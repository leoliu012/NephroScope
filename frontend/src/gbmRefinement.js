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
  if (workerHasStopped(stack)) return 'Recalculation is waiting for the analysis worker to restart…'
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

// What is under the pointer, for the correction tools.
export function pieceInfoFor(identity, view) {
  if (!identity || !view?.pieces) return null
  const index = identity - 1
  const code = view.pieces.reason[index]
  if (code === undefined) return null
  const name = view.pieces.reasonNames?.[String(code)] || 'kept'
  return { piece: index, reason: name, tiltDeg: view.pieces.tiltDeg[index], widthNm: view.pieces.widthNm[index] }
}

// ---- Requests ---------------------------------------------------------------

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      const error = new Error('Request was cancelled')
      error.name = 'AbortError'
      reject(error)
    }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

// Proxies drop requests now and then. Reads try again; a click is never sent twice.
export function isTemporaryFailure(error) {
  return error?.name !== 'AbortError' && (!error?.status || [502, 503, 504].includes(error.status))
}

async function withRetries(attempt, { signal, retries = 2, waitMs = 400 } = {}) {
  for (let tried = 0; ; tried += 1) {
    try {
      return await attempt()
    } catch (error) {
      if (tried >= retries || !isTemporaryFailure(error)) throw error
      await delay(waitMs * 3 ** tried, signal)
    }
  }
}

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

// A worker that has not reported for this long has gone; it reports every 30 seconds.
const WORKER_SILENT_SECONDS = 120

export function workerHasStopped(stack) {
  return stack?.state === 'running' && Number(stack.job?.heartbeatAgeSeconds) > WORKER_SILENT_SECONDS
}

const runUrl = runId => `/agh/api/analysis-runs/${encodeURIComponent(runId)}`

export function fetchRefinement(runId, { calibration, filter }, { signal } = {}) {
  return withRetries(() => requestJson(`${runUrl(runId)}/refinement`, {
    method: 'POST', body: JSON.stringify({ calibration, filter }), signal,
  }), { signal })
}

export function fetchRefinementFrames(runIds, { calibration, filter }, { signal } = {}) {
  return withRetries(() => requestJson('/agh/api/analysis-runs/refinement-frames', {
    method: 'POST', body: JSON.stringify({ runIds, calibration, filter }), signal,
  }), { signal })
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
