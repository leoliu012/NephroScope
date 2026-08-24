import { authFetch } from './auth.js'

export const DEFAULT_MODEL_OVERLAY_SETTINGS = Object.freeze({
  visible: true,
  color: '#00d4ff',
  opacity: 0.5,
  displayMode: 'filled',
})

export const DEFAULT_MODEL_SKELETON_SETTINGS = Object.freeze({
  visible: true,
  color: '#ffd166',
  thickness: 2,
})

const MODEL_OVERLAY_STORAGE_KEY = 'agh-viewer:model-overlay-settings:v1'
const MODEL_SKELETON_STORAGE_KEY = 'agh-viewer:model-skeleton-settings:v1'
const HEX_COLOR = /^#[0-9a-f]{6}$/i
const TERMINAL_RUN_STATUSES = new Set(['SUCCEEDED', 'FAILED'])

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function errorMessage(body, response) {
  if (typeof body?.error === 'string' && body.error.trim()) return body.error
  if (typeof body?.message === 'string' && body.message.trim()) return body.message
  return `Request failed with ${response.status}`
}

async function fetchJson(url, options = {}) {
  const response = await authFetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(errorMessage(body, response))
    error.status = response.status
    throw error
  }
  return body
}

export function normalizeModelOverlaySettings(raw) {
  const opacity = finiteNumber(raw?.opacity, DEFAULT_MODEL_OVERLAY_SETTINGS.opacity)
  return {
    visible: typeof raw?.visible === 'boolean' ? raw.visible : DEFAULT_MODEL_OVERLAY_SETTINGS.visible,
    color: HEX_COLOR.test(raw?.color || '') ? raw.color.toLowerCase() : DEFAULT_MODEL_OVERLAY_SETTINGS.color,
    opacity: clamp(opacity, 0, 1),
    displayMode: raw?.displayMode === 'contour' ? 'contour' : DEFAULT_MODEL_OVERLAY_SETTINGS.displayMode,
  }
}

export function modelMaskContourAlpha(alpha, width, height) {
  const imageWidth = Number(width)
  const imageHeight = Number(height)
  if (!Number.isInteger(imageWidth) || imageWidth < 1 || !Number.isInteger(imageHeight) || imageHeight < 1) {
    throw new RangeError('Model mask dimensions must be positive integers')
  }
  if (!alpha || Number(alpha.length) !== imageWidth * imageHeight) {
    throw new RangeError('Model mask alpha length does not match its dimensions')
  }

  const source = alpha
  const contour = new Uint8ClampedArray(source.length)
  for (let y = 0; y < imageHeight; y += 1) {
    const row = y * imageWidth
    for (let x = 0; x < imageWidth; x += 1) {
      const index = row + x
      const value = source[index]
      if (!value) continue
      if (
        x === 0
        || y === 0
        || x === imageWidth - 1
        || y === imageHeight - 1
        || !source[index - imageWidth - 1]
        || !source[index - imageWidth]
        || !source[index - imageWidth + 1]
        || !source[index - 1]
        || !source[index + 1]
        || !source[index + imageWidth - 1]
        || !source[index + imageWidth]
        || !source[index + imageWidth + 1]
      ) {
        contour[index] = value
      }
    }
  }
  return contour
}

export function loadModelOverlaySettings() {
  try {
    return normalizeModelOverlaySettings(JSON.parse(localStorage.getItem(MODEL_OVERLAY_STORAGE_KEY) || 'null'))
  } catch {
    return { ...DEFAULT_MODEL_OVERLAY_SETTINGS }
  }
}

export function saveModelOverlaySettings(settings) {
  try {
    localStorage.setItem(MODEL_OVERLAY_STORAGE_KEY, JSON.stringify(normalizeModelOverlaySettings(settings)))
  } catch {
    // Overlay controls remain usable when browser storage is unavailable.
  }
}

export function normalizeModelSkeletonSettings(raw) {
  const thickness = finiteNumber(raw?.thickness, DEFAULT_MODEL_SKELETON_SETTINGS.thickness)
  return {
    visible: typeof raw?.visible === 'boolean' ? raw.visible : DEFAULT_MODEL_SKELETON_SETTINGS.visible,
    color: HEX_COLOR.test(raw?.color || '') ? raw.color.toLowerCase() : DEFAULT_MODEL_SKELETON_SETTINGS.color,
    thickness: Math.round(clamp(thickness, 1, 12)),
  }
}

export function loadModelSkeletonSettings() {
  try {
    return normalizeModelSkeletonSettings(JSON.parse(localStorage.getItem(MODEL_SKELETON_STORAGE_KEY) || 'null'))
  } catch {
    return { ...DEFAULT_MODEL_SKELETON_SETTINGS }
  }
}

export function saveModelSkeletonSettings(settings) {
  try {
    localStorage.setItem(MODEL_SKELETON_STORAGE_KEY, JSON.stringify(normalizeModelSkeletonSettings(settings)))
  } catch {
    // Skeleton controls remain usable when browser storage is unavailable.
  }
}

export function normalizeRunStatus(value) {
  const status = String(value || '').trim().toUpperCase()
  if (status === 'QUEUED' || status === 'RUNNING' || status === 'SUCCEEDED' || status === 'FAILED') return status
  return status || 'QUEUED'
}

export function isTerminalRunStatus(value) {
  return TERMINAL_RUN_STATUSES.has(normalizeRunStatus(value))
}

export async function createModelRun(imageApiBase, { zIndex, channelIndex }, options = {}) {
  return fetchJson(`${imageApiBase}/analysis-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      zIndex: Math.max(0, Math.round(Number(zIndex) || 0)),
      channelIndex: Math.max(0, Math.round(Number(channelIndex) || 0)),
    }),
    signal: options.signal,
  })
}

export async function fetchModelRun(runId, options = {}) {
  return fetchJson(`/agh/api/analysis-runs/${encodeURIComponent(runId)}`, {
    signal: options.signal,
  })
}

export async function fetchLatestModelRuns(imageApiBase, options = {}) {
  return fetchJson(`${imageApiBase}/analysis-runs?latestPerZ=true`, {
    signal: options.signal,
  })
}

export async function deleteModelRunsForSlice(imageApiBase, zIndex, options = {}) {
  const normalizedZ = Math.max(0, Math.round(Number(zIndex) || 0))
  return fetchJson(`${imageApiBase}/analysis-runs?zIndex=${normalizedZ}`, {
    method: 'DELETE',
    signal: options.signal,
  })
}

export function indexModelRunsByZ(runs, imageKey) {
  const indexed = {}
  for (const run of Array.isArray(runs) ? runs : []) {
    const zIndex = Number(run?.request?.zIndex ?? run?.result?.zIndex)
    if (!Number.isInteger(zIndex) || zIndex < 0 || !run?.runId) continue
    const status = normalizeRunStatus(run.status)
    indexed[String(zIndex)] = {
      ...run,
      status,
      requestedZIndex: zIndex,
      channelIndex: Number(run?.request?.channelIndex) || 0,
      imageKey,
      maskStatus: status === 'SUCCEEDED' ? 'loading' : null,
      skeletonStatus: status === 'SUCCEEDED' ? 'loading' : null,
      error: status === 'FAILED'
        ? String(run?.error?.message || run?.error || 'Model run failed')
        : '',
      pollError: '',
    }
  }
  return indexed
}

export function modelMaskUrl(runId) {
  return `/agh/api/analysis-runs/${encodeURIComponent(runId)}/mask`
}

export function modelSkeletonUrl(runId) {
  return `/agh/api/analysis-runs/${encodeURIComponent(runId)}/skeleton`
}

export async function measureGbmThickness(runId, { roi, calibration }, options = {}) {
  return fetchJson(`/agh/api/analysis-runs/${encodeURIComponent(runId)}/measurements/gbm-thickness`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roi, calibration }),
    signal: options.signal,
  })
}

function samePoint(left, right) {
  return left && right && Math.abs(left[0] - right[0]) < 1e-6 && Math.abs(left[1] - right[1]) < 1e-6
}

export function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    sum += (Number(current?.[0]) || 0) * (Number(next?.[1]) || 0)
    sum -= (Number(next?.[0]) || 0) * (Number(current?.[1]) || 0)
  }
  return Math.abs(sum) / 2
}

export function normalizePolygonRoi(points, width, height, maxPoints = 1000) {
  const imageWidth = Math.max(1, finiteNumber(width, 1))
  const imageHeight = Math.max(1, finiteNumber(height, 1))
  const cleaned = []
  for (const point of points || []) {
    if (!Array.isArray(point) || point.length < 2) continue
    const x = finiteNumber(point[0])
    const y = finiteNumber(point[1])
    if (x === null || y === null) continue
    const next = [clamp(x, 0, imageWidth), clamp(y, 0, imageHeight)]
    if (!samePoint(cleaned[cleaned.length - 1], next)) cleaned.push(next)
  }
  if (cleaned.length > 1 && samePoint(cleaned[0], cleaned[cleaned.length - 1])) cleaned.pop()
  if (cleaned.length < 3) return null

  const limit = Math.max(3, Math.round(Number(maxPoints) || 1000))
  const sampled = cleaned.length <= limit
    ? cleaned
    : Array.from({ length: limit }, (_, index) => cleaned[Math.floor((index / limit) * cleaned.length)])
  if (polygonArea(sampled) < 1) return null
  return { type: 'polygon', points: sampled }
}

export function calibrationPayload(meta = {}) {
  const pixelSizeXUm = finiteNumber(meta?.pixelSizeXUm ?? meta?.pixelSizeUm)
  const pixelSizeYUm = finiteNumber(meta?.pixelSizeYUm ?? meta?.pixelSizeUm, pixelSizeXUm)
  return {
    pixelSizeXUm,
    pixelSizeYUm,
    expansionEnabled: Boolean(meta?.expansionEnabled),
    expansionFactor: finiteNumber(meta?.expansionFactor, 1),
  }
}

export function stableModelJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableModelJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableModelJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function thicknessMeasurement(result) {
  const source = result?.result && typeof result.result === 'object' ? result.result : result
  const candidates = [
    ['meanThickness', source?.unit],
    ['averageThickness', source?.unit],
    ['meanThicknessNm', 'nm'],
    ['averageThicknessNm', 'nm'],
    ['meanThicknessUm', 'µm'],
    ['averageThicknessUm', 'µm'],
  ]
  for (const [field, defaultUnit] of candidates) {
    const value = finiteNumber(source?.[field])
    if (value !== null) return { value, unit: String(defaultUnit || '').trim() || 'µm', field }
  }
  return null
}

function resultNumber(source, fields) {
  for (const field of fields) {
    const value = finiteNumber(source?.[field])
    if (value !== null) return value
  }
  return null
}

export function dynamicThicknessMeasurements(result, calibration = {}) {
  const source = result?.result && typeof result.result === 'object' ? result.result : result
  if (!source || typeof source !== 'object') return null
  const current = calibrationPayload(calibration)
  const pixelSizeX = finiteNumber(current.pixelSizeXUm)
  const pixelSizeY = finiteNumber(current.pixelSizeYUm, pixelSizeX)
  if (!(pixelSizeX > 0) || !(pixelSizeY > 0)) return null

  const meanPixels = resultNumber(source, ['meanThicknessPixels', 'mean_thickness_pixels'])
  let observedUm = null
  // Viewer measurement settings are isotropic. This pixel-domain value makes
  // an already measured ROI respond immediately to pixel-size edits without
  // recomputing its saved centerline geometry.
  if (meanPixels !== null && Math.abs(pixelSizeX - pixelSizeY) < 1e-12) {
    observedUm = meanPixels * pixelSizeX
  }
  if (observedUm === null) {
    observedUm = resultNumber(source, [
      'observedMeanThicknessUm',
      'observed_mean_um',
    ])
  }
  if (observedUm === null) {
    const correctedUm = resultNumber(source, [
      'efAdjustedMeanThicknessUm',
      'corrected_mean_um',
      'meanThicknessUm',
      'meanThickness',
    ])
    const sourceCalibration = source.calibration || result?.calibration || {}
    const sourceFactor = sourceCalibration.expansionEnabled
      ? finiteNumber(sourceCalibration.expansionFactor, 1)
      : 1
    if (correctedUm !== null) observedUm = correctedUm * Math.max(1e-12, sourceFactor || 1)
  }
  if (observedUm === null) return null

  const expansionEnabled = Boolean(current.expansionEnabled)
  const expansionFactor = expansionEnabled
    ? Math.max(1e-12, finiteNumber(current.expansionFactor, 1) || 1)
    : 1
  const adjustedUm = observedUm / expansionFactor
  return {
    before: { value: observedUm, unit: 'µm' },
    after: expansionEnabled
      ? { value: adjustedUm * 1000, unit: 'nm' }
      : { value: adjustedUm, unit: 'µm' },
    observedUm,
    adjustedUm,
    expansionEnabled,
    expansionFactor,
  }
}

export function formatThicknessValue(measurement) {
  const value = finiteNumber(measurement?.value)
  if (value === null) return '—'
  const absolute = Math.abs(value)
  const digits = absolute >= 100 ? 1 : absolute >= 10 ? 2 : 3
  return `${value.toFixed(digits)} ${String(measurement?.unit || 'µm')}`
}

export function formatThicknessMeasurement(result) {
  const measurement = thicknessMeasurement(result)
  if (!measurement) return '—'
  const absolute = Math.abs(measurement.value)
  const digits = absolute >= 100 ? 1 : absolute >= 10 ? 2 : 3
  return `${measurement.value.toFixed(digits)} ${measurement.unit}`
}
