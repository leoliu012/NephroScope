import { useEffect, useMemo, useRef, useState } from 'react'
import {
  batchProgress, loadAnalysisBatch, monitorCaseAnalysis, retryAnalysisBatch, saveAnalysisBatch,
} from './caseAnalysis.js'
import { imageThicknessReport, imageThicknessScope, imageThicknessSettingsChanged, makeImageThicknessBatch } from './imageThickness.js'

export default function useImageThicknessAnalysis({ caseId, filename, user, meta, ready, channelIndex, calibration }) {
  const scope = ready ? imageThicknessScope(caseId, filename, meta) : null
  const [record, setRecord] = useState(null)
  const [gap, setGap] = useState(0)
  const [monitoring, setMonitoring] = useState(false)
  const [error, setError] = useState('')
  const [storageWarning, setStorageWarning] = useState(false)
  const [options, setOptions] = useState({ groupBy: 'image', unit: 'nm', observed: false, focus: true, showPoints: true })
  const batch = scope && record?.scope === scope ? record.batch : null
  const batchRef = useRef(batch)
  batchRef.current = batch

  useEffect(() => {
    const restored = scope ? loadAnalysisBatch(user, scope) : null
    setRecord({ scope, batch: restored })
    setGap(restored?.gap || 0)
    setMonitoring(Boolean(restored))
    setError('')
    setStorageWarning(false)
  }, [scope, user])

  useEffect(() => {
    if (!batch || !monitoring) return undefined
    const controller = new AbortController()
    monitorCaseAnalysis(batchRef.current, {
      signal: controller.signal,
      onChange: next => {
        setRecord({ scope, batch: next })
        if (!saveAnalysisBatch(user, next, scope)) setStorageWarning(true)
      },
    }).then(() => { if (!controller.signal.aborted) setMonitoring(false) })
      .catch(err => {
        if (err.name !== 'AbortError' && !controller.signal.aborted) {
          setError(err.message)
          setMonitoring(false)
        }
        controller.abort()
      })
    return () => controller.abort()
  }, [scope, user, batch?.id, monitoring])

  const start = () => {
    if (!ready || monitoring) return
    const next = makeImageThicknessBatch({ caseId, filename, zCount: meta.zCount, gap, channelIndex, calibration })
    setRecord({ scope, batch: next })
    setStorageWarning(!saveAnalysisBatch(user, next, scope))
    setError('')
    setMonitoring(true)
  }
  const retry = () => {
    if (!batch) return
    setRecord({ scope, batch: retryAnalysisBatch(batch) })
    setError('')
    setMonitoring(true)
  }
  const report = useMemo(() => imageThicknessReport(batch, options), [batch, options])
  return {
    batch, gap, setGap, monitoring, error, storageWarning, options,
    setOption: (name, value) => setOptions(current => ({ ...current, [name]: value })),
    progress: batchProgress(batch?.jobs), report, start, retry,
    toggleMonitoring: () => { setError(''); setMonitoring(value => !value) },
    settingsChanged: imageThicknessSettingsChanged(batch, { gap, channelIndex, calibration }),
  }
}
