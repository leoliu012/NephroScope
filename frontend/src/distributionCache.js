// Thickness distributions for a finished run never change for a given
// calibration, so they are kept in memory for this page and in IndexedDB
// across reloads. Reopening an analysis then needs no measurement requests.
import { stableModelJson } from './modelAnalysis.js'

const DB_NAME = 'nephroscope-cache'
const STORE = 'gbm-distributions'
const MAX_ENTRIES = 6000
const memory = new Map()
let dbPromise = null
let writesSincePrune = 0

export function distributionCacheKey(runId, calibration) {
  return `${runId}|${stableModelJson(calibration || {})}`
}

function compact(distribution) {
  return {
    analysisRunId: distribution.analysisRunId,
    calibration: distribution.calibration,
    valuesUm: distribution.valuesUm,
    counts: distribution.counts,
    sampleCount: distribution.sampleCount,
    unit: distribution.unit,
  }
}

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return }
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function transactionDone(transaction) {
  return new Promise(resolve => {
    transaction.oncomplete = () => resolve(true)
    transaction.onerror = () => resolve(false)
    transaction.onabort = () => resolve(false)
  })
}

export async function getCachedDistributions(keys) {
  const found = new Map()
  const missing = []
  for (const key of keys) {
    if (memory.has(key)) found.set(key, memory.get(key))
    else missing.push(key)
  }
  if (!missing.length) return found
  const db = await openDb()
  if (!db) return found
  try {
    const transaction = db.transaction(STORE, 'readonly')
    const store = transaction.objectStore(STORE)
    await Promise.all(missing.map(key => new Promise(resolve => {
      const request = store.get(key)
      request.onsuccess = () => {
        const entry = request.result
        if (entry?.value) {
          memory.set(key, entry.value)
          found.set(key, entry.value)
        }
        resolve()
      }
      request.onerror = () => resolve()
    })))
  } catch {
    // Storage can be unavailable in private windows; measurements still load.
  }
  return found
}

export async function putCachedDistributions(entries) {
  const values = entries.map(({ key, distribution }) => [key, compact(distribution)])
  values.forEach(([key, value]) => memory.set(key, value))
  const db = await openDb()
  if (!db) return
  try {
    const transaction = db.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    const savedAt = Date.now()
    values.forEach(([key, value]) => store.put({ value, savedAt }, key))
    await transactionDone(transaction)
    writesSincePrune += values.length
    if (writesSincePrune > 500) {
      writesSincePrune = 0
      pruneDistributions(db)
    }
  } catch {
    // Best effort only.
  }
}

function pruneDistributions(db) {
  try {
    const transaction = db.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    const entries = []
    const cursor = store.openCursor()
    cursor.onsuccess = () => {
      const current = cursor.result
      if (current) {
        entries.push([current.key, current.value?.savedAt || 0])
        current.continue()
        return
      }
      if (entries.length <= MAX_ENTRIES) return
      entries.sort((a, b) => a[1] - b[1])
      entries.slice(0, entries.length - MAX_ENTRIES).forEach(([key]) => store.delete(key))
    }
  } catch {
    // Ignore; the cache simply grows a little larger.
  }
}
