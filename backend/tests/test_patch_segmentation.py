import tempfile
import unittest
from pathlib import Path

import numpy as np
import tifffile

from agh_api.magnifyseg_engine.patch_segmentation import run_patches


class FakeModel:
    def __init__(self, expected_channels, n_classes=2):
        self.expected_channels = expected_channels
        self.n_classes = n_classes
        self.seen_shape = None

    def predict(self, batch):
        self.seen_shape = batch.shape
        if batch.shape != (1, 576, 576, self.expected_channels):
            raise AssertionError(f"Unexpected model input shape: {batch.shape}")
        pred = np.zeros((1, 576, 576, self.n_classes), dtype=np.float32)
        pred[..., 1] = 1.0
        return pred


class PatchSegmentationTests(unittest.TestCase):
    def test_small_single_channel_image_is_padded_before_prediction(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "small.tif"
            tifffile.imwrite(path, np.ones((400, 500), dtype=np.uint8))
            model = FakeModel(expected_channels=1)

            result = run_patches(str(path), model, 576, 576, 2, 576, 576)

        self.assertEqual(model.seen_shape, (1, 576, 576, 1))
        self.assertEqual(result.shape, (400, 500))
        self.assertTrue(np.all(result == 1))

    def test_small_two_channel_image_is_padded_before_prediction(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "small_combined.tif"
            tifffile.imwrite(path, np.ones((2, 400, 500), dtype=np.uint8))
            model = FakeModel(expected_channels=2)

            result = run_patches(str(path), model, 576, 576, 2, 576, 576)

        self.assertEqual(model.seen_shape, (1, 576, 576, 2))
        self.assertEqual(result.shape, (400, 500))
        self.assertTrue(np.all(result == 1))


if __name__ == "__main__":
    unittest.main()
