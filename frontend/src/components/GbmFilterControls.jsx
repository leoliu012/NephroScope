import { useEffect, useState } from 'react'
import { Loader2, RotateCcw, Undo2 } from 'lucide-react'
import { DEFAULT_FILTER_SETTINGS, REASON_INFO, workerHasStopped } from '../gbmRefinement.js'
import './gbmFilter.css'

// A number field that commits on blur or Enter, so typing "3400" does not
// measure at 3, 34 and 340 on the way.
function NumberField({ value, onCommit, min, max, step = 1, label, unit, placeholder }) {
  const [draft, setDraft] = useState(value ?? '')
  useEffect(() => { setDraft(value ?? '') }, [value])
  const commit = () => {
    if (draft === '' || draft === null) {
      if (placeholder !== undefined) onCommit(null)
      else setDraft(value ?? '')
      return
    }
    const number = Number(draft)
    if (!Number.isFinite(number) || number < min || number > max) { setDraft(value ?? ''); return }
    if (number !== value) onCommit(number)
  }
  return <label className="gf-number">
    <span>{label}</span>
    <span className="gf-number-input">
      <input className="ux-input" type="number" value={draft} min={min} max={max} step={step} placeholder={placeholder}
        onChange={event => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter') { event.currentTarget.blur() } }} />
      {unit && <em>{unit}</em>}
    </span>
  </label>
}

function stackMessage(stack, summary) {
  if (!stack) return null
  const state = stack.state
  if (state === 'waiting') return { tone: 'busy', text: `Z analysis starts when the running segmentation finishes${stack.planes ? ` (${stack.planes} Z so far)` : ''}.` }
  if (state === 'queued') return { tone: 'busy', text: `Z analysis is queued for ${stack.planes} Z.` }
  if (workerHasStopped(stack)) {
    return { tone: 'error', text: 'The analysis worker has stopped responding. This analysis starts again when the worker restarts.' }
  }
  if (state === 'running') {
    const percent = Math.round(stack.job?.progress?.percent || 0)
    return { tone: 'busy', text: `Analysing ${stack.planes} Z across the stack${percent ? ` · ${percent}%` : ''}…` }
  }
  if (state === 'failed') return { tone: 'error', text: `Z analysis failed${stack.job?.error ? `: ${stack.job.error}` : ''}.`, retry: true }
  if (summary?.stale) return { tone: 'muted', text: 'Showing the previous Z analysis until the new one is ready.' }
  return null
}

function zStepText(zStep) {
  if (!zStep?.um) return 'Not recorded in this file'
  const value = `${Number(zStep.um.toPrecision(3))} µm`
  return zStep.source === 'metadata' ? `${value} · from file` : `${value} · entered`
}

// Controls shared by the viewer and Case analysis. ``view`` is the current
// plane's refinement in the viewer; Case analysis passes ``totals`` instead.
export default function GbmFilterControls({
  settings, onChange, view, totals, showDisplayOptions = false, zStepOverride, onZStepOverride, onRetry, error, children,
  onSegmentNearby, nearbyBusy = false, keptColor = null,
}) {
  const patch = change => onChange({ ...settings, ...change })
  const summary = view?.summary
  const stack = view?.stack
  const message = stackMessage(stack, summary)
  const kept = summary?.keptSamples ?? totals?.kept
  const total = summary?.totalSamples ?? totals?.total
  const byReason = summary?.byReason || totals?.byReason || {}
  const reasons = Object.entries(byReason).sort((a, b) => (a[0] === 'kept' ? -1 : b[0] === 'kept' ? 1 : b[1] - a[1]))
  const percent = total ? Math.round(100 * kept / total) : null
  const singlePlane = view?.hasNeighbours === false || (totals?.singlePlane > 0 && totals.singlePlane === totals.measured)
  const noZStep = Boolean(view?.pieces) && !view?.zStep?.um && view?.hasNeighbours !== false

  return <section className="gf-panel" aria-label="GBM prediction filter">
    <label className="gf-switch">
      <input type="checkbox" checked={settings.crossSection} onChange={event => patch({ crossSection: event.target.checked })} />
      <span>Cross-sections only</span>
    </label>
    {settings.crossSection && <div className="gf-group">
      <div className="gf-row">
        <span>Tilt limit</span>
        <select className="ux-input" aria-label="Tilt limit" disabled={noZStep} value={settings.tiltAuto || noZStep ? 'auto' : 'manual'} onChange={event => patch({ tiltAuto: event.target.value === 'auto' })}>
          <option value="auto">Auto{Number.isFinite(view?.limitDeg) && settings.tiltAuto ? ` · ${Math.round(view.limitDeg)}°` : ''}</option>
          <option value="manual">Custom</option>
        </select>
      </div>
      {!settings.tiltAuto && !noZStep && <label className="gf-slider">
        <input type="range" min="5" max="75" step="1" value={settings.maxTiltDeg} aria-label="Maximum tilt from vertical"
          onChange={event => patch({ maxTiltDeg: Number(event.target.value) })} />
        <span>{settings.maxTiltDeg}°</span>
      </label>}
      <div className="gf-row">
        <span>Z window</span>
        <select className="ux-input" aria-label="Z window" value={settings.windowAuto ? 'auto' : 'manual'} onChange={event => patch({ windowAuto: event.target.value === 'auto' })}>
          <option value="auto">Auto, up to ±{DEFAULT_FILTER_SETTINGS.window}</option>
          <option value="manual">Custom</option>
        </select>
      </div>
      {!settings.windowAuto && <NumberField label="Up to ±" unit="Z" min={1} max={200} value={settings.window} onCommit={value => patch({ window: value ?? DEFAULT_FILTER_SETTINGS.window })} />}
      {Number.isFinite(stack?.medianReachPlanes) && stack.medianReachPlanes > 0 && <p className="gf-note">Each point measures its own range; here the median reached ±{Math.round(stack.medianReachPlanes)} Z.</p>}
      {onZStepOverride && view?.pieces && <div className="gf-row">
        <span>Z step</span>
        <span className="gf-value">{zStepText(view?.zStep)}</span>
      </div>}
      {onZStepOverride && (noZStep || zStepOverride) && <>
        <NumberField label="Enter step" unit="µm" min={0.001} max={1000} step={0.01} value={zStepOverride ?? ''} placeholder="From file" onCommit={onZStepOverride} />
        {noZStep && <p className="gf-note gf-warning">Without a Z step, tilt has no angle, so GBM is excluded by how much drift between planes widens it. Enter the step for angles and a custom limit.</p>}
      </>}
    </div>}

    <label className="gf-switch">
      <input type="checkbox" checked={settings.thicknessLimits} onChange={event => patch({ thicknessLimits: event.target.checked })} />
      <span>Thickness limits</span>
    </label>
    {settings.thicknessLimits && <div className="gf-group gf-limits">
      <NumberField label="Min" unit="nm" min={0} max={Math.max(1, settings.maxNm - 1)} value={settings.minNm} onCommit={value => patch({ minNm: value ?? DEFAULT_FILTER_SETTINGS.minNm })} />
      <NumberField label="Max" unit="nm" min={settings.minNm + 1} max={1000000} value={settings.maxNm} onCommit={value => patch({ maxNm: value ?? DEFAULT_FILTER_SETTINGS.maxNm })} />
    </div>}

    {showDisplayOptions && <label className="gf-switch">
      <input type="checkbox" checked={settings.showExcluded} onChange={event => patch({ showExcluded: event.target.checked })} />
      <span>Show excluded, coloured by reason</span>
    </label>}

    {message && <p className={`gf-status gf-status-${message.tone}`} role="status">
      {message.tone === 'busy' && <Loader2 size={12} className="animate-spin" />}
      <span>{message.text}</span>
      {message.retry && onRetry && <button type="button" className="ux-button ux-button-ghost" onClick={onRetry}>Retry</button>}
    </p>}
    {totals?.pending > 0 && <p className="gf-status gf-status-busy" role="status"><Loader2 size={12} className="animate-spin" /><span>Cross-section analysis still running for {totals.pending} Z. Their values update when it finishes.</span></p>}
    {totals?.failed > 0 && <p className="gf-status gf-status-error" role="alert"><span>Cross-section analysis failed for {totals.failed} Z; only thickness limits apply to them.</span></p>}
    {settings.crossSection && singlePlane && <div className="gf-note gf-warning">
      <p>{onSegmentNearby ? 'Only one segmented Z here, so shape rules are used instead of tilt, and they catch less.' : 'Some images have one segmented Z, so shape rules are used instead of tilt there, and they catch less.'}</p>
      {onSegmentNearby && <button type="button" className="ux-button ux-button-secondary gf-nearby" disabled={nearbyBusy} onClick={onSegmentNearby}>
        {nearbyBusy && <Loader2 size={13} className="animate-spin" />}{nearbyBusy ? 'Running nearby Z…' : 'Run model on nearby Z'}
      </button>}
    </div>}
    {settings.crossSection && totals?.noZStep > 0 && <p className="gf-note">{totals.noZStep} of {totals.measured} Z come from files with no recorded Z step. Those are excluded by how much drift between planes widens GBM, not by angle, so the tilt limit does not apply to them.</p>}
    {error && <p role="alert" className="ca-error">{error}</p>}

    {percent !== null && <div className="gf-summary">
      <p><strong>{percent}%</strong> of centerline kept <span>{kept.toLocaleString()} of {total.toLocaleString()} points{view ? ' on this Z' : ''}</span></p>
      {reasons.length > 0 && <ul className="gf-reasons">
        {reasons.map(([name, count]) => {
          const info = REASON_INFO[name] || { label: name, color: '#94a3b8' }
          const color = name === 'kept' && keptColor ? keptColor : info.color
          return <li key={name} title={info.hint}><i style={{ background: color }} />{info.label}<span>{count.toLocaleString()}</span></li>
        })}
      </ul>}
    </div>}
    {children}
  </section>
}

// What is being recalculated, while it is. ``message`` is empty when nothing is.
export function GbmRecalculatingPopup({ message }) {
  if (!message) return null
  return <div className="gf-popup" role="status" aria-live="polite">
    <Loader2 size={15} className="animate-spin" />
    <span>{message}</span>
  </div>
}

export function GbmCorrectionControls({ correction, activeTool, onSelectTool, disabled, canAnnotate, brushRadius, onBrushRadius }) {
  const { clickState, canUndo, undo, restore, sliceEditCount, imageEditCount } = correction
  return <div className="gf-corrections">
    <p className="gf-label">Corrections</p>
    {canAnnotate ? <>
      <div className="gf-tool-row">
        <button type="button" disabled={disabled} className={`ux-button ux-button-secondary${activeTool === 'gbm-add' ? ' gf-tool-active' : ''}`}
          aria-pressed={activeTool === 'gbm-add'} onClick={() => onSelectTool(activeTool === 'gbm-add' ? 'select' : 'gbm-add')}>Add GBM</button>
        <button type="button" disabled={disabled} className={`ux-button ux-button-secondary${activeTool === 'gbm-remove' ? ' gf-tool-active' : ''}`}
          aria-pressed={activeTool === 'gbm-remove'} onClick={() => onSelectTool(activeTool === 'gbm-remove' ? 'select' : 'gbm-remove')}>Remove GBM</button>
      </div>
      <label className="gf-slider gf-brush">
        <span className="gf-brush-label">Brush</span>
        <input type="range" min="1" max="100" step="1" value={Math.min(100, brushRadius)} aria-label="Brush radius in pixels"
          onChange={event => onBrushRadius(Number(event.target.value))} />
        <span>{brushRadius} px</span>
      </label>
      <div className="gf-tool-row">
        <button type="button" className="ux-button ux-button-ghost" disabled={!canUndo || clickState.busy} onClick={undo}><Undo2 size={13} />Undo</button>
        <button type="button" className="ux-button ux-button-ghost" disabled={!sliceEditCount || clickState.busy} onClick={() => restore('slice')}><RotateCcw size={13} />Restore Z</button>
        <button type="button" className="ux-button ux-button-ghost" disabled={!imageEditCount || clickState.busy} onClick={() => restore('image')}><RotateCcw size={13} />Restore image</button>
      </div>
      <p className="gf-note">{imageEditCount ? `${sliceEditCount} on this Z · ${imageEditCount} on this image. The saved model prediction is unchanged.` : 'Paint to keep, add or remove exactly what the brush covers. Click to also adjust similar GBM nearby, including on nearby Z. [ and ] change the brush size.'}</p>
    </> : <p className="gf-note">Your role can view corrections but not change them.</p>}
    {clickState.busy && <p className="gf-status gf-status-busy" role="status"><Loader2 size={12} className="animate-spin" /><span>Applying…</span></p>}
    {clickState.message && <p className="gf-note" role="status">{clickState.message}</p>}
    {clickState.error && <p className="ca-error" role="alert">{clickState.error}</p>}
  </div>
}
