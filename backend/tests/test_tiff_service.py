import tempfile
import unittest
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

from agh_api.errors import BadRequest, UnsupportedTiff
from agh_api.tiff_service import (
    RawChannelCache,
    RAW_CHANNEL_DISPLAY_POLICY,
    RAW_DISPLAY_POLICY,
    PREVIEW_DISPLAY_POLICY,
    DEFAULT_PIXEL_SIZE_UM,
    get_metadata,
    infer_axes,
    render_raw_channel_bytes,
    render_raw_image_png,
    render_preview_png,
)


class TiffServiceTests(unittest.TestCase):
    def test_infers_plain_yx_image(self):
        self.assertEqual(infer_axes((3, 4)), "YX")

    def test_metadata_reads_dimensions_without_render_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image.tif"
            tifffile.imwrite(path, np.arange(12, dtype=np.uint16).reshape(3, 4), metadata={"axes": "YX"})

            metadata = get_metadata(path)

            self.assertEqual(metadata["width"], 4)
            self.assertEqual(metadata["height"], 3)
            self.assertEqual(metadata["sampleDtype"], "uint16")
            self.assertEqual(metadata["bitsPerSample"], 16)
            self.assertEqual(metadata["displayPolicy"], RAW_DISPLAY_POLICY)
            self.assertEqual(metadata["previewDisplayPolicy"], PREVIEW_DISPLAY_POLICY)


    def test_metadata_uses_default_pixel_size_when_calibration_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image.tif"
            tifffile.imwrite(path, np.arange(12, dtype=np.uint16).reshape(3, 4), metadata={"axes": "YX"})

            metadata = get_metadata(path)

            self.assertAlmostEqual(metadata["pixelSizeXUm"], DEFAULT_PIXEL_SIZE_UM)
            self.assertAlmostEqual(metadata["pixelSizeYUm"], DEFAULT_PIXEL_SIZE_UM)
            self.assertTrue(metadata["pixelSizeIsDefault"])
            self.assertEqual(metadata["pixelSizeSource"], "default")

    def test_metadata_reads_tiff_resolution_calibration(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "resolution.tif"
            tifffile.imwrite(
                path,
                np.arange(12, dtype=np.uint16).reshape(3, 4),
                metadata={"axes": "YX"},
                resolution=(20000, 40000),
                resolutionunit="CENTIMETER",
            )

            metadata = get_metadata(path)

            self.assertAlmostEqual(metadata["pixelSizeXUm"], 0.5)
            self.assertAlmostEqual(metadata["pixelSizeYUm"], 0.25)
            self.assertFalse(metadata["pixelSizeIsDefault"])
            self.assertEqual(metadata["pixelSizeSource"], "TIFF resolution tags")

    def test_metadata_reads_imagej_description_calibration(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "imagej-description.tif"
            tifffile.imwrite(
                path,
                np.arange(12, dtype=np.uint16).reshape(3, 4),
                metadata={"axes": "YX"},
                description="unit=um\npixel_width=0.4\npixel_height=0.6\n",
            )

            metadata = get_metadata(path)

            self.assertAlmostEqual(metadata["pixelSizeXUm"], 0.4)
            self.assertAlmostEqual(metadata["pixelSizeYUm"], 0.6)
            self.assertFalse(metadata["pixelSizeIsDefault"])
            self.assertEqual(metadata["pixelSizeSource"], "ImageJ metadata")

    def test_metadata_prefers_ome_physical_size(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ome.tif"
            tifffile.imwrite(
                path,
                np.arange(12, dtype=np.uint16).reshape(3, 4),
                metadata={
                    "axes": "YX",
                    "PhysicalSizeX": 0.22,
                    "PhysicalSizeXUnit": "µm",
                    "PhysicalSizeY": 0.33,
                    "PhysicalSizeYUnit": "µm",
                },
                ome=True,
            )

            metadata = get_metadata(path)

            self.assertAlmostEqual(metadata["pixelSizeXUm"], 0.22)
            self.assertAlmostEqual(metadata["pixelSizeYUm"], 0.33)
            self.assertFalse(metadata["pixelSizeIsDefault"])
            self.assertEqual(metadata["pixelSizeSource"], "OME-XML PhysicalSize")

    def test_render_raw_png_preserves_uint16_grayscale_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image.tif"
            arr = np.array([[0, 17, 1024], [4096, 32768, 65535]], dtype=np.uint16)
            tifffile.imwrite(path, arr, metadata={"axes": "YX"})

            png = render_raw_image_png(path)
            image = Image.open(png)

            self.assertEqual(image.format, "PNG")
            np.testing.assert_array_equal(np.asarray(image), arr)

    def test_render_raw_png_uses_first_plane_without_mip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "stack.tif"
            arr = np.array([
                [[1, 2], [3, 4]],
                [[200, 201], [202, 203]],
            ], dtype=np.uint8)
            tifffile.imwrite(path, arr, metadata={"axes": "IYX"})

            png = render_raw_image_png(path)
            image = Image.open(png)

            np.testing.assert_array_equal(np.asarray(image), arr[0])

    def test_render_raw_png_rejects_formats_that_require_conversion(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "float-image.tif"
            tifffile.imwrite(path, np.array([[0.0, 0.5], [0.75, 1.0]], dtype=np.float32), metadata={"axes": "YX"})

            with self.assertRaises(UnsupportedTiff):
                render_raw_image_png(path)

    def test_render_preview_png_bounds_multichannel_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "channels.tif"
            first = np.arange(512 * 256, dtype=np.uint16).reshape(512, 256)
            second = np.flipud(first)
            tifffile.imwrite(path, np.stack([first, second]), metadata={"axes": "CYX"})

            preview = render_preview_png(path, max_size=256)
            image = Image.open(preview)

            self.assertEqual(image.format, "PNG")
            self.assertEqual(image.mode, "RGB")
            self.assertEqual(image.size, (128, 256))

    def test_metadata_describes_raw_channels_without_loading_a_render_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "channels.tif"
            arr = np.arange(24, dtype=np.uint16).reshape(3, 2, 4)
            tifffile.imwrite(path, arr, metadata={"axes": "CYX"})

            metadata = get_metadata(path)

            self.assertEqual(metadata["channelCount"], 3)
            self.assertEqual(metadata["channelAxis"], "C")
            self.assertEqual(metadata["channelBitsPerSample"], 16)
            self.assertEqual(metadata["channelValueMin"], 0)
            self.assertEqual(metadata["channelValueMax"], 65535)
            self.assertEqual(metadata["channelByteOrder"], "little")
            self.assertEqual(metadata["channelDisplayPolicy"], RAW_CHANNEL_DISPLAY_POLICY)

    def test_metadata_describes_z_stack(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "zstack.tif"
            arr = np.arange(2 * 3 * 4, dtype=np.uint16).reshape(2, 3, 4)
            tifffile.imwrite(path, arr, metadata={"axes": "ZYX"})

            metadata = get_metadata(path)

            self.assertEqual(metadata["zCount"], 2)
            self.assertEqual(metadata["zAxis"], "Z")
            self.assertEqual(metadata["channelCount"], 1)

    def test_metadata_treats_unlabelled_image_stack_as_z_stack(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image-stack.tif"
            arr = np.arange(2 * 3 * 4, dtype=np.uint16).reshape(2, 3, 4)
            tifffile.imwrite(path, arr, metadata={"axes": "IYX"})

            metadata = get_metadata(path)

            self.assertEqual(metadata["zCount"], 2)
            self.assertEqual(metadata["zAxis"], "Z")

    def test_raw_channel_bytes_preserve_selected_uint16_channel(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "channels.tif"
            arr = np.array([
                [[1, 2], [3, 4]],
                [[1000, 2000], [3000, 65535]],
            ], dtype=np.uint16)
            tifffile.imwrite(path, arr, metadata={"axes": "CYX"})

            payload = render_raw_channel_bytes(path, 1).read()

            np.testing.assert_array_equal(np.frombuffer(payload, dtype="<u2").reshape(2, 2), arr[1])

    def test_raw_channel_bytes_use_first_plane_for_non_channel_stack(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "stack.tif"
            arr = np.array([
                [[1, 2], [3, 4]],
                [[100, 101], [102, 103]],
            ], dtype=np.uint8)
            tifffile.imwrite(path, arr, metadata={"axes": "IYX"})

            payload = render_raw_channel_bytes(path, 0).read()

            np.testing.assert_array_equal(np.frombuffer(payload, dtype=np.uint8).reshape(2, 2), arr[0])

    def test_raw_channel_bytes_preserve_selected_unlabelled_stack_slice(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image-stack.tif"
            arr = np.array([
                [[1, 2], [3, 4]],
                [[100, 101], [102, 103]],
            ], dtype=np.uint8)
            tifffile.imwrite(path, arr, metadata={"axes": "IYX"})

            payload = render_raw_channel_bytes(path, 0, z_index=1).read()

            np.testing.assert_array_equal(np.frombuffer(payload, dtype=np.uint8).reshape(2, 2), arr[1])

    def test_raw_channel_bytes_preserve_selected_z_slice(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "zstack.tif"
            arr = np.array([
                [[1, 2], [3, 4]],
                [[100, 101], [102, 103]],
            ], dtype=np.uint8)
            tifffile.imwrite(path, arr, metadata={"axes": "ZYX"})

            payload = render_raw_channel_bytes(path, 0, z_index=1).read()

            np.testing.assert_array_equal(np.frombuffer(payload, dtype=np.uint8).reshape(2, 2), arr[1])

    def test_raw_channel_cache_decodes_all_channels_once_per_file_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "channels.tif"
            arr = np.array([
                [[1, 2], [3, 4]],
                [[100, 200], [300, 400]],
            ], dtype=np.uint16)
            tifffile.imwrite(path, arr, metadata={"axes": "CYX"})
            cache = RawChannelCache(max_bytes=1024 * 1024)
            original_tiff_file = tifffile.TiffFile
            calls = 0

            def counting_tiff_file(*args, **kwargs):
                nonlocal calls
                calls += 1
                return original_tiff_file(*args, **kwargs)

            tiff_service_module = __import__("agh_api.tiff_service", fromlist=["tifffile"])
            try:
                tiff_service_module.tifffile.TiffFile = counting_tiff_file
                first = cache.channel_bytes(path, 0).read()
                second = cache.channel_bytes(path, 1).read()
                repeat = cache.channel_bytes(path, 0).read()
            finally:
                tiff_service_module.tifffile.TiffFile = original_tiff_file

            self.assertEqual(calls, 1)
            np.testing.assert_array_equal(np.frombuffer(first, dtype="<u2").reshape(2, 2), arr[0])
            np.testing.assert_array_equal(np.frombuffer(second, dtype="<u2").reshape(2, 2), arr[1])
            self.assertEqual(first, repeat)

    def test_raw_channel_bytes_reject_invalid_channel(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "channels.tif"
            tifffile.imwrite(path, np.zeros((2, 3, 4), dtype=np.uint8), metadata={"axes": "CYX"})

            with self.assertRaises(BadRequest):
                render_raw_channel_bytes(path, 2)


if __name__ == "__main__":
    unittest.main()
