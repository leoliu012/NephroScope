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

### Whole-field movement between slices

The whole field can move between slices for reasons that have nothing to do with the
GBM, and that movement would read as tilt:

- **The stage or sample slides** during acquisition. On real stacks this reached about
  2.7 px per plane, which at 0.107 µm pixels and a 0.3 µm Z step is about 44°.
- **Focusing changes the magnification**, so everything moves radially from the middle of
  the field. The three April 2026 AGH7 stacks measured here change by 0.13–0.22% per
  plane, up to about 3.5 px per plane at the image corners, while the other stacks
  measured stay at or below 0.03%.

So the stack analysis measures this first, from raw single planes of the same channel, two
planes apart. Single planes are used because neighbouring Z projections share planes,
which pulls registration towards no movement. The field is cut into 4 × 4 tiles, each is
registered by phase correlation, and a translation, scale and rotation are fitted across
tiles, with tiles that disagree losing their weight. A freer fit is not used, since it would
start to absorb real tissue geometry. Steps where tiles do not agree, as where the tissue
ends, carry on from the steps around them. Movement below 0.1 px per plane everywhere in
the field is treated as none. Slices are then compared in register, and corrections made
on one slice reach the same place in the sample on the others.

If the raw planes cannot be read, the analysis still finishes without this step, and the
filter panel warns that tilt may read too high. The panel also says when movement was
removed and how large it was.

The 5-plane projection that each mask is predicted from is **not** corrected. On a moving
stack it is smeared by about `4 × movement` pixels, so masks there are predicted on a
blurred image and can look wider along the direction of movement. Fixing that means
registering planes before projecting and predicting again, which has not been tested.
Tilt is corrected, thickness is not. Magnification change also means a pixel is not quite
the same size through a stack; that is not corrected either.

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
- **Uncertainty is weighed.** The fit reports a standard error, allowing for how the Z
  projection makes nearby slices repeat each other's noise. An uncertain slope counts
  for less in the decision below.

Everything is stored in pixels per plane, so a new pixel size or Z step needs no
recomputation (`tan θ = stored × pixel / dz`).

### Deciding

GBM is continuous along its centerline and through Z, so decisions are made for the whole
stack at once and not piece by piece. Pieces are lengths of centerline about two thicknesses
long, starting at endpoints and junctions.

Each piece first gets a score, positive when its own evidence says to exclude it:

- **Tilt**: degrees past the limit, over 8° plus half the uncertainty of its slope. The
  slope is used as measured. Earlier it was first evened out over neighbouring pieces, and
  its uncertainty counted in full; on real masks both let clearly tilted pieces be overruled.
- **Width**, only where tilt is near or past the limit: more than 20% wider than the
  best-oriented GBM counts towards tilt, since a tilted sheet is wider. This weight falls to
  nothing 8° of tilt score below the limit. A sheet measured well short of the limit is wide
  because it is thick, and thickness is what is being measured: before this, GBM at 12–22°
  that was 1.6–2.2 times the reference width was kept 74% of the time against 99% for
  narrow GBM at the same tilt. Clearly uniform narrow GBM still counts against tilt.
- **Line-likeness**: a long connected line counts slightly against tilt, and a short
  fragment slightly for it, since true cross-sections trace long continuous curves.

Then the decisions chosen are the ones that go against the least evidence (each piece's
length in thicknesses times its score), counting a cost of 1.75 wherever the decision changes
between two pieces that join along a centerline, and 0.6 wherever a piece differs from the
same stretch of sheet in a nearby plane. This is solved exactly, as a minimum cut. So a short
noisy stretch stays with the wall around it, a stretch that is clearly tilted is excluded as a
whole, a single piece that is clearly tilted holds on its own, and a reading that shows in one
plane only does not flicker in and out while moving through Z. A sheet that really turns away
through Z still changes where it does, because clear evidence outweighs the cost. Tapers,
spurs and junctions have no opinion and take after what they join; their samples are not
measured, but they do not break the GBM.

**The same stretch in nearby planes** is found when the stack is analysed: each piece is
looked for where its own drift puts it in the analysed planes within three planes, or within
1.5 times the spacing of analysed planes if that is further, in the stack's shared frame, with
a gate tighter across the sheet (0.6 thicknesses) than along it (1.2). Planes analysed more
than six planes apart are not linked, since they show different parts of a curving sheet, and
each is then decided on its own.

Without SciPy on the API server each plane is decided on its own by the earlier rule
(flipping runs of pieces whose evidence does not outweigh the breaks they make).

Excluded GBM is labelled as:

| Reason | Meaning |
|---|---|
| Oblique | The evidence above, or part of a stretch that is |
| En-face | Tilted beyond both the limit and 60° |
| Wide patch | Over 2.5 times the width of the best-oriented GBM, and its slope could not be measured |
| Brief in Z | Neither its medial point nor its followed centerline lasts longer than the projection plus 2 planes, and it is not cut off by the stack's ends. Not judged when slices are sampled too sparsely to tell |
| Speck | Its 3D component has less area than about 4 thickness², and it does not persist through Z |
| Compact | Its component is shorter than 1.5 times its width, and it does not persist through Z |
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

Corrections are applied after continuity, so they always win. A **brush stroke** is
exact: the centerline samples owning painted mask pixels become
their own pieces, kept or removed (later corrections win), and nothing nearby changes: every
other piece of that plane keeps the decision the stack gave the piece it came from.
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

Decisions are not stored. A request for any slice decides the whole stack from the saved
analysis, the current calibration and tilt limit, and the clicks that change limits, which
takes about 30–120 ms for 20–45 slices of 2304 × 2304, and the last 16 stacks decided are
kept in memory. An analysis from before links through Z were saved (`gbm-cross-section-v3`) is not
used; opening the image queues a new one.

A worker reports every 30 seconds. When it restarts, it queues again whatever a
worker that no longer exists left running, instead of waiting for that run's lease
to expire. Until then, the viewer says the worker has stopped rather than showing
the last progress.

Measurements requested before an analysis is ready return with thickness limits
applied and `filter.pending = true`, and the UI says so rather than presenting them
as filtered. A failed analysis is not retried automatically. Browsers cache filtered
distributions under a token of analysis run and corrections.

### Validation

There is still no expert ground truth for tilt on real images. What follows tests the method
against truth that can be constructed: a known tilt added to real stacks, and synthetic stacks.
"Before" is the previous rule (`gbm-cross-section-v3`: each plane decided on its own, slopes
evened out over neighbouring pieces, width counted at any tilt).

**Real masks with a known tilt added.** Sliding every plane of a stack sideways by `s` pixels
per plane tilts every sheet in it by a known amount: a piece whose slope along its normal `n`
was `a` now has slope `a + s (e · n)`, with `e` the direction of the slide. Done through each
plane's registration, the masks and pieces stay exactly as predicted, so the jitter is the real
model's. Five stacks (AGH1, AGH7, AGH9 ×2, AGH10; v10 masks on every second slice, 0.3 µm Z
step), slid by 30°, 45° and 60° along x and along y. Scored on pieces whose slope before the
slide was certain enough for the tilt after it to be known within 5°.

The tracker reads these tilts as they are: GBM whose true tilt is 0–10°, 10–20°, 20–30°,
30–45°, 45–60° and 60–75° reads 5°, 14°, 24°, 37°, 51° and 65° (medians). So wrong decisions
come from the deciding, not the measuring.

| | Kept, true tilt < 10° | 10–20° | 20–30° | 30–45° | 45–60° | > 60° | Breaks | Stacks as they are: kept | breaks | differ between neighbouring slices |
|---|---|---|---|---|---|---|---|---|---|---|
| Before | 92% | 90% | 79% | 51% | 15% | 6% | 3.8 | 77.6% | 3.0 | 7.9% |
| Now | 96% | 95% | 85% | 48% | 9% | 3% | 4.4 | 77.6% | 3.4 | 2.1% |

The limit is 27–31° on these stacks. Below 20°, wrongly excluded centerline fell from 9.3% to
4.2%; above 45°, wrongly kept from 12.1% to 7.2%. Breaks are changes of decision along the
centerline per 100 thicknesses. The last column is the share of centerline whose decision
differs from the same place in the next analysed slice, 0.6 µm away.

What this cannot show: the slide adds the same tilt through the whole stack, so it says
nothing about sheets whose tilt changes quickly through Z, and the masks do not widen as a
tilted sheet's would. The next two tests cover those.

**The same, with the model seeing the tilt.** For one stack (AGH9-2-2 ROI2) the raw planes were
slid by 30°, 45° and 60°, projected and predicted again with the deployed model. At the 45°
slide the model still draws 93% of GBM whose tilt became 45–60°, and 89% above 60°. On the new
masks the tracker reads true tilts of 0–10°, 10–20°, 20–30°, 30–45°, 45–60° and over 60° as 8°,
15°, 25°, 36°, 51° and 61°. Below 20°, wrongly excluded went from 9.4% to 7.1%; above 45°,
wrongly kept from 14.0% to 7.8%; breaks 4.7 and 5.2. The masks widen far less than the
projection's smear alone would make them: at the 45° slide by 7–10%, where the smear predicts
31%. So the model draws roughly the core of a smeared sheet, and the 35% apparent thickening
that the automatic tilt limit allows for overstates what reaches a measurement. On the stacks
as they are, width rises with measured tilt by a fifth to three quarters, depending on the
stack, of what `1 / cos θ` plus the full smear predicts.

**Synthetic stacks at the jitter of real masks.** Tube shells and spheres of every orientation,
true thickness 2.5 µm, imaged like the pipeline, with specks added. Their boundary noise is set
so that a centerline moves between analysed slices as it does on real v10 masks: by 4–5% of the
GBM's width (1.2–2.0 px), uncorrelated from slice to slice, measured on the five stacks above.
The noisy stacks this section used before were at about twice that, and the conclusion drawn
from them, that steep GBM is under-read, does not hold on real masks. These stacks curve
through Z, and their steep stretches are shorter than in tissue, which is hard on continuity.

| Stack (mean thickness unfiltered) | | Kept, true tilt < 10° | 20–30° | 30–45° | 45–60° | > 60° | Mean kept (µm) | Breaks | Differ between slices |
|---|---|---|---|---|---|---|---|---|---|
| Real jitter, every 2nd slice (3.31 µm) | Before | 99% | 88% | 61% | 57% | 42% | 3.07 | 6.3 | 11.1% |
| | Now | 99% | 87% | 49% | 41% | 18% | 3.01 | 7.2 | 4.6% |
| Real jitter, every slice (3.32 µm) | Before | 99% | 86% | 56% | 48% | 32% | 3.02 | 7.8 | 14.3% |
| | Now | 98% | 80% | 41% | 35% | 7% | 2.96 | 6.7 | 1.8% |
| Real jitter, every 4th slice (3.30 µm) | Before | 99% | 95% | 70% | 64% | 49% | 3.11 | 5.0 | 9.2% |
| | Now | 100% | 93% | 71% | 59% | 45% | 3.11 | 4.3 | 5.2% |
| Twice real jitter (3.03 µm) | Before | 98% | 90% | 75% | 76% | 63% | 2.90 | 4.2 | 14.6% |
| | Now | 99% | 88% | 71% | 58% | 22% | 2.86 | 3.3 | 1.7% |
| Clean masks (3.82 µm) | Before | 95% | 52% | 19% | 14% | 9% | 3.13 | 12.6 | 10.1% |
| | Now | 98% | 54% | 17% | 7% | 4% | 3.10 | 13.3 | 2.4% |

With real jitter a good part of the steep GBM is still kept on these stacks, before and now:
there the tracker's slope is less certain and the steep stretches are short. With slices four
planes apart there is little to gain from Z.

**Width and what is measured.** On the five stacks as they are, among pieces whose tilt is
well measured at 12–22°, the share kept by width over the reference width (< 1.1, 1.1–1.3,
1.3–1.6, 1.6–2.2, > 2.2) was 99%, 99%, 88%, 74%, 67% before and is 99%, 99%, 98%, 97%, 94% now.
Kept GBM in that band was 3.9% narrower than all of it and is now 0.5% narrower; the mean
width of all kept GBM rose by 1.5%. Thick GBM is no longer excluded for being thick.

**Costs.** The cost of a break along the centerline trades breaks for accuracy: at 2.0 instead
of 1.75, breaks on the real stacks fall to 2.7 (below the 3.0 before), wrong decisions rise
slightly (4.8% and 7.8%), and on the synthetic stacks more steep GBM is kept (51% at 45–60°).
Charging the cost through Z per piece instead of per thickness of centerline gave less flicker
on real masks (1.3%) but excluded nothing at all at twice the real jitter, where masks are cut
into many short pieces.

**Whole-field movement on real stacks.** Five real stacks, with v10 masks on every second
slice, before and after removing the movement. Movement is the largest anywhere in the field.
The shares kept and excluded are from the decision rule before this one.

| Stack | Movement, px per plane | Median tilt | Kept | Excluded as oblique |
|---|---|---|---|---|
| AGH9 60x_2 (stage slides) | 2.7 | 27° → 19° | 73% → 83% | 23% → 13% |
| AGH10 60x_2-2 (stage slides) | 1.4 | 23° → 18° | 70% → 79% | 23% → 15% |
| AGH7-1-1 60x-1 (magnification) | 4.1 | 20° → 7° | 83% → 98% | 15% → 1% |
| AGH1 botL (control) | 0.2 | 19° → 19° | 65% → 64% | 30% → 31% |
| AGH9-2-2 ROI2 (control) | 0.4 | 19° → 19° | 70% → 68% | 27% → 29% |

These masks used one view per tile for speed. With the deployed eight views, the AGH10 and
AGH9-2-2 stacks came out within 2 points of these. Independently of the raw images, the
movement implied by the GBM tracks alone falls after correction on AGH7 (scale +0.155% to
−0.021% per plane) and AGH10 (slide 0.94 to 0.28 px per plane). On AGH9 60x_2 it goes from
1.35 to 0.57 px per plane but changes sign, so that stack may be slightly overcorrected.

**Why tilt still comes from tracked centerlines.** An image-based normal-flow estimate was
compared with the tracked tilt on 1,322 pieces of the four stacks without magnification
change. Both repeat about equally from independent neighbouring slices (rank correlation
0.79 tracked, 0.82 image-based). The image-based estimate agrees better with a tilt measured
from the same images (0.59 against 0.30), but that shares its input. Width, which geometry
says should rise with tilt, relates more to tracked tilt (0.27 against 0.16). So neither is
shown to be better, and there is no ground truth here.

**What is still not validated.** Decisions have not been checked against expert review. Tracked
tilt has a median near 18° on real stacks that barely move, and the filter excludes a fifth to a
third of GBM on four of the five stacks above. That is the size to expect: if a sheet's orientation were equally likely in every
direction, its trace in a section would have a median tilt of 24° and 39% of it would be tilted
past 30°, and steep GBM is fainter and less often predicted. This is an argument from geometry,
not a measurement, so the defaults should still be compared with what an expert would keep.
To do that, compare a few images with the filter on and off, looking at what the coloured
overlays exclude; corrections made in the viewer are the labels such a comparison needs.

### Drawing predictions

Moving through Z has to stay smooth with predictions showing, so nothing about a slice is
computed per pixel on the main thread:

- The slider draws directly, without a React update, and every slice passed is shown:
  anything loaded on the way to where the slider is now gets drawn, and at most two slices
  are requested at once, so the newest never waits behind old requests. The rest of the
  viewer updates when the slider settles.
- A worker turns each prediction image into lists of runs and centerline points. GBM covers
  a few percent of an image, so these are about thirty times smaller than a decoded image,
  a whole stack fits on the GPU, and showing a slice is one draw call.
- `/analysis-runs/refinement-frames` returns the decisions for every slice in one request.
  A small table maps each piece to how it is shown, so changing decisions or colours needs
  no new data.
- The brush moves a small element by transform and grows its stroke on a small canvas, so a
  move costs the same however long the stroke is. Panning and zooming write the transform
  directly, and React state catches up when the gesture ends.
- Measuring every slice for the Thickness tab only happens while the tab or the export panel
  is open.

On a 2048 × 2048, 44-slice, 2-channel stack with the CPU slowed 6 times, a 2-second drag went
from 4–11 images and no predictions shown, at 18–48 frames per second with stalls of about
100 ms, to all 44 of each at 58–60 frames per second with no stalls, once the slices are loaded.
The first pass over slices not yet loaded shows about 30 of the 44.

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
