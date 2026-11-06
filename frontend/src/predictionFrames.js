// Prepares what the prediction overlay draws, off the main thread, nearest slices first.
import { frameBytes } from './predictionScan.js'

const MAX_FRAME_BYTES = 768 * 1024 * 1024
const WORKERS = 2

export const frameKey = request => `${request.url}${request.contour ? '#contour' : ''}`

function workerPool(size) {
  const workers = []
  const waiting = new Map()
  let nextId = 0
  let cursor = 0
  const start = () => {
    for (let index = 0; index < size; index += 1) {
      const worker = new Worker(new URL('./predictionWorker.js', import.meta.url), { type: 'module' })
      worker.onmessage = ({ data }) => {
        const pending = waiting.get(data.id)
        if (!pending) return
        waiting.delete(data.id)
        if (data.error) {
          const error = new Error(data.error)
          error.status = data.status
          pending.reject(error)
        } else {
          pending.resolve(data.frame)
        }
      }
      workers.push(worker)
    }
  }
  return {
    load(request) {
      if (!workers.length) start()
      nextId += 1
      const id = nextId
      const worker = workers[cursor % workers.length]
      cursor += 1
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject })
        worker.postMessage({ id, ...request })
      })
    },
    close() {
      workers.forEach(worker => worker.terminate())
      workers.length = 0
      waiting.clear()
    },
  }
}

export class PredictionFrameLoader {
  constructor({ pool = null, maxBytes = MAX_FRAME_BYTES, concurrency = WORKERS } = {}) {
    this.pool = pool || workerPool(concurrency)
    this.maxBytes = maxBytes
    this.concurrency = concurrency
    this.frames = new Map()
    this.bytes = 0
    this.loading = new Map()
    this.queue = []
    this.closed = false
  }

  // A frame that is ready, without waiting.
  peek(request) {
    const key = frameKey(request)
    const frame = this.frames.get(key)
    if (frame) {
      this.frames.delete(key)
      this.frames.set(key, frame)
    }
    return frame || null
  }

  // Resolves once the frame is ready, going to the front of the queue.
  want(request) {
    const key = frameKey(request)
    const known = this.frames.get(key)
    if (known) return Promise.resolve(known)
    if (this.loading.has(key)) return this.loading.get(key).promise
    const existing = this.queue.find(item => item.key === key)
    const entry = existing || this.enqueue(key, request)
    if (existing) this.queue.splice(this.queue.indexOf(existing), 1)
    this.queue.unshift(entry)
    this.pump()
    return entry.promise
  }

  enqueue(key, request) {
    const entry = { key, request, promise: null, resolve: null, reject: null }
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    entry.promise.catch(() => {})
    return entry
  }

  // Prepare these in this order, replacing whatever was still waiting to start.
  warm(requests) {
    const waiting = new Map(this.queue.map(item => [item.key, item]))
    this.queue = []
    for (const request of requests) {
      const key = frameKey(request)
      if (this.frames.has(key) || this.loading.has(key)) continue
      const known = waiting.get(key)
      waiting.delete(key)
      this.queue.push(known || this.enqueue(key, request))
    }
    // Someone may be awaiting one that is no longer listed, so it stays, behind the rest.
    this.queue.push(...waiting.values())
    this.pump()
  }

  pump() {
    while (!this.closed && this.loading.size < this.concurrency && this.queue.length) {
      const entry = this.queue.shift()
      this.loading.set(entry.key, entry)
      this.pool.load(entry.request).then(frame => {
        this.loading.delete(entry.key)
        if (this.closed) return
        this.frames.set(entry.key, frame)
        this.bytes += frameBytes(frame)
        for (const [key, old] of this.frames) {
          if (this.bytes <= this.maxBytes) break
          if (key === entry.key) continue
          this.frames.delete(key)
          this.bytes -= frameBytes(old)
        }
        entry.resolve(frame)
        this.pump()
      }, error => {
        this.loading.delete(entry.key)
        entry.reject(error)
        this.pump()
      })
    }
  }

  close() {
    this.closed = true
    this.queue = []
    this.frames.clear()
    this.loading.clear()
    this.bytes = 0
    this.pool.close?.()
  }
}

// Slices in the order to prepare them: nearest first, and ahead before behind.
export function nearestFirst(items, target, direction = 1, keyOf = item => item) {
  const ahead = direction >= 0 ? 1 : -1
  return [...items].sort((a, b) => {
    const offsetA = (keyOf(a) - target) * ahead
    const offsetB = (keyOf(b) - target) * ahead
    const costA = offsetA >= 0 ? offsetA : -offsetA + 0.5
    const costB = offsetB >= 0 ? offsetB : -offsetB + 0.5
    return costA - costB
  })
}
