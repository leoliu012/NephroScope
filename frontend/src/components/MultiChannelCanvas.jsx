import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

const API = '/agh/api'
const MAX_CACHE_ENTRIES = 48
const CHANNEL_CACHE = new Map()

// Ch0=Blue, Ch1=EM-inverted (handled specially), Ch2=Red, Ch3=Magenta
const RGB_FN = [
  (v) => [0, 0, v],
  null,
  (v) => [v, 0, 0],
  (v) => [v, 0, v],
]

function remap(v, minVal, maxVal) {
  if (maxVal <= minVal) return 0
  return Math.max(0, Math.min(255, Math.round((v - minVal) / (maxVal - minVal) * 255)))
}

function channelCacheKey(caseId, filename, imgMeta, channelIndex) {
  return `${caseId}|${filename}|${imgMeta?.cacheKey || 'no-cache-key'}|${channelIndex}`
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

function composeChannels(channelData, settings, width, height, stride = 1) {
  const outWidth = Math.ceil(width / stride)
  const outHeight = Math.ceil(height / stride)
  const out = new Uint8ClampedArray(outWidth * outHeight * 4)
  const hasEM = settings[1]?.enabled && channelData[1]

  for (let y = 0; y < outHeight; y++) {
    const sourceY = Math.min(height - 1, y * stride)
    for (let x = 0; x < outWidth; x++) {
      const sourceX = Math.min(width - 1, x * stride)
      const sourceIndex = sourceY * width + sourceX
      let r = hasEM ? 255 : 0
      let g = hasEM ? 255 : 0
      let b = hasEM ? 255 : 0

      if (hasEM) {
        const v = remap(channelData[1][sourceIndex], settings[1].minVal, settings[1].maxVal)
        const inv = 255 - v
        r = (r * inv) >> 8
        g = (g * inv) >> 8
        b = (b * inv) >> 8
      }

      for (let c = 0; c < settings.length; c++) {
        if (c === 1 || !settings[c]?.enabled || !channelData[c]) continue
        const v = remap(channelData[c][sourceIndex], settings[c].minVal, settings[c].maxVal)
        const fn = RGB_FN[c] ?? ((value) => [value, value, value])
        const [cr, cg, cb] = fn(v)
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

export default function MultiChannelCanvas({ caseId, filename, settings, imgMeta, canvasRef, onReady }) {
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

  useEffect(() => { channelDataRef.current = channelData }, [channelData])

  useEffect(() => {
    if (!imgMeta || !caseId || !filename) return
    const numChannels = imgMeta.numChannels || 0
    const cached = Array.from({ length: numChannels }, (_, index) =>
      getCachedChannel(channelCacheKey(caseId, filename, imgMeta, index))
    )
    channelDataRef.current = cached
    setChannelData(cached)
    setLoading(enabledIndexes.some(index => !cached[index]))
    setError(null)
  }, [caseId, filename, imgMeta?.cacheKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!imgMeta || !caseId || !filename) return
    const controller = new AbortController()
    let cancelled = false
    let cancelIdle = null
    const numChannels = imgMeta.numChannels || 0

    const loadChannel = async (channelIndex) => {
      const key = channelCacheKey(caseId, filename, imgMeta, channelIndex)
      const cached = getCachedChannel(key)
      if (cached) return cached
      const url = `${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/channel/${channelIndex}`
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
  }, [caseId, filename, imgMeta?.cacheKey, enabledKey]) // eslint-disable-line react-hooks/exhaustive-deps

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
      const preview = composeChannels(channelData, settings, width, height, 4)
      drawImageData(canvas, preview, width, height)
      renderRafRef.current = null
    })

    fullRenderTimerRef.current = window.setTimeout(() => {
      const full = composeChannels(channelData, settings, width, height, 1)
      drawImageData(canvas, full, width, height)
      fullRenderTimerRef.current = null
    }, 140)

    return () => {
      if (renderRafRef.current) window.cancelAnimationFrame(renderRafRef.current)
      if (fullRenderTimerRef.current) window.clearTimeout(fullRenderTimerRef.current)
    }
  }, [channelData, settings, imgMeta, canvasRef])

  if (error) return (
    <div className="flex items-center justify-center w-full h-full text-red-400 text-sm">{error}</div>
  )

  return (
    <>
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-20 bg-black/60">
          <Loader2 size={32} className="mb-2 animate-spin text-[var(--accent)]" />
          <span className="text-xs text-gray-400">Loading active channels...</span>
        </div>
      )}
      <canvas ref={canvasRef} className="block" />
    </>
  )
}


