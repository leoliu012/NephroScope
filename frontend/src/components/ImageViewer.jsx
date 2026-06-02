import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  X,
  Save,
  Download,
  MousePointer,
  Circle,
  Minus,
  Square,
  Ellipsis,
  PenLine,
  Type,
  ArrowRight,
  Trash2,
  User,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Pencil,
  List,
  Info,
  Eye,
  Activity,
  MessageSquare,
  Upload,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { jsPDF } from 'jspdf'
import html2canvas from 'html2canvas'
import MultiChannelCanvas from './MultiChannelCanvas.jsx'
import AnnotationLayer from './AnnotationLayer.jsx'
import ChannelControls from './ChannelControls.jsx'
import AnalysisPanel from './AnalysisPanel.jsx'
import AnalysisMaskCanvas from './AnalysisMaskCanvas.jsx'
import AnalysisVectorOverlay from './AnalysisVectorOverlay.jsx'
import { defaultChannelMapping, normalizeChannelMapping, roleInfo } from '../channelMapping.js'

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

const SIDEBAR_TABS = [
  { id: 'view', label: 'View', icon: Eye },
  { id: 'analyze', label: 'Analyze', icon: Activity },
  { id: 'annotate', label: 'Annotate', icon: MessageSquare },
  { id: 'export', label: 'Export', icon: Upload },
]

function defaultChSettings(n) {
  return Array.from({ length: n }, () => ({ enabled: true, minVal: 0, maxVal: 255 }))
}

function rectAnnotationToRoi(annotation) {
  if (!annotation || annotation.type !== 'rect') return null
  const [x1, y1, x2, y2] = annotation.coords || []
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  const width = Math.abs(x2 - x1)
  const height = Math.abs(y2 - y1)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
  return body
}

export default function ImageViewer({ caseId, filename, onClose, files = [], onNavigateFile }) {
  // Image metadata
  const [imgMeta, setImgMeta]           = useState(null)
  // Channel display settings [{enabled, minVal, maxVal}]
  const [chSettings, setChSettings]     = useState([])
  const [channelMapping, setChannelMapping] = useState([])
  // Pan/zoom
  const [tx, setTx]                     = useState(0)
  const [ty, setTy]                     = useState(0)
  const [scale, setScale]               = useState(1)
  const [spacePan, setSpacePan]         = useState(false)
  // Annotations
  const [annotations, setAnnotations]   = useState([])
  const [selectedId, setSelectedId]     = useState(null)
  const [dirty, setDirty]               = useState(false)
  const [annotationRevision, setAnnotationRevision] = useState(0)
  const [loadError, setLoadError]       = useState(null)
  const [saveError, setSaveError]       = useState(null)
  const [saving, setSaving]             = useState(false)
  const [lastSavedAt, setLastSavedAt]   = useState(null)
  // Tools
  const [activeTool, setActiveTool]     = useState('select')
  const [annColor, setAnnColor]         = useState('#ffee55')
  const [fontSize, setFontSize]         = useState(18)
  const [annotator, setAnnotator]       = useState(() => localStorage.getItem('annotatorName') || '')
  // Annotations panel
  const [showAnnPanel, setShowAnnPanel] = useState(true)
  const [sidebarTab, setSidebarTab]     = useState('view')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // About modal
  const [showAbout, setShowAbout]       = useState(false)
  // Export
  const [exporting, setExporting]       = useState(false)
  // MagnifySeg analysis
  const [analysisRun, setAnalysisRun]   = useState(null)
  const [visibleAnalysisOverlays, setVisibleAnalysisOverlays] = useState({})
  const [visibleAnalysisVectors, setVisibleAnalysisVectors] = useState({ thickness: true, process: true })
  const [thicknessMetric, setThicknessMetric] = useState(null)
  const [processMetric, setProcessMetric] = useState(null)

  const canvasRef   = useRef(null)
  const svgRef      = useRef(null)
  const viewportRef = useRef(null)
  const innerRef    = useRef(null)
  const dragRef     = useRef(null)
  const panRafRef   = useRef(null)
  const undoStackRef = useRef([])
  const redoStackRef = useRef([])

  const fitToViewport = useCallback((meta) => {
    if (!meta || !viewportRef.current) return
    const rect = viewportRef.current.getBoundingClientRect()
    const s = Math.min(rect.width / meta.width, rect.height / meta.height, 1) * 0.92
    setScale(s)
    setTx((rect.width - meta.width * s) / 2)
    setTy((rect.height - meta.height * s) / 2)
  }, [])

  const setActualSize = useCallback(() => {
    if (!imgMeta || !viewportRef.current) return
    const rect = viewportRef.current.getBoundingClientRect()
    setScale(1)
    setTx((rect.width - imgMeta.width) / 2)
    setTy((rect.height - imgMeta.height) / 2)
  }, [imgMeta])

  const zoomAroundCenter = useCallback((factor) => {
    if (!viewportRef.current) return
    const rect = viewportRef.current.getBoundingClientRect()
    const mx = rect.width / 2
    const my = rect.height / 2
    setScale(s => Math.max(0.05, Math.min(40, s * factor)))
    setTx(x => mx - (mx - x) * factor)
    setTy(y => my - (my - y) * factor)
  }, [])

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
        const savedMapping = localStorage.getItem(`agh-channel-map-${caseId}`)
        let mapping = defaultChannelMapping(meta.numChannels)
        if (savedMapping) {
          try { mapping = normalizeChannelMapping(JSON.parse(savedMapping), meta.numChannels) } catch {}
        }
        setChannelMapping(mapping)
        window.requestAnimationFrame(() => fitToViewport(meta))
      })
      .catch(err => { if (err.name !== 'AbortError') setLoadError(err.message) })
    return () => controller.abort()
  }, [caseId, filename, fitToViewport])

  // ── Load annotations ───────────────────────────────────────────────────────
  useEffect(() => {
    const controller = new AbortController()
    fetchJson(`${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/annotations`, { signal: controller.signal })
      .then(d => {
        setAnnotations(d.annotations || [])
        setAnnotationRevision(d.revision || 0)
        setDirty(false)
        setLastSavedAt(null)
        undoStackRef.current = []
        redoStackRef.current = []
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
      setLastSavedAt(new Date())
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }, [caseId, filename, annotations, annotationRevision, annotator])

  const setAnnsAndDirty = useCallback(fn => {
    setAnnotations(prev => {
      const next = typeof fn === 'function' ? fn(prev) : fn
      if (next === prev) return prev
      undoStackRef.current = [...undoStackRef.current.slice(-49), prev]
      redoStackRef.current = []
      setDirty(true)
      setSaveError(null)
      return next
    })
  }, [])

  const undoAnnotations = useCallback(() => {
    setAnnotations(prev => {
      const previous = undoStackRef.current.pop()
      if (!previous) return prev
      redoStackRef.current = [...redoStackRef.current.slice(-49), prev]
      setDirty(true)
      return previous
    })
  }, [])

  const redoAnnotations = useCallback(() => {
    setAnnotations(prev => {
      const next = redoStackRef.current.pop()
      if (!next) return prev
      undoStackRef.current = [...undoStackRef.current.slice(-49), prev]
      setDirty(true)
      return next
    })
  }, [])

  // ── Delete / Edit annotations ──────────────────────────────────────────────
  const deleteAnnotation = useCallback((id) => {
    setAnnsAndDirty(prev => prev.filter(a => a.id !== id))
    setSelectedId(prev => prev === id ? null : prev)
  }, [setAnnsAndDirty])

  const deleteSelected = useCallback(() => {
    if (selectedId) deleteAnnotation(selectedId)
  }, [selectedId, deleteAnnotation])

  const handleEditAnnotation = useCallback((id) => {
    setSelectedId(id)
    setSidebarTab('annotate')
    setSidebarCollapsed(false)
  }, [])

  const currentFileIndex = useMemo(() => files.findIndex(item => item === filename), [files, filename])
  const previousFile = currentFileIndex > 0 ? files[currentFileIndex - 1] : null
  const nextFile = currentFileIndex >= 0 && currentFileIndex < files.length - 1 ? files[currentFileIndex + 1] : null
  const navigateFile = useCallback((target) => {
    if (!target || !onNavigateFile) return
    onNavigateFile(target)
  }, [onNavigateFile])

  // ── Keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const isEditingTarget = target => {
      const tag = target?.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable
    }
    const onKey = e => {
      const key = e.key.toLowerCase()
      const command = e.ctrlKey || e.metaKey

      if (command && key === 's') {
        e.preventDefault()
        saveAnnotations()
        return
      }
      if (command && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redoAnnotations()
        else undoAnnotations()
        return
      }
      if (isEditingTarget(e.target)) return

      if (e.code === 'Space') {
        e.preventDefault()
        setSpacePan(true)
        return
      }
      if (e.key === 'Escape') { setActiveTool('select'); setSelectedId(null) }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) deleteSelected()
      if (key === 'f') fitToViewport(imgMeta)
      if (key === '0') setActualSize()
      if (key === '=' || key === '+') zoomAroundCenter(1.18)
      if (key === '-') zoomAroundCenter(1 / 1.18)
      if (e.key === 'ArrowLeft' && previousFile) navigateFile(previousFile)
      if (e.key === 'ArrowRight' && nextFile) navigateFile(nextFile)
    }
    const onKeyUp = e => {
      if (e.code === 'Space') setSpacePan(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [
    selectedId,
    deleteSelected,
    saveAnnotations,
    undoAnnotations,
    redoAnnotations,
    fitToViewport,
    setActualSize,
    zoomAroundCenter,
    imgMeta,
    previousFile,
    nextFile,
    navigateFile,
  ])

  useEffect(() => {
    const onBeforeUnload = e => {
      if (!dirty) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  useEffect(() => {
    if (!dirty || saving || saveError) return
    const id = window.setTimeout(() => { saveAnnotations() }, 1000)
    return () => window.clearTimeout(id)
  }, [dirty, saving, saveError, saveAnnotations])

  // ── Channel settings persistence ───────────────────────────────────────────
  useEffect(() => {
    if (chSettings.length > 0)
      localStorage.setItem(`agh-ch-${caseId}-${filename}`, JSON.stringify(chSettings))
  }, [chSettings, caseId, filename])

  useEffect(() => {
    if (channelMapping.length > 0)
      localStorage.setItem(`agh-channel-map-${caseId}`, JSON.stringify(channelMapping))
  }, [channelMapping, caseId])

  // ── Annotator name persistence ─────────────────────────────────────────────
  useEffect(() => { localStorage.setItem('annotatorName', annotator) }, [annotator])

  useEffect(() => {
    if (!imgMeta) return
    const id = window.setTimeout(() => fitToViewport(imgMeta), 0)
    return () => window.clearTimeout(id)
  }, [sidebarCollapsed, imgMeta, fitToViewport])

  // ── Pan / Zoom ─────────────────────────────────────────────────────────────
  const handleWheel = useCallback(e => {
    e.preventDefault()
    if (e.shiftKey) {
      setTx(x => x - e.deltaY)
      return
    }
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    const rect = viewportRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setScale(s => Math.max(0.05, Math.min(40, s * factor)))
    setTx(x => mx - (mx - x) * factor)
    setTy(y => my - (my - y) * factor)
  }, [])

  const handleMouseDown = useCallback(e => {
    if (activeTool !== 'select' && !spacePan) return
    if (e.button !== 0) return
    dragRef.current = { startX: e.clientX - tx, startY: e.clientY - ty }
  }, [activeTool, spacePan, tx, ty])

  const handleMouseMove = useCallback(e => {
    if (!dragRef.current) return
    const nextTx = e.clientX - dragRef.current.startX
    const nextTy = e.clientY - dragRef.current.startY
    if (panRafRef.current) window.cancelAnimationFrame(panRafRef.current)
    panRafRef.current = window.requestAnimationFrame(() => {
      setTx(nextTx)
      setTy(nextTy)
      panRafRef.current = null
    })
  }, [])

  const handleMouseUp = useCallback(() => {
    dragRef.current = null
    if (panRafRef.current) {
      window.cancelAnimationFrame(panRafRef.current)
      panRafRef.current = null
    }
  }, [])

  const updateCh = useCallback((i, patch) => {
    setChSettings(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s))
  }, [])

  const updateChannelRole = useCallback((channelIndex, role) => {
    setChannelMapping(prev => prev.map(item => {
      if (item.channel === channelIndex) return { ...item, role }
      if (role !== 'unassigned' && item.role === role) return { ...item, role: 'unassigned' }
      return item
    }))
  }, [])

  const setRoleChannel = useCallback((role, channelIndex) => {
    setChannelMapping(prev => prev.map(item => {
      if (item.channel === channelIndex) return { ...item, role }
      if (item.role === role) return { ...item, role: 'unassigned' }
      return item
    }))
  }, [])

  const updateSelectedAnnotation = useCallback((patch) => {
    if (!selectedId) return
    setAnnsAndDirty(prev => prev.map(a => a.id === selectedId ? { ...a, ...patch } : a))
  }, [selectedId, setAnnsAndDirty])

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
          pdf.text(`${i+1}. [${a.type}] ${a.label || ''} - ${a.annotator || 'unknown'} @ ${ts}`, 20, 35 + i * 14)
        })
      }

      const safeName = filename.replace(/\.[^.]+$/, '')
      pdf.save(`${safeName}${withAnnotations ? '_annotated' : ''}.pdf`)
    } finally {
      setExporting(false)
    }
  }, [filename, annotations])

  const selectedAnn = annotations.find(a => a.id === selectedId)
  const analysisRoi = rectAnnotationToRoi(selectedAnn)
  const displayFontSize = selectedAnn?.type === 'text' ? (selectedAnn.fontSize || fontSize) : fontSize
  const isDrawTool = activeTool !== 'select' && !spacePan
  const transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  const zoomLabel = `${Math.round(scale * 100)}%`
  const saveLabel = saving
    ? 'Saving...'
    : dirty
      ? 'Unsaved changes'
      : lastSavedAt
        ? 'Saved just now'
        : 'Saved'
  const activeMappedChannels = channelMapping.filter(item => item.role !== 'unassigned')
  const requestClose = () => {
    if (dirty && !window.confirm('Discard unsaved annotations?')) return
    onClose()
  }

  return (
    <div className="viewer-shell fixed inset-0 z-50 flex">
      <div className="viewer-tool-rail w-12 flex-shrink-0 flex flex-col items-center gap-1 border-r py-3">
        {TOOLS.map(({ id, icon: Icon, label }) => (
          <button key={id} title={label} onClick={() => setActiveTool(id)}
            className={`ux-tool-button ${activeTool === id ? 'ux-tool-button-active' : ''}`}>
            <Icon size={16} />
          </button>
        ))}
        <div className="ux-divider mt-2 h-px w-8" />
        {COLORS.map(c => (
          <button key={c} title={c} onClick={() => {
            setAnnColor(c)
            if (selectedId) setAnnsAndDirty(prev => prev.map(a => a.id === selectedId ? { ...a, color: c } : a))
          }}
            className={`w-6 h-6 rounded-full border-2 transition-all ${annColor === c ? 'border-white scale-110' : 'border-transparent'}`}
            style={{ background: c }} />
        ))}
        <div className="ux-divider mt-2 h-px w-8" />
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[9px] text-gray-500 uppercase tracking-wide">Size</span>
          <span className="text-[11px] font-mono text-gray-200 w-8 text-center">{displayFontSize}</span>
          <button onClick={() => {
            if (selectedAnn?.type === 'text') setAnnsAndDirty(prev => prev.map(a => a.id === selectedId ? { ...a, fontSize: Math.min(200, (a.fontSize || fontSize) + 2) } : a))
            else setFontSize(s => Math.min(200, s + 2))
          }} className="ux-icon-button h-5 w-7 text-[10px] font-bold">+</button>
          <button onClick={() => {
            if (selectedAnn?.type === 'text') setAnnsAndDirty(prev => prev.map(a => a.id === selectedId ? { ...a, fontSize: Math.max(8, (a.fontSize || fontSize) - 2) } : a))
            else setFontSize(s => Math.max(8, s - 2))
          }} className="ux-icon-button h-5 w-7 text-[10px] font-bold">-</button>
        </div>
        {selectedId && (
          <>
            <div className="ux-divider mt-2 h-px w-8" />
            <button title="Delete selected (Del)" onClick={deleteSelected}
              className="ux-tool-button text-[var(--danger)] hover:bg-[var(--danger-soft)]">
              <Trash2 size={16} />
            </button>
          </>
        )}
      </div>

      <div ref={viewportRef}
        className={`flex-1 overflow-hidden relative ${isDrawTool ? 'tool-draw' : ''} ${spacePan ? 'tool-pan' : ''}`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <div className="absolute top-3 left-3 right-3 z-20 pointer-events-none">
          <div className="viewer-commandbar pointer-events-auto flex items-center gap-1.5 px-2 py-2">
            <button onClick={requestClose}
              className="ux-button ux-button-ghost">
              <ChevronLeft size={14} />
              Back
            </button>
            <div className="min-w-0 flex-1 px-2">
              <p className="truncate text-xs text-gray-200">{caseId} / {filename}</p>
            </div>
            <button onClick={() => navigateFile(previousFile)} disabled={!previousFile}
              className="ux-button ux-button-ghost">
              <ChevronLeft size={14} />
              Previous
            </button>
            <button onClick={() => navigateFile(nextFile)} disabled={!nextFile}
              className="ux-button ux-button-ghost">
              Next
              <ChevronRight size={14} />
            </button>
            <div className="ux-divider mx-1 h-5 w-px" />
            <button onClick={() => fitToViewport(imgMeta)}
              className="ux-button ux-button-ghost">
              <RotateCcw size={13} />
              Fit
            </button>
            <button onClick={setActualSize}
              className="ux-button ux-button-ghost font-mono">
              {zoomLabel}
            </button>
            <button onClick={() => zoomAroundCenter(1 / 1.18)}
              className="ux-icon-button"
              title="Zoom out">
              <ZoomOut size={13} />
            </button>
            <button onClick={() => zoomAroundCenter(1.18)}
              className="ux-icon-button"
              title="Zoom in">
              <ZoomIn size={13} />
            </button>
            <div className="ux-divider mx-1 h-5 w-px" />
            <span className={`ux-badge ${dirty ? 'ux-badge-warning' : 'ux-badge-success'}`}>
              {saveLabel}
            </span>
            <button
              onClick={() => {
                setSidebarCollapsed(value => !value)
                window.requestAnimationFrame(() => fitToViewport(imgMeta))
              }}
              className="ux-icon-button"
              title={sidebarCollapsed ? 'Show sidebar' : 'Collapse sidebar'}
            >
              {sidebarCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
            </button>
          </div>
        </div>

        <div ref={innerRef} className="inner-content" style={{ position: 'absolute', transform, transformOrigin: '0 0' }}>
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
            <AnalysisMaskCanvas
              run={analysisRun}
              visibleOverlays={visibleAnalysisOverlays}
              processMetric={processMetric}
              imgMeta={imgMeta}
            />
            <AnalysisVectorOverlay
              imgMeta={imgMeta}
              thickness={thicknessMetric}
              processMetric={processMetric}
              showThickness={visibleAnalysisVectors.thickness !== false}
              showProcess={visibleAnalysisVectors.process !== false}
            />
            {imgMeta && (
              <AnnotationLayer
                svgRef={svgRef} imgMeta={imgMeta}
                annotations={annotations} setAnnotations={setAnnsAndDirty}
                activeTool={activeTool}
                panActive={spacePan}
                annotatorName={annotator}
                annotationColor={annColor}
                fontSize={fontSize}
                selectedId={selectedId} setSelectedId={setSelectedId}
                onEditAnnotation={handleEditAnnotation}
              />
            )}
          </div>
        </div>
      </div>

      {!sidebarCollapsed && (
        <aside className="viewer-inspector w-80 flex-shrink-0 border-l flex flex-col min-h-0">
          <div className="viewer-inspector-tabs px-3 py-2 border-b flex items-center gap-1">
            {SIDEBAR_TABS.map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setSidebarTab(id)}
                className={`ux-tab flex-1 min-w-0 ${sidebarTab === id ? 'ux-tab-active' : ''}`}>
                <Icon size={12} />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {sidebarTab === 'view' && (
              <div className="px-3 py-3 space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="ux-section-label">Channel mapping</p>
                    <button onClick={() => setChannelMapping(defaultChannelMapping(imgMeta?.numChannels || 0))}
                      className="ux-button ux-button-ghost min-h-0 px-1 py-0 text-[10px]">
                      Reset
                    </button>
                  </div>
                  {activeMappedChannels.length ? (
                    <div className="space-y-1">
                      {activeMappedChannels.map(item => {
                        const info = roleInfo(item.role)
                        return (
                          <div key={item.channel} className="flex items-center gap-2 text-[11px] text-gray-300">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ background: info.color }} />
                            <span className="flex-1">{info.label}</span>
                            <span className="font-mono text-gray-500">Ch {item.channel}</span>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="text-[10px] text-gray-600">No mapped channels.</p>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="ux-section-label">Display</p>
                    <button onClick={() => setChSettings(defaultChSettings(imgMeta?.numChannels || 0))}
                      className="ux-button ux-button-ghost min-h-0 px-1 py-0 text-[10px]">
                      <RotateCcw size={10} />
                      Reset contrast
                    </button>
                  </div>
                  <ChannelControls
                    settings={chSettings}
                    onChange={updateCh}
                    numChannels={imgMeta?.numChannels ?? 0}
                    channelMapping={channelMapping}
                    onMappingChange={updateChannelRole}
                  />
                </div>
              </div>
            )}

            {sidebarTab === 'analyze' && (
              <AnalysisPanel
                caseId={caseId}
                filename={filename}
                imgMeta={imgMeta}
                channelMapping={channelMapping}
                onSetRoleChannel={setRoleChannel}
                analysisRoi={analysisRoi}
                run={analysisRun}
                setRun={setAnalysisRun}
                visibleOverlays={visibleAnalysisOverlays}
                setVisibleOverlays={setVisibleAnalysisOverlays}
                visibleVectors={visibleAnalysisVectors}
                setVisibleVectors={setVisibleAnalysisVectors}
                thickness={thicknessMetric}
                setThickness={setThicknessMetric}
                processMetric={processMetric}
                setProcessMetric={setProcessMetric}
              />
            )}

            {sidebarTab === 'annotate' && (
              <div className="px-3 py-3 space-y-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <User size={12} className="text-gray-500" />
                    <span className="ux-section-label">Annotator</span>
                  </div>
                  <input value={annotator} onChange={e => setAnnotator(e.target.value)}
                    placeholder="Your name..."
                    className="ux-input" />
                </div>

                <div className="ux-card p-3 space-y-2">
                  <p className="ux-section-label">Selected annotation</p>
                  {selectedAnn ? (
                    <>
                      <div className="grid grid-cols-2 gap-2 text-[10px] text-gray-500">
                        <span>Type</span>
                        <span className="text-right text-gray-200">{selectedAnn.type}</span>
                        <span>Color</span>
                        <span className="text-right">
                          <span className="inline-block w-3 h-3 rounded-full align-middle" style={{ background: selectedAnn.color }} />
                        </span>
                      </div>
                      <label className="block">
                        <span className="text-[10px] text-gray-500">{selectedAnn.type === 'text' ? 'Text' : 'Label / note'}</span>
                        <input
                          value={selectedAnn.label || ''}
                          onChange={e => updateSelectedAnnotation({ label: e.target.value })}
                          className="ux-input mt-1"
                        />
                      </label>
                      <button onClick={deleteSelected}
                        className="ux-button ux-button-danger w-full">
                        <Trash2 size={12} />
                        Delete annotation
                      </button>
                    </>
                  ) : (
                    <p className="text-[10px] text-gray-600">Select an annotation to edit details.</p>
                  )}
                </div>

                <div className="ux-card">
                  <button onClick={() => setShowAnnPanel(p => !p)}
                    className="w-full flex items-center justify-between px-3 py-2 text-[10px] uppercase text-gray-500 tracking-wide hover:text-gray-300 transition-colors">
                    <span className="flex items-center gap-1.5">
                      <List size={10} />
                      Annotations ({annotations.length})
                    </span>
                    {showAnnPanel ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                  </button>
                  {showAnnPanel && (
                    <div className="max-h-64 overflow-y-auto px-2 pb-2 space-y-0.5">
                      {annotations.length === 0 ? (
                        <p className="text-[10px] text-gray-600 text-center py-2 italic">No annotations yet</p>
                      ) : annotations.map(a => (
                        <div key={a.id}
                          onClick={() => setSelectedId(a.id === selectedId ? null : a.id)}
                          className={`flex items-center gap-1.5 rounded px-2 py-1.5 cursor-pointer text-[10px] group transition-colors
                            ${a.id === selectedId ? 'bg-[var(--accent-soft)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)]'}`}>
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

                <div className="flex flex-col gap-2">
                  <button onClick={saveAnnotations} disabled={!dirty || saving}
                    className={`ux-button w-full ${dirty && !saving ? 'ux-button-primary' : 'ux-button-secondary cursor-not-allowed opacity-50'}`}>
                    <Save size={13} /> {saving ? 'Saving...' : dirty ? 'Save Annotations' : 'Saved'}
                  </button>
                  {saveError && <p className="text-[10px] text-red-300 leading-snug">{saveError}</p>}
                  <p className="text-[9px] text-gray-600 text-center">Ctrl/Cmd+S save. Ctrl/Cmd+Z undo.</p>
                </div>
              </div>
            )}

            {sidebarTab === 'export' && (
              <div className="px-3 py-3 space-y-3">
                <button onClick={() => exportPDF(true)} disabled={exporting}
                  className="ux-button ux-button-primary w-full">
                  <Download size={13} /> Export annotated PDF
                </button>
                <button onClick={() => exportPDF(false)} disabled={exporting}
                  className="ux-button ux-button-secondary w-full">
                  <Download size={13} /> Export image only
                </button>
                {analysisRun?.result?.segmentations && (
                  <div className="ux-card p-3 space-y-2">
                    <p className="ux-section-label">Segmentation TIFF</p>
                    {Object.entries(analysisRun.result.segmentations).map(([model, artifact]) => (
                      <a key={model}
                        href={`${API}/analysis-runs/${encodeURIComponent(analysisRun.runId)}/artifacts/${encodeURIComponent(artifact)}`}
                        className="ux-button ux-button-secondary flex w-full justify-between text-[10px]">
                        <span className="truncate">{model}</span>
                        <Download size={10} />
                      </a>
                    ))}
                  </div>
                )}
                <div className="pt-2 border-t border-[var(--border)] flex items-center justify-between">
                  <span className="ux-meta font-mono">v0.1</span>
                  <button onClick={() => setShowAbout(true)}
                    className="flex items-center gap-1 text-[9px] text-gray-600 hover:text-gray-300 transition-colors">
                    <Info size={9} /> About
                  </button>
                </div>
              </div>
            )}
          </div>
        </aside>
      )}

      {showAbout && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
          onClick={() => setShowAbout(false)}>
          <div className="ux-card w-80 p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-white">AGH Image Viewer</h2>
                <span className="text-[10px] text-[var(--accent)] font-mono">v0.1</span>
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
                <p className="ux-section-label mb-1">Credits</p>
                <p><span className="text-gray-200">Ha Vo</span><br />
                  <span className="text-gray-500">Carnegie Mellon University</span>
                </p>
                <p className="mt-1.5"><span className="text-gray-200">Yongxin Zhao</span><br />
                  <span className="text-gray-500">Carnegie Mellon University / Magnify Biosciences</span>
                </p>
              </div>
            </div>
            <button onClick={() => setShowAbout(false)}
              className="ux-button ux-button-secondary mt-5 w-full">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}


