import { AlertTriangle, Download, Loader2 } from 'lucide-react'
import { artifactUrl } from './analysisApi.js'
import { watershedLabel } from './analysisPresets.js'

function formatMetric(value) {
  if (value == null || Number.isNaN(value)) return 'n/a'
  if (Math.abs(value) >= 100 || Math.abs(value) < 0.001) return value.toExponential(2)
  return value.toFixed(3)
}

function formatSmallNumber(value) {
  if (value == null || Number.isNaN(value)) return 'Not recorded'
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: 6,
    minimumFractionDigits: 0,
  })
}

function formatCount(value) {
  if (value == null) return '0'
  return new Intl.NumberFormat().format(value)
}

function formatPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return 'Not recorded'
  return `${(Number(value) * 100).toFixed(1)}%`
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

function formatScope(metricRun) {
  return metricRun?.request?.roi ? 'Selected ROI' : 'Whole image'
}

function formatCalibration(segmentationRun, metric, metricRun) {
  const calibration = metric?.calibration
    || metricRun?.request?.calibration
    || (segmentationRun?.request || {}).calibration
    || {}
  const pixelSize = calibration.effectivePixelSize
  if (pixelSize == null) return 'Not recorded'
  const unit = calibration.pixelUnit || metric?.unit || 'um'
  const suffix = calibration.effectivePixelSizeSource === 'override'
    ? ' direct override'
    : calibration.expanded
      ? ' after EF correction'
      : ''
  return `${formatSmallNumber(pixelSize)} ${unit} / px${suffix}`
}

function sourceLabel(segmentationRun, isThickness) {
  const segmentations = segmentationRun?.result?.segmentations || {}
  if (isThickness) {
    if (segmentations.NHS_COMBINED_ACTN4) return 'NHS Ester + ACTN4'
    if (segmentations.NHS_SINGLE_CHANNEL) return 'NHS Ester'
    return 'NHS Ester'
  }
  return 'ACTN4'
}

export default function MetricResultCard({
  kind,
  metric,
  metricRun,
  segmentationRun,
  segmentationArtifact,
  staleReason,
  onRecompute,
}) {
  if (!metric || !segmentationRun?.runId) return null

  const isThickness = kind === 'thickness'
  const previewing = !isThickness && Boolean(metric.areaPreview)
  const displayedMetric = previewing
    ? { ...metric, ...metric.areaPreview, unit: metric.unit, artifacts: metric.artifacts, watershed: metric.watershed }
    : metric
  const title = isThickness ? 'GBM Thickness' : 'Process NND'
  const primaryLabel = isThickness ? 'Mean thickness' : 'Mean distance'
  const primaryValue = isThickness ? metric.meanThickness : displayedMetric.meanDistance
  const countLabel = isThickness ? 'Measurement points' : 'Detected processes'
  const countValue = isThickness ? metric.points?.length : (displayedMetric.processCount ?? 0)
  const pairCount = displayedMetric.pairCount ?? displayedMetric.pairs?.length ?? 0
  const displayPairCount = displayedMetric.displayPairCount ?? displayedMetric.displayPairs?.length ?? pairCount
  const hiddenPairCount = displayedMetric.displayExcludedPairCount ?? Math.max(0, pairCount - displayPairCount)
  const areaFilter = displayedMetric.areaFilter
  const pending = ['QUEUED', 'RUNNING'].includes(metricRun?.status)
  const failed = metricRun?.status === 'FAILED'
  const computedAt = pending || failed ? null : (metricRun?.finishedAt || metricRun?.createdAt)
  const watershed = metric.watershed || metricRun?.request?.watershed
  const statusLabel = failed
    ? 'Failed'
    : pending
      ? 'Running'
      : staleReason
        ? 'Outdated'
        : previewing
          ? 'Preview only'
          : 'Needs QC'
  const statusClass = failed
    ? 'ux-badge-danger'
    : staleReason || previewing
      ? 'ux-badge-warning'
      : pending
        ? 'ux-badge-neutral'
        : 'ux-badge-warning'

  return (
    <div className="ux-card space-y-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-gray-100">{title}</p>
        <span className={`ux-badge ${statusClass}`}>{statusLabel}</span>
      </div>

      {staleReason && (
        <div className="rounded border border-amber-400/30 bg-amber-400/5 p-2">
          <div className="flex items-start gap-2">
            <AlertTriangle size={12} className="mt-0.5 text-amber-300" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold text-amber-100">Outdated result</p>
              <p className="mt-0.5 text-[9px] leading-snug text-amber-200">{staleReason}</p>
            </div>
            {onRecompute && (
              <button type="button" onClick={onRecompute} className="ux-button ux-button-secondary min-h-0 px-2 py-1 text-[9px]">
                Recompute
              </button>
            )}
          </div>
        </div>
      )}

      {(pending || failed) && (
        <div className={`rounded border p-2 ${failed ? 'border-red-400/30 bg-red-400/5' : 'border-[var(--accent)]/30 bg-[var(--accent-soft)]'}`}>
          <div className="flex items-center gap-2">
            {pending ? <Loader2 size={12} className="animate-spin text-[var(--accent)]" /> : <AlertTriangle size={12} className="text-red-300" />}
            <p className={`text-[10px] font-semibold ${failed ? 'text-red-200' : 'text-gray-100'}`}>
              {pending ? 'Recomputation running' : 'Recomputation failed'}
            </p>
          </div>
          {failed && metricRun?.error && <p className="mt-1 text-[9px] leading-snug text-red-200">{metricRun.error}</p>}
        </div>
      )}

      <div className="rounded border border-[var(--border)] bg-[var(--canvas-bg)] p-3">
        <p className="text-[11px] text-[var(--text-subtle)]">{primaryLabel}</p>
        <p className="mt-1 font-mono text-2xl font-semibold text-[var(--text)]">{formatMetric(primaryValue)} {metric.unit || ''}</p>
        <p className="mt-2 text-[12px] leading-snug text-[var(--text-muted)]">
          Calculated from {sourceLabel(segmentationRun, isThickness)} segmentation
        </p>
        <p className="mt-1 text-[12px] leading-snug text-[var(--text-subtle)]">
          {formatScope(metricRun)} | {Number.isFinite(Number(segmentationRun?.request?.zIndex)) ? `Z-slice ${Number(segmentationRun.request.zIndex) + 1}` : 'Z-slice not recorded'} | {formatCalibration(segmentationRun, metric, metricRun)}
        </p>
        <p className="mt-1 text-[12px] leading-snug text-[var(--text-subtle)]">{formatDate(computedAt)}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[12px] text-gray-400">
        <span>{primaryLabel}</span>
        <span className="text-right text-gray-100">{formatMetric(primaryValue)} {metric.unit || ''}</span>
        <span>{countLabel}</span>
        <span className="text-right text-gray-100">{formatCount(countValue)}</span>
        {!isThickness && (
          <>
            <span>Objects included in NND</span>
            <span className="text-right text-gray-100">{formatCount(displayedMetric.nndIncludedProcessCount ?? displayedMetric.processCount ?? pairCount)}</span>
            <span>NND links</span>
            <span className="text-right text-gray-100">{formatCount(pairCount)}</span>
            <span>Displayed vectors</span>
            <span className="text-right text-gray-100">{formatCount(displayPairCount)}</span>
            <span>Hidden long vectors</span>
            <span className="text-right text-gray-100">{formatCount(hiddenPairCount)}</span>
            {areaFilter && (
              <>
                <span>Area-filter excluded</span>
                <span className="text-right text-gray-100">{formatCount(areaFilter.excludedProcessCount)}</span>
                <span>Small / large excluded</span>
                <span className="text-right text-gray-100">{formatCount(areaFilter.excludedSmallProcessCount)} / {formatCount(areaFilter.excludedLargeProcessCount)}</span>
              </>
            )}
            <span>Foreground coverage</span>
            <span className="text-right text-gray-100">{formatPercent(metric.foregroundCoverage)}</span>
          </>
        )}
      </div>

      <details className="rounded border border-[var(--border)] bg-[var(--canvas-bg)] p-2">
        <summary className="cursor-pointer text-[12px] font-semibold text-[var(--text-muted)]">Technical details</summary>
        <div className="mt-2 grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-[12px] leading-snug">
          <span className="text-gray-500">Scope</span>
          <span className="text-right text-gray-300">{formatScope(metricRun)}</span>
          <span className="text-gray-500">Source</span>
          <span className="text-right text-gray-300">{sourceLabel(segmentationRun, isThickness)} | {formatDate(segmentationRun?.createdAt)}</span>
          {Number.isFinite(Number(segmentationRun?.request?.zIndex)) && (
            <>
              <span className="text-gray-500">Z-slice</span>
              <span className="text-right text-gray-300">{Number(segmentationRun.request.zIndex) + 1}</span>
            </>
          )}
          <span className="text-gray-500">Calibration</span>
          <span className="text-right text-gray-300">{formatCalibration(segmentationRun, metric, metricRun)}</span>
          {!isThickness && (
            <>
              <span className="text-gray-500">Degrouping</span>
              <span className="text-right text-gray-300">{watershedLabel(watershed)}</span>
              <span className="text-gray-500">Min separation</span>
              <span className="text-right text-gray-300">{formatSmallNumber(watershed?.minDistanceUm)} {metric.unit || 'um'}</span>
              <span className="text-gray-500">Max shown link</span>
              <span className="text-right text-gray-300">{formatSmallNumber(watershed?.maxPairDistanceUm)} {metric.unit || 'um'}</span>
            </>
          )}
          <span className="text-gray-500">Computed</span>
          <span className="text-right text-gray-300">{formatDate(computedAt)}</span>
        </div>

        <div className="mt-3 flex gap-2">
          {metric.artifacts?.csv && (
            <a
              href={artifactUrl(segmentationRun.runId, metric.artifacts.csv)}
              className="ux-button ux-button-secondary flex-1 text-center text-[12px]"
            >
              <Download size={12} />
              CSV
            </a>
          )}
          {!isThickness && metric.artifacts?.labels && (
            <a
              href={artifactUrl(segmentationRun.runId, metric.artifacts.labels)}
              className="ux-button ux-button-secondary flex-1 text-center text-[12px]"
            >
              Labels
            </a>
          )}
          {segmentationArtifact && (
            <a
              href={artifactUrl(segmentationRun.runId, segmentationArtifact)}
              className="ux-button ux-button-secondary flex-1 text-center text-[12px]"
            >
              {isThickness && <Download size={12} />}
              TIFF
            </a>
          )}
        </div>
      </details>
    </div>
  )
}
