"""Cross-section filtering and corrections, end to end on a small known 3D scene."""
import tempfile
import unittest
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image
import tifffile

try:
    import scipy  # noqa: F401
    import skimage  # noqa: F401
    HAS_RUNTIME = True
except ImportError:
    HAS_RUNTIME = False

from agh_api import create_app
from agh_api.config import Config

PIXEL_UM = 0.1
Z_STEP_UM = 0.4
THICKNESS_PX = 20
PLANES = 26
SIZE = 300
RING = (80, 80, 50)
TILT_DEG = 50.0


def scene_volume() -> np.ndarray:
    """A vertical tube (rings in every plane) and a sheet tilted 50 degrees from vertical."""
    yy, xx = np.mgrid[:SIZE, :SIZE]
    volume = np.zeros((PLANES, SIZE, SIZE), dtype=bool)
    radius = np.hypot(yy - RING[0], xx - RING[1])
    shift = Z_STEP_UM / PIXEL_UM * np.tan(np.radians(TILT_DEG))
    half_width = 0.5 * THICKNESS_PX / np.cos(np.radians(TILT_DEG))
    for z in range(PLANES):
        volume[z] = np.abs(radius - RING[2]) < THICKNESS_PX / 2
        center = 170 + shift * (z - PLANES / 2) * 0.6
        volume[z] |= (np.abs(xx - center) < half_width) & (yy > 150) & (yy < 280)
    return volume


def z_mip(volume: np.ndarray, z: int, planes: int = 5) -> tuple[np.ndarray, list[int]]:
    low = min(max(0, z - planes // 2), max(0, volume.shape[0] - planes))
    window = list(range(low, min(volume.shape[0], low + planes)))
    return volume[window].any(axis=0), window


@unittest.skipUnless(HAS_RUNTIME, "scipy and scikit-image are required")
class RefinementApiTests(unittest.TestCase):
    calibration = {"pixelSizeXUm": PIXEL_UM, "pixelSizeYUm": PIXEL_UM, "expansionEnabled": False, "expansionFactor": 1}
    filter = {"crossSection": True, "thicknessLimits": True, "minNm": 30, "maxNm": 3400, "zStepUm": Z_STEP_UM}

    def setUp(self):
        from agh_api.analysis_artifacts import (
            write_mask_atomic, write_probability_atomic, write_thickness_geometry_atomic,
        )
        from agh_api.gbm_thickness import prepare_thickness_geometry, thickness_geometry_to_arrays
        from agh_api.segmentation_service import OPERATION, prepare_analysis_request

        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        data = base / "data"
        (data / "case1").mkdir(parents=True)
        self.path = data / "case1" / "stack.tif"
        tifffile.imwrite(self.path, np.zeros((1, PLANES, SIZE, SIZE), dtype=np.uint16), metadata={"axes": "CZYX"})
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

        volume = scene_volume()
        self.runs = {}
        # A faint GBM-like line the model left below its threshold.
        yy, xx = np.mgrid[:SIZE, :SIZE]
        self.faint = (np.abs(yy - 20) < 6) & (xx > 170) & (xx < 280)
        for z in range(0, PLANES, 2):
            request, key = prepare_analysis_request(self.config, self.path, {"zIndex": z, "channelIndex": 0})
            run, _ = self.store.create_or_reuse_run("case1", "stack.tif", OPERATION, request, cache_key=key)
            self.store.claim_next_run("test-worker")
            mask, _ = z_mip(volume, z)
            probability = np.where(mask, 0.9, 0.02)
            probability[self.faint] = 0.4
            write_mask_atomic(self.config.analysis_root, run["runId"], mask, attempt=1)
            write_probability_atomic(self.config.analysis_root, run["runId"], probability, attempt=1)
            write_thickness_geometry_atomic(
                self.config.analysis_root, run["runId"],
                thickness_geometry_to_arrays(prepare_thickness_geometry(mask)), attempt=1,
            )
            self.store.mark_succeeded(run["runId"], "test-worker", {
                "artifactAttempt": 1, "thicknessGeometryAvailable": True, "probabilityAvailable": True,
            })
            self.runs[z] = run["runId"]
        self.middle = self.runs[12]

    def tearDown(self):
        self.tmp.cleanup()

    def run_stack_job(self):
        from agh_api.gbm_refinement import STACK_OPERATION, execute_stack_analysis

        job = self.store.claim_next_run("test-worker")
        self.assertIsNotNone(job, "a stack analysis should be queued")
        self.assertEqual(job["operation"], STACK_OPERATION)
        result = execute_stack_analysis(self.config, job)
        self.store.mark_succeeded(job["runId"], "test-worker", result)
        return result

    def distribution(self, run_id=None, **overrides):
        body = {"calibration": self.calibration}
        if overrides.get("filter", self.filter) is not None:
            body["filter"] = overrides.get("filter", self.filter)
        response = self.client.post(
            f"/agh/api/analysis-runs/{run_id or self.middle}/measurements/gbm-distribution", json=body,
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()

    def mean_nm(self, result) -> float:
        return float(np.average(result["valuesUm"], weights=result["counts"])) * 1000.0

    def refinement(self, run_id=None) -> dict:
        response = self.client.post(
            f"/agh/api/analysis-runs/{run_id or self.middle}/refinement",
            json={"calibration": self.calibration, "filter": self.filter},
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()

    def click(self, kind, x, y, run_id=None, status=201):
        response = self.client.post(f"/agh/api/analysis-runs/{run_id or self.middle}/edits", json={
            "calibration": self.calibration, "filter": self.filter, "kind": kind, "x": x, "y": y,
        })
        self.assertEqual(response.status_code, status, response.get_json())
        return response.get_json()

    def test_measurements_are_pending_until_the_stack_analysis_finishes(self):
        raw = self.distribution(filter=None)
        pending = self.distribution(filter={**self.filter, "thicknessLimits": False})
        self.assertFalse(pending["filter"]["applied"])
        self.assertTrue(pending["filter"]["pending"])
        self.assertIsNone(pending["filter"]["token"])
        self.assertEqual(pending["sampleCount"], raw["sampleCount"])
        # Thickness limits need no stack analysis, so they already apply.
        self.assertLess(self.distribution()["sampleCount"], raw["sampleCount"])
        self.run_stack_job()
        ready = self.distribution()
        self.assertTrue(ready["filter"]["applied"])
        self.assertFalse(ready["filter"]["pending"])
        self.assertTrue(ready["filter"]["token"])
        self.assertLess(ready["sampleCount"], raw["sampleCount"])

    def test_oblique_sheet_is_excluded_and_thickness_approaches_truth(self):
        raw = self.distribution(filter=None)
        self.distribution()
        self.run_stack_job()
        kept = self.distribution()
        truth = THICKNESS_PX * PIXEL_UM * 1000.0
        self.assertGreater(self.mean_nm(raw) - truth, 2.0 * abs(self.mean_nm(kept) - truth))
        self.assertLess(abs(self.mean_nm(kept) - truth), 0.15 * truth)
        self.assertGreater(kept["filter"]["byReason"].get("oblique", 0), 0)

        view = self.refinement()
        self.assertEqual(view["summary"]["keptSamples"], kept["sampleCount"])
        reasons = np.asarray(view["pieces"]["reason"])
        tilt = np.asarray([np.nan if value is None else value for value in view["pieces"]["tiltDeg"]], dtype=float)
        self.assertLess(np.nanmedian(tilt[reasons == 0]), 20.0)
        self.assertGreater(np.nanmedian(tilt[reasons != 0]), 25.0)

    def test_gbm_that_is_vertical_here_is_kept_even_if_it_curves_away_elsewhere(self):
        from agh_api.gbm_cross_section import FilterSettings, StackPlane, analyze_stack, classify_pieces
        from agh_api.gbm_thickness import prepare_thickness_geometry

        # A sphere shell, 20 px thick, sliced near its equator. Every wall here is
        # vertical in the middle plane and tilted further up and down.
        planes, count, size, radius = [], 41, 400, 130.0
        yy, xx = np.mgrid[:size, :size]
        axial = Z_STEP_UM / PIXEL_UM
        rng = np.random.default_rng(3)
        for z in range(count):
            distance = np.sqrt((yy - 200) ** 2 + (xx - 200) ** 2 + ((z - 20) * axial) ** 2)
            jitter = rng.normal(0.0, 1.0)  # how masks differ between slices
            mask = np.abs(distance - radius) < 10.0 + jitter
            planes.append(StackPlane(z, float(z), mask, prepare_thickness_geometry(mask)))
        middle = analyze_stack(planes)[20]
        decided = classify_pieces(
            middle, FilterSettings(thickness_limits=False), pixel_size_um=PIXEL_UM, z_step_um=Z_STEP_UM,
        )
        kept = (decided["reasons"] == 0)[middle.sample_piece]
        self.assertGreater(kept.mean(), 0.9)
        self.assertLess(np.nanmedian(decided["tilt_deg"]), 8.0)

    def test_a_short_noisy_stretch_stays_with_the_wall_it_belongs_to(self):
        from agh_api.gbm_cross_section import decide_along_centerline

        # Ten pieces in a line, each two thicknesses long.
        edges = np.array([[i, i + 1] for i in range(9)])
        length = np.full(10, 2.0)
        score = np.full(10, -1.0)

        lone_wobble = score.copy()
        lone_wobble[5] = 0.3
        kept = ~decide_along_centerline(lone_wobble > 0, lone_wobble, length, edges)
        self.assertTrue(kept.all(), "one slightly tilted piece does not break the line")

        real_run = score.copy()
        real_run[3:7] = 2.0
        decided = decide_along_centerline(real_run > 0, real_run, length, edges)
        np.testing.assert_array_equal(np.nonzero(decided)[0], [3, 4, 5, 6])

        # A kept scrap in the middle of clearly tilted GBM goes with it.
        scrap = np.full(10, 2.0)
        scrap[5] = -0.2
        self.assertTrue(decide_along_centerline(scrap > 0, scrap, length, edges).all())

        # Pieces of no opinion, like junctions, take after what they join.
        neutral = score.copy()
        neutral[5] = 0.0
        self.assertFalse(decide_along_centerline(np.zeros(10, bool), neutral, length, edges).any())
        tilted = np.full(10, 2.0)
        tilted[5] = 0.0
        self.assertTrue(decide_along_centerline(tilted > 0, tilted, length, edges).all())

        # With nothing to be continuous with, evidence stands alone.
        alone = decide_along_centerline(np.array([True, False]), np.array([0.1, -0.1]), np.ones(2), np.empty((0, 2)))
        np.testing.assert_array_equal(alone, [True, False])

    def test_decisions_do_not_fragment_a_noisy_wall(self):
        from agh_api.gbm_cross_section import FilterSettings, StackPlane, analyze_stack, classify_pieces
        from agh_api.gbm_thickness import prepare_thickness_geometry

        # A vertical ring whose edges wander between slices, as model masks do.
        size, count = 420, 25
        yy, xx = np.mgrid[:size, :size]
        rng = np.random.default_rng(5)
        angle = np.arctan2(yy - 210, xx - 210)
        planes = []
        for z in range(count):
            wobble = sum(rng.normal(0, 1.8) * np.sin(k * angle + rng.uniform(0, 6.28)) for k in (3, 5, 9, 13))
            mask = np.abs(np.hypot(yy - 210, xx - 210) + wobble - 150) < 11 + rng.normal(0, 1.0)
            planes.append(StackPlane(z, float(z), mask, prepare_thickness_geometry(mask)))
        results = analyze_stack(planes)
        for z in (6, 12, 18):
            analysis = results[z]
            decided = classify_pieces(analysis, FilterSettings(thickness_limits=False), pixel_size_um=PIXEL_UM, z_step_um=Z_STEP_UM)
            kept = decided["reasons"] == 0
            edges = analysis.piece_edges
            breaks = (kept[edges[:, 0]] != kept[edges[:, 1]]).sum() if edges.size else 0
            self.assertLessEqual(breaks, 2, f"Z{z} was cut into pieces")
            self.assertGreater(kept[analysis.sample_piece].mean(), 0.85)

    def test_toggle_and_thickness_limits_are_independent(self):
        self.distribution()
        self.run_stack_job()
        raw = self.distribution(filter=None)
        limits_only = self.distribution(filter={**self.filter, "crossSection": False})
        self.assertTrue(limits_only["filter"]["applied"])
        self.assertLess(limits_only["sampleCount"], raw["sampleCount"])
        self.assertLessEqual(max(limits_only["valuesUm"]), 3.4)
        wide = self.distribution(filter={**self.filter, "crossSection": False, "maxNm": 9000})
        self.assertEqual(wide["sampleCount"], raw["sampleCount"])
        narrow = self.distribution(filter={**self.filter, "crossSection": False, "minNm": 1000, "maxNm": 2200})
        self.assertLess(narrow["sampleCount"], raw["sampleCount"])
        self.assertGreaterEqual(min(narrow["valuesUm"]), 1.0)
        self.assertLessEqual(max(narrow["valuesUm"]), 2.2)
        everything_off = self.distribution(filter={**self.filter, "crossSection": False, "thicknessLimits": False})
        self.assertEqual(everything_off["counts"], raw["counts"])

    def test_removing_then_restoring_gives_back_the_same_measurement(self):
        self.distribution()
        self.run_stack_job()
        before = self.distribution()
        ring_x, ring_y = RING[1] + RING[2], RING[0]
        clicked = self.click("negative", ring_x, ring_y)
        self.assertEqual(clicked["edit"]["kind"], "exclude")
        after = self.distribution()
        self.assertLess(after["sampleCount"], before["sampleCount"])
        self.assertNotEqual(after["filter"]["token"], before["filter"]["token"])
        self.assertGreater(after["filter"]["byReason"].get("manual", 0), 0)

        undo = self.client.delete(f"/agh/api/analysis-runs/{self.middle}/edits?edit={clicked['edit']['id']}")
        self.assertEqual(undo.get_json()["removed"], 1)
        restored = self.distribution()
        self.assertEqual(restored["counts"], before["counts"])
        self.assertEqual(restored["filter"]["token"], before["filter"]["token"])

    def test_without_a_z_step_the_oblique_sheet_is_still_excluded(self):
        self.filter = {key: value for key, value in self.filter.items() if key != "zStepUm"}
        self.distribution()
        self.run_stack_job()
        raw = self.distribution(filter=None)
        kept = self.distribution()
        self.assertIsNone(kept["filter"]["zStep"]["um"])
        self.assertIsNone(kept["filter"]["limitDeg"])
        self.assertGreater(kept["filter"]["byReason"].get("oblique", 0) + kept["filter"]["byReason"].get("en-face", 0), 0)
        truth = THICKNESS_PX * PIXEL_UM * 1000.0
        self.assertLess(abs(self.mean_nm(kept) - truth), 0.15 * truth)
        self.assertGreater(self.mean_nm(raw) - truth, 0.15 * truth)
        # An entered Z step takes over at once, with no new analysis.
        entered = self.distribution(filter={**self.filter, "zStepUm": Z_STEP_UM})
        self.assertEqual(entered["filter"]["zStep"], {"um": Z_STEP_UM, "source": "entered"})
        self.assertIsNone(self.store.claim_next_run("test-worker"))

    def test_removing_a_vertical_piece_changes_only_that_piece(self):
        self.filter = {**self.filter, "maxNm": 9000}
        self.distribution()
        self.run_stack_job()
        before = np.asarray(self.refinement()["pieces"]["reason"])
        after = np.asarray(self.click("negative", RING[1] + RING[2], RING[0])["refinement"]["pieces"]["reason"])
        changed = np.nonzero(before != after)[0]
        self.assertEqual(changed.size, 1)
        self.assertEqual(self.refinement()["pieces"]["reasonNames"][str(after[changed[0]])], "manual")

    def test_marking_excluded_gbm_real_relaxes_the_threshold_around_it(self):
        # This sheet's Z projection is wider than the default upper limit.
        self.filter = {**self.filter, "maxNm": 9000}
        self.distribution()
        self.run_stack_job()
        before = self.refinement()
        reasons = np.asarray(before["pieces"]["reason"])
        excluded_before = int((reasons != 0).sum())
        center = 170 + Z_STEP_UM / PIXEL_UM * np.tan(np.radians(TILT_DEG)) * (12 - PLANES / 2) * 0.6
        clicked = self.click("positive", float(center), 215.0)
        self.assertEqual(clicked["edit"]["kind"], "include")
        after = clicked["refinement"]
        excluded_after = int((np.asarray(after["pieces"]["reason"]) != 0).sum())
        # More than the single clicked piece comes back.
        self.assertLess(excluded_after, excluded_before - 1)
        # The same image's other slices feel it too, more weakly with distance in Z.
        near = self.refinement(self.runs[14])
        self.assertGreater(near["editCount"], 0)
        self.assertEqual(near["edits"], [])

        restored = self.client.delete(f"/agh/api/analysis-runs/{self.middle}/edits?scope=image")
        self.assertEqual(restored.get_json()["removed"], 1)
        self.assertEqual(self.refinement()["pieces"]["reason"], before["pieces"]["reason"])

    def test_clicking_a_faint_line_adds_it_without_touching_the_saved_mask(self):
        from agh_api.analysis_artifacts import read_mask

        self.distribution()
        self.run_stack_job()
        saved = read_mask(self.config.analysis_root, self.middle, attempt=1).copy()
        before = self.distribution()
        clicked = self.click("positive", 225.0, 20.0)
        self.assertEqual(clicked["edit"]["kind"], "add")
        after = self.distribution()
        self.assertGreater(after["sampleCount"], before["sampleCount"] + 40)
        np.testing.assert_array_equal(read_mask(self.config.analysis_root, self.middle, attempt=1), saved)

        view = clicked["refinement"]
        label = self.client.get(f"/agh/api/analysis-runs/{self.middle}/refinement/label.png?token={view['labelToken']}")
        self.assertEqual(label.status_code, 200)
        pixels = np.asarray(Image.open(BytesIO(label.data)).convert("RGB"), dtype=np.int32)
        identity = pixels[..., 0] + 256 * pixels[..., 1]
        self.assertGreater(identity[self.faint].mean(), 0.0)
        self.assertLess(identity.max() - 1, view["pieces"]["count"])

        self.client.delete(f"/agh/api/analysis-runs/{self.middle}/edits?scope=slice")
        self.assertEqual(self.distribution()["counts"], before["counts"])

    def paint(self, kind, stroke, radius=6, status=201):
        response = self.client.post(f"/agh/api/analysis-runs/{self.middle}/edits", json={
            "calibration": self.calibration, "filter": self.filter, "kind": kind, "stroke": stroke, "radius": radius,
        })
        self.assertEqual(response.status_code, status, response.get_json())
        return response.get_json()

    def test_removing_with_the_brush_takes_only_what_it_covers(self):
        self.distribution()
        self.run_stack_job()
        before = self.distribution()
        # Across the ring wall on its right side, about 12 pixels of brush.
        x = RING[1] + RING[2]
        painted = self.paint("negative", [[x - 15, RING[0]], [x + 15, RING[0]]])
        self.assertEqual(painted["edit"]["kind"], "paint-remove")
        after = self.distribution()
        removed = before["sampleCount"] - after["sampleCount"]
        self.assertGreater(removed, 5)
        self.assertLess(removed, 45, "only the painted length of the wall goes")
        self.assertGreater(after["filter"]["byReason"].get("manual", 0), 0)
        # Nothing else changed its decision.
        reasons = painted["refinement"]["pieces"]["reasonNames"]
        names = [reasons[str(code)] for code in painted["refinement"]["pieces"]["reason"]]
        self.assertLessEqual(names.count("manual"), 2, "a stroke can straddle two pieces, no more")
        # Undo restores it exactly.
        self.client.delete(f"/agh/api/analysis-runs/{self.middle}/edits?edit={painted['edit']['id']}")
        self.assertEqual(self.distribution()["counts"], before["counts"])

    def test_keeping_with_the_brush_returns_only_what_it_covers(self):
        self.filter = {**self.filter, "maxNm": 9000}
        self.distribution()
        self.run_stack_job()
        before = self.distribution()
        center = 170 + Z_STEP_UM / PIXEL_UM * np.tan(np.radians(TILT_DEG)) * (12 - PLANES / 2) * 0.6
        painted = self.paint("positive", [[center - 40, 200.0], [center + 40, 200.0]], radius=8)
        self.assertEqual(painted["edit"]["kind"], "paint-keep")
        after = self.distribution()
        gained = after["sampleCount"] - before["sampleCount"]
        self.assertGreater(gained, 5)
        self.assertLess(gained, 40, "a stroke does not bring back GBM beyond it, unlike a click")
        # The rest of the sheet is still excluded.
        self.assertGreater(after["filter"]["byReason"].get("oblique", 0), 0)

    def test_painting_over_a_faint_line_adds_it_at_its_own_width(self):
        self.distribution()
        self.run_stack_job()
        before = self.distribution()
        wide = self.paint("positive", [[185.0, 20.0], [265.0, 20.0]], radius=25)
        self.assertEqual(wide["edit"]["kind"], "paint-keep")
        after = self.distribution()
        self.assertGreater(after["sampleCount"], before["sampleCount"] + 40)
        # Thickness comes from the probability map (12 pixels), not the 50 pixel brush.
        added = np.repeat(after["valuesUm"], after["counts"])
        self.assertLess(np.percentile(added, 5), 1.5)
        self.assertLess(max(after["valuesUm"]), 3.4)

    def test_a_later_click_overrides_an_earlier_stroke(self):
        self.distribution()
        self.run_stack_job()
        x = RING[1] + RING[2]
        self.paint("negative", [[x - 15, RING[0]], [x + 15, RING[0]]])
        removed = self.distribution()["sampleCount"]
        self.click("positive", x, RING[0])
        self.assertGreater(self.distribution()["sampleCount"], removed)

    def test_brushes_outside_anything_are_refused(self):
        self.distribution()
        self.run_stack_job()
        self.assertIn("error", self.paint("negative", [[10.0, 290.0], [30.0, 290.0]], status=409))
        self.assertIn("error", self.paint("positive", [[10.0, 290.0], [30.0, 290.0]], status=409))
        self.paint("negative", "nope", status=400)
        self.paint("negative", [[1, 2, 3]], status=400)
        self.paint("negative", [[10.0, 290.0]], radius=-3, status=400)

    def test_clicking_empty_background_finds_nothing(self):
        self.distribution()
        self.run_stack_job()
        self.assertIn("error", self.click("positive", 20.0, 280.0, status=409))
        self.assertIn("error", self.click("negative", 20.0, 280.0, status=409))

    def test_roi_measurement_honours_the_filter(self):
        self.distribution()
        self.run_stack_job()
        url = f"/agh/api/analysis-runs/{self.middle}/measurements/gbm-thickness"
        sheet = {"type": "polygon", "points": [[130, 160], [240, 160], [240, 270], [130, 270]]}
        raw = self.client.post(url, json={"calibration": self.calibration, "roi": sheet})
        self.assertEqual(raw.status_code, 200, raw.get_json())
        filtered = self.client.post(url, json={"calibration": self.calibration, "roi": sheet, "filter": self.filter})
        if filtered.status_code == 200:
            self.assertLess(filtered.get_json()["sampleCount"], raw.get_json()["sampleCount"])
        else:
            self.assertEqual(filtered.status_code, 400)
            self.assertIn("excluded", filtered.get_json()["error"])

    def test_tokens_identify_results_and_change_with_corrections(self):
        self.distribution()
        url = "/agh/api/analysis-runs/refinement-tokens"
        ids = [self.middle, self.runs[14]]
        body = {"runIds": ids, "filter": self.filter}
        self.assertEqual(self.client.post(url, json=body).get_json()["tokens"][self.middle], None)
        self.run_stack_job()
        first = self.client.post(url, json=body).get_json()["tokens"]
        self.assertEqual(first[self.middle], self.distribution()["filter"]["token"])
        self.assertTrue(first[self.runs[14]])
        self.click("negative", RING[1] + RING[2], RING[0])
        second = self.client.post(url, json=body).get_json()["tokens"]
        self.assertNotEqual(second[self.middle], first[self.middle])
        self.assertEqual(second[self.runs[14]], second[self.middle])

    def test_a_failed_analysis_is_not_queued_again_by_every_request(self):
        self.distribution()
        job = self.store.claim_next_run("test-worker")
        self.store.mark_failed(job["runId"], "test-worker", "synthetic failure")
        state = self.distribution()["filter"]
        self.assertEqual(state["state"], "failed")
        self.assertIsNone(self.store.claim_next_run("test-worker"))
        retried = self.client.post("/agh/api/cases/case1/files/stack.tif/gbm-refinement?channel=0").get_json()
        self.assertEqual(retried["state"], "queued")

    def test_a_new_analysis_replaces_the_older_one(self):
        from agh_api.analysis_artifacts import run_directory
        from agh_api.segmentation_service import OPERATION, prepare_analysis_request

        self.distribution()
        self.run_stack_job()
        old = self.distribution()["filter"]["token"].split(":")[0]
        self.assertTrue(run_directory(self.config.analysis_root, old).exists())
        # One more segmented slice makes a new analysis due.
        request, key = prepare_analysis_request(self.config, self.path, {"zIndex": 1, "channelIndex": 0})
        run, _ = self.store.create_or_reuse_run("case1", "stack.tif", OPERATION, request, cache_key=key)
        self.store.claim_next_run("test-worker")
        self.copy_artifacts(self.middle, run["runId"])
        self.store.mark_succeeded(run["runId"], "test-worker", {
            "artifactAttempt": 1, "thicknessGeometryAvailable": True, "probabilityAvailable": True,
        })
        waiting = self.distribution()["filter"]
        self.assertTrue(waiting["applied"], "the previous analysis stays in use meanwhile")
        self.assertTrue(waiting["stale"])
        self.assertIsNone(waiting["token"])
        job = self.store.claim_next_run("test-worker")
        from agh_api.gbm_refinement import execute_stack_analysis
        self.store.mark_succeeded(job["runId"], "test-worker", execute_stack_analysis(self.config, job))

        import worker
        worker._remove_superseded_analyses(self.config, self.store, job)
        self.assertFalse(run_directory(self.config.analysis_root, old).exists())
        fresh = self.distribution()["filter"]
        self.assertFalse(fresh["stale"])
        self.assertEqual(fresh["token"].split(":")[0], job["runId"])

    def copy_artifacts(self, source: str, target: str):
        import shutil
        from agh_api.analysis_artifacts import attempt_directory

        destination = attempt_directory(self.config.analysis_root, target, 1, create=True)
        for path in attempt_directory(self.config.analysis_root, source, 1).iterdir():
            shutil.copy2(path, destination / path.name)

    def test_a_restarted_worker_picks_up_what_a_dead_one_left_running(self):
        import socket
        import subprocess
        import sys
        import worker

        self.distribution()
        # A worker on this host that has exited, like one killed during a restart.
        gone = subprocess.run([sys.executable, "-c", "import os; print(os.getpid())"], capture_output=True, text=True)
        worker_id = f"{socket.gethostname()}-{int(gone.stdout)}-abc123"
        job = self.store.claim_next_run(worker_id)
        self.store.update_progress(job["runId"], worker_id, {"stage": "stack", "percent": 87.0, "fraction": 0.87})
        state = self.distribution()["filter"]
        self.assertEqual(state["state"], "running")
        self.assertIsNone(self.store.claim_next_run("other-worker"), "its lease has not expired")

        self.assertEqual(self.store.release_orphaned_runs(worker._worker_is_alive), [job["runId"]])
        self.assertEqual(self.distribution()["filter"]["state"], "queued")
        result = self.run_stack_job()
        self.assertEqual(result["planes"], len(self.runs))
        self.assertTrue(self.distribution()["filter"]["applied"])

    def test_a_running_worker_or_one_elsewhere_keeps_its_runs(self):
        import os
        import socket
        import worker

        self.distribution()
        here = f"{socket.gethostname()}-{os.getpid()}-abc123"
        self.assertTrue(worker._worker_is_alive(here))
        self.assertTrue(worker._worker_is_alive("another-host-99999-abc123"), "another host cannot be checked")
        self.assertTrue(worker._worker_is_alive("test-worker"))
        job = self.store.claim_next_run(here)
        self.assertEqual(self.store.release_orphaned_runs(worker._worker_is_alive), [])
        self.assertEqual(self.store.get_run(job["runId"])["status"], "RUNNING")

    def test_status_says_how_long_the_worker_has_been_silent(self):
        from datetime import timedelta
        from agh_api.analysis_store import utc_now
        from agh_api.gbm_refinement import stack_state

        self.distribution()
        job = self.store.claim_next_run("test-worker")
        fresh = stack_state(self.config, self.store, "case1", "stack.tif", 0)
        self.assertLess(fresh["job"]["heartbeatAgeSeconds"], 30)
        from datetime import datetime
        old = (datetime.fromisoformat(utc_now()) - timedelta(minutes=10)).isoformat()
        with self.store._connect() as conn:
            conn.execute("UPDATE analysis_runs SET heartbeat_at = ? WHERE run_id = ?", (old, job["runId"]))
        stale = stack_state(self.config, self.store, "case1", "stack.tif", 0)
        self.assertGreater(stale["job"]["heartbeatAgeSeconds"], 500)

    def test_stacks_with_awkward_planes_are_analysed_without_failing(self):
        from agh_api.gbm_cross_section import FilterSettings, StackPlane, analyze_stack, classify_pieces
        from agh_api.gbm_refinement import _encode_label, _save_plane
        from agh_api.gbm_thickness import prepare_thickness_geometry

        size = 120
        masks = [np.zeros((size, size), dtype=bool) for _ in range(7)]  # 0: empty
        masks[1][60, 60] = True  # one pixel
        masks[2][40:44, 20:24] = True  # a dot
        masks[3][58:62, 10:110] = True  # a line that appears once
        masks[4][:, 50:70] = True  # touches the image edges
        masks[5][20:100, 20:100] = True  # a solid block
        masks[5][40:80, 40:80] = False  # with a hole
        # 6: empty at the end
        planes = [StackPlane(z, float(z), mask, prepare_thickness_geometry(mask)) for z, mask in enumerate(masks)]
        results = analyze_stack(planes)
        self.assertEqual(sorted(results), list(range(7)))
        for plane in planes:
            analysis = results[plane.z_index]
            for z_step in (Z_STEP_UM, None):
                decided = classify_pieces(analysis, FilterSettings(), pixel_size_um=PIXEL_UM, z_step_um=z_step)
                self.assertEqual(decided["reasons"].size, analysis.piece_samples.size)
            self.assertTrue(_encode_label(plane.geometry, plane.mask, analysis.sample_piece, analysis.sample_artifact))
            _save_plane(Path(self.tmp.name) / f"plane_{plane.z_index}.npz", analysis)

    def test_frames_give_the_same_decisions_as_each_slice_on_its_own(self):
        self.distribution()
        self.run_stack_job()
        self.click("negative", RING[1] + RING[2], RING[0])
        self.paint("negative", [[RING[1] - RING[2] - 15, RING[0]], [RING[1] - RING[2] + 15, RING[0]]])
        response = self.client.post("/agh/api/analysis-runs/refinement-frames", json={
            "runIds": list(self.runs.values()), "calibration": self.calibration, "filter": self.filter,
        })
        self.assertEqual(response.status_code, 200, response.get_json())
        payload = response.get_json()
        self.assertEqual(payload["reasonNames"]["0"], "kept")
        self.assertEqual(set(payload["frames"]), set(self.runs.values()))
        for z, run_id in self.runs.items():
            view = self.refinement(run_id)
            frame = payload["frames"][run_id]
            self.assertEqual(frame["reason"], view["pieces"]["reason"], f"Z{z}")
            self.assertEqual(frame["labelToken"], view["labelToken"], f"Z{z}")
            self.assertEqual(frame["zIndex"], z)

    def test_frames_before_the_analysis_is_ready_start_it(self):
        response = self.client.post("/agh/api/analysis-runs/refinement-frames", json={
            "runIds": [self.middle], "calibration": self.calibration, "filter": self.filter,
        }).get_json()
        self.assertIsNone(response["frames"][self.middle])
        self.assertTrue(self.run_stack_job()["planes"])
        for bad in ({"runIds": [], "calibration": self.calibration}, {"runIds": [self.middle], "calibration": None}):
            with self.subTest(body=bad):
                self.assertEqual(self.client.post("/agh/api/analysis-runs/refinement-frames", json=bad).status_code, 400)

    def test_deleting_a_prediction_removes_its_corrections(self):
        self.distribution()
        self.run_stack_job()
        self.click("negative", RING[1] + RING[2], RING[0])
        self.assertEqual(self.refinement()["editCount"], 1)
        response = self.client.delete("/agh/api/cases/case1/files/stack.tif/analysis-runs?zIndex=12")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.refinement(self.runs[14])["editCount"], 0)

    def test_invalid_filters_and_clicks_are_rejected(self):
        url = f"/agh/api/analysis-runs/{self.middle}/measurements/gbm-distribution"
        for bad in ({"minNm": 500, "maxNm": 100}, {"maxTiltDeg": 120}, {"window": 0}, {"zStepUm": "x"}, "off"):
            with self.subTest(filter=bad):
                self.assertEqual(self.client.post(url, json={"calibration": self.calibration, "filter": bad}).status_code, 400)
        self.distribution()
        self.run_stack_job()
        self.assertEqual(self.click("sideways", 10, 10, status=400)["error"], "kind must be positive or negative")
        self.click("positive", -5, 10, status=400)
        self.click("positive", SIZE + 5, 10, status=400)


if __name__ == "__main__":
    unittest.main()
