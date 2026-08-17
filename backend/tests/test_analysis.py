import sys
import tempfile
import types
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import numpy as np
import tifffile
from PIL import Image

from agh_api import create_app
from agh_api.analysis_artifacts import (
    manifest_path,
    read_mask,
    thickness_geometry_path,
    write_mask_atomic,
    write_thickness_geometry_atomic,
)
from agh_api.analysis_store import AnalysisStore, LeaseLost
from agh_api.config import Config
from agh_api.errors import BadRequest
from agh_api.segmentation_service import (
    OPERATION,
    execute_segmentation,
    prepare_analysis_request,
)
from agh_api import tiff_service
from agh_api.tiff_service import choose_z_window, read_channel_plane, read_z_mip


class AnalysisApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.data_root = base / "data"
        self.ann_root = base / "annotations"
        case_dir = self.data_root / "case1"
        case_dir.mkdir(parents=True)
        stack = np.zeros((2, 6, 4, 5), dtype=np.uint16)
        for channel in range(2):
            for z_index in range(6):
                stack[channel, z_index] = (channel * 100) + z_index
        self.image_path = case_dir / "stack.tif"
        tifffile.imwrite(self.image_path, stack, metadata={"axes": "CZYX"})
        self.checkpoint = base / "model.pt"
        self.checkpoint.write_bytes(b"test checkpoint")
        state = base / "state"
        self.config = Config(
            data_root=self.data_root,
            ann_root=self.ann_root,
            users_file=state / "users.json",
            session_root=state / "sessions",
            login_state_file=state / "login_attempts.json",
            audit_log_file=state / "audit.jsonl",
            collaboration_state_file=state / "collaboration.json",
            auth_required=False,
            analysis_root=state / "analysis",
            analysis_db=state / "analysis" / "jobs.sqlite3",
            model_checkpoint=self.checkpoint,
        )
        app = create_app(self.config)
        app.testing = True
        self.client = app.test_client()
        self.store = app.extensions["agh_analysis"]["store"]

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_list_get_and_reuse_analysis_run(self):
        endpoint = "/agh/api/cases/case1/files/stack.tif/analysis-runs"
        first = self.client.post(endpoint, json={"zIndex": 0, "channelIndex": 1})
        self.assertEqual(first.status_code, 202)
        body = first.get_json()
        self.assertEqual(body["status"], "QUEUED")
        self.assertEqual(body["operation"], OPERATION)
        self.assertFalse(body["reused"])
        self.assertEqual(first.headers["Location"], body["statusUrl"])

        repeated = self.client.post(endpoint, json={"zIndex": 0, "channelIndex": 1})
        self.assertEqual(repeated.status_code, 202)
        self.assertTrue(repeated.get_json()["reused"])
        self.assertEqual(repeated.get_json()["runId"], body["runId"])

        listed = self.client.get(endpoint)
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(len(listed.get_json()["runs"]), 1)
        run = listed.get_json()["runs"][0]
        self.assertEqual(run["request"]["zWindow"], [0, 1, 2, 3, 4])
        self.assertEqual(run["request"]["mipZ"], 5)
        self.assertNotIn("workerId", run)

        status = self.client.get(body["statusUrl"])
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.get_json()["runId"], body["runId"])

    def test_create_analysis_run_strictly_validates_body_and_indices(self):
        endpoint = "/agh/api/cases/case1/files/stack.tif/analysis-runs"
        cases = (
            ({"zIndex": True, "channelIndex": 0}, "zIndex"),
            ({"zIndex": 0, "channelIndex": 2}, "channelIndex"),
            ({"zIndex": 6, "channelIndex": 0}, "zIndex"),
            ({"zIndex": 0}, "required"),
            ({"zIndex": 0, "channelIndex": 0, "mipZ": 3}, "Unsupported"),
        )
        for payload, message in cases:
            with self.subTest(payload=payload):
                response = self.client.post(endpoint, json=payload)
                self.assertEqual(response.status_code, 400)
                self.assertIn(message.lower(), response.get_json()["error"].lower())

    def test_latest_saved_runs_restore_by_slice_and_delete_all_slice_history(self):
        endpoint = "/agh/api/cases/case1/files/stack.tif/analysis-runs"
        first = self.client.post(endpoint, json={"zIndex": 2, "channelIndex": 0})
        first_id = first.get_json()["runId"]
        self.store.claim_next_run("worker-a")
        write_mask_atomic(
            self.config.analysis_root,
            first_id,
            np.ones((4, 5), dtype=np.uint8),
        )
        self.store.mark_succeeded(first_id, "worker-a", {"width": 5, "height": 4})

        # A failed retry on another channel must not hide the usable mask.
        failed = self.client.post(endpoint, json={"zIndex": 2, "channelIndex": 1})
        failed_id = failed.get_json()["runId"]
        self.store.claim_next_run("worker-b")
        self.store.mark_failed(failed_id, "worker-b", "expected test failure")

        restored = self.client.get(f"{endpoint}?latestPerZ=true")
        self.assertEqual(restored.status_code, 200)
        runs = restored.get_json()["runs"]
        self.assertEqual([run["runId"] for run in runs], [first_id])

        deleted = self.client.delete(f"{endpoint}?zIndex=2")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.get_json()["deleted"], 2)
        self.assertFalse((self.config.analysis_root / "runs" / first_id).exists())
        self.assertEqual(self.client.get(f"/agh/api/analysis-runs/{first_id}").status_code, 404)
        self.assertEqual(self.client.get(f"{endpoint}?latestPerZ=true").get_json()["runs"], [])

    def test_running_slice_prediction_cannot_be_deleted(self):
        endpoint = "/agh/api/cases/case1/files/stack.tif/analysis-runs"
        created = self.client.post(endpoint, json={"zIndex": 4, "channelIndex": 0})
        run_id = created.get_json()["runId"]
        self.store.claim_next_run("worker-a")
        blocked = self.client.delete(f"{endpoint}?zIndex=4")
        self.assertEqual(blocked.status_code, 409)
        self.assertIn("still running", blocked.get_json()["error"])
        self.store.mark_failed(run_id, "worker-a", "cleanup")

    def test_store_claims_fifo_and_rejects_stale_worker_updates(self):
        request_one, cache_one = prepare_analysis_request(
            self.config, self.image_path, {"zIndex": 1, "channelIndex": 0}
        )
        request_two, cache_two = prepare_analysis_request(
            self.config, self.image_path, {"zIndex": 2, "channelIndex": 0}
        )
        first, _ = self.store.create_or_reuse_run(
            "case1", "stack.tif", OPERATION, request_one, cache_key=cache_one
        )
        second, _ = self.store.create_or_reuse_run(
            "case1", "stack.tif", OPERATION, request_two, cache_key=cache_two
        )
        claimed = self.store.claim_next_run("worker-a")
        self.assertEqual(claimed["runId"], first["runId"])

        with self.store._connect() as conn:
            conn.execute(
                "UPDATE analysis_runs SET lease_expires_at = ? WHERE run_id = ?",
                ("2000-01-01T00:00:00+00:00", first["runId"]),
            )
        reclaimed = self.store.claim_next_run("worker-b")
        self.assertEqual(reclaimed["runId"], first["runId"])
        with self.assertRaises(LeaseLost):
            self.store.update_progress(first["runId"], "worker-a", {"stage": "stale"})
        self.store.mark_failed(first["runId"], "worker-b", "test failure")
        self.assertEqual(self.store.claim_next_run("worker-b")["runId"], second["runId"])

    def test_worker_orchestration_passes_raw_shifted_mip_and_publishes_artifacts(self):
        request_payload, cache_key = prepare_analysis_request(
            self.config, self.image_path, {"zIndex": 0, "channelIndex": 1}
        )
        created, _ = self.store.create_or_reuse_run(
            "case1", "stack.tif", OPERATION, request_payload, cache_key=cache_key
        )
        job = self.store.claim_next_run("worker-a")
        self.assertEqual(job["runId"], created["runId"])
        captured = {}

        fake_model = types.ModuleType("agh_api.morphogbm_v10")

        def fake_segment(raw_plane, checkpoint_path, *, device, progress):
            captured["raw"] = np.array(raw_plane, copy=True)
            captured["checkpoint"] = Path(checkpoint_path)
            captured["device"] = device
            progress(1.0, "done")
            mask = np.zeros(raw_plane.shape, dtype=np.uint8)
            mask[1:3, 2:4] = 1
            return {
                "mask": mask,
                "metadata": {
                    "model": {"checkpoint_path": str(checkpoint_path)},
                    "preprocess": "inside-model",
                },
            }

        fake_model.segment_plane = fake_segment
        fake_thickness = types.ModuleType("agh_api.gbm_thickness")
        fake_thickness.prepare_thickness_geometry = lambda mask: {"mask": mask}
        fake_thickness.thickness_geometry_to_arrays = lambda geometry: {
            "placeholder": np.asarray([int(np.sum(geometry["mask"]))], dtype=np.int32)
        }

        with patch.dict(
            sys.modules,
            {
                "agh_api.morphogbm_v10": fake_model,
                "agh_api.gbm_thickness": fake_thickness,
            },
        ):
            result = execute_segmentation(self.config, job)

        # z=0 shifts the requested five-plane window to 0..4, and the model
        # receives the raw uint16 maximum (no API-side contrast adjustment).
        np.testing.assert_array_equal(
            captured["raw"], np.full((4, 5), 104, dtype=np.uint16)
        )
        self.assertEqual(captured["checkpoint"], self.checkpoint)
        self.assertEqual(captured["device"], "auto")
        self.assertEqual(result["zWindow"], [0, 1, 2, 3, 4])
        self.assertEqual(
            result["metadata"]["model"]["checkpoint_path"], self.checkpoint.name
        )
        self.assertTrue(
            manifest_path(
                self.config.analysis_root,
                job["runId"],
                attempt=result["artifactAttempt"],
            ).is_file()
        )
        self.assertTrue(
            thickness_geometry_path(
                self.config.analysis_root,
                job["runId"],
                attempt=result["artifactAttempt"],
            ).is_file()
        )
        self.assertEqual(
            int(
                read_mask(
                    self.config.analysis_root,
                    job["runId"],
                    attempt=result["artifactAttempt"],
                ).sum()
            ),
            4,
        )

    def test_completed_mask_is_immutable_png_endpoint(self):
        response = self.client.post(
            "/agh/api/cases/case1/files/stack.tif/analysis-runs",
            json={"zIndex": 2, "channelIndex": 0},
        )
        run_id = response.get_json()["runId"]
        claimed = self.store.claim_next_run("worker-a")
        self.assertEqual(claimed["runId"], run_id)
        write_mask_atomic(
            self.config.analysis_root,
            run_id,
            np.ones((4, 5), dtype=np.uint8),
            attempt=claimed["attempts"],
        )
        with self.store._connect() as conn:
            conn.execute(
                "UPDATE analysis_runs SET lease_expires_at = ? WHERE run_id = ?",
                ("2000-01-01T00:00:00+00:00", run_id),
            )
        reclaimed = self.store.claim_next_run("worker-b")
        self.assertEqual(reclaimed["attempts"], 2)
        mask = np.zeros((4, 5), dtype=np.uint8)
        mask[1:3, 2:4] = 1
        write_mask_atomic(
            self.config.analysis_root,
            run_id,
            mask,
            attempt=reclaimed["attempts"],
        )
        # The stale attempt may finish publishing later, but its immutable
        # attempt directory cannot overwrite the successful attempt.
        write_mask_atomic(
            self.config.analysis_root,
            run_id,
            np.zeros((4, 5), dtype=np.uint8),
            attempt=claimed["attempts"],
        )
        self.store.mark_succeeded(
            run_id,
            "worker-b",
            {"width": 5, "height": 4, "artifactAttempt": reclaimed["attempts"]},
        )

        result = self.client.get(f"/agh/api/analysis-runs/{run_id}/mask")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.mimetype, "image/png")
        self.assertIn("immutable", result.headers["Cache-Control"])
        self.assertTrue(result.headers.get("ETag"))
        mask_payload = result.data
        result.close()
        np.testing.assert_array_equal(
            np.asarray(Image.open(BytesIO(mask_payload)).convert("L")) > 0,
            mask > 0,
        )
        np.testing.assert_array_equal(
            read_mask(
                self.config.analysis_root,
                run_id,
                attempt=reclaimed["attempts"],
            ),
            mask > 0,
        )

    def test_thickness_endpoint_uses_saved_geometry_and_frontend_schema(self):
        response = self.client.post(
            "/agh/api/cases/case1/files/stack.tif/analysis-runs",
            json={"zIndex": 3, "channelIndex": 1},
        )
        run_id = response.get_json()["runId"]
        self.store.claim_next_run("worker-a")
        write_mask_atomic(self.config.analysis_root, run_id, np.ones((4, 5), dtype=np.uint8))
        write_thickness_geometry_atomic(
            self.config.analysis_root, run_id, {"placeholder": np.array([1], dtype=np.uint8)}
        )
        self.store.mark_succeeded(run_id, "worker-a", {"width": 5, "height": 4})

        fake_module = types.ModuleType("agh_api.gbm_thickness")
        fake_module.load_thickness_geometry = lambda path: {"loaded": str(path)}

        def fake_measure(geometry, vertices, **kwargs):
            self.assertEqual(len(vertices), 4)
            self.assertEqual(kwargs["expansion_factor"], 7.0)
            return {"meanThickness": 0.42, "unit": "um", "sampleCount": 12}

        fake_module.measure_gbm_thickness_from_geometry = fake_measure
        payload = {
            "roi": {
                "type": "polygon",
                "points": [[0, 0], [5, 0], [5, 4], [0, 4]],
            },
            "calibration": {
                "pixelSizeXUm": 0.2,
                "pixelSizeYUm": 0.3,
                "expansionEnabled": True,
                "expansionFactor": 7,
            },
        }
        with patch.dict(sys.modules, {"agh_api.gbm_thickness": fake_module}):
            measured = self.client.post(
                f"/agh/api/analysis-runs/{run_id}/measurements/gbm-thickness",
                json=payload,
            )
        self.assertEqual(measured.status_code, 200)
        self.assertAlmostEqual(measured.get_json()["meanThickness"], 0.42)
        self.assertEqual(measured.get_json()["sampleCount"], 12)
        self.assertTrue(measured.get_json()["calibration"]["expansionEnabled"])

        def no_centerline(geometry, vertices, **kwargs):
            raise ValueError("No segmented GBM centerline lies inside this ROI")

        fake_module.measure_gbm_thickness_from_geometry = no_centerline
        with patch.dict(sys.modules, {"agh_api.gbm_thickness": fake_module}):
            no_samples = self.client.post(
                f"/agh/api/analysis-runs/{run_id}/measurements/gbm-thickness",
                json=payload,
            )
        self.assertEqual(no_samples.status_code, 400)
        self.assertIn("No segmented GBM centerline", no_samples.get_json()["error"])

    def test_thickness_endpoint_rejects_invalid_polygon(self):
        run = {
            "status": "SUCCEEDED",
            "request": {"source": {"width": 5, "height": 4}},
        }
        from agh_api.segmentation_service import validate_thickness_request

        with self.assertRaises(BadRequest):
            validate_thickness_request(
                {
                    "roi": {"type": "polygon", "points": [[0, 0], [1, 1], [2, 2]]},
                    "calibration": {"pixelSizeXUm": 0.2},
                },
                run,
            )


class ZMipTests(unittest.TestCase):
    def test_choose_z_window_is_shifted_and_uses_all_short_stack_planes(self):
        self.assertEqual(choose_z_window(0, 8, 5), (0, 1, 2, 3, 4))
        self.assertEqual(choose_z_window(7, 8, 5), (3, 4, 5, 6, 7))
        self.assertEqual(choose_z_window(4, 8, 5), (2, 3, 4, 5, 6))
        self.assertEqual(choose_z_window(1, 3, 5), (0, 1, 2))
        self.assertEqual(choose_z_window(0, 1, 1), (0,))
        with self.assertRaises(BadRequest):
            choose_z_window(True, 5, 5)

    def test_tiff_z_mip_preserves_dtype_and_reports_actual_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "stack.tif"
            stack = np.stack(
                [np.full((2, 3), z_index, dtype=np.uint16) for z_index in range(6)]
            )
            tifffile.imwrite(path, stack, metadata={"axes": "ZYX"})

            lower, lower_window = read_z_mip(path, 0, 0, 5)
            upper, upper_window = read_z_mip(path, 0, 5, 5)

            self.assertEqual(lower.dtype, np.dtype("uint16"))
            self.assertEqual(lower_window, (0, 1, 2, 3, 4))
            self.assertEqual(upper_window, (1, 2, 3, 4, 5))
            np.testing.assert_array_equal(lower, np.full((2, 3), 4, dtype=np.uint16))
            np.testing.assert_array_equal(upper, np.full((2, 3), 5, dtype=np.uint16))

    def test_nd2_plane_and_shifted_mip_share_the_raw_channel_contract(self):
        class FakeND2File:
            sizes = {"C": 2, "Z": 6, "Y": 2, "X": 3}
            loop_indices = tuple({"Z": z_index} for z_index in range(6))

            def __init__(self, _path):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read_frame(self, frame_index):
                return np.stack(
                    [
                        np.full((2, 3), frame_index, dtype=np.uint16),
                        np.full((2, 3), 100 + frame_index, dtype=np.uint16),
                    ]
                )

        with patch.object(tiff_service.nd2, "ND2File", FakeND2File):
            plane = read_channel_plane(Path("synthetic.nd2"), 1, 2)
            projection, window = read_z_mip(Path("synthetic.nd2"), 1, 5, 5)

        self.assertEqual(plane.dtype, np.dtype("uint16"))
        self.assertEqual(projection.dtype, np.dtype("uint16"))
        self.assertEqual(window, (1, 2, 3, 4, 5))
        np.testing.assert_array_equal(plane, np.full((2, 3), 102, dtype=np.uint16))
        np.testing.assert_array_equal(
            projection,
            np.full((2, 3), 105, dtype=np.uint16),
        )


if __name__ == "__main__":
    unittest.main()
