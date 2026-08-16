import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Layers, Maximize2, SlidersHorizontal, X, ZoomIn, ZoomOut } from 'lucide-react'
import MultiChannelCanvas from './MultiChannelCanvas.jsx'
import ChannelControls from './ChannelControls.jsx'
import { euclideanLength, formatMicronLength } from '../expansionCalibration.js'

// A single-image panel for the expansion-factor calibrator that renders through
// the SAME pipeline as the main image viewer: MultiChannelCanvas fetches the
// raw per-channel planes and composites them with the user's channel display
// settings, wrapped in a zoom/pan viewport with an SVG overlay for drawing.
//
// Interaction mirrors the viewer's annotation tools:
//   * press-drag on empty image draws a new two-point line
//   * click a line to select it; drag its endpoints or body to adjust
//   * wheel zooms toward the cursor; Space-drag (or middle-drag) pans
//   * the Channels button opens the same per-channel controls as the viewer
//
// Line geometry stays in SOURCE-pixel coordinates via the overlay SVG's CTM
// (which includes the pan/zoom transform), so a line's length in µm is always
// length_px * pixelSizeUm, independent of zoom or channel display.

const MIN_DRAW_LENGTH_PX = 3

function clampScale(value) {
  return Math.max(0.05, Math.min(40, value))
}

export default function EfImagePanel({
  side,
  title,
  subtitle,
  apiBase,
  meta,
  zCount = 1,
  zIndex = 0,
  onZChange,
  channelSettings,
  onChannelSettingsChange,
  channelStats,
  onChannelStats,
  onAutoChannel,
  pixelSizeUm,
  drawingEnabled = false,
  lines = [],
  selectedId = null,
  onSelectLine,
  onDraw,
  onUpdateLine,
  emptyHint,
  lineColor = '#facc15',
  lineThickness = 2.4,
}) {
  const viewportRef = useRef(null)
  const svgRef = useRef(null)
  const canvasRef = useRef(null)
  const panRef = useRef(null)
  const drawRef = useRef(null)
  const fittedRef = useRef('')
  const zRafRef = useRef(null)
  const zTargetRef = useRef(zIndex)
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const [draft, setDraft] = useState(null)
  const [clickStart, setClickStart] = useState(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [channelsOpen, setChannelsOpen] = useState(false)
  const [renderError, setRenderError] = useState(null)
  const [zDraft, setZDraft] = useState(zIndex)

  const w = Math.max(1, Number(meta?.width) || 1)
  const h = Math.max(1, Number(meta?.height) || 1)

  useEffect(() => setZDraft(zIndex), [zIndex])
  useEffect(() => { setRenderError(null) }, [apiBase])
  useEffect(() => () => { if (zRafRef.current !== null) cancelAnimationFrame(zRafRef.current) }, [])

  // Live Z scrubbing, throttled to one commit per animation frame so dragging
  // the slider updates the image continuously (cached/prefetched slices render
  // instantly) without firing a load on every intermediate pixel.
  const handleZScrub = useCallback((value) => {
    zTargetRef.current = value
    setZDraft(value)
    if (zRafRef.current === null) {
      zRafRef.current = window.requestAnimationFrame(() => {
        zRafRef.current = null
        onZChange?.(zTargetRef.current)
      })
    }
  }, [onZChange])

  useEffect(() => {
    if (drawingEnabled) return
    drawRef.current = null
    setDraft(null)
    setClickStart(null)
  }, [drawingEnabled])

  useEffect(() => {
    const down = e => { if (e.code === 'Space') setSpaceHeld(true) }
    const up = e => { if (e.code === 'Space') setSpaceHeld(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  const fit = useCallback(() => {
    const vp = viewportRef.current
    if (!vp || !meta) return
    const rect = vp.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const s = Math.min(rect.width / w, rect.height / h, 1) * 0.94
    setScale(s)
    setTx((rect.width - w * s) / 2)
    setTy((rect.height - h * s) / 2)
  }, [meta, w, h])

  // Fit once the panel has a real size for each new image.
  useEffect(() => { fittedRef.current = '' }, [apiBase])
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return undefined
    const observer = new ResizeObserver(() => {
      const rect = vp.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0 && meta && fittedRef.current !== apiBase) {
        fittedRef.current = apiBase
        fit()
      }
    })
    observer.observe(vp)
    return () => observer.disconnect()
  }, [apiBase, meta, fit])

  // Native, non-passive wheel zoom (React registers wheel as passive).
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return undefined
    const onWheel = event => {
      event.preventDefault()
      const rect = vp.getBoundingClientRect()
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
      setScale(s => clampScale(s * factor))
      setTx(x => mx - (mx - x) * factor)
      setTy(y => my - (my - y) * factor)
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [])

  const clientToImg = useCallback(event => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const pt = svg.createSVGPoint()
    pt.x = event.clientX
    pt.y = event.clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const local = pt.matrixTransform(ctm.inverse())
    return { x: local.x, y: local.y }
  }, [])

  const beginPan = useCallback(event => {
    panRef.current = { startX: event.clientX - tx, startY: event.clientY - ty }
    viewportRef.current?.setPointerCapture?.(event.pointerId)
  }, [tx, ty])

  // Viewport-level pan (used when Space is held, drawing is off, or middle-drag,
  // and for presses outside the image).
  const onViewportPointerDown = useCallback(event => {
    if (event.button === 1 || event.button === 0) {
      if (event.button === 0 && drawingEnabled && !spaceHeld) return // draw handled by overlay
      beginPan(event)
    }
  }, [beginPan, drawingEnabled, spaceHeld])

  const onViewportPointerMove = useCallback(event => {
    const pan = panRef.current
    if (!pan) return
    setTx(event.clientX - pan.startX)
    setTy(event.clientY - pan.startY)
  }, [])

  const endViewportPointer = useCallback(event => {
    panRef.current = null
    try { viewportRef.current?.releasePointerCapture?.(event.pointerId) } catch { /* ignore */ }
  }, [])

  // Overlay (drawing) interactions.
  const onOverlayPointerDown = useCallback((event) => {
    if (spaceHeld || event.button === 1 || !drawingEnabled) return // let the viewport pan
    if (event.button !== 0) return
    event.stopPropagation()
    const start = clientToImg(event)
    if (clickStart) {
      if (euclideanLength(clickStart, [start.x, start.y]) >= MIN_DRAW_LENGTH_PX) {
        onDraw?.({ p0: clickStart, p1: [start.x, start.y] })
      }
      setClickStart(null)
      setDraft(null)
      return
    }
    onSelectLine?.(null)
    drawRef.current = { mode: 'draw', start, moved: false }
    setDraft({ p0: [start.x, start.y], p1: [start.x, start.y] })
    svgRef.current?.setPointerCapture?.(event.pointerId)
  }, [clickStart, clientToImg, drawingEnabled, onDraw, onSelectLine, spaceHeld])

  const onLinePointerDown = useCallback((event, line) => {
    if (spaceHeld || event.button !== 0) return
    event.stopPropagation()
    onSelectLine?.(line.id)
    if (!drawingEnabled || line.pending) return
    const start = clientToImg(event)
    drawRef.current = { mode: 'move', id: line.id, start, orig: { p0: [...line.p0], p1: [...line.p1] } }
    svgRef.current?.setPointerCapture?.(event.pointerId)
  }, [clientToImg, drawingEnabled, onSelectLine, spaceHeld])

  const onEndpointPointerDown = useCallback((event, line, endpoint) => {
    if (spaceHeld || event.button !== 0 || !drawingEnabled) return
    event.stopPropagation()
    onSelectLine?.(line.id)
    drawRef.current = { mode: 'endpoint', id: line.id, endpoint }
    svgRef.current?.setPointerCapture?.(event.pointerId)
  }, [drawingEnabled, onSelectLine, spaceHeld])

  const onOverlayPointerMove = useCallback(event => {
    const drag = drawRef.current
    const p = clientToImg(event)
    if (!drag && clickStart) {
      setDraft({ p0: clickStart, p1: [p.x, p.y] })
      return
    }
    if (!drag) return
    if (drag.mode === 'draw') {
      drag.moved = drag.moved || euclideanLength([drag.start.x, drag.start.y], [p.x, p.y]) >= MIN_DRAW_LENGTH_PX
      setDraft({ p0: [drag.start.x, drag.start.y], p1: [p.x, p.y] })
    } else if (drag.mode === 'endpoint') {
      onUpdateLine?.(drag.id, drag.endpoint === 0 ? { p0: [p.x, p.y] } : { p1: [p.x, p.y] })
    } else if (drag.mode === 'move') {
      const dx = p.x - drag.start.x
      const dy = p.y - drag.start.y
      onUpdateLine?.(drag.id, {
        p0: [drag.orig.p0[0] + dx, drag.orig.p0[1] + dy],
        p1: [drag.orig.p1[0] + dx, drag.orig.p1[1] + dy],
      })
    }
  }, [clickStart, clientToImg, onUpdateLine])

  const endOverlayPointer = useCallback(event => {
    const drag = drawRef.current
    drawRef.current = null
    try { svgRef.current?.releasePointerCapture?.(event.pointerId) } catch { /* ignore */ }
    if (drag?.mode === 'draw') {
      setDraft(current => {
        if (current && drag.moved && euclideanLength(current.p0, current.p1) >= MIN_DRAW_LENGTH_PX) {
          onDraw?.({ p0: current.p0, p1: current.p1 })
          setClickStart(null)
          return null
        }
        setClickStart(current?.p0 || null)
        return current ? { p0: current.p0, p1: current.p0 } : null
      })
    }
  }, [onDraw])

  const inv = 1 / (scale || 1)
  const strokePx = Math.max(1, Number(lineThickness) || 2.4) * inv
  const hitPx = 16 * inv
  const handlePx = 5.5 * inv
  const fontPx = 13 * inv

  const lengthLabel = useCallback(line => {
    const px = euclideanLength(line.p0, line.p1)
    return formatMicronLength(px * (Number(pixelSizeUm) || 0))
  }, [pixelSizeUm])

  const renderLine = (line, key) => {
    const [x1, y1] = line.p0
    const [x2, y2] = line.p1
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    const isSelected = line.id === selectedId
    const color = line.color || lineColor
    const label = lengthLabel(line)
    const labelText = line.labelPrefix ? `${line.labelPrefix} · ${label}` : label
    return (
      <g key={key}>
        {drawingEnabled && !line.pending && (
          <line
            x1={x1} y1={y1} x2={x2} y2={y2}
            stroke="transparent" strokeWidth={hitPx} strokeLinecap="round"
            style={{ cursor: line.pending ? 'default' : 'move' }}
            onPointerDown={event => onLinePointerDown(event, line)}
          />
        )}
        <line
          x1={x1} y1={y1} x2={x2} y2={y2}
          stroke={color} strokeWidth={strokePx} strokeLinecap="round"
          strokeDasharray={line.pending ? `${6 * inv} ${5 * inv}` : undefined}
          style={{ filter: isSelected ? 'drop-shadow(0 0 3px #ffffff)' : undefined, pointerEvents: 'none' }}
        />
        <g style={{ pointerEvents: 'none' }}>
          <rect
            x={mx + 8 * inv} y={my - fontPx} width={(labelText.length * 0.62 + 1.2) * fontPx} height={fontPx * 1.5}
            rx={3 * inv} fill="rgba(6,10,15,0.82)" stroke={color} strokeWidth={0.8 * inv}
          />
          <text x={mx + 8 * inv + 0.6 * fontPx} y={my + 0.12 * fontPx} fontSize={fontPx} fill="#f8fafc" fontFamily="ui-monospace, monospace">
            {labelText}
          </text>
        </g>
        {drawingEnabled && isSelected && !line.pending && [line.p0, line.p1].map((point, index) => (
          <rect
            key={index}
            x={point[0] - handlePx} y={point[1] - handlePx}
            width={handlePx * 2} height={handlePx * 2} rx={1.6 * inv}
            fill="#0b0f14" stroke="#ffffff" strokeWidth={1.4 * inv}
            style={{ cursor: 'crosshair' }}
            onPointerDown={event => onEndpointPointerDown(event, line, index)}
          />
        ))}
      </g>
    )
  }

  const transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  const badgeColor = side === 'A' ? 'var(--accent)' : '#a855f7'
  const imageReady = Boolean(apiBase && meta?.width && meta?.height)

  return (
    <div className="ef-panel">
      <div className="ef-panel-head">
        {side && <span className="ef-canvas-badge" style={{ borderColor: badgeColor }}>{side}</span>}
        <div className="min-w-0">
          <p className="ef-canvas-title">{title}</p>
          {subtitle && <p className="ef-canvas-subtitle" title={subtitle}>{subtitle}</p>}
        </div>
        <div className="ef-panel-tools">
          <button type="button" className="ux-icon-button" title="Zoom out" onClick={() => setScale(s => clampScale(s / 1.15))}><ZoomOut size={14} /></button>
          <span className="ef-canvas-zoom-label">{Math.round(scale * 100)}%</span>
          <button type="button" className="ux-icon-button" title="Zoom in" onClick={() => setScale(s => clampScale(s * 1.15))}><ZoomIn size={14} /></button>
          <button type="button" className="ux-icon-button" title="Fit to panel" onClick={fit}><Maximize2 size={14} /></button>
          <button
            type="button"
            className={`ux-icon-button ${channelsOpen ? 'ux-tool-button-active' : ''}`}
            title="Channel display"
            onClick={() => setChannelsOpen(open => !open)}
          >
            <SlidersHorizontal size={14} />
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className={`ef-panel-stage ${spaceHeld ? 'is-panning' : ''} ${drawingEnabled ? 'is-drawing' : ''}`}
        onPointerDown={onViewportPointerDown}
        onPointerMove={onViewportPointerMove}
        onPointerUp={endViewportPointer}
        onPointerCancel={endViewportPointer}
      >
        <div className="ef-panel-inner" style={{ transform, transformOrigin: '0 0' }}>
          <div style={{ position: 'relative', width: w, height: h }}>
            {imageReady && (
              <MultiChannelCanvas
                apiBase={apiBase}
                meta={meta}
                settings={channelSettings}
                zIndex={zIndex}
                zCount={zCount}
                prefetchAllZ={zCount > 1}
                canvasRef={canvasRef}
                onError={setRenderError}
                onChannelStats={onChannelStats}
              />
            )}
            <svg
              ref={svgRef}
              className="ef-panel-overlay"
              width={w}
              height={h}
              viewBox={`0 0 ${w} ${h}`}
              style={{ pointerEvents: drawingEnabled ? 'auto' : 'none' }}
              onPointerDown={onOverlayPointerDown}
              onPointerMove={onOverlayPointerMove}
              onPointerUp={endOverlayPointer}
              onPointerCancel={endOverlayPointer}
            >
              {drawingEnabled && <rect x={0} y={0} width={w} height={h} fill="transparent" />}
              {lines.map((line, index) => renderLine(line, line.id || index))}
              {draft && renderLine({ id: 'draft', p0: draft.p0, p1: draft.p1, color: lineColor, pending: true }, 'draft')}
            </svg>
          </div>
        </div>

        {renderError && (
          <div className="ef-panel-error">{renderError}</div>
        )}
        {drawingEnabled && lines.length === 0 && !draft && emptyHint && (
          <div className="ef-canvas-empty">{emptyHint}</div>
        )}

        {channelsOpen && (
          <div
            className="ef-panel-channels"
            onPointerDown={e => e.stopPropagation()}
            onPointerMove={e => e.stopPropagation()}
            onPointerUp={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            onWheel={e => e.stopPropagation()}
            onWheelCapture={e => e.stopPropagation()}
          >
            <div className="ef-panel-channels-head">
              <span className="flex items-center gap-2 text-[12px] font-semibold text-[var(--text)]"><Layers size={13} /> Channels</span>
              <button type="button" className="ux-icon-button" onClick={() => setChannelsOpen(false)}><X size={14} /></button>
            </div>
            <div className="ef-panel-channels-body">
              {channelSettings ? (
                <ChannelControls
                  meta={meta}
                  settings={channelSettings}
                  channelStats={channelStats}
                  onChange={onChannelSettingsChange}
                  onAutoChannel={onAutoChannel}
                />
              ) : (
                <p className="px-3 py-3 text-[12px] text-[var(--text-subtle)]">Loading channels…</p>
              )}
            </div>
          </div>
        )}
      </div>

      {zCount > 1 && (
        <div className="ef-panel-zbar">
          <span className="flex items-center gap-1"><Layers size={12} /> Z {zDraft + 1}/{zCount}</span>
          <input
            type="range" min={0} max={zCount - 1} step={1} value={zDraft}
            onInput={e => handleZScrub(Number(e.currentTarget.value))}
            onChange={e => onZChange?.(Number(e.currentTarget.value))}
          />
        </div>
      )}
    </div>
  )
}
