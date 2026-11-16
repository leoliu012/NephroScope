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

With the cross-section filter and its tilt correction on, each sample's diameter is first
multiplied by the cosine of its sheet's tilt (see *Thickness corrected for tilt*).

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

### Small holes

Implemented in `backend/agh_api/gbm_holes.py`, as the first step of the Z analysis.

The model leaves small holes in the middle of a membrane where its probability dips just
under the threshold: inside small holes on two real stacks it was 0.44–0.55 (10th to 90th
percentile), against 0.55 to enter the mask and about 0.03 in background. The centerline
then runs around the hole as two branches, each reading half the membrane's thickness,
with a junction at either end.

A hole is closed when all of this holds:

- it is background enclosed by the GBM of one slice, joined to nothing outside it along a
  pixel edge;
- it is small: no more than one thickness² in area and 0.7 of the thickness at its widest,
  against the typical thickness of that slice. Larger enclosed background is a lumen or a
  space between membranes;
- GBM covers at least 90% of it in a slice below and in a slice above, at the same place in
  the sample (so after the field's movement is removed), with **at most three planes
  uncovered** between those two slices.

The last is the evidence. Every slice is a projection of five planes that overlaps its
neighbours', and a leaning sheet moves steadily across them, so GBM at one place both
below and above is GBM in between. The limit of three planes is where real stacks divide:
small holes that were covered on both sides lasted 1, 2 or 3 planes (6, 4 and 1 of them on
AGH1 botL; 3, 1 and 0 on AGH9-2-2 ROI2) or 5 and more (7 and 4), and none lasted 4. A
projection shows a hole only where all five of its planes lack GBM, so a real opening is
several planes deep and shows in several slices; a dip of the probability comes and goes.
Every slice of one hole gets the same answer, because each is judged by how long the hole
lasts. A stack's first and last slices repeat a neighbour's projection, and the same
prediction twice does not count as a second slice. Analysed more than two planes apart,
slices cannot close each other's holes.

The saved prediction is not changed. The fill and the plane's centerline with the hole
closed are kept with the Z analysis, and everything that uses the filter (overlays, the
3D model, measurements, corrections) sees the plane with the hole closed. With the filter
off, the viewer shows the prediction as the model made it, hole included. The filter panel
says how many holes were closed on the slice and in the image.

Not closed: holes covered on one side only (a space where two membranes meet closes in one
direction), and breaks that cut a membrane through. Short-lived breaks do exist with the
same kind of evidence (about 2 per slice on AGH1 botL and 0.3 on AGH9-2-2 ROI2, probability
inside 0.38–0.52), but of the seven that fell on annotated planes the share annotated as
GBM ran from 0.10 to 1.00, which is not enough to add GBM on.

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
| En-face | Tilted beyond both the limit and 60°, over most of the excluded stretch |
| Wide patch | Over 2.5 times the width of the best-oriented GBM, and its slope could not be measured |
| Brief in Z | Neither its medial point nor its followed centerline lasts longer than the projection plus 2 planes, and it is not cut off by the stack's ends. Not judged when slices are sampled too sparsely to tell |
| Speck | Its 3D component has less area than about 4 thickness², and it does not persist through Z |
| Compact | Its component is shorter than 1.5 times its width, and it does not persist through Z |
| Below minimum / Above maximum | Thickness limits, per sample |
| Removed by you | A correction |

Oblique and en-face are given to an excluded stretch as a whole: whichever covers more of its
length, oblique on a tie. Judged piece by piece, a stretch near 60° alternated between the two
with the noise in each slope, which looked like the decision changing when it was not. On four
real stacks this removed 26–41% of the changes of colour along the centerline, and what is kept
or excluded was identical in every slice.

The automatic tilt limit depends on whether thickness is corrected for tilt (next section).
Corrected, it is 40°. Uncorrected, it is the largest tilt at which apparent thickening stays
within 35%, given the Z step and the reference thickness of the best-oriented pieces, and
held between 20° and 40°; a coarser Z step therefore earns a stricter limit. A limit someone
sets replaces either.

### Thickness corrected for tilt

A slice cuts a sheet that leans by `θ` from vertical obliquely, so what the slice shows is
`1 / cos θ` wider than the sheet. The stack says what `θ` is for every piece: it is the tilt
measured above, from how the same stretch of centerline moves through the neighbouring
slices. With **Correct thickness for tilt** on (the viewer's default; `filter.tiltCorrection`
in the API, off unless sent), every kept sample's diameter is multiplied by the cosine of its
piece's tilt before it is reported, in ROI measurements, distributions and exports alike.
Thickness limits apply to the corrected value. A piece whose tilt could not be measured is
not corrected.

GBM that leans moderately then does not have to be left out, which is what the automatic
limit of 40° reflects. Between about 27° and 40°, GBM that used to be excluded is measured.

Three things are deliberately not done:

- **The projection's smear is not subtracted.** Geometry says a 5-plane projection widens a
  leaning sheet by a further `4 dz tan θ`. Real predictions do not show that much: taking it
  off made GBM at 40–50° read 15–36% thinner than upright GBM (table under Validation).
- **No correction is fitted to each stack.** How fast width grows with tilt differs between
  stacks, and fitting it would flatten each by construction, but it would also hide a tilt
  that is read wrongly.
- **Thickness is not taken as a distance in 3D**, from a centerline point to the nearest
  surface in any slice. That is as flat across tilt, but it reads 5–15% lower for upright GBM
  too, more where masks are noisier, so it would not compare between cases.

The correction is only as good as the tilt. Where tilt is read too high, as it may be on a
stack whose field moves between slices and is slightly overcorrected, exclusion used to
lose GBM and correction now reads it thin.

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

**Thickness corrected for tilt.** A sheet's own thickness does not depend on which way it
leans, so a good measurement is flat across tilt. Four real stacks (AGH1 botL, AGH9-1-1
60x_2, AGH9-2-2 ROI2, AGH10 2-2; every second slice), pieces whose tilt is known within 6°,
median width relative to the same stack's pieces at 0–10°, as the range over the four stacks:

| Tilt | In the slice | × cos(tilt) | Smear also taken off | 3D distance |
|---|---|---|---|---|
| 10–20° | 1.03–1.11 | 0.99–1.09 | 0.94–1.04 | 0.99–1.06 |
| 20–30° | 1.03–1.21 | 0.94–1.10 | 0.83–0.96 | 0.92–1.02 |
| 30–40° | 1.15–1.36 | 0.95–1.10 | 0.76–0.89 | 0.92–0.99 |
| 40–50° | 1.23–1.51 | 0.87–1.08 | 0.64–0.85 | 0.85–0.94 |
| 50–60° | 1.30–1.71 | 0.77–0.99 | | 0.71–0.88 |

Uncorrected, width grows with tilt in every stack. Times the cosine it stays within a tenth
up to 40°, with no common direction across stacks, and falls off past 50°. On the two stacks
predicted on every slice (AGH1 botL, AGH9-2-2 ROI2) the largest departure up to 50° was
9.5%, against 52% uncorrected. The 3D distance is a second measurement that uses no tracking,
and it is flat as well; the tilt it implies (the arc cosine of 3D distance over in-slice
width) rises in step with the tracked tilt, about 8° above it (medians 33–39°, 41–48°,
50–58° for tracked 20–30°, 30–40°, 40–50°).

What the app then reports, with the decisions as shipped and every piece counted:

| Stack | Kept centerline | Excluded for tilt | Mean kept thickness, µm as imaged | Breaks per 100 thicknesses | Differ between neighbouring slices |
|---|---|---|---|---|---|
| AGH1 botL, every slice | 76.4% → 89.6% | 19.8% → 7.0% | 2.97 → 2.84 | 3.7 → 2.1 | 1.7% → 1.1% |
| AGH9-2-2 ROI2, every slice | 68.2% → 86.6% | 28.9% → 10.6% | 3.20 → 3.15 | 4.2 → 3.0 | 1.7% → 1.5% |
| AGH9-1-1 60x_2, every 2nd | 85.1% → 92.7% | 11.5% → 4.1% | 4.22 → 3.93 | 2.7 → 1.5 | 2.9% → 1.6% |
| AGH10 2-2, every 2nd | 79.7% → 87.7% | 13.3% → 5.6% | 4.19 → 3.97 | 2.8 → 1.9 | 2.9% → 2.0% |

So 8 to 18 points more of the centerline is measured, and decisions change less often along
it and through Z. **Mean thickness reads 2–7% lower than uncorrected**, and which of the two
is nearer the truth is not known: uncorrected, kept GBM at 10–30° was 0–11% wider than
upright GBM; corrected, kept GBM at 10–40° is within −9% to +7% of it. AGH9-1-1 60x_2 is the
stack that reads low (0.93 and 0.91 at 20–30° and 30–40°), and it is the one whose field
motion may be overcorrected (above). Numbers measured with and without the correction
should not be compared with each other; reports and exports say which was used.

Through the running app (AGH9-2-2 ROI2, v10 predictions on all 40 slices, measured over the
API): kept samples went from 56.8% to 72.4% of all centerline samples, junctions and tapers
included, oblique from 31.5% to 12.4%, and mean thickness from 3.24 to 3.18 µm as imaged. In
the 3D model what stays excluded is the membrane that lies flat; the blocks on upright-looking
walls are gone.

The tilt this rests on repeats: with the planes of a stack split into two interleaved halves
and each tracked on its own, a piece's tilt in one half and the tilt of the same stretch in
the other differ by a median 1.7° (RMS 4.7°, 2,298 pieces), and fall on the same side of the
limit 95% of the time. Where a decision changes along a centerline, the measured tilt steps
by a median 23° between the two pieces, against 9° between neighbours that are decided alike.

Synthetic stacks cannot test this: their masks are exact projections, so they carry the full
smear that real predictions do not, and there the cosine alone would leave GBM at 30–40°
about a fifth too thick.

**Small holes.** AGH1 botL (41 slices, every slice): 11 holes closed on 8 slices, median 75
px. Two of them are on annotated slices, and both are annotated as GBM throughout. Within
1.5 thicknesses of the closed holes, centerline samples reading under 0.6 of the typical
thickness fell from 182 to 59, and junction points from 104 to 41. AGH9-2-2 ROI2 through
the app (40 slices): 2 holes closed (36 and 60 px, probability inside 0.54); mean kept
thickness moved from 3.177 to 3.170 µm. So this removes local errors and stray branches and
does not move a stack's mean. The annotated planes are ones the model was trained on, where
it has fewer holes than elsewhere; there is no annotation on planes it has not seen.

**Tried alongside it and not used.** Taking the median of each slice's mask with the slice
either side before analysis: on synthetic stacks with noise drawn afresh in every slice it
halved steep GBM wrongly kept (45–60°: 34% to 15%), but real masks are not noisy in that way,
and on real stacks it changed nothing that could be measured (Dice against annotation 0.738
to 0.739, wrong decisions with a known tilt 3.6% and 3.9% to 3.6% and 4.3%). Requiring an
excluded patch to hold clear evidence as a whole: half as many patches, but steep GBM
wrongly kept rose from 7.2% to 8.0%. Charging more for a decision to change between slices:
changes fell, and wrong decisions rose in step, because steep sheet is short in Z by geometry.

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

## 3D model

Implemented in `backend/agh_api/gbm_volume.py` (the volume), `frontend/src/gbmVolume.js`
(its surface, and what a click points at) and `frontend/src/gbm3dRenderer.js` (drawing).

The 3D mode is offered for an image with more than 10 Z slices once every slice has a
finished prediction. It adds nothing to the predictions: it shows them together, as the
filter shows each slice, which includes the small holes the Z analysis closed.

### The volume

`POST /analysis-runs/gbm-volume` takes the run of every slice and returns one layer per
slice. A layer is what the viewer shows on that slice: the piece image the overlay draws
from, with the decision for each piece, so corrections and the current filter settings are
in it. Where the Z analysis is not ready, a layer is the plain prediction and all of it is
shown as measured; the 3D view says how many layers that is.

- **Reduced, not smoothed.** Each layer is reduced by whole pixels so the longer side of the
  image is at most 512 voxels (4 times for a 1952 px image). A voxel holds the share of its
  block that is GBM, the share that is measured GBM, and the reason code found in the block.
  Nothing is blurred, closed or interpolated between slices.
- **In register.** Where the Z analysis measured the field moving, each layer is placed in
  the frame shared by the stack, with the same registration the tilt measurement uses, so a
  wall that is vertical in the sample is vertical in the model. The volume is widened to
  hold the slices, by at most a quarter of the image on each side. The header says where
  each voxel of each layer is in that slice's own image, which is how a click finds its
  place again.
- **Proportions.** Voxels are drawn at the pixel size times the reduction, and slices at the
  Z step the filter uses (entered, or from the file). With no Z step, slices are drawn one
  voxel apart and the view says so. Expansion is not applied: the model is as imaged.
- **The ends repeat.** The first and last two slices are predicted from the same five planes
  as their neighbour, so those layers repeat it.

The response is three volumes of one byte per voxel behind a small JSON header, sent
gzip-compressed. Built volumes are kept in memory for the last few requests.

### The surface, and a click

The browser turns the volume into a surface where half a voxel is GBM (surface nets, in a
worker), treating the volume as empty beyond its faces, so GBM cut by the first or last
slice ends in a flat cap. Each vertex is coloured by whether the GBM around it is measured,
and otherwise by its reason, with the colours the slices use.

A click sends a ray from the camera through the pointer and takes the first place it meets
GBM that is drawn, by stepping through the volume. The slice is the layer nearest that
place, and the position in the slice's image comes from the layer's registration. The
viewer opens that slice and marks the place.

### What it is good for, and not

At 4 times reduction a GBM 12 px wide is 3 voxels wide. The model shows shape, continuity
through Z and where the filter's decisions fall on the sheet. It is not for reading
thickness, and gaps or bridges narrower than a voxel can close or open in it.

Stretching Z makes leaning sheets look upright. At 4 times, a sheet 45° from vertical is drawn
14° from vertical, so GBM excluded for tilt can look like a straight wall. Judge tilt at 1.

### Checked

On synthetic stacks (shells around overlapping balls, a prediction on every slice, masks
jittered between slices): a 1952 × 1952, 60-slice stack took 1.3 s to build on the server
(2.7 MB sent) and 1.7 s from pressing **3D** to a drawn model, and turned at 60 frames per
second on an Apple-silicon laptop. Clicks opened the slice the pointer label named, with the
mark on the clicked wall. Tests cover reduction, registration and the way back from a voxel
to a slice (`backend/tests/test_gbm_volume.py`), and that the surface is closed, faces
outwards, and is hit where expected (`frontend/src/gbmVolume.selftest.mjs`). **It has not
been run on real stacks yet**, and not on other graphics hardware.

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
