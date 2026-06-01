import unittest

import numpy as np

from agh_api.errors import UnsupportedTiff
from agh_api.tiff_service import normalise_array_to_channels, normalise_shape_to_czyx


class TiffServiceTests(unittest.TestCase):
    def test_yx_single_channel(self):
        arr = np.arange(12, dtype=np.uint16).reshape(3, 4)
        channels = normalise_array_to_channels(arr, "YX")
        self.assertEqual(len(channels), 1)
        np.testing.assert_array_equal(channels[0], arr)
        self.assertEqual(normalise_shape_to_czyx(arr.shape, "YX"), (1, 1, 3, 4))

    def test_cyx(self):
        arr = np.arange(24, dtype=np.uint16).reshape(2, 3, 4)
        channels = normalise_array_to_channels(arr, "CYX")
        self.assertEqual(len(channels), 2)
        np.testing.assert_array_equal(channels[1], arr[1])

    def test_yxc(self):
        arr = np.arange(24, dtype=np.uint16).reshape(3, 4, 2)
        channels = normalise_array_to_channels(arr, "YXC")
        self.assertEqual(len(channels), 2)
        np.testing.assert_array_equal(channels[1], arr[:, :, 1])

    def test_zyx_mip(self):
        arr = np.arange(24, dtype=np.uint16).reshape(2, 3, 4)
        channels = normalise_array_to_channels(arr, "ZYX")
        self.assertEqual(len(channels), 1)
        np.testing.assert_array_equal(channels[0], arr.max(axis=0))

    def test_czyx_mip(self):
        arr = np.arange(48, dtype=np.uint16).reshape(2, 2, 3, 4)
        channels = normalise_array_to_channels(arr, "CZYX")
        self.assertEqual(len(channels), 2)
        np.testing.assert_array_equal(channels[0], arr[0].max(axis=0))

    def test_zcyx_mip(self):
        arr = np.arange(48, dtype=np.uint16).reshape(2, 2, 3, 4)
        channels = normalise_array_to_channels(arr, "ZCYX")
        self.assertEqual(len(channels), 2)
        np.testing.assert_array_equal(channels[1], arr[:, 1].max(axis=0))

    def test_tc_zyx_singleton_time(self):
        arr = np.arange(48, dtype=np.uint16).reshape(1, 2, 2, 3, 4)
        channels = normalise_array_to_channels(arr, "TCZYX")
        self.assertEqual(len(channels), 2)
        np.testing.assert_array_equal(channels[0], arr[0, 0].max(axis=0))

    def test_rejects_non_singleton_time(self):
        arr = np.zeros((2, 1, 1, 3, 4), dtype=np.uint16)
        with self.assertRaises(UnsupportedTiff):
            normalise_array_to_channels(arr, "TCZYX")


if __name__ == "__main__":
    unittest.main()
