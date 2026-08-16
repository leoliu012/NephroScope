import { useState } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff, SlidersHorizontal, WandSparkles } from 'lucide-react'
import { CHANNEL_MARKERS, isNhsEsterChannel, markerLabel, sourceValueMax } from '../channelDisplay.js'

const SLIDER_STEPS = 4096

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function updateAt(settings, index, patch) {
  return settings.map((setting, itemIndex) => itemIndex === index ? { ...setting, ...patch } : setting)
}

function formatInteger(value) {
  const number = Math.round(Number(value) || 0)
  return Number.isFinite(number) ? `${number}` : '—'
}

function defaultCollapsedChannels(settings) {
  return new Set((settings || [])
    .filter(setting => !isNhsEsterChannel(setting))
    .map(setting => setting.index))
}

function getDomain(stats, sourceMax) {
  if (!stats) return { min: 0, max: sourceMax }
  const observedMin = Number.isFinite(Number(stats.min)) ? Number(stats.min) : 0
  const observedMax = Number.isFinite(Number(stats.max)) ? Number(stats.max) : sourceMax
  const span = Math.max(1, observedMax - observedMin)
  const padding = Math.max(1, Math.round(span * 0.02))
  const min = clamp(observedMin - padding, 0, sourceMax - 1)
  const max = clamp(observedMax + padding, min + 1, sourceMax)
  return { min, max }
}

function toSliderValue(actualValue, domain) {
  const span = Math.max(1, domain.max - domain.min)
  return Math.round(((actualValue - domain.min) / span) * SLIDER_STEPS)
}

function fromSliderValue(sliderValue, domain) {
  const span = Math.max(1, domain.max - domain.min)
  return Math.round(domain.min + (Number(sliderValue) / SLIDER_STEPS) * span)
}

function getDisplayDomain(rawDomain, sourceMax, inverted) {
  if (!inverted) return rawDomain
  return {
    min: sourceMax - rawDomain.max,
    max: sourceMax - rawDomain.min,
  }
}

function getDisplayWindow(setting, sourceMax) {
  if (!setting.inverted) return { min: Number(setting.min), max: Number(setting.max) }
  return {
    min: sourceMax - Number(setting.max),
    max: sourceMax - Number(setting.min),
  }
}

function displayWindowToRawPatch(displayWindow, sourceMax, inverted) {
  const min = Math.round(displayWindow.min)
  const max = Math.round(displayWindow.max)
  if (!inverted) return { min, max }
  return {
    min: sourceMax - max,
    max: sourceMax - min,
  }
}

function getDisplayedObservedRange(stats, sourceMax, inverted) {
  if (!stats) return null
  const min = Number(stats.min)
  const max = Number(stats.max)
  if (!inverted) return { min, max }
  return { min: sourceMax - max, max: sourceMax - min }
}

function normalizeWindow(window, bounds) {
  const span = Math.max(1, bounds.max - bounds.min)
  const width = clamp(Math.max(1, Number(window.max) - Number(window.min)), 1, span)
  const center = clamp(
    (Number(window.min) + Number(window.max)) / 2,
    bounds.min + (width / 2),
    bounds.max - (width / 2),
  )
  return {
    min: center - (width / 2),
    max: center + (width / 2),
  }
}

function brightnessValue(window, domain) {
  const normalized = normalizeWindow(window, domain)
  const width = normalized.max - normalized.min
  const travel = Math.max(0, (domain.max - domain.min) - width)
  if (travel <= 1e-9) return 0
  return clamp(Math.round(100 - (((normalized.min - domain.min) / travel) * 200)), -100, 100)
}

function windowForBrightness(value, window, domain) {
  const width = Math.min(Math.max(1, window.max - window.min), Math.max(1, domain.max - domain.min))
  const travel = Math.max(0, (domain.max - domain.min) - width)
  const offset = ((100 - Number(value)) / 200) * travel
  return {
    min: domain.min + offset,
    max: domain.min + offset + width,
  }
}

function contrastValue(window, domain) {
  const width = Math.max(1, Number(window.max) - Number(window.min))
  const domainSpan = Math.max(1, domain.max - domain.min)
  return clamp(domainSpan / width, 0.25, 8)
}

function windowForContrast(value, window, referenceDomain, fullDomain) {
  const center = (Number(window.min) + Number(window.max)) / 2
  const referenceSpan = Math.max(1, referenceDomain.max - referenceDomain.min)
  const nextWidth = clamp(referenceSpan / Math.max(0.25, Number(value)), 1, fullDomain.max - fullDomain.min)
  return normalizeWindow({
    min: center - (nextWidth / 2),
    max: center + (nextWidth / 2),
  }, fullDomain)
}

function HistogramBox({ stats, setting, sourceMax }) {
  const rawDomain = getDomain(stats, sourceMax)
  const domain = getDisplayDomain(rawDomain, sourceMax, setting.inverted)
  const rawBins = Array.isArray(stats?.histogramBins) && stats.histogramBins.length ? stats.histogramBins : []
  const bins = setting.inverted ? [...rawBins].reverse() : rawBins
  const displayWindow = getDisplayWindow(setting, sourceMax)
  const maxBin = Math.max(1, ...(bins.length ? bins : [1]))
  const minX = ((clamp(displayWindow.min, domain.min, domain.max) - domain.min) / Math.max(1, domain.max - domain.min)) * 100
  const maxX = ((clamp(displayWindow.max, domain.min, domain.max) - domain.min) / Math.max(1, domain.max - domain.min)) * 100
  const path = bins.map((count, index) => {
    const x = bins.length <= 1 ? 0 : (index / (bins.length - 1)) * 100
    const y = 100 - ((count / maxBin) * 100)
    return `${x},${y}`
  }).join(' ')

  return (
    <div className="channel-histogram-shell">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="channel-histogram-svg" aria-label="Channel histogram">
        <rect x="0" y="0" width="100" height="100" className="channel-histogram-bg" />
        {bins.length > 0 && (
          <polyline
            fill="none"
            points={path}
            className="channel-histogram-line"
          />
        )}
        <line x1={minX} y1="0" x2={minX} y2="100" className="channel-histogram-marker channel-histogram-marker-min" />
        <line x1={maxX} y1="0" x2={maxX} y2="100" className="channel-histogram-marker channel-histogram-marker-max" />
      </svg>
      <div className="channel-histogram-axis">
        <span>{formatInteger(domain.min)}</span>
        <span>{formatInteger(domain.max)}</span>
      </div>
    </div>
  )
}

function FineSlider({ label, settingValue, domain, onChange, displayValue }) {
  return (
    <div className="channel-bc-row">
      <input
        type="range"
        min={0}
        max={SLIDER_STEPS}
        step={1}
        value={toSliderValue(clamp(settingValue, domain.min, domain.max), domain)}
        onInput={event => onChange(fromSliderValue(event.currentTarget.value, domain))}
        className="channel-range channel-range-imagej"
      />
      <div className="channel-bc-row-footer">
        <span className="channel-bc-row-label">{label}</span>
        <span className="channel-bc-row-value">{displayValue}</span>
      </div>
    </div>
  )
}

function DirectSlider({ label, min, max, step = 1, value, displayValue, onChange }) {
  return (
    <div className="channel-bc-row">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={event => onChange(Number(event.currentTarget.value))}
        className="channel-range channel-range-imagej"
      />
      <div className="channel-bc-row-footer">
        <span className="channel-bc-row-label">{label}</span>
        <span className="channel-bc-row-value">{displayValue}</span>
      </div>
    </div>
  )
}

export default function ChannelControls({
  meta,
  settings,
  channelStats,
  onChange,
  onAutoChannel,
}) {
  const [collapsedChannels, setCollapsedChannels] = useState(() => defaultCollapsedChannels(settings))

  if (!settings?.length) return null
  const sourceMax = sourceValueMax(meta)
  const toggleChannel = (index) => {
    setCollapsedChannels(current => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="ux-card p-3">
        <div className="flex items-center gap-2 text-[12px] font-semibold text-[var(--text)]">
          <SlidersHorizontal size={13} /> Channel display
        </div>
      </div>

      {settings.map(setting => {
        const label = markerLabel(setting)
        const stats = channelStats?.[setting.index] || null
        const rawDomain = getDomain(stats, sourceMax)
        const domain = getDisplayDomain(rawDomain, sourceMax, setting.inverted)
        const fullDomain = { min: 0, max: sourceMax }
        const displayWindow = getDisplayWindow(setting, sourceMax)
        const displayedObservedRange = getDisplayedObservedRange(stats, sourceMax, setting.inverted)
        const lowerLabel = setting.inverted ? 'Maximum' : 'Minimum'
        const upperLabel = setting.inverted ? 'Minimum' : 'Maximum'
        const brightness = brightnessValue(displayWindow, domain)
        const contrast = contrastValue(displayWindow, domain)
        const collapsed = collapsedChannels.has(setting.index)

        const applyDisplayWindow = nextWindow => {
          const normalized = normalizeWindow(nextWindow, fullDomain)
          onChange(updateAt(settings, setting.index, {
            ...displayWindowToRawPatch(normalized, sourceMax, setting.inverted),
            brightness: 0,
            contrast: 1,
            autoStep: 0,
          }))
        }

        return (
          <div key={setting.index} className="ux-card space-y-3 p-3">
            <div className="flex items-start justify-between gap-3">
              <button
                type="button"
                onClick={() => toggleChannel(setting.index)}
                className="flex min-w-0 flex-1 items-start gap-2 text-left"
                aria-expanded={!collapsed}
                title={collapsed ? 'Expand channel' : 'Fold channel'}
              >
                <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center text-[var(--text-subtle)]">
                  {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] font-semibold text-[var(--text)]">Channel {setting.index + 1}</span>
                  <span className="block truncate text-[11px] text-[var(--text-subtle)]">{label}</span>
                </span>
              </button>
              <label className="flex items-center gap-2 text-[11px] text-[var(--text-subtle)]">
                <input
                  type="checkbox"
                  checked={setting.visible}
                  onChange={event => onChange(updateAt(settings, setting.index, { visible: event.currentTarget.checked }))}
                />
                {setting.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </label>
            </div>

            {!collapsed && (
              <>
            <label className="block">
              <span className="mb-1 block text-[11px] text-[var(--text-subtle)]">Marker / antibody</span>
              <select
                value={setting.marker}
                onChange={event => onChange(updateAt(settings, setting.index, { marker: event.target.value }))}
                className="ux-select"
              >
                {CHANNEL_MARKERS.map(marker => <option key={marker} value={marker}>{marker}</option>)}
              </select>
            </label>

            {setting.marker === 'Custom' && (
              <label className="block">
                <span className="mb-1 block text-[11px] text-[var(--text-subtle)]">Custom marker</span>
                <input
                  value={setting.customMarker}
                  onChange={event => onChange(updateAt(settings, setting.index, { customMarker: event.target.value }))}
                  placeholder="Enter marker name"
                  className="ux-input"
                />
              </label>
            )}

            <label className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-[var(--text-subtle)]">Display color</span>
              <input
                type="color"
                value={setting.color}
                onChange={event => onChange(updateAt(settings, setting.index, { color: event.target.value }))}
                className="channel-color-input"
              />
            </label>

            <div className="channel-imagej-panel">
              <HistogramBox stats={stats} setting={setting} sourceMax={sourceMax} />

              <div className="channel-window-values">
                <div>
                  <div className="channel-window-caption">{lowerLabel}</div>
                  <div className="channel-window-number">{formatInteger(displayWindow.min)}</div>
                </div>
                <div className="text-right">
                  <div className="channel-window-caption">{upperLabel}</div>
                  <div className="channel-window-number">{formatInteger(displayWindow.max)}</div>
                </div>
              </div>

              <FineSlider
                label={lowerLabel}
                domain={domain}
                settingValue={displayWindow.min}
                displayValue={formatInteger(displayWindow.min)}
                onChange={value => {
                  const nextMinimum = clamp(value, domain.min, Math.max(domain.min, displayWindow.max - 1))
                  applyDisplayWindow({
                    min: nextMinimum,
                    max: displayWindow.max,
                  })
                }}
              />
              <FineSlider
                label={upperLabel}
                domain={domain}
                settingValue={displayWindow.max}
                displayValue={formatInteger(displayWindow.max)}
                onChange={value => {
                  const nextMaximum = clamp(value, Math.min(domain.max, displayWindow.min + 1), domain.max)
                  applyDisplayWindow({
                    min: displayWindow.min,
                    max: nextMaximum,
                  })
                }}
              />
              <DirectSlider
                label="Brightness"
                min={-100}
                max={100}
                step={1}
                value={brightness}
                displayValue={`${brightness > 0 ? '+' : ''}${formatInteger(brightness)}`}
                onChange={value => applyDisplayWindow(windowForBrightness(value, displayWindow, domain))}
              />
              <DirectSlider
                label="Contrast"
                min={0.25}
                max={8}
                step={0.05}
                value={contrast}
                displayValue={`${Number(contrast).toFixed(2)}x`}
                onChange={value => applyDisplayWindow(windowForContrast(value, displayWindow, domain, fullDomain))}
              />

              <div className="mt-3 flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-[11px] text-[var(--text-subtle)]">
                  <input
                    type="checkbox"
                    checked={Boolean(setting.inverted)}
                    onChange={event => onChange(updateAt(settings, setting.index, { inverted: event.currentTarget.checked }))}
                  />
                  <span>Invert black / white</span>
                </label>
                <button
                  type="button"
                  onClick={() => onAutoChannel?.(setting.index)}
                  className="ux-button ux-button-secondary min-h-0 px-3 py-2 text-[11px]"
                >
                  <WandSparkles size={12} /> Auto
                </button>
              </div>

              <div className="mt-2 text-[11px] text-[var(--text-subtle)]">
                {stats ? (
                  <span>Displayed pixel range {formatInteger(displayedObservedRange.min)}–{formatInteger(displayedObservedRange.max)}</span>
                ) : (
                  <span>Loading histogram...</span>
                )}
              </div>
            </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
