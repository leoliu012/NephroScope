import { renderToStaticMarkup } from 'react-dom/server'
import ThicknessBoxPlot from './components/ThicknessBoxPlot.jsx'
import { gapLabel } from './caseAnalysis.js'
import { combinedThicknessExportLayout, thicknessReportPages } from './imageThickness.js'

const number = value => Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 })

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
  if (slices.length < 3) return slices.join(', ')
  const step = slices[1] - slices[0]
  if (slices.every((z, i) => i === 0 || z - slices[i - 1] === step)) {
    return `${slices[0]}–${slices.at(-1)}${step > 1 ? ` (step ${step})` : ''}`
  }
  return slices.length > 40 ? `${slices.slice(0, 40).join(', ')}… (${slices.length} slices)` : slices.join(', ')
}

async function svgImage(markup) {
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('Unable to render the thickness box plot for export'))
      image.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function renderThicknessReport(report) {
  const pages = thicknessReportPages(report)
  if (!pages.length) throw new Error('Run thickness analysis before exporting a box plot')
  // Keep the same scale as the sidebar comparison, including across PDF pages.
  const axisMaximum = Math.max(...report.groups.map(group => report.focus ? group.summary.high : group.summary.max))
  const canvases = []
  for (const [pageIndex, groups] of pages.entries()) {
    const canvas = document.createElement('canvas')
    canvas.width = 1400
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Unable to create the thickness report')
    context.font = '20px Arial'
    const cal = report.calibration
    const lines = [
      `Case: ${report.caseId}`,
      `Image: ${report.filename}`,
      `Analysis: ${new Date(report.createdAt).toLocaleString()} · Channel ${report.channelIndex + 1} · ${gapLabel(report.gap)}`,
      `Selected Z: ${sliceLabel(report.slices)} · Measured Z: ${sliceLabel(report.measuredSlices)}`,
      `${report.progress.complete}/${report.progress.total} runs measured · ${report.progress.empty} empty masks · ${report.progress.failed} need attention${report.progress.complete < report.progress.total ? ' · PARTIAL RESULTS' : ''}`,
      `Pixel size: ${cal.pixelSizeXUm} × ${cal.pixelSizeYUm} µm/px · ${report.observed ? 'Observed thickness (before EF)' : cal.expansionEnabled ? `EF-adjusted thickness, factor ${cal.expansionFactor}` : 'Unexpanded thickness'}`,
      `All thickness values in ${report.unit}. Every individual centerline point contributes to the statistics.`,
    ].flatMap(line => wrappedLines(context, line, 1280))
    const chartY = 110 + lines.length * 28
    const chartHeight = Math.round((74 + groups.length * 78) * 1280 / 980)
    const tableY = chartY + chartHeight + 60
    canvas.height = tableY + 54 + groups.length * 78 + 140
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#182230'
    context.font = 'bold 34px Arial'
    context.fillText('GBM thickness analysis', 60, 60)
    context.font = '20px Arial'
    lines.forEach((line, i) => context.fillText(line, 60, 106 + i * 28))
    const markup = renderToStaticMarkup(<ThicknessBoxPlot groups={groups} unit={report.unit}
      focus={report.focus} showPoints={report.showPoints} axisMaximum={axisMaximum} chartOnly theme="light" />)
    const image = await svgImage(markup)
    context.drawImage(image, 60, chartY, 1280, chartHeight)
    context.fillStyle = '#475467'
    context.font = '18px Arial'
    context.fillText(`Box: Q1–Q3 · median line · 1.5 × IQR whiskers${report.focus ? ' · axis focused on whiskers' : ''}`, 60, tableY - 22)
    const columns = [60, 570, 760, 950, 1140, 1340]
    context.fillStyle = '#182230'
    context.font = 'bold 19px Arial'
    ;['Group', 'Points', 'Q1', 'Median', 'Q3', 'Outliers'].forEach((label, i) => {
      context.textAlign = i ? 'right' : 'left'
      context.fillText(label, columns[i], tableY + 12)
    })
    groups.forEach((group, index) => {
      const y = tableY + 30 + index * 78
      const stats = group.summary
      context.fillStyle = index % 2 ? '#ffffff' : '#f2f4f7'
      context.fillRect(55, y, 1290, 76)
      context.fillStyle = '#182230'
      context.font = '20px Arial'
      ;[group.label, stats.count.toLocaleString(), number(stats.q1), number(stats.median), number(stats.q3), stats.outliers.toLocaleString()].forEach((value, i) => {
        context.textAlign = i ? 'right' : 'left'
        context.fillText(value, columns[i], y + 27)
      })
      context.textAlign = 'left'
      context.font = '17px Arial'
      context.fillStyle = '#475467'
      context.fillText(`Whiskers: ${number(stats.low)}–${number(stats.high)} ${report.unit} · Min/Max: ${number(stats.min)}–${number(stats.max)} ${report.unit}`, 60, y + 56)
    })
    context.textAlign = 'left'
    context.font = '17px Arial'
    context.fillStyle = '#475467'
    context.fillText(report.showPoints ? 'Dots show representative actual samples; all points contribute to the statistics.' : 'Statistics use all individual centerline samples.', 60, canvas.height - 95)
    context.fillText('Z projections may overlap; points and slices are not independent biological replicates.', 60, canvas.height - 68)
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
