import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, BarChart3, ChevronRight, FilePlus2, History, Loader2, Trash2 } from 'lucide-react'
import {
  analysisGapLabel, analysisRequest, analysisTitle, clearLegacyAnalysisBatch, loadLegacyAnalysisBatch, savedAnalyses,
} from '../caseAnalysis.js'
import { caseAnalysisSession } from '../caseAnalysisSession.js'
import CaseAnalysisResults from './CaseAnalysisResults.jsx'
import CaseAnalysisSetup from './CaseAnalysisSetup.jsx'
import { AnalysisStatusBadge, analysisProgress } from './CaseAnalysisStatus.jsx'
import './caseAnalysis.css'

function parseRoute(hash = window.location.hash) {
  const parts = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean)
  if (parts[0] !== 'case-analysis') return { view: 'home' }
  if (parts[1] === 'new') return { view: 'new' }
  if (parts[1] === 'analyses' && parts[2]) {
    try { return { view: 'analysis', id: decodeURIComponent(parts[2]) } } catch { return { view: 'list' } }
  }
  if (parts[1] === 'analyses') return { view: 'list' }
  return { view: 'home' }
}

function routeHash(route) {
  if (route.view === 'new') return '#/case-analysis/new'
  if (route.view === 'list') return '#/case-analysis/analyses'
  if (route.view === 'analysis') return `#/case-analysis/analyses/${encodeURIComponent(route.id)}`
  return '#/case-analysis'
}

function useSavedAnalysesList(currentUser, poll) {
  const [analyses, setAnalyses] = useState(() => caseAnalysisSession.analyses)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const refresh = useCallback(async (signal) => {
    setLoading(true)
    try {
      const list = await savedAnalyses.list({ signal })
      caseAnalysisSession.analyses = list
      setAnalyses(list)
      setError('')
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  // Analyses saved by the previous browser-only Case analysis become saved
  // analyses once, so nothing that was run before is lost.
  useEffect(() => {
    if (caseAnalysisSession.legacyMigrated.has(currentUser)) return
    caseAnalysisSession.legacyMigrated.add(currentUser)
    const legacy = loadLegacyAnalysisBatch(currentUser)
    if (!legacy) return
    const images = legacy.images.filter(image => image?.caseId && image?.filename && image?.calibration)
    if (!images.length) { clearLegacyAnalysisBatch(currentUser); return }
    savedAnalyses.create(analysisRequest(images.map(image => ({
      caseId: image.caseId, filename: image.filename, zCount: Math.max(1, Number(image.zCount) || 1),
      gap: image.gap ?? null, channelIndex: Number(image.channelIndex) || 0, calibration: image.calibration,
    })), Number(legacy.gap) || 0, { start: false }))
      .then(() => { clearLegacyAnalysisBatch(currentUser); refresh() })
      .catch(err => { if (err.status === 400) clearLegacyAnalysisBatch(currentUser) })
  }, [currentUser, refresh])

  useEffect(() => {
    const controller = new AbortController()
    refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const anyRunning = (analyses || []).some(analysis => analysis.status === 'running')
  useEffect(() => {
    if (!poll || !anyRunning) return undefined
    const id = window.setInterval(() => refresh(), 5000)
    return () => window.clearInterval(id)
  }, [poll, anyRunning, refresh])

  return { analyses, loading, error, refresh }
}

function HomeView({ analyses, onNew, onExisting }) {
  const count = analyses?.length || 0
  const running = (analyses || []).filter(analysis => analysis.status === 'running').length
  const unfinished = (analyses || []).filter(analysis => ['interrupted', 'incomplete'].includes(analysis.status)).length
  return <div className="ca-home">
    <button type="button" className="ux-card ca-home-choice" onClick={onNew}>
      <span className="ca-home-icon"><FilePlus2 size={22} /></span>
      <span className="ca-home-title">New analysis</span>
      <span className="ca-home-desc">Choose cases, images and Z sampling. Slices that already have results are reused.</span>
    </button>
    <button type="button" className="ux-card ca-home-choice" onClick={onExisting}>
      <span className="ca-home-icon"><History size={22} /></span>
      <span className="ca-home-title">Existing analyses</span>
      <span className="ca-home-desc">
        {analyses === null ? 'Loading saved analyses…'
          : count ? `${count} saved${running ? ` · ${running} running` : ''}${unfinished ? ` · ${unfinished} unfinished` : ''}`
            : 'No saved analyses yet'}
      </span>
    </button>
  </div>
}

function AnalysisListView({ analyses, loading, error, onOpen, onNew, onDeleted }) {
  const [deleting, setDeleting] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const remove = async analysis => {
    if (!window.confirm(`Delete the saved analysis “${analysisTitle(analysis)}”? Segmentations stay saved and are reused by other analyses.`)) return
    setDeleting(analysis.id)
    setDeleteError('')
    try {
      await savedAnalyses.remove(analysis.id)
      caseAnalysisSession.analysisState.delete(analysis.id)
      onDeleted()
    } catch (err) {
      setDeleteError(err.message)
    } finally {
      setDeleting('')
    }
  }
  return <section className="ux-card ca-card ca-list-card">
    <div className="ca-inline ca-between">
      <h2>Existing analyses</h2>
      <button className="ux-button ux-button-primary" onClick={onNew}><FilePlus2 size={14} />New analysis</button>
    </div>
    {error && <p role="alert" className="ca-error">{error}</p>}
    {deleteError && <p role="alert" className="ca-error">{deleteError}</p>}
    {analyses === null && loading && <p className="ca-help"><Loader2 size={14} className="mr-2 inline animate-spin" />Loading saved analyses…</p>}
    {analyses?.length === 0 && <p className="ca-empty">No saved analyses yet.</p>}
    {analyses?.length > 0 && <ul className="ca-analysis-list">
      {analyses.map(analysis => {
        const progress = analysisProgress(analysis.counts)
        return <li key={analysis.id} className="ca-analysis-item">
          <button type="button" className="ca-analysis-open" onClick={() => onOpen(analysis.id)}>
            <span className="ca-analysis-item-title">{analysisTitle(analysis)}</span>
            <span className="ca-analysis-item-meta">
              <strong>{analysisGapLabel(analysis)}</strong> · {analysis.images.length} image{analysis.images.length === 1 ? '' : 's'} · {analysis.caseIds.length} case{analysis.caseIds.length === 1 ? '' : 's'} · {progress.total} Z runs
            </span>
            <span className="ca-analysis-item-date">Updated {new Date(analysis.updatedAt).toLocaleString()}</span>
            {analysis.status !== 'complete' && <span className="ca-progress-bar-mini" aria-hidden="true"><span style={{ width: `${progress.percent}%` }} /></span>}
          </button>
          <AnalysisStatusBadge analysis={analysis} />
          <button type="button" className="ux-icon-button" title="Delete saved analysis" aria-label={`Delete ${analysisTitle(analysis)}`} disabled={deleting === analysis.id} onClick={() => remove(analysis)}>
            {deleting === analysis.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
        </li>
      })}
    </ul>}
  </section>
}

export default function CaseAnalysisPage({ cases, loadingCases, casesError, initialCase, currentUser, onBack, onReloadCases }) {
  const [route, setRoute] = useState(() => parseRoute())
  const list = useSavedAnalysesList(currentUser, route.view !== 'new')

  useEffect(() => {
    const sync = () => setRoute(parseRoute())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  const navigate = useCallback(next => {
    setRoute(next)
    const hash = routeHash(next)
    if (window.location.hash !== hash) window.history.pushState(null, '', hash)
  }, [])
  const openAnalysis = useCallback(id => { navigate({ view: 'analysis', id }); list.refresh() }, [navigate, list.refresh])

  const crumbs = [{ label: 'Case analysis', route: { view: 'home' } }]
  if (route.view === 'new') crumbs.push({ label: 'New analysis' })
  if (route.view === 'list') crumbs.push({ label: 'Existing analyses' })
  if (route.view === 'analysis') {
    crumbs.push({ label: 'Existing analyses', route: { view: 'list' } })
    const current = list.analyses?.find(analysis => analysis.id === route.id)
    crumbs.push({ label: current ? analysisTitle(current) : 'Analysis' })
  }

  return <div className="app-shell ca-page">
    <header className="app-header ca-header">
      <div className="ca-inline"><span className="app-brand-mark"><BarChart3 size={16} /></span><div><h1>Case analysis</h1><p className="ca-help">Compare GBM thickness across cases and images</p></div></div>
      <button onClick={onBack} className="ux-button ux-button-secondary"><ArrowLeft size={14} />Files browser</button>
    </header>
    <div className="border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-1.5 text-center text-[11px] font-semibold text-[var(--danger)]">Research use only. Not validated for clinical diagnosis or treatment decisions.</div>
    <main className="ca-main">
      {route.view !== 'home' && <nav className="ca-breadcrumbs" aria-label="Case analysis">
        {crumbs.map((crumb, index) => <span key={index} className="ca-crumb">
          {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
          {crumb.route ? <button type="button" onClick={() => navigate(crumb.route)}>{crumb.label}</button> : <span aria-current="page">{crumb.label}</span>}
        </span>)}
      </nav>}
      {route.view === 'home' && <HomeView analyses={list.analyses} onNew={() => navigate({ view: 'new' })} onExisting={() => navigate({ view: 'list' })} />}
      {route.view === 'new' && <CaseAnalysisSetup cases={cases} loadingCases={loadingCases} casesError={casesError}
        initialCase={initialCase} analyses={list.analyses} onReloadCases={onReloadCases} onOpenAnalysis={openAnalysis} />}
      {route.view === 'list' && <AnalysisListView analyses={list.analyses} loading={list.loading} error={list.error}
        onOpen={openAnalysis} onNew={() => navigate({ view: 'new' })} onDeleted={() => list.refresh()} />}
      {route.view === 'analysis' && <CaseAnalysisResults id={route.id} analyses={list.analyses}
        onOpenAnalysis={openAnalysis} onNewAnalysis={() => navigate({ view: 'new' })} onChanged={() => list.refresh()} />}
    </main>
  </div>
}
