import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { labelUrl } from '../gbmRefinement.js'
import { modelMaskUrl, modelSkeletonUrl } from '../modelAnalysis.js'
import { createOverlayRenderer, createPieceTable, fillPieceTable, fillPlainTable, overlayUniforms, pieceAtPixel } from '../predictionOverlay.js'
import { PredictionFrameLoader, nearestFirst } from '../predictionFrames.js'

// A slice not ready yet keeps the previous prediction this long, then shows none, so
// a mismatched prediction never lingers on the image.
const HOLD_PREVIOUS_MS = 220
const EMPTY_LINES = new Uint16Array(0)

// The prediction layer of the viewer. The image canvas calls show(z) as it draws each slice,
// without any React update, so prediction and image change together even mid-drag.
const PredictionOverlay = forwardRef(function PredictionOverlay({
  width, height, runsByZ, frames, reasonNames, useLabels, window: analysisWindow, zIndex, appearance, onReady, onError,
}, ref) {
  const canvasRef = useRef(null)
  const rendererRef = useRef(null)
  const loaderRef = useRef(null)
  const tableRef = useRef(null)
  const stateRef = useRef({ target: null, direction: 1, shown: null, holdTimer: null, exporting: false })
  const propsRef = useRef({})
  propsRef.current = { runsByZ, frames, reasonNames, useLabels, analysisWindow, zIndex, appearance, onReady, onError }

  // What slice z needs; null when it has no finished prediction.
  const specFor = useCallback(z => {
    const props = propsRef.current
    const run = props.runsByZ?.[String(z)]
    if (!run?.runId || run.status !== 'SUCCEEDED') return null
    const contour = Boolean(props.appearance?.contour)
    const frame = props.useLabels ? props.frames?.[run.runId] : null
    if (frame?.labelToken) {
      const fill = { url: labelUrl(run.runId, frame.labelToken, props.analysisWindow), kind: 'label', contour }
      return { runId: run.runId, reason: frame.reason, fill, skeleton: null }
    }
    const fill = { url: modelMaskUrl(run.runId), kind: 'mask', contour }
    const skeleton = run.result?.thicknessGeometryAvailable !== false ? { url: modelSkeletonUrl(run.runId), kind: 'skeleton', contour: false } : null
    return { runId: run.runId, reason: null, fill, skeleton }
  }, [])

  const paintRef = useRef(() => {})

  const warm = useCallback(() => {
    const state = stateRef.current
    if (state.target === null || !loaderRef.current) return
    const slices = Object.keys(propsRef.current.runsByZ || {}).map(Number)
    const requests = nearestFirst(slices, state.target, state.direction)
      .map(z => specFor(z)).filter(Boolean)
      .flatMap(spec => (spec.skeleton ? [spec.fill, spec.skeleton] : [spec.fill]))
    loaderRef.current.warm(requests)
  }, [specFor])

  const paint = useCallback(() => {
    const state = stateRef.current
    const renderer = rendererRef.current
    const loader = loaderRef.current
    if (!renderer || !loader || state.target === null) return
    const props = propsRef.current
    const z = state.target
    const spec = specFor(z)
    const clearHold = () => {
      if (state.holdTimer) window.clearTimeout(state.holdTimer)
      state.holdTimer = null
    }
    const clear = () => {
      renderer.clear()
      state.shown = null
      if (canvasRef.current) canvasRef.current.dataset.predictionReady = 'false'
    }
    const look = props.appearance || {}
    if (!spec || !look.visible) {
      clearHold()
      clear()
      return
    }
    const fill = loader.peek(spec.fill)
    const skeleton = spec.skeleton ? loader.peek(spec.skeleton) : null
    if (fill && (skeleton || !spec.skeleton)) {
      clearHold()
      if (!tableRef.current) tableRef.current = createPieceTable()
      if (spec.reason) fillPieceTable(tableRef.current, spec.reason, props.reasonNames)
      else fillPlainTable(tableRef.current)
      renderer.draw({
        fill,
        lines: (spec.skeleton ? skeleton?.lines : fill.lines) || EMPTY_LINES,
        table: tableRef.current,
        uniforms: overlayUniforms({
          maskColor: look.maskColor,
          skeletonColor: look.skeletonColor,
          opacity: look.opacity,
          showMask: look.showMask,
          showSkeleton: look.showSkeleton,
          contour: look.contour,
          showExcluded: look.showExcluded && !state.exporting,
          thickness: look.thickness,
        }),
      })
      state.shown = z
      state.shownFill = fill
      if (canvasRef.current) canvasRef.current.dataset.predictionReady = 'true'
      if (z === props.zIndex) props.onReady?.(spec.runId, z)
      return
    }
    // Not ready: keep what is showing for a moment, and draw this slice as soon as it is.
    if (state.shown !== z && !state.holdTimer) {
      state.holdTimer = window.setTimeout(() => {
        state.holdTimer = null
        if (state.shown !== state.target) clear()
      }, HOLD_PREVIOUS_MS)
    }
    const needed = spec.skeleton ? [spec.fill, spec.skeleton] : [spec.fill]
    Promise.all(needed.map(request => loader.want(request))).then(() => {
      if (stateRef.current.target === z) paintRef.current()
    }).catch(error => {
      const latest = propsRef.current
      if (stateRef.current.target === z && z === latest.zIndex) latest.onError?.(error.message || 'Unable to load the prediction', spec.runId, z)
    })
  }, [specFor])
  paintRef.current = paint

  const show = useCallback(z => {
    const state = stateRef.current
    if (state.target === z) return
    if (state.target !== null) state.direction = z >= state.target ? 1 : -1
    state.target = z
    paint()
    warm()
  }, [paint, warm])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !width || !height) return undefined
    canvas.width = width
    canvas.height = height
    let renderer = null
    try {
      renderer = createOverlayRenderer(canvas, width, height)
    } catch (error) {
      propsRef.current.onError?.(error.message || 'Unable to draw the prediction')
    }
    const loader = new PredictionFrameLoader()
    const state = stateRef.current
    rendererRef.current = renderer
    loaderRef.current = loader
    state.shown = null
    return () => {
      if (state.holdTimer) window.clearTimeout(state.holdTimer)
      state.holdTimer = null
      rendererRef.current = null
      loaderRef.current = null
      renderer?.destroy()
      loader.close()
    }
  }, [width, height])

  // Anything that changes what this slice looks like redraws it.
  const appearanceKey = JSON.stringify(appearance || {})
  const slicesKey = Object.keys(runsByZ || {}).length
  const currentRun = runsByZ?.[String(zIndex)]
  useEffect(() => {
    const state = stateRef.current
    if (state.target === null) state.target = zIndex
    paint()
    warm()
  }, [paint, warm, frames, reasonNames, useLabels, analysisWindow, appearanceKey, slicesKey, currentRun?.runId, currentRun?.status, zIndex])

  useImperativeHandle(ref, () => ({
    show,
    // For export: the current slice with only what is measured, drawn and waiting.
    async prepareExport() {
      const state = stateRef.current
      const spec = specFor(state.target)
      const loader = loaderRef.current
      if (!spec || !loader) return null
      await Promise.all((spec.skeleton ? [spec.fill, spec.skeleton] : [spec.fill]).map(request => loader.want(request)))
      state.exporting = true
      paint()
      return canvasRef.current
    },
    finishExport() {
      stateRef.current.exporting = false
      paint()
    },
    // Which piece a pixel belongs to, for the correction tools.
    pieceIdAt(x, y) {
      const state = stateRef.current
      const spec = specFor(state.target)
      if (!spec?.reason || !loaderRef.current) return null
      const fill = loaderRef.current.peek(spec.fill)
      return fill ? pieceAtPixel(fill.spans, x, y) : null
    },
  }), [paint, show, specFor])

  return (
    <canvas
      ref={canvasRef}
      width={Math.max(1, Number(width) || 1)}
      height={Math.max(1, Number(height) || 1)}
      className="model-prediction-overlay"
      aria-label="GBM prediction overlay"
      style={{ position: 'absolute', top: 0, left: 0, width: Number(width) || 0, height: Number(height) || 0, pointerEvents: 'none', imageRendering: 'pixelated' }}
    />
  )
})

export default PredictionOverlay
