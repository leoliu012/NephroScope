import { ChevronDown, ChevronRight, RefreshCw, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import {
  DEFAULT_WATERSHED_PRESET,
  WATERSHED_PRESETS,
  presetWatershedPayload,
} from './analysisPresets.js'

function numberValue(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clampPercent(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(100, parsed))
}

function fmtPercent(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '0'
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(1)
}

function formatMetric(value) {
  if (value == null || Number.isNaN(Number(value))) return 'n/a'
  const parsed = Number(value)
  if (Math.abs(parsed) >= 100 || Math.abs(parsed) < 0.001) return parsed.toExponential(2)
  return parsed.toFixed(3)
}

function formatCount(value) {
  if (value == null) return '0'
  return new Intl.NumberFormat().format(value)
}

export default function ProcessDegroupingPanel({
  value,
  onChange,
  onApply,
  dirty = false,
  disabled = false,
  areaPreview = null,
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const settings = value || DEFAULT_WATERSHED_PRESET
  const minAreaPercentile = clampPercent(settings.minAreaPercentile ?? 0, 0)
  const maxAreaPercentile = clampPercent(settings.maxAreaPercentile ?? 100, 100)
  const areaFilter = areaPreview?.areaFilter

  const choosePreset = presetId => onChange?.(presetWatershedPayload(presetId))
  const update = patch => onChange?.({ ...settings, ...patch, preset: 'custom', label: 'Custom' })
  const updateAreaMin = value => {
    const nextMin = Math.min(clampPercent(value, minAreaPercentile), Math.max(0, maxAreaPercentile - 1))
    update({ minAreaPercentile: nextMin, maxAreaPercentile })
  }
  const updateAreaMax = value => {
    const nextMax = Math.max(clampPercent(value, maxAreaPercentile), Math.min(100, minAreaPercentile + 1))
    update({ minAreaPercentile, maxAreaPercentile: nextMax })
  }

  return (
    <div className="ux-card space-y-3 p-3">
      <div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] font-semibold text-gray-200">Process separation</p>
          <span className="ux-badge ux-badge-neutral px-2 py-1 text-[10px]">{settings.label || 'Balanced'}</span>
        </div>
        <p className="mt-1 text-[12px] leading-snug text-gray-500">
          Watershed degrouping splits crowded ACTN4 regions before nearest-neighbor distance is measured.
        </p>
      </div>

      <div className="rounded border border-[var(--border)] bg-[var(--canvas-bg)] p-2">
        <div className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 text-[12px]">
          <span className="text-[var(--text-subtle)]">Processes retained</span>
          <span className="font-mono text-[var(--text)]">{formatCount(areaFilter?.includedProcessCount)} / {formatCount(areaFilter?.totalProcessCount)}</span>
          <span className="text-[var(--text-subtle)]">Excluded by area filter</span>
          <span className="font-mono text-[var(--warning)]">{formatCount(areaFilter?.excludedProcessCount)}</span>
          <span className="text-[var(--text-subtle)]">Preview NND</span>
          <span className="font-mono text-[var(--text)]">{formatMetric(areaPreview?.meanDistance)} {areaPreview?.unit || 'um'}</span>
        </div>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => setAdvancedOpen(true)} className="ux-button ux-button-secondary flex-1 text-[12px]">
            Review filter
          </button>
          <button type="button" disabled={disabled} onClick={onApply} className="ux-button ux-button-primary flex-1 text-[12px]">
            <RefreshCw size={12} />
            Recompute NND
          </button>
        </div>
        {areaPreview && (
          <p className="mt-2 text-[12px] leading-snug text-amber-200">
            Preview only - result has not been saved.
          </p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-1">
        {Object.values(WATERSHED_PRESETS).map(preset => (
          <button
            key={preset.preset}
            type="button"
            disabled={disabled}
            onClick={() => choosePreset(preset.preset)}
            title={preset.description}
            className={`rounded border px-1 py-1.5 text-[9px] transition-colors ${
              settings.preset === preset.preset
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--canvas-bg)] text-gray-500 hover:text-gray-200'
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setAdvancedOpen(open => !open)}
        className="flex w-full items-center justify-between text-[12px] text-gray-500 hover:text-gray-200"
      >
        <span>Expert settings</span>
        {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>

      {advancedOpen && (
        <div className="space-y-3 border-t border-[var(--border)] pt-2">
          <div className="space-y-2">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-gray-600">Watershed separation</p>
            <div className="grid grid-cols-2 gap-2">
              <label>
                <span className="text-[9px] text-gray-500">Minimum separation (um)</span>
                <input
                  type="number"
                  min="0.001"
                  step="0.005"
                  disabled={disabled}
                  value={settings.minDistanceUm}
                  onChange={e => update({ minDistanceUm: numberValue(e.target.value, settings.minDistanceUm) })}
                  className="ux-input mt-1"
                />
              </label>
              <label>
                <span className="text-[9px] text-gray-500">Peak sensitivity (0-1)</span>
                <input
                  type="number"
                  min="0.001"
                  max="1"
                  step="0.01"
                  disabled={disabled}
                  value={settings.thresholdRelative}
                  onChange={e => update({ thresholdRelative: numberValue(e.target.value, settings.thresholdRelative) })}
                  className="ux-input mt-1"
                />
              </label>
              <label>
                <span className="text-[9px] text-gray-500">Boundary smoothing (px)</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  disabled={disabled}
                  value={settings.sigma}
                  onChange={e => update({ sigma: numberValue(e.target.value, settings.sigma) })}
                  className="ux-input mt-1"
                />
              </label>
            </div>
            <p className="text-[9px] leading-snug text-gray-600">
              These controls can change the split boundary and detected process count.
            </p>
          </div>

          <div className="space-y-2 border-t border-[var(--border)] pt-2">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-gray-600">NND pairing</p>
            <label className="block w-1/2 pr-1">
              <span className="text-[9px] text-gray-500">Maximum displayed NND link (um)</span>
              <input
                type="number"
                min="0.001"
                step="0.05"
                disabled={disabled}
                value={settings.maxPairDistanceUm}
                onChange={e => update({ maxPairDistanceUm: numberValue(e.target.value, settings.maxPairDistanceUm) })}
                className="ux-input mt-1"
              />
            </label>
            <p className="text-[9px] leading-snug text-gray-600">
              Longer nearest-neighbor links remain included in the reported NND statistics but are hidden from the image overlay to reduce visual clutter.
            </p>
          </div>

          <div className="space-y-2 border-t border-[var(--border)] pt-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-gray-600">Area filter</p>
              <span className="font-mono text-[9px] text-gray-300">{fmtPercent(minAreaPercentile)}-{fmtPercent(maxAreaPercentile)}%</span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[9px] text-gray-500">
                <span>Exclude smallest {fmtPercent(minAreaPercentile)}%</span>
                <span>Exclude largest {fmtPercent(100 - maxAreaPercentile)}%</span>
              </div>
              <div
                className="dual-range"
                style={{
                  '--range-start': `${minAreaPercentile}%`,
                  '--range-end': `${100 - maxAreaPercentile}%`,
                }}
              >
                <div className="dual-range-track" />
                <div className="dual-range-selection" />
                <input
                  aria-label="Minimum retained process area percentile"
                  type="range"
                  min={0}
                  max={99}
                  step={1}
                  disabled={disabled}
                  value={minAreaPercentile}
                  onChange={e => updateAreaMin(e.target.value)}
                />
                <input
                  aria-label="Maximum retained process area percentile"
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  disabled={disabled}
                  value={maxAreaPercentile}
                  onChange={e => updateAreaMax(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded border border-[var(--border)] bg-[var(--canvas-bg)] p-2 text-[9px]">
              <span className="text-gray-500">Retained</span>
              <span className="text-right text-gray-200">{formatCount(areaFilter?.includedProcessCount)} / {formatCount(areaFilter?.totalProcessCount)}</span>
              <span className="text-gray-500">Excluded</span>
              <span className="text-right text-gray-200">{formatCount(areaFilter?.excludedProcessCount)}</span>
              {areaPreview && (
                <>
                  <span className="text-gray-500">Preview NND</span>
                  <span className="text-right text-gray-200">{formatMetric(areaPreview.meanDistance)} {areaPreview.unit || 'um'}</span>
                </>
              )}
            </div>
            <p className="text-[9px] leading-snug text-gray-600">
              Preview updates from the stored watershed labels. Recompute NND to save the filter into the final metric.
            </p>
          </div>

          <button
            type="button"
            disabled={disabled}
            onClick={() => choosePreset(DEFAULT_WATERSHED_PRESET.preset)}
            className="ux-button ux-button-ghost min-h-0 px-1 py-1 text-[10px]"
          >
            <RotateCcw size={10} />
            Reset recommended
          </button>
        </div>
      )}

      {dirty && (
        <div className="space-y-2 rounded border border-amber-400/30 bg-amber-400/5 p-2">
          <p className="text-[10px] leading-snug text-amber-200">
            Settings changed. Recompute NND to apply them. Previous NND lines and contours stay hidden until the new result finishes.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={onApply}
            className="ux-button ux-button-primary w-full text-[10px]"
          >
            <RefreshCw size={10} />
            Apply settings and recompute NND
          </button>
        </div>
      )}
    </div>
  )
}
