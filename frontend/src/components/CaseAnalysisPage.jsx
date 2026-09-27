import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, BarChart3, ChevronDown, Loader2, Play, RefreshCw, Search } from 'lucide-react'
import { fetchViewState } from '../collaboration.js'
import { applyMeasurementSettings } from '../measurement.js'
import { calibrationPayload } from '../modelAnalysis.js'
import { loadMeasurementSettings, normalizeMeasurementSettings } from '../measurementSettings.js'
import { sortAlphanumeric } from '../collectionOrganization.js'
import {
  batchProgress, caseAnalysisJson, comparisonGroups, gapLabel, imageApi, imageKey, isPost60X,
  loadAnalysisBatch, makeAnalysisBatch, mapLimit, monitorCaseAnalysis, retryAnalysisBatch,
  saveAnalysisBatch, selectedZSlices,
} from '../caseAnalysis.js'
import ThicknessBoxPlot from './ThicknessBoxPlot.jsx'
import './caseAnalysis.css'

function zDescription(zCount, gap) {
  const selected = selectedZSlices(zCount, gap)
  const preview = selected.slice(0, 12).map(z => z + 1).join(', ')
  return `${selected.length} run${selected.length === 1 ? '' : 's'} · Z ${preview}${selected.length > 12 ? ', …' : ''}${gap > 0 && zCount <= gap + 1 ? ' (middle slice)' : ''}`
}

function progressLabel(job) {
  if (job.distributionError) return `Measurement unavailable: ${job.distributionError}`
  if (job.distribution) return job.distribution.sampleCount
    ? `${job.reused ? 'Reused' : 'Complete'} · ${job.distribution.sampleCount.toLocaleString()} points`
    : 'Complete · no GBM points'
  if (job.status === 'SUCCEEDED') return `${job.reused ? 'Reusing segmentation' : 'Segmented'} · loading thickness points`
  if (job.error) return job.error
  if (job.pollError) return `Connection interrupted: ${job.pollError}`
  if (job.status === 'PENDING') return 'Checking for an existing run'
  return job.progress?.message || (job.status === 'QUEUED' ? 'Waiting for model worker' : 'Running model')
}

export default function CaseAnalysisPage({ cases, loadingCases, casesError, initialCase, currentUser, onBack, onReloadCases }) {
  const [selectedCases, setSelectedCases] = useState(initialCase ? [initialCase] : [])
  const [query, setQuery] = useState('')
  const [caseFiles, setCaseFiles] = useState({})
  const [selectedImages, setSelectedImages] = useState({})
  const [collapsedCases, setCollapsedCases] = useState({})
  const [details, setDetails] = useState({})
  const [metaReload, setMetaReload] = useState(0)
  const [gap, setGap] = useState(0)
  const [batch, setBatch] = useState(() => loadAnalysisBatch(currentUser))
  const [monitoring, setMonitoring] = useState(() => Boolean(batch))
  const [error, setError] = useState('')
  const [storageWarning, setStorageWarning] = useState(false)
  const [groupBy, setGroupBy] = useState('case')
  const [unit, setUnit] = useState('nm')
  const [observed, setObserved] = useState(false)
  const [focus, setFocus] = useState(true)
  const [showPoints, setShowPoints] = useState(true)
  const [excluded, setExcluded] = useState([])
  const batchRef = useRef(batch)
  batchRef.current = batch
  const filesRef = useRef({})
  const detailsRef = useRef(details)
  detailsRef.current = details
  const mounted = useRef(false)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    if (batch) return undefined
    const controller = new AbortController()
    mapLimit(selectedCases.filter(caseId => !filesRef.current[caseId]), 3, async caseId => {
      try {
        const payload = await caseAnalysisJson(`/agh/api/cases/${encodeURIComponent(caseId)}/files`, { signal: controller.signal })
        if (controller.signal.aborted) return
        const files = sortAlphanumeric(payload.files || [])
        filesRef.current[caseId] = { files }
        setCaseFiles(current => ({ ...current, [caseId]: { files } }))
        setSelectedImages(current => {
          const next = { ...current }
          files.forEach(filename => {
            const key = imageKey(caseId, filename)
            if (!(key in next)) next[key] = isPost60X(filename)
          })
          return next
        })
      } catch (err) {
        if (err.name !== 'AbortError' && mounted.current) setCaseFiles(current => ({ ...current, [caseId]: { error: err.message } }))
      }
    }, controller.signal)
    return () => controller.abort()
  }, [selectedCases, batch?.id, metaReload])

  const rows = useMemo(() => selectedCases.flatMap(caseId => (caseFiles[caseId]?.files || []).map(filename => ({
    caseId, filename, key: imageKey(caseId, filename),
  }))), [selectedCases, caseFiles])
  const chosen = rows.filter(row => selectedImages[row.key])
  const includedCaseCount = new Set(chosen.map(row => row.caseId)).size
  const casesWithoutImages = selectedCases.filter(caseId => caseFiles[caseId]?.files
    && !chosen.some(row => row.caseId === caseId))
  const chosenSignature = JSON.stringify(chosen.map(row => row.key))

  useEffect(() => {
    if (batch) return undefined
    const controller = new AbortController()
    const targets = chosen.filter(row => !detailsRef.current[row.key]?.meta)
    mapLimit(targets, 3, async row => {
      try {
        const meta = await caseAnalysisJson(`${imageApi(row.caseId, row.filename)}/meta`, { signal: controller.signal })
        let shared = null
        let calibrationWarning = ''
        try { shared = await fetchViewState(row.caseId, row.filename, { signal: controller.signal }) }
        catch (err) {
          if (err.name === 'AbortError') throw err
          calibrationWarning = 'Shared calibration could not be loaded. Verify the settings below.'
        }
        if (controller.signal.aborted) return
        const settings = shared?.measurementSettings
          ? normalizeMeasurementSettings(shared.measurementSettings, meta, row.caseId)
          : loadMeasurementSettings(row.caseId, row.filename, meta)
        setDetails(current => ({ ...current, [row.key]: {
          meta, settings, channelIndex: Number(meta.channelCount) > 1 ? 1 : 0,
          gap: null, calibrationWarning, error: '',
        } }))
      } catch (err) {
        if (err.name !== 'AbortError' && mounted.current) setDetails(current => ({ ...current, [row.key]: { error: err.message } }))
      }
    }, controller.signal)
    return () => controller.abort()
  }, [chosenSignature, metaReload, batch?.id])

  useEffect(() => {
    if (!batch || !monitoring) return undefined
    const controller = new AbortController()
    monitorCaseAnalysis(batchRef.current, {
      signal: controller.signal,
      onChange: next => {
        setBatch(next)
        if (!saveAnalysisBatch(currentUser, next)) setStorageWarning(true)
      },
    }).then(() => { if (!controller.signal.aborted) setMonitoring(false) })
      .catch(err => {
        if (err.name !== 'AbortError' && !controller.signal.aborted) { setError(err.message); setMonitoring(false) }
        controller.abort()
      })
    return () => controller.abort()
  }, [batch?.id, monitoring, currentUser])

  const patchDetail = (key, patch) => setDetails(current => ({ ...current, [key]: { ...current[key], ...patch } }))
  const patchSettings = (key, patch) => setDetails(current => ({ ...current, [key]: {
    ...current[key], settings: { ...current[key].settings, ...patch },
  } }))
  const loadingFiles = selectedCases.some(caseId => !caseFiles[caseId]?.files && !caseFiles[caseId]?.error)
  const ready = chosen.filter(row => details[row.key]?.meta).length
  const calibrationValid = chosen.every(row => {
    const settings = details[row.key]?.settings
    return Number(settings?.pixelSizeUm) > 0 && Number.isFinite(Number(settings?.pixelSizeUm))
      && (!settings.expansionEnabled || (Number(settings.expansionFactor) > 0 && Number.isFinite(Number(settings.expansionFactor))))
  })
  const plannedRuns = chosen.reduce((sum, row) => {
    const detail = details[row.key]
    return sum + (detail?.meta ? selectedZSlices(detail.meta.zCount, detail.gap ?? gap).length : 0)
  }, 0)
  const progress = batchProgress(batch?.jobs)
  const groups = useMemo(() => comparisonGroups(batch, { groupBy, unit, observed, excluded }), [batch, groupBy, unit, observed, excluded])

  const start = () => {
    setError('')
    const images = chosen.map(row => {
      const detail = details[row.key]
      return { ...row, zCount: Math.max(1, Number(detail.meta.zCount) || 1), gap: detail.gap,
        channelIndex: detail.channelIndex,
        calibration: calibrationPayload(applyMeasurementSettings(detail.meta, detail.settings)),
      }
    })
    const next = makeAnalysisBatch(images, gap)
    setExcluded([])
    setBatch(next)
    setStorageWarning(!saveAnalysisBatch(currentUser, next))
    setMonitoring(true)
  }

  const renderImage = row => {
    const detail = details[row.key]
    const checked = Boolean(selectedImages[row.key])
    const count = Math.max(1, Number(detail?.meta?.zCount) || 1)
    return <div key={row.key} className={`ca-image ${checked ? 'ca-image-selected' : ''}`}>
      <label className="ca-image-choice">
        <input type="checkbox" checked={checked} onChange={event => setSelectedImages(current => ({ ...current, [row.key]: event.target.checked }))} />
        <span className="break-all">{row.filename}</span>
        {isPost60X(row.filename)
          ? <span className="ux-badge">Post 60X</span>
          : checked && <span className="ux-badge ux-badge-neutral">Manual</span>}
      </label>
      {checked && !detail?.meta && <p className={detail?.error ? 'ca-error' : 'ca-help'}>
        {detail?.error || 'Reading channels, Z slices and calibration…'}
        {detail?.error && <button className="ux-button ux-button-ghost" onClick={() => setMetaReload(value => value + 1)}>Retry</button>}
      </p>}
      {checked && detail?.meta && <div className="ca-image-options">
        <p className="ca-help ca-image-slices">{count} Z slice{count === 1 ? '' : 's'} · {zDescription(count, detail.gap ?? gap)}</p>
        <details className="ca-image-settings">
          <summary>Image settings <span>Channel {detail.channelIndex + 1} · {detail.gap !== null ? `${gapLabel(detail.gap)} · ` : ''}{detail.settings.pixelSizeUm} µm/px · {detail.settings.expansionEnabled ? `EF ${detail.settings.expansionFactor}` : 'unexpanded'}</span></summary>
          <div className="ca-image-settings-body">
            <div className="ca-inline">
              <label className="ca-field">Model channel
                <select className="ux-input" value={detail.channelIndex} onChange={event => patchDetail(row.key, { channelIndex: Number(event.target.value) })}>
                  {Array.from({ length: Math.max(1, Number(detail.meta.channelCount) || 1) }, (_, index) => <option key={index} value={index}>Channel {index + 1}</option>)}
                </select>
              </label>
              {count > 1 && <label className="ca-check"><input type="checkbox" checked={detail.gap !== null} onChange={event => patchDetail(row.key, { gap: event.target.checked ? gap : null })} />Custom Z gap for this image</label>}
            </div>
            {count > 1 && detail.gap !== null && <label className="ca-field">{gapLabel(detail.gap)}
              <input type="range" min="0" max="8" step="1" value={detail.gap} aria-label={`Z gap for ${row.filename}`} onChange={event => patchDetail(row.key, { gap: Number(event.target.value) })} />
            </label>}
            <div className="ca-calibration">
              {detail.calibrationWarning && <p className="ca-warning">{detail.calibrationWarning}</p>}
              {detail.meta.pixelSizeIsDefault && <p className="ca-warning">Image metadata has no pixel calibration. Verify the pixel size before comparing thickness.</p>}
              <div className="ca-inline">
                <label className="ca-field">Pixel size (µm/px)<input className="ux-input" type="number" min="0.000001" step="any" value={detail.settings.pixelSizeUm} onChange={event => patchSettings(row.key, { pixelSizeUm: event.target.value })} /></label>
                <label className="ca-check"><input type="checkbox" checked={detail.settings.expansionEnabled} onChange={event => patchSettings(row.key, { expansionEnabled: event.target.checked })} />Apply expansion factor</label>
                {detail.settings.expansionEnabled && <label className="ca-field">Expansion factor<input className="ux-input" type="number" min="0.000001" step="any" value={detail.settings.expansionFactor} onChange={event => patchSettings(row.key, { expansionFactor: event.target.value })} /></label>}
              </div>
              <p className="ca-help">Starts with the viewer’s saved settings. Changes here apply to this analysis only.</p>
            </div>
          </div>
        </details>
      </div>}
    </div>
  }

  return <div className="app-shell ca-page">
    <header className="app-header ca-header">
      <div className="ca-inline"><span className="app-brand-mark"><BarChart3 size={16} /></span><div><h1>Case analysis</h1><p className="ca-help">Compare GBM thickness across cases and images</p></div></div>
      <button onClick={onBack} className="ux-button ux-button-secondary"><ArrowLeft size={14} />Files browser</button>
    </header>
    <div className="border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-1.5 text-center text-[11px] font-semibold text-[var(--danger)]">Research use only. Not validated for clinical diagnosis or treatment decisions.</div>
    <main className="ca-main">
      {error && <div role="alert" className="ca-error ca-notice">{error}</div>}
      {storageWarning && <p role="status" className="ca-warning">Browser storage is unavailable. Keep this page open to retain this comparison.</p>}
      {!batch ? <div className="ca-setup">
        <section className="ux-card ca-case-picker">
          <h2>1. Select cases</h2>
          <label className="ux-search"><Search size={14} /><input className="ca-search-input" placeholder="Find a case" aria-label="Find a case" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <div className="ca-inline"><button className="ux-button ux-button-ghost" onClick={() => setSelectedCases([...cases])}>Select all</button><button className="ux-button ux-button-ghost" onClick={() => setSelectedCases([])}>Clear</button></div>
          {loadingCases && <p className="ca-help">Loading cases…</p>}
          {casesError && <p className="ca-error">{casesError} <button onClick={onReloadCases}>Retry</button></p>}
          {!loadingCases && !cases.length && <p className="ca-help">No cases are available.</p>}
          <div className="ca-case-list">{cases.filter(caseId => caseId.toLowerCase().includes(query.toLowerCase())).map(caseId => <label key={caseId} className="ca-check">
            <input type="checkbox" checked={selectedCases.includes(caseId)} onChange={event => setSelectedCases(current => event.target.checked ? [...current, caseId] : current.filter(value => value !== caseId))} />{caseId}
          </label>)}</div>
        </section>
        <div className="ca-sections">
          <section className="ux-card ca-card">
            <div className="ca-inline ca-between">
              <h2>2. Choose images</h2>
              {selectedCases.length > 1 && <div className="ca-case-actions">
                <button className="ux-button ux-button-ghost" onClick={() => setCollapsedCases({})}>Expand all</button>
                <button className="ux-button ux-button-ghost" onClick={() => setCollapsedCases(Object.fromEntries(selectedCases.map(caseId => [caseId, true])))}>Collapse all</button>
              </div>}
            </div>
            <p className="ca-help">Only Post 60X images are selected automatically, using the files browser’s filename groups. Review the checked images or choose others manually. Folding a case keeps its selections.</p>
            {!selectedCases.length && <p className="ca-empty">Select one or more cases to see their images.</p>}
            {selectedCases.map(caseId => {
              const caseRows = rows.filter(row => row.caseId === caseId)
              const detected = caseRows.filter(row => isPost60X(row.filename))
              const other = caseRows.filter(row => !isPost60X(row.filename))
              const selected = caseRows.filter(row => selectedImages[row.key])
              const manualCount = other.filter(row => selectedImages[row.key]).length
              const loaded = Boolean(caseFiles[caseId]?.files)
              const collapsed = Boolean(collapsedCases[caseId])
              const panelId = `ca-case-${encodeURIComponent(caseId)}`
              return <section key={caseId} className="ca-case-section">
                <h3><button className="ca-case-toggle" aria-expanded={!collapsed} aria-controls={panelId}
                  onClick={() => setCollapsedCases(current => ({ ...current, [caseId]: !current[caseId] }))}>
                  <ChevronDown size={16} className={collapsed ? 'ca-chevron-folded' : ''} />
                  <span className="ca-case-name">{caseId}</span>
                  <span className={`ca-case-detection ${loaded && !detected.length ? 'ca-case-no-match' : ''}`}>
                    {loaded ? detected.length ? `${detected.length} Post 60X detected` : 'No Post 60X detected' : caseFiles[caseId]?.error ? 'Could not load images' : 'Loading…'}
                  </span>
                  <span className="ca-selection-count">{selected.length} selected{manualCount ? ` · ${manualCount} manual` : ''}</span>
                </button></h3>
                <div id={panelId} hidden={collapsed} className="ca-case-body">
                  <div className="ca-case-actions">
                    {detected.length > 0 && <button className="ux-button ux-button-ghost" onClick={() => setSelectedImages(current => ({ ...current, ...Object.fromEntries(caseRows.map(row => [row.key, isPost60X(row.filename)])) }))}>Select only Post 60X</button>}
                    {selected.length > 0 && <button className="ux-button ux-button-ghost" onClick={() => setSelectedImages(current => ({ ...current, ...Object.fromEntries(caseRows.map(row => [row.key, false])) }))}>Clear selection</button>}
                  </div>
                  {!caseFiles[caseId] && <p className="ca-help">Loading images…</p>}
                  {caseFiles[caseId]?.error && <p className="ca-error">{caseFiles[caseId].error} <button onClick={() => setMetaReload(value => value + 1)}>Retry</button></p>}
                  {loaded && !detected.length && <p className="ca-warning ca-missing-post">No Post 60X images detected from filenames. {other.length ? 'Nothing is selected automatically. Choose images manually below.' : 'This case has no available images.'}</p>}
                  {detected.map(renderImage)}
                  {other.length > 0 && (detected.length
                    ? <details className="ca-other-images"><summary>Choose other images manually <span>({other.length} available{manualCount ? ` · ${manualCount} selected` : ''})</span></summary>{other.map(renderImage)}</details>
                    : <div className="ca-manual-images"><p className="ca-help">Choose images manually</p>{other.map(renderImage)}</div>)}
                </div>
              </section>
            })}
          </section>
          <section className="ux-card ca-card">
            <h2>3. Choose Z sampling and run</h2>
            <label className="ca-field ca-gap-label">{gapLabel(gap)}
              <input type="range" min="0" max="8" step="1" value={gap} onChange={event => setGap(Number(event.target.value))} aria-label="Z-slice gap" aria-valuetext={gapLabel(gap)} />
            </label>
            <div className="ca-gap-ticks"><span>All slices</span>{Array.from({ length: 8 }, (_, i) => <span key={i}>{i + 1}</span>)}</div>
            <p className="ca-help">Gap 1 selects Z1, Z3, Z5… If a stack is too short for two samples, only its middle slice is used. Each run uses the existing model’s up-to-five-plane Z projection.</p>
            <p className="ca-help">Matching completed segmentations are reused. Matching queued or running jobs are joined. The source image, Z slice, model channel and model version must match.</p>
            <div className="ca-inline ca-between ca-run-summary"><p>{includedCaseCount} case{includedCaseCount === 1 ? '' : 's'} included · {chosen.length} images · {plannedRuns} Z runs{ready < chosen.length ? ` · reading ${ready}/${chosen.length} images` : ''}</p>
              <button className="ux-button ux-button-primary" onClick={start} disabled={!chosen.length || loadingFiles || ready !== chosen.length || !calibrationValid}>
                {ready < chosen.length ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}Run case analysis
              </button>
            </div>
            {casesWithoutImages.length > 0 && <p className="ca-warning">{casesWithoutImages.length} selected case{casesWithoutImages.length === 1 ? ' has' : 's have'} no images checked and will not be included. Choose images above to include {casesWithoutImages.length === 1 ? 'it' : 'them'}.</p>}
            {chosen.length > 0 && ready === chosen.length && !calibrationValid && <p className="ca-error">Enter a positive pixel size and expansion factor in each image’s calibration settings.</p>}
          </section>
        </div>
      </div> : <div className="ca-sections">
        <section className="ux-card ca-card">
          <div className="ca-inline ca-between"><div><h2>{monitoring ? 'Analyzing selected images' : progress.complete + progress.failed < progress.total ? 'Analysis updates paused' : progress.failed ? 'Analysis finished with issues' : 'Analysis results'}</h2><p className="ca-help">{batch.images.length} images · {batch.jobs.length} Z runs · {new Date(batch.createdAt).toLocaleString()}</p></div>
            <div className="ca-inline">
              <button className="ux-button ux-button-secondary" onClick={() => { setError(''); setMonitoring(value => !value) }}>{monitoring ? 'Pause updates' : 'Refresh progress'}</button>
              {!monitoring && progress.failed > 0 && <button className="ux-button ux-button-secondary" onClick={() => { setBatch(retryAnalysisBatch(batch)); setMonitoring(true); setError('') }}><RefreshCw size={14} />Retry incomplete</button>}
              <button className="ux-button ux-button-ghost" onClick={() => { setMonitoring(false); setBatch(null); saveAnalysisBatch(currentUser, null); setError(''); setExcluded([]) }}>New selection</button>
            </div>
          </div>
          <progress className="ca-progress" max="100" value={progress.percent} aria-label="Case analysis progress" />
          <p role="status" className="ca-progress-summary">{progress.complete}/{progress.total} measured · {progress.reused} saved segmentations reused · {progress.running} running · {progress.queued} queued{progress.failed ? ` · ${progress.failed} need attention` : ''}{progress.empty ? ` · ${progress.empty} empty masks` : ''}</p>
          <p className="ca-help">Queued jobs continue if you leave this page or pause updates. Reopen Case analysis in this browser to resume. If jobs remain queued, make sure the model worker is running.</p>
          {batch.images.map(image => {
            const jobs = batch.jobs.filter(job => job.imageKey === image.key)
            const completed = jobs.filter(job => job.distribution).length
            return <details key={image.key} className="ca-job-group">
              <summary>{image.caseId} · {image.filename}<span>{completed}/{jobs.length} measured · channel {image.channelIndex + 1}</span></summary>
              <p className="ca-help">{image.calibration.pixelSizeXUm} µm/px · {image.calibration.expansionEnabled ? `EF ${image.calibration.expansionFactor}` : 'unexpanded'}</p>
              {jobs.map(job => <div className="ca-job-row" key={job.id}><span>Z{job.zIndex + 1}</span><span className={job.error || job.distributionError ? 'ca-error' : ''}>{progressLabel(job)}</span><span>{job.status === 'RUNNING' ? `${Math.round((job.progress?.fraction || 0) * 100)}%` : ''}</span></div>)}
            </details>
          })}
        </section>
        <section className="ux-card ca-card">
          <h2>GBM thickness distributions</h2>
          <p className="ca-help">Every centerline point across the selected full masks contributes equally. These plots pool individual thickness values, not image or case averages. Z projections can overlap; points and slices are not independent biological replicates.</p>
          {progress.complete < progress.total && <p className="ca-warning">Partial results: this plot currently includes {progress.complete} of {progress.total} runs.</p>}
          <div className="ca-plot-controls">
            <label className="ca-field">Compare by<select className="ux-input" value={groupBy} onChange={event => setGroupBy(event.target.value)}><option value="case">Case</option><option value="image">Image within case</option><option value="slice">Image and Z slice</option></select></label>
            <label className="ca-field">Thickness<select className="ux-input" value={observed ? 'observed' : 'adjusted'} onChange={event => setObserved(event.target.value === 'observed')}><option value="adjusted">Per-image EF settings</option><option value="observed">Observed (before EF)</option></select></label>
            <label className="ca-field">Units<select className="ux-input" value={unit} onChange={event => setUnit(event.target.value)}><option value="nm">nm</option><option value="µm">µm</option></select></label>
            <label className="ca-check"><input type="checkbox" checked={focus} onChange={event => setFocus(event.target.checked)} />Focus on whiskers</label>
            <label className="ca-check"><input type="checkbox" checked={showPoints} onChange={event => setShowPoints(event.target.checked)} />Show representative points</label>
          </div>
          <details className="ca-comparison-filter"><summary>Choose images in this comparison ({batch.images.length - excluded.length}/{batch.images.length})</summary>
            {batch.images.map(image => <label key={image.key} className="ca-check"><input type="checkbox" checked={!excluded.includes(image.key)} onChange={event => setExcluded(current => event.target.checked ? current.filter(key => key !== image.key) : [...current, image.key])} />{image.caseId} · {image.filename}</label>)}
          </details>
          <ThicknessBoxPlot groups={groups} unit={unit} focus={focus} showPoints={showPoints} />
        </section>
      </div>}
    </main>
  </div>
}
