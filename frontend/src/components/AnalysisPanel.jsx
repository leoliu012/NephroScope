import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Play,
  Ruler,
  ScanLine,
  Trash2,
  Waypoints,
  XCircle,
} from 'lucide-react'
import { channelIndexForRole, channelLabel, roleInfo } from '../channelMapping.js'
import AnalysisHistory from './analysis/AnalysisHistory.jsx'
import AnalysisLayerPanel from './analysis/AnalysisLayerPanel.jsx'
import MetricResultCard from './analysis/MetricResultCard.jsx'
import ProcessDegroupingPanel from './analysis/ProcessDegroupingPanel.jsx'
import { API, fetchJson } from './analysis/analysisApi.js'
import { defaultWatershedPayload } from './analysis/analysisPresets.js'

const TASKS = [
  {
    id: 'full',
    title: 'Full Kidney Analysis',
    description: 'Run ACTN4 and NHS segmentation once, then calculate GBM thickness and process NND from the same result.',
    modelLabel: 'ACTN4 + NHS Ester',
    models: { actn4: true, dapi: false, nhs: true },
    roles: ['nhs', 'actn4'],
    recommended: true,
  },
  {
    id: 'gbm',
    title: 'GBM Thickness',
    description: 'Segment NHS Ester and calculate glomerular basement membrane thickness.',
    modelLabel: 'NHS Ester',
    models: { actn4: false, dapi: false, nhs: true },
    roles: ['nhs'],
  },
  {
    id: 'process',
    title: 'Process NND',
    description: 'Segment ACTN4, separate touching processes, and calculate nearest-neighbor distance.',
    modelLabel: 'ACTN4',
    models: { actn4: true, dapi: false, nhs: false },
    roles: ['actn4'],
  },
]

function clampIndex(value, n) {
  return Math.max(0, Math.min(Math.max(0, n - 1), Number(value) || 0))
}

function isRemovedDapiArtifact(name) {
  const basename = String(name).split('/').pop()
  return basename === 'overlay_DAPI.png' || basename === 'overlay_NHS_NUCLEI.png'
}

function defaultOverlayOpacity(name) {
  const basename = String(name).split('/').pop()
  if (basename === 'overlay_ACTN4.png') return 0.45
  if (basename === 'overlay_NHS_GBM.png') return 0.55
  if (basename === 'proc_outer_contours.png') return 0.75
  if (basename === 'proc_contours.png') return 0.90
  return 0.85
}

function runModelNames(run) {
  return run?.request?.modelNames || []
}

function runSupportsTask(run, taskId) {
  const names = runModelNames(run)
  const hasActn4 = names.includes('ACTN4')
  const hasNhs = names.some(name => String(name).startsWith('NHS_'))
  if (taskId === 'full') return hasActn4 && hasNhs
  if (taskId === 'process') return hasActn4
  if (taskId === 'gbm') return hasNhs
  return false
}

function runSummary(run) {
  const names = runModelNames(run)
  const labels = []
  if (names.includes('ACTN4')) labels.push('ACTN4')
  if (names.some(name => String(name).startsWith('NHS_'))) labels.push('NHS')
  return labels.length ? `${labels.join(' + ')} segmentation` : (run?.operation || 'Segmentation')
}

function hasVisibleSegmentation(run) {
  return runModelNames(run).length > 0
}

function metricKind(run) {
  if (run?.operation === 'gbm-thickness') return 'thickness'
  if (run?.operation === 'process-nnd') return 'process'
  return null
}

function latestMetricsByKind(metrics) {
  const latest = { thickness: null, process: null }
  const latestSucceeded = { thickness: null, process: null }
  metrics.forEach(metricRun => {
    const kind = metricKind(metricRun)
    if (!kind) return
    if (!latest[kind]) latest[kind] = metricRun
    if (metricRun.status === 'SUCCEEDED' && !latestSucceeded[kind]) latestSucceeded[kind] = metricRun
  })
  return {
    thickness: latestSucceeded.thickness || latest.thickness,
    process: latestSucceeded.process || latest.process,
  }
}

function upsertMetricRun(metrics, nextRun) {
  const existing = Array.isArray(metrics) ? metrics : []
  const filtered = existing.filter(metric => metric.runId !== nextRun.runId)
  return [nextRun, ...filtered].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}

function fmt(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 'Not available'
  if (Math.abs(parsed) < 0.001 || Math.abs(parsed) >= 100) return parsed.toExponential(2)
  return parsed.toFixed(4)
}

function TaskCard({ task, onClick }) {
  return (
    <button onClick={onClick} className="ux-card ux-card-action w-full px-3 py-3 text-left">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold text-gray-100">{task.title}</p>
            {task.recommended && <span className="ux-badge ux-badge-neutral px-1.5 py-0.5 text-[8px]">Recommended</span>}
          </div>
          <p className="mt-1 text-[11px] leading-snug text-gray-500">{task.description}</p>
          <p className="mt-1 text-[10px] text-gray-600">Model: {task.modelLabel}</p>
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
  zIndex = 0,
  onZIndexChange,
  displayProjection = 'slice',
  onDisplayProjectionChange,
  analysisRoi,
  onClearAnalysisRoi,
  selectedAnnotationRoi,
  onUseSelectedAnnotationRoi,
  onActivateAnalysisRoiTool,
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
  const [nhsMode, setNhsMode] = useState('single-channel')
  const [pixelSize, setPixelSize] = useState('')
  const [pixelUnit, setPixelUnit] = useState('um')
  const [effectivePixelSizeOverride, setEffectivePixelSizeOverride] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [metricScope, setMetricScope] = useState('whole')
  const [expanded, setExpanded] = useState(true)
  const [expansionFactor, setExpansionFactor] = useState(7)
  const [watershed, setWatershed] = useState(() => defaultWatershedPayload())
  const [processSettingsDirty, setProcessSettingsDirty] = useState(false)
  const [savedRuns, setSavedRuns] = useState([])
  const [savedRunMetrics, setSavedRunMetrics] = useState({})
  const [savedRunsLoading, setSavedRunsLoading] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [deletingRunId, setDeletingRunId] = useState(null)
  const [error, setError] = useState(null)
  const [metricRuns, setMetricRuns] = useState({ thickness: null, process: null })

  const selectedTask = TASKS.find(task => task.id === taskId)
  const preprocessingMode = 'percentile-stretch'
  const reusableSavedRuns = useMemo(() => savedRuns.filter(item => {
    if (!['SUCCEEDED', 'RUNNING', 'QUEUED'].includes(item.status)) return false
    return hasVisibleSegmentation(item)
  }), [savedRuns])

  useEffect(() => {
    if (!imgMeta) return
    setTaskId(null)
    setNhsMode('single-channel')
    setPixelSize(imgMeta.pixelSize ?? '')
    setPixelUnit(imgMeta.pixelUnit || 'um')
    setEffectivePixelSizeOverride('')
    setSettingsOpen(false)
    setMetricScope('whole')
    setExpanded(true)
    setExpansionFactor(7)
    setWatershed(defaultWatershedPayload())
    setProcessSettingsDirty(false)
    setSavedRuns([])
    setSavedRunMetrics({})
    setHistoryOpen(false)
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

  const loadMetricRunsForSegmentation = useCallback(async (segmentationRun) => {
    if (!segmentationRun?.runId || segmentationRun.status !== 'SUCCEEDED') return []
    try {
      const response = await fetchJson(`${API}/analysis-runs/${encodeURIComponent(segmentationRun.runId)}/metrics`)
      const metrics = response.runs || []
      setSavedRunMetrics(prev => ({ ...prev, [segmentationRun.runId]: metrics }))
      return metrics
    } catch (err) {
      setError(err.message)
      return []
    }
  }, [])

  const selectSegmentationRun = useCallback(async (nextRun) => {
    setRun(nextRun)
    setThickness(null)
    setProcessMetric(null)
    setMetricRuns({ thickness: null, process: null })
    setVisibleOverlays({})
    setVisibleVectors?.({ thickness: true, process: true })
    setError(null)
    const restoredCalibration = nextRun?.request?.calibration || {}
    setPixelSize(restoredCalibration.pixelSize ?? '')
    setPixelUnit(restoredCalibration.pixelUnit || 'um')
    setExpanded(restoredCalibration.expanded ?? true)
    setExpansionFactor(restoredCalibration.expansionFactor ?? 7)
    setEffectivePixelSizeOverride(
      restoredCalibration.effectivePixelSizeSource === 'override'
        ? (restoredCalibration.effectivePixelSizeOverride ?? restoredCalibration.effectivePixelSize ?? '')
        : ''
    )
    const requestZ = nextRun?.request?.zIndex
    if (Number.isFinite(Number(requestZ))) onZIndexChange?.(clampIndex(requestZ, imgMeta?.numZSlices || 1))
    const metrics = await loadMetricRunsForSegmentation(nextRun)
    const byKind = latestMetricsByKind(metrics)
    const restoredProcessMetric = byKind.process?.status === 'SUCCEEDED' ? byKind.process.result : null
    const restoredWatershed = restoredProcessMetric?.watershed || byKind.process?.request?.watershed
    const restoredMetricCalibration = restoredProcessMetric?.calibration
      || byKind.process?.request?.calibration
      || byKind.thickness?.result?.calibration
      || byKind.thickness?.request?.calibration
    if (restoredMetricCalibration) {
      setPixelSize(restoredMetricCalibration.pixelSize ?? '')
      setPixelUnit(restoredMetricCalibration.pixelUnit || 'um')
      setExpanded(restoredMetricCalibration.expanded ?? true)
      setExpansionFactor(restoredMetricCalibration.expansionFactor ?? 7)
      setEffectivePixelSizeOverride(
        restoredMetricCalibration.effectivePixelSizeSource === 'override'
          ? (restoredMetricCalibration.effectivePixelSizeOverride ?? restoredMetricCalibration.effectivePixelSize ?? '')
          : ''
      )
    }
    setMetricRuns(byKind)
    setThickness(byKind.thickness?.status === 'SUCCEEDED' ? byKind.thickness.result : null)
    setProcessMetric(restoredProcessMetric)
    if (restoredWatershed) setWatershed(restoredWatershed)
    setProcessSettingsDirty(false)
  }, [imgMeta?.numZSlices, loadMetricRunsForSegmentation, onZIndexChange, setRun, setThickness, setProcessMetric, setVisibleOverlays, setVisibleVectors])

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
        const latestReusable = runs.find(item =>
          ['SUCCEEDED', 'RUNNING', 'QUEUED'].includes(item.status) && hasVisibleSegmentation(item)
        )
        if (latestReusable) await selectSegmentationRun(latestReusable)
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
    if (!historyOpen) return
    reusableSavedRuns.forEach(savedRun => {
      if (savedRun.status === 'SUCCEEDED' && savedRunMetrics[savedRun.runId] == null) {
        loadMetricRunsForSegmentation(savedRun)
      }
    })
  }, [historyOpen, reusableSavedRuns, savedRunMetrics, loadMetricRunsForSegmentation])

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
          const parentRunId = latest.request?.segmentationRunId
          if (parentRunId) {
            setSavedRunMetrics(prev => ({
              ...prev,
              [parentRunId]: upsertMetricRun(prev[parentRunId], latest),
            }))
          }
          if (latest.status === 'SUCCEEDED') {
            if (kind === 'thickness') setThickness(latest.result)
            else setProcessMetric(latest.result)
          } else if (latest.status === 'FAILED') {
            if (kind === 'process') setProcessSettingsDirty(true)
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
  ].filter(name => !isRemovedDapiArtifact(name)), [run, processMetric])

  useEffect(() => {
    if (!overlayNames.length) return
    setVisibleOverlays(prev => {
      const next = { ...prev }
      overlayNames.forEach(name => {
        if (!(name in next)) next[name] = defaultOverlayOpacity(name)
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
  const assignedChannels = Object.values(channelPayload).filter(value => value != null)
  const duplicatedChannels = new Set(assignedChannels).size !== assignedChannels.length
  const calibrationPayload = useMemo(() => ({
    pixelSize: pixelSize === '' ? null : Number(pixelSize),
    pixelUnit,
    expanded,
    expansionFactor: Number(expansionFactor),
    effectivePixelSizeOverride: effectivePixelSizeOverride === '' ? null : Number(effectivePixelSizeOverride),
  }), [effectivePixelSizeOverride, expanded, expansionFactor, pixelSize, pixelUnit])

  const startRun = async () => {
    if (!selectedTask) return
    setError(null)
    setThickness(null)
    setProcessMetric(null)
    setMetricRuns({ thickness: null, process: null })
    setProcessSettingsDirty(false)
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
          calibration: calibrationPayload,
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
      setSavedRunMetrics(prev => {
        const next = { ...prev }
        delete next[runToDelete.runId]
        return next
      })
      if (run?.runId === runToDelete.runId) {
        const replacement = nextRuns.find(item => ['SUCCEEDED', 'RUNNING', 'QUEUED'].includes(item.status) && hasVisibleSegmentation(item))
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

  const duplicateRunSettings = useCallback((sourceRun) => {
    const request = sourceRun?.request || {}
    const names = request.modelNames || []
    const hasActn4 = names.includes('ACTN4')
    const hasNhs = names.some(name => String(name).startsWith('NHS_'))
    if (hasActn4 && hasNhs) setTaskId('full')
    else if (hasNhs) setTaskId('gbm')
    else if (hasActn4) setTaskId('process')

    setNhsMode(request.nhsMode || (names.includes('NHS_COMBINED_ACTN4') ? 'combined-actn4' : 'single-channel'))
    onZIndexChange?.(clampIndex(request.zIndex ?? 0, imgMeta?.numZSlices || 1))
    const calibration = request.calibration || {}
    setPixelSize(calibration.pixelSize ?? '')
    setPixelUnit(calibration.pixelUnit || 'um')
    setExpanded(calibration.expanded ?? true)
    setExpansionFactor(calibration.expansionFactor ?? 7)
    setEffectivePixelSizeOverride(
      calibration.effectivePixelSizeSource === 'override'
        ? (calibration.effectivePixelSizeOverride ?? calibration.effectivePixelSize ?? '')
        : ''
    )
    Object.entries(request.channels || {}).forEach(([role, channel]) => {
      if (role !== 'dapi' && channel != null) onSetRoleChannel?.(role, Number(channel))
    })
    setSettingsOpen(true)
    setError(null)
  }, [imgMeta?.numZSlices, onSetRoleChannel, onZIndexChange])

  const queueMetric = useCallback(async (kind) => {
    if (!run?.runId || run.status !== 'SUCCEEDED') return null
    const path = kind === 'thickness' ? 'gbm-thickness' : 'process-nnd'
    const roi = metricScope === 'selected' ? analysisRoi : null
    const payload = { roi, calibration: calibrationPayload }
    if (kind === 'process') payload.watershed = watershed
    const metricRun = await fetchJson(`${API}/analysis-runs/${encodeURIComponent(run.runId)}/metrics/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setMetricRuns(prev => ({ ...prev, [kind]: metricRun }))
    setSavedRunMetrics(prev => ({
      ...prev,
      [run.runId]: upsertMetricRun(prev[run.runId], {
        ...metricRun,
        createdAt: new Date().toISOString(),
        request: { ...payload, segmentationRunId: run.runId },
      }),
    }))
    if (kind === 'thickness') setThickness(null)
    else {
      setProcessMetric(null)
      setProcessSettingsDirty(false)
    }
    return metricRun
  }, [analysisRoi, calibrationPayload, metricScope, run, setProcessMetric, setThickness, watershed])

  const invalidateDisplayedProcessMetric = useCallback(() => {
    setProcessMetric(null)
    setMetricRuns(prev => ({ ...prev, process: null }))
    setProcessSettingsDirty(true)
  }, [setProcessMetric])

  const handleWatershedChange = useCallback((nextWatershed) => {
    setWatershed(nextWatershed)
    invalidateDisplayedProcessMetric()
  }, [invalidateDisplayedProcessMetric])

  const computeMetric = async kind => {
    setError(null)
    try {
      await queueMetric(kind)
    } catch (err) {
      setError(err.message)
    }
  }

  const computeAllAvailable = async () => {
    setError(null)
    try {
      const jobs = []
      if (hasNhs) jobs.push(queueMetric('thickness'))
      if (hasActn4) jobs.push(queueMetric('process'))
      await Promise.all(jobs)
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
  const nhsSegmentation = segmentations.NHS_SINGLE_CHANNEL || segmentations.NHS_COMBINED_ACTN4
  const actn4Segmentation = segmentations.ACTN4
  const numericPixelSize = Number(pixelSize)
  const numericFactor = Number(expansionFactor)
  const numericEffectiveOverride = Number(effectivePixelSizeOverride)
  const hasEffectiveOverride = effectivePixelSizeOverride !== '' && Number.isFinite(numericEffectiveOverride) && numericEffectiveOverride > 0
  const effectivePixelSize = hasEffectiveOverride
    ? numericEffectiveOverride
    : Number.isFinite(numericPixelSize) && numericPixelSize > 0
      ? (expanded && Number.isFinite(numericFactor) && numericFactor > 0 ? numericPixelSize / numericFactor : numericPixelSize)
      : null
  const calibrationReady = Number.isFinite(effectivePixelSize) && effectivePixelSize > 0
  const effectivePixelSizeSource = hasEffectiveOverride
    ? 'Direct effective-size override'
    : expanded
      ? 'Raw pixel size / expansion factor'
      : 'Raw pixel size'

  if (!imgMeta) return null

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="flex items-center gap-2">
        <p className="ux-section-label">Analysis</p>
        {busy && <Loader2 size={12} className="ml-auto animate-spin text-[var(--accent)]" />}
        {succeeded && <CheckCircle2 size={12} className="ml-auto text-[var(--success)]" />}
        {failed && <XCircle size={12} className="ml-auto text-red-400" />}
      </div>

      {!selectedTask ? (
        <div className="space-y-2">
          {TASKS.map(task => <TaskCard key={task.id} task={task} onClick={() => setTaskId(task.id)} />)}
          <AnalysisHistory
            runs={reusableSavedRuns}
            activeRunId={run?.runId}
            metricsByRun={savedRunMetrics}
            loading={savedRunsLoading}
            open={historyOpen}
            onToggleOpen={() => setHistoryOpen(value => !value)}
            onRestore={selectSegmentationRun}
            onDuplicateSettings={duplicateRunSettings}
            onDelete={deleteSavedRun}
            deletingRunId={deletingRunId}
          />
        </div>
      ) : (
        <div className="space-y-3">
          <button onClick={() => setTaskId(null)} className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-200">
            <ChevronLeft size={12} />
            Analysis workflows
          </button>

          <div>
            <p className="text-sm font-semibold text-gray-100">{selectedTask.title}</p>
            <p className="mt-1 text-[11px] leading-snug text-gray-500">{selectedTask.description}</p>
          </div>

          {selectedTask.models.nhs && (
            <label className="block">
              <span className="text-[10px] text-gray-500">NHS model</span>
              <select value={nhsMode} onChange={e => setNhsMode(e.target.value)} className="ux-select mt-1">
                <option value="single-channel">NHS single-channel</option>
                <option value="combined-actn4">NHS + ACTN4 input</option>
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

          <button onClick={() => setSettingsOpen(open => !open)} className="flex w-full items-center justify-between text-[11px] text-gray-500 hover:text-gray-200">
            <span>Analysis settings</span>
            {settingsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>

          {settingsOpen && (
            <div className="ux-card space-y-3 p-3">
              {imgMeta.numZSlices > 1 && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[10px] text-gray-500">
                    <span>Analysis Z-slice</span>
                    <span className="font-mono text-gray-300">{zIndex + 1} / {imgMeta.numZSlices}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={imgMeta.numZSlices - 1}
                    step={1}
                    value={zIndex}
                    onChange={e => onZIndexChange?.(clampIndex(e.target.value, imgMeta.numZSlices))}
                    className="w-full"
                  />
                  <div className="grid grid-cols-2 gap-1 pt-1">
                    <button
                      type="button"
                      onClick={() => onDisplayProjectionChange?.('slice')}
                      className={`rounded border px-2 py-1 text-[9px] ${displayProjection === 'slice' ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border)] text-gray-500'}`}
                    >
                      Show this slice
                    </button>
                    <button
                      type="button"
                      onClick={() => onDisplayProjectionChange?.('mip')}
                      className={`rounded border px-2 py-1 text-[9px] ${displayProjection === 'mip' ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border)] text-gray-500'}`}
                    >
                      MIP preview
                    </button>
                  </div>
                  {displayProjection === 'mip' && (
                    <p className="text-[9px] leading-snug text-amber-300">
                      MIP is for browsing only. Analysis still runs on Z-slice {zIndex + 1}.
                    </p>
                  )}
                </div>
              )}

              <div className="grid grid-cols-[1fr_3.5rem] gap-2">
                <label>
                  <span className="text-[10px] text-gray-500">Raw pixel size</span>
                  <input type="number" min="0" step="any" value={pixelSize} onChange={e => setPixelSize(e.target.value)} className="ux-input mt-1" />
                </label>
                <label>
                  <span className="text-[10px] text-gray-500">Unit</span>
                  <input value={pixelUnit} onChange={e => setPixelUnit(e.target.value)} className="ux-input mt-1" />
                </label>
              </div>

              <div className="grid grid-cols-[1fr_4.5rem] items-end gap-2">
                <label className="flex items-center gap-1.5 pb-1 text-[11px] text-gray-300">
                  <input type="checkbox" checked={expanded} onChange={e => setExpanded(e.target.checked)} />
                  <span>Apply expansion factor</span>
                </label>
                <label>
                  <span className="text-[10px] text-gray-500">Factor</span>
                  <input type="number" min="0.001" step="any" value={expansionFactor} onChange={e => setExpansionFactor(e.target.value)} className="ux-input mt-1" />
                </label>
              </div>

              <label className="block">
                <span className="text-[10px] text-gray-500">Effective pixel size override</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={effectivePixelSizeOverride}
                  onChange={e => setEffectivePixelSizeOverride(e.target.value)}
                  placeholder="Optional: enter post-EF size directly"
                  className="ux-input mt-1"
                />
                <span className="mt-1 block text-[9px] leading-snug text-gray-600">
                  Use this when TIFF metadata does not include XY pixel size. This value is already after EF correction.
                </span>
              </label>

              <div className="rounded border border-[var(--border)] bg-[var(--canvas-bg)] p-2 text-[10px] text-gray-500">
                <div>
                  Effective pixel size
                  <span className="ml-2 font-mono text-gray-200">{fmt(effectivePixelSize)} {pixelUnit} / px</span>
                </div>
                {calibrationReady && <p className="mt-1 text-[9px] text-gray-600">Source: {effectivePixelSizeSource}</p>}
              </div>

              {!calibrationReady && (
                <p className="rounded border border-amber-400/30 bg-amber-400/5 p-2 text-[9px] leading-snug text-amber-200">
                  Physical calibration is incomplete. Expansion factor alone is not a pixel size. Enter the raw XY pixel size or the effective pixel size after EF correction before computing measurements.
                </p>
              )}

              <button
                type="button"
                onClick={() => {
                  setPixelSize(imgMeta.pixelSize ?? '')
                  setPixelUnit(imgMeta.pixelUnit || 'um')
                  setEffectivePixelSizeOverride('')
                }}
                className="ux-button ux-button-ghost min-h-0 px-1 py-1 text-[10px]"
              >
                Reset to TIFF metadata
              </button>
            </div>
          )}

          {missingRoles.length > 0 && (
            <p className="text-[10px] text-amber-300">Assign {missingRoles.map(role => roleInfo(role).label).join(', ')} before running.</p>
          )}

          {matchingSavedRun && (
            <div className="ux-card space-y-2 p-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={12} className="text-[var(--accent)]" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-gray-200">Saved {runSummary(matchingSavedRun)}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => selectSegmentationRun(matchingSavedRun)} className="ux-button ux-button-secondary text-[10px]">Use saved</button>
                <button onClick={() => deleteSavedRun(matchingSavedRun)} disabled={deletingRunId === matchingSavedRun.runId} className="ux-button ux-button-danger text-[10px]">
                  {deletingRunId === matchingSavedRun.runId ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                  Delete
                </button>
              </div>
            </div>
          )}

          <button onClick={startRun} disabled={!canRun} className={`ux-button w-full ${canRun ? 'ux-button-primary' : 'ux-button-secondary cursor-not-allowed opacity-50'}`}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {busy ? 'Running segmentation...' : matchingSavedRun ? 'Run segmentation again' : 'Run segmentation'}
          </button>
        </div>
      )}

      {run?.progress && busy && (
        <div className="text-[10px] text-gray-500">
          <span className="text-gray-400">{run.progress.current || 'Queued'}</span>
          {run.progress.completed?.length > 0 && <span> / {run.progress.completed.join(', ')}</span>}
        </div>
      )}

      {succeeded && (
        <div className="space-y-3">
          <div className="ux-card space-y-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold text-gray-200">Measurement scope</p>
              {analysisRoi && <span className="font-mono text-[9px] text-[var(--accent)]">{Math.round(analysisRoi.width)} x {Math.round(analysisRoi.height)} px</span>}
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-md border border-[var(--border)] bg-[var(--canvas-bg)] p-1">
              <button onClick={() => setMetricScope('whole')} className={`rounded px-2 py-1 text-[10px] ${metricScope === 'whole' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-subtle)] hover:text-[var(--text)]'}`}>Whole image</button>
              <button onClick={() => setMetricScope('selected')} disabled={!analysisRoi} className={`rounded px-2 py-1 text-[10px] ${metricScope === 'selected' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-subtle)] hover:text-[var(--text)] disabled:opacity-40'}`}>Analysis ROI</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={onActivateAnalysisRoiTool} className="ux-button ux-button-secondary text-[10px]"><ScanLine size={11} />Draw ROI</button>
              <button onClick={onClearAnalysisRoi} disabled={!analysisRoi} className="ux-button ux-button-ghost text-[10px]">Clear ROI</button>
            </div>
            {selectedAnnotationRoi && (
              <button onClick={onUseSelectedAnnotationRoi} className="ux-button ux-button-ghost w-full min-h-0 py-1 text-[10px]">Use selected rectangle annotation as ROI</button>
            )}
          </div>

          {hasActn4 && (
            <ProcessDegroupingPanel
              value={watershed}
              onChange={handleWatershedChange}
              onApply={() => computeMetric('process')}
              dirty={processSettingsDirty}
              disabled={processBusy}
            />
          )}

          {hasNhs && hasActn4 && (
            <button onClick={computeAllAvailable} disabled={metricBusy || !calibrationReady} className="ux-button ux-button-primary w-full text-[11px]">
              {metricBusy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
              Compute all measurements
            </button>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => computeMetric('thickness')} disabled={metricBusy || !hasNhs || !calibrationReady} className="ux-button ux-button-secondary text-[11px]">
              {thicknessBusy ? <Loader2 size={11} className="animate-spin" /> : <Ruler size={11} />}
              GBM thickness
            </button>
            <button onClick={() => computeMetric('process')} disabled={metricBusy || !hasActn4 || !calibrationReady} className="ux-button ux-button-secondary text-[11px]">
              {processBusy ? <Loader2 size={11} className="animate-spin" /> : <Waypoints size={11} />}
              {processSettingsDirty ? 'Recompute Process NND' : 'Process NND'}
            </button>
          </div>
        </div>
      )}

      <AnalysisLayerPanel
        overlayNames={overlayNames}
        visibleOverlays={visibleOverlays}
        setVisibleOverlays={setVisibleOverlays}
        thickness={thickness}
        processMetric={processMetric}
        visibleVectors={visibleVectors}
        setVisibleVectors={setVisibleVectors}
      />

      <MetricResultCard
        kind="thickness"
        metric={thickness}
        metricRun={metricRuns.thickness}
        segmentationRun={run}
        segmentationArtifact={nhsSegmentation}
        vectorVisible={visibleVectors?.thickness}
        onToggleVector={() => setVisibleVectors?.(prev => ({ ...prev, thickness: prev.thickness === false }))}
      />

      <MetricResultCard
        kind="process"
        metric={processMetric}
        metricRun={metricRuns.process}
        segmentationRun={run}
        segmentationArtifact={actn4Segmentation}
        vectorVisible={visibleVectors?.process}
        onToggleVector={() => setVisibleVectors?.(prev => ({ ...prev, process: prev.process === false }))}
      />

      {(error || run?.error) && <p className="break-words text-[10px] leading-snug text-red-300">{error || run.error}</p>}
    </div>
  )
}
