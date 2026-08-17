import unittest
from pathlib import Path
import hashlib
from unittest import mock

import numpy as np

from agh_api import morphogbm_v10 as morphogbm


class MorphoGBMPreprocessingTests(unittest.TestCase):
    def test_contrast_enhancement_matches_supplied_percentile_formula(self):
        raw = np.arange(100, dtype=np.uint16).reshape(10, 10) * 17
        source = raw.astype(np.float32)
        low = np.percentile(source, 1)
        high = np.percentile(source, 99.7)
        contrast = 255.0 / (high - low)
        brightness = -low * contrast
        expected = np.clip(source * contrast + brightness, 0, 255).astype(np.uint8)

        actual = morphogbm.apply_contrast_enhancement(raw)

        self.assertEqual(actual.dtype, np.uint8)
        np.testing.assert_array_equal(actual, expected)

    def test_contrast_enhancement_constant_guard_returns_zero_uint8(self):
        actual = morphogbm.apply_contrast_enhancement(
            np.full((5, 7), 1234, dtype=np.uint16)
        )

        self.assertEqual(actual.dtype, np.uint8)
        np.testing.assert_array_equal(actual, np.zeros((5, 7), dtype=np.uint8))

    def test_contrast_enhancement_rejects_non_plane(self):
        with self.assertRaisesRegex(ValueError, "one 2-D plane"):
            morphogbm.apply_contrast_enhancement(np.zeros((2, 3, 4)))

    def test_v10_channels_match_raw_log_and_sqrt_standardization(self):
        raw = np.array([[0.0, 0.25], [0.5, 1.0]], dtype=np.float32)
        actual = morphogbm.make_inference_channels(
            raw,
            channel_mean=np.zeros(3, dtype=np.float32),
            channel_std=np.ones(3, dtype=np.float32),
        )
        expected = np.stack(
            [raw, np.log1p(9.0 * raw) / np.log(10.0), np.sqrt(raw)], axis=-1
        ).astype(np.float32)

        np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-7)


class MorphoGBMTilingTests(unittest.TestCase):
    def test_tile_positions_end_at_last_valid_core(self):
        self.assertEqual(morphogbm.tile_positions(576), [0])
        self.assertEqual(morphogbm.tile_positions(1000), [0, 288, 424])

    def test_gaussian_window_is_symmetric_normalized_and_floored(self):
        window = morphogbm.gaussian_blend_window(12, sigma_fraction=0.25, floor=0.05)

        self.assertEqual(window.shape, (12, 12))
        self.assertEqual(window.dtype, np.float32)
        self.assertAlmostEqual(float(window.max()), 1.0, places=7)
        self.assertGreaterEqual(float(window.min()), 0.05 - 1e-7)
        np.testing.assert_allclose(window, np.flipud(window), rtol=0, atol=1e-7)
        np.testing.assert_allclose(window, np.fliplr(window), rtol=0, atol=1e-7)

    def test_halo_uses_observed_neighbors_and_reflects_missing_border(self):
        raw = np.arange(36, dtype=np.float32).reshape(6, 6)
        coverage = np.ones((6, 6), dtype=np.uint8)

        interior = morphogbm.teacher_halo_window(
            raw, coverage, 1, 1, core=4, halo=1
        )
        edge = morphogbm.teacher_halo_window(raw, coverage, 0, 0, core=4, halo=1)

        np.testing.assert_array_equal(interior, raw[:6, :6])
        np.testing.assert_array_equal(edge[1:5, 1:5], raw[:4, :4])
        # No observed source exists above/left, so those values come from
        # reflecting the 4x4 core exactly as the v13 teacher reader does.
        self.assertEqual(edge[0, 1], raw[1, 0])
        self.assertEqual(edge[1, 0], raw[0, 1])
        # Real neighboring source pixels replace reflection at bottom/right.
        self.assertEqual(edge[5, 3], raw[4, 2])
        self.assertEqual(edge[3, 5], raw[2, 4])


class MorphoGBMHysteresisTests(unittest.TestCase):
    def test_hysteresis_keeps_only_low_component_with_high_seed(self):
        probability = np.zeros((7, 9), dtype=np.float32)
        probability[1:4, 1:4] = 0.60
        probability[2, 2] = 0.80
        probability[1:4, 6:8] = 0.60

        mask = morphogbm.hysteresis_components(probability)

        self.assertEqual(int(mask[:, :5].sum()), 9)
        self.assertEqual(int(mask[:, 5:].sum()), 0)

    def test_hysteresis_uses_eight_connectivity(self):
        probability = np.zeros((5, 5), dtype=np.float32)
        probability[1, 1] = 0.80
        probability[2, 2] = 0.60
        probability[3, 3] = 0.60

        mask = morphogbm.hysteresis_components(probability)

        self.assertEqual(int(mask.sum()), 3)


class MorphoGBMCheckpointContractTests(unittest.TestCase):
    @staticmethod
    def payload():
        config = dict(morphogbm.EXPECTED_CONFIG)
        config["decoder_channels"] = list(config["decoder_channels"])
        return {
            "format_version": 1,
            "model_state": {},
            "config": config,
            "channel_mean": morphogbm.EXPECTED_CHANNEL_MEAN.tolist(),
            "channel_std": morphogbm.EXPECTED_CHANNEL_STD.tolist(),
            "manifest_sha256": morphogbm.EXPECTED_MANIFEST_SHA256,
            "calibration": {
                "threshold": 0.775,
                "minimum_component_size": 64,
                "tta_transforms": [
                    {
                        "rotation_k": rotation,
                        "horizontal_flip_after_rotation": flip,
                    }
                    for rotation, flip in morphogbm.D4_TRANSFORMS
                ],
            },
        }

    def test_selected_payload_contract_is_accepted_without_loading_torch(self):
        validated = morphogbm._validate_checkpoint_payload(self.payload())

        self.assertEqual(validated["config"]["image_size"], 576)
        self.assertEqual(validated["calibration"]["threshold"], 0.775)

    def test_manifest_mismatch_is_rejected_before_model_construction(self):
        payload = self.payload()
        payload["manifest_sha256"] = "0" * 64

        with self.assertRaisesRegex(ValueError, "manifest"):
            morphogbm._validate_checkpoint_payload(payload)

    def test_bundled_checkpoint_has_expected_size_and_sha256(self):
        checkpoint = (
            Path(__file__).resolve().parents[1]
            / "models"
            / "morphogbm_v10_topology_robust_inference.pt"
        )
        self.assertEqual(checkpoint.stat().st_size, 46_009_907)
        digest = hashlib.sha256()
        with checkpoint.open("rb") as handle:
            for chunk in iter(lambda: handle.read(2**20), b""):
                digest.update(chunk)
        self.assertEqual(digest.hexdigest(), morphogbm.EXPECTED_CHECKPOINT_SHA256)

    def test_checkpoint_loader_requests_restricted_weights_only_mode(self):
        fake_torch = mock.Mock()
        fake_torch.load.return_value = {"model_state": {}}

        with mock.patch.object(morphogbm, "torch", fake_torch):
            actual = morphogbm._torch_load(Path("model.pt"))

        self.assertEqual(actual, {"model_state": {}})
        fake_torch.load.assert_called_once_with(
            Path("model.pt"), map_location="cpu", weights_only=True
        )


@unittest.skipUnless(
    morphogbm.model_runtime_available(),
    "real checkpoint smoke requires torch and timm",
)
class MorphoGBMCheckpointSmokeTests(unittest.TestCase):
    def test_supplied_checkpoint_strictly_reconstructs(self):
        checkpoint = (
            Path(__file__).resolve().parents[1]
            / "models"
            / "morphogbm_v10_topology_robust_inference.pt"
        )
        bundle = morphogbm.load_inference_bundle(checkpoint, device="cpu")

        self.assertEqual(bundle.checkpoint_sha256, morphogbm.EXPECTED_CHECKPOINT_SHA256)
        self.assertEqual(bundle.manifest_sha256, morphogbm.EXPECTED_MANIFEST_SHA256)
        self.assertEqual(bundle.format_version, 1)
        self.assertEqual(bundle.calibration["threshold"], 0.775)
        self.assertEqual(bundle.calibration["minimum_component_size"], 64)


if __name__ == "__main__":
    unittest.main()
