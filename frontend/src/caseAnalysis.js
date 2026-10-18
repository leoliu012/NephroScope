import { authFetch } from './auth.js'
import { v4 as uuidv4 } from 'uuid'
import { compareAlphanumeric, getImageMagnificationGroup, organizeImageFilenames } from './collectionOrganization.js'
import { distributionCacheKey, getCachedDistributions, putCachedDistributions } from './distributionCache.js'

export const imageKey = (caseId, filename) => JSON.stringify([caseId, filename])
export const jobKey = (caseId, filename, zIndex) => `${imageKey(caseId, filename)}:${zIndex}`
export const imageApi = (caseId, filename) => `/agh/api/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}`
export const is60X = filename => getImageMagnificationGroup(filename) === '60x'
export const isPost60X = filename => is60X(filename)
  && organizeImageFilenames([filename]).some(group => group.id === 'post' && group.files.length > 0)

export const MAX_GAP = 8
const ACTIVE = new Set(['QUEUED', 'RUNNING'])

export function selectedZSlices(zCount, gap = 0) {
  const count = Math.max(1, Math.floor(Number(zCount) || 1))
  const skip = Math.max(0, Math.min(MAX_GAP, Math.round(Number(gap) || 0)))
  if (skip > 0 && count <= skip + 1) return [Math.floor(count / 2)]
  return Array.from({ length: Math.ceil(count / (skip + 1)) }, (_, index) => index * (skip + 1))
}

export function ordinal(value) {
  const tens = value % 100
  if (tens >= 11 && tens <= 13) return `${value}th`
  return `${value}${({ 1: 'st', 2: 'nd', 3: 'rd' })[value % 10] || 'th'}`
}

export function gapLabel(gap) {
  const value = Number(gap) || 0
  return value === 0 ? 'Every Z slice' : `Every ${ordinal(value + 1)} Z slice`
}

export function gapShortLabel(gap) {
  const value = Number(gap) || 0
  return value === 0 ? 'All slices' : `Gap ${value}`
}

export function sliceSummary(slices, limit = 12) {
  const labels = slices.slice(0, limit).map(z => `Z${z + 1}`)
  return `${labels.join(', ')}${slices.length > limit ? ', …' : ''}`
}

// The analysis server sits behind proxies that occasionally drop a request
// (502/503/504 or a network error). Every call here is safe to repeat.
const RETRY_STATUSES = new Set([502, 503, 504])

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

export async function caseAnalysisJson(url, options = {}, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response
    try {
      response = await authFetch(url, {
        ...options, headers: { Accept: 'application/json', ...options.headers },
      })
    } catch (error) {
      if (error.name === 'AbortError' || attempt >= retries) throw error
      await abortableDelay(400 * 3 ** attempt, options.signal)
      continue
    }
    if (RETRY_STATUSES.has(response.status) && attempt < retries) {
      await abortableDelay(400 * 3 ** attempt, options.signal)
      continue
    }
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(body.error || `Request failed (${response.status})`)
      error.status = response.status
      throw error
    }
    return body
  }
}

export async function mapLimit(items, limit, callback, signal) {
  let index = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length && !signal?.aborted) {
      const next = index++
      await callback(items[next], next)
    }
  }))
}

function chunked(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))
}

const postJson = (request, url, body, signal) => request(url, {
  method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

// ---- Run API (batched) -----------------------------------------------------

export async function submitRuns(items, { signal, request = caseAnalysisJson } = {}) {
  const results = []
  for (const chunk of chunked(items, 500)) {
    const payload = await postJson(request, '/agh/api/analysis-runs/batch', {
      runs: chunk.map(item => ({ case: item.caseId, filename: item.filename, zIndex: item.zIndex, channelIndex: item.channelIndex })),
    }, signal)
    results.push(...payload.runs)
  }
  return results
}

export async function lookupRuns(runIds, { signal, request = caseAnalysisJson } = {}) {
  const runs = {}
  for (const chunk of chunked([...new Set(runIds)].filter(Boolean), 1000)) {
    Object.assign(runs, (await postJson(request, '/agh/api/analysis-runs/lookup', { runIds: chunk }, signal)).runs)
  }
  return runs
}

export async function cancelRuns(runIds, { signal, request = caseAnalysisJson } = {}) {
  const ids = [...new Set(runIds)].filter(Boolean)
  if (!ids.length) return { canceled: [], kept: [] }
  return postJson(request, '/agh/api/analysis-runs/cancel', { runIds: ids }, signal)
}

// Existing runs per Z slice for each image/channel, matched by the same cache
// key the server uses to reuse segmentations.
export async function fetchCoverage(images, { signal, request = caseAnalysisJson } = {}) {
  const coverage = new Map()
  for (const chunk of chunked(images, 100)) {
    const payload = await postJson(request, '/agh/api/analysis-coverage', {
      images: chunk.map(image => ({ case: image.caseId, filename: image.filename, channelIndex: image.channelIndex })),
    }, signal)
    payload.images.forEach(entry => {
      coverage.set(coverageKey(entry.case, entry.filename, entry.channelIndex), entry)
    })
  }
  return coverage
}

export const coverageKey = (caseId, filename, channelIndex) => `${imageKey(caseId, filename)}#${channelIndex}`

// Ready/active slice counts for one image at one Z gap.
export function gapCoverage(entry, zCount, gap) {
  const slices = selectedZSlices(zCount, gap)
  let ready = 0, active = 0
  for (const z of slices) {
    const status = entry?.runs?.[String(z)]?.status
    if (status === 'SUCCEEDED') ready++
    else if (ACTIVE.has(status)) active++
  }
  return { total: slices.length, ready, active, missing: slices.length - ready - active }
}

// Measurements for finished runs; cached results return without a request.
export async function fetchDistributions(items, { signal, request = caseAnalysisJson, onResult } = {}) {
  const keyed = items.map(item => ({ ...item, cacheKey: distributionCacheKey(item.runId, item.calibration) }))
  const cached = await getCachedDistributions(keyed.map(item => item.cacheKey))
  const pending = []
  keyed.forEach(item => {
    const distribution = cached.get(item.cacheKey)
    if (distribution) onResult?.(item.key, { runId: item.runId, cacheKey: item.cacheKey, distribution })
    else pending.push(item)
  })
  await mapLimit(chunked(pending, 40), 2, async chunk => {
    let payload
    try {
      payload = await postJson(request, '/agh/api/analysis-runs/distributions', {
        items: chunk.map(item => ({ runId: item.runId, calibration: item.calibration })),
      }, signal)
    } catch (error) {
      if (error.name === 'AbortError' || [401, 403].includes(error.status)) throw error
      chunk.forEach(item => onResult?.(item.key, { runId: item.runId, cacheKey: item.cacheKey, error: error.message, retryable: true }))
      return
    }
    const fresh = []
    payload.results.forEach((result, index) => {
      const item = chunk[index]
      if (result.distribution) {
        fresh.push({ key: item.cacheKey, distribution: result.distribution })
        onResult?.(item.key, { runId: item.runId, cacheKey: item.cacheKey, distribution: result.distribution })
      } else {
        onResult?.(item.key, { runId: item.runId, cacheKey: item.cacheKey, error: result.error || 'Measurement unavailable', status: result.status })
      }
    })
    if (fresh.length) await putCachedDistributions(fresh)
  }, signal)
}

// ---- Saved case analyses ----------------------------------------------------

const ANALYSES = '/agh/api/case-analyses'

export const savedAnalyses = {
  list: ({ signal, request = caseAnalysisJson } = {}) => request(ANALYSES, { signal }).then(payload => payload.analyses || []),
  get: (id, { signal, request = caseAnalysisJson } = {}) => request(`${ANALYSES}/${encodeURIComponent(id)}`, { signal }),
  create: (body, { signal, request = caseAnalysisJson } = {}) => postJson(request, ANALYSES, body, signal),
  interrupt: (id, { signal, request = caseAnalysisJson } = {}) => postJson(request, `${ANALYSES}/${encodeURIComponent(id)}/interrupt`, {}, signal),
  resume: (id, { signal, request = caseAnalysisJson } = {}) => postJson(request, `${ANALYSES}/${encodeURIComponent(id)}/resume`, {}, signal),
  cancelJobs: (id, jobIds, { signal, request = caseAnalysisJson } = {}) => postJson(request, `${ANALYSES}/${encodeURIComponent(id)}/cancel`, { jobIds }, signal),
  remove: (id, { signal, request = caseAnalysisJson } = {}) => request(`${ANALYSES}/${encodeURIComponent(id)}`, { method: 'DELETE', signal }),
}

// Request body for a new (or merged) saved analysis.
export function analysisRequest(images, gap, { start = true } = {}) {
  return {
    gap,
    start,
    images: images.map(image => ({
      caseId: image.caseId, filename: image.filename, channelIndex: image.channelIndex,
      zCount: image.zCount, gap: image.gap ?? null, calibration: image.calibration,
    })),
    jobs: images.flatMap(image => selectedZSlices(image.zCount, image.gap ?? gap).map(zIndex => ({
      caseId: image.caseId, filename: image.filename, zIndex,
    }))),
  }
}

// Same images, channels and Z sampling => the same analysis (the server
// merges these). Used to point at existing results before running anything.
export function selectionSignature(images, gap) {
  return images.map(image => JSON.stringify([image.caseId, image.filename, image.channelIndex, image.gap ?? gap]))
    .sort().join('\n')
}

export function imageSetSignature(images) {
  return images.map(image => imageKey(image.caseId, image.filename)).sort().join('\n')
}

export function analysisTitle(analysis) {
  const cases = analysis.caseIds || [...new Set((analysis.images || []).map(image => image.caseId))]
  const named = cases.slice(0, 3).join(', ')
  return cases.length > 3 ? `${named} +${cases.length - 3} more` : named || 'Case analysis'
}

export function analysisGapLabel(analysis) {
  const gaps = new Set((analysis.images || []).map(image => image.gap ?? analysis.gap))
  if (gaps.size > 1) return `${gapLabel(analysis.gap)} · custom gaps for some images`
  return gapLabel([...gaps][0] ?? analysis.gap)
}

export async function monitorSavedAnalysis(initial, {
  signal, onChange, request = caseAnalysisJson, pollMs = 3000, measure = fetchDistributions, distributions: known,
} = {}) {
  let analysis = initial
  const distributions = new Map(known || [])
  let dirty = false
  let retryPasses = 0
  const publish = () => {
    if (!signal?.aborted) onChange?.({ analysis, distributions: new Map(distributions) })
    dirty = false
  }
  while (!signal?.aborted) {
    const images = new Map(analysis.images.map(image => [image.key, image]))
    const needed = analysis.jobs.filter(job => {
      if (job.run?.status !== 'SUCCEEDED') return false
      const measured = distributions.get(job.id)
      const cacheKey = distributionCacheKey(job.run.runId, images.get(job.imageKey)?.calibration)
      return !measured || measured.cacheKey !== cacheKey || measured.retryable
    })
    if (needed.length) {
      let lastPublish = Date.now()
      await measure(needed.map(job => ({
        key: job.id, runId: job.run.runId, calibration: images.get(job.imageKey)?.calibration,
      })), {
        signal, request,
        onResult: (key, result) => {
          distributions.set(key, result)
          dirty = true
          if (Date.now() - lastPublish > 250) { publish(); lastPublish = Date.now() }
        },
      })
    }
    if (dirty || needed.length === 0) publish()
    const active = analysis.jobs.some(job => ACTIVE.has(job.run?.status))
    const retryable = analysis.jobs.some(job => distributions.get(job.id)?.retryable)
    if (!active && (!retryable || retryPasses >= 2)) break
    if (!active) retryPasses++
    await abortableDelay(pollMs, signal)
    if (active) {
      analysis = await savedAnalyses.get(analysis.id, { signal, request })
      publish()
    }
  }
  return { analysis, distributions }
}

// ---- Batch view model -------------------------------------------------------

export function makeAnalysisBatch(images, gap, id = uuidv4()) {
  const jobs = images.flatMap(image => selectedZSlices(image.zCount, image.gap ?? gap).map(zIndex => ({
    id: `${image.key}:${zIndex}`, imageKey: image.key, zIndex, status: 'PENDING',
    runId: null, reused: false, distribution: null, distributionError: '',
  })))
  return { id, createdAt: new Date().toISOString(), gap, images, jobs }
}

export function jobFromRun(job, run, measured) {
  const distribution = measured?.runId === run?.runId ? measured : null
  return {
    ...job,
    status: run?.status || 'MISSING',
    runId: run?.runId || null,
    progress: run?.progress || null,
    error: run?.status === 'FAILED' ? run?.error?.message || 'Segmentation failed' : '',
    distribution: distribution?.distribution || null,
    distributionError: distribution?.error || '',
  }
}

export function analysisToBatch(analysis, distributions = new Map()) {
  if (!analysis) return null
  return {
    id: analysis.id,
    createdAt: analysis.createdAt,
    gap: analysis.gap,
    images: analysis.images,
    jobs: analysis.jobs.map(job => jobFromRun({ id: job.id, imageKey: job.imageKey, zIndex: job.zIndex }, job.run, distributions.get(job.id))),
  }
}

export function batchProgress(jobs = []) {
  let fraction = 0
  const counts = { total: jobs.length, complete: 0, failed: 0, canceled: 0, missing: 0, empty: 0, queued: 0, running: 0, measuring: 0 }
  for (const job of jobs) {
    if (job.status === 'SUCCEEDED') {
      fraction += job.distribution || job.distributionError ? 1 : 0.95
      if (job.distribution) counts.complete++
      else if (job.distributionError) counts.failed++
      else counts.measuring++
      if (job.distribution?.sampleCount === 0) counts.empty++
    } else if (['FAILED', 'SUBMIT_ERROR'].includes(job.status)) { counts.failed++; fraction++ }
    else if (job.status === 'CANCELED') counts.canceled++
    else if (job.status === 'RUNNING') { counts.running++; fraction += Math.min(0.95, Math.max(0, job.progress?.fraction || 0)) }
    else if (job.status === 'QUEUED') counts.queued++
    else counts.missing++
  }
  return { ...counts, percent: jobs.length ? Math.round(100 * fraction / jobs.length) : 0 }
}

// Linear quantiles of the expanded individual-sample population, without
// allocating millions of duplicate values in the browser.
export function weightedQuantile(values, counts, quantile) {
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (!total) return null
  const position = Math.max(0, Math.min(1, quantile)) * (total - 1)
  const low = Math.floor(position), high = Math.ceil(position)
  let cumulative = 0, left = null, right = null
  for (let index = 0; index < values.length; index++) {
    cumulative += counts[index]
    if (left === null && cumulative > low) left = values[index]
    if (cumulative > high) { right = values[index]; break }
  }
  return left + (right - left) * (position - low)
}

export function distributionSummary(values, counts) {
  const count = counts.reduce((sum, value) => sum + value, 0)
  if (!count) return null
  const q1 = weightedQuantile(values, counts, 0.25)
  const median = weightedQuantile(values, counts, 0.5)
  const q3 = weightedQuantile(values, counts, 0.75)
  const iqr = q3 - q1
  const low = values.find(value => value >= q1 - 1.5 * iqr)
  const high = [...values].reverse().find(value => value <= q3 + 1.5 * iqr)
  const outliers = counts.reduce((sum, n, index) => sum + (values[index] < low || values[index] > high ? n : 0), 0)
  let total = 0
  values.forEach((value, index) => { total += value * counts[index] })
  const mean = total / count
  let squares = 0
  values.forEach((value, index) => { squares += counts[index] * (value - mean) ** 2 })
  const sd = count > 1 ? Math.sqrt(squares / (count - 1)) : 0
  return { count, mean, sd, q1, median, q3, low, high, min: values[0], max: values[values.length - 1], outliers }
}

export function comparisonGroups(batch, { groupBy = 'case', unit = 'nm', observed = false, excluded = [] } = {}) {
  if (!batch) return []
  const images = new Map(batch.images.map(image => [image.key, image]))
  const groups = new Map()
  const seen = new Set()
  for (const job of batch.jobs) {
    if (!job.distribution || excluded.includes(job.imageKey) || seen.has(job.runId)) continue
    seen.add(job.runId)
    const image = images.get(job.imageKey)
    const key = groupBy === 'case' ? image.caseId : groupBy === 'slice' ? job.id : image.key
    if (!groups.has(key)) groups.set(key, {
      key, caseId: image.caseId, filename: groupBy === 'case' ? '' : image.filename,
      zIndex: groupBy === 'slice' ? job.zIndex : null,
      label: groupBy === 'case' ? image.caseId : `${image.caseId} · ${image.filename}${groupBy === 'slice' ? ` · Z${job.zIndex + 1}` : ''}`,
      histogram: new Map(), images: new Set(), runs: 0,
    })
    const group = groups.get(key)
    const calibration = job.distribution.calibration || image.calibration
    const factor = (unit === 'nm' ? 1000 : 1) * (observed && calibration.expansionEnabled ? calibration.expansionFactor : 1)
    job.distribution.valuesUm.forEach((value, index) => {
      const physical = value * factor
      group.histogram.set(physical, (group.histogram.get(physical) || 0) + job.distribution.counts[index])
    })
    group.images.add(image.key)
    group.runs++
  }
  return [...groups.values()].map(group => {
    const values = [...group.histogram.keys()].sort((a, b) => a - b)
    const counts = values.map(value => group.histogram.get(value))
    const { histogram, images: imageKeys, ...rest } = group
    return { ...rest, imageCount: imageKeys.size, values, counts, summary: distributionSummary(values, counts) }
  }).filter(group => group.summary).sort((a, b) => compareAlphanumeric(a.label, b.label)
    || (a.zIndex ?? 0) - (b.zIndex ?? 0))
}

// ---- Legacy browser-stored comparison (migrated to saved analyses) --------

const legacyStorageKey = (user, scope) => `agh-viewer:${scope}:v1:${encodeURIComponent(user || 'local')}`

export function loadLegacyAnalysisBatch(user, scope = 'case-analysis') {
  try {
    const batch = JSON.parse(localStorage.getItem(legacyStorageKey(user, scope)) || 'null')
    if (!batch?.id || !Array.isArray(batch.images) || !Array.isArray(batch.jobs)) return null
    return batch
  } catch {
    return null
  }
}

export function clearLegacyAnalysisBatch(user, scope = 'case-analysis') {
  try { localStorage.removeItem(legacyStorageKey(user, scope)) } catch { /* optional */ }
}
