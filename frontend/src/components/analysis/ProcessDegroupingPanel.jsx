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

export default function ProcessDegroupingPanel({
  value,
  onChange,
  onApply,
  dirty = false,
  disabled = false,
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const settings = value || DEFAULT_WATERSHED_PRESET

  const choosePreset = presetId => onChange?.(presetWatershedPayload(presetId))
  const update = patch => onChange?.({ ...settings, ...patch, preset: 'custom', label: 'Custom' })

  return (
    <div className="ux-card space-y-3 p-3">
      <div>
        <p className="text-[11px] font-semibold text-gray-200">Separate touching processes</p>
        <p className="mt-1 text-[10px] leading-snug text-gray-500">
          Watershed degrouping splits crowded ACTN4 regions before nearest-neighbor distance is measured.
        </p>
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
        className="flex w-full items-center justify-between text-[10px] text-gray-500 hover:text-gray-200"
      >
        <span>Advanced degrouping settings</span>
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
              <span className="text-[9px] text-gray-500">Maximum NND link (um)</span>
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
              This cap filters NND lines and the mean NND. It does not change watershed boundaries.
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
