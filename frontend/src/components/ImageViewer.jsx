import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Save, Download, MousePointer, Circle, Minus, Square, Ellipsis, PenLine, Type, ArrowRight, Trash2, User, ChevronDown, ChevronUp, Pencil, List, Info } from 'lucide-react'
import { jsPDF } from 'jspdf'
import html2canvas from 'html2canvas'
import MultiChannelCanvas from './MultiChannelCanvas.jsx'
import AnnotationLayer from './AnnotationLayer.jsx'
import ChannelControls from './ChannelControls.jsx'

const API = '/agh/api'

const TOOLS = [
  { id: 'select',   icon: MousePointer, label: 'Select' },
  { id: 'point',    icon: Circle,       label: 'Point' },
  { id: 'line',     icon: Minus,        label: 'Line' },
  { id: 'arrow',    icon: ArrowRight,   label: 'Arrow' },
  { id: 'rect',     icon: Square,       label: 'Rectangle' },
  { id: 'ellipse',  icon: Ellipsis,     label: 'Ellipse' },
  { id: 'freehand', icon: PenLine,      label: 'Freehand' },
  { id: 'text',     icon: Type,         label: 'Text' },
]

const COLORS = ['#ffee55','#ff4444','#44ff88','#44aaff','#ff44ff','#ffffff','#ff8800']

function defaultChSettings(n) {
  return Array.from({ length: n }, () => ({ enabled: true, minVal: 0, maxVal: 255 }))
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
  return body
}

export default function ImageViewer({ caseId, filename, onClose }) {
  // Image metadata
  const [imgMeta, setImgMeta]           = useState(null)
  // Channel display settings [{enabled, minVal, maxVal}]
  const [chSettings, setChSettings]     = useState([])
  // Pan/zoom
  const [tx, setTx]                     = useState(0)
  const [ty, setTy]                     = useState(0)
  const [scale, setScale]               = useState(1)
  // Annotations
  const [annotations, setAnnotations]   = useState([])
  const [selectedId, setSelectedId]     = useState(null)
  const [dirty, setDirty]               = useState(false)
  const [annotationRevision, setAnnotationRevision] = useState(0)
  const [loadError, setLoadError]       = useState(null)
  const [saveError, setSaveError]       = useState(null)
  const [saving, setSaving]             = useState(false)
  // Tools
  const [activeTool, setActiveTool]     = useState('select')
  const [annColor, setAnnColor]         = useState('#ffee55')
  const [fontSize, setFontSize]         = useState(18)
  const [annotator, setAnnotator]       = useState(() => localStorage.getItem('annotatorName') || '')
  // Annotations panel
  const [showAnnPanel, setShowAnnPanel] = useState(true)
  // About modal
  const [showAbout, setShowAbout]       = useState(false)
  // Export
  const [exporting, setExporting]       = useState(false)

  const canvasRef   = useRef(null)
  const svgRef      = useRef(null)
  const viewportRef = useRef(null)
  const dragRef     = useRef(null)

  // ── Load meta ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const controller = new AbortController()
    setLoadError(null)
    fetchJson(`${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/meta`, { signal: controller.signal })
      .then(meta => {
        setImgMeta(meta)
        const _saved = localStorage.getItem(`agh-ch-${caseId}-${filename}`)
        let _ch = defaultChSettings(meta.numChannels)
        if (_saved) { try { const p = JSON.parse(_saved); if (p.length === meta.numChannels) _ch = p } catch {} }
        setChSettings(_ch)
        // Fit to viewport
        const vw = window.innerWidth - 56 * 4   // approx sidebar widths
        const vh = window.innerHeight - 48
        const s  = Math.min(vw / meta.width, vh / meta.height, 1) * 0.9
        setScale(s)
        setTx((vw - meta.width * s) / 2)
        setTy((vh - meta.height * s) / 2)
      })
      .catch(err => { if (err.name !== 'AbortError') setLoadError(err.message) })
    return () => controller.abort()
  }, [caseId, filename])

  // ── Load annotations ───────────────────────────────────────────────────────
  useEffect(() => {
    const controller = new AbortController()
    fetchJson(`${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/annotations`, { signal: controller.signal })
      .then(d => {
        setAnnotations(d.annotations || [])
        setAnnotationRevision(d.revision || 0)
        setDirty(false)
      })
      .catch(err => { if (err.name !== 'AbortError') setLoadError(err.message) })
    return () => controller.abort()
  }, [caseId, filename])

  // ── Save annotations ───────────────────────────────────────────────────────
  const saveAnnotations = useCallback(async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const result = await fetchJson(`${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/annotations`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-AGH-User': annotator || ''
        },
        body: JSON.stringify({ revision: annotationRevision, updatedBy: annotator, annotations })
      })
      setAnnotationRevision(result.revision || annotationRevision + 1)
      setDirty(false)
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }, [caseId, filename, annotations, annotationRevision, annotator])

  const setAnnsAndDirty = useCallback(fn => { setAnnotations(fn); setDirty(true) }, [])

  // ── Delete / Edit annotations ──────────────────────────────────────────────
  const deleteAnnotation = useCallback((id) => {
    setAnnsAndDirty(prev => prev.filter(a => a.id !== id))
    setSelectedId(prev => prev === id ? null : prev)
  }, [setAnnsAndDirty])

  const deleteSelected = useCallback(() => {
    if (selectedId) deleteAnnotation(selectedId)
  }, [selectedId, deleteAnnotation])

  const handleEditAnnotation = useCallback((id) => {
    const ann = annotations.find(a => a.id === id)
    if (!ann) return
    const newLabel = window.prompt(
      ann.type === 'text' ? 'Edit text:' : 'Edit label/note:',
      ann.label || ''
    )
    if (newLabel == null) return
    setAnnsAndDirty(prev => prev.map(a => a.id === id ? { ...a, label: newLabel } : a))
  }, [annotations, setAnnsAndDirty])

  // ── Keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') { setActiveTool('select'); setSelectedId(null) }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) deleteSelected()
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveAnnotations() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, deleteSelected, saveAnnotations])

  useEffect(() => {
    const onBeforeUnload = e => {
      if (!dirty) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // ── Channel settings persistence ───────────────────────────────────────────
  useEffect(() => {
    if (chSettings.length > 0)
      localStorage.setItem(`agh-ch-${caseId}-${filename}`, JSON.stringify(chSettings))
  }, [chSettings, caseId, filename])

  // ── Annotator name persistence ─────────────────────────────────────────────
  useEffect(() => { localStorage.setItem('annotatorName', annotator) }, [annotator])

  // ── Pan / Zoom ─────────────────────────────────────────────────────────────
  const handleWheel = useCallback(e => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    const rect = viewportRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setScale(s => Math.max(0.05, Math.min(40, s * factor)))
    setTx(x => mx - (mx - x) * factor)
    setTy(y => my - (my - y) * factor)
  }, [])

  const handleMouseDown = useCallback(e => {
    if (activeTool !== 'select') return
    if (e.button !== 0) return
    dragRef.current = { startX: e.clientX - tx, startY: e.clientY - ty }
  }, [activeTool, tx, ty])

  const handleMouseMove = useCallback(e => {
    if (!dragRef.current) return
    setTx(e.clientX - dragRef.current.startX)
    setTy(e.clientY - dragRef.current.startY)
  }, [])

  const handleMouseUp = useCallback(() => { dragRef.current = null }, [])

  const updateCh = useCallback((i, patch) => {
    setChSettings(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s))
  }, [])

  // ── PDF Export ─────────────────────────────────────────────────────────────
  const exportPDF = useCallback(async (withAnnotations) => {
    setExporting(true)
    try {
      const target = withAnnotations
        ? viewportRef.current.querySelector('.inner-content')
        : canvasRef.current
      const cvs = await html2canvas(target, { useCORS: true, scale: 1, backgroundColor: null })
      const imgData = cvs.toDataURL('image/jpeg', 0.92)
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'px', format: [cvs.width, cvs.height] })
      pdf.addImage(imgData, 'JPEG', 0, 0, cvs.width, cvs.height)

      if (withAnnotations && annotations.length) {
        pdf.addPage()
        pdf.setFontSize(10)
        pdf.text('Annotations', 20, 20)
        annotations.forEach((a, i) => {
          const ts = a.timestamp ? new Date(a.timestamp).toLocaleString() : ''
          pdf.text(`${i+1}. [${a.type}] ${a.label || ''} — ${a.annotator || 'unknown'} @ ${ts}`, 20, 35 + i * 14)
        })
      }

      const safeName = filename.replace(/\.[^.]+$/, '')
      pdf.save(`${safeName}${withAnnotations ? '_annotated' : ''}.pdf`)
    } finally {
      setExporting(false)
    }
  }, [filename, annotations])

  const selectedAnn     = annotations.find(a => a.id === selectedId)
  const displayFontSize = selectedAnn?.type === 'text' ? (selectedAnn.fontSize || fontSize) : fontSize
  const isDrawTool = activeTool !== 'select'
  const transform  = `translate(${tx}px, ${ty}px) scale(${scale})`
  const requestClose = () => {
    if (dirty && !window.confirm('Discard unsaved annotations?')) return
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex bg-[#080810]">
      {/* ── Left toolbar ─────────────────────────────────────────────────────── */}
      <div className="w-12 flex-shrink-0 flex flex-col items-center py-3 gap-1 bg-[#111122] border-r border-[#223]">
        {TOOLS.map(({ id, icon: Icon, label }) => (
          <button key={id} title={label} onClick={() => setActiveTool(id)}
            className={`w-9 h-9 flex items-center justify-center rounded transition-colors
              ${activeTool === id ? 'bg-[#e94560] text-white' : 'text-gray-400 hover:bg-[#223] hover:text-white'}`}>
            <Icon size={16} />
          </button>
        ))}
        <div className="mt-2 border-t border-[#223] w-8" />
        {COLORS.map(c => (
          <button key={c} title={c} onClick={() => {
            setAnnColor(c)
            if (selectedId) setAnnsAndDirty(prev => prev.map(a => a.id === selectedId ? { ...a, color: c } : a))
          }}
            className={`w-6 h-6 rounded-full border-2 transition-all ${annColor === c ? 'border-white scale-110' : 'border-transparent'}`}
            style={{ background: c }} />
        ))}
        {/* ── Font size control (for text tool) ─────────────────────── */}
        <div className="mt-2 border-t border-[#223] w-8" />
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[9px] text-gray-500 uppercase tracking-wide">Size</span>
          <span className="text-[11px] font-mono text-gray-200 w-8 text-center">{displayFontSize}</span>
          <button onClick={() => {
            if (selectedAnn?.type === 'text') setAnnsAndDirty(prev => prev.map(a => a.id === selectedId ? { ...a, fontSize: Math.min(200, (a.fontSize || fontSize) + 2) } : a))
            else setFontSize(s => Math.min(200, s + 2))
          }} className="w-7 h-5 flex items-center justify-center rounded text-[10px] font-bold text-gray-400 hover:bg-[#223] hover:text-white transition-colors">+</button>
          <button onClick={() => {
            if (selectedAnn?.type === 'text') setAnnsAndDirty(prev => prev.map(a => a.id === selectedId ? { ...a, fontSize: Math.max(8, (a.fontSize || fontSize) - 2) } : a))
            else setFontSize(s => Math.max(8, s - 2))
          }} className="w-7 h-5 flex items-center justify-center rounded text-[10px] font-bold text-gray-400 hover:bg-[#223] hover:text-white transition-colors">−</button>
        </div>
        {selectedId && (
          <>
            <div className="mt-2 border-t border-[#223] w-8" />
            <button title="Delete selected (Del)" onClick={deleteSelected}
              className="w-9 h-9 flex items-center justify-center rounded text-red-400 hover:bg-red-900/40 transition-colors">
              <Trash2 size={16} />
            </button>
          </>
        )}
      </div>

      {/* ── Viewport ──────────────────────────────────────────────────────────── */}
      <div ref={viewportRef}
        className={`flex-1 overflow-hidden relative ${isDrawTool ? 'tool-draw' : ''}`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <div className="inner-content" style={{ position: 'absolute', transform, transformOrigin: '0 0' }}>
          <div style={{ position: 'relative' }} className="viewer-canvas-container">
            {loadError && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 text-sm text-red-300 px-6 text-center">
                {loadError}
              </div>
            )}
            <MultiChannelCanvas
              caseId={caseId} filename={filename}
              settings={chSettings} imgMeta={imgMeta}
              canvasRef={canvasRef}
            />
            {imgMeta && (
              <AnnotationLayer
                svgRef={svgRef} imgMeta={imgMeta}
                annotations={annotations} setAnnotations={setAnnsAndDirty}
                activeTool={activeTool}
                annotatorName={annotator}
                annotationColor={annColor}
                fontSize={fontSize}
                selectedId={selectedId} setSelectedId={setSelectedId}
                onEditAnnotation={handleEditAnnotation}
              />
            )}
          </div>
        </div>

        {/* Filename badge */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] text-gray-500 bg-black/60 px-2 py-1 rounded pointer-events-none max-w-[80%] text-center truncate">
          {caseId} / {filename}
        </div>
      </div>

      {/* ── Right sidebar ─────────────────────────────────────────────────────── */}
      <div className="w-56 flex-shrink-0 bg-[#111122] border-l border-[#223] flex flex-col overflow-y-auto">
        {/* Annotator */}
        <div className="px-3 pt-3 pb-2 border-b border-[#223]">
          <div className="flex items-center gap-2 mb-1">
            <User size={12} className="text-gray-500" />
            <span className="text-[10px] uppercase text-gray-500 tracking-wide">Annotator</span>
          </div>
          <input value={annotator} onChange={e => setAnnotator(e.target.value)}
            placeholder="Your name…"
            className="w-full bg-[#0d0d1a] border border-[#334] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:border-[#e94560]" />
        </div>

        {/* Channel controls */}
        <div className="px-3 py-3 flex-1">
          <p className="text-[10px] uppercase text-gray-500 tracking-wide mb-2">Channels</p>
          <ChannelControls settings={chSettings} onChange={updateCh} numChannels={imgMeta?.numChannels ?? 0} />
        </div>

        {/* ── Annotations list panel ──────────────────────────────────── */}
        <div className="border-t border-[#223]">
          <button onClick={() => setShowAnnPanel(p => !p)}
            className="w-full flex items-center justify-between px-3 py-2 text-[10px] uppercase text-gray-500 tracking-wide hover:text-gray-300 transition-colors">
            <span className="flex items-center gap-1.5">
              <List size={10} />
              Annotations ({annotations.length})
            </span>
            {showAnnPanel ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </button>
          {showAnnPanel && (
            <div className="max-h-44 overflow-y-auto px-2 pb-2 space-y-0.5">
              {annotations.length === 0 ? (
                <p className="text-[10px] text-gray-600 text-center py-2 italic">No annotations yet</p>
              ) : annotations.map(a => (
                <div key={a.id}
                  onClick={() => setSelectedId(a.id === selectedId ? null : a.id)}
                  className={`flex items-center gap-1.5 rounded px-2 py-1.5 cursor-pointer text-[10px] group transition-colors
                    ${a.id === selectedId ? 'bg-[#e94560]/25 text-white' : 'text-gray-400 hover:bg-[#1e1e3a]'}`}>
                  <span className="w-2 h-2 rounded-full flex-shrink-0 ring-1 ring-white/20" style={{ background: a.color }} />
                  <span className="flex-1 min-w-0 truncate">{a.type}{a.label ? `: ${a.label}` : ''}</span>
                  <button title="Edit" onClick={e => { e.stopPropagation(); handleEditAnnotation(a.id) }}
                    className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-blue-400 p-0.5 flex-shrink-0 transition-opacity">
                    <Pencil size={9} />
                  </button>
                  <button title="Delete" onClick={e => { e.stopPropagation(); deleteAnnotation(a.id) }}
                    className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 p-0.5 flex-shrink-0 transition-opacity">
                    <Trash2 size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-3 py-3 border-t border-[#223] flex flex-col gap-2">
          <button onClick={saveAnnotations} disabled={!dirty || saving}
            className={`flex items-center justify-center gap-2 px-3 py-2 rounded text-xs font-medium transition-colors w-full
              ${dirty && !saving ? 'bg-[#0f3460] hover:bg-[#1a4a80] text-white' : 'bg-[#111] text-gray-600 cursor-not-allowed'}`}>
            <Save size={13} /> {saving ? 'Saving...' : dirty ? 'Save Annotations' : 'Saved'}
          </button>
          {saveError && <p className="text-[10px] text-red-300 leading-snug">{saveError}</p>}
          <button onClick={() => exportPDF(true)} disabled={exporting}
            className="flex items-center justify-center gap-2 px-3 py-2 rounded text-xs font-medium bg-[#e94560]/20 hover:bg-[#e94560]/40 text-[#e94560] transition-colors w-full">
            <Download size={13} /> Export with annotations
          </button>
          <button onClick={() => exportPDF(false)} disabled={exporting}
            className="flex items-center justify-center gap-2 px-3 py-2 rounded text-xs font-medium bg-[#223] hover:bg-[#334] text-gray-300 transition-colors w-full">
            <Download size={13} /> Export image only
          </button>
          <p className="text-[9px] text-gray-600 text-center">Ctrl+S to save · Del to remove</p>
        </div>

        {/* Version / About */}
        <div className="px-3 py-2 border-t border-[#223] flex items-center justify-between">
          <span className="text-[9px] text-gray-600 font-mono">v0.1</span>
          <button onClick={() => setShowAbout(true)}
            className="flex items-center gap-1 text-[9px] text-gray-600 hover:text-gray-300 transition-colors">
            <Info size={9} /> About
          </button>
        </div>
      </div>

      {/* ── About modal ───────────────────────────────────────────────────────── */}
      {showAbout && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
          onClick={() => setShowAbout(false)}>
          <div className="bg-[#111122] border border-[#334] rounded-xl p-6 w-80 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-white">AGH Image Viewer</h2>
                <span className="text-[10px] text-[#e94560] font-mono">v0.1</span>
              </div>
              <button onClick={() => setShowAbout(false)}
                className="text-gray-500 hover:text-white transition-colors">
                <X size={14} />
              </button>
            </div>
            <div className="space-y-3 text-[11px] text-gray-400 leading-relaxed">
              <p>
                Hosted by{' '}
                <span className="text-gray-200 font-medium">Magnify Biosciences Inc.</span>
              </p>
              <div>
                <p className="text-[10px] uppercase text-gray-600 tracking-wide mb-1">Credits</p>
                <p><span className="text-gray-200">Ha Vo</span><br />
                  <span className="text-gray-500">Carnegie Mellon University</span>
                </p>
                <p className="mt-1.5"><span className="text-gray-200">Yongxin Zhao</span><br />
                  <span className="text-gray-500">Carnegie Mellon University / Magnify Biosciences</span>
                </p>
              </div>
            </div>
            <button onClick={() => setShowAbout(false)}
              className="mt-5 w-full py-1.5 rounded text-[11px] text-gray-400 bg-[#1e1e3a] hover:bg-[#2a2a4a] transition-colors">
              Close
            </button>
          </div>
        </div>
      )}

      {/* ── Close button ──────────────────────────────────────────────────────── */}
      <button onClick={requestClose}
        className="absolute top-3 right-60 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-[#111122] border border-[#334] text-gray-400 hover:text-white hover:border-[#e94560] transition-colors">
        <X size={14} />
      </button>
    </div>
  )
}
