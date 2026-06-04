import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
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
import { metricFingerprint, stableJson } from './analysis/metricFingerprint.js'

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
  if (basename === 'proc_included_contours.png') return 0.90
  if (basename === 'proc_excluded_contours.png') return false
  if (basename === 'proc_all_contours.png') return false
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

function fmtCount(value) {
  if (value == null || Number.isNaN(Number(value))) return '0'
  return new Intl.NumberFormat().format(Number(value))
}

function expectedModelNames(task, nhsMode) {
  if (!task) return []
  const names = []
  if (task.models.actn4) names.push('ACTN4')
  if (task.models.nhs) names.push(nhsMode === 'combined-actn4' ? 'NHS_COMBINED_ACTN4' : 'NHS_SINGLE_CHANNEL')
  return names.sort()
}

function blockersFor(capabilities, kind) {
  const key = kind === 'thickness' ? 'gbmThickness' : 'processNnd'
  return capabilities?.measurements?.[key]?.blockers || []
}

function capabilityAvailable(capabilities, kind, fallback) {
  const key = kind === 'thickness' ? 'gbmThickness' : 'processNnd'
  const item = capabilities?.measurements?.[key]
  return item ? Boolean(item.available) : fallback
}

function blockerMessage(blockers) {
  return blockers[0]?.message || null
}

function statusDot(ready, busy = false) {
  if (busy) return <Loader2 size={11} className="animate-spin text-[var(--accent)]" />
  if (ready) return <CheckCircle2 size={11} className="text-[var(--success)]" />
  return <AlertTriangle size={11} className="text-amber-300" />
}

function queryForCalibration(calibration) {
  const params = new URLSearchParams()
  Object.entries(calibration || {}).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value))
  })
  const query = params.toString()
  return query ? `?${query}` : ''
}

function savedRunMismatchSummary(savedRun, currentRequest) {
  const request = savedRun?.request || {}
  const differences = []
  if (Number(request.zIndex ?? 0) !== Number(currentRequest.zIndex ?? 0)) {
    differences.push(`Z-slice ${(request.zIndex ?? 0) + 1}`)
  }
  if (stableJson(request.channels || {}) !== stableJson(currentRequest.channels || {})) differences.push('a different channel mapping')
  if (stableJson([...(request.modelNames || [])].sort()) !== stableJson([...(currentRequest.modelNames || [])].sort())) differences.push('a different model set')
  if ((request.nhsMode || 'single-channel') !== (currentRequest.nhsMode || 'single-channel')) differences.push('a different NHS mode')
  if ((request.preprocessingMode || 'percentile-stretch') !== (currentRequest.preprocessingMode || 'percentile-stretch')) differences.push('a different preprocessing mode')
  return differences.length ? differences.join(' and ') : 'different analysis settings'
}

function latestSuccessfulSource(runs, kind) {
  return (runs || []).find(item => {
    if (item.status !== 'SUCCEEDED') return false
    const segmentations = item.result?.segmentations || {}
    if (kind === 'thickness') return Boolean(segmentations.NHS_SINGLE_CHANNEL || segmentations.NHS_COMBINED_ACTN4)
    return Boolean(segmentations.ACTN4)
  }) || null
}

function sourceModelLabel(source, kind) {
  if (!source) return kind === 'thickness' ? 'NHS Ester segmentation' : 'ACTN4 segmentation'
  const segmentations = source.result?.segmentations || {}
  if (kind === 'thickness') {
    if (segmentations.NHS_COMBINED_ACTN4) return 'NHS Ester + ACTN4 segmentation'
    return 'NHS Ester segmentation'
  }
  return 'ACTN4 segmentation'
}

function formatDate(value) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Not recorded'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function MetricSourceLine({ kind, source, busy, metric }) {
  const title = kind === 'thickness' ? 'GBM thickness' : 'Process NND'
  const value = kind === 'thickness' ? metric?.meanThickness : metric?.meanDistance
  const hasValue = Number.isFinite(Number(value))
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--canvas-bg)] p-2">
      <div className="flex items-center gap-2">
        {busy ? <Loader2 size={11} className="animate-spin text-[var(--accent)]" /> : source ? <CheckCircle2 size={11} className="text-[var(--success)]" /> : <AlertTriangle size={11} className="text-amber-300" />}
        <p className="min-w-0 flex-1 text-[11px] font-semibold text-gray-200">{title}</p>
        {hasValue && <span className="font-mono text-[10px] text-gray-100">{fmt(value)} {metric?.unit || ''}</span>}
      </div>
      <p className={`mt-1 text-[10px] leading-snug ${source ? 'text-gray-500' : 'text-amber-300'}`}>
        {busy && source
          ? `Calculating from ${sourceModelLabel(source, kind)} · ${formatDate(source.createdAt)}`
          : source
            ? `Using newest result · ${sourceModelLabel(source, kind)} · ${formatDate(source.createdAt)}`
            : kind === 'thickness'
              ? 'No NHS Ester segmentation available'
              : 'No ACTN4 segmentation available'}
      </p>
      {source && Number.isFinite(Number(source.request?.zIndex)) && (
        <p className="mt-0.5 text-[9px] text-gray-600">Z-slice {Number(source.request.zIndex) + 1}</p>
      )}
    </div>
  )
}

function AnalysisProgressCard({ run, selectedTask }) {
  const completed = new Set(run?.progress?.completed || [])
  const current = run?.progress?.current
  const modelSteps = []
  if (selectedTask?.models.actn4 || runModelNames(run).includes('ACTN4')) modelSteps.push({ id: 'ACTN4', label: 'ACTN4 segmentation' })
  if (selectedTask?.models.nhs || runModelNames(run).some(name => String(name).startsWith('NHS_'))) modelSteps.push({ id: 'NHS', label: 'NHS segmentation' })
  const steps = [
    { id: 'input', label: 'Input validation', complete: true },
    ...modelSteps.map(step => ({
      ...step,
      complete: step.id === 'NHS'
        ? [...completed].some(name => String(name).startsWith('NHS_'))
        : completed.has(step.id),
      active: step.id === 'NHS' ? String(current || '').startsWith('NHS_') : current === step.id,
    })),
    { id: 'gbm', label: 'GBM thickness', complete: false },
    { id: 'process', label: 'Process NND', complete: false },
    { id: 'qc', label: 'QC summary', complete: false },
  ]
  return (
    <div className="ux-card space-y-2 p-3">
      <p className="text-[11px] font-semibold text-gray-200">Analysis in progress</p>
      <div className="space-y-1">
        {steps.map(step => (
          <div key={step.id} className="flex items-center gap-2 text-[10px] text-gray-400">
            {step.complete ? <CheckCircle2 size={11} className="text-[var(--success)]" /> : step.active ? <Loader2 size={11} className="animate-spin text-[var(--accent)]" /> : <span className="h-2.5 w-2.5 rounded-full border border-gray-600" />}
            <span>{step.label}</span>
          </div>
        ))}
      </div>
      <p className="text-[9px] text-gray-600">You may continue reviewing the image while queued work runs.</p>
    </div>
  )
}

function MeasurementReadinessCard({
  capabilities,
  calibrationReady,
  busy,
  hasNhs,
  hasActn4,
  missingRoles,
  duplicatedChannels,
  onFixCalibration,
  onRunNhs,
  onRunActn4,
}) {
  const gbmBlockers = blockersFor(capabilities, 'thickness')
  const processBlockers = blockersFor(capabilities, 'process')
  const blockers = [...gbmBlockers, ...processBlockers]
  const uniqueBlockers = blockers.filter((blocker, index) =>
    blockers.findIndex(item => item.code === blocker.code) === index
  )
  const channelReady = !missingRoles.length && !duplicatedChannels
  const needsAttention = uniqueBlockers.length > 0 || !channelReady || !calibrationReady
  if (!needsAttention) return null

  const actionFor = blocker => {
    if (blocker.fixAction === 'OPEN_CALIBRATION') return <button type="button" onClick={onFixCalibration} className="ux-button ux-button-secondary min-h-0 px-2 py-1 text-[9px]">Fix calibration</button>
    if (blocker.fixAction === 'RUN_NHS_SEGMENTATION') return <button type="button" onClick={onRunNhs} className="ux-button ux-button-secondary min-h-0 px-2 py-1 text-[9px]">Run NHS segmentation</button>
    if (blocker.fixAction === 'RUN_ACTN4_SEGMENTATION') return <button type="button" onClick={onRunActn4} className="ux-button ux-button-secondary min-h-0 px-2 py-1 text-[9px]">Run ACTN4 segmentation</button>
    return null
  }

  return (
    <div className="ux-card space-y-2 border-amber-400/30 bg-amber-400/5 p-3">
      <div className="flex items-center gap-2">
        <AlertTriangle size={13} className="text-amber-300" />
        <p className="text-[11px] font-semibold text-amber-100">Measurements need attention</p>
      </div>
      <div className="space-y-1 text-[10px] text-gray-300">
        <div className="flex items-center gap-2">{statusDot(hasNhs || hasActn4, busy)}<span>Segmentation: {busy ? 'Running' : (hasNhs || hasActn4) ? 'Ready' : 'Missing'}</span></div>
        <div className="flex items-center gap-2">{statusDot(channelReady)}<span>Channel mapping: {channelReady ? 'Ready' : 'Needs assignment'}</span></div>
        <div className="flex items-center gap-2">{statusDot(calibrationReady)}<span>Physical calibration: {calibrationReady ? 'Ready' : 'Missing'}</span></div>
      </div>
      {!calibrationReady && !uniqueBlockers.some(blocker => blocker.fixAction === 'OPEN_CALIBRATION') && (
        <div className="flex items-center gap-2 rounded border border-amber-400/20 bg-black/10 p-2">
          <p className="min-w-0 flex-1 text-[10px] leading-snug text-amber-100">Enter the raw XY pixel size or provide the effective post-expansion size.</p>
          <button type="button" onClick={onFixCalibration} className="ux-button ux-button-secondary min-h-0 px-2 py-1 text-[9px]">Fix calibration</button>
        </div>
      )}
      {uniqueBlockers.map(blocker => (
        <div key={blocker.code} className="flex items-center gap-2 rounded border border-amber-400/20 bg-black/10 p-2">
          <p className="min-w-0 flex-1 text-[10px] leading-snug text-amber-100">{blocker.message}</p>
          {actionFor(blocker)}
        </div>
      ))}
    </div>
  )
}

function MeasurementCalibrationCard({
  open,
  onToggle,
  calibrationReady,
  attention,
  pixelSize,
  setPixelSize,
  pixelUnit,
  setPixelUnit,
  expanded,
  setExpanded,
  expansionFactor,
  setExpansionFactor,
  effectivePixelSizeOverride,
  setEffectivePixelSizeOverride,
  effectivePixelSize,
  effectivePixelSizeSource,
  pendingMetricIntent,
  onContinue,
  inputRef,
}) {
  const pendingLabel = pendingMetricIntent === 'all'
    ? 'all measurements'
    : pendingMetricIntent === 'process'
      ? 'Process NND'
      : pendingMetricIntent === 'thickness'
        ? 'GBM thickness'
        : 'measurements'
  return (
    <div className={`ux-card space-y-2 p-3 ${attention ? 'border-amber-400/70 bg-amber-400/5' : ''}`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="flex items-center gap-2">
          {calibrationReady ? <CheckCircle2 size={12} className="text-[var(--success)]" /> : <AlertTriangle size={12} className="text-amber-300" />}
          <span className="text-[11px] font-semibold text-gray-200">Calibration</span>
        </span>
        {open ? <ChevronDown size={12} className="text-gray-500" /> : <ChevronRight size={12} className="text-gray-500" />}
      </button>

      <p className={`text-[10px] leading-snug ${calibrationReady ? 'text-gray-500' : 'text-amber-300'}`}>
        {calibrationReady
          ? <>Effective size: <span className="font-mono text-gray-200">{fmt(effectivePixelSize)} {pixelUnit} / px</span> · {effectivePixelSizeSource}</>
          : 'Required before measurements can be calculated.'}
      </p>

      {open && (
        <div className="space-y-3 pt-1">
          <div className="grid grid-cols-[1fr_3.5rem] gap-2">
            <label>
              <span className="text-[10px] text-gray-500">Raw XY pixel size</span>
              <input
                ref={inputRef}
                type="number"
                min="0"
                step="any"
                value={pixelSize}
                onChange={e => setPixelSize(e.target.value)}
                className={`ux-input mt-1 ${attention && !calibrationReady ? 'border-amber-400/80' : ''}`}
              />
              {attention && !calibrationReady && (
                <span className="mt-1 block text-[9px] leading-snug text-amber-300">Required before calculating {pendingLabel}.</span>
              )}
            </label>
            <label>
              <span className="text-[10px] text-gray-500">Unit</span>
              <select value={pixelUnit} onChange={e => setPixelUnit(e.target.value)} className="ux-select mt-1 h-8 py-1 text-[11px]">
                <option value="nm">nm</option>
                <option value="um">um</option>
                <option value="mm">mm</option>
              </select>
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
            <span className="text-[10px] text-gray-500">Effective size after correction</span>
            <input
              type="number"
              min="0"
              step="any"
              value={effectivePixelSizeOverride}
              onChange={e => setEffectivePixelSizeOverride(e.target.value)}
              placeholder="Optional direct effective size"
              className="ux-input mt-1"
            />
            <span className="mt-1 block text-[9px] leading-snug text-gray-600">
              Leave blank to calculate from raw XY size and expansion factor.
            </span>
          </label>

          {pendingMetricIntent && (
            <button type="button" onClick={onContinue} className="ux-button ux-button-primary w-full text-[11px]">
              Continue with {pendingLabel}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function StepFrame({ step, title, status, children }) {
  return (
    <div className="analysis-step">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-[var(--accent)]">Step {step}</p>
          <h3 className="mt-0.5 text-sm font-semibold text-[var(--text)]">{title}</h3>
        </div>
        {status && <span className="ux-badge ux-badge-neutral flex-shrink-0">{status}</span>}
      </div>
      {children}
    </div>
  )
}

function PreflightRow({ ready, label, value, action }) {
  return (
    <div className="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--canvas-bg)] px-2 py-2 text-[12px]">
      {ready ? <CheckCircle2 size={13} className="text-[var(--success)]" /> : <AlertTriangle size={13} className="text-amber-300" />}
      <span className="min-w-0 flex-1 text-[var(--text-muted)]">{label}</span>
      <span className={`max-w-[8.5rem] truncate text-right font-mono ${ready ? 'text-[var(--text)]' : 'text-amber-200'}`}>{value}</span>
      {action}
    </div>
  )
}

function TaskCard({ task, onClick, compact = false }) {
  return (
    <button onClick={onClick} className={`ux-card ux-card-action w-full text-left ${compact ? 'px-3 py-2.5' : 'border-[var(--accent)]/50 bg-[var(--accent-soft)] px-3 py-4'}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={`${compact ? 'text-[12px]' : 'text-sm'} font-semibold text-gray-100`}>{task.title}</p>
            {task.recommended && <span className="ux-badge ux-badge-neutral px-2 py-1 text-[10px]">Recommended</span>}
          </div>
          {!compact && <p className="mt-2 text-[12px] leading-snug text-gray-300">{task.description}</p>}
          <p className="mt-1 text-[12px] text-gray-500">Model: {task.modelLabel}</p>
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
  onEditMapping,
  onReviewQc,
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
  const [taskId, setTaskId] = useState('full')
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
  const [capabilities, setCapabilities] = useState(null)
  const [autoMeasureRunId, setAutoMeasureRunId] = useState(null)
  const [measurementSetupOpen, setMeasurementSetupOpen] = useState(false)
  const [pendingMetricIntent, setPendingMetricIntent] = useState(null)
  const [calibrationAttention, setCalibrationAttention] = useState(false)
  const calibrationInputRef = useRef(null)

  const selectedTask = TASKS.find(task => task.id === taskId)
  const preprocessingMode = 'percentile-stretch'
  const reusableSavedRuns = useMemo(() => savedRuns.filter(item => {
    if (!['SUCCEEDED', 'RUNNING', 'QUEUED'].includes(item.status)) return false
    return hasVisibleSegmentation(item)
  }), [savedRuns])

  useEffect(() => {
    if (!imgMeta) return
    setTaskId('full')
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
    setCapabilities(null)
    setAutoMeasureRunId(null)
    setMeasurementSetupOpen(false)
    setPendingMetricIntent(null)
    setCalibrationAttention(false)
    setVisibleOverlays({})
    setVisibleVectors?.({ thickness: true, process: true })
    setError(null)
  }, [imgMeta?.cacheKey, caseId, filename]) // eslint-disable-line react-hooks/exhaustive-deps

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
    setCapabilities(null)
    setAutoMeasureRunId(null)
    setPendingMetricIntent(null)
    setCalibrationAttention(false)
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

  useEffect(() => {
    const metricRunId = metricRuns.process?.runId
    if (!processMetric || !metricRunId || metricRuns.process?.status !== 'SUCCEEDED') {
      setProcessMetric(prev => prev?.areaPreview ? { ...prev, areaPreview: null } : prev)
      return
    }

    const minPercentile = Number(watershed?.minAreaPercentile ?? 0)
    const maxPercentile = Number(watershed?.maxAreaPercentile ?? 100)
    const committedWatershed = metricRuns.process?.request?.watershed || processMetric?.watershed || {}
    const committedMin = Number(committedWatershed.minAreaPercentile ?? 0)
    const committedMax = Number(committedWatershed.maxAreaPercentile ?? 100)
    if (
      !Number.isFinite(minPercentile)
      || !Number.isFinite(maxPercentile)
      || minPercentile < 0
      || maxPercentile > 100
      || minPercentile >= maxPercentile
    ) return
    if (
      Number.isFinite(committedMin)
      && Number.isFinite(committedMax)
      && committedMin === minPercentile
      && committedMax === maxPercentile
    ) {
      setProcessMetric(prev => prev?.areaPreview ? { ...prev, areaPreview: null } : prev)
      return
    }

    const controller = new AbortController()
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const preview = await fetchJson(`${API}/analysis-runs/${encodeURIComponent(metricRunId)}/process-area-preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ minPercentile, maxPercentile }),
        })
        if (cancelled) return
        setProcessMetric(prev => prev ? { ...prev, areaPreview: { ...preview, unit: prev.unit || 'um' } } : prev)
      } catch (err) {
        if (!cancelled && err.name !== 'AbortError') setError(err.message)
      }
    }, 80)

    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [
    metricRuns.process?.runId,
    metricRuns.process?.status,
    Boolean(processMetric),
    processMetric?.unit,
    setProcessMetric,
    metricRuns.process?.request?.watershed?.minAreaPercentile,
    metricRuns.process?.request?.watershed?.maxAreaPercentile,
    processMetric?.watershed?.minAreaPercentile,
    processMetric?.watershed?.maxAreaPercentile,
    watershed?.minAreaPercentile,
    watershed?.maxAreaPercentile,
  ])

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

  const currentRunRequest = useMemo(() => ({
    zIndex,
    channels: channelPayload,
    modelNames: expectedModelNames(selectedTask, nhsMode),
    nhsMode,
    preprocessingMode,
  }), [channelPayload, nhsMode, preprocessingMode, selectedTask, zIndex])

  const currentRunFingerprint = useMemo(
    () => stableJson(currentRunRequest),
    [currentRunRequest]
  )

  const loadCapabilities = useCallback(async () => {
    if (!run?.runId) {
      setCapabilities(null)
      return null
    }
    try {
      const response = await fetchJson(
        `${API}/analysis-runs/${encodeURIComponent(run.runId)}/capabilities${queryForCalibration(calibrationPayload)}`
      )
      setCapabilities(response)
      return response
    } catch (err) {
      setCapabilities(null)
      return null
    }
  }, [calibrationPayload, run?.runId])

  useEffect(() => {
    if (!run?.runId) {
      setCapabilities(null)
      return
    }
    loadCapabilities()
  }, [loadCapabilities, run?.runId, run?.status])

  const startRun = async () => {
    if (!selectedTask) return
    setError(null)
    setThickness(null)
    setProcessMetric(null)
    setMetricRuns({ thickness: null, process: null })
    setCapabilities(null)
    setAutoMeasureRunId(null)
    setPendingMetricIntent(null)
    setCalibrationAttention(false)
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
      if (selectedTask.id === 'full') setAutoMeasureRunId(created.runId)
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
          setCapabilities(null)
          setAutoMeasureRunId(null)
          setPendingMetricIntent(null)
          setCalibrationAttention(false)
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

  const metricSources = useMemo(() => ({
    thickness: latestSuccessfulSource(
      [
        ...(run?.runId ? [run] : []),
        ...savedRuns.filter(item => item.runId !== run?.runId),
      ].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
      'thickness'
    ),
    process: latestSuccessfulSource(
      [
        ...(run?.runId ? [run] : []),
        ...savedRuns.filter(item => item.runId !== run?.runId),
      ].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
      'process'
    ),
  }), [run, savedRuns])

  const focusMeasurementCalibration = useCallback((intent) => {
    setPendingMetricIntent(intent)
    setMeasurementSetupOpen(true)
    setCalibrationAttention(true)
    window.setTimeout(() => calibrationInputRef.current?.focus(), 0)
  }, [])

  const queueMetric = useCallback(async (kind) => {
    const sourceRun = metricSources[kind]
    if (!sourceRun?.runId) {
      throw new Error(kind === 'thickness'
        ? 'No NHS Ester segmentation is available for GBM thickness.'
        : 'No ACTN4 segmentation is available for Process NND.')
    }
    const path = kind === 'thickness' ? 'gbm-thickness' : 'process-nnd'
    const roi = metricScope === 'selected' ? analysisRoi : null
    const payload = { roi, calibration: calibrationPayload }
    if (kind === 'process') payload.watershed = watershed
    const metricRun = await fetchJson(`${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/metrics/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const sourceRunId = metricRun.sourceSegmentationRunId || sourceRun.runId
    const createdAt = new Date().toISOString()
    const enrichedMetricRun = {
      ...metricRun,
      createdAt,
      request: { ...payload, segmentationRunId: sourceRunId },
    }
    setMetricRuns(prev => ({ ...prev, [kind]: enrichedMetricRun }))
    setSavedRunMetrics(prev => ({
      ...prev,
      [sourceRunId]: upsertMetricRun(prev[sourceRunId], enrichedMetricRun),
    }))
    if (kind === 'process') setProcessSettingsDirty(false)
    return enrichedMetricRun
  }, [analysisRoi, calibrationPayload, caseId, filename, metricScope, metricSources, watershed])

  const invalidateDisplayedProcessMetric = useCallback(() => {
    setProcessSettingsDirty(true)
  }, [])

  const handleWatershedChange = useCallback((nextWatershed) => {
    setWatershed(nextWatershed)
    invalidateDisplayedProcessMetric()
  }, [invalidateDisplayedProcessMetric])

  const requestMetric = async kind => {
    setError(null)
    const needsThickness = kind === 'thickness' || kind === 'all'
    const needsProcess = kind === 'process' || kind === 'all'
    if (needsThickness && !metricSources.thickness) {
      setError('No NHS Ester segmentation is available for GBM thickness.')
      return
    }
    if (needsProcess && !metricSources.process) {
      setError('No ACTN4 segmentation is available for Process NND.')
      return
    }
    if (!calibrationReady) {
      focusMeasurementCalibration(kind)
      return
    }
    setPendingMetricIntent(null)
    setCalibrationAttention(false)
    try {
      if (kind === 'all') {
        const jobs = []
        if (metricSources.thickness) jobs.push(queueMetric('thickness'))
        if (metricSources.process) jobs.push(queueMetric('process'))
        await Promise.all(jobs)
      } else {
        await queueMetric(kind)
      }
    } catch (err) {
      setError(err.message)
    }
  }

  const continuePendingMetric = () => {
    if (!pendingMetricIntent) return
    if (!calibrationReady) {
      focusMeasurementCalibration(pendingMetricIntent)
      return
    }
    requestMetric(pendingMetricIntent)
  }

  const computeMetric = async kind => {
    setError(null)
    try {
      await requestMetric(kind)
    } catch (err) {
      setError(err.message)
    }
  }

  const computeAllAvailable = async () => {
    await requestMetric('all')
  }

  const busy = run?.status === 'QUEUED' || run?.status === 'RUNNING'
  const succeeded = run?.status === 'SUCCEEDED'
  const failed = run?.status === 'FAILED'
  const segmentations = run?.result?.segmentations || {}
  const hasNhs = Boolean(segmentations.NHS_SINGLE_CHANNEL || segmentations.NHS_COMBINED_ACTN4)
  const hasActn4 = Boolean(segmentations.ACTN4)
  const sourceHasNhs = Boolean(metricSources.thickness)
  const sourceHasActn4 = Boolean(metricSources.process)
  const thicknessBusy = ['QUEUED', 'RUNNING'].includes(metricRuns.thickness?.status)
  const processBusy = ['QUEUED', 'RUNNING'].includes(metricRuns.process?.status)
  const metricBusy = thicknessBusy || processBusy
  const canRun = imgMeta && selectedTask && numChannels > 0 && !busy && !missingRoles.length && !duplicatedChannels
  const matchingSavedRun = selectedTask
    ? savedRuns.find(item =>
      runSupportsTask(item, selectedTask.id)
      && item.status === 'SUCCEEDED'
      && stableJson({
        zIndex: item.request?.zIndex,
        channels: item.request?.channels || {},
        modelNames: [...(item.request?.modelNames || [])].sort(),
        nhsMode: item.request?.nhsMode || 'single-channel',
        preprocessingMode: item.request?.preprocessingMode || 'percentile-stretch',
      }) === currentRunFingerprint
    )
    : null
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
  const thicknessAvailable = sourceHasNhs
  const processAvailable = sourceHasActn4
  const metricRoi = metricScope === 'selected' ? analysisRoi : null
  const currentThicknessFingerprint = metricFingerprint({
    runId: metricSources.thickness?.runId,
    roi: metricRoi,
    calibration: calibrationPayload,
    effectivePixelSize,
  })
  const currentProcessFingerprint = metricFingerprint({
    runId: metricSources.process?.runId,
    roi: metricRoi,
    calibration: calibrationPayload,
    effectivePixelSize,
    watershed,
  })
  const thicknessFingerprint = metricRuns.thickness ? metricFingerprint({
    runId: metricRuns.thickness.request?.segmentationRunId || metricSources.thickness?.runId,
    roi: metricRuns.thickness.request?.roi,
    calibration: metricRuns.thickness.request?.calibration,
  }) : null
  const processFingerprint = metricRuns.process ? metricFingerprint({
    runId: metricRuns.process.request?.segmentationRunId || metricSources.process?.runId,
    roi: metricRuns.process.request?.roi,
    calibration: metricRuns.process.request?.calibration,
    watershed: metricRuns.process.request?.watershed,
  }) : null
  const thicknessStale = Boolean(thickness && thicknessFingerprint && thicknessFingerprint !== currentThicknessFingerprint)
  const processStale = Boolean(processMetric && processFingerprint && processFingerprint !== currentProcessFingerprint)
  const thicknessResultSource = savedRuns.find(item => item.runId === metricRuns.thickness?.request?.segmentationRunId) || metricSources.thickness || run
  const processResultSource = savedRuns.find(item => item.runId === metricRuns.process?.request?.segmentationRunId) || metricSources.process || run
  const thicknessSegmentation = thicknessResultSource?.result?.segmentations?.NHS_SINGLE_CHANNEL
    || thicknessResultSource?.result?.segmentations?.NHS_COMBINED_ACTN4
  const processSegmentation = processResultSource?.result?.segmentations?.ACTN4
  const showMeasurements = succeeded || sourceHasNhs || sourceHasActn4
  const preflightRows = selectedTask ? [
    ...rolesForTask.map(role => {
      const value = channelPayload[role]
      return {
        key: role,
        ready: value != null,
        label: roleInfo(role).label,
        value: value != null ? channelLabel(channelMapping, value) : 'Not assigned',
      }
    }),
    {
      key: 'z',
      ready: true,
      label: 'Z-slice',
      value: imgMeta.numZSlices > 1 ? `${zIndex + 1} of ${imgMeta.numZSlices}` : 'Single slice',
    },
    {
      key: 'calibration',
      ready: calibrationReady,
      label: 'Calibration',
      value: calibrationReady ? `${fmt(effectivePixelSize)} ${pixelUnit} / px` : 'Missing',
    },
    {
      key: 'scope',
      ready: metricScope !== 'selected' || Boolean(analysisRoi),
      label: 'Scope',
      value: metricScope === 'selected' && analysisRoi
        ? `ROI ${Math.round(analysisRoi.width)} x ${Math.round(analysisRoi.height)} px`
        : metricScope === 'selected'
          ? 'ROI not drawn'
          : 'Whole image',
    },
  ] : []
  const analysisComplete = Boolean(thickness || processMetric)

  useEffect(() => {
    if (!autoMeasureRunId || autoMeasureRunId !== run?.runId || run?.status !== 'SUCCEEDED' || metricBusy) return
    if (!capabilities) return
    const canQueueAny = thicknessAvailable || processAvailable
    if (!canQueueAny) {
      const blockers = [
        ...blockersFor(capabilities, 'thickness'),
        ...blockersFor(capabilities, 'process'),
      ]
      const waitingForCalibration = blockers.some(blocker => blocker.code === 'CALIBRATION_REQUIRED')
      if (!waitingForCalibration) setAutoMeasureRunId(null)
      return
    }
    computeAllAvailable()
    setAutoMeasureRunId(null)
  }, [autoMeasureRunId, run?.runId, run?.status, metricBusy, capabilities, thicknessAvailable, processAvailable])

  if (!imgMeta) return null

  const scopeLabel = metricScope === 'selected' && analysisRoi ? 'Selected region' : 'Whole image'
  const latestMeasurementDate = metricRuns.thickness?.finishedAt
    || metricRuns.process?.finishedAt
    || metricRuns.thickness?.createdAt
    || metricRuns.process?.createdAt
    || run?.finishedAt
    || run?.createdAt
  const hasAnyMeasurement = Boolean(thickness || processMetric)

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="flex items-center gap-2">
        <p className="ux-section-label">Measurements</p>
        {busy || metricBusy ? <Loader2 size={12} className="ml-auto animate-spin text-[var(--accent)]" /> : null}
        {!busy && !metricBusy && hasAnyMeasurement && <CheckCircle2 size={12} className="ml-auto text-[var(--success)]" />}
        {!busy && !metricBusy && failed && <XCircle size={12} className="ml-auto text-red-400" />}
      </div>

      {!hasAnyMeasurement && (
        <div className="ux-card space-y-3 p-3">
          <div>
            <p className="text-sm font-semibold text-[var(--text)]">No measurements available for this image.</p>
            <p className="mt-1 text-[12px] leading-snug text-[var(--text-muted)]">
              Calculate GBM thickness and process nearest-neighbor distance from the available channels.
            </p>
          </div>
          {missingRoles.length > 0 && (
            <p className="rounded border border-amber-400/30 bg-amber-400/5 p-2 text-[12px] leading-snug text-amber-200">
              Assign {missingRoles.map(role => roleInfo(role).label).join(', ')} channels in Display before calculating measurements.
            </p>
          )}
          <button onClick={startRun} disabled={!canRun} className={`ux-button w-full ${canRun ? 'ux-button-primary' : 'ux-button-secondary cursor-not-allowed opacity-50'}`}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {busy ? 'Calculating measurements...' : 'Calculate kidney measurements'}
          </button>
        </div>
      )}

      {hasAnyMeasurement && (
        <div className="ux-card space-y-3 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-[var(--text)]">Kidney measurements</p>
            {latestMeasurementDate && <span className="text-[11px] text-[var(--text-subtle)]">{formatDate(latestMeasurementDate)}</span>}
          </div>

          <div className="rounded border border-[var(--border)] bg-[var(--canvas-bg)] p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[12px] font-semibold text-[var(--text)]">GBM thickness</p>
                <p className="mt-1 font-mono text-2xl font-semibold text-[var(--text)]">{fmt(thickness?.meanThickness)} {thickness?.unit || 'um'}</p>
                <p className="mt-1 text-[12px] text-[var(--text-subtle)]">Measured across {fmtCount(thickness?.points?.length)} points</p>
              </div>
              <div className="flex flex-col gap-2">
                <button type="button" onClick={() => setVisibleVectors?.(prev => ({ ...prev, thickness: prev.thickness === false }))} className="ux-button ux-button-secondary min-h-0 px-2 py-1 text-[11px]">
                  {visibleVectors?.thickness === false ? 'Show overlay' : 'Hide overlay'}
                </button>
                <button type="button" onClick={() => requestMetric('thickness')} disabled={metricBusy || !thicknessAvailable} className="ux-button ux-button-secondary min-h-0 px-2 py-1 text-[11px]">
                  Recalculate
                </button>
              </div>
            </div>
          </div>

          <div className="rounded border border-[var(--border)] bg-[var(--canvas-bg)] p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[12px] font-semibold text-[var(--text)]">Process nearest-neighbor distance</p>
                <p className="mt-1 font-mono text-2xl font-semibold text-[var(--text)]">{fmt(processMetric?.meanDistance)} {processMetric?.unit || 'um'}</p>
                <p className="mt-1 text-[12px] text-[var(--text-subtle)]">
                  Calculated from {fmtCount(processMetric?.areaFilter?.includedProcessCount ?? processMetric?.nndIncludedProcessCount ?? processMetric?.processCount)} included processes
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <button type="button" onClick={() => setVisibleVectors?.(prev => ({ ...prev, process: prev.process === false }))} className="ux-button ux-button-secondary min-h-0 px-2 py-1 text-[11px]">
                  {visibleVectors?.process === false ? 'Show overlay' : 'Hide overlay'}
                </button>
                <button type="button" onClick={() => requestMetric('process')} disabled={metricBusy || !processAvailable} className="ux-button ux-button-secondary min-h-0 px-2 py-1 text-[11px]">
                  Recalculate
                </button>
              </div>
            </div>
          </div>

          <p className="text-[12px] text-[var(--text-subtle)]">
            Scope: {scopeLabel}
            {calibrationReady && <> · Calibration: <span className="font-mono text-[var(--text-muted)]">{fmt(effectivePixelSize)} {pixelUnit} / px</span></>}
          </p>
        </div>
      )}

      <div className="ux-card space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] font-semibold text-[var(--text)]">Scope</p>
          {analysisRoi && <span className="font-mono text-[11px] text-[var(--accent)]">{Math.round(analysisRoi.width)} x {Math.round(analysisRoi.height)} px</span>}
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-md border border-[var(--border)] bg-[var(--canvas-bg)] p-1">
          <button onClick={() => setMetricScope('whole')} className={`rounded px-2 py-1 text-[12px] ${metricScope === 'whole' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-subtle)] hover:text-[var(--text)]'}`}>Whole image</button>
          <button
            onClick={() => {
              setMetricScope('selected')
              if (!analysisRoi) onActivateAnalysisRoiTool?.()
            }}
            className={`rounded px-2 py-1 text-[12px] ${metricScope === 'selected' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-subtle)] hover:text-[var(--text)]'}`}
          >
            Selected region
          </button>
        </div>
        {metricScope === 'selected' && (
          !analysisRoi ? (
            <button onClick={onActivateAnalysisRoiTool} className="ux-button ux-button-secondary w-full text-[12px]"><ScanLine size={12} />Draw measurement region</button>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button onClick={onActivateAnalysisRoiTool} className="ux-button ux-button-secondary text-[12px]"><ScanLine size={12} />Redraw region</button>
              <button onClick={onClearAnalysisRoi} className="ux-button ux-button-ghost text-[12px]">Clear region</button>
            </div>
          )
        )}
        {selectedAnnotationRoi && (
          <button onClick={onUseSelectedAnnotationRoi} className="ux-button ux-button-ghost w-full min-h-0 py-1 text-[12px]">Use selected annotation as measurement region</button>
        )}
      </div>

      <details className="ux-card p-3" open={measurementSetupOpen || calibrationAttention}>
        <summary className="cursor-pointer text-[12px] font-semibold text-[var(--text-muted)]">Measurement settings</summary>
        <div className="mt-3 space-y-3">
          {selectedTask?.models.nhs && (
            <label className="block">
              <span className="text-[12px] text-[var(--text-subtle)]">NHS model</span>
              <select value={nhsMode} onChange={e => setNhsMode(e.target.value)} className="ux-select mt-1">
                <option value="single-channel">NHS single-channel</option>
                <option value="combined-actn4">NHS + ACTN4 input</option>
              </select>
            </label>
          )}
          <div className="rounded border border-[var(--border)] bg-[var(--canvas-bg)] p-2 text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[var(--text-muted)]">Channels</span>
              <button type="button" onClick={onEditMapping} className="ux-button ux-button-ghost min-h-0 px-2 py-1 text-[11px]">Edit in Display</button>
            </div>
            <div className="mt-2 space-y-1">
              {rolesForTask.map(role => {
                const value = channelPayload[role]
                return (
                  <div key={role} className="flex items-center justify-between gap-2">
                    <span className="text-[var(--text-subtle)]">{roleInfo(role).label}</span>
                    <span className={value != null ? 'font-mono text-[var(--text)]' : 'text-amber-300'}>{value != null ? channelLabel(channelMapping, value) : 'Not assigned'}</span>
                  </div>
                )
              })}
            </div>
          </div>
          {imgMeta.numZSlices > 1 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[12px] text-[var(--text-subtle)]">
                <span>Measurement Z-slice</span>
                <span className="font-mono text-[var(--text)]">{zIndex + 1} / {imgMeta.numZSlices}</span>
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
            </div>
          )}
          <MeasurementCalibrationCard
            open
            onToggle={() => {}}
            calibrationReady={calibrationReady}
            attention={calibrationAttention && !calibrationReady}
            pixelSize={pixelSize}
            setPixelSize={value => {
              setPixelSize(value)
              setCalibrationAttention(false)
            }}
            pixelUnit={pixelUnit}
            setPixelUnit={setPixelUnit}
            expanded={expanded}
            setExpanded={setExpanded}
            expansionFactor={expansionFactor}
            setExpansionFactor={setExpansionFactor}
            effectivePixelSizeOverride={effectivePixelSizeOverride}
            setEffectivePixelSizeOverride={value => {
              setEffectivePixelSizeOverride(value)
              setCalibrationAttention(false)
            }}
            effectivePixelSize={effectivePixelSize}
            effectivePixelSizeSource={effectivePixelSizeSource}
            pendingMetricIntent={pendingMetricIntent}
            onContinue={continuePendingMetric}
            inputRef={calibrationInputRef}
          />
        </div>
      </details>

      {sourceHasActn4 && (
        <ProcessDegroupingPanel
          value={watershed}
          onChange={handleWatershedChange}
          onApply={() => requestMetric('process')}
          dirty={processSettingsDirty}
          disabled={processBusy}
          areaPreview={processMetric?.areaPreview}
        />
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

      <MetricResultCard
        kind="thickness"
        metric={thickness}
        metricRun={metricRuns.thickness}
        segmentationRun={thicknessResultSource}
        segmentationArtifact={thicknessSegmentation}
        staleReason={thicknessStale ? 'The measurement region or calibration changed after this value was calculated.' : null}
        onRecompute={thicknessAvailable ? () => computeMetric('thickness') : null}
      />

      <MetricResultCard
        kind="process"
        metric={processMetric}
        metricRun={metricRuns.process}
        segmentationRun={processResultSource}
        segmentationArtifact={processSegmentation}
        staleReason={processStale ? 'The measurement region, calibration, or process-size range changed after this value was calculated.' : null}
        onRecompute={processAvailable ? () => computeMetric('process') : null}
      />

      {(error || run?.error) && <p className="break-words text-[12px] leading-snug text-red-300">{error || run.error}</p>}
    </div>
  )

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
          <StepFrame step="1" title="Choose analysis" status="Recommended path">
            <TaskCard task={TASKS.find(task => task.id === 'full')} onClick={() => setTaskId('full')} />
            <div className="mt-4 space-y-2">
              <p className="ux-section-label">Run a specific measurement only</p>
              {TASKS.filter(task => task.id !== 'full').map(task => (
                <TaskCard key={task.id} task={task} compact onClick={() => setTaskId(task.id)} />
              ))}
            </div>
          </StepFrame>
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

          <StepFrame step="2" title="Confirm inputs" status={missingRoles.length || !calibrationReady ? 'Needs attention' : 'Ready'}>
            <div>
              <p className="text-sm font-semibold text-gray-100">{selectedTask.title}</p>
              <p className="mt-1 text-[12px] leading-snug text-gray-500">{selectedTask.description}</p>
            </div>

            {selectedTask.models.nhs && (
              <label className="mt-3 block">
                <span className="text-[12px] text-gray-500">NHS model</span>
                <select value={nhsMode} onChange={e => setNhsMode(e.target.value)} className="ux-select mt-1">
                  <option value="single-channel">NHS single-channel</option>
                  <option value="combined-actn4">NHS + ACTN4 input</option>
                </select>
              </label>
            )}

            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="ux-section-label">Analysis inputs</p>
                <button type="button" onClick={onEditMapping} className="ux-button ux-button-ghost min-h-0 px-2 py-1 text-[11px]">
                  Edit mapping
                </button>
              </div>
              {preflightRows.map(row => (
                <PreflightRow
                  key={row.key}
                  ready={row.ready}
                  label={row.label}
                  value={row.value}
                  action={row.key === 'calibration' && !row.ready ? (
                    <button type="button" onClick={() => setSettingsOpen(true)} className="ux-button ux-button-secondary min-h-0 px-2 py-1 text-[11px]">Edit</button>
                  ) : null}
                />
              ))}
            </div>
          </StepFrame>

          <button onClick={() => setSettingsOpen(open => !open)} className="flex w-full items-center justify-between text-[11px] text-gray-500 hover:text-gray-200">
            <span>Edit analysis plane and calibration</span>
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

          <StepFrame step="3" title="Run segmentation and measurements" status={busy ? 'Running' : succeeded ? 'Segmentation ready' : 'Ready to run'}>
            {missingRoles.length > 0 && (
              <p className="mb-3 text-[12px] text-amber-300">Assign {missingRoles.map(role => roleInfo(role).label).join(', ')} before running.</p>
            )}

            <button onClick={startRun} disabled={!canRun} className={`ux-button w-full ${canRun ? 'ux-button-primary' : 'ux-button-secondary cursor-not-allowed opacity-50'}`}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {busy
                ? 'Running analysis...'
                : selectedTask.id === 'full'
                  ? 'Run full analysis'
                  : matchingSavedRun
                    ? 'Run segmentation again'
                    : 'Run segmentation'}
            </button>
            {matchingSavedRun && (
              <button type="button" onClick={() => selectSegmentationRun(matchingSavedRun)} className="ux-button ux-button-secondary mt-2 w-full text-[12px]">
                Restore newest matching result
              </button>
            )}
          </StepFrame>
        </div>
      )}

      {run?.progress && busy && <AnalysisProgressCard run={run} selectedTask={selectedTask} />}

      {showMeasurements && (
        <div className="space-y-3">
          {analysisComplete && (
            <StepFrame step="4" title="Review results" status="Needs QC review">
              <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-[12px]">
                <span className="text-[var(--text-muted)]">GBM thickness</span>
                <span className="font-mono text-[var(--text)]">{fmt(thickness?.meanThickness)} {thickness?.unit || 'um'}</span>
                <span className="text-[var(--text-muted)]">Process NND</span>
                <span className="font-mono text-[var(--text)]">{fmt(processMetric?.meanDistance)} {processMetric?.unit || 'um'}</span>
                <span className="text-[var(--text-muted)]">Processes retained</span>
                <span className="font-mono text-[var(--text)]">
                  {fmtCount(processMetric?.areaFilter?.includedProcessCount ?? processMetric?.nndIncludedProcessCount ?? processMetric?.processCount)}
                  {' / '}
                  {fmtCount(processMetric?.areaFilter?.totalProcessCount ?? processMetric?.processCount)}
                </span>
                <span className="text-[var(--text-muted)]">Excluded by area filter</span>
                <span className="font-mono text-[var(--text)]">{fmtCount(processMetric?.areaFilter?.excludedProcessCount)}</span>
                <span className="text-[var(--text-muted)]">Scope</span>
                <span className="font-mono text-[var(--text)]">{metricScope === 'selected' && analysisRoi ? 'Analysis ROI' : 'Whole image'}</span>
                <span className="text-[var(--text-muted)]">Z-slice</span>
                <span className="font-mono text-[var(--text)]">{imgMeta.numZSlices > 1 ? `${zIndex + 1} of ${imgMeta.numZSlices}` : 'Single slice'}</span>
              </div>
              <button type="button" onClick={onReviewQc} className="ux-button ux-button-primary mt-3 w-full text-[12px]">
                Review segmentation QC
              </button>
            </StepFrame>
          )}

          <div className="ux-card space-y-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold text-gray-200">Measurement scope</p>
              {analysisRoi && <span className="font-mono text-[9px] text-[var(--accent)]">{Math.round(analysisRoi.width)} x {Math.round(analysisRoi.height)} px</span>}
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-md border border-[var(--border)] bg-[var(--canvas-bg)] p-1">
              <button onClick={() => setMetricScope('whole')} className={`rounded px-2 py-1 text-[10px] ${metricScope === 'whole' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-subtle)] hover:text-[var(--text)]'}`}>Whole image</button>
              <button
                onClick={() => {
                  setMetricScope('selected')
                  if (!analysisRoi) onActivateAnalysisRoiTool?.()
                }}
                className={`rounded px-2 py-1 text-[10px] ${metricScope === 'selected' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-subtle)] hover:text-[var(--text)]'}`}
              >
                Analysis ROI
              </button>
            </div>
            {metricScope === 'whole' && analysisRoi && (
              <p className="text-[9px] leading-snug text-gray-600">Saved ROI available. Switch to Analysis ROI to use it.</p>
            )}
            {metricScope === 'selected' && (
              <div className="space-y-2">
                {!analysisRoi ? (
                  <button onClick={onActivateAnalysisRoiTool} className="ux-button ux-button-secondary w-full text-[10px]"><ScanLine size={11} />Draw ROI</button>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={onActivateAnalysisRoiTool} className="ux-button ux-button-secondary text-[10px]"><ScanLine size={11} />Redraw ROI</button>
                    <button onClick={onClearAnalysisRoi} className="ux-button ux-button-ghost text-[10px]">Clear ROI</button>
                  </div>
                )}
              </div>
            )}
            {selectedAnnotationRoi && (
              <button onClick={onUseSelectedAnnotationRoi} className="ux-button ux-button-ghost w-full min-h-0 py-1 text-[12px]">Use selected annotation as analysis ROI</button>
            )}
          </div>

          <MeasurementCalibrationCard
            open={measurementSetupOpen}
            onToggle={() => setMeasurementSetupOpen(open => !open)}
            calibrationReady={calibrationReady}
            attention={calibrationAttention && !calibrationReady}
            pixelSize={pixelSize}
            setPixelSize={value => {
              setPixelSize(value)
              setCalibrationAttention(false)
            }}
            pixelUnit={pixelUnit}
            setPixelUnit={setPixelUnit}
            expanded={expanded}
            setExpanded={setExpanded}
            expansionFactor={expansionFactor}
            setExpansionFactor={setExpansionFactor}
            effectivePixelSizeOverride={effectivePixelSizeOverride}
            setEffectivePixelSizeOverride={value => {
              setEffectivePixelSizeOverride(value)
              setCalibrationAttention(false)
            }}
            effectivePixelSize={effectivePixelSize}
            effectivePixelSizeSource={effectivePixelSizeSource}
            pendingMetricIntent={pendingMetricIntent}
            onContinue={continuePendingMetric}
            inputRef={calibrationInputRef}
          />

          {sourceHasActn4 && (
            <ProcessDegroupingPanel
              value={watershed}
              onChange={handleWatershedChange}
              onApply={() => requestMetric('process')}
              dirty={processSettingsDirty}
              disabled={processBusy}
              areaPreview={processMetric?.areaPreview}
            />
          )}

          <div className="space-y-2">
            <MetricSourceLine kind="thickness" source={metricSources.thickness} busy={thicknessBusy} metric={thickness} />
            <MetricSourceLine kind="process" source={metricSources.process} busy={processBusy} metric={processMetric} />
          </div>

          {sourceHasNhs && sourceHasActn4 && (
            <button onClick={computeAllAvailable} disabled={metricBusy} className="ux-button ux-button-primary w-full text-[11px]">
              {metricBusy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
              {metricBusy ? 'Measurement running...' : 'Compute all measurements'}
            </button>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <button onClick={() => requestMetric('thickness')} disabled={metricBusy || !thicknessAvailable} className="ux-button ux-button-secondary w-full text-[11px]">
                {thicknessBusy ? <Loader2 size={11} className="animate-spin" /> : <Ruler size={11} />}
                {thicknessStale ? 'Recompute GBM' : 'GBM thickness'}
              </button>
              {!thicknessAvailable && (
                <p className="text-[9px] leading-snug text-amber-300">Run NHS segmentation to calculate GBM thickness.</p>
              )}
            </div>
            <div className="space-y-1">
              <button onClick={() => requestMetric('process')} disabled={metricBusy || !processAvailable} className="ux-button ux-button-secondary w-full text-[11px]">
                {processBusy ? <Loader2 size={11} className="animate-spin" /> : <Waypoints size={11} />}
                {processSettingsDirty || processStale ? 'Recompute NND' : 'Process NND'}
              </button>
              {!processAvailable && (
                <p className="text-[9px] leading-snug text-amber-300">Run ACTN4 segmentation to calculate Process NND.</p>
              )}
            </div>
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
        segmentationRun={thicknessResultSource}
        segmentationArtifact={thicknessSegmentation}
        vectorVisible={visibleVectors?.thickness}
        onToggleVector={() => setVisibleVectors?.(prev => ({ ...prev, thickness: prev.thickness === false }))}
        staleReason={thicknessStale ? 'The ROI or calibration has changed since this value was calculated.' : null}
        onRecompute={thicknessAvailable ? () => computeMetric('thickness') : null}
      />

      <MetricResultCard
        kind="process"
        metric={processMetric}
        metricRun={metricRuns.process}
        segmentationRun={processResultSource}
        segmentationArtifact={processSegmentation}
        vectorVisible={visibleVectors?.process}
        onToggleVector={() => setVisibleVectors?.(prev => ({ ...prev, process: prev.process === false }))}
        staleReason={processStale ? 'The ROI, calibration, or degrouping settings have changed since this value was calculated.' : null}
        onRecompute={processAvailable ? () => computeMetric('process') : null}
      />

      {(error || run?.error) && <p className="break-words text-[10px] leading-snug text-red-300">{error || run.error}</p>}
    </div>
  )
}
