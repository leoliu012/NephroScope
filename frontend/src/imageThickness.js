import { batchProgress, comparisonGroups, imageKey, makeAnalysisBatch } from './caseAnalysis.js'
import { stableModelJson } from './modelAnalysis.js'

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

export function imageThicknessSettingsChanged(batch, { gap, channelIndex, calibration }) {
  const image = batch?.images?.[0]
  return Boolean(image && (batch.gap !== gap || image.channelIndex !== channelIndex
    || stableModelJson(image.calibration) !== stableModelJson(calibration)))
}

export function imageThicknessReport(batch, options = {}) {
  if (!batch) return null
  const image = batch.images[0]
  const groups = comparisonGroups(batch, {
    groupBy: options.groupBy === 'slice' ? 'slice' : 'image',
    unit: options.unit || 'nm', observed: Boolean(options.observed),
  }).map(group => ({ ...group, label: options.groupBy === 'slice'
    ? `Z${batch.jobs.find(job => job.id === group.key).zIndex + 1}` : 'All analyzed Z slices' }))
  if (!groups.length) return null
  return {
    caseId: image.caseId, filename: image.filename, calibration: image.calibration,
    channelIndex: image.channelIndex, gap: batch.gap, createdAt: batch.createdAt,
    slices: batch.jobs.map(job => job.zIndex + 1),
    measuredSlices: batch.jobs.filter(job => job.distribution).map(job => job.zIndex + 1),
    progress: batchProgress(batch.jobs), groups,
    unit: options.unit || 'nm', observed: Boolean(options.observed),
    focus: options.focus !== false, showPoints: options.showPoints !== false,
    groupBy: options.groupBy === 'slice' ? 'slice' : 'image',
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
    throw new Error('This image and thickness report are too large for one PNG/JPEG. Choose PDF, or pool the Z slices into one box plot.')
  }
  return { width, height, items }
}
