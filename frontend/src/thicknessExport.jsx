import { renderToStaticMarkup } from 'react-dom/server'
import ThicknessDistributionPlot from './components/ThicknessDistributionPlot.jsx'
import { combinedThicknessExportLayout, thicknessReportPages } from './imageThickness.js'
import { distributionPlotSize, formatThickness, plotDomain } from './thicknessStats.js'

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

export async function renderThicknessReport(report) {
  const pages = thicknessReportPages(report)
  if (!pages.length) throw new Error('Run thickness analysis before exporting its plot')
  // Keep one axis across PDF pages so groups stay comparable.
  const domain = plotDomain(report.groups, report.focus)
  const unit = report.unit
  const canvases = []
  for (const [pageIndex, groups] of pages.entries()) {
    const canvas = document.createElement('canvas')
    canvas.width = PAGE_WIDTH
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Unable to create the thickness report')
    context.font = '20px Arial'
    const cal = report.calibration
    const lines = [
      `Case: ${report.caseId}`,
      `Image: ${report.filename}`,
      `Analysis: ${new Date(report.createdAt).toLocaleString()} · Channel ${report.channelIndex + 1} · Z sampling: ${report.gapLabel}`,
      `Selected: ${sliceLabel(report.slices)} · Measured: ${sliceLabel(report.measuredSlices)}`,
      `${report.progress.complete}/${report.progress.total} Z runs measured · ${report.progress.empty} empty masks · ${report.progress.failed} need attention${report.progress.complete < report.progress.total ? ' · PARTIAL RESULTS' : ''}`,
      `Pixel size: ${cal.pixelSizeXUm} × ${cal.pixelSizeYUm} µm/px · ${report.observed ? 'Observed thickness (before EF)' : cal.expansionEnabled ? `EF-adjusted thickness, factor ${cal.expansionFactor}` : 'Unexpanded thickness'} · values in ${unit}`,
    ].flatMap(line => wrappedLines(context, line, CHART_WIDTH))
    const chartY = 110 + lines.length * 28
    const size = distributionPlotSize(groups.length)
    const chartHeight = Math.round(size.height * CHART_WIDTH / size.width)
    const tableY = chartY + chartHeight + 44
    canvas.height = tableY + 46 + groups.length * 52 + 90
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#182230'
    context.font = 'bold 34px Arial'
    context.fillText('GBM thickness analysis', 60, 60)
    context.font = '20px Arial'
    lines.forEach((line, i) => context.fillText(line, 60, 106 + i * 28))
    const markup = renderToStaticMarkup(<ThicknessDistributionPlot groups={groups} unit={unit} observed={report.observed}
      focus={report.focus} domain={domain} chartOnly theme="light" />)
    const image = await svgImage(markup)
    context.drawImage(image, 60, chartY, CHART_WIDTH, chartHeight)

    const columns = [60, 720, 880, 1080, 1340]
    context.fillStyle = '#182230'
    context.font = 'bold 19px Arial'
    ;['Group', `Mean ± SD (${unit})`, 'Median', 'IQR (Q1–Q3)', 'Points'].forEach((label, i) => {
      context.textAlign = i ? 'right' : 'left'
      context.fillText(label, columns[i], tableY + 12)
    })
    groups.forEach((group, index) => {
      const y = tableY + 26 + index * 52
      const stats = group.summary
      context.fillStyle = index % 2 ? '#ffffff' : '#f2f4f7'
      context.fillRect(55, y, 1290, 50)
      const cells = [
        group.label,
        `${formatThickness(stats.mean, unit, { withUnit: false })} ± ${formatThickness(stats.sd, unit, { withUnit: false })}`,
        formatThickness(stats.median, unit, { withUnit: false }),
        `${formatThickness(stats.q1, unit, { withUnit: false })}–${formatThickness(stats.q3, unit, { withUnit: false })}`,
        stats.count.toLocaleString(),
      ]
      cells.forEach((value, i) => {
        context.textAlign = i ? 'right' : 'left'
        context.font = i === 1 ? 'bold 20px Arial' : '20px Arial'
        context.fillStyle = '#182230'
        const text = i === 0 ? wrappedLines(context, value, 600)[0] : value
        context.fillText(text, columns[i], y + 32)
      })
    })
    context.textAlign = 'left'
    context.font = '17px Arial'
    context.fillStyle = '#475467'
    context.fillText('Statistics use every individual centerline thickness measurement in the selected Z runs.', 60, canvas.height - 68)
    context.fillStyle = '#9c3030'
    context.fillText('Research use only. Not validated for clinical diagnosis or treatment decisions.', 60, canvas.height - 40)
    context.textAlign = 'right'
    context.fillStyle = '#475467'
    context.fillText(`${pageIndex + 1}/${pages.length}`, 1340, canvas.height - 40)
    canvases.push(canvas)
  }
  return canvases
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
