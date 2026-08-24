export const DEFAULT_ANNOTATION_STROKE_WIDTH = 6
export const DEFAULT_ARROW_STROKE_WIDTH = 8
export const MIN_ANNOTATION_STROKE_WIDTH = 0.5
export const MAX_ANNOTATION_STROKE_WIDTH = 20

export function defaultAnnotationStrokeWidth(annotationOrType = '') {
  const type = typeof annotationOrType === 'string'
    ? annotationOrType
    : annotationOrType?.type
  return type === 'arrow'
    ? DEFAULT_ARROW_STROKE_WIDTH
    : DEFAULT_ANNOTATION_STROKE_WIDTH
}

export function resolveAnnotationStrokeWidth(value, annotationOrType = '') {
  const fallback = defaultAnnotationStrokeWidth(annotationOrType)
  if (value === null || value === undefined || value === '') return fallback
  const width = Number(value)
  if (!Number.isFinite(width)) return fallback
  return Math.max(MIN_ANNOTATION_STROKE_WIDTH, Math.min(MAX_ANNOTATION_STROKE_WIDTH, width))
}
