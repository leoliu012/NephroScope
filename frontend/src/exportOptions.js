export const DEFAULT_EXPORT_FORMAT = 'pdf'

export const EXPORT_FORMAT_OPTIONS = Object.freeze([
  Object.freeze({ id: 'pdf', label: 'PDF', extension: 'pdf', mimeType: 'application/pdf' }),
  Object.freeze({ id: 'png', label: 'PNG', extension: 'png', mimeType: 'image/png' }),
  Object.freeze({ id: 'jpeg', label: 'JPEG', extension: 'jpeg', mimeType: 'image/jpeg' }),
])

export function exportFormatOption(value) {
  return EXPORT_FORMAT_OPTIONS.find(option => option.id === value)
    || EXPORT_FORMAT_OPTIONS.find(option => option.id === DEFAULT_EXPORT_FORMAT)
}

export function exportFilename(sourceFilename, format, includeAnnotations = true) {
  const leaf = String(sourceFilename || '').split(/[\\/]/).pop() || 'image'
  const base = leaf.replace(/\.[^.]+$/, '').trim() || 'image'
  const option = exportFormatOption(format)
  return `${base}${includeAnnotations ? '_annotated' : ''}.${option.extension}`
}
