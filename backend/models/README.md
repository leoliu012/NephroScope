# MorphoGBM model asset

`morphogbm_v10_topology_robust_inference.pt` is the deployment checkpoint for
NephroScope. It was extracted from the supplied model archive; the larger
training/optimizer checkpoints and unrelated A-region ablations are not needed
at runtime.

- Model: MorphoGBM v10 topology/source-robust ConvNeXt-Pico residual U-Net
- Size: 46,009,907 bytes
- SHA-256: `a729ecc0036ddb6a52819dc92e93be43bd18d2ce8d472179a9fb92f0a76aec7f`
- Embedded manifest SHA-256: `101a22b90aea3a3acea67cc5fe9d86497c1e84d5c450f808ba117444876ddc30`
- Embedded input contract: uint8-scale input, raw/log1p/sqrt channels
- Embedded v10 calibration: D4 TTA, threshold 0.775, minimum component 64 px

The application deliberately uses the later v13 notebook's validated
whole-image teacher path around this v10 model: 32-pixel halo context,
overlapping 576-pixel cores, D4 averaging, Gaussian stitching, and the v13
selected hysteresis rule. The checkpoint remains immutable; preprocessing and
deployment inference metadata are recorded with every run.
