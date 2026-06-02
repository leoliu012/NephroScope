import { useRef, useState, useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'

// Convert clientX/Y to SVG image coordinates
function toImgCoords(svg, clientX, clientY) {
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  return pt.matrixTransform(svg.getScreenCTM().inverse())
}

function distanceSq(x0, y0, x1, y1) {
  const dx = x1 - x0
  const dy = y1 - y0
  return dx * dx + dy * dy
}

function simplifyCoords(coords, epsilon = 1.4) {
  if (!coords || coords.length <= 4) return coords || []
  const points = []
  for (let i = 0; i < coords.length; i += 2) points.push([coords[i], coords[i + 1]])
  const keep = new Array(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true

  const simplifyRange = (start, end) => {
    if (end <= start + 1) return
    const [x1, y1] = points[start]
    const [x2, y2] = points[end]
    const denom = distanceSq(x1, y1, x2, y2) || 1
    let bestIndex = -1
    let bestDistance = 0
    for (let i = start + 1; i < end; i++) {
      const [x0, y0] = points[i]
      const area = Math.abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1)
      const dist = (area * area) / denom
      if (dist > bestDistance) {
        bestDistance = dist
        bestIndex = i
      }
    }
    if (bestDistance > epsilon * epsilon && bestIndex > -1) {
      keep[bestIndex] = true
      simplifyRange(start, bestIndex)
      simplifyRange(bestIndex, end)
    }
  }

  simplifyRange(0, points.length - 1)
  return points.flatMap((point, index) => keep[index] ? point : [])
}

function ArrowMarker({ id, color }) {
  return (
    <defs>
      <marker id={id} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill={color} />
      </marker>
    </defs>
  )
}

function AnnShape({ ann, selected, onClick, onDoubleClick }) {
  const { type, coords, color, label, annotator, timestamp } = ann
  const s = { stroke: color, strokeWidth: 2, fill: 'none', cursor: 'pointer' }
  const ts = timestamp ? new Date(timestamp).toLocaleString() : ''
  const tip = [label, annotator, ts].filter(Boolean).join('\n')

  const shared = {
    ...s,
    onClick:       e => { e.stopPropagation(); onClick?.(ann.id) },
    onDoubleClick: e => { e.stopPropagation(); onDoubleClick?.(ann.id) },
  }
  const sel = selected ? { strokeWidth: 3, filter: 'drop-shadow(0 0 4px white)' } : {}

  let shape = null
  if (type === 'point') {
    const [cx, cy] = coords
    shape = <circle cx={cx} cy={cy} r={8} stroke={color} strokeWidth={2} fill={color} fillOpacity={0.4} {...shared} style={sel}><title>{tip}</title></circle>
  } else if (type === 'line' || type === 'arrow') {
    const [x1, y1, x2, y2] = coords
    const markerId = `arr-${ann.id}`
    shape = <>
      {type === 'arrow' && <ArrowMarker id={markerId} color={color} />}
      <line x1={x1} y1={y1} x2={x2} y2={y2} {...shared} style={sel}
        markerEnd={type === 'arrow' ? `url(#${markerId})` : undefined}>
        <title>{tip}</title>
      </line>
    </>
  } else if (type === 'rect') {
    const [x1, y1, x2, y2] = coords
    shape = <rect x={Math.min(x1,x2)} y={Math.min(y1,y2)} width={Math.abs(x2-x1)} height={Math.abs(y2-y1)} {...shared} style={sel}><title>{tip}</title></rect>
  } else if (type === 'ellipse') {
    const [x1, y1, x2, y2] = coords
    const cx = (x1+x2)/2, cy = (y1+y2)/2
    const rx = Math.abs(x2-x1)/2, ry = Math.abs(y2-y1)/2
    shape = <ellipse cx={cx} cy={cy} rx={rx} ry={ry} {...shared} style={sel}><title>{tip}</title></ellipse>
  } else if (type === 'freehand') {
    const pts = coords.reduce((a, v, i) => i % 2 === 0 ? [...a, `${v},`] : [...a.slice(0,-1), a[a.length-1]+v+' '], []).join('')
    shape = <polyline points={pts} {...shared} style={sel}><title>{tip}</title></polyline>
  } else if (type === 'text') {
    const [x, y] = coords
    const fs = ann.fontSize || 14
    // Estimate background box size from character count & font size
    const bw = Math.max(fs * 2, label.length * fs * 0.56 + 12)
    const bh = fs + 10
    const clickHandler = e => { e.stopPropagation(); onClick?.(ann.id) }
    const dblHandler  = e => { e.stopPropagation(); onDoubleClick?.(ann.id) }
    shape = (
      <g style={{ cursor: 'pointer', ...sel }} onClick={clickHandler} onDoubleClick={dblHandler}>
        <rect
          x={x - 4} y={y - fs}
          width={bw} height={bh}
          fill="#000" fillOpacity={0.55}
          rx={3} ry={3}
        />
        <text
          x={x} y={y}
          fill={color} fontSize={fs}
          style={{ userSelect: 'none', fontFamily: 'sans-serif' }}
        >
          {label}
          <title>{tip}</title>
        </text>
      </g>
    )
  }

  if (!shape) return null
  return shape
}

function PreviewShape({ drawing, color }) {
  if (!drawing) return null
  const { type, coords } = drawing
  const s = { stroke: color, strokeWidth: 2, fill: 'none', strokeDasharray: '6 3', opacity: 0.8 }
  if (type === 'point') {
    const [cx, cy] = coords
    return <circle cx={cx} cy={cy} r={8} {...s} fillOpacity={0.3} fill={color} />
  } else if (type === 'line' || type === 'arrow') {
    const [x1, y1, x2, y2] = coords
    return <line x1={x1} y1={y1} x2={x2} y2={y2} {...s} />
  } else if (type === 'rect') {
    const [x1, y1, x2, y2] = coords
    return <rect x={Math.min(x1,x2)} y={Math.min(y1,y2)} width={Math.abs(x2-x1)} height={Math.abs(y2-y1)} {...s} />
  } else if (type === 'ellipse') {
    const [x1, y1, x2, y2] = coords
    return <ellipse cx={(x1+x2)/2} cy={(y1+y2)/2} rx={Math.abs(x2-x1)/2} ry={Math.abs(y2-y1)/2} {...s} />
  } else if (type === 'freehand' && coords.length >= 4) {
    const pts = coords.reduce((a, v, i) => i % 2 === 0 ? [...a, `${v},`] : [...a.slice(0,-1), a[a.length-1]+v+' '], []).join('')
    return <polyline points={pts} {...s} />
  }
  return null
}

export default function AnnotationLayer({
  imgMeta, annotations, setAnnotations,
  activeTool, annotatorName, annotationColor,
  fontSize, onEditAnnotation, panActive = false,
  selectedId, setSelectedId, svgRef
}) {
  const [drawing, setDrawing] = useState(null)
  const lastFreehandRef = useRef({ time: 0, x: null, y: null })
  const { width = 100, height = 100 } = imgMeta || {}

  const makeAnn = useCallback((type, coords, label = '') => ({
    id: uuidv4(), type, coords, label,
    annotator: annotatorName,
    timestamp: new Date().toISOString(),
    color: annotationColor,
    ...(type === 'text' ? { fontSize } : {}),
  }), [annotatorName, annotationColor, fontSize])

  const handleMouseDown = useCallback((e) => {
    if (activeTool === 'select' || panActive || !svgRef?.current) return
    e.preventDefault()
    const { x, y } = toImgCoords(svgRef.current, e.clientX, e.clientY)

    if (activeTool === 'point') {
      const ann = makeAnn('point', [x, y])
      setAnnotations(prev => [...prev, ann])
      setSelectedId(ann.id)
      return
    }
    if (activeTool === 'text') {
      const ann = makeAnn('text', [x, y], '')
      setAnnotations(prev => [...prev, ann])
      setSelectedId(ann.id)
      onEditAnnotation?.(ann.id)
      return
    }
    lastFreehandRef.current = { time: performance.now(), x, y }
    setDrawing({ type: activeTool, start: { x, y }, coords: [x, y, x, y] })
  }, [activeTool, panActive, svgRef, makeAnn, setAnnotations, setSelectedId, onEditAnnotation])

  const handleMouseMove = useCallback((e) => {
    if (!drawing || panActive || !svgRef?.current) return
    e.preventDefault()
    const { x, y } = toImgCoords(svgRef.current, e.clientX, e.clientY)
    if (drawing.type === 'freehand') {
      const now = performance.now()
      const last = lastFreehandRef.current
      if (now - last.time < 10 && distanceSq(last.x, last.y, x, y) < 9) return
      lastFreehandRef.current = { time: now, x, y }
      setDrawing(d => ({ ...d, coords: [...d.coords, x, y] }))
    } else {
      setDrawing(d => ({ ...d, coords: [d.start.x, d.start.y, x, y] }))
    }
  }, [drawing, panActive, svgRef])

  const handleMouseUp = useCallback((e) => {
    if (!drawing) return
    e.preventDefault()
    const coords = drawing.type === 'freehand'
      ? simplifyCoords(drawing.coords)
      : drawing.coords
    const ann = makeAnn(drawing.type, coords)
    setAnnotations(prev => [...prev, ann])
    setSelectedId(ann.id)
    setDrawing(null)
  }, [drawing, makeAnn, setAnnotations, setSelectedId])

  const handleClick = useCallback((e) => {
    if (activeTool === 'select') setSelectedId(null)
  }, [activeTool, setSelectedId])

  const isSelect = activeTool === 'select' || panActive

  return (
    <svg
      ref={svgRef}
      width={width} height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{
        position: 'absolute', top: 0, left: 0, overflow: 'visible',
        // In draw mode capture all events; in select mode let background pass through
        pointerEvents: isSelect ? 'none' : 'all'
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onClick={handleClick}
    >
      {annotations.map(ann => (
        <g key={ann.id} style={{ pointerEvents: 'all' }}>
          <AnnShape
            ann={ann}
            selected={ann.id === selectedId}
            onClick={id => setSelectedId(id === selectedId ? null : id)}
            onDoubleClick={onEditAnnotation}
          />
        </g>
      ))}
      <PreviewShape drawing={drawing} color={annotationColor} />
    </svg>
  )
}
