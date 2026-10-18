import { MAX_GAP, batchProgress, comparisonGroups, gapLabel, imageKey, makeAnalysisBatch, selectedZSlices } from './caseAnalysis.js'

export function imageThicknessScope(caseId, filename, meta) {
  return `image-thickness:${encodeURIComponent(JSON.stringify([
    caseId, filename, meta?.sourceId, meta?.sourceSize, meta?.sourceMtimeNs,
  ]))}`
}

export function makeImageThicknessBatch({ caseId, filename, zCount, gap, channelIndex, calibration }, id) {
  return makeAnalysisBatch([{
    key: imageKey(caseId, filename), caseId, filename, zCount, channelIndex,
    calibration: { ...calibration },
  }], gap, id)
}

// Distinct Z samplings for this stack; short stacks collapse to one choice.
export function viewerGapOptions(zCount) {
  const seen = new Set()
  const options = []
  for (let gap = 0; gap <= MAX_GAP; gap++) {
    const slices = selectedZSlices(zCount, gap)
    const signature = slices.join(',')
    if (seen.has(signature)) continue
    seen.add(signature)
    options.push({ gap, slices })
  }
  return options
}

export function gapRunCounts(slices, runs = {}) {
  let ready = 0, active = 0, failed = 0
  for (const z of slices) {
    const status = runs[String(z)]?.status
    if (status === 'SUCCEEDED') ready++
    else if (status === 'QUEUED' || status === 'RUNNING') active++
    else if (status === 'FAILED') failed++
  }
  return { total: slices.length, ready, active, failed, missing: slices.length - ready - active }
}

const gapPreferenceKey = scope => `agh-viewer:thickness-gap:v1:${scope}`

export function loadGapPreference(scope) {
  try {
    const value = localStorage.getItem(gapPreferenceKey(scope))
    if (value === null || value === undefined) return null
    const gap = Number(value)
    return Number.isInteger(gap) && gap >= 0 && gap <= MAX_GAP ? gap : null
  } catch {
    return null
  }
}

export function saveGapPreference(scope, gap) {
  try { localStorage.setItem(gapPreferenceKey(scope), String(gap)) } catch { /* optional */ }
}

export function imageThicknessReport(batch, options = {}) {
  if (!batch) return null
  const image = batch.images[0]
  const groupBy = options.groupBy === 'slice' ? 'slice' : 'image'
  const groups = comparisonGroups(batch, {
    groupBy, unit: options.unit || 'nm', observed: Boolean(options.observed),
  }).map(group => {
    const title = groupBy === 'slice' ? `Z${batch.jobs.find(job => job.id === group.key).zIndex + 1}` : 'All analyzed Z slices'
    return { ...group, label: title, title }
  })
  if (!groups.length) return null
  return {
    caseId: image.caseId, filename: image.filename, calibration: image.calibration,
    channelIndex: image.channelIndex, gap: batch.gap, gapLabel: gapLabel(batch.gap), createdAt: batch.createdAt,
    slices: batch.jobs.map(job => job.zIndex + 1),
    measuredSlices: batch.jobs.filter(job => job.distribution).map(job => job.zIndex + 1),
    progress: batchProgress(batch.jobs), groups,
    unit: options.unit || 'nm', observed: Boolean(options.observed),
    focus: options.focus !== false, groupBy,
  }
}

export function thicknessReportPages(report, groupsPerPage = 6) {
  if (!report?.groups?.length) return []
  return Array.from({ length: Math.ceil(report.groups.length / groupsPerPage) }, (_, i) => (
    report.groups.slice(i * groupsPerPage, (i + 1) * groupsPerPage)
  ))
}

export function combinedThicknessExportLayout(image, reports) {
  const width = Math.max(image.width, ...reports.map(report => report.width))
  let height = image.height
  const items = reports.map(report => {
    height += 24
    const item = { y: height, width, height: Math.round(report.height * width / report.width) }
    height += item.height
    return item
  })
  if (width > 16384 || height > 16384 || width * height > 64_000_000) {
    throw new Error('This image and thickness report are too large for one PNG/JPEG. Choose PDF, or pool the Z slices into one plot.')
  }
  return { width, height, items }
}
