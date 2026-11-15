"""The 3D volume of a stack's predictions that the viewer's 3D mode draws."""
import unittest
from unittest import mock

import numpy as np

from agh_api import gbm_volume
from agh_api.gbm_cross_section import REASON_KEPT, REASON_NAMES
from agh_api.gbm_volume import VolumeGrid, parse_volume, reduce_coverage, reduce_reason

# Imported as a module, so its test classes are not collected a second time from here.
import test_gbm_refinement as base

HAS_RUNTIME, PLANES, RING, SIZE = base.HAS_RUNTIME, base.PLANES, base.RING, base.SIZE

OBLIQUE = next(code for code, name in REASON_NAMES.items() if name == "oblique")


class ReductionTests(unittest.TestCase):
    def test_coverage_is_the_share_of_each_block(self):
        mask = np.zeros((5, 4), dtype=bool)
        mask[:2, :2] = True
        mask[2, 2] = True
        reduced = reduce_coverage(mask, 2)
        # The last row of blocks runs past the image, and what is past it is empty.
        self.assertEqual(reduced.tolist(), [[255, 0], [0, 64], [0, 0]])
        self.assertEqual(reduce_coverage(mask, 1).max(), 255)

    def test_a_block_takes_the_reason_found_in_it(self):
        reason = np.zeros((4, 4), dtype=np.uint8)
        reason[0, 1] = 2
        reason[3, 3] = 7
        self.assertEqual(reduce_reason(reason, 2).tolist(), [[2, 0], [0, 7]])

    def test_voxels_map_to_the_middle_of_their_block(self):
        grid = VolumeGrid(100, 200, 4, None)
        self.assertEqual((grid.rows, grid.columns), (25, 50))
        matrix = grid.plane_from_voxel(0)
        y, x = matrix @ np.array([0.0, 0.0, 1.0])
        self.assertEqual((y, x), (1.5, 1.5))
        y, x = matrix @ np.array([24.0, 49.0, 1.0])
        self.assertEqual((y, x), (97.5, 197.5))

    def test_a_moving_field_widens_the_volume_and_keeps_the_sample_still(self):
        # Each slice sees the sample 4 px further along x.
        registrations = {z: np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 4.0 * z]]) for z in range(4)}
        grid = VolumeGrid(40, 60, 2, registrations)
        self.assertEqual(grid.origin_x, -12)
        self.assertEqual((grid.rows, grid.columns), (20, 36))
        coverage = np.zeros((20, 30), dtype=np.uint8)
        column_in_plane = 10
        coverage[:, column_in_plane] = 255
        columns = []
        for z in range(4):
            placed, _, _ = grid.place(z, coverage, coverage, np.zeros_like(coverage))
            columns.append(int(placed[10].argmax()))
            # And the way back from a voxel is the slice's own pixel.
            _, x = grid.plane_from_voxel(z) @ np.array([10.0, columns[-1], 1.0])
            self.assertAlmostEqual(float(x), column_in_plane * 2 + 0.5, delta=1.0)
        # A field that moves further than a quarter of the image is cut there.
        far = VolumeGrid(40, 60, 2, {0: np.eye(2, 3), 1: np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 50.0]])})
        self.assertEqual(far.origin_x, -15)
        self.assertEqual(columns, [16, 14, 12, 10])


class EverySliceFixture(base.StackFixture):
    PLANE_STEP = 1

    def volume(self, run_ids=None, status=200, **body):
        response = self.client.post("/agh/api/analysis-runs/gbm-volume", json={
            "runIds": list(self.runs.values()) if run_ids is None else run_ids,
            "calibration": self.calibration, "filter": self.filter, **body,
        })
        self.assertEqual(response.status_code, status, response.get_data()[:300])
        return parse_volume(response.get_data()) if status == 200 else response.get_json()


@unittest.skipUnless(HAS_RUNTIME, "scipy and scikit-image are required")
class VolumeApiTests(EverySliceFixture):
    def test_every_slice_becomes_a_layer_of_its_prediction(self):
        header, coverage, kept, reason = self.volume()
        self.assertEqual(header["size"], [SIZE, SIZE, PLANES])
        self.assertEqual(header["factor"], 1)
        self.assertEqual(header["zIndices"], list(range(PLANES)))
        self.assertEqual(header["runIds"], [self.runs[z] for z in range(PLANES)])
        self.assertEqual(header["voxelUm"], {"x": 0.1, "y": 0.1, "z": 0.4})
        self.assertFalse(header["registered"])
        # No Z analysis yet: the plain prediction, all of it counting.
        self.assertEqual(header["decidedLayers"], 0)
        np.testing.assert_array_equal(coverage, kept)
        self.assertFalse(reason.any())
        from agh_api.analysis_artifacts import read_mask

        mask = read_mask(self.config.analysis_root, self.runs[7], attempt=1)
        np.testing.assert_array_equal(coverage[7] > 0, mask)

    def test_decisions_and_corrections_show_in_the_volume(self):
        # The tilted sheet's Z projection is wider than the default upper thickness limit.
        self.filter = {**self.filter, "maxNm": 9000}
        self.volume()
        self.run_stack_job()
        header, coverage, kept, reason = self.volume()
        self.assertEqual(header["decidedLayers"], PLANES)
        middle = PLANES // 2
        ring = np.zeros((SIZE, SIZE), dtype=bool)
        yy, xx = np.mgrid[:SIZE, :SIZE]
        ring[np.abs(np.hypot(yy - RING[0], xx - RING[1]) - RING[2]) < 5] = True
        sheet = (np.abs(xx - 170) < 5) & (yy > 170) & (yy < 260)
        # The vertical tube counts; the sheet tilted 50 degrees does not, and says why.
        self.assertGreater(kept[middle][ring].mean(), 0.9 * 255)
        self.assertEqual(kept[middle][sheet].max(), 0)
        self.assertEqual(coverage[middle][sheet].min(), 255)
        self.assertGreater((reason[middle][sheet] == OBLIQUE).mean(), 0.9)
        self.assertEqual(REASON_KEPT, 0)

        # Someone marks the sheet as real on the middle slice.
        self.click("positive", 170, 215, run_id=self.runs[middle])
        _, _, kept_after, _ = self.volume()
        self.assertGreater(kept_after[middle][sheet].mean(), 0.5 * 255)

    def test_large_images_are_reduced(self):
        with mock.patch.object(gbm_volume, "MAX_SIDE", 100):
            header, coverage, _, _ = self.volume()
        self.assertEqual(header["factor"], 3)
        self.assertEqual(header["size"], [100, 100, PLANES])
        self.assertAlmostEqual(header["voxelUm"]["x"], 0.3)
        self.assertEqual(coverage.shape, (PLANES, 100, 100))
        full = parse_volume(self.client.post("/agh/api/analysis-runs/gbm-volume", json={
            "runIds": list(self.runs.values()), "calibration": self.calibration, "filter": self.filter,
        }).get_data())[1]
        self.assertAlmostEqual(float(coverage.mean()), float(full.mean()), delta=0.02 * float(full.mean()))
        # A click on a voxel lands inside its block of the image.
        y, x = np.asarray(header["planeFromVoxel"][3]).reshape(2, 3) @ np.array([10.0, 20.0, 1.0])
        self.assertEqual((y, x), (31.0, 61.0))

    def test_a_stack_missing_slices_is_refused(self):
        partial = [self.runs[z] for z in range(PLANES) if z != 5]
        self.assertIn("every Z slice", self.volume(run_ids=partial, status=409)["error"])
        self.assertIn("no longer exist", self.volume(run_ids=[*partial, "0" * 32], status=409)["error"])

    def test_a_compressed_volume_is_sent_when_the_browser_takes_it(self):
        response = self.client.post("/agh/api/analysis-runs/gbm-volume", headers={"Accept-Encoding": "gzip"}, json={
            "runIds": list(self.runs.values()), "calibration": self.calibration, "filter": self.filter,
        })
        self.assertEqual(response.headers["Content-Encoding"], "gzip")
        self.assertLess(len(response.get_data()), SIZE * SIZE * PLANES // 20)
        self.assertEqual(parse_volume(response.get_data())[0]["size"], [SIZE, SIZE, PLANES])


@unittest.skipUnless(HAS_RUNTIME, "scipy and scikit-image are required")
class ShortStackTests(EverySliceFixture):
    def test_ten_slices_are_too_few(self):
        with mock.patch.object(gbm_volume, "MIN_PLANES", PLANES + 1):
            self.assertIn("more than", self.volume(status=409)["error"])


@unittest.skipUnless(HAS_RUNTIME, "scipy and scikit-image are required")
class MovingVolumeTests(EverySliceFixture):
    """The vertical tube again, with the whole field sliding through the stack."""

    SLIDE = base.MovingStackApiTests.SLIDE
    raw_volume = base.MovingStackApiTests.raw_volume
    mask_volume = base.MovingStackApiTests.mask_volume

    def test_a_sliding_stack_is_drawn_in_register(self):
        self.volume()
        self.run_stack_job()
        header, coverage, _, _ = self.volume()
        self.assertTrue(header["registered"])
        self.assertGreater(header["size"][0], SIZE + 30)  # Widened by the slide of 2.5 px per plane.
        centers = []
        for z in (4, 12, 20):
            rows, columns = np.nonzero(coverage[z] > 127)
            centers.append((rows.mean(), columns.mean()))
            # Back in the slice's own image, the tube is where its prediction has it.
            y, x = np.asarray(header["planeFromVoxel"][z]).reshape(2, 3) @ np.array([rows.mean(), columns.mean(), 1.0])
            self.assertAlmostEqual(float(y), RING[0] + 70 + self.SLIDE[0] * z, delta=3.0)
            self.assertAlmostEqual(float(x), RING[1] + 70 + self.SLIDE[1] * z, delta=3.0)
        # The tube is vertical in the sample, so it stays put in the volume while sliding 40 px in the images.
        self.assertLess(max(abs(a[1] - b[1]) for a in centers for b in centers), 4.0)


if __name__ == "__main__":
    unittest.main()
