import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Download, Loader2, RotateCcw, X } from 'lucide-react'
import { canvasBlob, downloadBlob } from '../exportPages.js'
import { REASON_INFO, fetchGbmVolume, filterKey } from '../gbmRefinement.js'
import { CLASS_EXCLUDED, CLASS_KEPT, classAtPoint, pickSurface, sliceAtPoint, volumeScale } from '../gbmVolume.js'
import {
  DEPTH_COLORS, VIEW_PRESETS, classPalette, createCamera, createModelRenderer, modelFrame, orbit, pan,
  rayAtTargetDepth, viewRay, voxelToWorld, worldDirectionToVoxel, worldToVoxel, zoom,
} from '../gbm3dRenderer.js'
import './gbm3d.css'

const FETCH_DELAY_MS = 150
// A press that moves less than this is a click, not a drag.
const CLICK_SLOP_PX = 4
const MAX_PIXEL_RATIO = 2
const STRETCH_STEPS = [1, 1.5, 2, 3, 4, 6, 8]

const formatUm = value => (value >= 100 ? Math.round(value).toLocaleString() : value >= 10 ? value.toFixed(1) : value.toFixed(2))

function classLabel(code, reasonNames) {
  if (code === CLASS_KEPT) return REASON_INFO.kept.label
  const info = REASON_INFO[reasonNames?.[String(code)]]
  return info ? `${info.label}, not measured` : 'Not measured'
}

// The 3D mode: every slice's GBM prediction as one model to turn, zoom and click into.
export default function Gbm3DView({
  runIds, calibration, filter, refreshKey = '', zIndex, keptColor, imageName = '', showExcludedDefault = true, onOpenSlice, onClose,
}) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const hoverLabelRef = useRef(null)
  const rendererRef = useRef(null)
  const workerRef = useRef(null)
  const volumeRef = useRef(null)
  const cameraRef = useRef(null)
  const frameRef = useRef(null)
  const hoverRef = useRef(null)
  const dragRef = useRef(null)
  const frameRequestRef = useRef(0)
  const lookRef = useRef({})
  // The stack the camera was set up for, so only a different one starts the view over.
  const cameraShapeRef = useRef('')

  const [model, setModel] = useState(null) // { header, vertexCount, triangleCount, classes }
  const [status, setStatus] = useState({ state: 'loading', message: '' })
  const [retry, setRetry] = useState(0)
  const [colorMode, setColorMode] = useState('decisions')
  const [showExcluded, setShowExcluded] = useState(showExcludedDefault)
  const [stretch, setStretch] = useState(1)

  const runsKey = runIds.join(',')
  const calibrationKey = JSON.stringify(calibration)
  const filterId = filterKey(filter)

  const reasonColors = useMemo(() => {
    const colors = {}
    for (const [code, name] of Object.entries(model?.header.reasonNames || {})) {
      if (REASON_INFO[name]) colors[Number(code)] = REASON_INFO[name].color
    }
    return colors
  }, [model])
  const palette = useMemo(() => classPalette({ keptColor, reasonColors, showExcluded }), [keptColor, reasonColors, showExcluded])
  const sliceLayer = model ? model.header.zIndices.indexOf(zIndex) : -1
  lookRef.current = { palette, colorByDepth: colorMode === 'depth', slice: sliceLayer, showExcluded }

  const draw = useCallback(() => {
    frameRequestRef.current = 0
    const renderer = rendererRef.current
    const volume = volumeRef.current
    if (!renderer || !volume || !cameraRef.current || !frameRef.current) return
    const look = lookRef.current
    const hover = hoverRef.current
    renderer.draw({
      camera: cameraRef.current,
      frame: frameRef.current,
      size: volume.size,
      palette: look.palette,
      colorByDepth: look.colorByDepth,
      slice: look.slice >= 0 ? look.slice : -10,
      hoverSlice: hover ? hover.slice.layer : -10,
      marker: hover ? [hover.point.x, hover.point.y, hover.point.z] : null,
    })
  }, [])
  const requestDraw = useCallback(() => {
    if (!frameRequestRef.current) frameRequestRef.current = window.requestAnimationFrame(draw)
  }, [draw])

  // The canvas, sized to its container.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return undefined
    try {
      rendererRef.current = createModelRenderer(canvas)
    } catch (error) {
      setStatus({ state: 'error', message: error.message || '3D could not be started in this browser', fatal: true })
      return undefined
    }
    const resize = () => {
      const ratio = Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1)
      const width = Math.max(1, Math.round(container.clientWidth * ratio))
      const height = Math.max(1, Math.round(container.clientHeight * ratio))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      requestDraw()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    return () => {
      observer.disconnect()
      if (frameRequestRef.current) window.cancelAnimationFrame(frameRequestRef.current)
      frameRequestRef.current = 0
      rendererRef.current?.destroy()
      rendererRef.current = null
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [requestDraw])

  // The volume, and its surface. A model already showing stays until the next one is ready.
  useEffect(() => {
    if (!runsKey || !rendererRef.current) return undefined
    const controller = new AbortController()
    let cancelled = false
    setStatus(current => ({ state: 'loading', message: '', updating: Boolean(volumeRef.current) && !current.fatal }))
    const timer = setTimeout(async () => {
      try {
        const volume = await fetchGbmVolume(runsKey.split(','), { calibration, filter }, { signal: controller.signal })
        if (cancelled) return
        if (!workerRef.current) {
          workerRef.current = new Worker(new URL('../gbmSurfaceWorker.js', import.meta.url), { type: 'module' })
        }
        const worker = workerRef.current
        const surface = await new Promise((resolve, reject) => {
          const id = Math.random()
          const onMessage = ({ data }) => {
            if (data.id !== id) return
            worker.removeEventListener('message', onMessage)
            if (data.error) reject(new Error(data.error))
            else resolve(data.surface)
          }
          worker.addEventListener('message', onMessage)
          worker.postMessage({ id, volume: { size: volume.size, coverage: volume.coverage, kept: volume.kept, reason: volume.reason } })
        })
        if (cancelled || !rendererRef.current) return
        rendererRef.current.setSurface(surface)
        volumeRef.current = volume
        hoverRef.current = null
        if (hoverLabelRef.current) hoverLabelRef.current.style.display = 'none'
        const present = new Set()
        for (let index = 0; index < surface.classes.length; index += 1) present.add(surface.classes[index])
        setModel({
          header: volume.header, vertexCount: surface.vertexCount, triangleCount: surface.triangleCount,
          classes: [...present].sort((a, b) => a - b),
        })
        setStatus({ state: 'ready', message: '' })
      } catch (error) {
        if (cancelled || error.name === 'AbortError') return
        setStatus({ state: 'error', message: error.message || 'Unable to build the 3D model' })
      }
    }, FETCH_DELAY_MS)
    return () => { cancelled = true; controller.abort(); clearTimeout(timer) }
  }, [runsKey, calibrationKey, filterId, refreshKey, retry])

  // Where the model sits in the world. The camera starts over only for a different stack.
  useEffect(() => {
    if (!model) return
    const frame = modelFrame(model.header.size, volumeScale(model.header), stretch)
    const previous = frameRef.current
    frameRef.current = frame
    const shape = model.header.size.join('x')
    if (!cameraRef.current || cameraShapeRef.current !== shape) {
      cameraShapeRef.current = shape
      cameraRef.current = createCamera(frame)
    } else if (previous) {
      // Stretching Z keeps what the camera is looking at in view.
      const target = worldToVoxel(previous, cameraRef.current.target)
      cameraRef.current = { ...cameraRef.current, target: voxelToWorld(frame, target) }
    }
    requestDraw()
  }, [model, stretch, requestDraw])

  useEffect(() => { requestDraw() }, [palette, colorMode, sliceLayer, requestDraw])

  // What is under the pointer: where its ray first meets GBM that is drawn.
  const pick = useCallback((clientX, clientY) => {
    const volume = volumeRef.current
    const canvas = canvasRef.current
    if (!volume || !canvas || !cameraRef.current || !frameRef.current) return null
    const bounds = canvas.getBoundingClientRect()
    const ray = viewRay(cameraRef.current, clientX - bounds.left, clientY - bounds.top, bounds.width, bounds.height)
    const point = pickSurface(
      volume, worldToVoxel(frameRef.current, ray.origin), worldDirectionToVoxel(frameRef.current, ray.direction),
      { keptOnly: !lookRef.current.showExcluded },
    )
    if (!point) return { ray, point: null }
    return { ray, point, slice: sliceAtPoint(volume.header, point), code: classAtPoint(volume, point) }
  }, [])

  const setHover = useCallback((hit, clientX, clientY) => {
    const label = hoverLabelRef.current
    const canvas = canvasRef.current
    hoverRef.current = hit?.point ? hit : null
    if (canvas) canvas.style.cursor = hit?.point ? 'pointer' : 'grab'
    if (label) {
      if (hit?.point) {
        const volume = volumeRef.current
        const bounds = containerRef.current.getBoundingClientRect()
        label.textContent = `Z ${hit.slice.zIndex + 1} of ${volume.header.zIndices.length} · ${classLabel(hit.code, volume.header.reasonNames)} · click to open this slice`
        label.style.display = 'block'
        label.style.left = `${Math.min(bounds.width - 12, Math.max(12, clientX - bounds.left))}px`
        label.style.top = `${clientY - bounds.top}px`
      } else {
        label.style.display = 'none'
      }
    }
    requestDraw()
  }, [requestDraw])

  const onPointerDown = useCallback(event => {
    if (!cameraRef.current) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const panning = event.button === 1 || event.button === 2 || event.shiftKey
    dragRef.current = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, panning, moved: false, button: event.button }
    event.currentTarget.style.cursor = 'grabbing'
    event.preventDefault()
  }, [])

  const onPointerMove = useCallback(event => {
    const drag = dragRef.current
    if (!drag) {
      setHover(pick(event.clientX, event.clientY), event.clientX, event.clientY)
      return
    }
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y
    drag.x = event.clientX
    drag.y = event.clientY
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < CLICK_SLOP_PX) return
    if (!drag.moved) {
      drag.moved = true
      setHover(null)
    }
    cameraRef.current = drag.panning
      ? pan(cameraRef.current, dx, dy, canvasRef.current.getBoundingClientRect().height)
      : orbit(cameraRef.current, dx, dy)
    requestDraw()
  }, [pick, requestDraw, setHover])

  const onPointerUp = useCallback(event => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const hit = pick(event.clientX, event.clientY)
    if (!drag.moved && drag.button === 0 && !drag.panning && hit?.point) {
      onOpenSlice?.({ zIndex: hit.slice.zIndex, x: hit.slice.x, y: hit.slice.y })
      return
    }
    setHover(hit, event.clientX, event.clientY)
  }, [onOpenSlice, pick, setHover])

  const onPointerLeave = useCallback(() => { if (!dragRef.current) setHover(null) }, [setHover])

  // The wheel must not scroll the page or reach the 2D viewer under this one.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const onWheel = event => {
      event.preventDefault()
      event.stopPropagation()
      if (!cameraRef.current || !frameRef.current) return
      const hit = pick(event.clientX, event.clientY)
      const anchor = hit?.point
        ? voxelToWorld(frameRef.current, [hit.point.x, hit.point.y, hit.point.z])
        : hit ? rayAtTargetDepth(cameraRef.current, hit.ray) : null
      const factor = Math.exp(Math.max(-1, Math.min(1, event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0016))))
      cameraRef.current = zoom(cameraRef.current, factor, anchor, frameRef.current)
      setHover(pick(event.clientX, event.clientY), event.clientX, event.clientY)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [pick, setHover])

  useEffect(() => {
    const onKey = event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // The view as it is drawn now, without the panels around it.
  const saveImage = useCallback(async () => {
    if (!canvasRef.current || !volumeRef.current) return
    const hover = hoverRef.current
    hoverRef.current = null
    draw()
    try {
      const blob = await canvasBlob(canvasRef.current, 'image/png')
      downloadBlob(blob, `${String(imageName || 'gbm').replace(/\.[^.]+$/, '')}-3d.png`)
    } catch (error) {
      setStatus(current => ({ ...current, state: 'error', message: error.message || 'Unable to save the picture' }))
    }
    hoverRef.current = hover
    requestDraw()
  }, [draw, imageName, requestDraw])

  const applyPreset = useCallback(name => {
    if (!frameRef.current) return
    cameraRef.current = { ...createCamera(frameRef.current, name) }
    setHover(null)
  }, [setHover])

  const stop = event => event.stopPropagation()
  const header = model?.header
  const scale = header ? volumeScale(header) : null
  const extent = header && scale ? [header.size[0] * scale.x, header.size[1] * scale.y, header.size[2] * scale.z] : null
  const excludedClasses = (model?.classes || []).filter(code => code !== CLASS_KEPT)
  const hasExcluded = excludedClasses.length > 0
  const undecided = header ? header.zIndices.length - header.decidedLayers : 0

  return (
    <div
      ref={containerRef}
      className="g3-root"
      onMouseDown={stop} onMouseMove={stop} onMouseUp={stop} onWheel={stop} onClick={stop} onDoubleClick={stop}
      onContextMenu={event => event.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        className="g3-canvas"
        aria-label="3D model of the GBM predictions. Drag to rotate, scroll to zoom, click the GBM to open that Z slice."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
      />
      <div ref={hoverLabelRef} className="g3-hover" role="status" style={{ display: 'none' }} />

      <div className="g3-panel g3-info">
        <strong>3D GBM model</strong>
        {header && extent && (
          <span>
            {header.zIndices.length} slices · {formatUm(extent[0])} × {formatUm(extent[1])} × {formatUm(extent[2])} µm as imaged
          </span>
        )}
        {header && !scale.knownZ && (
          <span className="g3-warning">No Z step recorded: slices are drawn {formatUm(scale.z)} µm apart. Enter the Z step in the GBM filter for true proportions.</span>
        )}
        {header?.registered && <span>Slices are in register: movement of the field through the stack is removed.</span>}
        {header && undecided > 0 && (
          <span className="g3-warning">
            {undecided === header.zIndices.length
              ? 'The Z analysis is not ready, so every prediction is shown as measured.'
              : `${undecided} slice${undecided === 1 ? '' : 's'} not analysed yet, shown as measured.`}
          </span>
        )}
        {status.state === 'loading' && status.updating && <span className="g3-busy"><Loader2 size={12} className="animate-spin" />Updating the model…</span>}
        {status.state === 'error' && model && <span className="g3-error">{status.message}</span>}
      </div>

      <div className="g3-panel g3-controls">
        <div className="g3-row">
          <span className="g3-label">View</span>
          {Object.keys(VIEW_PRESETS).map(name => (
            <button key={name} type="button" className="g3-chip" onClick={() => applyPreset(name)}
              title={name === 'top' ? 'Looking down at the first slice, as in the 2D viewer' : `${name[0].toUpperCase()}${name.slice(1)} view`}>
              {name === 'angled' ? <RotateCcw size={11} /> : null}{name[0].toUpperCase()}{name.slice(1)}
            </button>
          ))}
        </div>
        <div className="g3-row">
          <span className="g3-label">Colour</span>
          <button type="button" className={`g3-chip ${colorMode === 'decisions' ? 'g3-chip-active' : ''}`} aria-pressed={colorMode === 'decisions'}
            onClick={() => setColorMode('decisions')} title="GBM that is measured, and why the rest is not">Filter</button>
          <button type="button" className={`g3-chip ${colorMode === 'depth' ? 'g3-chip-active' : ''}`} aria-pressed={colorMode === 'depth'}
            onClick={() => setColorMode('depth')} title="Colour by Z slice">Depth</button>
          <label className="g3-check" title="Show GBM the filter excludes">
            <input type="checkbox" checked={showExcluded} disabled={!hasExcluded && showExcluded} onChange={event => setShowExcluded(event.target.checked)} />
            Excluded
          </label>
        </div>
        <div className="g3-row">
          <span className="g3-label" title="Draw slices further apart than they are, to see along Z">Z stretch</span>
          <input type="range" min={0} max={STRETCH_STEPS.length - 1} step={1} value={Math.max(0, STRETCH_STEPS.indexOf(stretch))}
            onChange={event => setStretch(STRETCH_STEPS[Number(event.target.value)])} aria-label="Z stretch" />
          <span className="g3-value">{stretch}×</span>
        </div>
      </div>

      <div className="g3-actions">
        <button type="button" className="ux-button ux-button-secondary" onClick={saveImage} disabled={!model} title="Save this view as a PNG">
          <Download size={14} />Save image
        </button>
        <button type="button" className="ux-button ux-button-secondary" onClick={onClose} title="Back to the slices (Esc)">
          <X size={14} />Close 3D
        </button>
      </div>

      {model && (
        <div className="g3-panel g3-legend">
          {colorMode === 'depth' ? (
            <div className="g3-depth">
              <span>Z 1</span>
              <i style={{ background: `linear-gradient(90deg, ${DEPTH_COLORS.join(', ')})` }} />
              <span>Z {header.zIndices.length}</span>
            </div>
          ) : (
            <ul>
              <li><i style={{ background: keptColor }} />{REASON_INFO.kept.hint}</li>
              {showExcluded && excludedClasses.map(code => {
                const info = REASON_INFO[header.reasonNames?.[String(code)]]
                return (
                  <li key={code} title={info?.hint}>
                    <i style={{ background: info?.color || '#94a3b8' }} />{code === CLASS_EXCLUDED || !info ? 'Not measured' : info.label}
                  </li>
                )
              })}
            </ul>
          )}
          <p><i className="g3-line" />Slice open in the viewer (Z {zIndex + 1})</p>
        </div>
      )}

      <p className="g3-hint">Drag to rotate · Shift-drag or right-drag to move · Scroll to zoom · Click the GBM to open that Z slice</p>

      {!model && status.state !== 'error' && (
        <div className="g3-cover" role="status">
          <Loader2 size={22} className="animate-spin" />
          <span>Building the 3D model from {runIds.length} slices…</span>
        </div>
      )}
      {!model && status.state === 'error' && (
        <div className="g3-cover" role="alert">
          <span className="g3-error">{status.message}</span>
          <div className="g3-row">
            {!status.fatal && <button type="button" className="ux-button ux-button-secondary" onClick={() => setRetry(value => value + 1)}>Try again</button>}
            <button type="button" className="ux-button ux-button-ghost" onClick={onClose}>Back to the slices</button>
          </div>
        </div>
      )}
    </div>
  )
}
