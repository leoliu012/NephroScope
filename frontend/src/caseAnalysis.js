import { authFetch } from './auth.js'
import { v4 as uuidv4 } from 'uuid'
import { compareAlphanumeric, getImageMagnificationGroup, organizeImageFilenames } from './collectionOrganization.js'

export const imageKey = (caseId, filename) => JSON.stringify([caseId, filename])
export const imageApi = (caseId, filename) => `/agh/api/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}`
export const is60X = filename => getImageMagnificationGroup(filename) === '60x'
export const isPost60X = filename => is60X(filename)
  && organizeImageFilenames([filename]).some(group => group.id === 'post' && group.files.length > 0)

export function selectedZSlices(zCount, gap = 0) {
  const count = Math.max(1, Math.floor(Number(zCount) || 1))
  const skip = Math.max(0, Math.min(8, Math.round(Number(gap) || 0)))
  if (skip > 0 && count <= skip + 1) return [Math.floor(count / 2)]
  return Array.from({ length: Math.ceil(count / (skip + 1)) }, (_, index) => index * (skip + 1))
}

export function gapLabel(gap) {
  return Number(gap) === 0 ? 'All Z slices' : `Skip ${gap} slice${Number(gap) === 1 ? '' : 's'} between runs`
}

export async function caseAnalysisJson(url, options = {}) {
  const response = await authFetch(url, {
    ...options, headers: { Accept: 'application/json', ...options.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return body
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

export function makeAnalysisBatch(images, gap, id = uuidv4()) {
  const jobs = images.flatMap(image => selectedZSlices(image.zCount, image.gap ?? gap).map(zIndex => ({
    id: `${image.key}:${zIndex}`, imageKey: image.key, zIndex, status: 'PENDING',
    runId: null, reused: false, distribution: null, distributionError: '',
  })))
  return { id, createdAt: new Date().toISOString(), gap, images, jobs }
}

const batchStorageKey = (user, scope) => `agh-viewer:${scope}:v1:${encodeURIComponent(user || 'local')}`

export function saveAnalysisBatch(user, batch, scope = 'case-analysis') {
  try {
    if (!batch) localStorage.removeItem(batchStorageKey(user, scope))
    else localStorage.setItem(batchStorageKey(user, scope), JSON.stringify({
      ...batch, jobs: batch.jobs.map(({ distribution, ...job }) => job),
    }))
    return true
  } catch {
    return false
  }
}

export function loadAnalysisBatch(user, scope = 'case-analysis') {
  try {
    const batch = JSON.parse(localStorage.getItem(batchStorageKey(user, scope)) || 'null')
    if (!batch?.id || !Array.isArray(batch.images) || !Array.isArray(batch.jobs)) return null
    return { ...batch, jobs: batch.jobs.map(job => ({ ...job, distribution: null })) }
  } catch {
    return null
  }
}

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

// The server queue persists jobs. The browser stores the selection/run IDs and
// can resume submission, polling and distributions after navigation or reload.
export async function monitorCaseAnalysis(initial, { signal, onChange, request = caseAnalysisJson, pollMs = 3000 }) {
  const batch = { ...initial, jobs: initial.jobs.map(job => ({ ...job })) }
  const images = new Map(batch.images.map(image => [image.key, image]))
  const publish = () => {
    if (!signal?.aborted) onChange({ ...batch, jobs: batch.jobs.map(job => ({ ...job })) })
  }
  const fatal = error => error.name === 'AbortError' || [401, 403].includes(error.status)
  await mapLimit(batch.jobs.filter(job => job.status === 'PENDING'), 3, async job => {
    const image = images.get(job.imageKey)
    try {
      const run = await request(`${imageApi(image.caseId, image.filename)}/analysis-runs`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zIndex: job.zIndex, channelIndex: image.channelIndex }),
      })
      Object.assign(job, { runId: run.runId, status: run.status, reused: Boolean(run.reused), error: '' })
    } catch (error) {
      if (fatal(error)) throw error
      Object.assign(job, { status: 'SUBMIT_ERROR', error: error.message })
    }
    publish()
  }, signal)

  while (!signal?.aborted) {
    const pending = batch.jobs.filter(job => job.runId && !['FAILED', 'SUBMIT_ERROR'].includes(job.status)
      && (!job.distribution && !job.distributionError))
    if (!pending.length) break
    await mapLimit(pending, 3, async job => {
      try {
        if (job.status !== 'SUCCEEDED') {
          const run = await request(`/agh/api/analysis-runs/${encodeURIComponent(job.runId)}`, { signal })
          Object.assign(job, { status: run.status, progress: run.progress, error: run.error?.message || '', pollError: '' })
        }
        if (job.status === 'SUCCEEDED') {
          try {
            job.distribution = await request(`/agh/api/analysis-runs/${encodeURIComponent(job.runId)}/measurements/gbm-distribution`, {
              method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ calibration: images.get(job.imageKey).calibration }),
            })
            job.pollError = ''
          } catch (error) {
            if (fatal(error)) throw error
            job.distributionError = error.message
          }
        }
      } catch (error) {
        if (fatal(error)) throw error
        if (error.status === 404) Object.assign(job, { status: 'FAILED', error: 'The saved run was deleted. Retry to queue it again.' })
        else job.pollError = error.message
      }
      publish()
    }, signal)
    if (batch.jobs.some(job => job.runId && ['QUEUED', 'RUNNING'].includes(job.status))) {
      await abortableDelay(pollMs, signal)
    }
  }
  return batch
}

export function retryAnalysisBatch(batch) {
  return { ...batch, jobs: batch.jobs.map(job => ['FAILED', 'SUBMIT_ERROR'].includes(job.status)
    ? { ...job, status: 'PENDING', runId: null, error: '', pollError: '', distributionError: '', distribution: null }
    : { ...job, distributionError: '', pollError: '' }) }
}

export function batchProgress(jobs = []) {
  let fraction = 0
  const counts = { total: jobs.length, complete: 0, reused: 0, failed: 0, empty: 0, queued: 0, running: 0 }
  for (const job of jobs) {
    if (job.status === 'SUCCEEDED') {
      fraction += job.distribution || job.distributionError ? 1 : 0.95
      if (job.distribution) counts.complete++
      if (job.reused) counts.reused++
      if (job.distribution?.sampleCount === 0) counts.empty++
      if (job.distributionError) counts.failed++
    } else if (['FAILED', 'SUBMIT_ERROR'].includes(job.status)) { counts.failed++; fraction++ }
    else if (job.status === 'RUNNING') { counts.running++; fraction += Math.min(0.95, Math.max(0, job.progress?.fraction || 0)) }
    else if (job.status === 'QUEUED') counts.queued++
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
  return { count, q1, median, q3, low, high, min: values[0], max: values[values.length - 1], outliers }
}

export function representativeSamples(values, counts, limit = 120) {
  const total = counts.reduce((sum, count) => sum + count, 0)
  const length = Math.min(limit, total)
  let valueIndex = 0, cumulative = counts[0] || 0
  return Array.from({ length }, (_, index) => {
    const rank = Math.floor((index + 0.5) * total / length)
    while (cumulative <= rank && valueIndex < values.length - 1) cumulative += counts[++valueIndex]
    return values[valueIndex]
  })
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
      key, caseId: image.caseId,
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
    return { ...group, imageCount: group.images.size, values, counts, summary: distributionSummary(values, counts) }
  }).filter(group => group.summary).sort((a, b) => compareAlphanumeric(a.label, b.label))
}
