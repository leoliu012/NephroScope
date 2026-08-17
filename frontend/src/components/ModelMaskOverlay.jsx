import { useEffect, useRef, useState } from 'react'
import { authFetch } from '../auth.js'

function parseHexColor(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(value || '')
  if (!match) return [0, 212, 255]
  const number = Number.parseInt(match[1], 16)
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
}

async function responseError(response) {
  const body = await response.clone().json().catch(() => null)
  if (body?.error) return body.error
  const text = await response.text().catch(() => '')
  return text || `Mask request failed with ${response.status}`
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
      const error = new Error('Mask load was cancelled')
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
      reject(new Error('The model mask is not a valid image'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    image.src = objectUrl
  })
}

export default function ModelMaskOverlay({
  maskUrl,
  width,
  height,
  color,
  opacity,
  visible,
  onReady,
  onError,
}) {
  const canvasRef = useRef(null)
  const maskAlphaRef = useRef(null)
  const readyCallbackRef = useRef(onReady)
  const errorCallbackRef = useRef(onError)
  const [maskRevision, setMaskRevision] = useState(0)

  useEffect(() => { readyCallbackRef.current = onReady }, [onReady])
  useEffect(() => { errorCallbackRef.current = onError }, [onError])

  useEffect(() => {
    maskAlphaRef.current = null
    setMaskRevision(revision => revision + 1)
    if (!maskUrl || !width || !height) return undefined

    const controller = new AbortController()
    let objectUrl = null
    const load = async () => {
      try {
        const response = await authFetch(maskUrl, {
          signal: controller.signal,
          headers: { Accept: 'image/png,image/*;q=0.9' },
        })
        if (!response.ok) throw new Error(await responseError(response))
        const blob = await response.blob()
        const decoded = await loadBlobImage(blob, controller.signal)
        objectUrl = decoded.objectUrl
        const image = decoded.image
        if (image.naturalWidth !== Number(width) || image.naturalHeight !== Number(height)) {
          throw new Error(`Model mask dimensions ${image.naturalWidth}×${image.naturalHeight} do not match the image ${width}×${height}`)
        }

        const scratch = document.createElement('canvas')
        scratch.width = image.naturalWidth
        scratch.height = image.naturalHeight
        const context = scratch.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('The browser could not decode the model mask')
        context.drawImage(image, 0, 0)
        const source = context.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data
        const alpha = new Uint8ClampedArray(image.naturalWidth * image.naturalHeight)
        let maximumIntensity = 0
        let hasTransparency = false
        for (let sourceIndex = 0, targetIndex = 0; sourceIndex < source.length; sourceIndex += 4, targetIndex += 1) {
          const sourceAlpha = source[sourceIndex + 3]
          if (sourceAlpha < 255) hasTransparency = true
          const intensity = Math.max(source[sourceIndex], source[sourceIndex + 1], source[sourceIndex + 2])
          if (intensity > maximumIntensity) maximumIntensity = intensity
          alpha[targetIndex] = intensity
        }
        if (hasTransparency) {
          for (let sourceIndex = 3, targetIndex = 0; sourceIndex < source.length; sourceIndex += 4, targetIndex += 1) {
            alpha[targetIndex] = source[sourceIndex]
          }
        } else if (maximumIntensity <= 1) {
          for (let index = 0; index < alpha.length; index += 1) alpha[index] = alpha[index] ? 255 : 0
        }
        if (controller.signal.aborted) return
        maskAlphaRef.current = { alpha, width: image.naturalWidth, height: image.naturalHeight }
        setMaskRevision(revision => revision + 1)
        readyCallbackRef.current?.({ width: image.naturalWidth, height: image.naturalHeight })
      } catch (error) {
        if (error.name !== 'AbortError') errorCallbackRef.current?.(error.message || 'Unable to load model mask')
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
      }
    }
    void load()
    return () => controller.abort()
  }, [height, maskUrl, width])

  useEffect(() => {
    const mask = maskAlphaRef.current
    const canvas = canvasRef.current
    if (!mask || !canvas) return
    canvas.width = mask.width
    canvas.height = mask.height
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) {
      errorCallbackRef.current?.('The browser could not render the model mask')
      return
    }
    const [red, green, blue] = parseHexColor(color)
    const output = context.createImageData(mask.width, mask.height)
    for (let sourceIndex = 0, targetIndex = 0; sourceIndex < mask.alpha.length; sourceIndex += 1, targetIndex += 4) {
      output.data[targetIndex] = red
      output.data[targetIndex + 1] = green
      output.data[targetIndex + 2] = blue
      output.data[targetIndex + 3] = mask.alpha[sourceIndex]
    }
    context.putImageData(output, 0, 0)
  }, [color, maskRevision])

  return (
    <canvas
      ref={canvasRef}
      width={Math.max(1, Number(width) || 1)}
      height={Math.max(1, Number(height) || 1)}
      className="model-mask-overlay"
      aria-label="GBM model mask overlay"
      aria-hidden={!visible}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: Number(width) || 0,
        height: Number(height) || 0,
        opacity: visible ? Math.max(0, Math.min(1, Number(opacity) || 0)) : 0,
        pointerEvents: 'none',
        imageRendering: 'pixelated',
      }}
    />
  )
}

