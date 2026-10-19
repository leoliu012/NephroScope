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

// The full layout keeps a fixed label column left of the plot area; labels
// wrap or shorten inside it and never run into the distributions.
export const PLOT_LAYOUT = {
  full: { width: 1060, labelLeft: 16, labelRight: 300, plotLeft: 320, plotRight: 900, rowHeight: 70, top: 34, bottom: 62 },
  compact: { width: 320, labelLeft: 4, labelRight: 316, plotLeft: 12, plotRight: 308, rowHeight: 64, top: 30, bottom: 58 },
}

export function middleEllipsis(text, max) {
  const value = String(text || '')
  if (value.length <= max) return value
  const head = Math.ceil((max - 1) * 0.55)
  return `${value.slice(0, head)}…${value.slice(value.length - (max - 1 - head))}`
}

// Characters that fit in a column, from a conservative Arial advance width
// (digits, capitals and underscores dominate microscopy file names).
export function labelChars(widthPx, fontSize, bold = false) {
  return Math.max(4, Math.floor(widthPx / (fontSize * (bold ? 0.64 : 0.57))))
}

const BREAK_MARKS = ['_', '-', ' ', '·']

// Where to split a label that needs two lines: the separator nearest the
// middle whose two halves both fit, so neither line is a stub like "2.tif".
export function balancedBreak(text, fits) {
  let best = -1
  for (let i = 1; i < text.length - 1; i++) {
    if (!BREAK_MARKS.includes(text[i])) continue
    const cut = i + 1
    if (!fits(text.slice(0, cut).trimEnd()) || !fits(text.slice(cut).trimStart())) continue
    if (best < 0 || Math.abs(cut - text.length / 2) < Math.abs(best - text.length / 2)) best = cut
  }
  return best
}

// Wrap at "_", "-", " " or "·" where possible (never at the extension dot);
// a label too long for two lines keeps the end of the name (for example
// "-3.nd2") after a middle ellipsis.
export function wrapLabel(text, maxChars, maxLines = 2) {
  let rest = String(text || '')
  if (rest.length <= maxChars) return [rest]
  if (maxLines === 2 && rest.length <= maxChars * 2) {
    const cut = balancedBreak(rest, part => part.length <= maxChars)
    if (cut > 0) return [rest.slice(0, cut).trimEnd(), rest.slice(cut).trimStart()]
  }
  const lines = []
  while (rest.length > maxChars && lines.length < maxLines - 1) {
    const window = rest.slice(0, maxChars + 1)
    const breakAt = Math.max(...BREAK_MARKS.map(mark => window.lastIndexOf(mark)))
    const cut = breakAt >= Math.floor(maxChars * 0.5) && breakAt < maxChars ? breakAt + 1 : maxChars
    lines.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  lines.push(middleEllipsis(rest, maxChars))
  return lines
}

export const CASE_ROW_HEIGHT = 36

// Image- and slice-level groups are shown under a header per case.
export function hasCaseSections(groups) {
  return groups.length > 0 && groups.every(group => group.filename && !group.title)
}

export function caseSections(groups) {
  const sections = new Map()
  for (const group of groups) {
    if (!sections.has(group.caseId)) sections.set(group.caseId, [])
    sections.get(group.caseId).push(group)
  }
  return [...sections].map(([caseId, members]) => ({ caseId, groups: members }))
}

// Row positions for the plot: optional case header rows, and group rows that
// are left out while their case is folded.
export function distributionLayout(groups, { compact = false, collapsed = {} } = {}) {
  const layout = compact ? PLOT_LAYOUT.compact : PLOT_LAYOUT.full
  const rows = []
  let y = layout.top
  const pushGroup = group => { rows.push({ type: 'group', group, y, height: layout.rowHeight }); y += layout.rowHeight }
  if (!compact && hasCaseSections(groups)) {
    for (const section of caseSections(groups)) {
      const folded = Boolean(collapsed[section.caseId])
      rows.push({ type: 'case', caseId: section.caseId, groups: section.groups, folded, y, height: CASE_ROW_HEIGHT })
      y += CASE_ROW_HEIGHT
      if (!folded) section.groups.forEach(pushGroup)
    }
  } else {
    groups.forEach(pushGroup)
  }
  return { ...layout, rows, rowsBottom: y, height: y + layout.bottom }
}
