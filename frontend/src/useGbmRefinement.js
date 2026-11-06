import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  analysisIsActive, createPredictionEdit, excludedColorTable, fetchLabel, fetchRefinement, filterKey, keptPieceTable,
  pieceInfoAt, refinedLayers, removePredictionEdits, retryStackAnalysis,
} from './gbmRefinement.js'

const POLL_MS = 2500
const SCRUB_DELAY_MS = 120

// What the viewer draws and offers for the displayed Z slice. The response for
// another slice or filter is ignored, so overlays never show the wrong plane.
export default function useGbmRefinement({
  caseId, filename, channelIndex, runId, enabled, calibration, filter, filterActive, onEdited, refreshKey = '',
}) {
  const [view, setView] = useState(null)
  const [label, setLabel] = useState(null)
  const [error, setError] = useState('')
  const [clickState, setClickState] = useState({ busy: false, message: '', error: '' })
  const [version, setVersion] = useState(0)
  const [pollTick, setPollTick] = useState(0)
  const onEditedRef = useRef(onEdited)
  onEditedRef.current = onEdited
  const calibrationKey = JSON.stringify(calibration)
  const key = filterKey(filter)

  useEffect(() => {
    setView(current => (current?.runId === runId ? current : null))
    setError('')
    setClickState({ busy: false, message: '', error: '' })
  }, [runId])

  useEffect(() => {
    if (!enabled || !runId) return undefined
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const next = await fetchRefinement(runId, { calibration, filter }, { signal: controller.signal })
        if (controller.signal.aborted) return
        setView({ ...next, filterKey: key })
        setError('')
      } catch (err) {
        if (err.name !== 'AbortError') setError(err.message || 'Unable to read the prediction filter')
      }
    }, SCRUB_DELAY_MS)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [enabled, runId, calibrationKey, key, version, pollTick, refreshKey])

  const current = view?.runId === runId && view?.filterKey === key ? view : null
  const known = view?.runId === runId ? view : null
  const stack = known?.stack || null
  const updating = analysisIsActive(stack)

  useEffect(() => {
    if (!enabled || !runId || !updating) return undefined
    const timer = setTimeout(() => setPollTick(value => value + 1), POLL_MS)
    return () => clearTimeout(timer)
  }, [enabled, runId, updating, known])

  const labelToken = current?.pieces ? current.labelToken : null
  const window = filter?.window
  useEffect(() => {
    if (!labelToken || !runId) return undefined
    const controller = new AbortController()
    fetchLabel(runId, labelToken, window, { signal: controller.signal })
      .then(decoded => { if (!controller.signal.aborted) setLabel({ runId, token: labelToken, data: decoded }) })
      .catch(err => { if (err.name !== 'AbortError') setError(err.message || 'Unable to load the prediction pieces') })
    return () => controller.abort()
  }, [labelToken, runId, window])

  const activeLabel = label?.runId === runId && label?.token === labelToken ? label.data : null
  const hasCorrections = (current?.edits?.length || 0) > 0 || (current?.editCount || 0) > 0
  const refined = useMemo(() => {
    if (!activeLabel || !current?.pieces || !(filterActive || hasCorrections)) return null
    const { reason, reasonNames } = current.pieces
    return refinedLayers(activeLabel, keptPieceTable(reason, reasonNames), excludedColorTable(reason, reasonNames))
  }, [activeLabel, current, filterActive, hasCorrections])

  const pieceAt = useCallback((x, y) => pieceInfoAt(activeLabel, current, x, y), [activeLabel, current])

  const applyEdit = useCallback(async (target, message) => {
    if (!runId) return
    setClickState({ busy: true, message: '', error: '' })
    try {
      const response = await createPredictionEdit(runId, { ...target, calibration, filter })
      setView({ ...response.refinement, filterKey: key })
      setClickState({ busy: false, error: '', message: message(response.edit.kind) })
      onEditedRef.current?.()
    } catch (err) {
      setClickState({ busy: false, message: '', error: err.message || 'Unable to apply this correction' })
    }
  }, [runId, calibrationKey, filter, key])

  const click = useCallback((kind, x, y) => applyEdit({ kind, x, y }, resolved => {
    if (resolved === 'add') return 'Added GBM around this point.'
    return kind === 'positive' ? 'Marked as GBM; similar GBM nearby is included too.' : 'Removed this piece.'
  }), [applyEdit])

  const paint = useCallback((kind, stroke, radius) => applyEdit(
    { kind, stroke, radius },
    () => (kind === 'positive' ? 'Kept or added what this stroke covers.' : 'Removed what this stroke covers.'),
  ), [applyEdit])

  const removeEdits = useCallback(async (options, message) => {
    if (!runId) return
    setClickState({ busy: true, message: '', error: '' })
    try {
      const result = await removePredictionEdits(runId, options)
      setVersion(value => value + 1)
      setClickState({ busy: false, error: '', message: message(result.removed) })
      onEditedRef.current?.()
    } catch (err) {
      setClickState({ busy: false, message: '', error: err.message || 'Unable to undo this correction' })
    }
  }, [runId])

  const lastEdit = current?.edits?.at?.(-1) || null
  const undo = useCallback(() => {
    if (lastEdit) void removeEdits({ editId: lastEdit.id }, () => 'Last correction on this Z undone.')
  }, [lastEdit, removeEdits])
  const restore = useCallback(scope => removeEdits(
    { scope },
    removed => `Restored the model prediction${scope === 'image' ? ' for this image' : ' on this Z'} (${removed} correction${removed === 1 ? '' : 's'} removed).`,
  ), [removeEdits])

  const retry = useCallback(async () => {
    setError('')
    try {
      await retryStackAnalysis(caseId, filename, channelIndex, window)
      setPollTick(value => value + 1)
    } catch (err) {
      setError(err.message || 'Unable to start the Z analysis')
    }
  }, [caseId, filename, channelIndex, window])

  return {
    view: known, current, stack, updating, refined, error, clickState, pieceAt, click, paint, undo, restore, retry,
    fetching: Boolean(enabled && runId && known && known.filterKey !== key),
    canUndo: Boolean(lastEdit), sliceEditCount: current?.edits?.length || 0, imageEditCount: current?.editCount || 0,
  }
}
