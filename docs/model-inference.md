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

What matters is the tilt **at this slice**. A loop that is vertical here and curves
away further up or down is a true cross-section here. So each short length of
centerline is followed into neighbouring slices, by finding the nearest centerline
there, and its sideways displacement along its own normal is recorded per plane.
The tilt is the slope of that displacement at this slice.

- **Signed.** A tilted sheet moves steadily one way, whereas mask jitter between
  slices averages out. Measuring magnitudes instead turns jitter into apparent tilt.
- **Local quadratic fit, centred here.** Curvature goes into the quadratic term, so
  the equator of a sphere reads as vertical. Fits are robust to occasional jumps.
- **Own Z window.** A piece is followed only until it has moved by its own thickness
  or is missing from two sampled slices in a row, up to the configured maximum
  (default ±30). The Z window setting only changes that maximum.
- **Uncertain means kept.** The fit reports a standard error, allowing for how the Z
  projection makes nearby slices repeat each other's noise. A piece counts as tilted
  only when the low end of that range is over the limit, or when the measured tilt
  is over it and the piece is also more than 20% wider than the best-oriented GBM,
  since a tilted sheet is wider.

Everything is stored in pixels per plane, so a new pixel size or Z step needs no
recomputation (`tan θ = stored × pixel / dz`).

### Deciding

Decisions are made on *pieces*: lengths of centerline about two thicknesses long,
starting at endpoints and junctions. A wall that turns oblique part-way along is
excluded only where it does, and pieces are what a person clicks. Tilt is smoothed
over neighbouring pieces. A piece is excluded as:

| Reason | Meaning |
|---|---|
| Oblique | Tilted beyond the limit (see above) |
| En-face | Tilted beyond both the limit and 60° |
| Wide patch | Over 2.5 times the width of the best-oriented GBM, with nothing showing it is vertical |
| Brief in Z | Neither its medial point nor its followed centerline lasts longer than the projection plus 2 planes, and it is not cut off by the stack's ends. Not judged when slices are sampled too sparsely to tell |
| Speck | Its 3D component has less area than about 4 thickness², and it does not persist through Z |
| Compact | Its component is shorter than 1.5 times its width, and it does not persist through Z |
| Skeleton artifact | Mostly taper, spur or junction samples (these samples are also dropped from kept pieces) |
| Below minimum / Above maximum | Thickness limits, per sample |
| Removed by you | A correction |

The automatic tilt limit is the largest tilt at which apparent thickening stays
within 35%, given the Z step and the reference thickness of the best-oriented
pieces, and held between 20° and 40°. A coarser Z step therefore earns a stricter
limit.

### When the file records no Z step

The Z step comes from the file (ND2, OME, ImageJ) or from what someone enters for
that image. It is **never estimated**: an estimate from the expected distribution of
orientations was off by up to five times on test stacks, which would exclude good
GBM. Without a Z step the angle is unknown, but what tilt does to the measurement
is not: the projection smears a sheet sideways by `(planes − 1) × drift` pixels,
whatever the Z step is. GBM is excluded when that smear exceeds 35% of the reference
thickness (en-face above 100%). On the test stacks this behaved like the known-Z
result, except at a fine Z step of 0.2 µm, where it excluded almost nothing.

### Corrections

Corrections live in the `prediction_edits` table, keyed by image, channel and source
version; saved masks are never touched, so removing them restores the prediction.

A **brush stroke** is exact: the centerline samples owning painted mask pixels become
their own pieces, kept or removed (later corrections win), and nothing nearby changes.
Where a keeping stroke crosses background, what it adds is cut from the smoothed
probability map at half height between the signal under the brush and the local
background, so thickness comes from the image and not the brush. A **click** also
changes thresholds around it:

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
with boundary noise and dropouts), with non-GBM specks and fibres added. "Kept" columns
are shares of centerline with that true tilt.

| Stack | Mean, unfiltered → kept (µm) | Median kept | Kept, tilt < 10° | Kept, 30–45° |
|---|---|---|---|---|
| dz 0.4 µm, 60 planes | 3.74 → 2.72 | 2.58 | 93% | 15% |
| dz 0.2 µm | 2.79 → 2.71 | 2.60 | 92% | 35% |
| dz 0.8 µm, 30 planes | 4.46 → 2.89 | 2.58 | 90% | 19% |
| Every 4th slice segmented | 3.86 → 2.86 | 2.60 | 92% | 30% |
| 15 planes only | 2.76 → 2.71 | 2.71 | 88% | 41% |
| Noisy masks (±5 px jitter, dropouts) | 2.27 → 2.07 | 2.18 | 63% | 28% |

Compared with the first version of this filter, which used unsigned drift and axial
chords, near-vertical GBM kept rose from 86% to 93% on the first stack and from 23% to
63% on noisy masks. In exchange more oblique GBM stays (kept GBM truly under 30° fell
from 99% to 89%), and the mean rose from 2.67 to 2.72 µm. On noisy masks most of what
is still lost is skeleton artifacts rather than tilt.

**It has not been validated on real images.** Real masks may behave differently from
these, so the defaults should be checked against expert review before results are
relied on. To do that, compare a few images with the filter on and off, looking at
what the coloured overlays exclude.

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
