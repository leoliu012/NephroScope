import unittest

import numpy as np

from agh_api.magnifyseg_engine.preprocess import direct_uint8_stack, preprocess_stack


class PreprocessTests(unittest.TestCase):
    def test_direct_uint8_preserves_processed_input_distribution(self):
        arr = np.full((576, 576), 47, dtype=np.uint8)
        arr[0, 0] = 48

        direct = direct_uint8_stack(arr)

        self.assertEqual(direct.dtype, np.uint8)
        self.assertEqual(direct.shape, arr.shape)
        self.assertAlmostEqual(float(direct.mean()) / 255.0, float(arr.mean()) / 255.0, places=6)

    def test_direct_uint8_does_not_percentile_stretch_channels(self):
        stack = np.stack([
            np.full((8, 8), 20, dtype=np.uint8),
            np.full((8, 8), 80, dtype=np.uint8),
        ], axis=0)

        direct = direct_uint8_stack(stack)

        np.testing.assert_array_equal(direct, stack)

    def test_percentile_stretch_matches_auto_enhance_math(self):
        arr = np.array([[0, 10, 20], [30, 40, 50]], dtype=np.uint8)
        lo = np.percentile(arr.astype(np.float32), 1.0)
        hi = np.percentile(arr.astype(np.float32), 99.7)
        expected = np.clip(arr.astype(np.float32) * (255.0 / (hi - lo)) + (-lo * (255.0 / (hi - lo))), 0, 255).astype(np.uint8)

        enhanced = preprocess_stack(arr)

        np.testing.assert_array_equal(enhanced, expected)

    def test_percentile_stretch_does_not_normalize_by_max_first(self):
        arr = np.array([[-5, -4, -3], [-2, -1, 0]], dtype=np.float32)

        enhanced = preprocess_stack(arr)

        self.assertGreater(float(enhanced.max()), 0.0)


if __name__ == "__main__":
    unittest.main()
