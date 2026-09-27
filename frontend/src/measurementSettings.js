import { DEFAULT_EXPANSION_FACTOR, formatPixelSizeInput } from './measurement.js'

const PREFIX = 'agh-viewer:measurement-settings:v1:'
const LOCAL_DEV_EXPANSION_CASES = new Set(['4', '5', '9'])

function storageKey(caseId, filename) {
  return `${PREFIX}${encodeURIComponent(caseId)}/${encodeURIComponent(filename)}`
}

function positiveInput(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? String(value) : fallback
}

export function defaultMeasurementSettings(meta, caseId) {
  const match = String(caseId || '').match(/(?:^|\D)([459])(?:\D|$)/)
  const factor = match && LOCAL_DEV_EXPANSION_CASES.has(match[1]) ? 7.23 : DEFAULT_EXPANSION_FACTOR
  const pixelSize = Number(meta?.pixelSizeXUm ?? meta?.pixelSizeUm)
  const unexpanded = Number.isFinite(pixelSize) && pixelSize > 0
    && !meta?.pixelSizeIsUserOverride && meta?.pixelSizeIsDefault === false
    && Math.abs(pixelSize - 0.015) <= 0.001
  return {
    pixelSizeUm: formatPixelSizeInput(meta),
    expansionEnabled: !unexpanded,
    expansionFactor: String(factor),
  }
}

export function normalizeMeasurementSettings(raw, meta, caseId) {
  const fallback = defaultMeasurementSettings(meta, caseId)
  return {
    pixelSizeUm: positiveInput(raw?.pixelSizeUm, fallback.pixelSizeUm),
    expansionEnabled: typeof raw?.expansionEnabled === 'boolean' ? raw.expansionEnabled : fallback.expansionEnabled,
    expansionFactor: positiveInput(raw?.expansionFactor, fallback.expansionFactor),
  }
}

export function loadMeasurementSettings(caseId, filename, meta) {
  try {
    return normalizeMeasurementSettings(JSON.parse(localStorage.getItem(storageKey(caseId, filename)) || 'null'), meta, caseId)
  } catch {
    return defaultMeasurementSettings(meta, caseId)
  }
}

export function saveMeasurementSettings(caseId, filename, settings) {
  try {
    localStorage.setItem(storageKey(caseId, filename), JSON.stringify(settings))
  } catch {
    // Measurement controls remain usable even when storage is unavailable.
  }
}
