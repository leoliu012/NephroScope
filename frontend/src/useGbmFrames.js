import { useEffect, useRef, useState } from 'react'
import { fetchRefinementFrames, filterKey } from './gbmRefinement.js'

const DEBOUNCE_MS = 150

// What to draw for every segmented slice of the image, fetched in one request, so
// moving through the stack needs none. Keeps the previous answer until the next arrives.
export default function useGbmFrames({ enabled, runIds, calibration, filter, refreshKey = '' }) {
  const [state, setState] = useState({ frames: {}, reasonNames: {} })
  const onceRef = useRef('')
  const runsKey = runIds.join(',')
  const calibrationKey = JSON.stringify(calibration)
  const key = filterKey(filter)

  useEffect(() => {
    if (!enabled || !runsKey) return undefined
    const request = `${runsKey}|${calibrationKey}|${key}|${refreshKey}`
    if (onceRef.current === request) return undefined
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const next = await fetchRefinementFrames(runsKey.split(','), { calibration, filter }, { signal: controller.signal })
        if (controller.signal.aborted) return
        onceRef.current = request
        setState({ frames: next.frames || {}, reasonNames: next.reasonNames || {} })
      } catch {
        // Predictions stay on the plain mask until the next change or poll.
      }
    }, DEBOUNCE_MS)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [enabled, runsKey, calibrationKey, key, refreshKey])

  return state
}
