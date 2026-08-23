import { useEffect, useRef, useState } from 'react'
import { authFetch } from '../auth.js'

function parseHexColor(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(value || '')
  if (!match) return [255, 209, 102]
  const number = Number.parseInt(match[1], 16)
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
}

async function responseError(response) {
  const body = await response.clone().json().catch(() => null)
  if (body?.error) return body.error
  const text = await response.text().catch(() => '')
  return text || `Skeleton request failed with ${response.status}`
}

function loadBlobImage(blob, signal) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob)
    const image = new Image()
    const cleanup = () => {
      image.onload = null
      image.onerror = null
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      URL.revokeObjectURL(objectUrl)
      const error = new Error('Skeleton load was cancelled')
      error.name = 'AbortError'
      reject(error)
    }
    image.onload = () => {
      cleanup()
      resolve({ image, objectUrl })
    }
    image.onerror = () => {
      cleanup()
      URL.revokeObjectURL(objectUrl)
      reject(new Error('The GBM skeleton is not a valid image'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    image.src = objectUrl
  })
}

function brushOffsets(thickness) {
  const size = Math.max(1, Math.min(12, Math.round(Number(thickness) || 1)))
  const lower = -Math.floor((size - 1) / 2)
  const upper = Math.ceil((size - 1) / 2)
  const center = (lower + upper) / 2
  const radius = Math.max(0.5, size / 2)
  const offsets = []
  for (let y = lower; y <= upper; y += 1) {
    for (let x = lower; x <= upper; x += 1) {
      if (Math.hypot(x - center, y - center) <= radius + 0.15) offsets.push([x, y])
    }
  }
  return offsets.length ? offsets : [[0, 0]]
}

export default function ModelSkeletonOverlay({
  skeletonUrl,
  width,
  height,
  color,
  thickness,
  visible,
  onReady,
  onError,
}) {
  const canvasRef = useRef(null)
  const skeletonAlphaRef = useRef(null)
  const readyCallbackRef = useRef(onReady)
  const errorCallbackRef = useRef(onError)
  const [skeletonRevision, setSkeletonRevision] = useState(0)

  useEffect(() => { readyCallbackRef.current = onReady }, [onReady])
  useEffect(() => { errorCallbackRef.current = onError }, [onError])

  useEffect(() => {
    skeletonAlphaRef.current = null
    setSkeletonRevision(revision => revision + 1)
    if (!skeletonUrl || !width || !height) return undefined

    const controller = new AbortController()
    let objectUrl = null
    const load = async () => {
      try {
        const response = await authFetch(skeletonUrl, {
          signal: controller.signal,
          headers: { Accept: 'image/png,image/*;q=0.9' },
        })
        if (!response.ok) throw new Error(await responseError(response))
        const blob = await response.blob()
        const decoded = await loadBlobImage(blob, controller.signal)
        objectUrl = decoded.objectUrl
        const image = decoded.image
        if (image.naturalWidth !== Number(width) || image.naturalHeight !== Number(height)) {
          throw new Error(`GBM skeleton dimensions ${image.naturalWidth}×${image.naturalHeight} do not match the image ${width}×${height}`)
        }

        const scratch = document.createElement('canvas')
        scratch.width = image.naturalWidth
        scratch.height = image.naturalHeight
        const context = scratch.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('The browser could not decode the GBM skeleton')
        context.drawImage(image, 0, 0)
        const source = context.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data
        const alpha = new Uint8ClampedArray(image.naturalWidth * image.naturalHeight)
        for (let sourceIndex = 0, targetIndex = 0; sourceIndex < source.length; sourceIndex += 4, targetIndex += 1) {
          alpha[targetIndex] = Math.max(source[sourceIndex], source[sourceIndex + 1], source[sourceIndex + 2])
        }
        if (controller.signal.aborted) return
        skeletonAlphaRef.current = { alpha, width: image.naturalWidth, height: image.naturalHeight }
        setSkeletonRevision(revision => revision + 1)
        readyCallbackRef.current?.({ width: image.naturalWidth, height: image.naturalHeight })
      } catch (error) {
        if (error.name !== 'AbortError') errorCallbackRef.current?.(error.message || 'Unable to load the GBM skeleton')
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
      }
    }
    void load()
    return () => controller.abort()
  }, [height, skeletonUrl, width])

  useEffect(() => {
    const skeleton = skeletonAlphaRef.current
    const canvas = canvasRef.current
    if (!skeleton || !canvas) return
    canvas.width = skeleton.width
    canvas.height = skeleton.height
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) {
      errorCallbackRef.current?.('The browser could not render the GBM skeleton')
      return
    }
    const [red, green, blue] = parseHexColor(color)
    const base = document.createElement('canvas')
    base.width = skeleton.width
    base.height = skeleton.height
    const baseContext = base.getContext('2d', { alpha: true })
    if (!baseContext) {
      errorCallbackRef.current?.('The browser could not render the GBM skeleton')
      return
    }
    const output = baseContext.createImageData(skeleton.width, skeleton.height)
    for (let sourceIndex = 0, targetIndex = 0; sourceIndex < skeleton.alpha.length; sourceIndex += 1, targetIndex += 4) {
      output.data[targetIndex] = red
      output.data[targetIndex + 1] = green
      output.data[targetIndex + 2] = blue
      output.data[targetIndex + 3] = skeleton.alpha[sourceIndex]
    }
    baseContext.putImageData(output, 0, 0)
    context.clearRect(0, 0, skeleton.width, skeleton.height)
    for (const [offsetX, offsetY] of brushOffsets(thickness)) {
      context.drawImage(base, offsetX, offsetY)
    }
  }, [color, skeletonRevision, thickness])

  return (
    <canvas
      ref={canvasRef}
      width={Math.max(1, Number(width) || 1)}
      height={Math.max(1, Number(height) || 1)}
      className="model-skeleton-overlay"
      aria-label="GBM thickness skeleton overlay"
      aria-hidden={!visible}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: Number(width) || 0,
        height: Number(height) || 0,
        opacity: visible ? 1 : 0,
        pointerEvents: 'none',
        imageRendering: 'pixelated',
      }}
    />
  )
}
