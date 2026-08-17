import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { normalizePolygonRoi } from '../modelAnalysis.js'

function clientToImage(svg, clientX, clientY) {
  const point = svg.createSVGPoint()
  point.x = clientX
  point.y = clientY
  const matrix = svg.getScreenCTM()
  if (!matrix) return null
  const transformed = point.matrixTransform(matrix.inverse())
  return [transformed.x, transformed.y]
}

function pointString(points) {
  return (points || []).map(point => `${point[0]},${point[1]}`).join(' ')
}

function roiBounds(roi) {
  const points = roi?.points || []
  if (!points.length) return null
  const xs = points.map(point => point[0])
  const ys = points.map(point => point[1])
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
  }
}

export default function ModelRoiLayer({
  imgMeta,
  active,
  roi,
  onComplete,
  onInvalid,
}) {
  const svgRef = useRef(null)
  const drawingRef = useRef(null)
  const [draftPoints, setDraftPoints] = useState(null)
  const rawId = useId()
  const maskId = useMemo(() => `model-roi-mask-${rawId.replace(/[^a-z0-9_-]/gi, '')}`, [rawId])
  const width = Math.max(1, Number(imgMeta?.width) || 1)
  const height = Math.max(1, Number(imgMeta?.height) || 1)

  useEffect(() => {
    if (active) return
    drawingRef.current = null
    setDraftPoints(null)
  }, [active])

  const handlePointerDown = event => {
    if (!active || event.button !== 0 || !svgRef.current) return
    const point = clientToImage(svgRef.current, event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    const drawing = {
      pointerId: event.pointerId,
      points: [point],
      lastClientX: event.clientX,
      lastClientY: event.clientY,
    }
    drawingRef.current = drawing
    setDraftPoints(drawing.points)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handlePointerMove = event => {
    const drawing = drawingRef.current
    if (!active || !drawing || drawing.pointerId !== event.pointerId || !svgRef.current) return
    if (Math.hypot(event.clientX - drawing.lastClientX, event.clientY - drawing.lastClientY) < 3) return
    const point = clientToImage(svgRef.current, event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    drawing.lastClientX = event.clientX
    drawing.lastClientY = event.clientY
    drawing.points = [...drawing.points, point]
    setDraftPoints(drawing.points)
  }

  const finishDrawing = event => {
    const drawing = drawingRef.current
    if (!drawing || drawing.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    drawingRef.current = null
    try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch { /* already released */ }
    const endpoint = svgRef.current ? clientToImage(svgRef.current, event.clientX, event.clientY) : null
    const points = endpoint ? [...drawing.points, endpoint] : drawing.points
    const normalized = normalizePolygonRoi(points, width, height)
    setDraftPoints(null)
    if (!normalized) {
      onInvalid?.('Draw a larger closed region before measuring.')
      return
    }
    onComplete?.(normalized)
  }

  const cancelDrawing = event => {
    const drawing = drawingRef.current
    if (!drawing || drawing.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    drawingRef.current = null
    setDraftPoints(null)
    try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch { /* already released */ }
  }

  const displayedPoints = draftPoints || roi?.points || []
  const bounds = roiBounds(draftPoints ? { points: draftPoints } : roi)
  const hasPolygon = displayedPoints.length >= 3

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="model-roi-layer"
      aria-label={active ? 'Draw GBM measurement ROI' : 'GBM measurement ROI'}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        overflow: 'visible',
        pointerEvents: active ? 'all' : 'none',
        touchAction: 'none',
        cursor: active ? 'crosshair' : 'default',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrawing}
      onPointerCancel={cancelDrawing}
    >
      <defs>
        <mask id={maskId}>
          <rect x="0" y="0" width={width} height={height} fill="white" />
          {hasPolygon && <polygon points={pointString(displayedPoints)} fill="black" />}
        </mask>
      </defs>
      {hasPolygon && (
        <>
          <rect x="0" y="0" width={width} height={height} fill="#000" fillOpacity="0.24" mask={`url(#${maskId})`} />
          <polygon
            points={pointString(displayedPoints)}
            fill="#63a4d8"
            fillOpacity="0.08"
            stroke="#8ed0ff"
            strokeWidth="2"
            strokeDasharray={draftPoints ? '5 4' : '8 5'}
          />
          {bounds && !draftPoints && (
            <text x={bounds.x + 8} y={bounds.y + 18} fill="#cceaff" fontSize="13" fontFamily="sans-serif">
              GBM ROI
            </text>
          )}
        </>
      )}
      {active && <rect x="0" y="0" width={width} height={height} fill="transparent" />}
    </svg>
  )
}
