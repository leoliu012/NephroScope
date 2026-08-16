// Manual line-pair expansion-factor (EF) estimation.
//
// Ported from the "Manual Line-Pair Expansion Factor Estimation" notebook so
// the viewer computes the identical quantity. The user draws matched line
// segments across two images of the same structure:
//
//   * image A – the EXPANDED sample (the notebook's 10X image)
//   * image B – the REFERENCE / unexpanded sample (the notebook's 60X image,
//               treated as the baseline where EF = 1)
//
// For each matched pair the linear expansion factor is
//
//   EF_i = (len_A_px * pxA) / (len_B_px * pxB)
//        = length_A_um / length_B_um
//
// which is exactly the factor the viewer divides a measured length by to
// recover the pre-expansion size. The robust summary (median, IQR, MAD,
// bootstrap CI) mirrors the notebook's `summarize_line_pairs`.

export const DEFAULT_EXPECTED_EF_MIN = 5.5
export const DEFAULT_EXPECTED_EF_MAX = 8.8
export const DEFAULT_MIN_LINE_LENGTH_PX = 50

function toFinite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : NaN
}

export function euclideanLength(p0, p1) {
  const dx = toFinite(p1[0]) - toFinite(p0[0])
  const dy = toFinite(p1[1]) - toFinite(p0[1])
  return Math.hypot(dx, dy)
}

export function lineAngleDeg(p0, p1) {
  const dx = toFinite(p1[0]) - toFinite(p0[0])
  const dy = toFinite(p1[1]) - toFinite(p0[1])
  return (Math.atan2(dy, dx) * 180) / Math.PI
}

// Difference between two unoriented line angles, in [0, 90].
export function acuteAngleDifferenceDeg(a, b) {
  let d = Math.abs((((a - b + 180) % 360) + 360) % 360 - 180)
  if (d > 90) d = 180 - d
  return d
}

// Linear-interpolation percentile (matches numpy.percentile default), so the
// robust statistics agree with the notebook to floating-point tolerance.
export function percentile(sortedValues, q) {
  const values = sortedValues
  const n = values.length
  if (n === 0) return NaN
  if (n === 1) return values[0]
  const rank = (q / 100) * (n - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  if (low === high) return values[low]
  const weight = rank - low
  return values[low] * (1 - weight) + values[high] * weight
}

export function median(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  return percentile(sorted, 50)
}

function mean(values) {
  if (!values.length) return NaN
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sampleStd(values) {
  if (values.length < 2) return NaN
  const m = mean(values)
  const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

// Deterministic PRNG (mulberry32) so the bootstrap CI is reproducible across
// runs and machines, matching the notebook's fixed-seed default_rng.
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Compute one line-pair row. `a`/`b` are { p0:[x,y], p1:[x,y] } in SOURCE
// pixel coordinates; pxA/pxB are the µm/px calibrations of each image.
export function computeLinePairRow(pair, options = {}) {
  const {
    minLineLengthPx = DEFAULT_MIN_LINE_LENGTH_PX,
    expectedEfMin = DEFAULT_EXPECTED_EF_MIN,
    expectedEfMax = DEFAULT_EXPECTED_EF_MAX,
  } = options

  const lenApx = euclideanLength(pair.a.p0, pair.a.p1)
  const lenBpx = euclideanLength(pair.b.p0, pair.b.p1)
  const pxA = toFinite(pair.pxA)
  const pxB = toFinite(pair.pxB)

  const lenAum = lenApx * pxA
  const lenBum = lenBpx * pxB

  const ef = lenBum > 0 ? lenAum / lenBum : NaN
  const scaleBtoApx = lenBpx > 0 ? lenApx / lenBpx : NaN

  const angleA = lineAngleDeg(pair.a.p0, pair.a.p1)
  const angleB = lineAngleDeg(pair.b.p0, pair.b.p1)
  const angleDiff = acuteAngleDifferenceDeg(angleA, angleB)

  const notes = []
  if (lenApx < minLineLengthPx) notes.push(`short expanded line < ${minLineLengthPx}px`)
  if (lenBpx < minLineLengthPx) notes.push(`short reference line < ${minLineLengthPx}px`)
  if (Number.isFinite(ef) && !(ef >= expectedEfMin && ef <= expectedEfMax)) {
    notes.push(`EF outside expected ${expectedEfMin}-${expectedEfMax}`)
  }
  if (angleDiff > 45) notes.push('large orientation difference; verify correspondence')

  return {
    lenApx,
    lenBpx,
    lenAum,
    lenBum,
    ef,
    scaleBtoApx,
    angleA,
    angleB,
    angleDiff,
    qualityNote: notes.length ? notes.join('; ') : 'OK',
  }
}

// Robust EF summary across pairs. Mirrors the notebook's `summarize_line_pairs`.
export function summarizeLinePairs(efValues, { nBoot = 10000, seed = 0 } = {}) {
  const ef = (efValues || []).map(Number).filter(Number.isFinite)
  if (!ef.length) return null

  const sorted = [...ef].sort((a, b) => a - b)
  const med = percentile(sorted, 50)
  const q1 = percentile(sorted, 25)
  const q3 = percentile(sorted, 75)
  const mad = 1.4826 * median(ef.map(value => Math.abs(value - med)))
  const meanValue = mean(ef)
  const std = sampleStd(ef)

  const summary = {
    nPairs: ef.length,
    efMedian: med,
    efMean: meanValue,
    efStd: ef.length > 1 ? std : NaN,
    efMin: sorted[0],
    efQ1: q1,
    efQ3: q3,
    efMax: sorted[sorted.length - 1],
    efIqr: q3 - q1,
    efMadRobust: mad,
    cvPercent: ef.length > 1 && meanValue !== 0 ? (100 * std) / meanValue : NaN,
    medianCi95Low: NaN,
    medianCi95High: NaN,
  }

  if (ef.length >= 3) {
    const rng = mulberry32(seed || 1)
    const boots = new Array(nBoot)
    for (let i = 0; i < nBoot; i += 1) {
      const resample = new Array(ef.length)
      for (let j = 0; j < ef.length; j += 1) {
        resample[j] = ef[Math.floor(rng() * ef.length)]
      }
      boots[i] = median(resample)
    }
    boots.sort((a, b) => a - b)
    summary.medianCi95Low = percentile(boots, 2.5)
    summary.medianCi95High = percentile(boots, 97.5)
  }

  return summary
}

// Map a pair's EF to a "consistency" score and heat-spectrum color relative to
// the consensus (median) EF. score 0 = perfectly consistent (green); score 1 =
// at/above the deviation cap (red). Used both on the line itself and its table
// row so outliers stand out at a glance.
export function consistencyForEf(ef, medianEf, { maxRelativeDeviation = 0.15 } = {}) {
  if (!Number.isFinite(ef) || !Number.isFinite(medianEf) || medianEf === 0) {
    return { score: 1, deviation: NaN, relativeDeviation: NaN, color: heatColor(1) }
  }
  const deviation = ef - medianEf
  const relativeDeviation = Math.abs(deviation) / Math.abs(medianEf)
  const score = Math.max(0, Math.min(1, relativeDeviation / maxRelativeDeviation))
  return { score, deviation, relativeDeviation, color: heatColor(score) }
}

// score 0 -> green (140°), score 1 -> red (0°). A smooth green→amber→red ramp.
export function heatColor(score, { saturation = 72, lightness = 46 } = {}) {
  const clamped = Math.max(0, Math.min(1, Number(score) || 0))
  const hue = 140 * (1 - clamped)
  return `hsl(${hue.toFixed(0)}, ${saturation}%, ${lightness}%)`
}

export function heatColorSoft(score) {
  // Translucent variant for table-row / fill backgrounds.
  const clamped = Math.max(0, Math.min(1, Number(score) || 0))
  const hue = 140 * (1 - clamped)
  return `hsla(${hue.toFixed(0)}, 70%, 45%, 0.18)`
}

export function formatEf(value, digits = 3) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—'
}

export function formatMicronLength(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  if (number >= 100) return `${number.toFixed(1)} µm`
  if (number >= 10) return `${number.toFixed(2)} µm`
  return `${number.toFixed(3)} µm`
}
