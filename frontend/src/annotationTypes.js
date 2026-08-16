export const ALLOWED_ANNOTATION_TYPES = new Set(['point', 'line', 'measure', 'arrow', 'rect', 'ellipse', 'freehand', 'text'])

const TYPE_ALIASES = {
  box: 'rect',
  brush: 'freehand',
  caliper: 'measure',
  caliper_line: 'measure',
  caliper_measure: 'measure',
  caliper_measurement: 'measure',
  caliper_tool: 'measure',
  calipers: 'measure',
  calibrated_measure: 'measure',
  calibrated_measurement: 'measure',
  calibrated_measurement_line: 'measure',
  calibrated_ruler: 'measure',
  circle: 'point',
  distance: 'measure',
  distance_line: 'measure',
  distance_measure: 'measure',
  distance_measurement: 'measure',
  distance_measurement_line: 'measure',
  distance_ruler: 'measure',
  distance_tool: 'measure',
  dot: 'point',
  draw: 'freehand',
  free_hand: 'freehand',
  label: 'text',
  length: 'measure',
  length_indicator: 'measure',
  length_line: 'measure',
  length_marker: 'measure',
  length_measure: 'measure',
  length_measurement: 'measure',
  length_ruler: 'measure',
  length_tool: 'measure',
  line_measurement: 'measure',
  line_measurement_tool: 'measure',
  linear_measure: 'measure',
  linear_measurement: 'measure',
  marker: 'point',
  measure_annotation: 'measure',
  measure_line: 'measure',
  measure_object: 'measure',
  measure_shape: 'measure',
  measure_tool: 'measure',
  rectangle: 'rect',
  measurement: 'measure',
  measurement_annotation: 'measure',
  measurement_line: 'measure',
  measurement_object: 'measure',
  measurement_shape: 'measure',
  measurement_tool: 'measure',
  measurements: 'measure',
  measurements_line: 'measure',
  note: 'text',
  oval: 'ellipse',
  path: 'freehand',
  pen: 'freehand',
  polygon: 'freehand',
  polyline: 'freehand',
  ruler: 'measure',
  ruler_line: 'measure',
  ruler_measure: 'measure',
  ruler_measurement: 'measure',
  ruler_measurement_tool: 'measure',
  ruler_tool: 'measure',
  scale_bar: 'measure',
  scalebar: 'measure',
  scribble: 'freehand',
  square: 'rect',
}

const TYPE_FIELDS = [
  'type',
  'annotationType',
  'annotation_type',
  'kind',
  'tool',
  'toolType',
  'tool_type',
  'toolId',
  'tool_id',
  'toolKey',
  'tool_key',
  'toolName',
  'tool_name',
  'shape',
  'shapeType',
  'shape_type',
  'mode',
  'name',
  'class',
  'className',
  'class_name',
  'category',
  'objectType',
  'object_type',
  'subtype',
  'subType',
  'sub_type',
  'measurementType',
  'measurement_type',
]

const TYPE_VALUE_FIELDS = [
  ...TYPE_FIELDS,
  'id',
  'value',
  'label',
  'key',
  'code',
  'title',
  'displayName',
  'display_name',
]

const TYPE_CONTAINER_FIELDS = [
  'metadata',
  'meta',
  'properties',
  'props',
  'attributes',
  'attrs',
  'classification',
  'classifications',
  'data',
  'details',
  'extra',
  'extras',
  'toolData',
  'tool_data',
]

const MEASUREMENT_HINT_FIELDS = new Set([
  'calibration',
  'distance',
  'distance_px',
  'distance_um',
  'is_measurement',
  'label_dx',
  'label_dy',
  'length',
  'length_px',
  'length_um',
  'measure',
  'measurement',
  'microns',
  'micrometers',
  'pixel_size',
  'pixel_size_um',
  'pixel_size_x_um',
  'pixel_size_y_um',
  'ruler',
  'unit_um',
])

function normalizeKey(value) {
  return String(value ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

function keyLooksLikeMeasurementType(key) {
  const tokens = new Set(key.split('_').filter(Boolean))
  if (!tokens.size) return false
  if (['measurement', 'measurements', 'ruler', 'caliper', 'calipers'].some(token => tokens.has(token))) return true
  if (tokens.has('measure')) return true
  if (['distance', 'length'].some(token => tokens.has(token)) && ['annotation', 'line', 'object', 'shape', 'tool'].some(token => tokens.has(token))) return true
  if (tokens.has('linear') && ['annotation', 'line', 'measure', 'measurement', 'tool'].some(token => tokens.has(token))) return true
  if (tokens.has('scale') && ['bar', 'line', 'tool'].some(token => tokens.has(token))) return true
  return false
}

function keyLooksLikeMeasurementHint(key) {
  const tokens = new Set(key.split('_').filter(Boolean))
  if (!tokens.size) return false
  if (['measurement', 'measurements', 'ruler', 'caliper', 'calipers'].some(token => tokens.has(token))) return true
  if (tokens.has('measure')) return true
  if (['distance', 'length'].some(token => tokens.has(token))) return true
  if (tokens.has('pixel') && ['size', 'spacing', 'micron', 'microns', 'um'].some(token => tokens.has(token))) return true
  return false
}

function normalizeTypeValue(value) {
  if (typeof value !== 'string') return null
  const key = normalizeKey(value)
  if (!key) return null
  if (TYPE_ALIASES[key]) return TYPE_ALIASES[key]
  if (keyLooksLikeMeasurementType(key)) return 'measure'
  return key
}

function nestedTypeValues(value) {
  if (Array.isArray(value)) return value.flatMap(nestedTypeValues)
  if (value && typeof value === 'object') {
    return [...TYPE_VALUE_FIELDS, ...TYPE_CONTAINER_FIELDS].flatMap(field => (
      Object.prototype.hasOwnProperty.call(value, field) ? nestedTypeValues(value[field]) : []
    ))
  }
  return [value]
}

function annotationTypeValues(annotation) {
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) return nestedTypeValues(annotation)
  return [
    ...TYPE_FIELDS.flatMap(field => (
      Object.prototype.hasOwnProperty.call(annotation, field) ? nestedTypeValues(annotation[field]) : []
    )),
    ...TYPE_CONTAINER_FIELDS.flatMap(field => (
      Object.prototype.hasOwnProperty.call(annotation, field) ? nestedTypeValues(annotation[field]) : []
    )),
  ]
}

function hasMeasurementHint(value) {
  if (Array.isArray(value)) return value.some(hasMeasurementHint)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, nested]) => {
    const normalizedKey = normalizeKey(key)
    return MEASUREMENT_HINT_FIELDS.has(normalizedKey)
      || keyLooksLikeMeasurementHint(normalizedKey)
      || ((nested && typeof nested === 'object') ? hasMeasurementHint(nested) : false)
  })
}

function looksLikeMeasurement(annotation) {
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) return false
  const coords = Array.isArray(annotation.coords) ? annotation.coords : []
  if (coords.length !== 4) return false
  if (!coords.every(coord => Number.isFinite(Number(coord)))) return false
  return hasMeasurementHint(annotation)
}

function normalizeMeasurementAnnotation(annotation) {
  const normalized = { ...annotation }
  if (normalized.pixelSizeUm != null) {
    if (normalized.pixelSizeXUm == null) normalized.pixelSizeXUm = normalized.pixelSizeUm
    if (normalized.pixelSizeYUm == null) normalized.pixelSizeYUm = normalized.pixelSizeUm
  }
  return normalized
}

export function normalizedAnnotationType(annotationOrType) {
  let firstNormalized = null
  for (const value of annotationTypeValues(annotationOrType)) {
    const normalized = normalizeTypeValue(value)
    if (firstNormalized === null) firstNormalized = normalized
    if (ALLOWED_ANNOTATION_TYPES.has(normalized)) return normalized
  }
  if (looksLikeMeasurement(annotationOrType)) return 'measure'
  return firstNormalized || ''
}

export function normalizePointGeometry(annotation) {
  const coords = Array.isArray(annotation.coords) ? annotation.coords : []
  const radius = Number(annotation.radius)
  if (Number.isFinite(radius) && radius > 0) return annotation
  if (coords.length >= 4) {
    const [x1, y1, x2, y2] = coords
    return {
      ...annotation,
      coords: [(x1 + x2) / 2, (y1 + y2) / 2],
      radius: Math.max(1, Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) / 2),
    }
  }
  if (coords.length >= 3 && Number.isFinite(Number(coords[2])) && Number(coords[2]) > 0) {
    return { ...annotation, coords: [coords[0], coords[1]], radius: Number(coords[2]) }
  }
  return annotation
}

export function normalizeAnnotationForStorage(annotation) {
  const normalized = { ...annotation, type: normalizedAnnotationType(annotation) }
  if (normalized.type === 'point') return normalizePointGeometry(normalized)
  if (normalized.type === 'measure') return normalizeMeasurementAnnotation(normalized)
  return normalized
}
