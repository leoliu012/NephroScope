import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

const API = '/agh/api'
const MAX_CACHE_ENTRIES = 72
const CHANNEL_CACHE = new Map()


function remap(v, minVal, maxVal) {
  if (maxVal <= minVal) return 0
  return Math.max(0, Math.min(255, Math.round((v - minVal) / (maxVal - minVal) * 255)))
}

function hexToRgb(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!match) return [255, 255, 255]
  const value = Number.parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function displayRgb(setting, value) {
  if (setting?.displayMode !== 'color') return [value, value, value]
  const [r, g, b] = hexToRgb(setting.displayColor)
  return [
    Math.round(value * r / 255),
    Math.round(value * g / 255),
    Math.round(value * b / 255),
  ]
}

function channelCacheKey(caseId, filename, imgMeta, channelIndex, projection, zIndex) {
  const plane = projection === 'mip' ? 'mip' : `z-${zIndex}`
  return `${caseId}|${filename}|${imgMeta?.cacheKey || 'no-cache-key'}|${plane}|${channelIndex}`
}

function getCachedChannel(key) {
  if (!CHANNEL_CACHE.has(key)) return null
  const value = CHANNEL_CACHE.get(key)
  CHANNEL_CACHE.delete(key)
  CHANNEL_CACHE.set(key, value)
  return value
}

function setCachedChannel(key, value) {
  CHANNEL_CACHE.set(key, value)
  while (CHANNEL_CACHE.size > MAX_CACHE_ENTRIES) {
    const oldest = CHANNEL_CACHE.keys().next().value
    CHANNEL_CACHE.delete(oldest)
  }
}

function makeScratchCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function composeChannels(channelData, settings, mapping, width, height, stride = 1) {
  const outWidth = Math.ceil(width / stride)
  const outHeight = Math.ceil(height / stride)
  const out = new Uint8ClampedArray(outWidth * outHeight * 4)

  for (let y = 0; y < outHeight; y++) {
    const sourceY = Math.min(height - 1, y * stride)
    for (let x = 0; x < outWidth; x++) {
      const sourceX = Math.min(width - 1, x * stride)
      const sourceIndex = sourceY * width + sourceX
      let r = 0
      let g = 0
      let b = 0

      for (let c = 0; c < settings.length; c++) {
        if (!settings[c]?.enabled || !channelData[c]) continue
        const v = remap(channelData[c][sourceIndex], settings[c].minVal, settings[c].maxVal)
        const [cr, cg, cb] = displayRgb(settings[c], v)
        r = Math.min(255, r + cr)
        g = Math.min(255, g + cg)
        b = Math.min(255, b + cb)
      }

      const idx = (y * outWidth + x) * 4
      out[idx] = r
      out[idx + 1] = g
      out[idx + 2] = b
      out[idx + 3] = 255
    }
  }
  return new ImageData(out, outWidth, outHeight)
}

function drawImageData(canvas, imageData, width, height) {
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  if (imageData.width === width && imageData.height === height) {
    ctx.putImageData(imageData, 0, 0)
    return
  }
  const scratch = makeScratchCanvas(imageData.width, imageData.height)
  scratch.getContext('2d').putImageData(imageData, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(scratch, 0, 0, width, height)
}

async function loadGrayChannel(url, signal) {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Channel request failed with ${res.status}`)
  const blob = await res.blob()
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const oc = makeScratchCanvas(img.width, img.height)
      const ctx = oc.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const px = ctx.getImageData(0, 0, img.width, img.height).data
      const gray = new Uint8Array(img.width * img.height)
      for (let i = 0; i < gray.length; i++) gray[i] = px[i * 4]
      URL.revokeObjectURL(img.src)
      resolve(gray)
    }
    img.onerror = err => {
      URL.revokeObjectURL(img.src)
      reject(err)
    }
    img.src = URL.createObjectURL(blob)
  })
}

function scheduleIdle(fn) {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout: 1500 })
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(fn, 300)
  return () => window.clearTimeout(id)
}

export default function MultiChannelCanvas({
  caseId,
  filename,
  settings,
  channelMapping,
  imgMeta,
  canvasRef,
  zIndex = 0,
  projection = 'slice',
  onReady,
}) {
  const [channelData, setChannelData] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const channelDataRef = useRef([])
  const renderRafRef = useRef(null)
  const fullRenderTimerRef = useRef(null)

  const enabledIndexes = useMemo(() => (
    settings
      .map((setting, index) => setting?.enabled ? index : null)
      .filter(index => index != null)
  ), [settings])
  const enabledKey = enabledIndexes.join(',')
  const mappingKey = (channelMapping || []).map(item => `${item.channel}:${item.role}`).join('|')
  const planeKey = projection === 'mip' ? 'mip' : `z-${zIndex}`

  useEffect(() => { channelDataRef.current = channelData }, [channelData])

  useEffect(() => {
    if (!imgMeta || !caseId || !filename) return
    const numChannels = imgMeta.numChannels || 0
    const cached = Array.from({ length: numChannels }, (_, index) =>
      getCachedChannel(channelCacheKey(caseId, filename, imgMeta, index, projection, zIndex))
    )
    channelDataRef.current = cached
    setChannelData(cached)
    setLoading(enabledIndexes.some(index => !cached[index]))
    setError(null)
  }, [caseId, filename, imgMeta?.cacheKey, planeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!imgMeta || !caseId || !filename) return
    const controller = new AbortController()
    let cancelled = false
    let cancelIdle = null
    const numChannels = imgMeta.numChannels || 0

    const loadChannel = async (channelIndex) => {
      const key = channelCacheKey(caseId, filename, imgMeta, channelIndex, projection, zIndex)
      const cached = getCachedChannel(key)
      if (cached) return cached
      const query = projection === 'mip'
        ? '?projection=mip'
        : `?projection=slice&z=${encodeURIComponent(zIndex)}`
      const url = `${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/channel/${channelIndex}${query}`
      const data = await loadGrayChannel(url, controller.signal)
      setCachedChannel(key, data)
      return data
    }

    const missingEnabled = enabledIndexes.filter(index => !channelDataRef.current[index])
    setLoading(missingEnabled.length > 0)
    setError(null)

    Promise.all(missingEnabled.map(async index => [index, await loadChannel(index)]))
      .then(entries => {
        if (cancelled) return
        if (entries.length) {
          setChannelData(prev => {
            const next = Array.from({ length: numChannels }, (_, index) => prev[index] || null)
            entries.forEach(([index, data]) => { next[index] = data })
            channelDataRef.current = next
            onReady?.(next)
            return next
          })
        }
        setLoading(false)

        const remaining = Array.from({ length: numChannels }, (_, index) => index)
          .filter(index => !channelDataRef.current[index])
        if (remaining.length) {
          cancelIdle = scheduleIdle(() => {
            remaining.reduce((promise, index) => promise.then(async () => {
              if (cancelled || controller.signal.aborted) return
              const data = await loadChannel(index)
              if (cancelled) return
              setChannelData(prev => {
                const next = Array.from({ length: numChannels }, (_, ch) => prev[ch] || null)
                next[index] = data
                channelDataRef.current = next
                return next
              })
            }), Promise.resolve()).catch(err => {
              if (!cancelled && err.name !== 'AbortError') setError(err.message)
            })
          })
        }
      })
      .catch(err => {
        if (err.name === 'AbortError' || cancelled) return
        setError(err.message)
        setLoading(false)
      })

    return () => {
      cancelled = true
      controller.abort()
      cancelIdle?.()
    }
  }, [caseId, filename, imgMeta?.cacheKey, enabledKey, planeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!canvasRef?.current || !imgMeta) return
    const { width, height } = imgMeta
    const canvas = canvasRef.current
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    if (renderRafRef.current) window.cancelAnimationFrame(renderRafRef.current)
    if (fullRenderTimerRef.current) window.clearTimeout(fullRenderTimerRef.current)

    const hasData = channelData.some(Boolean)
    if (!hasData) {
      canvas.getContext('2d').clearRect(0, 0, width, height)
      return
    }

    renderRafRef.current = window.requestAnimationFrame(() => {
      const preview = composeChannels(channelData, settings, channelMapping, width, height, 4)
      drawImageData(canvas, preview, width, height)
      renderRafRef.current = null
    })

    fullRenderTimerRef.current = window.setTimeout(() => {
      const full = composeChannels(channelData, settings, channelMapping, width, height, 1)
      drawImageData(canvas, full, width, height)
      fullRenderTimerRef.current = null
    }, 140)

    return () => {
      if (renderRafRef.current) window.cancelAnimationFrame(renderRafRef.current)
      if (fullRenderTimerRef.current) window.clearTimeout(fullRenderTimerRef.current)
    }
  }, [channelData, settings, mappingKey, imgMeta, canvasRef]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return (
    <div className="flex h-full w-full items-center justify-center text-sm text-red-400">{error}</div>
  )

  return (
    <>
      {loading && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/60">
          <Loader2 size={32} className="mb-2 animate-spin text-[var(--accent)]" />
          <span className="text-xs text-gray-400">Loading active channels...</span>
        </div>
      )}
      <canvas ref={canvasRef} className="block" />
    </>
  )
}
