import tempfile
import unittest
from pathlib import Path

import numpy as np
import tifffile

from agh_api import create_app
from agh_api.analysis_artifacts import artifact_path
from agh_api.analysis_profiles import resolve_process_watershed
from agh_api.magnifyseg_engine.metrics import compute_process_nnd
from agh_api.analysis_store import AnalysisStore
from agh_api.analysis_validation import normalize_calibration, validate_analysis_request
from agh_api.config import Config
from agh_api.errors import BadRequest, NotFound


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.data_root = base / "data"
        self.ann_root = base / "annotations"
        self.cache_root = base / "cache"
        self.analysis_root = base / "analysis"
        self.model_root = base / "models"
        case_dir = self.data_root / "case1"
        case_dir.mkdir(parents=True)
        tifffile.imwrite(
            case_dir / "image.tif",
            np.arange(2 * 2 * 3 * 4, dtype=np.uint16).reshape(2, 2, 3, 4),
            metadata={"axes": "CZYX"},
        )
        self.config = Config(
            data_root=self.data_root,
            ann_root=self.ann_root,
            cache_root=self.cache_root,
            analysis_root=self.analysis_root,
            model_root=self.model_root,
            analysis_db=self.analysis_root / "jobs.sqlite3",
        )
        app = create_app(self.config)
        app.testing = True
        self.client = app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_validate_analysis_request_rejects_duplicate_channels(self):
        metadata = {"numChannels": 3, "numZSlices": 2, "pixelSize": None, "pixelUnit": "um"}
        with self.assertRaises(BadRequest):
            validate_analysis_request({
                "zIndex": 0,
                "channels": {"actn4": 1, "dapi": 1, "nhs": 2},
                "models": {"actn4": True},
            }, metadata)

    def test_validate_analysis_request_defaults_to_percentile_stretch(self):
        metadata = {"numChannels": 3, "numZSlices": 1, "pixelSize": None, "pixelUnit": "um"}
        request = validate_analysis_request({
            "zIndex": 0,
            "channels": {"actn4": 0},
            "models": {"actn4": True},
        }, metadata)

        self.assertEqual(request["preprocessingMode"], "percentile-stretch")

    def test_calibration_uses_raw_pixel_size_and_expansion_factor(self):
        calibration = normalize_calibration({
            "pixelSize": 0.014,
            "pixelUnit": "um",
            "expanded": True,
            "expansionFactor": 7.0,
        })
        self.assertAlmostEqual(calibration["effectivePixelSize"], 0.002)
        self.assertEqual(calibration["effectivePixelSizeSource"], "raw-pixel-size/expansion-factor")

    def test_calibration_effective_override_works_without_raw_pixel_size(self):
        calibration = normalize_calibration({
            "pixelSize": None,
            "pixelUnit": "um",
            "expanded": True,
            "expansionFactor": 7.0,
            "effectivePixelSizeOverride": 0.002,
        })
        self.assertIsNone(calibration["pixelSize"])
        self.assertAlmostEqual(calibration["effectivePixelSize"], 0.002)
        self.assertEqual(calibration["effectivePixelSizeSource"], "override")

    def test_expansion_factor_alone_does_not_invent_pixel_size(self):
        calibration = normalize_calibration({
            "pixelSize": None,
            "expanded": True,
            "expansionFactor": 7.0,
        })
        self.assertIsNone(calibration["effectivePixelSize"])

    def test_watershed_presets_resolve_physical_units_to_pixels(self):
        resolved = resolve_process_watershed({"preset": "balanced"}, effective_pixel_size=0.002)
        self.assertEqual(resolved["label"], "Balanced")
        self.assertAlmostEqual(resolved["minDistanceUm"], 0.08)
        self.assertAlmostEqual(resolved["minDistance"], 40.0)
        self.assertAlmostEqual(resolved["maxPairDistanceUm"], 1.5)
        self.assertAlmostEqual(resolved["maxPairDistance"], 750.0)

    def test_watershed_legacy_pixel_values_remain_supported(self):
        resolved = resolve_process_watershed(
            {"minDistance": 25, "maxPairDistance": 500, "thresholdRelative": 0.3, "sigma": 0},
            effective_pixel_size=0.002,
        )
        self.assertAlmostEqual(resolved["minDistanceUm"], 0.05)
        self.assertAlmostEqual(resolved["maxPairDistanceUm"], 1.0)
        self.assertAlmostEqual(resolved["minDistance"], 25.0)
        self.assertAlmostEqual(resolved["maxPairDistance"], 500.0)


    def test_watershed_custom_max_pair_um_is_not_overwritten_by_preset(self):
        resolved = resolve_process_watershed(
            {"preset": "balanced", "maxPairDistanceUm": 0.25},
            effective_pixel_size=0.002,
        )
        self.assertAlmostEqual(resolved["maxPairDistanceUm"], 0.25)
        self.assertAlmostEqual(resolved["maxPairDistance"], 125.0)

    def test_process_nnd_max_pair_distance_filters_links_and_mean(self):
        mask = np.zeros((50, 80), dtype=bool)
        mask[15:25, 10:20] = True
        mask[15:25, 40:50] = True
        with tempfile.TemporaryDirectory() as wide_dir, tempfile.TemporaryDirectory() as narrow_dir:
            wide = compute_process_nnd(
                mask, 1.0, Path(wide_dir),
                max_pair_px=40, ws_min_dist=3, ws_thresh_rel=0.1, ws_sigma=0,
            )
            narrow = compute_process_nnd(
                mask, 1.0, Path(narrow_dir),
                max_pair_px=20, ws_min_dist=3, ws_thresh_rel=0.1, ws_sigma=0,
            )
        self.assertEqual(wide["processCount"], 2)
        self.assertEqual(wide["pairCount"], 2)
        self.assertAlmostEqual(wide["meanDistance"], 30.0)
        self.assertEqual(narrow["processCount"], 2)
        self.assertEqual(narrow["pairCount"], 0)
        self.assertIsNone(narrow["meanDistance"])

    def test_watershed_presets_convert_nanometer_calibration(self):
        resolved = resolve_process_watershed(
            {"preset": "balanced"},
            effective_pixel_size=2.0,
            pixel_unit="nm",
        )
        self.assertAlmostEqual(resolved["effectivePixelSizeUm"], 0.002)
        self.assertAlmostEqual(resolved["minDistance"], 40.0)

    def test_create_analysis_run(self):
        response = self.client.post("/agh/api/cases/case1/files/image.tif/analysis-runs", json={
            "zIndex": 1,
            "channels": {"actn4": 0, "dapi": 1},
            "models": {"actn4": True, "dapi": False, "nhs": False},
            "calibration": {"pixelSize": 0.014, "pixelUnit": "um", "expanded": True, "expansionFactor": 7.0},
        })
        self.assertEqual(response.status_code, 202)
        run_id = response.get_json()["runId"]
        status = self.client.get(f"/agh/api/analysis-runs/{run_id}")
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.get_json()["status"], "QUEUED")

    def test_list_analysis_runs_for_file(self):
        first = self.client.post("/agh/api/cases/case1/files/image.tif/analysis-runs", json={
            "zIndex": 0,
            "channels": {"actn4": 0},
            "models": {"actn4": True, "dapi": False, "nhs": False},
        })
        second = self.client.post("/agh/api/cases/case1/files/image.tif/analysis-runs", json={
            "zIndex": 0,
            "channels": {"nhs": 1},
            "models": {"actn4": False, "dapi": False, "nhs": True},
            "nhsMode": "single-channel",
        })
        self.assertEqual(first.status_code, 202)
        self.assertEqual(second.status_code, 202)

        response = self.client.get(
            "/agh/api/cases/case1/files/image.tif/analysis-runs?operation=magnifyseg-segmentation"
        )
        self.assertEqual(response.status_code, 200)
        run_ids = [run["runId"] for run in response.get_json()["runs"]]
        self.assertIn(first.get_json()["runId"], run_ids)
        self.assertIn(second.get_json()["runId"], run_ids)

    def test_create_analysis_run_rejects_dapi_segmentation(self):
        response = self.client.post("/agh/api/cases/case1/files/image.tif/analysis-runs", json={
            "zIndex": 0,
            "channels": {"dapi": 1},
            "models": {"actn4": False, "dapi": True, "nhs": False},
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn("DAPI segmentation", response.get_json()["error"])

    def test_store_claims_one_job(self):
        store = AnalysisStore(self.analysis_root / "unit.sqlite3")
        first = store.create_run("case1", "image.tif", "test", {"modelNames": ["ACTN4"]})
        second = store.create_run("case1", "image.tif", "test", {"modelNames": ["NHS_SINGLE_CHANNEL"]})
        claimed = store.claim_next_run(worker_id="worker-a")
        self.assertEqual(claimed["runId"], first["runId"])
        self.assertEqual(store.get_run(first["runId"])["status"], "RUNNING")
        self.assertEqual(store.get_run(first["runId"])["workerId"], "worker-a")
        self.assertEqual(store.get_run(first["runId"])["attempts"], 1)
        self.assertEqual(store.get_run(second["runId"])["status"], "QUEUED")

    def test_store_reclaims_expired_running_job(self):
        store = AnalysisStore(self.analysis_root / "lease.sqlite3")
        run = store.create_run("case1", "image.tif", "test", {"modelNames": ["ACTN4"]})
        first = store.claim_next_run(worker_id="worker-a", lease_seconds=-1)
        self.assertEqual(first["runId"], run["runId"])

        reclaimed = store.claim_next_run(worker_id="worker-b")
        self.assertEqual(reclaimed["runId"], run["runId"])
        latest = store.get_run(run["runId"])
        self.assertEqual(latest["status"], "RUNNING")
        self.assertEqual(latest["workerId"], "worker-b")
        self.assertEqual(latest["attempts"], 2)

    def test_create_metric_run_queues_job(self):
        store = AnalysisStore(self.config.analysis_db)
        segmentation = store.create_run("case1", "image.tif", "magnifyseg-segmentation", {
            "calibration": {"effectivePixelSize": 0.002, "pixelUnit": "um"},
        })
        store.mark_succeeded(segmentation["runId"], {
            "segmentations": {
                "NHS_SINGLE_CHANNEL": "seg_NHS_SINGLE_CHANNEL.tif",
                "ACTN4": "seg_ACTN4.tif",
            }
        })

        response = self.client.post(
            f"/agh/api/analysis-runs/{segmentation['runId']}/metrics/gbm-thickness",
            json={"roi": {"x": 1, "y": 2, "width": 3, "height": 4}},
        )
        self.assertEqual(response.status_code, 202)
        metric_run_id = response.get_json()["runId"]
        metric = store.get_run(metric_run_id)
        self.assertEqual(metric["operation"], "gbm-thickness")
        self.assertEqual(metric["request"]["segmentationRunId"], segmentation["runId"])
        self.assertEqual(metric["status"], "QUEUED")

    def test_metric_calibration_can_be_added_after_segmentation_without_rerun(self):
        store = AnalysisStore(self.config.analysis_db)
        segmentation = store.create_run("case1", "image.tif", "magnifyseg-segmentation", {
            "calibration": {
                "pixelSize": None,
                "pixelUnit": "um",
                "expanded": True,
                "expansionFactor": 7.0,
                "effectivePixelSize": None,
            },
        })
        store.mark_succeeded(segmentation["runId"], {
            "segmentations": {"ACTN4": "seg_ACTN4.tif"},
        })

        response = self.client.post(
            f"/agh/api/analysis-runs/{segmentation['runId']}/metrics/process-nnd",
            json={
                "calibration": {
                    "pixelSize": None,
                    "pixelUnit": "um",
                    "expanded": True,
                    "expansionFactor": 7.0,
                    "effectivePixelSizeOverride": 0.002,
                },
                "watershed": {"preset": "balanced"},
            },
        )
        self.assertEqual(response.status_code, 202)
        metric = store.get_run(response.get_json()["runId"])
        self.assertAlmostEqual(metric["request"]["calibration"]["effectivePixelSize"], 0.002)
        self.assertEqual(metric["request"]["calibration"]["effectivePixelSizeSource"], "override")
        self.assertAlmostEqual(metric["request"]["watershed"]["minDistance"], 40.0)

    def test_metric_error_explains_that_expansion_factor_alone_is_insufficient(self):
        store = AnalysisStore(self.config.analysis_db)
        segmentation = store.create_run("case1", "image.tif", "magnifyseg-segmentation", {
            "calibration": {
                "pixelSize": None,
                "pixelUnit": "um",
                "expanded": True,
                "expansionFactor": 7.0,
                "effectivePixelSize": None,
            },
        })
        store.mark_succeeded(segmentation["runId"], {
            "segmentations": {"ACTN4": "seg_ACTN4.tif"},
        })

        response = self.client.post(
            f"/agh/api/analysis-runs/{segmentation['runId']}/metrics/process-nnd",
            json={"calibration": {"expanded": True, "expansionFactor": 7.0}},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("Expansion factor alone is not enough", response.get_json()["error"])

    def test_list_metric_runs_for_segmentation(self):
        store = AnalysisStore(self.config.analysis_db)
        segmentation = store.create_run("case1", "image.tif", "magnifyseg-segmentation", {
            "calibration": {"effectivePixelSize": 0.002, "pixelUnit": "um"},
        })
        other_segmentation = store.create_run("case1", "image.tif", "magnifyseg-segmentation", {
            "calibration": {"effectivePixelSize": 0.002, "pixelUnit": "um"},
        })
        metric = store.create_run("case1", "image.tif", "gbm-thickness", {
            "segmentationRunId": segmentation["runId"],
            "roi": None,
        })
        other_metric = store.create_run("case1", "image.tif", "process-nnd", {
            "segmentationRunId": other_segmentation["runId"],
            "roi": None,
        })
        store.mark_succeeded(metric["runId"], {
            "kind": "gbm-thickness",
            "meanThickness": 0.231,
            "unit": "um",
            "points": [],
        })
        store.mark_succeeded(other_metric["runId"], {
            "kind": "process-nnd",
            "meanDistance": 0.842,
            "unit": "um",
            "pairs": [],
        })

        response = self.client.get(f"/agh/api/analysis-runs/{segmentation['runId']}/metrics")
        self.assertEqual(response.status_code, 200)
        runs = response.get_json()["runs"]
        self.assertEqual([run["runId"] for run in runs], [metric["runId"]])
        self.assertEqual(runs[0]["operation"], "gbm-thickness")
        self.assertEqual(runs[0]["result"]["meanThickness"], 0.231)
        self.assertEqual(runs[0]["request"]["segmentationRunId"], segmentation["runId"])

    def test_delete_segmentation_run_removes_child_metric_runs(self):
        store = AnalysisStore(self.config.analysis_db)
        segmentation = store.create_run("case1", "image.tif", "magnifyseg-segmentation", {
            "calibration": {"effectivePixelSize": 0.002, "pixelUnit": "um"},
        })
        metric = store.create_run("case1", "image.tif", "gbm-thickness", {
            "segmentationRunId": segmentation["runId"],
            "roi": None,
        })

        response = self.client.delete(f"/agh/api/analysis-runs/{segmentation['runId']}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["deleted"], True)
        with self.assertRaises(NotFound):
            store.get_run(segmentation["runId"])
        with self.assertRaises(NotFound):
            store.get_run(metric["runId"])

    def test_artifact_path_guard(self):
        run_id = "11111111-1111-1111-1111-111111111111"
        metric_run_id = "22222222-2222-2222-2222-222222222222"
        run_dir = self.analysis_root / "runs" / run_id
        metric_dir = run_dir / "metrics" / metric_run_id
        metric_dir.mkdir(parents=True)
        (run_dir / "overlay_ACTN4.png").write_bytes(b"png")
        (metric_dir / "proc_contours.png").write_bytes(b"png")
        path = artifact_path(self.analysis_root, run_id, "overlay_ACTN4.png")
        self.assertEqual(path.name, "overlay_ACTN4.png")
        nested = artifact_path(self.analysis_root, run_id, f"metrics/{metric_run_id}/proc_contours.png")
        self.assertEqual(nested.name, "proc_contours.png")
        with self.assertRaises(BadRequest):
            artifact_path(self.analysis_root, run_id, "../secret.txt")


if __name__ == "__main__":
    unittest.main()

