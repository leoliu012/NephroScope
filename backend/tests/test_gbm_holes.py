"""Small holes in predicted GBM are closed only where slices below and above both have GBM there."""
import unittest

import numpy as np

try:
    import scipy  # noqa: F401
    import skimage  # noqa: F401
    HAS_RUNTIME = True
except ImportError:  # pragma: no cover - the API server may run without them
    HAS_RUNTIME = False

from tests.test_gbm_refinement import PIXEL_UM, PLANES, RING, SIZE, THICKNESS_PX, StackFixture, scene_volume

WALL = 20


def wall(size=120, center=60.0, width=WALL):
    _, xx = np.mgrid[:size, :size]
    return np.abs(xx - center) < width / 2


def stack(masks, centers=None, registrations=None):
    from agh_api.gbm_cross_section import StackPlane
    from agh_api.gbm_thickness import prepare_thickness_geometry

    return [
        StackPlane(z, float(z if centers is None else centers[z]), mask, prepare_thickness_geometry(mask), None if registrations is None else registrations[z])
        for z, mask in enumerate(masks)
    ]


@unittest.skipUnless(HAS_RUNTIME, "scipy and scikit-image are required")
class SmallHoleTests(unittest.TestCase):
    def test_only_small_enclosed_background_is_a_hole(self):
        from agh_api.gbm_holes import small_holes

        yy, xx = np.mgrid[:200, :200]
        ring = np.abs(np.hypot(yy - 100, xx - 100) - 60) < WALL / 2
        mask = ring.copy()
        mask[38:42, 98:102] = False          # a pinhole in the wall
        mask[150:166, 92:108] = False        # as wide as the wall: an opening, not a hole
        found = small_holes(mask, float(WALL))
        self.assertEqual(len(found), 1, "the lumen inside the ring and the opening are not holes")
        rows, columns = found[0]
        self.assertEqual((rows.min(), rows.max(), columns.min(), columns.max()), (38, 41, 98, 101))

    def test_a_hole_that_meets_the_outside_only_at_a_corner_is_still_enclosed(self):
        from agh_api.gbm_holes import small_holes

        mask = wall()
        mask[58:62, 58:62] = False
        mask[62, 62] = False                 # touches the hole at a corner only
        mask[62:, 63:] &= wall()[62:, 63:]
        self.assertEqual(len(small_holes(mask, float(WALL))), 2)
        open_to_edge = wall()
        open_to_edge[0:4, 58:62] = False     # runs off the image
        self.assertEqual(small_holes(open_to_edge, float(WALL)), [])

    def test_a_hole_too_wide_for_the_membrane_is_left(self):
        from agh_api.gbm_holes import HOLE_MAX_WIDTH, small_holes

        mask = wall(width=40)
        mask[50:66, 52:68] = False           # 16 px across in a 40 px membrane
        self.assertEqual(len(small_holes(mask, 40.0)), 1)
        self.assertEqual(small_holes(mask, 16.0 / HOLE_MAX_WIDTH - 2.0), [])


@unittest.skipUnless(HAS_RUNTIME, "scipy and scikit-image are required")
class HolesToFillTests(unittest.TestCase):
    def holed(self, planes_with_hole, count=9, lean=0.0):
        masks = []
        for z in range(count):
            mask = wall(center=60.0 + lean * (z - count // 2))
            if z in planes_with_hole:
                middle = int(round(60.0 + lean * (z - count // 2)))
                mask[58:62, middle - 2:middle + 2] = False
            masks.append(mask)
        return masks

    def test_a_hole_in_one_slice_is_filled(self):
        from agh_api.gbm_holes import holes_to_fill

        fills = holes_to_fill(stack(self.holed({4})))
        self.assertEqual(list(fills), [4])
        self.assertEqual(fills[4].holes, 1)
        self.assertEqual(int(fills[4].pixels.sum()), 16)
        self.assertTrue(fills[4].pixels[58:62, 58:62].all())

    def test_a_hole_in_a_leaning_sheet_is_filled(self):
        from agh_api.gbm_holes import holes_to_fill

        fills = holes_to_fill(stack(self.holed({4}, lean=2.5)))
        self.assertEqual({z: fill.holes for z, fill in fills.items()}, {4: 1})

    def test_a_hole_that_lasts_through_the_slices_is_left(self):
        from agh_api.gbm_holes import holes_to_fill

        self.assertEqual(holes_to_fill(stack(self.holed(set(range(9))))), {})
        # Every slice of a hole gets the same answer: three planes long it is closed, four it is not.
        self.assertEqual(sorted(holes_to_fill(stack(self.holed({3, 4, 5})))), [3, 4, 5])
        self.assertEqual(holes_to_fill(stack(self.holed({2, 3, 4, 5}))), {})

    def test_gbm_on_one_side_only_is_not_enough(self):
        from agh_api.gbm_holes import holes_to_fill

        masks = self.holed({4})
        for z in range(5, 9):
            masks[z][40:80] = False          # above, the membrane is not there at all
        self.assertEqual(holes_to_fill(stack(masks)), {})
        # Nor are the first and last slices judged: they have nothing on one side.
        self.assertEqual(holes_to_fill(stack(self.holed({0, 8}))), {})

    def test_the_same_projection_twice_is_not_a_second_opinion(self):
        from agh_api.gbm_holes import holes_to_fill

        masks = self.holed({2}, count=4)
        # Slices 0 to 2 repeat one projection, as a stack's first slices do.
        self.assertEqual(holes_to_fill(stack(masks, centers=[2.0, 2.0, 2.0, 3.0])), {})
        self.assertEqual(sorted(holes_to_fill(stack(masks, centers=[0.0, 1.0, 2.0, 3.0]))), [2])

    def test_slices_too_far_apart_do_not_fill_each_other(self):
        from agh_api.gbm_holes import holes_to_fill

        masks = self.holed({1}, count=3)
        # Every second plane leaves three planes uncovered at the hole; every third leaves five.
        self.assertEqual(sorted(holes_to_fill(stack(masks, centers=[0.0, 2.0, 4.0]))), [1])
        self.assertEqual(holes_to_fill(stack(masks, centers=[0.0, 3.0, 6.0])), {})

    def test_a_moving_field_is_followed(self):
        from agh_api.gbm_holes import holes_to_fill

        slide = 30
        masks, registrations = [], []
        for z in range(5):
            mask = np.roll(wall(size=240, center=60.0), slide * z, axis=1)
            if z == 2:
                mask[58:62, 58 + slide * z:62 + slide * z] = False
            masks.append(mask)
            registrations.append(np.array([[1.0, 0.0, 0.0], [0.0, 1.0, float(slide * z)]]))
        self.assertEqual(holes_to_fill(stack(masks)), {}, "read as it lies in the image, the wall is somewhere else in every slice")
        self.assertEqual(sorted(holes_to_fill(stack(masks, registrations=registrations))), [2])


@unittest.skipUnless(HAS_RUNTIME, "scipy and scikit-image are required")
class HoleFillApiTests(StackFixture):
    """A pinhole in the ring of one slice, and one that runs through the whole stack."""

    HOLE = (slice(RING[0] - 2, RING[0] + 2), slice(RING[1] + RING[2] - 2, RING[1] + RING[2] + 2))
    LASTING = (slice(RING[0] + RING[2] - 2, RING[0] + RING[2] + 2), slice(RING[1] - 2, RING[1] + 2))

    def mask_volume(self) -> np.ndarray:
        volume = scene_volume()
        # Through planes 10 to 14, so only the slice projecting exactly those shows it.
        for z in range(10, 15):
            volume[(z, *self.HOLE)] = False
        for z in range(PLANES):
            volume[(z, *self.LASTING)] = False
        return volume

    def view(self):
        from agh_api.gbm_refinement import plane_view

        run = self.store.get_run(self.middle)
        return run, plane_view(self.config, self.store, run, {})

    def test_the_hole_one_slice_has_is_closed_and_the_lasting_one_is_not(self):
        from agh_api.analysis_artifacts import read_mask
        from agh_api.gbm_refinement import plane_mask

        saved = read_mask(self.config.analysis_root, self.middle, attempt=1)
        self.assertFalse(saved[self.HOLE].any())
        self.distribution()
        result = self.run_stack_job()
        self.assertEqual(result["holesFilled"], 1)
        self.assertEqual(result["planesWithHolesFilled"], 1)

        refinement = self.refinement()
        self.assertEqual(refinement["holesFilled"], 1)
        self.assertEqual(refinement["stack"]["holesFilled"], 1)
        self.assertEqual(self.refinement(self.runs[10])["holesFilled"], 0)

        run, view = self.view()
        filled = plane_mask(self.config, run, view.fill)
        self.assertTrue(filled[self.HOLE].all())
        self.assertFalse(filled[self.LASTING].any(), "a hole in every slice may be a real opening")
        self.assertEqual(int(filled.sum() - saved.sum()), 16)
        # The saved prediction keeps its hole.
        self.assertFalse(read_mask(self.config.analysis_root, self.middle, attempt=1)[self.HOLE].any())

    def test_the_centerline_runs_through_the_closed_hole(self):
        from agh_api.analysis_artifacts import thickness_geometry_path
        from agh_api.gbm_thickness import load_thickness_geometry

        self.distribution()
        self.run_stack_job()
        _, view = self.view()
        before = load_thickness_geometry(thickness_geometry_path(self.config.analysis_root, self.middle, attempt=1))
        rows, columns = self.HOLE

        def at_hole(geometry):
            near = (
                (geometry.skeleton_y >= rows.start - 12) & (geometry.skeleton_y < rows.stop + 12)
                & (geometry.skeleton_x >= columns.start - 12) & (geometry.skeleton_x < columns.stop + 12)
            )
            return geometry.local_thickness_pixels[near]

        self.assertLess(at_hole(before).min(), 0.7 * THICKNESS_PX, "around the hole the membrane read as two thin ones")
        self.assertGreater(at_hole(view.geometry).min(), 0.85 * THICKNESS_PX)
        # What is measured is the plane with the hole closed.
        kept = self.distribution()
        truth = THICKNESS_PX * PIXEL_UM * 1000.0
        self.assertLess(abs(self.mean_nm(kept) - truth), 0.1 * truth)

    def test_corrections_work_on_a_plane_with_a_closed_hole(self):
        self.distribution()
        self.run_stack_job()
        before = self.distribution()["sampleCount"]
        self.click("negative", RING[1] + RING[2], RING[0])
        after = self.distribution()
        self.assertLess(after["sampleCount"], before)
        painted = self.client.post(f"/agh/api/analysis-runs/{self.middle}/edits", json={
            "calibration": self.calibration, "filter": self.filter, "kind": "positive",
            "stroke": [[RING[1] + RING[2] - 6, RING[0]], [RING[1] + RING[2] + 6, RING[0]]], "radius": 8,
        })
        self.assertEqual(painted.status_code, 201, painted.get_json())
        _, view = self.view()
        self.assertIsNotNone(view.fill)
        self.assertEqual(view.analysis.sample_piece.size, view.geometry.skeleton_y.size)


if __name__ == "__main__":
    unittest.main()
