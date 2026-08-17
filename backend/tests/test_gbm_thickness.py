import unittest
from io import BytesIO

import numpy as np

from agh_api import gbm_thickness


@unittest.skipUnless(
    gbm_thickness.thickness_runtime_available(),
    "GBM thickness tests require scipy and scikit-image",
)
class GBMThicknessTests(unittest.TestCase):
    @staticmethod
    def ribbon():
        mask = np.zeros((160, 220), dtype=np.uint8)
        mask[70:90, 20:200] = 1
        roi = np.array([[60, 40], [160, 40], [160, 120], [60, 120]], float)
        return mask, roi

    def test_matches_notebook_twenty_pixel_ribbon_self_check(self):
        mask, roi = self.ribbon()

        result = gbm_thickness.measure_gbm_thickness(
            mask,
            roi,
            pixel_size_x_um=0.5,
            pixel_size_y_um=0.5,
            expansion_factor=2.0,
        )

        self.assertAlmostEqual(result["mean_thickness_pixels"], 20.0, places=6)
        self.assertAlmostEqual(result["observed_mean_um"], 10.0, places=6)
        self.assertAlmostEqual(result["corrected_mean_um"], 5.0, places=6)
        self.assertAlmostEqual(result["meanThickness"], 5.0, places=6)
        self.assertEqual(result["unit"], "µm")
        self.assertEqual(result["sampleCount"], result["centerline_sample_count"])
        self.assertFalse(result["anisotropic_pixel_size"])
        self.assertEqual(result["pixel_size_um_per_pixel"], 0.5)
        self.assertGreater(result["centerline_sample_count"], 20)

    def test_anisotropic_physical_edt_uses_yx_sampling(self):
        mask, roi = self.ribbon()

        result = gbm_thickness.measure_gbm_thickness(
            mask,
            roi,
            pixel_size_x_um=0.25,
            pixel_size_y_um=0.75,
            expansion_factor=3.0,
        )

        self.assertAlmostEqual(result["mean_thickness_pixels"], 20.0, places=6)
        self.assertAlmostEqual(result["observed_mean_um"], 15.0, places=6)
        self.assertAlmostEqual(result["corrected_mean_um"], 5.0, places=6)
        self.assertTrue(result["anisotropic_pixel_size"])
        self.assertIsNone(result["pixel_size_um_per_pixel"])
        self.assertEqual(result["physical_edt_sampling_yx_um"], [0.75, 0.25])

    def test_geometry_artifact_round_trip_and_numpy_only_measurement(self):
        mask, roi = self.ribbon()
        geometry = gbm_thickness.prepare_thickness_geometry(mask)
        buffer = BytesIO()
        np.savez_compressed(
            buffer,
            **gbm_thickness.thickness_geometry_to_arrays(geometry),
        )
        buffer.seek(0)
        loaded = gbm_thickness.load_thickness_geometry(buffer)

        result = gbm_thickness.measure_gbm_thickness_from_geometry(
            loaded,
            roi,
            pixel_size_x_um=0.5,
            pixel_size_y_um=0.5,
        )
        self.assertAlmostEqual(result["observed_mean_um"], 10.0, places=6)
        self.assertEqual(loaded.shape, mask.shape)
        np.testing.assert_array_equal(loaded.skeleton_x, geometry.skeleton_x)

    def test_roi_without_centerline_is_rejected(self):
        mask, _ = self.ribbon()
        empty_roi = np.array([[0, 0], [10, 0], [10, 10], [0, 10]], float)

        with self.assertRaisesRegex(ValueError, "No segmented GBM centerline"):
            gbm_thickness.measure_gbm_thickness(
                mask,
                empty_roi,
                pixel_size_x_um=0.5,
            )

    def test_empty_mask_has_valid_artifact_and_friendly_measurement_error(self):
        mask = np.zeros((40, 60), dtype=np.uint8)
        geometry = gbm_thickness.prepare_thickness_geometry(mask)
        self.assertEqual(geometry.total_component_count, 0)
        self.assertEqual(geometry.skeleton_x.size, 0)

        buffer = BytesIO()
        np.savez_compressed(
            buffer,
            **gbm_thickness.thickness_geometry_to_arrays(geometry),
        )
        buffer.seek(0)
        loaded = gbm_thickness.load_thickness_geometry(buffer)
        roi = np.array([[0, 0], [59, 0], [59, 39], [0, 39]], float)
        with self.assertRaisesRegex(ValueError, "No segmented GBM centerline"):
            gbm_thickness.measure_gbm_thickness_from_geometry(
                loaded,
                roi,
                pixel_size_x_um=0.5,
            )

    def test_polygon_area_and_expansion_corrected_area(self):
        mask, roi = self.ribbon()
        result = gbm_thickness.measure_gbm_thickness(
            mask,
            roi,
            pixel_size_x_um=0.5,
            pixel_size_y_um=0.25,
            expansion_factor=2.0,
        )

        self.assertAlmostEqual(result["roi_area_pixels2"], 8000.0)
        self.assertAlmostEqual(result["roi_area_observed_um2"], 1000.0)
        self.assertAlmostEqual(result["roi_area_corrected_um2"], 250.0)


if __name__ == "__main__":
    unittest.main()
