import { useRef, useState, useCallback } from 'react'
import { v4 as uuidv4 } from 'uuid'

// Convert clientX/Y to SVG image coordinates
function toImgCoords(svg, clientX, clientY) {
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  return pt.matrixTransform(svg.getScreenCTM().inverse())
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
  fontSize, onEditAnnotation,
  selectedId, setSelectedId, svgRef
}) {
  const [drawing, setDrawing] = useState(null)
  const { width = 100, height = 100 } = imgMeta || {}

  const makeAnn = useCallback((type, coords, label = '') => ({
    id: uuidv4(), type, coords, label,
    annotator: annotatorName,
    timestamp: new Date().toISOString(),
    color: annotationColor,
    ...(type === 'text' ? { fontSize } : {}),
  }), [annotatorName, annotationColor, fontSize])

  const handleMouseDown = useCallback((e) => {
    if (activeTool === 'select' || !svgRef?.current) return
    e.preventDefault()
    const { x, y } = toImgCoords(svgRef.current, e.clientX, e.clientY)

    if (activeTool === 'point') {
      const ann = makeAnn('point', [x, y])
      setAnnotations(prev => [...prev, ann])
      setSelectedId(ann.id)
      return
    }
    if (activeTool === 'text') {
      const label = prompt('Annotation text:')
      if (label == null) return
      const ann = makeAnn('text', [x, y], label)
      setAnnotations(prev => [...prev, ann])
      setSelectedId(ann.id)
      return
    }
    setDrawing({ type: activeTool, start: { x, y }, coords: [x, y, x, y] })
  }, [activeTool, svgRef, makeAnn, setAnnotations, setSelectedId])

  const handleMouseMove = useCallback((e) => {
    if (!drawing || !svgRef?.current) return
    e.preventDefault()
    const { x, y } = toImgCoords(svgRef.current, e.clientX, e.clientY)
    if (drawing.type === 'freehand') {
      setDrawing(d => ({ ...d, coords: [...d.coords, x, y] }))
    } else {
      setDrawing(d => ({ ...d, coords: [d.start.x, d.start.y, x, y] }))
    }
  }, [drawing, svgRef])

  const handleMouseUp = useCallback((e) => {
    if (!drawing) return
    e.preventDefault()
    const ann = makeAnn(drawing.type, drawing.coords)
    setAnnotations(prev => [...prev, ann])
    setSelectedId(ann.id)
    setDrawing(null)
  }, [drawing, makeAnn, setAnnotations, setSelectedId])

  const handleClick = useCallback((e) => {
    if (activeTool === 'select') setSelectedId(null)
  }, [activeTool, setSelectedId])

  const isSelect = activeTool === 'select'

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
