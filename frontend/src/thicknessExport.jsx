import { renderToStaticMarkup } from 'react-dom/server'
import ThicknessDistributionPlot from './components/ThicknessDistributionPlot.jsx'
import { combinedThicknessExportLayout, thicknessReportPages } from './imageThickness.js'
import { balancedBreak, caseSections, distributionLayout, formatThickness, hasCaseSections, plotDomain } from './thicknessStats.js'
import { canvasBlob, downloadBlob } from './exportPages.js'

const PAGE_WIDTH = 1400
const CHART_WIDTH = 1280

function wrappedLines(context, text, width) {
  const lines = []
  let line = ''
  for (const char of String(text)) {
    if (context.measureText(line + char).width > width && line) { lines.push(line); line = '' }
    line += char
  }
  lines.push(line)
  return lines
}

function sliceLabel(slices) {
  if (!slices.length) return 'none'
  if (slices.length < 3) return slices.map(z => `Z${z}`).join(', ')
  const step = slices[1] - slices[0]
  if (slices.every((z, i) => i === 0 || z - slices[i - 1] === step)) {
    return `Z${slices[0]}–Z${slices.at(-1)}${step > 1 ? ` (every ${step})` : ''}`
  }
  return slices.length > 40 ? `${slices.slice(0, 40).map(z => `Z${z}`).join(', ')}… (${slices.length} slices)` : slices.map(z => `Z${z}`).join(', ')
}

async function svgImage(markup) {
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('Unable to render the thickness plot for export'))
      image.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

const FONT = 'Arial, "Segoe UI", "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif'
const NOTICE = 'Research use only. Not validated for clinical diagnosis or treatment decisions.'

// Line breaks at "_", "-" or spaces where possible (file names have few
// spaces); two-line labels split near the middle.
function separatorLines(context, text, width) {
  const value = String(text)
  const fits = part => context.measureText(part).width <= width
  if (fits(value)) return [value]
  if (context.measureText(value).width <= width * 2) {
    const cut = balancedBreak(value, fits)
    if (cut > 0) return [value.slice(0, cut).trimEnd(), value.slice(cut).trimStart()]
  }
  const lines = []
  let rest = value
  while (rest && !fits(rest)) {
    let fit = 1
    while (fit < rest.length && fits(rest.slice(0, fit + 1))) fit++
    const window = rest.slice(0, fit)
    const breakAt = Math.max(...['_', '-', ' ', '·'].map(mark => window.lastIndexOf(mark)))
    const cut = breakAt >= Math.floor(fit * 0.5) ? breakAt + 1 : fit
    lines.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) lines.push(rest)
  return lines.length ? lines : ['']
}

// Up to two lines that fit the width; the second keeps the end of the label.
function cellLines(context, text, width) {
  const lines = separatorLines(context, text, width)
  if (lines.length <= 2) return lines
  let tail = String(text).slice(lines[0].length).trimStart()
  while (tail.length > 1 && context.measureText(`…${tail}`).width > width) tail = tail.slice(1)
  return [lines[0], `…${tail}`]
}

function imageLabel(group) {
  return group.filename ? `${group.filename}${Number.isInteger(group.zIndex) ? ` · Z${group.zIndex + 1}` : ''}` : group.label
}

// Table rows for one page: image/slice groups sit under a header per case
// carrying the pooled case statistics.
function tableRows(pageGroups, caseGroups, seenCases) {
  if (!hasCaseSections(pageGroups)) return pageGroups.map(group => ({ label: group.label, stats: group.summary }))
  const pooled = new Map(caseGroups.map(group => [group.caseId, group]))
  return caseSections(pageGroups).flatMap(section => {
    const continued = seenCases.has(section.caseId)
    seenCases.add(section.caseId)
    const header = {
      label: `${section.caseId}${continued ? ' (continued)' : ''}`,
      stats: pooled.get(section.caseId)?.summary || null,
      header: true,
    }
    return [header, ...section.groups.map(group => ({ label: imageLabel(group), stats: group.summary, nested: true }))]
  })
}

// Report pages: heading, context lines, the light-theme distribution plot and
// a statistics table. Every page shares one axis so groups stay comparable.
export async function renderDistributionPages({ title, lines: details, groups, caseGroups = [], unit, observed, focus, groupsPerPage = 6 }) {
  if (!groups.length) throw new Error('There are no thickness results to export yet')
  const domain = plotDomain(hasCaseSections(groups) ? [...groups, ...caseGroups] : groups, focus)
  const pages = Array.from({ length: Math.ceil(groups.length / groupsPerPage) }, (_, i) => groups.slice(i * groupsPerPage, (i + 1) * groupsPerPage))
  const columns = [
    { label: 'Group', x: 60, width: 640 },
    { label: `Mean ± SD (${unit})`, x: 930, bold: true, value: stats => `${formatThickness(stats.mean, unit, { withUnit: false })} ± ${formatThickness(stats.sd, unit, { withUnit: false })}` },
    { label: 'Median', x: 1060, value: stats => formatThickness(stats.median, unit, { withUnit: false }) },
    { label: 'IQR (Q1–Q3)', x: 1230, value: stats => `${formatThickness(stats.q1, unit, { withUnit: false })}–${formatThickness(stats.q3, unit, { withUnit: false })}` },
    { label: 'Points', x: 1340, value: stats => stats.count.toLocaleString() },
  ]
  const seenCases = new Set()
  const canvases = []
  for (const [pageIndex, pageGroups] of pages.entries()) {
    const canvas = document.createElement('canvas')
    canvas.width = PAGE_WIDTH
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Unable to create the thickness report')
    context.font = `20px ${FONT}`
    const lines = details.flatMap(line => wrappedLines(context, line, CHART_WIDTH))
    const rows = tableRows(pageGroups, caseGroups, seenCases).map(row => {
      context.font = row.header ? `bold 20px ${FONT}` : `20px ${FONT}`
      const labelLines = cellLines(context, row.label, columns[0].width - (row.nested ? 30 : 0))
      return { ...row, labelLines, height: row.header ? 44 : labelLines.length > 1 ? 72 : 50 }
    })
    const plotLayout = distributionLayout(pageGroups)
    const chartY = 110 + lines.length * 28
    const chartHeight = Math.round(plotLayout.height * CHART_WIDTH / plotLayout.width)
    const tableY = chartY + chartHeight + 44
    canvas.height = tableY + 26 + rows.reduce((sum, row) => sum + row.height + 2, 0) + 110
    if (canvas.height > 16000) throw new Error('Too many comparison groups for one image. Export a PDF instead.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#182230'
    context.font = `bold 34px ${FONT}`
    context.fillText(title, 60, 60)
    context.font = `20px ${FONT}`
    lines.forEach((line, i) => context.fillText(line, 60, 106 + i * 28))
    const pageCases = new Set(pageGroups.map(group => group.caseId))
    const markup = renderToStaticMarkup(<ThicknessDistributionPlot groups={pageGroups} unit={unit} observed={observed}
      focus={focus} domain={domain} caseGroups={caseGroups.filter(group => pageCases.has(group.caseId))} chartOnly theme="light" />)
    context.drawImage(await svgImage(markup), 60, chartY, CHART_WIDTH, chartHeight)

    context.fillStyle = '#182230'
    context.font = `bold 19px ${FONT}`
    columns.forEach((column, i) => {
      context.textAlign = i ? 'right' : 'left'
      context.fillText(column.label, column.x, tableY + 12)
    })
    let y = tableY + 26
    rows.forEach((row, index) => {
      context.fillStyle = row.header ? '#e4e9f0' : index % 2 ? '#ffffff' : '#f5f6f8'
      context.fillRect(55, y, 1290, row.height)
      context.fillStyle = '#182230'
      context.textAlign = 'left'
      context.font = row.header ? `bold 20px ${FONT}` : `20px ${FONT}`
      row.labelLines.forEach((line, i) => context.fillText(line, columns[0].x + (row.nested ? 30 : 0), y + (row.header ? 29 : 32) + i * 24))
      if (row.stats) {
        columns.slice(1).forEach(column => {
          context.textAlign = 'right'
          context.font = column.bold || row.header ? `bold 20px ${FONT}` : `20px ${FONT}`
          context.fillText(column.value(row.stats), column.x, y + (row.header ? 29 : 32))
        })
      }
      y += row.height + 2
    })
    context.textAlign = 'left'
    context.font = `17px ${FONT}`
    context.fillStyle = '#475467'
    context.fillText('Statistics use every individual centerline thickness measurement in the selected Z runs.', 60, canvas.height - 68)
    context.fillStyle = '#9c3030'
    context.fillText(NOTICE, 60, canvas.height - 40)
    context.textAlign = 'right'
    context.fillStyle = '#475467'
    context.fillText(`${pageIndex + 1}/${pages.length}`, 1340, canvas.height - 40)
    canvases.push(canvas)
  }
  return canvases
}

export async function renderThicknessReport(report) {
  if (!thicknessReportPages(report).length) throw new Error('Run thickness analysis before exporting its plot')
  const cal = report.calibration
  return renderDistributionPages({
    title: 'GBM thickness analysis',
    lines: [
      `Case: ${report.caseId}`,
      `Image: ${report.filename}`,
      `Analysis: ${new Date(report.createdAt).toLocaleString()} · Channel ${report.channelIndex + 1} · Z sampling: ${report.gapLabel}`,
      `Selected: ${sliceLabel(report.slices)} · Measured: ${sliceLabel(report.measuredSlices)}`,
      `${report.progress.complete}/${report.progress.total} Z runs measured · ${report.progress.empty} empty masks · ${report.progress.failed} need attention${report.progress.complete < report.progress.total ? ' · PARTIAL RESULTS' : ''}`,
      `Pixel size: ${cal.pixelSizeXUm} × ${cal.pixelSizeYUm} µm/px · ${report.observed ? 'Observed thickness (before EF)' : cal.expansionEnabled ? `EF-adjusted thickness, factor ${cal.expansionFactor}` : 'Unexpanded thickness'} · values in ${report.unit}`,
    ],
    groups: report.groups,
    unit: report.unit,
    observed: report.observed,
    focus: report.focus,
  })
}

const GROUP_BY_LABEL = { case: 'Case', image: 'Image within case', slice: 'Image and Z slice' }

function calibrationSummary(images) {
  const distinct = new Set(images.map(image => JSON.stringify([
    image.calibration.pixelSizeXUm, image.calibration.pixelSizeYUm,
    image.calibration.expansionEnabled, image.calibration.expansionFactor,
  ])))
  if (distinct.size !== 1) return 'Calibration set per image (pixel size and EF)'
  const cal = images[0].calibration
  return `Pixel size ${cal.pixelSizeXUm} × ${cal.pixelSizeYUm} µm/px · ${cal.expansionEnabled ? `EF ${cal.expansionFactor}` : 'unexpanded'}`
}

function fileSlug(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'analysis'
}

// Case analysis distributions as a paginated PDF or one PNG.
export async function exportCaseAnalysisDistributions({
  format, title, analysis, gapLabel, groups, caseGroups = [], progress, groupBy, unit, observed, focus, excludedCount = 0,
}) {
  const included = analysis.images.length - excludedCount
  const cases = [...new Set(analysis.images.map(image => image.caseId))]
  const pages = await renderDistributionPages({
    title: 'GBM thickness distributions',
    lines: [
      `Analysis: ${title} · ${cases.length} case${cases.length === 1 ? '' : 's'} · ${included} of ${analysis.images.length} images · Z sampling: ${gapLabel}`,
      `Compared by: ${GROUP_BY_LABEL[groupBy] || groupBy} · ${observed ? 'Observed thickness (before EF)' : 'EF-adjusted thickness'} · values in ${unit}`,
      `${progress.complete}/${progress.total} Z runs measured${progress.empty ? ` · ${progress.empty} empty masks` : ''}${progress.complete < progress.total ? ' · PARTIAL RESULTS' : ''}`,
      `${calibrationSummary(analysis.images)} · Started ${new Date(analysis.createdAt).toLocaleString()} · Exported ${new Date().toLocaleString()}`,
    ],
    groups, caseGroups, unit, observed, focus,
    groupsPerPage: format === 'png' ? groups.length : 8,
  })
  const filename = `GBM-thickness_${fileSlug(title)}_${fileSlug(gapLabel)}_by-${groupBy}.${format === 'png' ? 'png' : 'pdf'}`
  if (format === 'png') {
    downloadBlob(await canvasBlob(pages[0], 'image/png'), filename)
  } else {
    const { jsPDF } = await import('jspdf')
    const orientation = page => page.width >= page.height ? 'landscape' : 'portrait'
    const pdf = new jsPDF({ orientation: orientation(pages[0]), unit: 'px', format: [pages[0].width, pages[0].height], compress: true })
    pages.forEach((page, index) => {
      if (index) pdf.addPage([page.width, page.height], orientation(page))
      pdf.addImage(page.toDataURL('image/png'), 'PNG', 0, 0, page.width, page.height, undefined, 'FAST')
    })
    pdf.save(filename)
  }
  return filename
}

export function appendThicknessReport(imageCanvas, reports) {
  const layout = combinedThicknessExportLayout(imageCanvas, reports)
  const canvas = document.createElement('canvas')
  canvas.width = layout.width
  canvas.height = layout.height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Unable to combine the image and thickness report')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(imageCanvas, (canvas.width - imageCanvas.width) / 2, 0)
  reports.forEach((report, i) => {
    const item = layout.items[i]
    context.drawImage(report, 0, item.y, item.width, item.height)
  })
  return canvas
}
