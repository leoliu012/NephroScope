// Fetches, decodes and scans prediction images off the main thread.
import { scanPrediction, scanSkeleton } from './predictionScan.js'

let scratch = null
let context = null

async function fetchImage(url) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'image/png,image/*;q=0.9' } }).catch(() => null)
    if (response?.ok) return response.blob()
    const temporary = !response || [502, 503, 504].includes(response.status)
    if (!temporary || attempt >= 2) {
      const body = await response?.json().catch(() => null)
      const error = new Error(body?.error || (response ? `Prediction request failed with ${response.status}` : 'Prediction request failed'))
      error.status = response?.status
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 400 * 3 ** attempt))
  }
}

self.onmessage = async ({ data: { id, url, kind, contour } }) => {
  try {
    const bitmap = await createImageBitmap(await fetchImage(url), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    const { width, height } = bitmap
    if (!scratch || scratch.width !== width || scratch.height !== height) {
      scratch = new OffscreenCanvas(width, height)
      context = scratch.getContext('2d', { willReadFrequently: true, alpha: true })
    }
    context.clearRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const { data } = context.getImageData(0, 0, width, height)
    const frame = kind === 'skeleton'
      ? scanSkeleton(data, width, height)
      : scanPrediction(data, width, height, { raw: kind === 'mask', contour })
    self.postMessage({ id, frame, width, height }, [frame.spans.buffer, frame.lines.buffer, frame.edges.buffer])
  } catch (error) {
    self.postMessage({ id, error: error.message || 'Unable to load the prediction', status: error.status })
  }
}
