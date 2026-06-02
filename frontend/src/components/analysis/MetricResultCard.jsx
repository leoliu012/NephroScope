import { Download, Eye, EyeOff } from 'lucide-react'
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

export default function MetricResultCard({
  kind,
  metric,
  metricRun,
  segmentationRun,
  segmentationArtifact,
  vectorVisible,
  onToggleVector,
}) {
  if (!metric || !segmentationRun?.runId) return null

  const isThickness = kind === 'thickness'
  const title = isThickness ? 'GBM Thickness' : 'Process NND'
  const primaryLabel = isThickness ? 'Mean thickness' : 'Mean distance'
  const primaryValue = isThickness ? metric.meanThickness : metric.meanDistance
  const countLabel = isThickness ? 'Measurement points' : 'Detected processes'
  const countValue = isThickness ? metric.points?.length : (metric.processCount ?? 0)
  const pairCount = metric.pairCount ?? metric.pairs?.length ?? 0
  const computedAt = metricRun?.finishedAt || metricRun?.createdAt
  const watershed = metric.watershed || metricRun?.request?.watershed

  return (
    <div className="ux-card space-y-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-gray-100">{title}</p>
        <button
          onClick={onToggleVector}
          className="ux-icon-button h-6 w-6"
          title={isThickness ? 'Toggle thickness map' : 'Toggle NND vectors'}
        >
          {vectorVisible === false ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px] text-gray-400">
        <span>{primaryLabel}</span>
        <span className="text-right text-gray-100">{formatMetric(primaryValue)} {metric.unit || ''}</span>
        <span>{countLabel}</span>
        <span className="text-right text-gray-100">{formatCount(countValue)}</span>
        {!isThickness && (
          <>
            <span>NND links</span>
            <span className="text-right text-gray-100">{formatCount(pairCount)}</span>
          </>
        )}
      </div>

      <div className="border-t border-[var(--border)] pt-2 grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-[10px] leading-snug">
        <span className="text-gray-500">Scope</span>
        <span className="text-right text-gray-300">{formatScope(metricRun)}</span>
        <span className="text-gray-500">Calibration</span>
        <span className="text-right text-gray-300">{formatCalibration(segmentationRun, metric, metricRun)}</span>
        {!isThickness && (
          <>
            <span className="text-gray-500">Degrouping</span>
            <span className="text-right text-gray-300">{watershedLabel(watershed)}</span>
            <span className="text-gray-500">Min separation</span>
            <span className="text-right text-gray-300">{formatSmallNumber(watershed?.minDistanceUm)} {metric.unit || 'um'}</span>
            <span className="text-gray-500">Max NND link</span>
            <span className="text-right text-gray-300">{formatSmallNumber(watershed?.maxPairDistanceUm)} {metric.unit || 'um'}</span>
          </>
        )}
        <span className="text-gray-500">Computed</span>
        <span className="text-right text-gray-300">{formatDate(computedAt)}</span>
      </div>

      <div className="flex gap-2">
        {metric.artifacts?.csv && (
          <a
            href={artifactUrl(segmentationRun.runId, metric.artifacts.csv)}
            className="ux-button ux-button-secondary flex-1 text-center text-[10px]"
          >
            <Download size={10} />
            CSV
          </a>
        )}
        {!isThickness && metric.artifacts?.labels && (
          <a
            href={artifactUrl(segmentationRun.runId, metric.artifacts.labels)}
            className="ux-button ux-button-secondary flex-1 text-center text-[10px]"
          >
            Labels
          </a>
        )}
        {segmentationArtifact && (
          <a
            href={artifactUrl(segmentationRun.runId, segmentationArtifact)}
            className="ux-button ux-button-secondary flex-1 text-center text-[10px]"
          >
            {isThickness && <Download size={10} />}
            TIFF
          </a>
        )}
      </div>
    </div>
  )
}

