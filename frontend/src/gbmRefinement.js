// Which GBM predictions count: settings, requests and overlay rasters.
//
// The saved model prediction never changes. The server derives what counts from
// the prediction, a Z stack analysis and people's corrections, and these are the
// browser's side of that.
import { authFetch } from './auth.js'
import { stableModelJson } from './modelAnalysis.js'

const SETTINGS_KEY = 'agh-viewer:gbm-filter:v1'
const Z_STEP_KEY = 'agh-viewer:gbm-z-step:v1'
const MAX_WINDOW = 200

export const DEFAULT_FILTER_SETTINGS = Object.freeze({
  crossSection: true,
  tiltAuto: true,
  maxTiltDeg: 25,
  windowAuto: true,
  window: 30,
  thicknessLimits: true,
  minNm: 30,
  maxNm: 3400,
  showExcluded: true,
  brushRadius: 12,
})

// Reason codes come from the server; these say what each means to a person.
export const REASON_INFO = Object.freeze({
  kept: { label: 'Kept', hint: 'Measured', color: '#22c55e' },
  oblique: { label: 'Oblique', hint: 'Tilted past the limit at this slice, so it looks wider than it is', color: '#ef4444' },
  'en-face': { label: 'En-face', hint: 'Lies nearly flat in the image', color: '#a855f7' },
  transient: { label: 'Brief in Z', hint: 'Does not persist beyond the Z projection', color: '#f9a8d4' },
  speck: { label: 'Speck', hint: 'Too little sheet area across the stack', color: '#ec4899' },
  compact: { label: 'Compact', hint: 'A blob rather than a line', color: '#c084fc' },
  artifact: { label: 'Skeleton artifact', hint: 'A taper, spur or junction of the centerline', color: '#94a3b8' },
  'wide-patch': { label: 'Wide patch', hint: 'Far wider than typical GBM, with nothing showing it is vertical', color: '#f97316' },
  'too-thin': { label: 'Below minimum', hint: 'Thinner than the lower limit', color: '#84cc16' },
  'too-thick': { label: 'Above maximum', hint: 'Thicker than the upper limit', color: '#10b981' },
  manual: { label: 'Removed by you', hint: 'Excluded by a correction', color: '#ff00ff' },
})

const ANALYSIS_ACTIVE = new Set(['waiting', 'queued', 'running'])

function finite(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

export function normalizeFilterSettings(raw) {
  const base = DEFAULT_FILTER_SETTINGS
  const value = raw && typeof raw === 'object' ? raw : {}
  const minNm = clamp(finite(value.minNm, base.minNm), 0, 100000)
  const maxNm = clamp(finite(value.maxNm, base.maxNm), 0, 1000000)
  const valid = minNm < maxNm
  return {
    crossSection: value.crossSection !== false,
    tiltAuto: value.tiltAuto !== false,
    maxTiltDeg: clamp(Math.round(finite(value.maxTiltDeg, base.maxTiltDeg)), 1, 89),
    windowAuto: value.windowAuto !== false,
    window: clamp(Math.round(finite(value.window, base.window)), 1, MAX_WINDOW),
    thicknessLimits: value.thicknessLimits !== false,
    minNm: valid ? minNm : base.minNm,
    maxNm: valid ? maxNm : base.maxNm,
    showExcluded: value.showExcluded !== false,
    brushRadius: clamp(Math.round(finite(value.brushRadius, base.brushRadius)), 1, 200),
  }
}

export function loadFilterSettings() {
  try {
    return normalizeFilterSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'))
  } catch {
    return normalizeFilterSettings(null)
  }
}

export function saveFilterSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* optional */ }
}

// A Z step someone entered belongs to one image's acquisition, not to all of them.
function zStepStore() {
  try {
    const stored = JSON.parse(localStorage.getItem(Z_STEP_KEY) || '{}')
    return stored && typeof stored === 'object' ? stored : {}
  } catch {
    return {}
  }
}

const zStepId = (caseId, filename) => JSON.stringify([caseId, filename])

export function loadZStepOverride(caseId, filename) {
  const value = Number(zStepStore()[zStepId(caseId, filename)])
  return Number.isFinite(value) && value > 0 ? value : null
}

export function saveZStepOverride(caseId, filename, value) {
  const stored = zStepStore()
  const id = zStepId(caseId, filename)
  if (Number.isFinite(value) && value > 0) stored[id] = value
  else delete stored[id]
  try { localStorage.setItem(Z_STEP_KEY, JSON.stringify(stored)) } catch { /* optional */ }
}

export function filterPayload(settings, zStepUm = null) {
  const value = normalizeFilterSettings(settings)
  return {
    crossSection: value.crossSection,
    thicknessLimits: value.thicknessLimits,
    minNm: value.minNm,
    maxNm: value.maxNm,
    window: value.windowAuto ? DEFAULT_FILTER_SETTINGS.window : value.window,
    ...(value.tiltAuto ? {} : { maxTiltDeg: value.maxTiltDeg }),
    ...(zStepUm ? { zStepUm } : {}),
  }
}

export function filterKey(payload) {
  return stableModelJson(payload || null)
}

// What a measurement used, in one sentence for plots and exports.
export function filterLabel(settings) {
  const value = normalizeFilterSettings(settings)
  const parts = []
  if (value.crossSection) {
    parts.push(`Cross-sections only (tilt ${value.tiltAuto ? 'limit auto' : `≤ ${value.maxTiltDeg}°`}, Z window ${value.windowAuto ? 'auto up to ±30' : `±${value.window}`})`)
  }
  if (value.thicknessLimits) parts.push(`thickness ${value.minNm}–${value.maxNm} nm`)
  return parts.length ? parts.join(' · ') : 'All model predictions'
}

// Which settings change results, as opposed to how they are displayed. Changing
// only these starts a recalculation.
export function recalculationMessage({ stack, fetching, remeasuring }) {
  if (stack?.state === 'running') {
    const percent = Math.round(stack.job?.progress?.percent || 0)
    return `Recalculating across Z${percent ? ` · ${percent}%` : ''}…`
  }
  if (stack?.state === 'queued') return 'Recalculating across Z: queued…'
  if (stack?.state === 'waiting') return 'Recalculating across Z once segmentation finishes…'
  if (fetching) return 'Recalculating with the new settings…'
  if (remeasuring) return 'Recalculating thickness…'
  return ''
}

export function filterIsActive(settings) {
  const value = normalizeFilterSettings(settings)
  return value.crossSection || value.thicknessLimits
}

// A measurement still waiting for the Z analysis; failed analyses never resolve.
export function filterIsWaiting(info) {
  return Boolean(info?.pending) && (ANALYSIS_ACTIVE.has(info.state) || info.state === 'none')
}

export function analysisIsActive(stack) {
  return ANALYSIS_ACTIVE.has(stack?.state)
}

// Totals over several measurements, for status lines and reports.
export function filterTotals(distributions) {
  const totals = { kept: 0, total: 0, measured: 0, pending: 0, failed: 0, stale: 0, singlePlane: 0, noZStep: 0, byReason: {} }
  for (const distribution of distributions) {
    const info = distribution?.filter
    if (!info) continue
    totals.measured++
    totals.kept += info.keptSamples || 0
    totals.total += info.totalSamples || 0
    if (info.pending) {
      if (info.state === 'failed') totals.failed++
      else totals.pending++
    }
    if (info.stale) totals.stale++
    if (info.applied && info.hasNeighbours === false && info.crossSection) totals.singlePlane++
    if (info.applied && info.hasNeighbours && info.crossSection && !info.zStep?.um) totals.noZStep++
    for (const [reason, count] of Object.entries(info.byReason || {})) {
      totals.byReason[reason] = (totals.byReason[reason] || 0) + count
    }
  }
  return totals
}

export function reportFilterLine(settings, distributions) {
  const totals = filterTotals(distributions)
  const parts = [`Filter: ${filterLabel(settings)}`]
  if (totals.total) parts.push(`${totals.kept.toLocaleString()} of ${totals.total.toLocaleString()} centerline points kept`)
  if (totals.pending) parts.push(`CROSS-SECTION ANALYSIS PENDING FOR ${totals.pending} Z`)
  if (totals.failed) parts.push(`CROSS-SECTION ANALYSIS FAILED FOR ${totals.failed} Z`)
  if (totals.singlePlane) parts.push(`${totals.singlePlane} Z without neighbours used shape rules only`)
  if (totals.noZStep) parts.push(`${totals.noZStep} Z with no recorded Z step excluded by measured smear instead of angle`)
  return parts.join(' · ')
}

// ---- Overlay rasters --------------------------------------------------------

// Label image: piece id + 1 in R + 256 G; B is 255 on measured centerline and
// 128 on skeleton artifacts.
export function decodeLabel(rgba, width, height) {
  const count = width * height
  const pieces = new Uint16Array(count)
  const center = new Uint8Array(count)
  for (let index = 0, source = 0; index < count; index += 1, source += 4) {
    pieces[index] = rgba[source] + 256 * rgba[source + 1]
    center[index] = rgba[source + 2]
  }
  return { pieces, center, width, height }
}

export function keptPieceTable(reasons, reasonNames) {
  const kept = new Uint8Array((reasons?.length || 0) + 1)
  ;(reasons || []).forEach((code, index) => {
    kept[index + 1] = reasonNames?.[String(code)] === 'kept' ? 1 : 0
  })
  return kept
}

function hexColor(value) {
  const number = Number.parseInt(String(value).slice(1), 16)
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
}

// One colour per piece for what was left out; 0 means the piece is kept.
export function excludedColorTable(reasons, reasonNames) {
  const table = new Uint8Array(((reasons?.length || 0) + 1) * 3)
  ;(reasons || []).forEach((code, index) => {
    const name = reasonNames?.[String(code)]
    if (name === 'kept') return
    const color = hexColor((REASON_INFO[name] || REASON_INFO.artifact).color)
    table.set(color, (index + 1) * 3)
  })
  return table
}

// Rasters of what is measured and what was left out. Excluded GBM is drawn filled
// and its centerline solid, each in the colour of its reason, so it reads at a glance.
export function refinedLayers(label, keptTable, colorTable) {
  const { pieces, center, width, height } = label
  const count = pieces.length
  const kept = new Uint8ClampedArray(count)
  const skeleton = new Uint8ClampedArray(count)
  const fill = new Uint8ClampedArray(count * 4)
  const lines = new Uint8ClampedArray(count * 4)
  const artifact = hexColor(REASON_INFO.artifact.color)
  for (let index = 0; index < count; index += 1) {
    const piece = pieces[index]
    if (!piece) continue
    const target = index * 4
    if (keptTable[piece]) {
      kept[index] = 255
      if (center[index] === 255) skeleton[index] = 255
      else if (center[index]) {
        // Tapers and spurs of kept GBM are not measured either.
        lines[target] = artifact[0]
        lines[target + 1] = artifact[1]
        lines[target + 2] = artifact[2]
        lines[target + 3] = 255
      }
      continue
    }
    const source = piece * 3
    fill[target] = colorTable[source]
    fill[target + 1] = colorTable[source + 1]
    fill[target + 2] = colorTable[source + 2]
    fill[target + 3] = 255
    if (center[index]) {
      lines[target] = colorTable[source]
      lines[target + 1] = colorTable[source + 1]
      lines[target + 2] = colorTable[source + 2]
      lines[target + 3] = 255
    }
  }
  return {
    kept: { alpha: kept, width, height },
    skeleton: { alpha: skeleton, width, height },
    excluded: { fill, lines, width, height },
  }
}

// What is under the pointer, for the correction tools.
export function pieceInfoAt(label, view, x, y) {
  if (!label || !view?.pieces) return null
  const column = Math.floor(x), row = Math.floor(y)
  if (column < 0 || row < 0 || column >= label.width || row >= label.height) return null
  const identity = label.pieces[row * label.width + column]
  if (!identity) return null
  const index = identity - 1
  const name = view.pieces.reasonNames?.[String(view.pieces.reason[index])] || 'kept'
  return { piece: index, reason: name, tiltDeg: view.pieces.tiltDeg[index], widthNm: view.pieces.widthNm[index] }
}

// ---- Requests ---------------------------------------------------------------

async function requestJson(url, options = {}) {
  const response = await authFetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body?.error || `Request failed with ${response.status}`)
    error.status = response.status
    throw error
  }
  return body
}

const runUrl = runId => `/agh/api/analysis-runs/${encodeURIComponent(runId)}`

export function fetchRefinement(runId, { calibration, filter }, { signal } = {}) {
  return requestJson(`${runUrl(runId)}/refinement`, {
    method: 'POST', body: JSON.stringify({ calibration, filter }), signal,
  })
}

export function createPredictionEdit(runId, { kind, x, y, stroke, radius, calibration, filter }, { signal } = {}) {
  const target = stroke ? { stroke, radius } : { x, y }
  return requestJson(`${runUrl(runId)}/edits`, {
    method: 'POST', body: JSON.stringify({ kind, ...target, calibration, filter }), signal,
  })
}

export function removePredictionEdits(runId, { editId, scope }, { signal } = {}) {
  const query = editId ? `edit=${encodeURIComponent(editId)}` : `scope=${encodeURIComponent(scope)}`
  return requestJson(`${runUrl(runId)}/edits?${query}`, { method: 'DELETE', signal })
}

export function retryStackAnalysis(caseId, filename, channel, window, { signal } = {}) {
  const base = `/agh/api/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/gbm-refinement`
  return requestJson(`${base}?channel=${channel}&window=${window}`, { method: 'POST', signal })
}

export function labelUrl(runId, token, window) {
  return `${runUrl(runId)}/refinement/label.png?token=${encodeURIComponent(token)}&window=${window}`
}

const LABEL_CACHE_SIZE = 16
const labelCache = new Map()

export async function fetchLabel(runId, token, window, { signal } = {}) {
  const id = `${runId}|${token}|${window}`
  if (labelCache.has(id)) {
    const hit = labelCache.get(id)
    labelCache.delete(id)
    labelCache.set(id, hit)
    return hit
  }
  const response = await authFetch(labelUrl(runId, token, window), { signal, headers: { Accept: 'image/png' } })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body?.error || `Label request failed with ${response.status}`)
  }
  // Exact pixel values matter here, so decode without any colour conversion.
  const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(bitmap, 0, 0)
  const label = decodeLabel(context.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height)
  bitmap.close?.()
  labelCache.set(id, label)
  while (labelCache.size > LABEL_CACHE_SIZE) labelCache.delete(labelCache.keys().next().value)
  return label
}
