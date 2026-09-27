import { useEffect, useState } from 'react'
import { Loader2, Play, RefreshCw } from 'lucide-react'
import { gapLabel, selectedZSlices } from '../caseAnalysis.js'
import ThicknessBoxPlot from './ThicknessBoxPlot.jsx'
import './caseAnalysis.css'
import './imageThickness.css'

export default function ImageThicknessPanel({ analysis, ready, zCount, channelIndex, channelCount, onChannelChange, calibration }) {
  const { batch, gap, setGap, progress, monitoring, report, options, setOption } = analysis
  const slices = selectedZSlices(zCount, gap)
  const [settingsOpen, setSettingsOpen] = useState(!batch)
  useEffect(() => { setSettingsOpen(!batch?.id) }, [batch?.id])
  return <div className="ta-panel">
    <h2>Image thickness analysis</h2>
    <p className="ca-help">Measure GBM across Z slices. Matching segmentations from the viewer or Case analysis are reused.</p>
    <details className="ta-run-settings" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}>
    <summary>Run settings <span>{gapLabel(gap)} · {slices.length} run{slices.length === 1 ? '' : 's'}</span></summary>
    <div className="ta-run-fields">
    <label className="ca-field">Model channel
      <select className="ux-input" value={channelIndex} disabled={!ready || monitoring} onChange={event => onChannelChange(Number(event.target.value))}>
        {Array.from({ length: channelCount }, (_, i) => <option key={i} value={i}>Channel {i + 1}</option>)}
      </select>
    </label>
    <label className="ca-field">Z gap: {gapLabel(gap)}
      <input type="range" min="0" max="8" step="1" value={gap} disabled={!ready || monitoring || zCount === 1}
        aria-label="Thickness analysis Z-slice gap" aria-valuetext={gapLabel(gap)} onChange={event => setGap(Number(event.target.value))} />
    </label>
    <div className="ta-gap-ticks"><span>All</span>{Array.from({ length: 8 }, (_, i) => <span key={i}>{i + 1}</span>)}</div>
    <p className="ta-slices">{slices.length} run{slices.length === 1 ? '' : 's'} · Z {slices.slice(0, 16).map(z => z + 1).join(', ')}{slices.length > 16 ? ', …' : ''}{gap > 0 && zCount <= gap + 1 ? ' (middle slice)' : ''}</p>
    <p className="ca-help">Gap 1 skips one slice: Z1, Z3, Z5. Short stacks use the middle slice. Each run uses the model’s up-to-five-plane Z projection.</p>
    <p className="ca-help">Viewer calibration: {calibration.pixelSizeXUm} µm/px · {calibration.expansionEnabled ? `EF ${calibration.expansionFactor}` : 'unexpanded'}. Edit it in Settings.</p>
    <button className="ux-button ux-button-primary" onClick={analysis.start} disabled={!ready || monitoring}>
      {monitoring ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}{monitoring ? 'Analyzing…' : 'Run thickness analysis'}
    </button>
    </div></details>
    {analysis.error && <p role="alert" className="ca-error">{analysis.error}</p>}
    {analysis.storageWarning && <p className="ca-warning">Browser storage is unavailable. Keep the viewer open to retain this analysis.</p>}
    {batch && <section className="ta-progress-section">
      <progress max="100" value={progress.percent} aria-label="Image thickness analysis progress" />
      <p role="status">{progress.complete}/{progress.total} measured · {progress.reused} reused{progress.failed ? ` · ${progress.failed} need attention` : ''}</p>
      {(monitoring || progress.running > 0 || progress.queued > 0 || progress.empty > 0) && <p className="ca-help">{progress.running} running · {progress.queued} queued{progress.empty ? ` · ${progress.empty} empty masks` : ''}</p>}
      {(monitoring || progress.complete < progress.total) && <div className="ta-actions">
        <button className="ux-button ux-button-ghost" onClick={analysis.toggleMonitoring}>{monitoring ? 'Pause updates' : 'Refresh progress'}</button>
        {!monitoring && progress.failed > 0 && <button className="ux-button ux-button-ghost" onClick={analysis.retry}><RefreshCw size={12} />Retry incomplete</button>}
      </div>}
      {(monitoring || progress.queued > 0 || progress.running > 0) && <p className="ca-help">Queued jobs continue when you leave. Reopen this image to resume. A model worker must be running.</p>}
      <details><summary>Slice progress</summary>{!monitoring && progress.complete === progress.total && <button className="ux-button ux-button-ghost" onClick={analysis.toggleMonitoring}>Refresh progress</button>}<ul className="ta-job-list">{batch.jobs.map(job => <li key={job.id}>
        <span>Z{job.zIndex + 1}</span><span className={job.error || job.distributionError ? 'ca-error' : ''}>
          {job.distributionError || job.error || job.pollError || (job.distribution
            ? `${job.reused ? 'Reused' : 'Complete'} · ${job.distribution.sampleCount.toLocaleString()} points`
            : job.status === 'SUCCEEDED' ? 'Reading thickness points…'
              : job.status === 'PENDING' ? 'Checking saved runs…' : job.progress?.message || job.status)}
        </span>
      </li>)}</ul></details>
    </section>}
    {analysis.settingsChanged && <p className="ca-warning">Settings have changed. The current results use the settings saved with this analysis. Run thickness analysis again to apply your changes; matching segmentations are reused.</p>}
    {batch && <section className="ta-results">
      <h3>Thickness distribution</h3>
      <p className="ca-help">All individual centerline points contribute to the box plot, rather than averages per slice.</p>
      <p className="ca-help">Analysis settings: channel {batch.images[0].channelIndex + 1} · {batch.images[0].calibration.pixelSizeXUm} µm/px · {batch.images[0].calibration.expansionEnabled ? `EF ${batch.images[0].calibration.expansionFactor}` : 'unexpanded'}.</p>
      {progress.complete < progress.total && <p className="ca-warning">Partial results: {progress.complete}/{progress.total} runs included.</p>}
      <div className="ta-plot-controls">
        <label className="ca-field">Compare<select className="ux-input" value={options.groupBy} onChange={e => setOption('groupBy', e.target.value)}><option value="image">Pool selected Z slices</option><option value="slice">Each Z slice</option></select></label>
        <label className="ca-field">Units<select className="ux-input" value={options.unit} onChange={e => setOption('unit', e.target.value)}><option value="nm">nm</option><option value="µm">µm</option></select></label>
      </div>
      <details className="ta-display-settings"><summary>Plot options · {options.observed ? 'observed' : 'analysis EF settings'}</summary><div className="ta-run-fields">
      <label className="ca-field">Thickness<select className="ux-input" value={options.observed ? 'observed' : 'adjusted'} onChange={e => setOption('observed', e.target.value === 'observed')}><option value="adjusted">Analysis EF settings</option><option value="observed">Observed (before EF)</option></select></label>
      <label className="ta-check"><input type="checkbox" checked={options.focus} onChange={e => setOption('focus', e.target.checked)} />Focus on whiskers</label>
      <label className="ta-check"><input type="checkbox" checked={options.showPoints} onChange={e => setOption('showPoints', e.target.checked)} />Show representative points</label>
      </div></details>
      <ThicknessBoxPlot groups={report?.groups || []} unit={options.unit} focus={options.focus} showPoints={options.showPoints} compact />
      <p className="ca-help">Use Export → Include thickness box plot and statistics to save this comparison. Overlapping Z projections are not independent biological replicates.</p>
    </section>}
  </div>
}
