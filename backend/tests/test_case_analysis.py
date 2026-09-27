"""Case comparison uses the exact saved centerline samples, without inference."""
import shutil
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import numpy as np
import tifffile

from agh_api import create_app, gbm_thickness
from agh_api.analysis_artifacts import write_thickness_geometry_atomic
from agh_api.auth import UserStore
from agh_api.config import Config
from agh_api.segmentation_service import OPERATION, analysis_request_cache_key, prepare_analysis_request


def sample_geometry(empty=False):
    dy = np.array([] if empty else [1, 1, 1, 2, 3], dtype=np.int32)
    n = len(dy)
    return gbm_thickness.ThicknessGeometry(
        shape=(12, 12), skeleton_y=np.full(n, 6, dtype=np.int32),
        skeleton_x=np.arange(3, 3 + n, dtype=np.int32),
        local_thickness_pixels=2.0 * dy,
        nearest_background_dy_pixels=dy,
        nearest_background_dx_pixels=np.zeros(n, dtype=np.int32),
        skeleton_degree=np.full(n, 2, dtype=np.uint8),
        skeleton_component=np.ones(n, dtype=np.int32),
        border_components=np.array([], dtype=np.int32), total_component_count=int(n > 0),
    )


class DistributionGeometryTests(unittest.TestCase):
    def test_preserves_every_sample_and_matches_existing_roi_measurement(self):
        geometry = sample_geometry()
        calibration = dict(pixel_size_x_um=0.2, pixel_size_y_um=0.5, expansion_factor=2)
        distribution = gbm_thickness.gbm_thickness_distribution_from_geometry(geometry, **calibration)
        self.assertEqual(distribution["valuesUm"], [0.5, 1.0, 1.5])
        self.assertEqual(distribution["counts"], [3, 1, 1])
        self.assertEqual(distribution["sampleCount"], 5)
        samples = np.repeat(distribution["valuesUm"], distribution["counts"])
        roi = gbm_thickness.measure_gbm_thickness_from_geometry(
            geometry, [[0, 0], [12, 0], [12, 12], [0, 12]], **calibration,
        )
        self.assertAlmostEqual(samples.mean(), roi["meanThicknessUm"])
        self.assertEqual(len(samples), roi["sampleCount"])

    def test_anisotropic_vectors_and_expansion(self):
        geometry = replace(sample_geometry(), nearest_background_dx_pixels=np.array([2, 0, 2, 1, 0]))
        result = gbm_thickness.gbm_thickness_distribution_from_geometry(
            geometry, pixel_size_x_um=0.25, pixel_size_y_um=0.5, expansion_factor=3,
        )
        expected = 2 * np.hypot(np.array([1, 1, 1, 2, 3]) * 0.5, np.array([2, 0, 2, 1, 0]) * 0.25) / 3
        np.testing.assert_allclose(np.repeat(result["valuesUm"], result["counts"]), np.sort(expected))

    def test_empty_mask_has_no_fabricated_zero_thickness_sample(self):
        result = gbm_thickness.gbm_thickness_distribution_from_geometry(sample_geometry(True), pixel_size_x_um=0.5)
        self.assertEqual(result["valuesUm"], [])
        self.assertEqual(result["counts"], [])
        self.assertEqual(result["sampleCount"], 0)


class CaseAnalysisApiTests(unittest.TestCase):
    endpoint = "/agh/api/cases/case1/files/60x.tif/analysis-runs"
    calibration = {"pixelSizeXUm": 0.5, "pixelSizeYUm": 0.5, "expansionEnabled": True, "expansionFactor": 2}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        data = base / "data"
        (data / "case1").mkdir(parents=True)
        self.path = data / "case1" / "60x.tif"
        tifffile.imwrite(self.path, np.zeros((2, 6, 12, 12), dtype=np.uint16), metadata={"axes": "CZYX"})
        checkpoint = base / "model.pt"
        checkpoint.write_bytes(b"synthetic test checkpoint")
        self.config = Config(
            data_root=data, ann_root=base / "annotations", users_file=base / "users.json",
            session_root=base / "sessions", login_state_file=base / "logins.json",
            audit_log_file=base / "audit.jsonl", collaboration_state_file=base / "collaboration.json",
            analysis_root=base / "analysis", analysis_db=base / "analysis" / "jobs.sqlite3",
            model_checkpoint=checkpoint, auth_required=False,
        )
        self.app = create_app(self.config)
        self.app.testing = True
        self.client = self.app.test_client()
        self.store = self.app.extensions["agh_analysis"]["store"]

    def tearDown(self):
        self.tmp.cleanup()

    def complete_run(self, *, empty=False, legacy=False):
        request, key = prepare_analysis_request(self.config, self.path, {"zIndex": 2, "channelIndex": 1})
        if legacy:
            request["source"].pop("pathId")
            key = analysis_request_cache_key(self.path, request, legacy_source=True)
        run, _ = self.store.create_or_reuse_run("case1", "60x.tif", OPERATION, request, cache_key=key)
        self.store.claim_next_run("test-worker")
        write_thickness_geometry_atomic(self.config.analysis_root, run["runId"],
            gbm_thickness.thickness_geometry_to_arrays(sample_geometry(empty)), attempt=1)
        self.store.mark_succeeded(run["runId"], "test-worker", {"artifactAttempt": 1, "thicknessGeometryAvailable": True})
        return run["runId"]

    def distribution_url(self, run_id):
        return f"/agh/api/analysis-runs/{run_id}/measurements/gbm-distribution"

    def test_reads_saved_attempt_without_model_or_geometry_recomputation(self):
        run_id = self.complete_run()
        with patch.object(gbm_thickness, "prepare_thickness_geometry", side_effect=AssertionError("must reuse")):
            response = self.client.post(self.distribution_url(run_id), json={"calibration": self.calibration})
        self.assertEqual(response.status_code, 200, response.get_json())
        result = response.get_json()
        self.assertEqual(result["sampleCount"], 5)
        self.assertEqual(result["counts"], [3, 1, 1])
        self.assertEqual(result["valuesUm"], [0.5, 1, 1.5])
        self.assertEqual(result["calibration"], self.calibration)
        self.assertEqual(result["coverage"], "full-mask-centerline")

    def test_calibration_can_change_without_another_segmentation(self):
        run_id = self.complete_run()
        result = self.client.post(self.distribution_url(run_id), json={"calibration": {
            **self.calibration, "expansionEnabled": False,
        }}).get_json()
        self.assertEqual(result["valuesUm"], [1, 2, 3])
        self.assertIsNone(self.store.claim_next_run("test-worker"))

    def test_empty_mask_is_success_with_zero_samples(self):
        response = self.client.post(self.distribution_url(self.complete_run(empty=True)), json={"calibration": self.calibration})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["sampleCount"], 0)

    def test_validates_calibration_and_run_readiness(self):
        queued = self.client.post(self.endpoint, json={"zIndex": 2, "channelIndex": 1}).get_json()
        url = self.distribution_url(queued["runId"])
        self.assertEqual(self.client.post(url, json={"calibration": self.calibration}).status_code, 409)
        self.complete_run()
        for body in ({}, {"calibration": None}, {"calibration": {"pixelSizeXUm": -1}},
                     {"calibration": {**self.calibration, "expansionEnabled": "false"}},
                     {"calibration": self.calibration, "roi": {}}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post(url, json=body).status_code, 400)

    def test_completed_runs_reused_but_other_z_channel_or_model_not_reused(self):
        run_id = self.complete_run()
        reused = self.client.post(self.endpoint, json={"zIndex": 2, "channelIndex": 1}).get_json()
        self.assertTrue(reused["reused"])
        self.assertEqual(reused["runId"], run_id)
        self.assertEqual(reused["status"], "SUCCEEDED")
        for payload in ({"zIndex": 3, "channelIndex": 1}, {"zIndex": 2, "channelIndex": 0}):
            self.assertFalse(self.client.post(self.endpoint, json=payload).get_json()["reused"])
        self.config.model_checkpoint.write_bytes(b"updated model")
        self.assertFalse(self.client.post(self.endpoint, json={"zIndex": 2, "channelIndex": 1}).get_json()["reused"])

    def test_old_completed_runs_remain_reusable(self):
        run_id = self.complete_run(legacy=True)
        reused = self.client.post(self.endpoint, json={"zIndex": 2, "channelIndex": 1}).get_json()
        self.assertEqual(reused["runId"], run_id)
        self.assertTrue(reused["reused"])
        self.assertEqual(self.client.post(self.distribution_url(run_id), json={"calibration": self.calibration}).status_code, 200)

    def test_rejects_changed_source(self):
        run_id = self.complete_run()
        self.path.write_bytes(b"changed image")
        response = self.client.post(self.distribution_url(run_id), json={"calibration": self.calibration})
        self.assertEqual(response.status_code, 409)

    def test_old_run_cannot_be_measured_against_same_named_file_in_another_root(self):
        run_id = self.complete_run(legacy=True)
        new_root = Path(self.tmp.name) / "other"
        (new_root / "case1").mkdir(parents=True)
        shutil.copy2(self.path, new_root / "case1" / "60x.tif")
        other = create_app(replace(self.config, data_root=new_root)).test_client()
        response = other.post(self.distribution_url(run_id), json={"calibration": self.calibration})
        self.assertEqual(response.status_code, 409)
        self.assertIn("folder changed", response.get_json()["error"])

    def test_all_roles_can_queue_and_measure_with_session_and_csrf(self):
        run_id = self.complete_run()
        app = create_app(replace(self.config, auth_required=True))
        users = UserStore(self.config.users_file)
        url = self.distribution_url(run_id)
        self.assertEqual(app.test_client().post(url, json={"calibration": self.calibration}).status_code, 401)
        for role in ("admin", "annotator", "viewer"):
            with self.subTest(role=role):
                users.add(role, "test password")
                users.set_role(role, role)
                client = app.test_client()
                login = client.post("/agh/api/login", json={"username": role, "password": "test password"})
                self.assertEqual(login.status_code, 200)
                headers = {"X-AGH-CSRF": login.get_json()["csrfToken"]}
                self.assertEqual(client.post(url, json={"calibration": self.calibration}).status_code, 403)
                self.assertEqual(client.post(url, headers=headers, json={"calibration": self.calibration}).status_code, 200)
                queued = client.post(self.endpoint, headers=headers, json={"zIndex": 2, "channelIndex": 1})
                self.assertEqual(queued.status_code, 202)
                self.assertEqual(queued.get_json()["runId"], run_id)


if __name__ == "__main__":
    unittest.main()
