import { CheckCircle2, CircleStop, Loader2, Play } from 'lucide-react'
import { gapLabel, gapShortLabel, sliceSummary } from '../caseAnalysis.js'
import ThicknessDistributionPlot from './ThicknessDistributionPlot.jsx'
import './caseAnalysis.css'
import './imageThickness.css'

function sliceStatus(job) {
  if (job.distributionError) return job.distributionError
  if (job.distribution) return job.distribution.sampleCount ? `${job.distribution.sampleCount.toLocaleString()} points` : 'No GBM detected'
  switch (job.status) {
    case 'SUCCEEDED': return 'Reading thickness…'
    case 'RUNNING': return job.progress?.message || 'Running model'
    case 'QUEUED': return 'Queued'
    case 'CANCELED': return 'Canceled'
    case 'FAILED': return job.error || 'Segmentation failed'
    default: return 'Not analyzed'
  }
}

export default function ImageThicknessPanel({ analysis, ready, zCount, channelIndex, channelCount, onChannelChange, calibration }) {
  const { batch, gap, setGap, gapOptions, slices, progress, monitoring, busy, report, options, setOption } = analysis
  const runnable = (batch?.jobs || []).filter(job => !['SUCCEEDED', 'QUEUED', 'RUNNING'].includes(job.status)).length
  const needsRun = runnable > 0
  const complete = progress.total > 0 && progress.complete === progress.total
  const started = progress.complete + progress.running + progress.queued + progress.measuring > 0

  return <div className="ta-panel">
    <div className="ta-head">
      <h2>GBM thickness</h2>
      {complete ? <span className="ca-status-badge ca-status-complete"><CheckCircle2 size={12} />Results ready</span>
        : monitoring ? <span className="ca-status-badge ca-status-running"><Loader2 size={12} className="animate-spin" />Running · {progress.complete}/{progress.total}</span>
          : analysis.coverageLoading ? <span className="ta-loading"><Loader2 size={12} className="animate-spin" />Checking saved results</span> : null}
    </div>

    <section className="ta-sampling">
      <p className="ta-label">Z sampling</p>
      {zCount > 1 ? <div className="ta-gap-grid" role="radiogroup" aria-label="Thickness analysis Z sampling">
        {gapOptions.map(option => {
          // Short stacks share slices across gaps; match the chosen slices.
          const selected = option.slices.join(',') === slices.join(',')
          const full = option.total && option.ready === option.total
          const partial = !full && (option.ready || option.active)
          return <button key={option.gap} type="button" role="radio" aria-checked={selected} disabled={!ready}
            className={`ta-gap${selected ? ' is-selected' : ''}${full ? ' is-ready' : partial ? ' is-partial' : ''}`}
            title={`${gapLabel(option.gap)} · ${option.slices.length} Z · ${option.ready}/${option.total} with results`}
            onClick={() => setGap(option.gap)}>
            <span>{option.gap === 0 ? 'All' : `Gap ${option.gap}`}</span>
            <span className="ta-gap-count">{full ? <CheckCircle2 size={11} aria-label="results ready" /> : `${option.ready}/${option.total}`}</span>
          </button>
        })}
      </div> : <p className="ta-slices">Single Z plane</p>}
      {zCount > 1 && <p className="ta-slices"><strong>{gapLabel(gap)}</strong> · {slices.length} Z: {sliceSummary(slices, 10)}</p>}
    </section>

    <label className="ca-field">Model channel
      <select className="ux-input" value={channelIndex} disabled={!ready || monitoring} onChange={event => onChannelChange(Number(event.target.value))}>
        {Array.from({ length: channelCount }, (_, i) => <option key={i} value={i}>Channel {i + 1}</option>)}
      </select>
    </label>
    <p className="ta-calibration">{calibration.pixelSizeXUm} µm/px · {calibration.expansionEnabled ? `EF ${calibration.expansionFactor}` : 'unexpanded'}</p>

    <div className="ta-actions">
      {monitoring
        ? <button className="ux-button ux-button-secondary" onClick={analysis.interrupt} disabled={busy === 'interrupt' || progress.queued === 0}>
          {busy === 'interrupt' ? <Loader2 size={14} className="animate-spin" /> : <CircleStop size={14} />}Interrupt analysis
        </button>
        : needsRun && <button className="ux-button ux-button-primary" onClick={analysis.start} disabled={!ready || Boolean(busy)}>
          {busy === 'start' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {started ? `Continue · ${runnable} Z left` : 'Run thickness analysis'}
        </button>}
    </div>
    {analysis.error && <p role="alert" className="ca-error">{analysis.error}</p>}
    {analysis.coverageError && <p role="alert" className="ca-error">{analysis.coverageError}</p>}

    {batch && started && !complete && <section className="ta-progress-section">
      <progress max="100" value={progress.percent} aria-label="Image thickness analysis progress" />
      <p role="status">{progress.complete}/{progress.total} measured{progress.running ? ` · ${progress.running} running` : ''}{progress.queued ? ` · ${progress.queued} queued` : ''}{progress.canceled ? ` · ${progress.canceled} canceled` : ''}{progress.failed ? ` · ${progress.failed} failed` : ''}</p>
    </section>}
    {batch && started && <details className="ta-slice-details"><summary>Slice progress</summary><ul className="ta-job-list">{batch.jobs.map(job => <li key={job.id}>
      <span>Z{job.zIndex + 1}</span><span className={job.error || job.distributionError ? 'ca-error' : ''}>{sliceStatus(job)}</span>
    </li>)}</ul></details>}

    {report && <section className="ta-results">
      <div className="ta-results-head">
        <h3>Distribution</h3>
        <span className="ca-z-pill">{gapShortLabel(gap)} · {progress.complete}/{progress.total} Z</span>
      </div>
      {progress.complete < progress.total && <p className="ca-warning">Partial results: {progress.complete}/{progress.total} Z runs included.</p>}
      <div className="ta-plot-controls">
        <label className="ca-field">Compare<select className="ux-input" value={options.groupBy} onChange={e => setOption('groupBy', e.target.value)}><option value="image">Pool Z slices</option><option value="slice">Each Z slice</option></select></label>
        <label className="ca-field">Units<select className="ux-input" value={options.unit} onChange={e => setOption('unit', e.target.value)}><option value="nm">nm</option><option value="µm">µm</option></select></label>
        <label className="ca-field">Thickness<select className="ux-input" value={options.observed ? 'observed' : 'adjusted'} onChange={e => setOption('observed', e.target.value === 'observed')}><option value="adjusted">EF-adjusted</option><option value="observed">Observed</option></select></label>
        <label className="ca-field">Axis<select className="ux-input" value={options.focus ? 'whiskers' : 'full'} onChange={e => setOption('focus', e.target.value === 'whiskers')}><option value="whiskers">Whiskers</option><option value="full">Full range</option></select></label>
      </div>
      <ThicknessDistributionPlot groups={report.groups} unit={options.unit} observed={options.observed} focus={options.focus} compact />
    </section>}
  </div>
}
