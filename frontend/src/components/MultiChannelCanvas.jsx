import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

const API = '/agh/api'

// ── LUT definitions ──────────────────────────────────────────────────────────
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

function composeChannels(channelData, settings, width, height) {
  const n = width * height
  const out = new Uint8ClampedArray(n * 4)
  const hasEM = settings[1]?.enabled && channelData[1]

  for (let i = 0; i < n; i++) {
    let r = hasEM ? 255 : 0
    let g = hasEM ? 255 : 0
    let b = hasEM ? 255 : 0

    // Ch1 — EM: multiply blend on white background
    if (hasEM) {
      const v = remap(channelData[1][i], settings[1].minVal, settings[1].maxVal)
      const inv = 255 - v
      r = (r * inv) >> 8
      g = (g * inv) >> 8
      b = (b * inv) >> 8
    }

    // Ch0, Ch2, Ch3 — fluorescence: additive blend
    for (let c = 0; c < channelData.length; c++) {
      if (c === 1 || !settings[c]?.enabled || !channelData[c]) continue
      const v = remap(channelData[c][i], settings[c].minVal, settings[c].maxVal)
      const fn = RGB_FN[c] ?? ((v) => [v, v, v])
      const [cr, cg, cb] = fn(v)
      r = Math.min(255, r + cr)
      g = Math.min(255, g + cg)
      b = Math.min(255, b + cb)
    }

    const idx = i * 4
    out[idx] = r; out[idx + 1] = g; out[idx + 2] = b; out[idx + 3] = 255
  }
  return new ImageData(out, width, height)
}

async function loadGrayChannel(url, signal) {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Channel request failed with ${res.status}`)
  const blob = await res.blob()
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const oc = typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(img.width, img.height)
        : document.createElement('canvas')
      oc.width = img.width
      oc.height = img.height
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

export default function MultiChannelCanvas({ caseId, filename, settings, imgMeta, canvasRef, onReady }) {
  const [channelData, setChannelData] = useState([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState(null)

  // Load all channels from API — depends on imgMeta so it fires after async meta fetch
  useEffect(() => {
    if (!imgMeta || !caseId || !filename) return
    const controller = new AbortController()

    setLoading(true)
    setError(null)

    const { numChannels } = imgMeta
    const urls = Array.from({ length: numChannels }, (_, ch) =>
      `${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/channel/${ch}`
    )

    Promise.all(urls.map(url => loadGrayChannel(url, controller.signal)))
      .then(data => { setChannelData(data); setLoading(false); onReady?.(data) })
      .catch(err => {
        if (err.name === 'AbortError') return
        setError(err.message)
        setLoading(false)
      })
    return () => controller.abort()
  }, [caseId, filename, imgMeta])  // imgMeta must be here — it arrives async after mount

  // Redraw whenever channel data or display settings change
  useEffect(() => {
    if (!canvasRef?.current || !channelData.length || !imgMeta) return
    const { width, height } = imgMeta
    const canvas = canvasRef.current
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const composed = composeChannels(channelData, settings, width, height)
    canvas.getContext('2d').putImageData(composed, 0, 0)
  }, [channelData, settings, imgMeta])  // eslint-disable-line

  if (error) return (
    <div className="flex items-center justify-center w-full h-full text-red-400 text-sm">{error}</div>
  )

  return (
    <>
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-20 bg-black/60">
          <Loader2 size={32} className="animate-spin text-[#e94560] mb-2" />
          <span className="text-xs text-gray-400">Loading channels…</span>
        </div>
      )}
      <canvas ref={canvasRef} className="block" />
    </>
  )
}
