// Text pages for PDF exports, drawn with the browser's own fonts so every
// character (µ, ×, accents, CJK) appears exactly as typed.
const EXPORT_TEXT_FONT = 'Arial, "Segoe UI", "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif'

export function wrapCanvasText(context, text, width) {
  const lines = []
  let line = ''
  for (const char of String(text)) {
    if (line && context.measureText(line + char).width > width) {
      lines.push(line)
      line = char.trim() ? char : ''
    } else {
      line += char
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

export function annotationListPages(entries, { title = 'Annotations', notice = '', width = 1400, maxHeight = 1900 } = {}) {
  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) throw new Error('Unable to render the annotation list')
  measure.font = `22px ${EXPORT_TEXT_FONT}`
  const lines = entries.flatMap(entry => wrapCanvasText(measure, entry, width - 120).map((line, i) => ({ line, indent: i > 0 })))
  const lineHeight = 32
  const perPage = Math.max(1, Math.floor((maxHeight - 170) / lineHeight))
  const pages = []
  for (let start = 0; start < lines.length; start += perPage) {
    const pageLines = lines.slice(start, start + perPage)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = 150 + pageLines.length * lineHeight + 60
    const context = canvas.getContext('2d', { alpha: false })
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#182230'
    context.font = `bold 30px ${EXPORT_TEXT_FONT}`
    context.fillText(title, 60, 70)
    context.font = `22px ${EXPORT_TEXT_FONT}`
    pageLines.forEach(({ line, indent }, index) => context.fillText(line, indent ? 90 : 60, 130 + index * lineHeight))
    context.font = `17px ${EXPORT_TEXT_FONT}`
    context.fillStyle = '#9c3030'
    if (notice) context.fillText(notice, 60, canvas.height - 28)
    pages.push(canvas)
  }
  return pages
}
