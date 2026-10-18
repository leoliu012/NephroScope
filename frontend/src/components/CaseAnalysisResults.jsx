import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleStop, FilePlus2, Loader2, Play } from 'lucide-react'
import {
  analysisGapLabel, analysisTitle, analysisToBatch, batchProgress, comparisonGroups, gapShortLabel,
  monitorSavedAnalysis, savedAnalyses,
} from '../caseAnalysis.js'
import { caseAnalysisSession } from '../caseAnalysisSession.js'
import { compareAlphanumeric } from '../collectionOrganization.js'
import { AnalysisStatusBadge, analysisStatusText } from './CaseAnalysisStatus.jsx'
import ThicknessDistributionPlot from './ThicknessDistributionPlot.jsx'

function useSavedAnalysis(id) {
  const [state, setState] = useState(() => caseAnalysisSession.analysisState.get(id) || null)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  const nextRef = useRef(null)

  useEffect(() => {
    setState(caseAnalysisSession.analysisState.get(id) || null)
    setError('')
  }, [id])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    ;(async () => {
      try {
        const known = caseAnalysisSession.analysisState.get(id)
        // Show what is cached at once, then refresh it from the server.
        const initial = nextRef.current || await savedAnalyses.get(id, { signal })
        nextRef.current = null
        await monitorSavedAnalysis(initial, {
          signal,
          distributions: known?.distributions,
          onChange: next => {
            caseAnalysisSession.analysisState.set(id, next)
            setState(next)
          },
        })
      } catch (err) {
        if (err.name !== 'AbortError' && !signal.aborted) setError(err.message)
      }
    })()
    return () => controller.abort()
  }, [id, version])

  const restartWith = analysis => {
    nextRef.current = analysis
    const next = { analysis, distributions: caseAnalysisSession.analysisState.get(id)?.distributions || new Map() }
    caseAnalysisSession.analysisState.set(id, next)
    setState(next)
    setVersion(value => value + 1)
  }
  return { analysis: state?.analysis || null, distributions: state?.distributions || new Map(), error, setError, restartWith }
}

function jobLabel(job) {
  if (job.distributionError) return `Measurement unavailable: ${job.distributionError}`
  if (job.distribution) return job.distribution.sampleCount ? `${job.distribution.sampleCount.toLocaleString()} points` : 'No GBM detected'
  switch (job.status) {
    case 'SUCCEEDED': return 'Reading thickness…'
    case 'RUNNING': return job.progress?.message || 'Running model'
    case 'QUEUED': return 'Queued'
    case 'CANCELED': return 'Canceled'
    case 'FAILED': return job.error || 'Segmentation failed'
    default: return 'Not started'
  }
}

function jobTone(job) {
  if (job.distribution) return 'done'
  if (job.distributionError || job.status === 'FAILED') return 'error'
  if (job.status === 'RUNNING' || job.status === 'SUCCEEDED') return 'running'
  if (job.status === 'QUEUED') return 'queued'
  return 'idle'
}

function ProgressTree({ batch, analysis, canCancel, onCancel, cancelling }) {
  const tree = useMemo(() => {
    const images = new Map(batch.images.map(image => [image.key, { image, jobs: [] }]))
    batch.jobs.forEach(job => images.get(job.imageKey)?.jobs.push(job))
    const cases = new Map()
    for (const entry of images.values()) {
      if (!cases.has(entry.image.caseId)) cases.set(entry.image.caseId, [])
      cases.get(entry.image.caseId).push(entry)
    }
    return [...cases.entries()].sort(([a], [b]) => compareAlphanumeric(a, b)).map(([caseId, entries]) => ({
      caseId,
      images: entries.sort((a, b) => compareAlphanumeric(a.image.filename, b.image.filename)),
      progress: batchProgress(entries.flatMap(entry => entry.jobs)),
    }))
  }, [batch])

  return <details className="ca-progress-details">
    <summary>Progress by case and image <span>{tree.length} case{tree.length === 1 ? '' : 's'} · {batch.images.length} image{batch.images.length === 1 ? '' : 's'}</span></summary>
    {tree.map(group => <details key={group.caseId} className="ca-progress-case">
      <summary>
        <span className="ca-progress-case-name">{group.caseId}</span>
        <span className="ca-progress-case-meta">{group.progress.complete}/{group.progress.total} measured · {group.images.length} image{group.images.length === 1 ? '' : 's'}{group.progress.queued ? ` · ${group.progress.queued} queued` : ''}{group.progress.running ? ` · ${group.progress.running} running` : ''}{group.progress.failed ? ` · ${group.progress.failed} failed` : ''}</span>
        <span className="ca-progress-bar-mini" aria-hidden="true"><span style={{ width: `${group.progress.percent}%` }} /></span>
      </summary>
      {group.images.map(({ image, jobs }) => {
        const progress = batchProgress(jobs)
        const queued = jobs.filter(job => job.status === 'QUEUED')
        return <details key={image.key} className="ca-job-group">
          <summary>{image.filename}<span>{progress.complete}/{jobs.length} measured · channel {image.channelIndex + 1} · {gapShortLabel(image.gap ?? analysis.gap)}{progress.queued ? ` · ${progress.queued} queued` : ''}</span></summary>
          <div className="ca-job-group-body">
            <p className="ca-help">{image.calibration.pixelSizeXUm} µm/px · {image.calibration.expansionEnabled ? `EF ${image.calibration.expansionFactor}` : 'unexpanded'}</p>
            {canCancel && queued.length > 0 && <button type="button" className="ux-button ux-button-ghost ca-cancel-button" disabled={cancelling} onClick={() => onCancel(queued.map(job => job.id))}>
              <CircleStop size={13} />Cancel {queued.length} queued
            </button>}
            {jobs.map(job => <div className={`ca-job-row ca-job-${jobTone(job)}`} key={job.id}>
              <span>Z{job.zIndex + 1}</span>
              <span>{jobLabel(job)}</span>
              <span>{job.status === 'RUNNING' ? `${Math.round((job.progress?.fraction || 0) * 100)}%` : ''}</span>
            </div>)}
          </div>
        </details>
      })}
    </details>)}
  </details>
}

export default function CaseAnalysisResults({ id, analyses, onOpenAnalysis, onNewAnalysis, onChanged }) {
  const { analysis, distributions, error, setError, restartWith } = useSavedAnalysis(id)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [groupBy, setGroupBy] = useState('case')
  const [unit, setUnit] = useState('nm')
  const [observed, setObserved] = useState(false)
  const [focus, setFocus] = useState(true)
  const [excluded, setExcluded] = useState([])
  useEffect(() => { setExcluded([]); setNotice('') }, [id])

  const batch = useMemo(() => analysisToBatch(analysis, distributions), [analysis, distributions])
  const progress = batchProgress(batch?.jobs)
  const groups = useMemo(() => comparisonGroups(batch, { groupBy, unit, observed, excluded }), [batch, groupBy, unit, observed, excluded])

  if (!analysis) {
    return <section className="ux-card ca-card">
      {error ? <p role="alert" className="ca-error">{error}</p> : <p className="ca-help"><Loader2 size={14} className="mr-2 inline animate-spin" />Loading analysis…</p>}
    </section>
  }

  const run = async (label, action) => {
    setBusy(label)
    setError('')
    setNotice('')
    try {
      const next = await action()
      restartWith(next)
      onChanged?.()
      return next
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setBusy('')
    }
  }
  const interrupt = () => run('interrupt', () => savedAnalyses.interrupt(id)).then(next => {
    if (next?.kept) setNotice(`${next.kept} queued Z slice${next.kept === 1 ? ' is' : 's are'} kept because another running analysis also needs ${next.kept === 1 ? 'it' : 'them'}.`)
  })
  const resume = () => run('resume', () => savedAnalyses.resume(id)).then(next => {
    const failed = Object.keys(next?.submitErrors || {}).length
    if (failed) setError(`${failed} Z slice${failed === 1 ? '' : 's'} could not be queued: ${Object.values(next.submitErrors)[0]}`)
  })
  const cancelJobs = jobIds => run('cancel', () => savedAnalyses.cancelJobs(id, jobIds))

  const status = analysis.status
  const running = status === 'running'
  const canContinue = ['interrupted', 'incomplete', 'finished-with-issues'].includes(status)
  const counts = analysis.counts || {}
  const caseCount = analysis.caseIds?.length || new Set(analysis.images.map(image => image.caseId)).size
  const sorted = [...(analyses || [])]
  if (!sorted.some(item => item.id === analysis.id)) sorted.unshift(analysis)

  return <div className="ca-sections">
    <section className="ux-card ca-card ca-analysis-head">
      <div className="ca-analysis-title">
        <div className="min-w-0">
          <p className="ca-eyebrow">Saved analysis</p>
          <h2>{analysisTitle(analysis)}</h2>
          <p className="ca-analysis-meta">
            <span className="ca-z-pill">Z sampling: {analysisGapLabel(analysis)}</span>
            <span>{analysis.images.length} image{analysis.images.length === 1 ? '' : 's'} in {caseCount} case{caseCount === 1 ? '' : 's'} · {counts.total} Z runs · started {new Date(analysis.createdAt).toLocaleString()}</span>
          </p>
        </div>
        <AnalysisStatusBadge analysis={analysis} />
      </div>
      <div className="ca-analysis-actions">
        {sorted.length > 1 && <label className="ca-field ca-switcher">Switch to another analysis
          <select className="ux-input" value={analysis.id} onChange={event => onOpenAnalysis(event.target.value)}>
            {sorted.map(item => <option key={item.id} value={item.id}>
              {analysisTitle(item)} · {gapShortLabel(item.gap)} · {item.images.length} images · {analysisStatusText(item)}
            </option>)}
          </select>
        </label>}
        <div className="ca-inline">
          {running && <button className="ux-button ux-button-secondary" onClick={interrupt} disabled={Boolean(busy)}>
            {busy === 'interrupt' ? <Loader2 size={14} className="animate-spin" /> : <CircleStop size={14} />}Interrupt analysis
          </button>}
          {canContinue && <button className="ux-button ux-button-primary" onClick={resume} disabled={Boolean(busy)}>
            {busy === 'resume' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}{status === 'finished-with-issues' ? 'Retry failed slices' : 'Continue analysis'}
          </button>}
          {!running && <button className="ux-button ux-button-secondary" onClick={onNewAnalysis} disabled={Boolean(busy)}><FilePlus2 size={14} />New analysis</button>}
        </div>
      </div>
      {status !== 'complete' && <>
        <progress className="ca-progress" max="100" value={progress.percent} aria-label="Case analysis progress" />
        <p role="status" className="ca-progress-summary">
          {progress.complete}/{progress.total} measured
          {progress.running ? ` · ${progress.running} running` : ''}
          {progress.queued ? ` · ${progress.queued} queued` : ''}
          {progress.measuring ? ` · ${progress.measuring} reading thickness` : ''}
          {progress.canceled ? ` · ${progress.canceled} canceled` : ''}
          {progress.missing ? ` · ${progress.missing} not started` : ''}
          {progress.failed ? ` · ${progress.failed} failed` : ''}
          {progress.empty ? ` · ${progress.empty} empty masks` : ''}
        </p>
      </>}
      {status === 'interrupted' && counts.running > 0 && <p className="ca-help">The Z slice already running finishes; queued slices were canceled.</p>}
      {notice && <p role="status" className="ca-help">{notice}</p>}
      {error && <p role="alert" className="ca-error">{error}</p>}
      {batch && <ProgressTree batch={batch} analysis={analysis} canCancel={running} onCancel={cancelJobs} cancelling={busy === 'cancel'} />}
    </section>

    <section className="ux-card ca-card">
      <div className="ca-inline ca-between">
        <h2>GBM thickness distributions</h2>
        <span className="ca-z-pill">{gapShortLabel(analysis.gap)} · {progress.complete}/{progress.total} Z runs</span>
      </div>
      {progress.complete < progress.total && <p className="ca-warning">Partial results: {progress.complete} of {progress.total} Z runs included.</p>}
      <div className="ca-plot-controls">
        <label className="ca-field">Compare by<select className="ux-input" value={groupBy} onChange={event => setGroupBy(event.target.value)}><option value="case">Case</option><option value="image">Image within case</option><option value="slice">Image and Z slice</option></select></label>
        <label className="ca-field">Thickness<select className="ux-input" value={observed ? 'observed' : 'adjusted'} onChange={event => setObserved(event.target.value === 'observed')}><option value="adjusted">EF-adjusted (per-image EF)</option><option value="observed">Observed (before EF)</option></select></label>
        <label className="ca-field">Units<select className="ux-input" value={unit} onChange={event => setUnit(event.target.value)}><option value="nm">nm</option><option value="µm">µm</option></select></label>
        <label className="ca-field">Axis range<select className="ux-input" value={focus ? 'whiskers' : 'full'} onChange={event => setFocus(event.target.value === 'whiskers')}><option value="whiskers">Whiskers (1.5 × IQR)</option><option value="full">Full range</option></select></label>
      </div>
      <details className="ca-comparison-filter"><summary>Images in this comparison ({analysis.images.length - excluded.length}/{analysis.images.length})</summary>
        {[...analysis.images].sort((a, b) => compareAlphanumeric(a.caseId, b.caseId) || compareAlphanumeric(a.filename, b.filename)).map(image => <label key={image.key} className="ca-check"><input type="checkbox" checked={!excluded.includes(image.key)} onChange={event => setExcluded(current => event.target.checked ? current.filter(key => key !== image.key) : [...current, image.key])} />{image.caseId} · {image.filename}</label>)}
      </details>
      <ThicknessDistributionPlot groups={groups} unit={unit} observed={observed} focus={focus} />
    </section>
  </div>
}
