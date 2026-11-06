import { useEffect, useLayoutEffect, useRef } from 'react'

// Further than this on screen and a press has become a stroke, not a click.
const CLICK_TOLERANCE_PX = 4
// The stroke preview only has to look right, so it is drawn smaller than the image.
const PREVIEW_MAX_SIZE = 1024

// The Add GBM / Remove GBM brush. A click asks for a smart correction around that point; a
// drag paints exactly what it covers. Sizes are in image pixels, so the brush keeps its true
// size at any zoom.
//
// Painting must not repaint anything image-sized. The cursor is a small element moved by a
// transform, and the stroke grows on a small canvas segment by segment, so a move costs the
// same however long the stroke is. Nothing here goes through React while painting.
export default function ModelEditLayer({ width, height, active, tool, edits, busy, brushRadius, zoom = 1, onClick, onStroke, onHover }) {
  const rootRef = useRef(null)
  const cursorRef = useRef(null)
  const previewRef = useRef(null)
  const strokeRef = useRef(null)
  const hoverFrameRef = useRef(null)
  const latestHoverRef = useRef(null)
  const imageWidth = Math.max(1, Number(width) || 1)
  const imageHeight = Math.max(1, Number(height) || 1)
  const markerRadius = Math.max(imageWidth, imageHeight) / 110
  const previewScale = Math.min(1, PREVIEW_MAX_SIZE / Math.max(imageWidth, imageHeight))
  const toolColor = tool === 'gbm-add' ? '#22c55e' : '#ff00ff'
  const handlersRef = useRef({})
  handlersRef.current = { onClick, onStroke, onHover, brushRadius, busy, active, toolColor, previewScale, imageWidth, imageHeight }

  const clearPreview = () => {
    const canvas = previewRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  }

  // A finished stroke stays visible until the server has applied it.
  useEffect(() => { if (!busy && !strokeRef.current) clearPreview() }, [busy])
  useEffect(() => {
    if (active) return
    strokeRef.current = null
    clearPreview()
    if (cursorRef.current) cursorRef.current.style.display = 'none'
  }, [active])

  useLayoutEffect(() => {
    if (cursorRef.current) {
      cursorRef.current.style.width = `${2 * brushRadius}px`
      cursorRef.current.style.height = `${2 * brushRadius}px`
      cursorRef.current.style.borderWidth = `${1.5 / Math.max(zoom, 0.02)}px`
      cursorRef.current.style.boxShadow = `0 0 0 ${1 / Math.max(zoom, 0.02)}px rgba(0,0,0,0.55)`
    }
  }, [brushRadius, zoom])

  const toImage = (event, rect) => [
    (event.clientX - rect.left) * imageWidth / rect.width,
    (event.clientY - rect.top) * imageHeight / rect.height,
  ]

  const moveCursor = point => {
    const cursor = cursorRef.current
    if (!cursor) return
    const radius = handlersRef.current.brushRadius
    cursor.style.display = 'block'
    cursor.style.transform = `translate3d(${point[0] - radius}px, ${point[1] - radius}px, 0)`
    latestHoverRef.current = point
    if (hoverFrameRef.current === null) {
      hoverFrameRef.current = window.requestAnimationFrame(() => {
        hoverFrameRef.current = null
        const latest = latestHoverRef.current
        if (latest) handlersRef.current.onHover?.(latest[0], latest[1])
      })
    }
  }

  const drawSegment = (from, to) => {
    const canvas = previewRef.current
    const context = canvas?.getContext('2d')
    if (!context) return
    const { brushRadius: radius, previewScale: scale, toolColor: color } = handlersRef.current
    context.strokeStyle = color
    context.fillStyle = color
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.lineWidth = 2 * radius * scale
    context.beginPath()
    context.moveTo(from[0] * scale, from[1] * scale)
    context.lineTo(to[0] * scale + 0.01, to[1] * scale)
    context.stroke()
  }

  const handlePointerDown = event => {
    if (!active || event.button !== 0 || busy || !rootRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const rect = rootRef.current.getBoundingClientRect()
    const start = toImage(event, rect)
    strokeRef.current = { points: [start], startX: event.clientX, startY: event.clientY, moved: false, pointerId: event.pointerId, rect }
    clearPreview()
    drawSegment(start, start)
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* optional */ }
  }

  const handlePointerMove = event => {
    if (!active || !rootRef.current) return
    const stroke = strokeRef.current
    const rect = stroke?.rect || rootRef.current.getBoundingClientRect()
    moveCursor(toImage(event, rect))
    if (!stroke) return
    event.preventDefault()
    event.stopPropagation()
    if (Math.hypot(event.clientX - stroke.startX, event.clientY - stroke.startY) > CLICK_TOLERANCE_PX) stroke.moved = true
    const spacing = Math.max(0.75, handlersRef.current.brushRadius / 5)
    // Pointer samples between frames too, so fast strokes keep their shape.
    const samples = event.nativeEvent.getCoalescedEvents?.() || []
    for (const sample of samples.length ? samples : [event]) {
      const next = toImage(sample, rect)
      const last = stroke.points.at(-1)
      if (Math.hypot(next[0] - last[0], next[1] - last[1]) < spacing) continue
      drawSegment(last, next)
      stroke.points.push(next)
    }
  }

  const finish = event => {
    const stroke = strokeRef.current
    strokeRef.current = null
    if (!stroke) return
    event.stopPropagation()
    try { event.currentTarget.releasePointerCapture?.(stroke.pointerId) } catch { /* optional */ }
    if (stroke.moved) {
      onStroke?.([...stroke.points, toImage(event, stroke.rect)])
    } else {
      clearPreview()
      onClick?.(stroke.points[0][0], stroke.points[0][1])
    }
  }

  const leave = () => {
    if (cursorRef.current) cursorRef.current.style.display = 'none'
    latestHoverRef.current = null
    onHover?.(null, null)
  }

  const markers = (edits || []).filter(edit => edit.kind === 'include' || edit.kind === 'exclude' || edit.kind === 'add')

  return (
    <div
      ref={rootRef}
      className="model-edit-layer"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={leave}
      style={{
        position: 'absolute', top: 0, left: 0, width: imageWidth, height: imageHeight, overflow: 'hidden', touchAction: 'none',
        pointerEvents: active ? 'auto' : 'none',
        cursor: active ? (busy ? 'progress' : 'none') : 'default',
      }}
    >
      {markers.length > 0 && (
        <svg viewBox={`0 0 ${imageWidth} ${imageHeight}`} width={imageWidth} height={imageHeight} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}>
          {markers.map(edit => {
            const positive = edit.kind !== 'exclude'
            const color = positive ? '#22c55e' : '#ff00ff'
            return (
              <g key={edit.id} transform={`translate(${edit.x} ${edit.y})`} aria-label={positive ? 'Added or kept here' : 'Removed here'}>
                <circle r={markerRadius} fill="rgba(0,0,0,0.55)" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                <line x1={-markerRadius * 0.55} x2={markerRadius * 0.55} y1="0" y2="0" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                {positive && <line x1="0" x2="0" y1={-markerRadius * 0.55} y2={markerRadius * 0.55} stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
              </g>
            )
          })}
        </svg>
      )}
      <canvas
        ref={previewRef}
        width={Math.round(imageWidth * previewScale)}
        height={Math.round(imageHeight * previewScale)}
        style={{ position: 'absolute', top: 0, left: 0, width: imageWidth, height: imageHeight, opacity: 0.4, pointerEvents: 'none' }}
      />
      <div
        ref={cursorRef}
        className="model-edit-cursor"
        style={{ display: 'none', borderColor: toolColor, background: `${toolColor}26` }}
      />
    </div>
  )
}
