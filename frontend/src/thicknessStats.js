// Axis scaling and density estimation for GBM thickness plots.

// Minor gridlines per major step: 100 -> 20, 200 -> 50, 50 -> 10.
const MINOR_DIVISIONS = { 1: 5, 2: 4, 5: 5 }

function decimalsFor(step) {
  if (!(step > 0)) return 0
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-9))
}

// Step of 1, 2 or 5 x 10^n closest (in log scale) to the raw step, as d3 does.
export function niceStep(rawStep) {
  if (!(rawStep > 0) || !Number.isFinite(rawStep)) return { step: 1, fraction: 1 }
  let base = 10 ** Math.floor(Math.log10(rawStep))
  const error = rawStep / base
  let fraction = 1
  if (error >= Math.sqrt(50)) base *= 10
  else if (error >= Math.sqrt(10)) fraction = 5
  else if (error >= Math.sqrt(2)) fraction = 2
  return { step: fraction * base, fraction }
}

// Round axis bounds outward to whole steps of 1, 2 or 5 x 10^n, so gridlines
// fall on values such as 50, 100 or 200 nm instead of 306.346.
export function niceScale(minimum, maximum, targetTicks = 6) {
  let low = Number(minimum)
  let high = Number(maximum)
  if (!Number.isFinite(low) || !Number.isFinite(high)) { low = 0; high = 1 }
  if (high < low) [low, high] = [high, low]
  if (high - low < 1e-12) {
    const pad = Math.abs(high) > 0 ? Math.abs(high) * 0.1 : 1
    low -= pad
    high += pad
  }
  const { step, fraction } = niceStep((high - low) / Math.max(1, targetTicks - 1))
  const decimals = decimalsFor(step)
  const round = value => Number(value.toFixed(Math.min(12, decimals + 2)))
  const domainMin = round(Math.floor(low / step + 1e-9) * step)
  const domainMax = round(Math.ceil(high / step - 1e-9) * step)
  const ticks = []
  for (let value = domainMin, i = 0; value <= domainMax + step * 1e-6 && i < 200; i++, value = domainMin + i * step) {
    ticks.push(round(value))
  }
  const minorStep = step / MINOR_DIVISIONS[fraction]
  const minorTicks = []
  for (let i = 0; domainMin + i * minorStep <= domainMax + minorStep * 1e-6 && i < 1000; i++) {
    if (i % MINOR_DIVISIONS[fraction]) minorTicks.push(round(domainMin + i * minorStep))
  }
  return { min: domainMin, max: domainMax, step, minorStep, ticks, minorTicks, decimals }
}

export function formatAxisValue(value, decimals = 0) {
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

// Display precision for statistics: whole nanometres, thousandths of µm.
export function formatThickness(value, unit, { withUnit = true } = {}) {
  if (!Number.isFinite(Number(value))) return '—'
  const digits = unit === 'nm' ? (Math.abs(value) < 10 ? 1 : 0) : (Math.abs(value) < 0.01 ? 4 : 3)
  const text = Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return withUnit ? `${text} ${unit}` : text
}

// Weighted Gaussian kernel density over value/count pairs. The bandwidth is
// at least the typical spacing between neighbouring measured values and a
// fraction of the IQR, so pixel-quantized thickness values do not form a comb.
export function densityCurve(values, counts, { min, max }, points = 96, { spread = 0 } = {}) {
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (!total || !(max > min)) return []
  let mean = 0
  values.forEach((value, i) => { mean += value * counts[i] })
  mean /= total
  let variance = 0
  values.forEach((value, i) => { variance += counts[i] * (value - mean) ** 2 })
  const sd = Math.sqrt(variance / Math.max(1, total - 1))
  const spacings = []
  for (let i = 1; i < values.length; i++) spacings.push(values[i] - values[i - 1])
  spacings.sort((a, b) => a - b)
  const typicalSpacing = spacings.length ? spacings[Math.floor(spacings.length / 2)] : 0
  const silverman = 1.06 * (sd || (max - min) / 10) * total ** -0.2
  // spread (the IQR) keeps pixel-quantized thickness values from showing as ripples.
  const bandwidth = Math.max(silverman, typicalSpacing * 1.5, spread / 3.5, (max - min) / 200)
  const curve = []
  let peak = 0
  for (let i = 0; i < points; i++) {
    const x = min + (max - min) * i / (points - 1)
    let density = 0
    for (let j = 0; j < values.length; j++) {
      const u = (x - values[j]) / bandwidth
      if (u > -4 && u < 4) density += counts[j] * Math.exp(-0.5 * u * u)
    }
    peak = Math.max(peak, density)
    curve.push([x, density])
  }
  return peak ? curve.map(([x, density]) => [x, density / peak]) : []
}

// ---- Distribution plot layout (shared by the page and the export) ----

export function thicknessAxisTitle(unit, observed) {
  return observed ? `Observed GBM thickness, before EF (${unit})` : `GBM thickness, EF-adjusted (${unit})`
}

export function plotDomain(groups, focus) {
  if (!groups.length) return { min: 0, max: 1 }
  return {
    min: Math.min(...groups.map(group => focus ? group.summary.low : group.summary.min)),
    max: Math.max(...groups.map(group => focus ? group.summary.high : group.summary.max)),
  }
}

export const PLOT_LAYOUT = {
  full: { width: 980, plotLeft: 262, plotRight: 820, rowHeight: 62, top: 34, bottom: 62 },
  compact: { width: 320, plotLeft: 12, plotRight: 308, rowHeight: 64, top: 30, bottom: 58 },
}

export function distributionPlotSize(groupCount, compact = false) {
  const layout = compact ? PLOT_LAYOUT.compact : PLOT_LAYOUT.full
  return { width: layout.width, height: layout.top + groupCount * layout.rowHeight + layout.bottom }
}
