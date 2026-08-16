import { useRef, useState, useCallback, useMemo, useEffect } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { formatMeasurement, pixelCalibration } from '../measurement.js'
import { normalizedAnnotationType as normalizedType } from '../annotationTypes.js'

// Tools that support click-to-place two points, in addition to press-drag.
const TWO_CLICK_TOOLS = ['measure', 'line', 'arrow', 'rect']

// Convert browser pointer coordinates to source-image coordinates.
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

function polylinePoints(coords) {
  const points = []
  for (let i = 0; i + 1 < coords.length; i += 2) points.push(`${coords[i]},${coords[i + 1]}`)
  return points.join(' ')
}

let textMeasureCanvas = null
const TEXT_BOX_PAD_X = 10

function measureTextWidth(label, fontSize) {
  const text = label || ''
  if (typeof document === 'undefined') return text.length * fontSize * 0.68
  textMeasureCanvas = textMeasureCanvas || document.createElement('canvas')
  const context = textMeasureCanvas.getContext('2d')
  if (!context) return text.length * fontSize * 0.68
  context.font = `${fontSize}px sans-serif`
  return context.measureText(text).width
}

function fittedTextWidth(label, fontSize) {
  return Math.max(measureTextWidth(label, fontSize), (label || '').length * fontSize * 0.68)
}

function circleGeometry(coords = [], fallbackRadius = 5) {
  if (coords.length >= 4) {
    const [x1, y1, x2, y2] = coords
    const dx = x2 - x1
    const dy = y2 - y1
    const diameter = Math.max(2, Math.max(Math.abs(dx), Math.abs(dy)))
    const signX = Math.sign(dx) || 1
    const signY = Math.sign(dy) || 1
    return { cx: x1 + signX * diameter / 2, cy: y1 + signY * diameter / 2, radius: diameter / 2 }
  }
  const [cx = 0, cy = 0] = coords
  return { cx, cy, radius: fallbackRadius }
}

function pointRadius(annotation) {
  const explicit = Number(annotation.radius)
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, explicit)
  return circleGeometry(annotation.coords || [], Math.max(5, (Number(annotation.strokeWidth) || 2) * 2.5)).radius
}

function normalizeCircleAnnotation(annotation) {
  const fallbackRadius = Math.max(5, (Number(annotation.strokeWidth) || 2) * 2.5)
  const { cx, cy, radius } = circleGeometry(annotation.coords || [], fallbackRadius)
  return { ...annotation, coords: [cx, cy], radius }
}

function textBox(annotation) {
  const coords = annotation.coords || []
  const [x = 0, y = 0] = coords
  const fs = Number(annotation.fontSize) || 18
  const label = annotation.label || 'Type text…'
  const width = Math.max(fs * 2, fittedTextWidth(label, fs) + TEXT_BOX_PAD_X * 2)
  const height = fs + 10
  return { x: x - TEXT_BOX_PAD_X, y: y - fs, width, height, cx: x - TEXT_BOX_PAD_X + width / 2, cy: y - fs + height / 2 }
}

function measurementMidpoint(annotation) {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = annotation.coords || []
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
}

function measurementLabelText(annotation, imgMeta) {
  return formatMeasurement(annotation.coords, annotation, imgMeta)
}

function measurementLabelBox(annotation, imgMeta) {
  const midpoint = measurementMidpoint(annotation)
  const fs = Math.max(12, Number(annotation.fontSize) || 14)
  const label = measurementLabelText(annotation, imgMeta)
  const labelDx = Number(annotation.labelDx) || 0
  const labelDy = Number(annotation.labelDy) || 0
  const anchorX = midpoint.x + labelDx
  const anchorY = midpoint.y + labelDy
  const width = Math.max(fs * 2, fittedTextWidth(label, fs) + TEXT_BOX_PAD_X * 2)
  const height = fs + 10
  const x = anchorX - width / 2
  const y = anchorY - fs - 6
  return { x, y, width, height, cx: x + width / 2, cy: y + height / 2, anchorX, anchorY, label, fontSize: fs }
}

function parseHexColor(value) {
  const raw = String(value || '').trim()
  const match = raw.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!match) return { r: 255, g: 255, b: 255 }
  const hex = match[1].length === 3
    ? match[1].split('').map(ch => ch + ch).join('')
    : match[1]
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  }
}

function relativeLuminance({ r, g, b }) {
  const [lr, lg, lb] = [r, g, b].map(value => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

function contrastRatio(a, b) {
  const light = Math.max(a, b)
  const dark = Math.min(a, b)
  return (light + 0.05) / (dark + 0.05)
}

function labelBackgroundFor(annotationColor) {
  const annotationLum = relativeLuminance(parseHexColor(annotationColor))
  const dark = { fill: '#05080b', opacity: 0.76, stroke: '#ffffff', strokeOpacity: 0.18 }
  const light = { fill: '#f4f7fb', opacity: 0.92, stroke: '#000000', strokeOpacity: 0.28 }
  return contrastRatio(annotationLum, relativeLuminance(parseHexColor(dark.fill))) >= 4.5 ? dark : light
}

function cleanDisplayName(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const withoutEmailDomain = raw.includes('@') ? raw.split('@')[0] : raw
  return withoutEmailDomain
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, letter => letter.toUpperCase())
}

function displayInitials(name) {
  const parts = cleanDisplayName(name).split(' ').filter(Boolean)
  if (!parts.length) return '?'
  return parts.slice(0, 2).map(part => part[0]).join('').toUpperCase()
}

function compactDisplayName(name) {
  return name.length > 22 ? `${name.slice(0, 21)}...` : name
}

function annotationNameAnchor(annotation, imgMeta) {
  const bounds = annotationBounds(annotation, imgMeta)
  return {
    x: Math.max(4, bounds.x),
    y: Math.max(4, bounds.y - 34),
  }
}

function translateCoords(coords, dx, dy) {
  const next = []
  for (let i = 0; i + 1 < coords.length; i += 2) next.push(coords[i] + dx, coords[i + 1] + dy)
  return next
}

function scaleCoords(coords, cx, cy, scaleX, scaleY) {
  const next = []
  for (let i = 0; i + 1 < coords.length; i += 2) {
    next.push(cx + (coords[i] - cx) * scaleX, cy + (coords[i + 1] - cy) * scaleY)
  }
  return next
}

function annotationBounds(annotation, imgMeta) {
  const type = normalizedType(annotation)
  const coords = annotation.coords || []
  if (!coords.length) return { x: 0, y: 0, width: 1, height: 1, cx: 0.5, cy: 0.5 }

  if (type === 'text') {
    return textBox(annotation)
  }

  if (type === 'measure') {
    return measurementLabelBox(annotation, imgMeta)
  }

  if (type === 'point') {
    const { cx, cy, radius } = circleGeometry(coords, pointRadius(annotation))
    return { x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2, cx, cy }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i + 1 < coords.length; i += 2) {
    minX = Math.min(minX, coords[i])
    minY = Math.min(minY, coords[i + 1])
    maxX = Math.max(maxX, coords[i])
    maxY = Math.max(maxY, coords[i + 1])
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1, height: 1, cx: 0.5, cy: 0.5 }
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  return { x: minX, y: minY, width, height, cx: minX + width / 2, cy: minY + height / 2 }
}

function annotationRotation(annotation) {
  const value = Number(annotation.rotation)
  return Number.isFinite(value) ? value : 0
}

function rotationTransform(annotation, bounds = annotationBounds(annotation)) {
  const rotation = annotationRotation(annotation)
  return rotation ? `rotate(${rotation} ${bounds.cx} ${bounds.cy})` : undefined
}

function ArrowMarker({ id, color, strokeWidth }) {
  const size = Math.max(8, Number(strokeWidth || 2) * 4)
  return (
    <defs>
      <marker id={id} markerWidth={size} markerHeight={size} refX={size * 0.75} refY={size * 0.375} orient="auto" markerUnits="userSpaceOnUse">
        <path d={`M0,0 L0,${size * 0.75} L${size},${size * 0.375} z`} fill={color} />
      </marker>
    </defs>
  )
}

function AnnotationNameTag({ ann, selected, imgMeta }) {
  const name = cleanDisplayName(ann.annotator)
  if (!name) return null
  const label = compactDisplayName(name)
  const anchor = annotationNameAnchor(ann, imgMeta)
  const width = Math.max(64, fittedTextWidth(label, 12) + 40)
  const color = ann.color || '#63a4d8'

  return (
    <g className={`annotation-name-tag ${selected ? 'annotation-name-tag-selected' : ''}`} transform={`translate(${anchor.x} ${anchor.y})`} pointerEvents="none">
      <rect x="0" y="0" width={width} height="25" rx="5" ry="5" fill="#11171d" fillOpacity="0.94" stroke={color} strokeOpacity="0.72" />
      <circle cx="13" cy="12.5" r="8" fill={color} />
      <text x="13" y="16.5" fill="#081018" fontSize="8.5" textAnchor="middle"
        style={{ userSelect: 'none', fontFamily: 'sans-serif', fontWeight: 800 }}>
        {displayInitials(name)}
      </text>
      <text x="27" y="16.5" fill="#edf4fa" fontSize="12"
        style={{ userSelect: 'none', fontFamily: 'sans-serif', fontWeight: 650 }}>
        {label}
      </text>
    </g>
  )
}

function MeasurementShape({ ann, selected, onLabelPointerDown, imgMeta }) {
  const [x1, y1, x2, y2] = ann.coords
  const color = ann.color || '#000000'
  const strokeWidth = Number(ann.strokeWidth) || 2
  const box = measurementLabelBox(ann, imgMeta)
  const labelBackground = labelBackgroundFor(color)
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const cap = Math.max(6, strokeWidth * 3)
  const px = Math.sin(angle) * cap
  const py = -Math.cos(angle) * cap
  const rotation = annotationRotation(ann)
  const labelTransform = rotation ? `rotate(${rotation} ${box.cx} ${box.cy})` : undefined

  return (
    <g>
      <g pointerEvents="none">
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={ann.color} strokeWidth={strokeWidth} />
        <line x1={x1 - px} y1={y1 - py} x2={x1 + px} y2={y1 + py} stroke={ann.color} strokeWidth={strokeWidth} />
        <line x1={x2 - px} y1={y2 - py} x2={x2 + px} y2={y2 + py} stroke={ann.color} strokeWidth={strokeWidth} />
      </g>
      <g transform={labelTransform} onPointerDown={event => onLabelPointerDown?.(ann, event)}
        style={{ cursor: 'move', filter: selected ? 'drop-shadow(0 0 4px white)' : undefined }}>
        <rect
          x={box.x}
          y={box.y}
          width={box.width}
          height={box.height}
          rx={3}
          ry={3}
          fill={labelBackground.fill}
          fillOpacity={labelBackground.opacity}
          stroke={labelBackground.stroke}
          strokeOpacity={labelBackground.strokeOpacity}
          strokeWidth={1}
        />
        <text x={box.anchorX} y={box.anchorY + 1} fill={color} fontSize={box.fontSize} textAnchor="middle"
          style={{ userSelect: 'none', fontFamily: 'sans-serif', fontWeight: 600 }}>
          {box.label}
        </text>
      </g>
    </g>
  )
}

function TextShape({ ann, selected, editing, onObjectPointerDown, onTextChange, onFinishTextEdit, onEditText }) {
  const [x, y] = ann.coords
  const label = ann.label || ''
  const fs = Number(ann.fontSize) || 18
  const displayLabel = label || 'Type text…'
  const box = textBox({ ...ann, label: displayLabel, fontSize: fs })
  const labelBackground = labelBackgroundFor(ann.color)
  const bw = box.width
  const bh = box.height
  const selectedStyle = selected ? { filter: 'drop-shadow(0 0 4px white)' } : {}

  if (editing) {
    const editorWidth = Math.max(44, bw + 12)
    const editorHeight = Math.max(34, bh + 8)
    return (
      <foreignObject x={x - 6} y={y - fs - 7} width={editorWidth} height={editorHeight} style={{ overflow: 'visible' }}>
        <div xmlns="http://www.w3.org/1999/xhtml" className="annotation-text-editor-shell"
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}>
          <input
            autoFocus
            value={label}
            onChange={event => onTextChange?.(ann.id, event.currentTarget.value)}
            onBlur={() => onFinishTextEdit?.(ann.id)}
            onKeyDown={event => {
              event.stopPropagation()
              if (event.key === 'Escape' || event.key === 'Enter') {
                event.preventDefault()
                onFinishTextEdit?.(ann.id)
              }
            }}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            inputMode="text"
            enterKeyHint="done"
            spellCheck={false}
            placeholder="Type text"
            className="annotation-text-editor"
            style={{ color: ann.color, fontSize: `${fs}px`, textTransform: 'none' }}
          />
        </div>
      </foreignObject>
    )
  }

  return (
    <g style={{ cursor: 'move', ...selectedStyle }}
      onPointerDown={event => onObjectPointerDown?.(ann, event, 'move')}
      onDoubleClick={event => {
        event.preventDefault()
        event.stopPropagation()
        onEditText?.(ann.id)
      }}>
      <rect
        x={box.x}
        y={box.y}
        width={bw}
        height={bh}
        fill={labelBackground.fill}
        fillOpacity={labelBackground.opacity}
        stroke={labelBackground.stroke}
        strokeOpacity={labelBackground.strokeOpacity}
        strokeWidth={1}
        rx={3}
        ry={3}
      />
      <text x={x} y={y} fill={ann.color} fillOpacity={label ? 1 : 0.72} fontSize={fs}
        style={{ userSelect: 'none', fontFamily: 'sans-serif', fontStyle: label ? 'normal' : 'italic' }}>
        {displayLabel}
      </text>
    </g>
  )
}

function AnnShape({ ann, selected, imgMeta, editingTextId, onObjectPointerDown, onLabelPointerDown, onTextChange, onFinishTextEdit, onEditText }) {
  const type = normalizedType(ann)
  const { coords, color } = ann
  const strokeWidth = Number(ann.strokeWidth) || 2
  const bounds = annotationBounds(ann, imgMeta)
  const transform = type === 'measure' ? undefined : rotationTransform(ann, bounds)
  const pointerDown = event => onObjectPointerDown?.(ann, event, 'move')
  let shape = null

  if (type === 'point') {
    const { cx, cy, radius } = circleGeometry(coords, pointRadius(ann))
    shape = <>
      <circle cx={cx} cy={cy} r={Math.max(radius, strokeWidth + 6)} fill="transparent" stroke="transparent" onPointerDown={pointerDown} />
      <circle cx={cx} cy={cy} r={radius} stroke={color} strokeWidth={strokeWidth} fill="none" onPointerDown={pointerDown} />
    </>
  } else if (type === 'line' || type === 'arrow') {
    const [x1, y1, x2, y2] = coords
    const markerId = `arr-${ann.id}`
    shape = <>
      {type === 'arrow' && <ArrowMarker id={markerId} color={color} strokeWidth={strokeWidth} />}
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={strokeWidth}
        markerEnd={type === 'arrow' ? `url(#${markerId})` : undefined} onPointerDown={pointerDown} />
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={Math.max(12, strokeWidth * 4)} onPointerDown={pointerDown} />
    </>
  } else if (type === 'measure') {
    shape = <MeasurementShape ann={ann} selected={selected} onLabelPointerDown={onLabelPointerDown} imgMeta={imgMeta} />
  } else if (type === 'rect') {
    const [x1, y1, x2, y2] = coords
    shape = <rect x={Math.min(x1,x2)} y={Math.min(y1,y2)} width={Math.abs(x2-x1)} height={Math.abs(y2-y1)} stroke={color} strokeWidth={strokeWidth} fill="transparent" onPointerDown={pointerDown} />
  } else if (type === 'ellipse') {
    const [x1, y1, x2, y2] = coords
    const cx = (x1+x2)/2, cy = (y1+y2)/2
    const rx = Math.abs(x2-x1)/2, ry = Math.abs(y2-y1)/2
    shape = <ellipse cx={cx} cy={cy} rx={rx} ry={ry} stroke={color} strokeWidth={strokeWidth} fill="transparent" onPointerDown={pointerDown} />
  } else if (type === 'freehand') {
    shape = <polyline points={polylinePoints(coords)} stroke={color} strokeWidth={strokeWidth} fill="none" onPointerDown={pointerDown} />
  } else if (type === 'text') {
    shape = <TextShape ann={ann} selected={selected} editing={editingTextId === ann.id}
      onObjectPointerDown={onObjectPointerDown} onTextChange={onTextChange}
      onFinishTextEdit={onFinishTextEdit} onEditText={onEditText} />
  }

  return (
    <g className="annotation-object" transform={transform} style={{ cursor: type === 'measure' ? 'default' : 'move', filter: selected && type !== 'measure' ? 'drop-shadow(0 0 4px white)' : undefined }}>
      {shape}
      <AnnotationNameTag ann={ann} selected={selected} imgMeta={imgMeta} />
    </g>
  )
}

function PreviewShape({ drawing, color, strokeWidth, imgMeta }) {
  if (!drawing) return null
  const type = normalizedType(drawing.type)
  const { coords } = drawing
  const width = Number(strokeWidth) || 2
  const s = { stroke: color, strokeWidth: width, fill: 'none', strokeDasharray: '6 3', opacity: 0.85 }
  if (type === 'point') {
    const { cx, cy, radius } = circleGeometry(coords, Math.max(5, width * 2.5))
    return <circle cx={cx} cy={cy} r={radius} {...s} fill="none" />
  }
  if (type === 'line' || type === 'arrow') {
    const [x1, y1, x2, y2] = coords
    return <line x1={x1} y1={y1} x2={x2} y2={y2} {...s} />
  }
  if (type === 'measure') {
    const [x1, y1, x2, y2] = coords
    const label = formatMeasurement(coords, {}, imgMeta)
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    return <>
      <line x1={x1} y1={y1} x2={x2} y2={y2} {...s} />
      <text x={mx} y={my - 8} fill={color} fontSize={14} textAnchor="middle"
        style={{ userSelect: 'none', fontFamily: 'sans-serif', fontWeight: 600 }}>{label}</text>
    </>
  }
  if (type === 'rect') {
    const [x1, y1, x2, y2] = coords
    return <rect x={Math.min(x1,x2)} y={Math.min(y1,y2)} width={Math.abs(x2-x1)} height={Math.abs(y2-y1)} {...s} />
  }
  if (type === 'ellipse') {
    const [x1, y1, x2, y2] = coords
    return <ellipse cx={(x1+x2)/2} cy={(y1+y2)/2} rx={Math.abs(x2-x1)/2} ry={Math.abs(y2-y1)/2} {...s} />
  }
  if (type === 'freehand' && coords.length >= 4) return <polyline points={polylinePoints(coords)} {...s} />
  return null
}

function SelectionOverlay({ ann, imgMeta, onObjectPointerDown }) {
  if (!ann) return null
  const bounds = annotationBounds(ann, imgMeta)
  const transform = rotationTransform(ann, bounds)
  const pad = 8
  const x = bounds.x - pad
  const y = bounds.y - pad
  const width = bounds.width + pad * 2
  const height = bounds.height + pad * 2
  const handles = [
    ['nw', x, y], ['ne', x + width, y], ['se', x + width, y + height], ['sw', x, y + height],
  ]
  const rotateY = y - 26

  return (
    <g className="annotation-selection-overlay" transform={transform}>
      <rect x={x} y={y} width={width} height={height} fill="none" stroke="#ffffff" strokeWidth="1.5" strokeDasharray="7 5" opacity="0.9" />
      <line x1={bounds.cx} y1={y} x2={bounds.cx} y2={rotateY} stroke="#ffffff" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.9" />
      <circle cx={bounds.cx} cy={rotateY} r="6" fill="#101317" stroke="#ffffff" strokeWidth="1.5"
        style={{ cursor: 'grab' }} onPointerDown={event => onObjectPointerDown?.(ann, event, 'rotate')}>
        <title>Drag to rotate</title>
      </circle>
      <circle cx={bounds.cx} cy={bounds.cy} r="7" fill="#101317" stroke="#ffffff" strokeWidth="1.5"
        style={{ cursor: 'move' }} onPointerDown={event => onObjectPointerDown?.(ann, event, 'move')}>
        <title>Drag to move</title>
      </circle>
      <path d={`M${bounds.cx - 3},${bounds.cy} h6 M${bounds.cx},${bounds.cy - 3} v6`} stroke="#ffffff" strokeWidth="1.4" pointerEvents="none" />
      {handles.map(([handle, hx, hy]) => (
        <rect key={handle} x={hx - 5} y={hy - 5} width="10" height="10" rx="2" ry="2"
          fill="#101317" stroke="#ffffff" strokeWidth="1.5" style={{ cursor: `${handle}-resize` }}
          onPointerDown={event => onObjectPointerDown?.(ann, event, 'resize', { handle })}>
          <title>Drag to resize</title>
        </rect>
      ))}
    </g>
  )
}

function applyInteraction(annotation, interaction, point) {
  const original = interaction.original
  const type = normalizedType(original)
  if (interaction.mode === 'move') {
    const dx = point.x - interaction.start.x
    const dy = point.y - interaction.start.y
    if (type === 'measure') {
      return { ...annotation, labelDx: (Number(original.labelDx) || 0) + dx, labelDy: (Number(original.labelDy) || 0) + dy }
    }
    return { ...annotation, coords: translateCoords(original.coords, dx, dy) }
  }
  if (interaction.mode === 'label') {
    const dx = point.x - interaction.start.x
    const dy = point.y - interaction.start.y
    return { ...annotation, labelDx: (Number(original.labelDx) || 0) + dx, labelDy: (Number(original.labelDy) || 0) + dy }
  }
  if (interaction.mode === 'rotate') {
    const bounds = interaction.bounds
    const startAngle = Math.atan2(interaction.start.y - bounds.cy, interaction.start.x - bounds.cx)
    const currentAngle = Math.atan2(point.y - bounds.cy, point.x - bounds.cx)
    const degrees = (currentAngle - startAngle) * 180 / Math.PI
    return { ...annotation, rotation: (Number(original.rotation) || 0) + degrees }
  }
  if (interaction.mode === 'resize') {
    const bounds = interaction.bounds
    const handle = interaction.handle
    const anchorX = handle.includes('w') ? bounds.x + bounds.width : bounds.x
    const anchorY = handle.includes('n') ? bounds.y + bounds.height : bounds.y
    const startX = interaction.start.x - anchorX
    const startY = interaction.start.y - anchorY
    let scaleX = Math.abs(startX) < 0.001 ? 1 : (point.x - anchorX) / startX
    let scaleY = Math.abs(startY) < 0.001 ? 1 : (point.y - anchorY) / startY
    if (interaction.shiftKey) {
      const uniform = Math.max(0.05, Math.min(Math.abs(scaleX), Math.abs(scaleY)))
      scaleX = Math.sign(scaleX || 1) * uniform
      scaleY = Math.sign(scaleY || 1) * uniform
    }
    scaleX = Math.sign(scaleX || 1) * Math.max(0.05, Math.abs(scaleX))
    scaleY = Math.sign(scaleY || 1) * Math.max(0.05, Math.abs(scaleY))
    const next = { ...annotation }
    if (type === 'measure') {
      const uniform = Math.max(0.2, Math.min(8, (Math.abs(scaleX) + Math.abs(scaleY)) / 2))
      const nextFontSize = Math.max(8, Math.min(160, (Number(original.fontSize) || 14) * uniform))
      const midpoint = measurementMidpoint(original)
      const nextCenterX = anchorX + (interaction.bounds.cx - anchorX) * scaleX
      const nextCenterY = anchorY + (interaction.bounds.cy - anchorY) * scaleY
      return {
        ...next,
        fontSize: nextFontSize,
        labelDx: nextCenterX - midpoint.x,
        labelDy: nextCenterY + nextFontSize / 2 + 1 - midpoint.y,
      }
    }
    if (type === 'point') {
      const uniform = Math.max(0.05, Math.max(Math.abs(scaleX), Math.abs(scaleY)))
      const signedScaleX = Math.sign(scaleX || 1) * uniform
      const signedScaleY = Math.sign(scaleY || 1) * uniform
      return {
        ...next,
        coords: [
          anchorX + (original.coords[0] - anchorX) * signedScaleX,
          anchorY + (original.coords[1] - anchorY) * signedScaleY,
        ],
        radius: Math.max(1, pointRadius(original) * uniform),
      }
    }
    if (type === 'text') {
      const uniform = Math.max(0.2, Math.min(8, (Math.abs(scaleX) + Math.abs(scaleY)) / 2))
      next.fontSize = Math.max(8, Math.min(160, (Number(original.fontSize) || 18) * uniform))
      next.coords = [anchorX + (original.coords[0] - anchorX) * scaleX, anchorY + (original.coords[1] - anchorY) * scaleY]
      return next
    }
    next.coords = scaleCoords(original.coords, anchorX, anchorY, scaleX, scaleY)
    return next
  }
  return annotation
}

export default function AnnotationLayer({
  imgMeta, annotations, setAnnotations,
  activeTool, annotatorName, annotationColor,
  strokeWidth, fontSize, onEditAnnotation, panActive = false,
  selectedId, setSelectedId, svgRef,
  editingTextId, setEditingTextId,
  onExitEditMode,
  zIndex = 0,
  zCount = 1,
  readOnly = false,
}) {
  const [drawing, setDrawing] = useState(null)
  // A shape whose first point was placed by a click, awaiting a second click.
  // Used by the measurement tool and, now, line/arrow/rect (which also still
  // support press-drag-release).
  const [pendingShape, setPendingShape] = useState(null)
  const [interaction, setInteraction] = useState(null)
  const lastFreehandRef = useRef({ time: 0, x: null, y: null })
  const { width = 100, height = 100 } = imgMeta || {}

  useEffect(() => {
    // Abandon any half-placed two-click shape when the tool changes.
    setPendingShape(null)
  }, [activeTool])

  const makeAnn = useCallback((type, coords, label = '') => {
    const calibration = pixelCalibration(imgMeta)
    const normalized = normalizedType(type)
    const annotation = {
      id: uuidv4(), type: normalized, coords, label,
      annotator: annotatorName,
      timestamp: new Date().toISOString(),
      color: annotationColor,
      strokeWidth,
      ...(zCount > 1 ? { zIndex } : {}),
      ...(normalized === 'text' ? { fontSize } : {}),
      ...(normalized === 'measure' ? { pixelSizeXUm: calibration.x, pixelSizeYUm: calibration.y, labelDx: 0, labelDy: 0 } : {}),
    }
    return normalized === 'point' ? normalizeCircleAnnotation(annotation) : annotation
  }, [annotatorName, annotationColor, strokeWidth, fontSize, imgMeta, zCount, zIndex])

  const displayedAnnotations = useMemo(() => annotations
    .filter(annotation => zCount <= 1 || Math.max(0, Math.min(zCount - 1, Number.isInteger(Number(annotation.zIndex)) ? Number(annotation.zIndex) : 0)) === zIndex)
    .map(annotation => {
    if (!interaction || interaction.id !== annotation.id) return { ...annotation, type: normalizedType(annotation) }
    return { ...interaction.preview, type: normalizedType(interaction.preview) }
  }), [annotations, interaction, zCount, zIndex])

  const selectedAnnotation = displayedAnnotations.find(annotation => annotation.id === selectedId) || null

  const startObjectInteraction = useCallback((ann, event, mode, options = {}) => {
    if (panActive || !svgRef?.current || editingTextId === ann.id) return
    if (readOnly) {
      event.preventDefault()
      event.stopPropagation()
      setSelectedId(ann.id)
      return
    }
    const type = normalizedType(ann)
    const selected = ann.id === selectedId
    if (activeTool !== 'select' && activeTool !== 'text' && !selected && !(activeTool === 'measure' && type === 'measure')) return
    event.preventDefault()
    event.stopPropagation()
    const point = toImgCoords(svgRef.current, event.clientX, event.clientY)
    const original = { ...ann, type: normalizedType(ann), coords: [...ann.coords] }
    setSelectedId(ann.id)
    setInteraction({
      id: ann.id,
      mode,
      handle: options.handle,
      start: point,
      bounds: annotationBounds(original, imgMeta),
      original,
      preview: original,
      moved: false,
      pointerId: event.pointerId,
      shiftKey: Boolean(event.shiftKey),
    })
    svgRef.current.setPointerCapture?.(event.pointerId)
  }, [activeTool, editingTextId, imgMeta, panActive, readOnly, selectedId, setSelectedId, svgRef])

  const startLabelInteraction = useCallback((ann, event) => {
    startObjectInteraction(ann, event, normalizedType(ann) === 'measure' ? 'move' : 'label')
  }, [startObjectInteraction])

  const handleTextChange = useCallback((id, label) => {
    if (readOnly) return
    // Preserve the exact browser-provided value. Never normalize letter case.
    setAnnotations(previous => previous.map(annotation => annotation.id === id ? { ...annotation, label } : annotation))
  }, [readOnly, setAnnotations])

  const finishTextEdit = useCallback((id) => {
    setEditingTextId?.(current => current === id ? null : current)
    onExitEditMode?.()
  }, [onExitEditMode, setEditingTextId])

  const handlePointerDown = useCallback((event) => {
    if (panActive || !svgRef?.current) return
    if (event.target !== event.currentTarget) return
    if (readOnly) {
      if (selectedId) {
        event.preventDefault()
        event.stopPropagation()
        setSelectedId(null)
      }
      return
    }
    const { x, y } = toImgCoords(svgRef.current, event.clientX, event.clientY)

    // Second click of a two-click shape (measure/line/arrow/rect): finalize it.
    if (pendingShape) {
      event.preventDefault()
      event.stopPropagation()
      const coords = [pendingShape.start.x, pendingShape.start.y, x, y]
      const ann = makeAnn(pendingShape.type, coords)
      setAnnotations(previous => [...previous, ann])
      setSelectedId(ann.id)
      setPendingShape(null)
      return
    }

    if (selectedId) {
      event.preventDefault()
      event.stopPropagation()
      setSelectedId(null)
      return
    }

    // The measurement tool is click-only: first click plants the start point.
    if (activeTool === 'measure') {
      event.preventDefault()
      event.stopPropagation()
      setPendingShape({ type: 'measure', start: { x, y }, coords: [x, y, x, y] })
      return
    }
    if (activeTool === 'select' || activeTool === 'text') {
      event.preventDefault()
      event.stopPropagation()
      setSelectedId(null)
      return
    }
    // line/arrow/rect/point/ellipse/freehand: begin a drag. For the two-click
    // tools, a release without movement is treated as the first click instead
    // (handled in handlePointerUp).
    event.preventDefault()
    lastFreehandRef.current = { time: performance.now(), x, y }
    setDrawing({ type: activeTool, start: { x, y }, coords: [x, y, x, y], screenStart: { x: event.clientX, y: event.clientY } })
    svgRef.current.setPointerCapture?.(event.pointerId)
  }, [activeTool, makeAnn, panActive, pendingShape, readOnly, selectedId, setAnnotations, setSelectedId, svgRef])

  const handlePointerMove = useCallback((event) => {
    if (!svgRef?.current) return
    const point = toImgCoords(svgRef.current, event.clientX, event.clientY)
    if (interaction) {
      event.preventDefault()
      setInteraction(current => {
        if (!current) return current
        const preview = applyInteraction(current.preview, current, point)
        return { ...current, preview, moved: current.moved || distanceSq(current.start.x, current.start.y, point.x, point.y) > 4 }
      })
      return
    }
    if (pendingShape) {
      setPendingShape(current => current ? { ...current, coords: [current.start.x, current.start.y, point.x, point.y] } : current)
      return
    }
    if (!drawing || panActive) return
    event.preventDefault()
    if (drawing.type === 'freehand') {
      const now = performance.now()
      const last = lastFreehandRef.current
      if (now - last.time < 10 && distanceSq(last.x, last.y, point.x, point.y) < 9) return
      lastFreehandRef.current = { time: now, x: point.x, y: point.y }
      setDrawing(current => ({ ...current, coords: [...current.coords, point.x, point.y] }))
    } else {
      setDrawing(current => ({ ...current, coords: [current.start.x, current.start.y, point.x, point.y] }))
    }
  }, [drawing, interaction, panActive, pendingShape, svgRef])

  const handlePointerUp = useCallback((event) => {
    if (interaction) {
      event.preventDefault()
      const current = interaction
      setInteraction(null)
      svgRef?.current?.releasePointerCapture?.(current.pointerId)
      if (current.moved) {
        setAnnotations(previous => previous.map(annotation => annotation.id === current.id ? current.preview : annotation))
      }
      return
    }
    if (!drawing) return
    event.preventDefault()
    svgRef?.current?.releasePointerCapture?.(event.pointerId)
    // If a two-click tool was merely clicked (no real drag), switch to
    // click-to-place mode: plant the first point and wait for a second click.
    if (TWO_CLICK_TOOLS.includes(drawing.type)) {
      const start = drawing.screenStart
      const draggedFar = start
        ? Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6
        : distanceSq(drawing.start.x, drawing.start.y, drawing.coords[2], drawing.coords[3]) > 9
      if (!draggedFar) {
        setPendingShape({ type: drawing.type, start: drawing.start, coords: [drawing.start.x, drawing.start.y, drawing.start.x, drawing.start.y] })
        setDrawing(null)
        return
      }
    }
    const coords = drawing.type === 'freehand' ? simplifyCoords(drawing.coords) : drawing.coords
    const ann = makeAnn(drawing.type, coords)
    setAnnotations(previous => [...previous, ann])
    setSelectedId(ann.id)
    setDrawing(null)
  }, [drawing, interaction, makeAnn, setAnnotations, setSelectedId, svgRef])

  const shouldHandleBackground = activeTool !== 'select' && activeTool !== 'text' || Boolean(selectedId) || Boolean(editingTextId)
  const backgroundPointerEvents = !panActive && shouldHandleBackground ? 'all' : 'none'
  const previewDrawing = pendingShape ? { type: pendingShape.type, coords: pendingShape.coords } : drawing

  return (
    <svg
      ref={svgRef}
      width={width} height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible', pointerEvents: backgroundPointerEvents }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={event => { if (drawing || interaction) handlePointerUp(event) }}
    >
      {displayedAnnotations.map(ann => (
        <g key={ann.id} style={{ pointerEvents: 'all' }}>
          <AnnShape
            ann={ann}
            selected={ann.id === selectedId}
            imgMeta={imgMeta}
            editingTextId={editingTextId}
            onObjectPointerDown={startObjectInteraction}
            onLabelPointerDown={startLabelInteraction}
            onTextChange={handleTextChange}
            onFinishTextEdit={finishTextEdit}
            onEditText={onEditAnnotation}
          />
        </g>
      ))}
      <g className="annotation-preview-overlay" style={{ pointerEvents: 'none' }}>
        <PreviewShape drawing={previewDrawing} color={annotationColor} strokeWidth={strokeWidth} imgMeta={imgMeta} />
      </g>
      <g style={{ pointerEvents: 'all' }}>
        <SelectionOverlay ann={selectedAnnotation} imgMeta={imgMeta} onObjectPointerDown={startObjectInteraction} />
      </g>
    </svg>
  )
}
