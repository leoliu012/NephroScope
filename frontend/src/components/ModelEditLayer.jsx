import { useEffect, useRef, useState } from 'react'

function clientToImage(svg, clientX, clientY) {
  const point = svg.createSVGPoint()
  point.x = clientX
  point.y = clientY
  const matrix = svg.getScreenCTM()
  if (!matrix) return null
  const transformed = point.matrixTransform(matrix.inverse())
  return [transformed.x, transformed.y]
}

// Further than this on screen and a press has become a stroke, not a click.
const CLICK_TOLERANCE_PX = 4

// The Add GBM / Remove GBM brush. A click asks for a smart correction around that
// point; a drag paints exactly what it covers. Sizes are in image pixels, so the
// brush keeps its true size at any zoom.
export default function ModelEditLayer({ width, height, active, tool, edits, busy, brushRadius, onClick, onStroke, onHover }) {
  const svgRef = useRef(null)
  const strokeRef = useRef(null)
  const [cursor, setCursor] = useState(null)
  const [draft, setDraft] = useState(null)
  const imageWidth = Math.max(1, Number(width) || 1)
  const imageHeight = Math.max(1, Number(height) || 1)
  const markerRadius = Math.max(imageWidth, imageHeight) / 110
  const adding = tool === 'gbm-add'
  const toolColor = adding ? '#22c55e' : '#ff00ff'

  // A finished stroke stays visible until the server has applied it.
  useEffect(() => { if (!busy && !strokeRef.current) setDraft(null) }, [busy])
  useEffect(() => {
    if (active) return
    strokeRef.current = null
    setDraft(null)
    setCursor(null)
  }, [active])

  const point = event => (svgRef.current ? clientToImage(svgRef.current, event.clientX, event.clientY) : null)

  const handlePointerDown = event => {
    if (!active || event.button !== 0 || busy) return
    const start = point(event)
    if (!start) return
    event.preventDefault()
    event.stopPropagation()
    strokeRef.current = { points: [start], startX: event.clientX, startY: event.clientY, moved: false, pointerId: event.pointerId }
    setDraft([start])
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* optional */ }
  }

  const handlePointerMove = event => {
    if (!active) return
    const next = point(event)
    if (!next) return
    setCursor(next)
    onHover?.(next[0], next[1])
    const stroke = strokeRef.current
    if (!stroke) return
    event.preventDefault()
    event.stopPropagation()
    if (Math.hypot(event.clientX - stroke.startX, event.clientY - stroke.startY) > CLICK_TOLERANCE_PX) stroke.moved = true
    const last = stroke.points.at(-1)
    if (Math.hypot(next[0] - last[0], next[1] - last[1]) >= Math.max(0.75, brushRadius / 5)) {
      stroke.points.push(next)
      setDraft([...stroke.points])
    }
  }

  const finish = event => {
    const stroke = strokeRef.current
    strokeRef.current = null
    if (!stroke) return
    event.stopPropagation()
    try { event.currentTarget.releasePointerCapture?.(stroke.pointerId) } catch { /* optional */ }
    if (stroke.moved) {
      const end = point(event)
      onStroke?.(end ? [...stroke.points, end] : stroke.points)
    } else {
      setDraft(null)
      onClick?.(stroke.points[0][0], stroke.points[0][1])
    }
  }

  return (
    <svg
      ref={svgRef}
      className="model-edit-layer"
      viewBox={`0 0 ${imageWidth} ${imageHeight}`}
      width={imageWidth}
      height={imageHeight}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={() => { setCursor(null); onHover?.(null, null) }}
      style={{
        position: 'absolute', top: 0, left: 0, width: imageWidth, height: imageHeight,
        pointerEvents: active ? 'auto' : 'none',
        cursor: active ? (busy ? 'progress' : 'none') : 'default',
      }}
    >
      {(edits || []).filter(edit => edit.kind === 'include' || edit.kind === 'exclude' || edit.kind === 'add').map(edit => {
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
      {draft && draft.length > 1 && (
        <polyline
          points={draft.map(item => item.join(',')).join(' ')}
          fill="none"
          stroke={toolColor}
          strokeOpacity="0.4"
          strokeWidth={2 * brushRadius}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {active && cursor && (
        <g transform={`translate(${cursor[0]} ${cursor[1]})`} pointerEvents="none">
          <circle r={brushRadius} fill={`${toolColor}26`} stroke="#000" strokeOpacity="0.6" strokeWidth="3" vectorEffect="non-scaling-stroke" />
          <circle r={brushRadius} fill="none" stroke={toolColor} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </g>
      )}
    </svg>
  )
}
