# MorphoGBM v10 inference contract

This implementation was derived from the supplied resources rather than from
the removed legacy analysis stack.

## Runtime asset

The only deployed weight file is
`backend/models/morphogbm_v10_topology_robust_inference.pt` (SHA-256
`a729ecc0036ddb6a52819dc92e93be43bd18d2ce8d472179a9fb92f0a76aec7f`).
It embeds the exact ConvNeXt-Pico residual U-Net state, three-channel
normalization, and v10 calibration. The optimizer-bearing `*_last.pt`, the
A-region ablations, and the outer 680 MB archive are not runtime assets.

The v13 notebook's selected ensemble weight is `alpha = 0`, so its promoted
large-image result is the v10 teacher alone. No v13 student checkpoint is
required.

## Plane selection and MIP

- The request records an explicit zero-based model channel and current Z.
- A two-dimensional image uses that plane directly.
- A stack uses the supplied `nd2_mip_5z.py` shifted-window behavior: prefer two
  planes on either side, then shift inward at the first/last Z so a five-plane
  window is retained.
- A stack with fewer than five planes projects every available plane rather
  than failing. The actual inclusive/exclusive Z bounds and plane count are
  recorded as the exact Z-index list in the result.
- The same rule is used for TIFF and ND2. Other axes use the viewer's existing
  deterministic first-position/first-time policy.

## Contrast enhancement

The in-memory transform matches `image_enhance.py` as invoked by `apply_CE.py`:

1. cast the selected plane/MIP to `float32`;
2. compute its 1st and 99.7th percentiles;
3. linearly map those values to 0 and 255;
4. clip and cast to `uint8` using NumPy truncation.

The app adds one safety rule absent from the batch helper: a constant or invalid
percentile range returns an all-zero uint8 plane instead of dividing by zero.
The source array is never modified or saved over the original file.

## Model channels

The checkpoint divides the enhanced uint8 plane by 255, then forms:

```text
raw
log1p(9 * raw) / log(10)
sqrt(raw)
```

Those channels are standardized with the checkpoint's embedded mean and
standard deviation.

## Whole-image inference

The implementation follows the v13 notebook's final teacher path:

- 576 x 576 output cores;
- 32 pixels of observed/reflective halo on every side (640 x 640 model input);
- stride 288;
- eight D4 views (four rotations, with and without horizontal flip);
- sigmoid probabilities inverse-transformed and averaged;
- Gaussian overlap weights with sigma `0.25 * 576` and floor `0.05`;
- first/second-moment stitching for a disagreement summary;
- crop back to the exact source-plane dimensions.

Because halo inference changes the probability operating point, the final mask
uses the v13-selected eight-connected hysteresis rule, not the older patch-only
v10 threshold/component pair: low support `p >= 0.55`, high seeds `p >= 0.70`,
keep each low component containing at least one high seed.

## ROI thickness

Thickness mirrors
`interactive_qupath_gbm_mask_roi_thickness_colab.ipynb`:

1. skeletonize the complete predicted mask;
2. compute local diameter as twice the full-mask Euclidean distance-transform
   radius at each skeleton pixel;
3. select only skeleton samples inside the completed polygon ROI;
4. average those local diameters;
5. apply physical X/Y pixel calibration and divide by the linear expansion
   factor when expansion correction is enabled.

Endpoint, junction, border-component, sample-count, median, standard deviation,
and 5th/95th-percentile values are returned for quality control. The ROI is
transient viewer state and is not written into the user's annotations.

The full saved centerline is available as a separate viewer overlay. It is the
same `skeleton_y`/`skeleton_x` geometry from which ROI samples are selected,
not a separately recomputed display approximation. Users can hide it or change
its color and rendered thickness; those controls never alter measurement data.
New jobs publish a one-pixel binary `skeleton.png` with the other immutable
artifacts. For an older saved job, the API creates that PNG on first request
from its existing schema-v1 thickness geometry.

The viewer presents the observed (before-EF) average and the EF-adjusted
average together. The adjusted value is the primary result. Because the saved
measurement includes its pixel-domain mean diameter, both displayed values
respond immediately to the current image pixel-size and expansion-factor
settings without rerunning inference.

## Cross-section filter

Implemented in `backend/agh_api/gbm_cross_section.py` (measurement and decisions)
and `gbm_refinement.py` (jobs, corrections, filtered measurements).

### Why

A sheet of thickness `t` tilted by `θ` from vertical looks wider in one plane
(`t / cos θ`), and the 5-plane Z projection used for inference widens it again by
how far it drifts across the projection (`4 dz tan θ`). Lying flat, it becomes a
wide en-face patch. All of that biases thickness upwards.

### Measuring tilt

Every centerline sample of every segmented slice gets two independent measurements
from the masks of neighbouring slices. Both are stored in pixels per plane, so a
new pixel size or Z step needs no recomputation (`tan θ = stored × pixel / dz`).

- **Axial chord.** Follow the medial point through Z until it leaves the mask. A
  slab with lateral chord `w` and axial chord `a` has `tan θ = w / a`, and because
  this is a ratio, Z projection and axial blur cancel out.
- **Level-set drift.** With a signed distance function `φ` of each mask, the tilt of
  a boundary from vertical is `atan |∂φ/∂z|`. Each boundary face is followed
  outwards only until it has moved 0.4 of the local thickness, because beyond that
  `φ` no longer reports the same surface.

That second rule is also how the Z window is chosen on the fly: steep surfaces use
nearby planes and near-vertical ones use a long lever arm, up to the configured
maximum (default ±30). The Z window setting only changes that maximum.

### Deciding

Decisions are made on *pieces*: lengths of centerline about two thicknesses long,
starting at endpoints and junctions. A wall that turns oblique part-way along is
excluded only where it does, and pieces are what a person clicks. Tilt is smoothed
over neighbouring pieces. A piece is excluded as:

| Reason | Meaning |
|---|---|
| Oblique | Tilt above the limit |
| En-face | Tilt above both the limit and 60° |
| Brief in Z | Chord no longer than the projection itself, and not cut off by the stack's ends |
| Speck | Its 3D component has less area than about 6 thickness² |
| Compact | Its component is shorter than twice its width |
| Skeleton artifact | Mostly taper, spur or junction samples (these samples are also dropped from kept pieces) |
| Wide patch | One plane only: over twice the typical width |
| Below minimum / Above maximum | Thickness limits, per sample |
| Removed by you | A correction |

The automatic tilt limit is the largest tilt at which apparent thickening stays
within 25%, given the Z step and the reference thickness of the best-oriented
pieces, and held between 15° and 35°. A coarser Z step therefore earns a stricter
limit.

### When the file records no Z step

The Z step comes from the file (ND2, OME, ImageJ) or from what someone enters for
that image. It is **never estimated**: an estimate from the expected distribution of
orientations was off by up to five times on test stacks, which would exclude good
GBM. Without a Z step the angle is unknown, but what tilt does to the measurement
is not: the projection smears a sheet sideways by `(planes − 1) × drift` pixels,
whatever the Z step is. GBM is excluded when that smear exceeds 25% of the reference
thickness (en-face above 100%). On the test stacks this matched the known-Z result
closely, except at a fine Z step of 0.2 µm, where it kept more oblique GBM.

### Corrections

Corrections live in the `prediction_edits` table, keyed by image, channel and source
version; saved masks are never touched, so removing them restores the prediction.

| Click | Effect |
|---|---|
| Add GBM on excluded GBM | Keeps that piece (including past thickness limits). Raises the local tilt limit to the clicked tilt + 3° through a 3D Gaussian (sigma 4 thicknesses, combining lateral and axial distance, ignored below weight 0.25), and vouches for the same exclusion reason nearby |
| Remove GBM on kept GBM | Excludes that piece. Only if its tilt was at least 60% of the limit does the limit tighten nearby, since a wrong piece that is nearly vertical says nothing about tilt |
| Add GBM where nothing was predicted | Thresholds the smoothed probability map at half height between the local peak and background, returning to the model's threshold (0.55) with distance. Fainter evidence therefore reaches less far. If the region is wider than 2.5 typical thicknesses, the level is raised until it is not. The region joins the mask for this slice only, and the slice is re-skeletonized in the API |

Runs from before probability maps were saved use image contrast instead, as noted
on the correction (`probabilitySource`).

### Jobs and caching

The analysis is a `gbm-stack-analysis` job with `zIndex = -1`, run by the same worker
and ahead of queued inference, since someone is usually waiting on it. It starts when
no segmentation of that image is running, and the previous analysis stays in use
meanwhile (reported as stale). Its cache key covers the member runs, so any change
to the segmented slices makes a new one, and the older one is then deleted.

Measurements requested before an analysis is ready return with thickness limits
applied and `filter.pending = true`, and the UI says so rather than presenting them
as filtered. A failed analysis is not retried automatically. Browsers cache filtered
distributions under a token of analysis run and corrections.

### Validation

Tested only on synthetic stacks: tube shells and spheres of known orientation and
true thickness 2.5 µm, imaged like the pipeline (blur, 5-plane projection, thresholding
with boundary noise and dropouts), with non-GBM specks and fibres added.

| Stack | Mean, unfiltered → kept (µm) | Kept GBM truly ≤ 30° | Near-vertical GBM kept |
|---|---|---|---|
| dz 0.4 µm, 60 planes | 3.74 → 2.67 | 99% | 86% |
| dz 0.2 µm | 2.79 → 2.63 | 98% | 87% |
| dz 0.8 µm, 30 planes | 4.46 → 2.76 | 97% | 81% |
| Every 4th slice segmented | 3.86 → 2.66 | 99% | 83% |
| 15 planes only | 2.76 → 2.78 | 97% | 75% |
| One plane (shape rules only) | 3.74 → 3.13 | — | 93% |

Non-GBM distractors fell from 3338 to 272 samples on the first stack. With very
noisy masks (±5 px boundary jitter) it stays precise but conservative, keeping about
23% of near-vertical GBM.

**It has not been validated on real images.** Real masks may behave differently from
these, so the defaults should be checked against expert review before results are
relied on. To do that, compare a few images with the filter on and off, looking at
what the red outlines exclude.

## Persistence and Z status

Queued, running, failed, and successful runs are stored in the analysis SQLite
database; masks and thickness geometry are stored under the configured
analysis state directory. Reopening an image or starting a new login restores
the latest valid prediction for every Z slice and resumes polling active runs.
The Z slider labels active slices as `Running` and completed slices as
`Segmented`. Restored masks are accepted only when the source file size and
nanosecond modification time still match the version used for inference.

Deleting a prediction for a Z slice removes all terminal run records and
artifacts for that slice so an older hidden mask cannot reappear, along with
corrections made on that slice. A queued or running prediction cannot be deleted
until it reaches a terminal state.

All model outputs and measurements are for research use only.
