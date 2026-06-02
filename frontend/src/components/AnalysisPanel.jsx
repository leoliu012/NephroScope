import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  CheckCircle2,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Play,
  Ruler,
  Trash2,
  XCircle,
  Waypoints,
} from 'lucide-react'
import { channelIndexForRole, channelLabel, roleInfo } from '../channelMapping.js'

const API = '/agh/api'

const TASKS = [
  {
    id: 'process',
    title: 'Process segmentation',
    modelLabel: 'ACTN4',
    models: { actn4: true, dapi: false, nhs: false },
    roles: ['actn4'],
    metric: 'process',
    action: 'Run Process Segmentation',
  },
  {
    id: 'gbm',
    title: 'GBM segmentation',
    modelLabel: 'NHS',
    models: { actn4: false, dapi: false, nhs: true },
    roles: ['nhs'],
    metric: 'thickness',
    action: 'Run GBM Segmentation',
  },
  {
    id: 'nuclei',
    title: 'Nuclei segmentation',
    modelLabel: 'DAPI',
    models: { actn4: false, dapi: true, nhs: false },
    roles: ['dapi'],
    metric: null,
    action: 'Run Nuclei Segmentation',
  },
]

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
  return body
}

function artifactUrl(runId, artifactPath) {
  const encodedPath = String(artifactPath).split('/').map(encodeURIComponent).join('/')
  return `${API}/analysis-runs/${encodeURIComponent(runId)}/artifacts/${encodedPath}`
}

function clampIndex(value, n) {
  return Math.max(0, Math.min(Math.max(0, n - 1), Number(value) || 0))
}

function formatMetric(value) {
  if (value == null || Number.isNaN(value)) return 'n/a'
  if (Math.abs(value) >= 100 || Math.abs(value) < 0.01) return value.toExponential(2)
  return value.toFixed(3)
}

function formatCount(value) {
  if (value == null) return '0'
  return new Intl.NumberFormat().format(value)
}

function overlayLabel(name) {
  return String(name).split('/').pop().replace(/^overlay_/, '').replace(/\.png$/, '').replace(/_/g, ' ')
}

function runModelNames(run) {
  return run?.request?.modelNames || []
}

function runSupportsTask(run, taskId) {
  const names = runModelNames(run)
  if (taskId === 'process') return names.includes('ACTN4')
  if (taskId === 'nuclei') return names.includes('DAPI')
  if (taskId === 'gbm') return names.some(name => String(name).startsWith('NHS_'))
  return false
}

function runSummary(run) {
  const names = runModelNames(run)
  if (names.length) return names.join(', ')
  return run?.operation || 'segmentation'
}

function TaskCard({ task, onClick }) {
  return (
    <button
      onClick={onClick}
      className="ux-card ux-card-action w-full px-3 py-3 text-left"
    >
      <div className="flex items-start gap-2">
        <Activity size={14} className="mt-0.5 flex-shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-gray-100">{task.title}</p>
          <p className="text-[10px] text-gray-500 mt-1">Model: {task.modelLabel}</p>
        </div>
        <ChevronRight size={14} className="text-gray-500" />
      </div>
    </button>
  )
}

export default function AnalysisPanel({
  caseId,
  filename,
  imgMeta,
  channelMapping,
  onSetRoleChannel,
  analysisRoi,
  run,
  setRun,
  visibleOverlays,
  setVisibleOverlays,
  visibleVectors,
  setVisibleVectors,
  thickness,
  setThickness,
  processMetric,
  setProcessMetric,
}) {
  const numChannels = imgMeta?.numChannels || 0
  const [taskId, setTaskId] = useState(null)
  const [zIndex, setZIndex] = useState(0)
  const [nhsMode, setNhsMode] = useState('single-channel')
  const [pixelSize, setPixelSize] = useState('')
  const [pixelUnit, setPixelUnit] = useState('um')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [metricScope, setMetricScope] = useState('whole')
  const [expanded, setExpanded] = useState(true)
  const [expansionFactor, setExpansionFactor] = useState(7)
  const [savedRuns, setSavedRuns] = useState([])
  const [savedRunsLoading, setSavedRunsLoading] = useState(false)
  const [deletingRunId, setDeletingRunId] = useState(null)
  const [error, setError] = useState(null)
  const [metricRuns, setMetricRuns] = useState({ thickness: null, process: null })

  const selectedTask = TASKS.find(task => task.id === taskId)
  const preprocessingMode = 'percentile-stretch'

  useEffect(() => {
    if (!imgMeta) return
    setTaskId(null)
    setZIndex(0)
    setNhsMode('single-channel')
    setPixelSize(imgMeta.pixelSize || '')
    setPixelUnit(imgMeta.pixelUnit || 'um')
    setAdvancedOpen(false)
    setMetricScope('whole')
    setExpanded(true)
    setExpansionFactor(7)
    setSavedRuns([])
    setDeletingRunId(null)
    setRun(null)
    setThickness(null)
    setProcessMetric(null)
    setMetricRuns({ thickness: null, process: null })
    setVisibleOverlays({})
    setVisibleVectors?.({ thickness: true, process: true })
    setError(null)
  }, [imgMeta?.cacheKey, caseId, filename]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!analysisRoi && metricScope === 'selected') setMetricScope('whole')
  }, [analysisRoi, metricScope])

  const selectSegmentationRun = useCallback((nextRun) => {
    setRun(nextRun)
    setThickness(null)
    setProcessMetric(null)
    setMetricRuns({ thickness: null, process: null })
    setVisibleOverlays({})
    setVisibleVectors?.({ thickness: true, process: true })
    setError(null)
  }, [setRun, setThickness, setProcessMetric, setVisibleOverlays, setVisibleVectors])

  const loadSavedRuns = useCallback(async ({ selectLatest = false } = {}) => {
    if (!imgMeta || !caseId || !filename) return []
    setSavedRunsLoading(true)
    try {
      const response = await fetchJson(
        `${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/analysis-runs?operation=magnifyseg-segmentation&limit=20`
      )
      const runs = response.runs || []
      setSavedRuns(runs)
      if (selectLatest) {
        const latestReusable = runs.find(item => ['SUCCEEDED', 'RUNNING', 'QUEUED'].includes(item.status))
        if (latestReusable) selectSegmentationRun(latestReusable)
      }
      return runs
    } catch (err) {
      setError(err.message)
      return []
    } finally {
      setSavedRunsLoading(false)
    }
  }, [caseId, filename, imgMeta, selectSegmentationRun])

  useEffect(() => {
    loadSavedRuns({ selectLatest: true })
  }, [loadSavedRuns])

  useEffect(() => {
    if (!run?.runId || !['QUEUED', 'RUNNING'].includes(run.status)) return
    let cancelled = false
    const poll = async () => {
      try {
        const latest = await fetchJson(`${API}/analysis-runs/${encodeURIComponent(run.runId)}`)
        if (!cancelled) setRun(latest)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }
    poll()
    const id = window.setInterval(poll, 1500)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [run?.runId, run?.status, setRun])

  useEffect(() => {
    if (!run?.runId || !['SUCCEEDED', 'FAILED'].includes(run.status)) return
    loadSavedRuns()
  }, [run?.runId, run?.status, loadSavedRuns])

  useEffect(() => {
    const pending = Object.entries(metricRuns).filter(([, metricRun]) =>
      metricRun?.runId && ['QUEUED', 'RUNNING'].includes(metricRun.status)
    )
    if (!pending.length) return

    let cancelled = false
    const poll = async () => {
      await Promise.all(pending.map(async ([kind, metricRun]) => {
        try {
          const latest = await fetchJson(`${API}/analysis-runs/${encodeURIComponent(metricRun.runId)}`)
          if (cancelled) return
          setMetricRuns(prev => ({ ...prev, [kind]: latest }))
          if (latest.status === 'SUCCEEDED') {
            if (kind === 'thickness') setThickness(latest.result)
            else setProcessMetric(latest.result)
          } else if (latest.status === 'FAILED') {
            setError(latest.error || 'Metric calculation failed')
          }
        } catch (err) {
          if (!cancelled) setError(err.message)
        }
      }))
    }
    poll()
    const id = window.setInterval(poll, 1500)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [metricRuns.thickness?.runId, metricRuns.thickness?.status, metricRuns.process?.runId, metricRuns.process?.status, setThickness, setProcessMetric])

  const overlayNames = useMemo(() => [
    ...(run?.result?.overlays || []),
    ...(processMetric?.contourOverlays || []),
  ], [run, processMetric])

  useEffect(() => {
    if (!overlayNames.length) return
    setVisibleOverlays(prev => {
      const next = { ...prev }
      overlayNames.forEach(name => {
        if (!(name in next)) next[name] = true
      })
      return next
    })
  }, [overlayNames, setVisibleOverlays])

  const rolesForTask = useMemo(() => {
    if (!selectedTask) return []
    if (selectedTask.id === 'gbm' && nhsMode === 'combined-actn4') return ['nhs', 'actn4']
    return selectedTask.roles
  }, [selectedTask, nhsMode])

  const channelPayload = useMemo(() => {
    const payload = { actn4: null, dapi: null, nhs: null }
    rolesForTask.forEach(role => {
      payload[role] = channelIndexForRole(channelMapping, role)
    })
    return payload
  }, [channelMapping, rolesForTask])

  const missingRoles = rolesForTask.filter(role => channelPayload[role] == null)
  const duplicatedChannels = new Set(Object.values(channelPayload).filter(value => value != null)).size
    !== Object.values(channelPayload).filter(value => value != null).length

  const startRun = async () => {
    if (!selectedTask) return
    setError(null)
    setThickness(null)
    setProcessMetric(null)
    setMetricRuns({ thickness: null, process: null })
    try {
      const created = await fetchJson(`${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/analysis-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          zIndex,
          channels: channelPayload,
          models: selectedTask.models,
          nhsMode,
          preprocessingMode,
          calibration: {
            pixelSize: pixelSize === '' ? null : Number(pixelSize),
            pixelUnit,
            expanded,
            expansionFactor: Number(expansionFactor),
          },
        }),
      })
      setRun(created)
      setVisibleOverlays({})
      setVisibleVectors?.({ thickness: true, process: true })
      loadSavedRuns()
    } catch (err) {
      setError(err.message)
    }
  }

  const deleteSavedRun = async (runToDelete) => {
    if (!runToDelete?.runId) return
    setDeletingRunId(runToDelete.runId)
    setError(null)
    try {
      await fetchJson(`${API}/analysis-runs/${encodeURIComponent(runToDelete.runId)}`, { method: 'DELETE' })
      const nextRuns = savedRuns.filter(item => item.runId !== runToDelete.runId)
      setSavedRuns(nextRuns)
      if (run?.runId === runToDelete.runId) {
        const replacement = nextRuns.find(item => ['SUCCEEDED', 'RUNNING', 'QUEUED'].includes(item.status))
        if (replacement) selectSegmentationRun(replacement)
        else {
          setRun(null)
          setThickness(null)
          setProcessMetric(null)
          setMetricRuns({ thickness: null, process: null })
          setVisibleOverlays({})
        }
      }
      loadSavedRuns()
    } catch (err) {
      setError(err.message)
    } finally {
      setDeletingRunId(null)
    }
  }

  const computeMetric = async (kind) => {
    if (!run?.runId || run.status !== 'SUCCEEDED') return
    setError(null)
    try {
      const path = kind === 'thickness' ? 'gbm-thickness' : 'process-nnd'
      const roi = metricScope === 'selected' ? analysisRoi : null
      const metricRun = await fetchJson(`${API}/analysis-runs/${encodeURIComponent(run.runId)}/metrics/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roi }),
      })
      setMetricRuns(prev => ({ ...prev, [kind]: metricRun }))
      if (kind === 'thickness') setThickness(null)
      else setProcessMetric(null)
    } catch (err) {
      setError(err.message)
    }
  }

  const busy = run?.status === 'QUEUED' || run?.status === 'RUNNING'
  const succeeded = run?.status === 'SUCCEEDED'
  const failed = run?.status === 'FAILED'
  const segmentations = run?.result?.segmentations || {}
  const hasNhs = Boolean(segmentations.NHS_SINGLE_CHANNEL || segmentations.NHS_COMBINED_ACTN4)
  const hasActn4 = Boolean(segmentations.ACTN4)
  const thicknessBusy = ['QUEUED', 'RUNNING'].includes(metricRuns.thickness?.status)
  const processBusy = ['QUEUED', 'RUNNING'].includes(metricRuns.process?.status)
  const metricBusy = thicknessBusy || processBusy
  const canRun = imgMeta && selectedTask && numChannels > 0 && !busy && !missingRoles.length && !duplicatedChannels
  const matchingSavedRun = selectedTask
    ? savedRuns.find(item => runSupportsTask(item, selectedTask.id) && item.status === 'SUCCEEDED')
    : null
  const reusableSavedRuns = savedRuns.filter(item => ['SUCCEEDED', 'RUNNING', 'QUEUED'].includes(item.status))
  const nhsSegmentation = segmentations.NHS_SINGLE_CHANNEL || segmentations.NHS_COMBINED_ACTN4
  const actn4Segmentation = segmentations.ACTN4

  if (!imgMeta) return null

  return (
    <div className="px-3 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <Activity size={12} className="text-[var(--accent)]" />
        <p className="ux-section-label">MagnifySeg</p>
        {busy && <Loader2 size={12} className="ml-auto animate-spin text-[var(--accent)]" />}
        {succeeded && <CheckCircle2 size={12} className="ml-auto text-[var(--success)]" />}
        {failed && <XCircle size={12} className="ml-auto text-red-400" />}
      </div>

      {!selectedTask ? (
        <div className="space-y-2">
          {TASKS.map(task => (
            <TaskCard key={task.id} task={task} onClick={() => setTaskId(task.id)} />
          ))}
          <div className="space-y-2 border-t border-[var(--border)] pt-3">
            <div className="flex items-center justify-between">
              <p className="ux-section-label">Saved segmentations</p>
              {savedRunsLoading && <Loader2 size={11} className="animate-spin text-gray-500" />}
            </div>
            {reusableSavedRuns.length === 0 ? (
              <p className="text-[10px] text-gray-600">No saved segmentation for this image yet.</p>
            ) : reusableSavedRuns.map(savedRun => (
              <div key={savedRun.runId} className={`ux-card space-y-2 p-2 ${run?.runId === savedRun.runId ? 'ux-card-selected' : ''}`}>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${savedRun.status === 'SUCCEEDED' ? 'bg-[var(--success)]' : savedRun.status === 'FAILED' ? 'bg-[var(--danger)]' : 'bg-[var(--warning)]'}`} />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-gray-200">{runSummary(savedRun)}</span>
                  <span className="text-[9px] text-gray-600">{savedRun.status}</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => selectSegmentationRun(savedRun)}
                    className="ux-button ux-button-secondary text-[10px]"
                  >
                    Use
                  </button>
                  <button
                    onClick={() => deleteSavedRun(savedRun)}
                    disabled={deletingRunId === savedRun.runId}
                    className="ux-button ux-button-danger text-[10px]"
                  >
                    {deletingRunId === savedRun.runId ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <button
            onClick={() => setTaskId(null)}
            className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-200"
          >
            <ChevronLeft size={12} />
            Analysis tasks
          </button>

          <div>
            <p className="text-sm font-semibold text-gray-100">{selectedTask.title}</p>
            {selectedTask.metric === 'thickness' && <p className="text-[10px] text-gray-500 mt-1">Recommended next step: Calculate GBM thickness.</p>}
            {selectedTask.metric === 'process' && <p className="text-[10px] text-gray-500 mt-1">Recommended next step: Calculate process NND.</p>}
            {selectedTask.metric == null && <p className="text-[10px] text-gray-500 mt-1">Recommended next step: View nuclei overlay.</p>}
          </div>

          {selectedTask.id === 'gbm' && (
            <label className="block">
              <span className="text-[10px] text-gray-500">Model</span>
              <select
                value={nhsMode}
                onChange={e => setNhsMode(e.target.value)}
                className="ux-select mt-1"
              >
                <option value="single-channel">NHS single-channel</option>
                <option value="combined-actn4">NHS + ACTN4</option>
              </select>
            </label>
          )}

          <div className="space-y-2">
            <p className="ux-section-label">Channel mapping</p>
            {rolesForTask.map(role => {
              const info = roleInfo(role)
              const value = channelIndexForRole(channelMapping, role)
              return (
                <label key={role} className="block">
                  <span className="text-[10px] text-gray-500">{info.label} channel</span>
                  <select
                    value={value ?? ''}
                    onChange={e => onSetRoleChannel?.(role, Number(e.target.value))}
                    className="ux-select mt-1"
                  >
                    <option value="" disabled>Choose channel</option>
                    {Array.from({ length: numChannels }, (_, i) => (
                      <option key={i} value={i}>{channelLabel(channelMapping, i)}</option>
                    ))}
                  </select>
                </label>
              )
            })}
          </div>

          <button
            onClick={() => setAdvancedOpen(value => !value)}
            className="w-full flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-500 hover:text-gray-200"
          >
            <span>Advanced settings</span>
            {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>

          {advancedOpen && (
            <div className="ux-card space-y-2 p-3">
              {imgMeta.numZSlices > 1 && (
                <label className="block">
                  <span className="text-[10px] text-gray-500">Z-slice</span>
                  <input
                    type="number"
                    min={0}
                    max={imgMeta.numZSlices - 1}
                    value={zIndex}
                    onChange={e => setZIndex(clampIndex(e.target.value, imgMeta.numZSlices))}
                    className="ux-input mt-1"
                  />
                </label>
              )}

              <div className="grid grid-cols-[1fr_3.5rem] gap-2">
                <label>
                  <span className="text-[10px] text-gray-500">Pixel size</span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={pixelSize}
                    onChange={e => setPixelSize(e.target.value)}
                    className="ux-input mt-1"
                  />
                </label>
                <label>
                  <span className="text-[10px] text-gray-500">Unit</span>
                  <input
                    value={pixelUnit}
                    onChange={e => setPixelUnit(e.target.value)}
                    className="ux-input mt-1"
                  />
                </label>
              </div>

              <div className="grid grid-cols-[1fr_4.5rem] gap-2 items-end">
                <label className="flex items-center gap-1.5 text-[11px] text-gray-300 pb-1">
                  <input
                    type="checkbox"
                    checked={expanded}
                    onChange={e => setExpanded(e.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  <span>Expanded</span>
                </label>
                <label>
                  <span className="text-[10px] text-gray-500">Factor</span>
                  <input
                    type="number"
                    min="0.001"
                    step="any"
                    value={expansionFactor}
                    onChange={e => setExpansionFactor(e.target.value)}
                    className="ux-input mt-1"
                  />
                </label>
              </div>
            </div>
          )}

          {missingRoles.length > 0 && (
            <p className="text-[10px] text-amber-300">
              Assign {missingRoles.map(role => roleInfo(role).label).join(', ')} before running.
            </p>
          )}

          {matchingSavedRun && (
            <div className="ux-card space-y-2 p-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={12} className="text-[var(--accent)]" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-gray-200">Saved {runSummary(matchingSavedRun)}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => selectSegmentationRun(matchingSavedRun)}
                  className="ux-button ux-button-secondary text-[10px]"
                >
                  Use saved
                </button>
                <button
                  onClick={() => deleteSavedRun(matchingSavedRun)}
                  disabled={deletingRunId === matchingSavedRun.runId}
                  className="ux-button ux-button-danger text-[10px]"
                >
                  {deletingRunId === matchingSavedRun.runId ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                  Delete
                </button>
              </div>
            </div>
          )}

          <button
            onClick={startRun}
            disabled={!canRun}
            className={`ux-button w-full ${canRun ? 'ux-button-primary' : 'ux-button-secondary cursor-not-allowed opacity-50'}`}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {busy ? 'Running...' : matchingSavedRun ? 'Run again' : selectedTask.action}
          </button>
        </div>
      )}

      {run?.progress && busy && (
        <div className="text-[10px] text-gray-500">
          <span className="text-gray-400">{run.progress.current || 'Queued'}</span>
          {run.progress.completed?.length > 0 && <span> / {run.progress.completed.join(', ')}</span>}
        </div>
      )}

      {overlayNames.length > 0 && (
        <div className="space-y-2 border-t border-[var(--border)] pt-3">
          <p className="ux-section-label">Overlay controls</p>
          {overlayNames.map(name => (
            <div key={name} className="space-y-1">
              <button
                onClick={() => setVisibleOverlays(prev => ({ ...prev, [name]: prev[name] === false ? 0.85 : false }))}
                className="w-full flex items-center gap-2 text-[10px] text-gray-400 hover:text-gray-200"
              >
                {visibleOverlays[name] === false ? <EyeOff size={11} /> : <Eye size={11} />}
                <span className="truncate">{overlayLabel(name)}</span>
              </button>
              {visibleOverlays[name] !== false && (
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={typeof visibleOverlays[name] === 'number' ? visibleOverlays[name] : 1}
                  onChange={e => setVisibleOverlays(prev => ({ ...prev, [name]: Number(e.target.value) }))}
                  className="w-full"
                />
              )}
            </div>
          ))}
          {thickness && (
            <button
              onClick={() => setVisibleVectors?.(prev => ({ ...prev, thickness: prev.thickness === false }))}
              className="w-full flex items-center gap-2 text-[10px] text-gray-400 hover:text-gray-200"
            >
              {visibleVectors?.thickness === false ? <EyeOff size={11} /> : <Eye size={11} />}
              <span className="truncate">Thickness map</span>
            </button>
          )}
          {processMetric && (
            <button
              onClick={() => setVisibleVectors?.(prev => ({ ...prev, process: prev.process === false }))}
              className="w-full flex items-center gap-2 text-[10px] text-gray-400 hover:text-gray-200"
            >
              {visibleVectors?.process === false ? <EyeOff size={11} /> : <Eye size={11} />}
              <span className="truncate">NND vectors</span>
            </button>
          )}
        </div>
      )}

      {succeeded && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1 rounded-md border border-[var(--border)] bg-[var(--canvas-bg)] p-1">
            <button
              onClick={() => setMetricScope('whole')}
              className={`px-2 py-1 rounded text-[10px] ${metricScope === 'whole' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-subtle)] hover:text-[var(--text)]'}`}
            >
              Whole image
            </button>
            <button
              onClick={() => setMetricScope('selected')}
              disabled={!analysisRoi}
              className={`px-2 py-1 rounded text-[10px] ${metricScope === 'selected' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-subtle)] hover:text-[var(--text)] disabled:opacity-40'}`}
            >
              Selected ROI
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => computeMetric('thickness')}
              disabled={metricBusy || !hasNhs}
              className="ux-button ux-button-secondary text-[11px]"
            >
              {thicknessBusy ? <Loader2 size={11} className="animate-spin" /> : <Ruler size={11} />}
              GBM thickness
            </button>
            <button
              onClick={() => computeMetric('process')}
              disabled={metricBusy || !hasActn4}
              className="ux-button ux-button-secondary text-[11px]"
            >
              {processBusy ? <Loader2 size={11} className="animate-spin" /> : <Waypoints size={11} />}
              Process NND
            </button>
          </div>
        </div>
      )}

      {thickness && (
        <div className="ux-card space-y-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-gray-100">GBM Thickness</p>
            <button
              onClick={() => setVisibleVectors?.(prev => ({ ...prev, thickness: prev.thickness === false }))}
              className="ux-icon-button h-6 w-6"
              title="Toggle thickness map"
            >
              {visibleVectors?.thickness === false ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[10px] text-gray-400">
            <span>Mean thickness</span>
            <span className="text-right text-gray-100">{formatMetric(thickness.meanThickness)} {thickness.unit || ''}</span>
            <span>Measurement points</span>
            <span className="text-right text-gray-100">{formatCount(thickness.points?.length)}</span>
          </div>
          <div className="flex gap-2">
            {thickness.artifacts?.csv && (
              <a
                href={artifactUrl(run.runId, thickness.artifacts.csv)}
                className="ux-button ux-button-secondary flex-1 text-center text-[10px]"
              >
                CSV
              </a>
            )}
            {nhsSegmentation && (
              <a
                href={artifactUrl(run.runId, nhsSegmentation)}
                className="ux-button ux-button-secondary flex-1 text-[10px]"
              >
                <Download size={10} /> TIFF
              </a>
            )}
          </div>
        </div>
      )}

      {processMetric && (
        <div className="ux-card space-y-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-gray-100">Process NND</p>
            <button
              onClick={() => setVisibleVectors?.(prev => ({ ...prev, process: prev.process === false }))}
              className="ux-icon-button h-6 w-6"
              title="Toggle NND vectors"
            >
              {visibleVectors?.process === false ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[10px] text-gray-400">
            <span>Mean distance</span>
            <span className="text-right text-gray-100">{formatMetric(processMetric.meanDistance)} {processMetric.unit || ''}</span>
            <span>Detected processes</span>
            <span className="text-right text-gray-100">{formatCount(processMetric.pairs?.length)}</span>
          </div>
          <div className="flex gap-2">
            {processMetric.artifacts?.csv && (
              <a
                href={artifactUrl(run.runId, processMetric.artifacts.csv)}
                className="ux-button ux-button-secondary flex-1 text-center text-[10px]"
              >
                CSV
              </a>
            )}
            {processMetric.artifacts?.labels && (
              <a
                href={artifactUrl(run.runId, processMetric.artifacts.labels)}
                className="ux-button ux-button-secondary flex-1 text-center text-[10px]"
              >
                Labels
              </a>
            )}
            {actn4Segmentation && (
              <a
                href={artifactUrl(run.runId, actn4Segmentation)}
                className="ux-button ux-button-secondary flex-1 text-center text-[10px]"
              >
                TIFF
              </a>
            )}
          </div>
        </div>
      )}

      {(error || run?.error) && (
        <p className="text-[10px] text-red-300 leading-snug break-words">{error || run.error}</p>
      )}
    </div>
  )
}


