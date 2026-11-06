import { useLayoutEffect, useRef } from 'react'

function brushOffsets(thickness) {
  const size = Math.max(1, Math.min(12, Math.round(Number(thickness) || 1)))
  const offsets = []
  const middle = (size - 1) / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (Math.hypot(x - middle, y - middle) <= size / 2 + 0.15) offsets.push([Math.round(x - middle), Math.round(y - middle)])
    }
  }
  return offsets.length ? offsets : [[0, 0]]
}

const FILL_ALPHA = 0.42

// Excluded GBM, filled and with its centerline, each in the colour of its reason.
// Exports only use the kept prediction, so this layer is for looking at decisions.
export default function ModelClassOverlay({ layer, opacity, visible, lineThickness }) {
  const canvasRef = useRef(null)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !layer) return
    const { fill, lines, width, height } = layer
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) return
    const scratch = document.createElement('canvas')
    scratch.width = width
    scratch.height = height
    const scratchContext = scratch.getContext('2d', { alpha: true })
    if (!scratchContext) return
    scratchContext.putImageData(new ImageData(fill, width, height), 0, 0)
    context.globalAlpha = FILL_ALPHA * Math.max(0.3, Math.min(1, Number(opacity) * 2 || 0))
    context.drawImage(scratch, 0, 0)
    context.globalAlpha = 1
    scratchContext.clearRect(0, 0, width, height)
    scratchContext.putImageData(new ImageData(lines, width, height), 0, 0)
    for (const [x, y] of brushOffsets(lineThickness)) context.drawImage(scratch, x, y)
  }, [layer, lineThickness, opacity])

  return (
    <canvas
      ref={canvasRef}
      width={Math.max(1, Number(layer?.width) || 1)}
      height={Math.max(1, Number(layer?.height) || 1)}
      className="model-excluded-overlay"
      aria-label="GBM predictions excluded by the filter, coloured by reason"
      aria-hidden={!visible}
      style={{
        position: 'absolute', top: 0, left: 0,
        width: Number(layer?.width) || 0, height: Number(layer?.height) || 0,
        opacity: visible ? 1 : 0, pointerEvents: 'none', imageRendering: 'pixelated',
      }}
    />
  )
}
