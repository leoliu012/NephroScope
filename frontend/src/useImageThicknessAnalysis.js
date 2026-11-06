import { useEffect, useMemo, useRef, useState } from 'react'
import {
  batchProgress, cancelRuns, coverageKey, distributionNeeded, fetchCoverage, fetchDistributions, fetchDistributionTokens,
  imageKey, jobFromRun, lookupRuns, selectedZSlices, submitRuns,
} from './caseAnalysis.js'
import { distributionCacheKey } from './distributionCache.js'
import { filterKey, reportFilterLine } from './gbmRefinement.js'
import {
  gapRunCounts, imageThicknessReport, imageThicknessScope, loadGapPreference, nearbyZSlices, saveGapPreference, viewerGapOptions,
} from './imageThickness.js'

const ACTIVE = new Set(['QUEUED', 'RUNNING'])
const POLL_MS = 3000
const FILTER_POLL_MS = 4000

// Thickness results for the open image come from the runs already saved on
// the server for this channel, so any Z sampling that was analyzed before
// (here or in Case analysis) shows immediately.
export default function useImageThicknessAnalysis({
  caseId, filename, meta, ready, channelIndex, calibration, initialGap = null, filter = null, filterSettings = null, editsVersion = 0,
}) {
  const zCount = Math.max(1, Number(meta?.zCount) || 1)
  const scope = ready ? imageThicknessScope(caseId, filename, meta) : null
  const coverageId = scope ? `${scope}#${channelIndex}` : ''
  const key = imageKey(caseId, filename)
  const [gap, setGapState] = useState(0)
  const [coverage, setCoverage] = useState({ id: '', runs: {}, loading: false, error: '' })
  const [measured, setMeasured] = useState({ id: '', byZ: new Map() })
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [options, setOptions] = useState({ groupBy: 'image', unit: 'nm', observed: false, focus: true })
  const [refreshToken, setRefreshToken] = useState(0)
  const [filterPoll, setFilterPoll] = useState(0)
  const preferenceRef = useRef(null)
  const initialGapRef = useRef(initialGap)
  initialGapRef.current = initialGap
  const calibrationKey = JSON.stringify(calibration)
  const filterIdentity = filterKey(filter)

  useEffect(() => {
    if (!scope) return
    // A link from Case analysis opens on that analysis's Z sampling.
    preferenceRef.current = Number.isInteger(initialGapRef.current) ? initialGapRef.current : loadGapPreference(scope)
    setGapState(preferenceRef.current ?? 0)
    setError('')
  }, [scope])

  const setGap = value => {
    setGapState(value)
    preferenceRef.current = value
    if (scope) saveGapPreference(scope, value)
  }

  useEffect(() => {
    if (!coverageId) { setCoverage({ id: '', runs: {}, loading: false, error: '' }); return undefined }
    const controller = new AbortController()
    setCoverage(current => current.id === coverageId ? { ...current, loading: true } : { id: coverageId, runs: {}, loading: true, error: '' })
    fetchCoverage([{ caseId, filename, channelIndex }], { signal: controller.signal })
      .then(map => {
        const entry = map.get(coverageKey(caseId, filename, channelIndex))
        const runs = entry?.runs || {}
        setCoverage({ id: coverageId, runs, loading: false, error: entry?.error || '' })
        if (preferenceRef.current === null) {
          // No remembered choice yet: open on a Z sampling that already has results.
          const complete = viewerGapOptions(zCount).find(option => {
            const counts = gapRunCounts(option.slices, runs)
            return counts.total && counts.ready === counts.total
          })
          if (complete) setGapState(complete.gap)
        }
      })
      .catch(err => {
        if (err.name !== 'AbortError') setCoverage(current => ({ ...current, id: coverageId, loading: false, error: err.message }))
      })
    return () => controller.abort()
  }, [coverageId, refreshToken])

  const runs = coverage.id === coverageId ? coverage.runs : {}
  const slices = useMemo(() => selectedZSlices(zCount, gap), [zCount, gap])
  const activeRunIds = slices.map(z => runs[String(z)]).filter(run => run && ACTIVE.has(run.status)).map(run => run.runId)
  // Every active slice is followed, including nearby ones run for the Z analysis.
  const allActiveRunIds = Object.values(runs).filter(run => run && ACTIVE.has(run.status)).map(run => run.runId)
  const activeSignature = allActiveRunIds.join(',')

  useEffect(() => {
    if (!activeSignature) return undefined
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const found = await lookupRuns(activeSignature.split(','), { signal: controller.signal })
        setCoverage(current => {
          if (current.id !== coverageId) return current
          const next = { ...current.runs }
          for (const [z, run] of Object.entries(current.runs)) {
            if (run && found[run.runId]) next[z] = { ...run, ...found[run.runId] }
          }
          return { ...current, runs: next }
        })
      } catch (err) {
        if (err.name !== 'AbortError') setError(`Progress could not be updated: ${err.message}`)
      }
    }, POLL_MS)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [activeSignature, coverageId, coverage.runs])

  const byZ = measured.id === coverageId ? measured.byZ : new Map()
  const finishedSignature = slices.map(z => {
    const run = runs[String(z)]
    return run?.status === 'SUCCEEDED' ? `${z}:${run.runId}` : ''
  }).filter(Boolean).join(',')

  useEffect(() => {
    if (!finishedSignature) return undefined
    const controller = new AbortController()
    const { signal } = controller
    const items = finishedSignature.split(',').map(item => {
      const [z, runId] = item.split(':')
      return { key: z, runId, calibration, ...(filter ? { filter } : {}) }
    })
    ;(async () => {
      const { tokens, states } = filter
        ? await fetchDistributionTokens(items.map(item => item.runId), filter, { signal }).catch(err => {
          if (err.name === 'AbortError') throw err
          return { tokens: null, states: {} }
        })
        : { tokens: null, states: {} }
      const needed = items.filter(item => distributionNeeded(
        byZ.get(item.key), distributionCacheKey(item.runId, item.calibration, item.filter), tokens?.[item.runId], states[item.runId],
      ))
      if (!needed.length) return
      await fetchDistributions(needed, {
        signal,
        ...(tokens ? { tokens } : {}),
        onResult: (z, result) => setMeasured(current => {
          const map = new Map(current.id === coverageId ? current.byZ : [])
          map.set(z, result)
          return { id: coverageId, byZ: map }
        }),
      })
    })().catch(err => { if (err.name !== 'AbortError') setError(err.message) })
    return () => controller.abort()
  }, [finishedSignature, calibrationKey, coverageId, filterIdentity, editsVersion, filterPoll])

  // Slices measured while the Z analysis was unfinished are measured again once it is.
  const filterWaiting = [...byZ.values()].some(result => result.waiting)
  useEffect(() => {
    if (!filterWaiting) return undefined
    const timer = setTimeout(() => setFilterPoll(value => value + 1), FILTER_POLL_MS)
    return () => clearTimeout(timer)
  }, [filterWaiting, filterPoll])

  const batch = useMemo(() => {
    if (!scope) return null
    const image = { key, caseId, filename, zCount, channelIndex, calibration }
    const finished = slices.map(z => runs[String(z)]?.finishedAt).filter(Boolean).sort()
    return {
      id: `${coverageId}:${gap}`,
      createdAt: finished.at(-1) || new Date().toISOString(),
      gap,
      images: [image],
      jobs: slices.map(z => jobFromRun({ id: `${key}:${z}`, imageKey: key, zIndex: z }, runs[String(z)], byZ.get(String(z)))),
    }
  }, [scope, key, caseId, filename, zCount, channelIndex, calibrationKey, slices, runs, byZ, coverageId, gap])

  const progress = batchProgress(batch?.jobs)
  const report = useMemo(() => imageThicknessReport(batch, {
    ...options,
    filterLine: filterSettings ? reportFilterLine(filterSettings, (batch?.jobs || []).map(job => job.distribution).filter(Boolean)) : '',
  }), [batch, options, filterSettings])
  const gapOptions = useMemo(() => viewerGapOptions(zCount).map(option => ({ ...option, ...gapRunCounts(option.slices, runs) })), [zCount, runs])
  const monitoring = activeRunIds.length > 0

  const start = async () => {
    if (!scope || busy) return
    const missing = slices.filter(z => !['SUCCEEDED', 'QUEUED', 'RUNNING'].includes(runs[String(z)]?.status))
    if (!missing.length) return
    setBusy('start')
    setError('')
    try {
      const results = await submitRuns(missing.map(zIndex => ({ caseId, filename, zIndex, channelIndex })))
      setCoverage(current => {
        if (current.id !== coverageId) return current
        const next = { ...current.runs }
        results.forEach(result => { if (result.runId) next[String(result.zIndex)] = result })
        return { ...current, runs: next }
      })
      const failed = results.filter(result => result.status === 'SUBMIT_ERROR')
      if (failed.length) setError(`${failed.length} Z slice${failed.length === 1 ? '' : 's'} could not be queued: ${failed[0].error?.message || 'unknown error'}`)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  // Tilt needs neighbours: segment a spread of nearby slices around this one.
  const runNearby = async zIndex => {
    if (!scope || busy) return
    const missing = nearbyZSlices(zCount, zIndex).filter(z => !['SUCCEEDED', 'QUEUED', 'RUNNING'].includes(runs[String(z)]?.status))
    if (!missing.length) return
    setBusy('nearby')
    setError('')
    try {
      const results = await submitRuns(missing.map(z => ({ caseId, filename, zIndex: z, channelIndex })))
      setCoverage(current => {
        if (current.id !== coverageId) return current
        const next = { ...current.runs }
        results.forEach(result => { if (result.runId) next[String(result.zIndex)] = result })
        return { ...current, runs: next }
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const interrupt = async () => {
    const queued = slices.map(z => runs[String(z)]).filter(run => run?.status === 'QUEUED').map(run => run.runId)
    if (!queued.length || busy) return
    setBusy('interrupt')
    setError('')
    try {
      const result = await cancelRuns(queued)
      const canceled = new Set(result.canceled)
      setCoverage(current => {
        const next = { ...current.runs }
        for (const [z, run] of Object.entries(current.runs)) {
          if (run && canceled.has(run.runId)) next[z] = { ...run, status: 'CANCELED' }
        }
        return { ...current, runs: next }
      })
      if (result.kept?.length) setError(`${result.kept.length} queued Z slice${result.kept.length === 1 ? ' is' : 's are'} kept because a running Case analysis also needs ${result.kept.length === 1 ? 'it' : 'them'}.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  return {
    batch, gap, setGap, gapOptions, slices, monitoring, busy, error, options,
    setOption: (name, value) => setOptions(current => ({ ...current, [name]: value })),
    progress, report, start, interrupt, runNearby, filterWaiting, activeCount: allActiveRunIds.length,
    coverageLoading: coverage.loading && coverage.id === coverageId,
    coverageError: coverage.id === coverageId ? coverage.error : '',
    refresh: () => setRefreshToken(value => value + 1),
  }
}
