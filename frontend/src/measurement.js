export const DEFAULT_PIXEL_SIZE_UM = 0.106872
export const DEFAULT_EXPANSION_FACTOR = 7.1

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function formatNumber(value, digits = 6) {
  return Number(value).toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')
}

export function pixelCalibration(meta = {}) {
  meta = meta || {}
  const fallback = DEFAULT_PIXEL_SIZE_UM
  const x = positiveNumber(meta.pixelSizeXUm ?? meta.pixelSizeUm, fallback)
  const y = positiveNumber(meta.pixelSizeYUm ?? meta.pixelSizeUm, x)
  return {
    x,
    y,
    source: meta.pixelSizeSource || 'default',
    isDefault: Boolean(meta.pixelSizeIsDefault ?? (!meta.pixelSizeXUm && !meta.pixelSizeYUm && !meta.pixelSizeUm)),
  }
}

export function measurementCalibration(annotation = {}, meta = {}) {
  annotation = annotation || {}
  const image = pixelCalibration(meta)
  if (meta?.pixelSizeIsUserOverride) {
    return {
      x: image.x,
      y: image.y,
    }
  }
  const fallback = positiveNumber(annotation.pixelSizeUm, image.x)
  return {
    x: positiveNumber(annotation.pixelSizeXUm, fallback),
    y: positiveNumber(annotation.pixelSizeYUm, fallback),
  }
}

export function measurementLengthUm(coords, annotation = {}, meta = {}) {
  if (!Array.isArray(coords) || coords.length < 4) return 0
  const [x1, y1, x2, y2] = coords.map(Number)
  if (![x1, y1, x2, y2].every(Number.isFinite)) return 0
  const calibration = measurementCalibration(annotation, meta)
  return Math.hypot((x2 - x1) * calibration.x, (y2 - y1) * calibration.y)
}

export function formatMicrometers(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  if (number >= 100) return `${number.toFixed(1)} µm`
  if (number >= 10) return `${number.toFixed(2)} µm`
  return `${number.toFixed(3)} µm`
}

export function formatNanometers(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  if (number >= 1000) return `${number.toFixed(0)} nm`
  if (number >= 100) return `${number.toFixed(1)} nm`
  if (number >= 10) return `${number.toFixed(2)} nm`
  return `${number.toFixed(3)} nm`
}

export function measurementDisplayLength(coords, annotation = {}, meta = {}) {
  const lengthUm = measurementLengthUm(coords, annotation, meta)
  if (meta?.expansionEnabled) {
    const factor = positiveNumber(meta.expansionFactor, DEFAULT_EXPANSION_FACTOR)
    return {
      value: (lengthUm * 1000) / factor,
      unit: 'nm',
      expansionFactor: factor,
    }
  }
  return {
    value: lengthUm,
    unit: 'µm',
    expansionFactor: null,
  }
}

export function formatMeasurement(coords, annotation = {}, meta = {}) {
  const measurement = measurementDisplayLength(coords, annotation, meta)
  return measurement.unit === 'nm'
    ? formatNanometers(measurement.value)
    : formatMicrometers(measurement.value)
}

export function applyMeasurementSettings(meta = {}, settings = {}) {
  if (!meta) return meta
  const calibration = pixelCalibration(meta)
  const pixelSizeUm = positiveNumber(settings?.pixelSizeUm, calibration.x)
  const expansionFactor = positiveNumber(settings?.expansionFactor, DEFAULT_EXPANSION_FACTOR)
  const expansionEnabled = settings?.expansionEnabled !== false

  return {
    ...meta,
    pixelSizeUm,
    pixelSizeXUm: pixelSizeUm,
    pixelSizeYUm: pixelSizeUm,
    pixelSizeSource: 'viewer settings',
    pixelSizeIsDefault: false,
    pixelSizeIsUserOverride: true,
    expansionEnabled,
    expansionFactor,
  }
}

export function formatPixelSize(meta = {}) {
  const calibration = pixelCalibration(meta)
  const size = Math.abs(calibration.x - calibration.y) < 1e-12
    ? `${formatNumber(calibration.x)} µm/px`
    : `${formatNumber(calibration.x)} × ${formatNumber(calibration.y)} µm/px`
  return `${size} (${calibration.isDefault ? 'default' : calibration.source})`
}

export function formatPixelSizeInput(meta = {}) {
  return formatNumber(pixelCalibration(meta).x)
}
