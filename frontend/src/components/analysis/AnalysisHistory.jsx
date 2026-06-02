import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Trash2,
  XCircle,
} from 'lucide-react'
import { watershedLabel } from './analysisPresets.js'

function runModelNames(run) {
  return run?.request?.modelNames || []
}

function modelSummary(run) {
  const labels = []
  runModelNames(run).forEach(name => {
    if (name === 'ACTN4' && !labels.includes('ACTN4')) labels.push('ACTN4')
    if (String(name).startsWith('NHS_') && !labels.includes('NHS')) labels.push('NHS')
  })
  if (!labels.length) return run?.operation || 'Segmentation'
  return `${labels.join(' + ')} segmentation`
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

function formatMetric(value) {
  if (value == null || Number.isNaN(value)) return 'n/a'
  if (Math.abs(value) >= 100 || Math.abs(value) < 0.001) return value.toExponential(2)
  return value.toFixed(3)
}

function statusDot(status) {
  if (status === 'SUCCEEDED') return 'bg-[var(--success)]'
  if (status === 'FAILED') return 'bg-[var(--danger)]'
  return 'bg-[var(--warning)]'
}

function formatSettings(run) {
  const request = run?.request || {}
  const z = Number.isFinite(Number(request.zIndex)) ? `Z slice ${Number(request.zIndex)}` : null
  const calibration = request.calibration || {}
  const ef = calibration.expanded ? `EF ${calibration.expansionFactor || 7}x` : 'No EF correction'
  return [z, ef].filter(Boolean).join(' / ')
}

function metricKind(run) {
  if (run?.operation === 'gbm-thickness') return 'thickness'
  if (run?.operation === 'process-nnd') return 'process'
  return null
}

function metricTitle(run) {
  return metricKind(run) === 'thickness' ? 'GBM thickness' : 'Process NND'
}

function metricValue(run) {
  const result = run?.result || {}
  const value = metricKind(run) === 'thickness' ? result.meanThickness : result.meanDistance
  return `${formatMetric(value)} ${result.unit || ''}`.trim()
}

function latestProcessMetric(metrics) {
  return metrics.find(run => run.operation === 'process-nnd')
}

function MetricLine({ metric }) {
  const succeeded = metric.status === 'SUCCEEDED'
  const failed = metric.status === 'FAILED'
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
      {succeeded ? (
        <CheckCircle2 size={11} className="text-[var(--success)]" />
      ) : failed ? (
        <XCircle size={11} className="text-[var(--danger)]" />
      ) : (
        <Loader2 size={11} className="animate-spin text-[var(--warning)]" />
      )}
      <span className="min-w-0 flex-1 truncate">{metricTitle(metric)}</span>
      {succeeded && <span className="font-mono text-gray-200">{metricValue(metric)}</span>}
      {failed && <span className="text-red-300">failed</span>}
      {!succeeded && !failed && <span className="text-gray-500">{metric.status}</span>}
    </div>
  )
}

export default function AnalysisHistory({
  runs,
  activeRunId,
  metricsByRun,
  loading,
  open,
  onToggleOpen,
  onRestore,
  onDuplicateSettings,
  onDelete,
  deletingRunId,
}) {
  return (
    <div className="border-t border-[var(--border)] pt-2">
      <button
        onClick={onToggleOpen}
        className="flex w-full items-center justify-between py-1 text-[11px] text-[var(--text-subtle)] hover:text-[var(--text)]"
      >
        <span>History ({runs.length})</span>
        <span className="flex items-center gap-2">
          {loading && <Loader2 size={11} className="animate-spin text-gray-500" />}
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {runs.length === 0 ? (
            <p className="text-[11px] text-gray-600">No saved segmentation for this image yet.</p>
          ) : runs.map(savedRun => {
            const metrics = metricsByRun[savedRun.runId] || []
            const processMetric = latestProcessMetric(metrics)
            return (
              <div key={savedRun.runId} className={`ux-card space-y-2 p-2 ${activeRunId === savedRun.runId ? 'ux-card-selected' : ''}`}>
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${statusDot(savedRun.status)}`} />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-gray-200">{formatDate(savedRun.createdAt)}</span>
                  <span className="text-[10px] text-gray-600">{savedRun.status}</span>
                </div>
                <div>
                  <p className="truncate text-[11px] text-gray-200">{modelSummary(savedRun)}</p>
                  <p className="mt-0.5 text-[10px] text-gray-500">{formatSettings(savedRun)}</p>
                </div>
                {metrics.length > 0 && (
                  <div className="space-y-1">
                    {metrics.map(metric => <MetricLine key={metric.runId} metric={metric} />)}
                    {processMetric && (
                      <p className="text-[10px] text-gray-500">
                        Watershed: {watershedLabel(processMetric.result?.watershed || processMetric.request?.watershed)}
                      </p>
                    )}
                  </div>
                )}
                <div className="grid grid-cols-[1fr_1.35fr_auto] gap-2">
                  <button
                    onClick={() => onRestore(savedRun)}
                    className="ux-button ux-button-secondary min-h-0 px-2 py-1 text-[10px]"
                  >
                    Restore
                  </button>
                  <button
                    onClick={() => onDuplicateSettings(savedRun)}
                    className="ux-button ux-button-secondary min-h-0 px-2 py-1 text-[9px]"
                  >
                    Duplicate settings
                  </button>
                  <button
                    onClick={() => onDelete(savedRun)}
                    disabled={deletingRunId === savedRun.runId}
                    className="ux-button ux-button-danger min-h-0 px-2 py-1 text-[10px]"
                    title="Delete"
                  >
                    {deletingRunId === savedRun.runId ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
