import unittest
import tempfile
from pathlib import Path

import numpy as np
import tifffile

from agh_api.errors import UnsupportedTiff
from agh_api.tiff_service import _read_pixel_calibration, load_raw_plane, normalise_array_to_channels, normalise_shape_to_czyx


class _FakePage:
    tags = {}


class _FakeSeries:
    pages = [_FakePage()]


class _FakeTiff:
    series = [_FakeSeries()]

    def __init__(self, imagej_metadata=None, ome_metadata=None):
        self.imagej_metadata = imagej_metadata or {}
        self.ome_metadata = ome_metadata


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

    def test_load_raw_plane_from_czyx_without_mip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "stack.tif"
            arr = np.arange(48, dtype=np.uint16).reshape(2, 2, 3, 4)
            tifffile.imwrite(path, arr, metadata={"axes": "CZYX"})
            plane = load_raw_plane(path, channel_index=1, z_index=0)
            np.testing.assert_array_equal(plane, arr[1, 0].astype(np.float32))

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

    def test_pixel_calibration_does_not_use_z_spacing_as_xy_size(self):
        pixel_size, unit = _read_pixel_calibration(_FakeTiff({"spacing": 7.0, "unit": "um"}))
        self.assertIsNone(pixel_size)
        self.assertEqual(unit, "um")

    def test_pixel_calibration_reads_ome_physical_size_x(self):
        xml = """<?xml version="1.0" encoding="UTF-8"?>
        <OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">
          <Image ID="Image:0">
            <Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint16"
              SizeX="4" SizeY="3" SizeZ="1" SizeC="1" SizeT="1"
              PhysicalSizeX="0.014" PhysicalSizeXUnit="{unit}" />
          </Image>
        </OME>
        """.format(unit="\u00b5m")
        pixel_size, unit = _read_pixel_calibration(_FakeTiff(ome_metadata=xml))
        self.assertEqual(pixel_size, 0.014)
        self.assertEqual(unit, "um")


if __name__ == "__main__":
    unittest.main()
