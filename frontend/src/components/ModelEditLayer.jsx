import { useRef } from 'react'

function clientToImage(svg, clientX, clientY) {
  const point = svg.createSVGPoint()
  point.x = clientX
  point.y = clientY
  const matrix = svg.getScreenCTM()
  if (!matrix) return null
  const transformed = point.matrixTransform(matrix.inverse())
  return [transformed.x, transformed.y]
}

const MOVE_TOLERANCE_PX = 4

// Clicks of the Add GBM / Remove GBM tools, and where corrections were made on
// this Z slice. Markers keep the same size on screen at any zoom through
// non-scaling strokes and a size relative to the image.
export default function ModelEditLayer({ width, height, active, tool, edits, busy, onClick, onHover }) {
  const svgRef = useRef(null)
  const downRef = useRef(null)
  const imageWidth = Math.max(1, Number(width) || 1)
  const imageHeight = Math.max(1, Number(height) || 1)
  const radius = Math.max(imageWidth, imageHeight) / 110

  const handlePointerDown = event => {
    if (!active || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    downRef.current = { x: event.clientX, y: event.clientY }
  }
  const handlePointerUp = event => {
    const down = downRef.current
    downRef.current = null
    if (!active || !down || event.button !== 0 || busy || !svgRef.current) return
    event.stopPropagation()
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > MOVE_TOLERANCE_PX) return
    const point = clientToImage(svgRef.current, event.clientX, event.clientY)
    if (point) onClick?.(point[0], point[1])
  }
  const handlePointerMove = event => {
    if (!active || !svgRef.current) return
    const point = clientToImage(svgRef.current, event.clientX, event.clientY)
    if (point) onHover?.(point[0], point[1])
  }

  return (
    <svg
      ref={svgRef}
      className="model-edit-layer"
      viewBox={`0 0 ${imageWidth} ${imageHeight}`}
      width={imageWidth}
      height={imageHeight}
      data-export-ignore="true"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => onHover?.(null, null)}
      style={{
        position: 'absolute', top: 0, left: 0, width: imageWidth, height: imageHeight,
        pointerEvents: active ? 'auto' : 'none',
        cursor: active ? (busy ? 'progress' : tool === 'gbm-remove' ? 'not-allowed' : 'copy') : 'default',
      }}
    >
      {(edits || []).map(edit => {
        const positive = edit.kind !== 'exclude'
        const color = positive ? '#22c55e' : '#f43f5e'
        return (
          <g key={edit.id} transform={`translate(${edit.x} ${edit.y})`} aria-label={positive ? 'Added or kept here' : 'Removed here'}>
            <circle r={radius} fill="rgba(0,0,0,0.55)" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            <line x1={-radius * 0.55} x2={radius * 0.55} y1="0" y2="0" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            {positive && <line x1="0" x2="0" y1={-radius * 0.55} y2={radius * 0.55} stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
          </g>
        )
      })}
    </svg>
  )
}
