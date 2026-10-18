import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, CheckCircle2, ChevronDown, Loader2, Play, Search } from 'lucide-react'
import { fetchViewState } from '../collaboration.js'
import { applyMeasurementSettings } from '../measurement.js'
import { calibrationPayload } from '../modelAnalysis.js'
import { loadMeasurementSettings, normalizeMeasurementSettings } from '../measurementSettings.js'
import { sortAlphanumeric } from '../collectionOrganization.js'
import {
  MAX_GAP, analysisGapLabel, analysisRequest, caseAnalysisJson, coverageKey, fetchCoverage, gapCoverage,
  gapLabel, gapShortLabel, imageApi, imageKey, imageSetSignature, isPost60X, mapLimit, ordinal, savedAnalyses,
  selectedZSlices, selectionSignature, sliceSummary,
} from '../caseAnalysis.js'
import { caseAnalysisSession } from '../caseAnalysisSession.js'
import { AnalysisStatusBadge } from './CaseAnalysisStatus.jsx'

const COVERAGE_MAX_AGE_MS = 30_000
const GAPS = Array.from({ length: MAX_GAP + 1 }, (_, gap) => gap)

function readinessLabel(state) {
  if (!state) return null
  if (state.ready === state.total) return { kind: 'ready', text: 'Results ready' }
  if (state.ready || state.active) {
    return { kind: 'partial', text: `${state.ready}/${state.total} Z ready${state.active ? ` · ${state.active} running` : ''}` }
  }
  return null
}

export default function CaseAnalysisSetup({ cases, loadingCases, casesError, initialCase, analyses, onReloadCases, onOpenAnalysis }) {
  const draft = caseAnalysisSession.draft
  const [selectedCases, setSelectedCases] = useState(() => draft?.selectedCases || (initialCase ? [initialCase] : []))
  const [query, setQuery] = useState('')
  const [caseFiles, setCaseFiles] = useState(() => Object.fromEntries(caseAnalysisSession.caseFiles))
  const [selectedImages, setSelectedImages] = useState(() => draft?.selectedImages || {})
  const [collapsedCases, setCollapsedCases] = useState(() => draft?.collapsedCases || {})
  const [details, setDetails] = useState(() => Object.fromEntries(caseAnalysisSession.details))
  const [coverage, setCoverage] = useState(() => new Map(caseAnalysisSession.coverage))
  const [coverageLoading, setCoverageLoading] = useState(false)
  const [reload, setReload] = useState(0)
  const [gap, setGap] = useState(() => draft?.gap ?? 0)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const detailsRef = useRef(details)
  detailsRef.current = details
  const mounted = useRef(false)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    caseAnalysisSession.draft = { selectedCases, selectedImages, collapsedCases, gap }
  }, [selectedCases, selectedImages, collapsedCases, gap])
  useEffect(() => {
    Object.entries(details).forEach(([key, detail]) => {
      if (detail?.meta) caseAnalysisSession.details.set(key, { ...detail, refreshed: false })
    })
  }, [details])

  useEffect(() => {
    const controller = new AbortController()
    mapLimit(selectedCases.filter(caseId => !caseAnalysisSession.caseFiles.get(caseId)?.files), 3, async caseId => {
      try {
        const payload = await caseAnalysisJson(`/agh/api/cases/${encodeURIComponent(caseId)}/files`, { signal: controller.signal })
        if (controller.signal.aborted) return
        const files = sortAlphanumeric(payload.files || [])
        caseAnalysisSession.caseFiles.set(caseId, { files })
        setCaseFiles(current => ({ ...current, [caseId]: { files } }))
      } catch (err) {
        if (err.name !== 'AbortError' && mounted.current) setCaseFiles(current => ({ ...current, [caseId]: { error: err.message } }))
      }
    }, controller.signal)
    return () => controller.abort()
  }, [selectedCases, reload])

  // New files get the automatic Post 60X selection once; later edits stick.
  useEffect(() => {
    setSelectedImages(current => {
      let next = null
      selectedCases.forEach(caseId => (caseFiles[caseId]?.files || []).forEach(filename => {
        const key = imageKey(caseId, filename)
        if (!(key in current)) {
          next = next || { ...current }
          next[key] = isPost60X(filename)
        }
      }))
      return next || current
    })
  }, [selectedCases, caseFiles])

  const rows = useMemo(() => selectedCases.flatMap(caseId => (caseFiles[caseId]?.files || []).map(filename => ({
    caseId, filename, key: imageKey(caseId, filename),
  }))), [selectedCases, caseFiles])
  const chosen = useMemo(() => rows.filter(row => selectedImages[row.key]), [rows, selectedImages])
  const chosenSignature = JSON.stringify(chosen.map(row => row.key))

  useEffect(() => {
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
  }, [chosenSignature, reload])

  // Cached images show at once; their shared calibration is refreshed quietly
  // in case it was changed in the viewer since.
  useEffect(() => {
    const controller = new AbortController()
    const cached = chosen.filter(row => detailsRef.current[row.key]?.meta && !detailsRef.current[row.key].edited && !detailsRef.current[row.key].refreshed)
    mapLimit(cached, 2, async row => {
      try {
        const shared = await fetchViewState(row.caseId, row.filename, { signal: controller.signal })
        if (controller.signal.aborted) return
        setDetails(current => {
          const detail = current[row.key]
          if (!detail?.meta || detail.edited) return current
          const settings = shared?.measurementSettings
            ? normalizeMeasurementSettings(shared.measurementSettings, detail.meta, row.caseId)
            : detail.settings
          return { ...current, [row.key]: { ...detail, settings, refreshed: true } }
        })
      } catch { /* the cached settings remain usable */ }
    }, controller.signal)
    return () => controller.abort()
    // Only once per visit; new images are read by the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const coverageTargets = chosen.filter(row => details[row.key]?.meta)
    .map(row => ({ caseId: row.caseId, filename: row.filename, channelIndex: details[row.key].channelIndex }))
  const coverageSignature = JSON.stringify(coverageTargets.map(target => coverageKey(target.caseId, target.filename, target.channelIndex)))

  useEffect(() => {
    const now = Date.now()
    const stale = coverageTargets.filter(target => {
      const cached = caseAnalysisSession.coverage.get(coverageKey(target.caseId, target.filename, target.channelIndex))
      return !cached || now - cached.loadedAt > COVERAGE_MAX_AGE_MS
    })
    if (!stale.length) return undefined
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setCoverageLoading(true)
      try {
        const loaded = await fetchCoverage(stale, { signal: controller.signal })
        const loadedAt = Date.now()
        loaded.forEach((entry, key) => caseAnalysisSession.coverage.set(key, { entry, loadedAt }))
        if (!controller.signal.aborted) setCoverage(new Map(caseAnalysisSession.coverage))
      } catch (err) {
        if (err.name !== 'AbortError' && mounted.current) setError(`Saved results could not be checked: ${err.message}`)
      } finally {
        if (!controller.signal.aborted) setCoverageLoading(false)
      }
    }, 250)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [coverageSignature, reload])

  const patchDetail = (key, patch) => setDetails(current => ({ ...current, [key]: { ...current[key], ...patch, edited: true } }))
  const patchSettings = (key, patch) => setDetails(current => ({ ...current, [key]: {
    ...current[key], settings: { ...current[key].settings, ...patch }, edited: true,
  } }))

  const includedCaseCount = new Set(chosen.map(row => row.caseId)).size
  const casesWithoutImages = selectedCases.filter(caseId => caseFiles[caseId]?.files && !chosen.some(row => row.caseId === caseId))
  const loadingFiles = selectedCases.some(caseId => !caseFiles[caseId]?.files && !caseFiles[caseId]?.error)
  const ready = chosen.filter(row => details[row.key]?.meta).length
  const calibrationValid = chosen.every(row => {
    const settings = details[row.key]?.settings
    return Number(settings?.pixelSizeUm) > 0 && Number.isFinite(Number(settings?.pixelSizeUm))
      && (!settings.expansionEnabled || (Number(settings.expansionFactor) > 0 && Number.isFinite(Number(settings.expansionFactor))))
  })

  const imageState = (row, atGap) => {
    const detail = details[row.key]
    if (!detail?.meta) return null
    const entry = coverage.get(coverageKey(row.caseId, row.filename, detail.channelIndex))?.entry
    if (!entry || entry.error) return null
    return gapCoverage(entry, Math.max(1, Number(detail.meta.zCount) || 1), detail.gap ?? atGap)
  }
  const coverageKnown = coverageTargets.length > 0 && coverageTargets.every(target => coverage.has(coverageKey(target.caseId, target.filename, target.channelIndex)))
  const totals = chosen.reduce((sum, row) => {
    const detail = details[row.key]
    if (!detail?.meta) return sum
    const state = imageState(row, gap) || { total: selectedZSlices(detail.meta.zCount, detail.gap ?? gap).length, ready: 0, active: 0, missing: 0 }
    sum.total += state.total
    sum.ready += state.ready
    sum.active += state.active
    sum.missing += state.missing
    if (state.total && state.ready === state.total) sum.imagesReady++
    return sum
  }, { total: 0, ready: 0, active: 0, missing: 0, imagesReady: 0 })
  const readyByGap = GAPS.map(option => chosen.filter(row => {
    const state = imageState(row, option)
    return state && state.ready === state.total
  }).length)

  const chosenImages = chosen.filter(row => details[row.key]?.meta).map(row => ({
    caseId: row.caseId, filename: row.filename, channelIndex: details[row.key].channelIndex, gap: details[row.key].gap,
  }))
  const imageSet = imageSetSignature(chosenImages)
  const selection = selectionSignature(chosenImages, gap)
  const matches = chosen.length && ready === chosen.length
    ? (analyses || []).filter(analysis => imageSetSignature(analysis.images) === imageSet)
    : []
  const exact = matches.find(analysis => selectionSignature(analysis.images, analysis.gap) === selection)

  const start = async () => {
    setError('')
    setStarting(true)
    try {
      const images = chosen.map(row => {
        const detail = details[row.key]
        return { caseId: row.caseId, filename: row.filename, zCount: Math.max(1, Number(detail.meta.zCount) || 1),
          gap: detail.gap, channelIndex: detail.channelIndex,
          calibration: calibrationPayload(applyMeasurementSettings(detail.meta, detail.settings)),
        }
      })
      const analysis = await savedAnalyses.create(analysisRequest(images, gap))
      const previous = caseAnalysisSession.analysisState.get(analysis.id)
      caseAnalysisSession.analysisState.set(analysis.id, { analysis, distributions: previous?.distributions || new Map() })
      caseAnalysisSession.coverage.clear()
      onOpenAnalysis(analysis.id)
    } catch (err) {
      if (mounted.current) setError(err.message)
    } finally {
      if (mounted.current) setStarting(false)
    }
  }

  const startLabel = totals.total && totals.ready === totals.total
    ? exact ? 'Open results' : 'Show results'
    : totals.ready || totals.active
      ? `Run ${totals.missing.toLocaleString()} new Z run${totals.missing === 1 ? '' : 's'}`
      : 'Run case analysis'

  const renderImage = row => {
    const detail = details[row.key]
    const checked = Boolean(selectedImages[row.key])
    const count = Math.max(1, Number(detail?.meta?.zCount) || 1)
    const readiness = checked ? readinessLabel(imageState(row, gap)) : null
    const slices = selectedZSlices(count, detail?.gap ?? gap)
    return <div key={row.key} className={`ca-image ${checked ? 'ca-image-selected' : ''}`}>
      <label className="ca-image-choice">
        <input type="checkbox" checked={checked} onChange={event => setSelectedImages(current => ({ ...current, [row.key]: event.target.checked }))} />
        <span className="break-all">{row.filename}</span>
        {readiness && <span className={`ca-ready-chip ca-ready-${readiness.kind}`}>{readiness.kind === 'ready' && <CheckCircle2 size={12} />}{readiness.text}</span>}
        {isPost60X(row.filename)
          ? <span className="ux-badge">Post 60X</span>
          : checked && <span className="ux-badge ux-badge-neutral">Manual</span>}
      </label>
      {checked && !detail?.meta && <p className={detail?.error ? 'ca-error' : 'ca-help'}>
        {detail?.error || 'Reading channels, Z slices and calibration…'}
        {detail?.error && <button className="ux-button ux-button-ghost" onClick={() => setReload(value => value + 1)}>Retry</button>}
      </p>}
      {checked && detail?.meta && <div className="ca-image-options">
        <p className="ca-help ca-image-slices">{count} Z slice{count === 1 ? '' : 's'} · {slices.length} run{slices.length === 1 ? '' : 's'}: {sliceSummary(slices)}</p>
        <details className="ca-image-settings">
          <summary>Image settings <span>Channel {detail.channelIndex + 1} · {detail.gap !== null ? `${gapShortLabel(detail.gap)} · ` : ''}{detail.settings.pixelSizeUm} µm/px · {detail.settings.expansionEnabled ? `EF ${detail.settings.expansionFactor}` : 'unexpanded'}</span></summary>
          <div className="ca-image-settings-body">
            <div className="ca-inline">
              <label className="ca-field">Model channel
                <select className="ux-input" value={detail.channelIndex} onChange={event => patchDetail(row.key, { channelIndex: Number(event.target.value) })}>
                  {Array.from({ length: Math.max(1, Number(detail.meta.channelCount) || 1) }, (_, index) => <option key={index} value={index}>Channel {index + 1}</option>)}
                </select>
              </label>
              {count > 1 && <label className="ca-check"><input type="checkbox" checked={detail.gap !== null} onChange={event => patchDetail(row.key, { gap: event.target.checked ? gap : null })} />Custom Z gap for this image</label>}
            </div>
            {count > 1 && detail.gap !== null && <label className="ca-field">{gapLabel(detail.gap)} ({gapShortLabel(detail.gap)})
              <input type="range" min="0" max={MAX_GAP} step="1" value={detail.gap} aria-label={`Z gap for ${row.filename}`} onChange={event => patchDetail(row.key, { gap: Number(event.target.value) })} />
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

  return <div className="ca-setup">
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
        <p className="ca-help">Post 60X images are selected automatically from their filenames. Choose others manually if needed.</p>
        {!selectedCases.length && <p className="ca-empty">Select one or more cases to see their images.</p>}
        {selectedCases.map(caseId => {
          const caseRows = rows.filter(row => row.caseId === caseId)
          const detected = caseRows.filter(row => isPost60X(row.filename))
          const other = caseRows.filter(row => !isPost60X(row.filename))
          const selected = caseRows.filter(row => selectedImages[row.key])
          const readyCount = selected.filter(row => readinessLabel(imageState(row, gap))?.kind === 'ready').length
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
              <span className="ca-selection-count">{selected.length} selected{manualCount ? ` · ${manualCount} manual` : ''}{readyCount ? ` · ${readyCount} ready` : ''}</span>
            </button></h3>
            <div id={panelId} hidden={collapsed} className="ca-case-body">
              <div className="ca-case-actions">
                {detected.length > 0 && <button className="ux-button ux-button-ghost" onClick={() => setSelectedImages(current => ({ ...current, ...Object.fromEntries(caseRows.map(row => [row.key, isPost60X(row.filename)])) }))}>Select only Post 60X</button>}
                {selected.length > 0 && <button className="ux-button ux-button-ghost" onClick={() => setSelectedImages(current => ({ ...current, ...Object.fromEntries(caseRows.map(row => [row.key, false])) }))}>Clear selection</button>}
              </div>
              {!caseFiles[caseId] && <p className="ca-help">Loading images…</p>}
              {caseFiles[caseId]?.error && <p className="ca-error">{caseFiles[caseId].error} <button onClick={() => setReload(value => value + 1)}>Retry</button></p>}
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
        <div className="ca-gap-options" role="radiogroup" aria-label="Z sampling">
          {GAPS.map(option => {
            const readyAtGap = readyByGap[option]
            const full = coverageKnown && chosen.length > 0 && readyAtGap === chosen.length
            return <button key={option} type="button" role="radio" aria-checked={option === gap}
              className={`ca-gap-option${option === gap ? ' is-selected' : ''}${full ? ' is-ready' : ''}`} onClick={() => setGap(option)}
              title={`${gapLabel(option)}${coverageKnown ? ` · ${readyAtGap}/${chosen.length} selected images already have results` : ''}`}>
              <span className="ca-gap-option-name">{gapShortLabel(option)}</span>
              <span className="ca-gap-option-detail">{option === 0 ? 'every slice' : `every ${ordinal(option + 1)}`}</span>
              {coverageKnown && chosen.length > 0 && <span className="ca-gap-option-ready">{full && <CheckCircle2 size={11} />}{readyAtGap}/{chosen.length}</span>}
            </button>
          })}
        </div>
        <p className="ca-gap-caption">{gapLabel(gap)}{coverageKnown && chosen.length > 0 ? ' · ✓ marks a Z sampling where every selected image already has results' : ''}</p>

        {chosen.length > 0 && ready === chosen.length && <div className={`ca-existing-summary${totals.total && totals.ready === totals.total ? ' is-ready' : ''}`} role="status">
          {!coverageKnown && coverageLoading ? <><Loader2 size={14} className="animate-spin" /> Checking saved results…</>
            : totals.total && totals.ready === totals.total
              ? <><CheckCircle2 size={15} /><span>All {chosen.length} images already have results at this Z sampling ({totals.total.toLocaleString()} Z slices). No model time needed.</span></>
              : totals.ready || totals.active
                ? <span><strong>{totals.imagesReady} of {chosen.length}</strong> images already have results at this Z sampling · {totals.ready.toLocaleString()} of {totals.total.toLocaleString()} Z slices segmented{totals.active ? ` · ${totals.active} in progress` : ''} · <strong>{totals.missing.toLocaleString()}</strong> new run{totals.missing === 1 ? '' : 's'} needed</span>
                : <span>No saved segmentations for this Z sampling yet · {totals.total.toLocaleString()} Z runs needed</span>}
        </div>}

        {matches.length > 0 && <div className="ca-saved-matches">
          <p>Saved analyses of these images</p>
          {matches.map(analysis => <button key={analysis.id} type="button" className={`ca-saved-match${analysis === exact ? ' is-exact' : ''}`} onClick={() => onOpenAnalysis(analysis.id)}>
            <span>{analysisGapLabel(analysis)}{analysis === exact ? ' · same settings' : ''}</span>
            <AnalysisStatusBadge analysis={analysis} />
            <ArrowRight size={14} />
          </button>)}
        </div>}

        <div className="ca-inline ca-between ca-run-summary"><p>{includedCaseCount} case{includedCaseCount === 1 ? '' : 's'} · {chosen.length} images · {totals.total.toLocaleString()} Z runs{ready < chosen.length ? ` · reading ${ready}/${chosen.length} images` : ''}</p>
          <button className="ux-button ux-button-primary" onClick={start} disabled={starting || !chosen.length || loadingFiles || ready !== chosen.length || !calibrationValid}>
            {starting || ready < chosen.length ? <Loader2 size={15} className="animate-spin" /> : totals.total && totals.ready === totals.total ? <ArrowRight size={15} /> : <Play size={15} />}
            {starting ? 'Starting…' : startLabel}
          </button>
        </div>
        {error && <p role="alert" className="ca-error">{error}</p>}
        {casesWithoutImages.length > 0 && <p className="ca-warning">{casesWithoutImages.length} selected case{casesWithoutImages.length === 1 ? ' has' : 's have'} no images checked and will not be included. Choose images above to include {casesWithoutImages.length === 1 ? 'it' : 'them'}.</p>}
        {chosen.length > 0 && ready === chosen.length && !calibrationValid && <p className="ca-error">Enter a positive pixel size and expansion factor in each image’s calibration settings.</p>}
      </section>
    </div>
  </div>
}
