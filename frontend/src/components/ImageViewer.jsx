import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { v4 as uuidv4 } from 'uuid'
import {
  X,
  Download,
  MousePointer,
  Circle,
  Minus,
  Square,
  Ellipsis,
  PenLine,
  Type,
  ArrowRight,
  Hand,
  Trash2,
  User,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Pencil,
  List,
  Info,
  Keyboard,
  Maximize2,
  PanelRightClose,
  PanelRightOpen,
  ZoomIn,
  ZoomOut,
  Ruler,
  Settings,
} from 'lucide-react'
import { jsPDF } from 'jspdf'
import AnnotationLayer from './AnnotationLayer.jsx'
import ChannelControls from './ChannelControls.jsx'
import MultiChannelCanvas from './MultiChannelCanvas.jsx'
import ZSliceSlider, { zIndexForAnnotation } from './ZSliceSlider.jsx'
import { autoWindowChannelSettings, loadChannelSettings, normalizeChannelSettings, saveChannelSettings } from '../channelDisplay.js'
import { APP_NAME, APP_VERSION } from '../appInfo.js'
import {
  DEFAULT_EXPANSION_FACTOR,
  applyMeasurementSettings,
  formatMeasurement,
  formatPixelSize,
  formatPixelSizeInput,
} from '../measurement.js'
import { normalizeAnnotationForStorage, normalizedAnnotationType } from '../annotationTypes.js'
import { authFetch, currentProfile, currentUser, rememberProfile } from '../auth.js'
import { fetchViewState, updateViewState } from '../collaboration.js'

const API = '/agh/api'
const RESEARCH_USE_NOTICE = 'Research use only. Not validated for clinical diagnosis or treatment decisions.'

const TOOLS = [
  { id: 'select',   icon: MousePointer, label: 'Select' },
  { id: 'pan',      icon: Hand,         label: 'Pan - Hold Space' },
  { id: 'point',    icon: Circle,       label: 'Circle' },
  { id: 'line',     icon: Minus,        label: 'Line' },
  { id: 'measure',  icon: Ruler,        label: 'Measure distance' },
  { id: 'arrow',    icon: ArrowRight,   label: 'Arrow' },
  { id: 'rect',     icon: Square,       label: 'Rectangle' },
  { id: 'ellipse',  icon: Ellipsis,     label: 'Ellipse' },
  { id: 'freehand', icon: PenLine,      label: 'Freehand' },
  { id: 'text',     icon: Type,         label: 'Text' },
]

const ANNOTATION_TOOL_IDS = ['point', 'line', 'measure', 'arrow', 'rect', 'ellipse', 'freehand', 'text']
const COLORS = ['#000000','#ff4444','#44ff88','#44aaff','#ff44ff','#ffffff','#ff8800']
const MEASUREMENT_SETTINGS_STORAGE_PREFIX = 'agh-viewer:measurement-settings:v1:'

const KEYBOARD_SHORTCUTS = [
  { keys: ['F'], action: 'Fit image to window' },
  { keys: ['0'], action: 'Actual size (100%)' },
  { keys: ['+', '-'], action: 'Zoom in / out' },
  { keys: ['Space'], action: 'Hold to pan' },
  { keys: ['Left', 'Right'], action: 'Previous / next image' },
  { keys: ['Esc'], action: 'Deselect / return to Select tool' },
  { keys: ['Del'], action: 'Delete selected annotation' },
  { keys: ['Ctrl', 'S'], action: 'Save annotations' },
  { keys: ['Ctrl', 'Z'], action: 'Undo' },
  { keys: ['Ctrl', 'Shift', 'Z'], action: 'Redo' },
  { keys: ['Ctrl', 'C'], action: 'Copy selected annotation' },
  { keys: ['Ctrl', 'V'], action: 'Paste annotation' },
  { keys: ['Ctrl', 'X'], action: 'Cut selected annotation' },
  { keys: ['?'], action: 'Show this shortcut list' },
]

async function fetchJson(url, options = {}) {
  const res = await authFetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
  return body
}

function normalizeSidebarTab(value) {
  if (value === 'channels' || value === 'settings') return value
  return 'annotations'
}

function cleanDisplayName(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const withoutEmailDomain = raw.includes('@') ? raw.split('@')[0] : raw
  return withoutEmailDomain
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, letter => letter.toUpperCase())
}

function displayInitials(value) {
  const parts = cleanDisplayName(value).split(' ').filter(Boolean)
  if (!parts.length) return '?'
  return parts.slice(0, 2).map(part => part[0]).join('').toUpperCase()
}

function formatAnnotationTimestamp(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function measurementSettingsStorageKey(caseId, filename) {
  return `${MEASUREMENT_SETTINGS_STORAGE_PREFIX}${encodeURIComponent(caseId)}/${encodeURIComponent(filename)}`
}

function validPositiveInput(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? String(value) : fallback
}

const LOCAL_DEV_EXPANSION_CASES = new Set(['4', '5', '9'])
const LOCAL_DEV_EXPANSION_FACTOR = 7.23
const AUTO_UNEXPANDED_PIXEL_SIZE_UM = 0.015
const AUTO_UNEXPANDED_PIXEL_SIZE_TOLERANCE_UM = 0.001

function defaultExpansionFactor(caseId) {
  const match = String(caseId || '').match(/(?:^|\D)([459])(?:\D|$)/)
  return match && LOCAL_DEV_EXPANSION_CASES.has(match[1])
    ? LOCAL_DEV_EXPANSION_FACTOR
    : DEFAULT_EXPANSION_FACTOR
}

function isAutoUnexpandedPixelSize(meta) {
  const pixelSize = Number(meta?.pixelSizeXUm ?? meta?.pixelSizeUm)
  if (!Number.isFinite(pixelSize) || pixelSize <= 0) return false
  if (meta?.pixelSizeIsUserOverride || meta?.pixelSizeIsDefault !== false) return false
  return Math.abs(pixelSize - AUTO_UNEXPANDED_PIXEL_SIZE_UM) <= AUTO_UNEXPANDED_PIXEL_SIZE_TOLERANCE_UM
}

function defaultMeasurementSettings(meta, caseId) {
  return {
    pixelSizeUm: formatPixelSizeInput(meta),
    expansionEnabled: !isAutoUnexpandedPixelSize(meta),
    expansionFactor: String(defaultExpansionFactor(caseId)),
  }
}

function normalizeMeasurementSettings(raw, meta, caseId) {
  const fallback = defaultMeasurementSettings(meta, caseId)
  return {
    pixelSizeUm: validPositiveInput(raw?.pixelSizeUm, fallback.pixelSizeUm),
    expansionEnabled: typeof raw?.expansionEnabled === 'boolean' ? raw.expansionEnabled : fallback.expansionEnabled,
    expansionFactor: validPositiveInput(raw?.expansionFactor, fallback.expansionFactor),
  }
}

function clampZIndex(value, meta) {
  const count = Math.max(1, Number(meta?.zCount) || 1)
  const number = Math.round(Number(value) || 0)
  return Math.max(0, Math.min(count - 1, number))
}

function formatCacheEta(value) {
  const milliseconds = Number(value)
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 'calculating estimate'
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000))
  if (seconds < 60) return `about ${seconds}s left`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return remainingSeconds ? `about ${minutes}m ${remainingSeconds}s left` : `about ${minutes}m left`
}

function loadMeasurementSettings(caseId, filename, meta) {
  try {
    const saved = JSON.parse(localStorage.getItem(measurementSettingsStorageKey(caseId, filename)) || 'null')
    return normalizeMeasurementSettings(saved, meta, caseId)
  } catch {
    return defaultMeasurementSettings(meta, caseId)
  }
}

function saveMeasurementSettings(caseId, filename, settings) {
  try {
    localStorage.setItem(measurementSettingsStorageKey(caseId, filename), JSON.stringify(settings))
  } catch {
    // Measurement controls remain usable even when storage is unavailable.
  }
}

function cloneAnnotation(annotation) {
  return JSON.parse(JSON.stringify(annotation))
}

function offsetAnnotation(annotation, offset = 18) {
  const copy = cloneAnnotation(annotation)
  copy.coords = (copy.coords || []).map((value, index) => Number(value) + (index % 2 === 0 ? offset : offset))
  return copy
}

function nextFrame() {
  return new Promise(resolve => window.requestAnimationFrame(resolve))
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Unable to render annotations for export'))
    image.src = src
  })
}

async function annotationOverlayImage(svg, width, height) {
  if (!svg) return null
  const clone = svg.cloneNode(true)
  clone.querySelectorAll('.annotation-selection-overlay, .annotation-preview-overlay').forEach(node => node.remove())
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`)
  clone.style.position = ''
  clone.style.top = ''
  clone.style.left = ''
  clone.style.overflow = 'visible'
  clone.style.pointerEvents = 'none'

  const svgText = new XMLSerializer().serializeToString(clone)
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    return { image: await loadImage(url), url }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

async function exportCanvasFromViewer(sourceCanvas, svg, withAnnotations) {
  if (!sourceCanvas) throw new Error('Image is not ready to export')
  await nextFrame()

  const width = Number(sourceCanvas.width) || 1
  const height = Number(sourceCanvas.height) || 1
  const output = document.createElement('canvas')
  output.width = width
  output.height = height

  const context = output.getContext('2d', { alpha: false })
  if (!context) throw new Error('The browser could not create a PDF export canvas')
  context.imageSmoothingEnabled = false
  context.fillStyle = '#000'
  context.fillRect(0, 0, width, height)
  context.drawImage(sourceCanvas, 0, 0, width, height)

  if (withAnnotations) {
    const overlay = await annotationOverlayImage(svg, width, height)
    if (overlay) {
      try {
        context.drawImage(overlay.image, 0, 0, width, height)
      } finally {
        URL.revokeObjectURL(overlay.url)
      }
    }
  }

  return output
}

export default function ImageViewer({
  caseId,
  filename,
  onClose,
  files = [],
  onNavigateFile,
  initialTab = 'annotations',
  user = '',
  role = '',
  firstName = '',
  lastName = '',
  displayName = '',
  clientId = '',
  onProfileChange,
}) {
  const [imgMeta, setImgMeta] = useState(null)
  const [channelSettings, setChannelSettings] = useState(null)
  const [channelStats, setChannelStats] = useState(null)
  const [measurementSettings, setMeasurementSettings] = useState(null)
  const [zIndex, setZIndex] = useState(0)
  const [zDraftIndex, setZDraftIndex] = useState(0)
  const [sliceLoadState, setSliceLoadState] = useState({ status: 'idle', requestedZIndex: 0, displayedZIndex: null, loadedChannels: 0, channelCount: 0 })
  const [fullImageCacheRequest, setFullImageCacheRequest] = useState(0)
  const [fullImageCacheState, setFullImageCacheState] = useState({ status: 'idle', completedPlanes: 0, totalPlanes: 0, etaMs: 0, persistent: false, error: '' })
  const [viewStateRevision, setViewStateRevision] = useState(0)
  const [viewStateChangedBy, setViewStateChangedBy] = useState('')
  const autoWindowAppliedRef = useRef(false)
  const applyingRemoteViewStateRef = useRef(false)
  const suppressNextViewStatePublishRef = useRef(false)
  const viewStatePublishTimerRef = useRef(null)
  const [loadedImageKey, setLoadedImageKey] = useState(null)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const [scale, setScale] = useState(1)
  const [spacePan, setSpacePan] = useState(false)
  const [annotations, setAnnotations] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [annotationRevision, setAnnotationRevision] = useState(0)
  const [loadError, setLoadError] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState(null)
  const [activeTool, setActiveTool] = useState('select')
  const [annColor, setAnnColor] = useState('#000000')
  const [strokeWidth, setStrokeWidth] = useState(2)
  const [fontSize, setFontSize] = useState(18)
  const initialProfile = currentProfile()
  const [annotatorProfile, setAnnotatorProfile] = useState({
    firstName: firstName || initialProfile.firstName || '',
    lastName: lastName || initialProfile.lastName || '',
  })
  const [annotatorDraft, setAnnotatorDraft] = useState({
    firstName: firstName || initialProfile.firstName || '',
    lastName: lastName || initialProfile.lastName || '',
  })
  const annotator = [annotatorProfile.firstName, annotatorProfile.lastName].filter(Boolean).join(' ').trim() || displayName || user || currentUser() || ''
  const annotatorEdited = useRef(false)
  const [annotatorNameOpen, setAnnotatorNameOpen] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMessage, setProfileMessage] = useState('')
  const [showAnnPanel, setShowAnnPanel] = useState(true)
  const [sidebarTab, setSidebarTab] = useState(() => normalizeSidebarTab(initialTab))
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [annotationToolsOpen, setAnnotationToolsOpen] = useState(false)
  const [editingTextId, setEditingTextId] = useState(null)
  const [toolbarDock, setToolbarDock] = useState('top')
  const [toolbarFreePosition, setToolbarFreePosition] = useState(null)
  const [showAbout, setShowAbout] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [reportNote, setReportNote] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(null)
  const [exportPanelOpen, setExportPanelOpen] = useState(initialTab === 'report')
  const canAnnotate = role !== 'viewer'

  const imageRef = useRef(null)
  const svgRef = useRef(null)
  const viewportRef = useRef(null)
  const dragRef = useRef(null)
  const panRafRef = useRef(null)
  const zScrubTimerRef = useRef(null)
  const zScrubTargetRef = useRef(0)
  const undoStackRef = useRef([])
  const redoStackRef = useRef([])
  const annotationClipboardRef = useRef(null)
  const toolbarRef = useRef(null)
  const toolbarDragRef = useRef(null)

  const imageKey = `${caseId}/${filename}`
  const imageApiBase = `${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}`
  const measurementMeta = useMemo(() => (
    imgMeta ? applyMeasurementSettings(imgMeta, measurementSettings || defaultMeasurementSettings(imgMeta, caseId)) : null
  ), [caseId, imgMeta, measurementSettings])
  const zCount = Math.max(1, Number(imgMeta?.zCount) || 1)

  useEffect(() => {
    setSidebarTab(normalizeSidebarTab(initialTab))
    setExportPanelOpen(initialTab === 'report')
  }, [initialTab, filename])

  useEffect(() => {
    if (canAnnotate) return
    setActiveTool('select')
    setAnnotationToolsOpen(false)
    setEditingTextId(null)
  }, [canAnnotate])

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

  useEffect(() => {
    const controller = new AbortController()
    setLoadError(null)
    setImgMeta(null)
    setChannelSettings(null)
    setChannelStats(null)
    setMeasurementSettings(null)
    autoWindowAppliedRef.current = false
    setLoadedImageKey(null)
    setEditingTextId(null)
    setSliceLoadState({ status: 'idle', requestedZIndex: 0, displayedZIndex: null, loadedChannels: 0, channelCount: 0 })
    setFullImageCacheRequest(0)
    setFullImageCacheState({ status: 'idle', completedPlanes: 0, totalPlanes: 0, etaMs: 0, persistent: false, error: '' })
    fetchJson(`${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/meta`, { signal: controller.signal })
      .then(async meta => {
        let sharedState = null
        try {
          sharedState = await fetchViewState(caseId, filename, { signal: controller.signal })
        } catch {
          sharedState = null
        }
        if (controller.signal.aborted) return
        const nextChannelSettings = sharedState?.channelSettings
          ? normalizeChannelSettings(sharedState.channelSettings, meta)
          : loadChannelSettings(caseId, filename, meta)
        const nextMeasurementSettings = sharedState?.measurementSettings
          ? normalizeMeasurementSettings(sharedState.measurementSettings, meta, caseId)
          : loadMeasurementSettings(caseId, filename, meta)
        const nextZIndex = clampZIndex(sharedState?.zIndex || 0, meta)
        applyingRemoteViewStateRef.current = Boolean(sharedState?.revision)
        suppressNextViewStatePublishRef.current = Boolean(sharedState?.revision)
        setImgMeta(meta)
        setChannelSettings(nextChannelSettings)
        setMeasurementSettings(nextMeasurementSettings)
        setZIndex(nextZIndex)
        setZDraftIndex(nextZIndex)
        setViewStateRevision(sharedState?.revision || 0)
        setViewStateChangedBy(sharedState?.lastChangedByName || sharedState?.lastChangedBy || '')
        setLoadedImageKey(`${caseId}/${filename}`)
        setReportNote('')
        window.requestAnimationFrame(() => fitToViewport(meta))
        window.setTimeout(() => { applyingRemoteViewStateRef.current = false }, 0)
      })
      .catch(err => { if (err.name !== 'AbortError') setLoadError(err.message) })
    return () => controller.abort()
  }, [caseId, filename, fitToViewport])

  useEffect(() => {
    if (!channelSettings || loadedImageKey !== imageKey) return
    saveChannelSettings(caseId, filename, channelSettings)
  }, [caseId, filename, imageKey, loadedImageKey, channelSettings])

  useEffect(() => {
    if (!measurementSettings || loadedImageKey !== imageKey) return
    saveMeasurementSettings(caseId, filename, measurementSettings)
  }, [caseId, filename, imageKey, loadedImageKey, measurementSettings])

  useEffect(() => {
    if (!imgMeta || loadedImageKey !== imageKey || !channelSettings || !measurementSettings) return undefined
    if (applyingRemoteViewStateRef.current) return undefined
    if (suppressNextViewStatePublishRef.current) {
      suppressNextViewStatePublishRef.current = false
      return undefined
    }
    if (viewStatePublishTimerRef.current) window.clearTimeout(viewStatePublishTimerRef.current)
    viewStatePublishTimerRef.current = window.setTimeout(() => {
      updateViewState(caseId, filename, {
        clientId,
        channelSettings,
        measurementSettings,
        zIndex,
      }).then(state => {
        setViewStateRevision(state?.revision || 0)
        setViewStateChangedBy(state?.lastChangedByName || state?.lastChangedBy || '')
      }).catch(() => {})
    }, 600)
    return () => {
      if (viewStatePublishTimerRef.current) window.clearTimeout(viewStatePublishTimerRef.current)
    }
  }, [caseId, filename, imageKey, loadedImageKey, imgMeta, channelSettings, measurementSettings, zIndex, clientId])

  useEffect(() => {
    if (!imgMeta || loadedImageKey !== imageKey) return undefined
    const id = window.setInterval(() => {
      fetchViewState(caseId, filename)
        .then(state => {
          const nextRevision = state?.revision || 0
          if (!nextRevision || nextRevision <= viewStateRevision) return
          applyingRemoteViewStateRef.current = true
          suppressNextViewStatePublishRef.current = true
          if (state.channelSettings) setChannelSettings(normalizeChannelSettings(state.channelSettings, imgMeta))
          if (state.measurementSettings) setMeasurementSettings(normalizeMeasurementSettings(state.measurementSettings, imgMeta, caseId))
          const nextZIndex = clampZIndex(state.zIndex || 0, imgMeta)
          setZIndex(nextZIndex)
          setZDraftIndex(nextZIndex)
          setViewStateRevision(nextRevision)
          setViewStateChangedBy(state.lastChangedByName || state.lastChangedBy || '')
          window.setTimeout(() => { applyingRemoteViewStateRef.current = false }, 0)
        })
        .catch(() => {})
    }, 5000)
    return () => window.clearInterval(id)
  }, [caseId, filename, imageKey, loadedImageKey, imgMeta, viewStateRevision])

  useEffect(() => {
    setChannelStats(null)
  }, [zIndex])

  const commitZSlice = useCallback((value) => {
    const nextZIndex = clampZIndex(value, imgMeta)
    if (zScrubTimerRef.current) {
      window.clearTimeout(zScrubTimerRef.current)
      zScrubTimerRef.current = null
    }
    zScrubTargetRef.current = nextZIndex
    setZDraftIndex(nextZIndex)
    setZIndex(nextZIndex)
  }, [imgMeta])

  // Keep the thumb responsive, but do not turn one quick drag into dozens of
  // expensive TIFF/ND2 reads. Releasing the control always commits its final
  // slice immediately.
  const scrubZSlice = useCallback((value) => {
    const nextZIndex = clampZIndex(value, imgMeta)
    zScrubTargetRef.current = nextZIndex
    setZDraftIndex(nextZIndex)
    if (zScrubTimerRef.current) return
    zScrubTimerRef.current = window.setTimeout(() => {
      zScrubTimerRef.current = null
      setZIndex(zScrubTargetRef.current)
    }, 90)
  }, [imgMeta])

  const nudgeZSlice = useCallback((direction) => {
    commitZSlice(zDraftIndex + direction)
  }, [commitZSlice, zDraftIndex])

  useEffect(() => {
    const nextZIndex = clampZIndex(zDraftIndex, imgMeta)
    if (nextZIndex !== zDraftIndex) setZDraftIndex(nextZIndex)
    const committedZIndex = clampZIndex(zIndex, imgMeta)
    if (committedZIndex !== zIndex) setZIndex(committedZIndex)
  }, [imgMeta, zDraftIndex, zIndex])

  useEffect(() => () => {
    if (zScrubTimerRef.current) window.clearTimeout(zScrubTimerRef.current)
  }, [])

  useEffect(() => {
    if (!imgMeta || !channelSettings || !channelStats || autoWindowAppliedRef.current) return
    autoWindowAppliedRef.current = true
    setChannelSettings(autoWindowChannelSettings(channelSettings, channelStats, imgMeta, { onlyUninitialized: true }))
  }, [imgMeta, channelSettings, channelStats])

  useEffect(() => {
    const controller = new AbortController()
    fetchJson(`${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/annotations`, { signal: controller.signal })
      .then(d => {
        setAnnotations((d.annotations || []).map(normalizeAnnotationForStorage))
        setAnnotationRevision(d.revision || 0)
        setDirty(false)
        setLastSavedAt(null)
        undoStackRef.current = []
        redoStackRef.current = []
      })
      .catch(err => { if (err.name !== 'AbortError') setLoadError(err.message) })
    return () => controller.abort()
  }, [caseId, filename])

  useEffect(() => {
    if (dirty || saving) return undefined
    const id = window.setInterval(() => {
      fetchJson(`${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/annotations`)
        .then(d => {
          const nextRevision = d.revision || 0
          if (nextRevision <= annotationRevision) return
          const nextAnnotations = (d.annotations || []).map(normalizeAnnotationForStorage)
          setAnnotations(nextAnnotations)
          setAnnotationRevision(nextRevision)
          setLastSavedAt(null)
          setSelectedId(current => nextAnnotations.some(annotation => annotation.id === current) ? current : null)
          setEditingTextId(current => nextAnnotations.some(annotation => annotation.id === current) ? current : null)
          undoStackRef.current = []
          redoStackRef.current = []
        })
        .catch(() => {})
    }, 10000)
    return () => window.clearInterval(id)
  }, [annotationRevision, caseId, dirty, filename, saving])


  const applyAutoChannel = useCallback((channelIndex) => {
    setChannelSettings(current => current
      ? autoWindowChannelSettings(current, channelStats, imgMeta, { channelIndex, advanceAutoStep: true })
      : current)
  }, [channelStats, imgMeta])

  const saveAnnotations = useCallback(async () => {
    if (!canAnnotate) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = await fetchJson(`${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/annotations`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-AGH-User': annotator || ''
        },
        body: JSON.stringify({
          revision: annotationRevision,
          updatedBy: annotator,
          annotations: annotations.map(normalizeAnnotationForStorage),
        })
      })
      setAnnotationRevision(result.revision || annotationRevision + 1)
      setDirty(false)
      setLastSavedAt(new Date())
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }, [canAnnotate, caseId, filename, annotations, annotationRevision, annotator])

  const setAnnsAndDirty = useCallback(fn => {
    if (!canAnnotate) return
    setAnnotations(prev => {
      const next = typeof fn === 'function' ? fn(prev) : fn
      if (next === prev) return prev
      undoStackRef.current = [...undoStackRef.current.slice(-49), prev]
      redoStackRef.current = []
      setDirty(true)
      setSaveError(null)
      return next
    })
  }, [canAnnotate])

  const undoAnnotations = useCallback(() => {
    if (!canAnnotate) return
    setAnnotations(prev => {
      const previous = undoStackRef.current.pop()
      if (!previous) return prev
      redoStackRef.current = [...redoStackRef.current.slice(-49), prev]
      setDirty(true)
      return previous
    })
  }, [canAnnotate])

  const redoAnnotations = useCallback(() => {
    if (!canAnnotate) return
    setAnnotations(prev => {
      const next = redoStackRef.current.pop()
      if (!next) return prev
      undoStackRef.current = [...undoStackRef.current.slice(-49), prev]
      setDirty(true)
      return next
    })
  }, [canAnnotate])

  const deleteAnnotation = useCallback((id) => {
    if (!canAnnotate) return
    setAnnsAndDirty(prev => prev.filter(a => a.id !== id))
    setSelectedId(prev => prev === id ? null : prev)
    setEditingTextId(current => current === id ? null : current)
  }, [canAnnotate, setAnnsAndDirty])

  const deleteSelected = useCallback(() => {
    if (selectedId) deleteAnnotation(selectedId)
  }, [selectedId, deleteAnnotation])

  const copySelectedAnnotation = useCallback(() => {
    const selected = annotations.find(annotation => annotation.id === selectedId)
    if (!selected) return false
    annotationClipboardRef.current = cloneAnnotation(selected)
    return true
  }, [annotations, selectedId])

  const pasteAnnotation = useCallback(() => {
    if (!canAnnotate) return
    const source = annotationClipboardRef.current
    if (!source) return
    const pasted = {
      ...offsetAnnotation(source),
      id: uuidv4(),
      annotator: annotator || source.annotator || '',
      timestamp: new Date().toISOString(),
      ...(zCount > 1 ? { zIndex } : {}),
    }
    setAnnsAndDirty(previous => [...previous, pasted])
    setSelectedId(pasted.id)
    setEditingTextId(null)
  }, [canAnnotate, annotator, setAnnsAndDirty, zCount, zIndex])

  const cutSelectedAnnotation = useCallback(() => {
    if (!canAnnotate) return
    if (!copySelectedAnnotation()) return
    deleteSelected()
  }, [canAnnotate, copySelectedAnnotation, deleteSelected])

  const handleEditAnnotation = useCallback((id) => {
    if (!canAnnotate) return
    const target = annotations.find(annotation => annotation.id === id)
    setSelectedId(id)
    if (normalizedAnnotationType(target) === 'text') {
      setEditingTextId(id)
      setActiveTool('text')
      setAnnotationToolsOpen(true)
    }
  }, [canAnnotate, annotations])

  const currentFileIndex = useMemo(() => files.findIndex(item => item === filename), [files, filename])
  const previousFile = currentFileIndex > 0 ? files[currentFileIndex - 1] : null
  const nextFile = currentFileIndex >= 0 && currentFileIndex < files.length - 1 ? files[currentFileIndex + 1] : null
  const navigateFile = useCallback((target) => {
    if (!target || !onNavigateFile) return
    onNavigateFile(target)
  }, [onNavigateFile])

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
        if (canAnnotate) saveAnnotations()
        return
      }
      if (command && key === 'z') {
        e.preventDefault()
        if (canAnnotate) {
          if (e.shiftKey) redoAnnotations()
          else undoAnnotations()
        }
        return
      }
      if (e.key === 'Enter' && (editingTextId || selectedId || activeTool !== 'select')) {
        e.preventDefault()
        setActiveTool('select')
        setEditingTextId(null)
        setSelectedId(null)
        return
      }
      if (isEditingTarget(e.target)) return
      if (command && key === 'c') {
        e.preventDefault()
        copySelectedAnnotation()
        return
      }
      if (command && key === 'v') {
        e.preventDefault()
        if (canAnnotate) pasteAnnotation()
        return
      }
      if (command && key === 'x') {
        e.preventDefault()
        if (canAnnotate) cutSelectedAnnotation()
        return
      }

      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault()
        setShowShortcuts(value => !value)
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        setSpacePan(true)
        return
      }
      if (e.key === 'Escape') {
        if (showShortcuts) { setShowShortcuts(false); return }
        if (showAbout) { setShowAbout(false); return }
        setActiveTool('select'); setSelectedId(null); setEditingTextId(null)
      }
      if (canAnnotate && (e.key === 'Delete' || e.key === 'Backspace') && selectedId) deleteSelected()
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
    copySelectedAnnotation,
    pasteAnnotation,
    cutSelectedAnnotation,
    fitToViewport,
    setActualSize,
    zoomAroundCenter,
    imgMeta,
    previousFile,
    nextFile,
    navigateFile,
    showShortcuts,
    showAbout,
    editingTextId,
    activeTool,
    canAnnotate,
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
    if (!canAnnotate || !dirty || saving || saveError) return
    const id = window.setTimeout(() => { saveAnnotations() }, 1000)
    return () => window.clearTimeout(id)
  }, [canAnnotate, dirty, saving, saveError, saveAnnotations])

  // Default the annotator to the logged-in username. Runs when the session
  // identity becomes available (it may arrive a tick after mount), but never
  // overrides a name the user typed themselves.
  useEffect(() => {
    if (!annotatorEdited.current) {
      const next = {
        firstName: firstName || '',
        lastName: lastName || '',
      }
      setAnnotatorProfile(next)
      setAnnotatorDraft(next)
    }
  }, [firstName, lastName])

  useEffect(() => {
    if (!imgMeta) return
    const id = window.setTimeout(() => fitToViewport(imgMeta), 0)
    return () => window.clearTimeout(id)
  }, [sidebarCollapsed, imgMeta, fitToViewport])

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
    if (e.target?.closest?.('.annotation-floating-toolbar')) return
    if (activeTool !== 'select' && activeTool !== 'pan' && !spacePan) return
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

  const updateSelectedAnnotation = useCallback((patch) => {
    if (!canAnnotate) return
    if (!selectedId) return
    setAnnsAndDirty(prev => prev.map(a => a.id === selectedId ? { ...a, ...patch } : a))
  }, [canAnnotate, selectedId, setAnnsAndDirty])

  const insertCenteredText = useCallback(() => {
    if (!canAnnotate) return
    if (!imgMeta || !viewportRef.current) return
    const rect = viewportRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(imgMeta.width, ((rect.width / 2) - tx) / Math.max(scale, 0.0001)))
    const y = Math.max(fontSize, Math.min(imgMeta.height, ((rect.height / 2) - ty) / Math.max(scale, 0.0001)))
    const annotation = {
      id: uuidv4(),
      type: 'text',
      coords: [x, y],
      label: '',
      annotator,
      timestamp: new Date().toISOString(),
      color: annColor,
      strokeWidth,
      fontSize,
      ...(zCount > 1 ? { zIndex } : {}),
    }
    setAnnsAndDirty(previous => [...previous, annotation])
    setSelectedId(annotation.id)
    setEditingTextId(annotation.id)
    setActiveTool('text')
    setAnnotationToolsOpen(true)
  }, [canAnnotate, annColor, annotator, fontSize, imgMeta, scale, setAnnsAndDirty, strokeWidth, tx, ty, zCount, zIndex])

  const saveAnnotatorProfile = useCallback(async () => {
    if (!canAnnotate) return
    setProfileSaving(true)
    setProfileMessage('')
    try {
      const body = await fetchJson(`${API}/account/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(annotatorDraft),
      })
      const nextProfile = { firstName: body.firstName || '', lastName: body.lastName || '', displayName: body.displayName || '' }
      rememberProfile(nextProfile)
      setAnnotatorProfile({ firstName: nextProfile.firstName, lastName: nextProfile.lastName })
      setAnnotatorDraft({ firstName: nextProfile.firstName, lastName: nextProfile.lastName })
      onProfileChange?.(nextProfile)
      annotatorEdited.current = false
      setProfileMessage('Name saved')
      setAnnotatorNameOpen(false)
    } catch (error) {
      setProfileMessage(error.message || 'Unable to save name')
    } finally {
      setProfileSaving(false)
    }
  }, [annotatorDraft, canAnnotate, onProfileChange])

  const exportPDF = useCallback(async (withAnnotations) => {
    setExporting(true)
    setExportError(null)
    try {
      const cvs = await exportCanvasFromViewer(imageRef.current, svgRef.current, withAnnotations)
      const imgData = cvs.toDataURL('image/png')
      const orientation = cvs.width >= cvs.height ? 'landscape' : 'portrait'
      const pdf = new jsPDF({ orientation, unit: 'px', format: [cvs.width, cvs.height], compress: false })
      pdf.addImage(imgData, 'PNG', 0, 0, cvs.width, cvs.height, undefined, 'NONE')

      if (withAnnotations && annotations.length) {
        pdf.addPage()
        pdf.setFontSize(10)
        pdf.text('Annotations', 20, 20)
        annotations.forEach((a, i) => {
          const type = normalizedAnnotationType(a)
          const ts = a.timestamp ? new Date(a.timestamp).toLocaleString() : ''
          const details = type === 'measure'
            ? formatMeasurement(a.coords, a, measurementMeta)
            : a.label || ''
          pdf.text(`${i+1}. [${type}] ${details} - ${a.annotator || 'unknown'} @ ${ts}`, 20, 35 + i * 14)
        })
      }

      pdf.setFontSize(10)
      pdf.setTextColor(180, 30, 30)
      pdf.text(RESEARCH_USE_NOTICE, 20, Math.max(20, cvs.height - 20))
      await authFetch(`${API}/audit/export-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ caseId, filename, withAnnotations }),
      }).catch(() => {})

      const safeName = filename.replace(/\.[^.]+$/, '')
      pdf.save(`${safeName}${withAnnotations ? '_annotated' : ''}.pdf`)
    } catch (error) {
      setExportError(error.message || 'Unable to export PDF')
    } finally {
      setExporting(false)
    }
  }, [caseId, filename, annotations, measurementMeta])

  const imageReady = loadedImageKey === imageKey && imgMeta && channelSettings

  const handleSliceLoadState = useCallback(nextState => {
    setSliceLoadState(nextState)
  }, [])

  const handleFullImageCacheProgress = useCallback(nextState => {
    setFullImageCacheState(nextState)
  }, [])

  const cacheEntireImage = useCallback(() => {
    if (!imgMeta || fullImageCacheState.status === 'caching') return
    setFullImageCacheState({ status: 'caching', completedPlanes: 0, totalPlanes: 0, etaMs: 0, persistent: false, error: '' })
    setFullImageCacheRequest(current => current + 1)
  }, [fullImageCacheState.status, imgMeta])

  const selectedAnn = annotations.find(a => a.id === selectedId)
  const selectedMeasurement = normalizedAnnotationType(selectedAnn) === 'measure'
    ? formatMeasurement(selectedAnn.coords, selectedAnn, measurementMeta)
    : null

  useEffect(() => {
    if (!selectedAnn) return
    if (selectedAnn.color) setAnnColor(selectedAnn.color)
    if (Number.isFinite(Number(selectedAnn.strokeWidth))) setStrokeWidth(Number(selectedAnn.strokeWidth))
    if (normalizedAnnotationType(selectedAnn) === 'text' && Number.isFinite(Number(selectedAnn.fontSize))) setFontSize(Number(selectedAnn.fontSize))
  }, [selectedAnn?.id])

  const updateMeasurementSettings = useCallback((patch) => {
    setMeasurementSettings(current => ({
      ...(current || defaultMeasurementSettings(imgMeta, caseId)),
      ...patch,
    }))
  }, [caseId, imgMeta])

  const changeAnnotationColor = useCallback((color) => {
    setAnnColor(color)
    if (selectedId) updateSelectedAnnotation({ color })
  }, [selectedId, updateSelectedAnnotation])

  const changeStrokeWidth = useCallback((value) => {
    const next = Math.max(1, Math.min(12, Number(value) || 2))
    setStrokeWidth(next)
    if (selectedId) updateSelectedAnnotation({ strokeWidth: next })
  }, [selectedId, updateSelectedAnnotation])

  const changeFontSize = useCallback((value) => {
    const next = Math.max(10, Math.min(72, Number(value) || 18))
    setFontSize(next)
    if (normalizedAnnotationType(selectedAnn) === 'text') updateSelectedAnnotation({ fontSize: next })
  }, [selectedAnn, updateSelectedAnnotation])

  const exitAnnotationEditMode = useCallback(() => {
    setActiveTool('select')
    setSelectedId(null)
  }, [])

  const annotationSummary = useCallback((annotation) => {
    const type = normalizedAnnotationType(annotation)
    if (type === 'measure') {
      return `measurement: ${formatMeasurement(annotation.coords, annotation, measurementMeta)}`
    }
    return annotation.label ? `${type}: ${annotation.label}` : type
  }, [measurementMeta])

  const toolbarStyle = useMemo(() => {
    if (toolbarFreePosition) {
      return { left: `${toolbarFreePosition.x}px`, top: `${toolbarFreePosition.y}px`, right: 'auto', bottom: 'auto', transform: 'none' }
    }
    if (toolbarDock === 'bottom') return { left: '50%', top: 'auto', right: 'auto', bottom: '12px', transform: 'translateX(-50%)' }
    if (toolbarDock === 'left') return { left: '12px', top: '50%', right: 'auto', bottom: 'auto', transform: 'translateY(-50%)' }
    if (toolbarDock === 'right') return { left: 'auto', top: '50%', right: '12px', bottom: 'auto', transform: 'translateY(-50%)' }
    return { left: '50%', top: '12px', right: 'auto', bottom: 'auto', transform: 'translateX(-50%)' }
  }, [toolbarDock, toolbarFreePosition])

  const stopToolbarEvent = useCallback((event) => {
    event.stopPropagation()
  }, [])

  const beginToolbarDrag = useCallback((event) => {
    const viewport = viewportRef.current?.getBoundingClientRect()
    const toolbar = toolbarRef.current?.getBoundingClientRect()
    if (!viewport || !toolbar) return
    event.preventDefault()
    event.stopPropagation()
    toolbarDragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - toolbar.left,
      offsetY: event.clientY - toolbar.top,
      width: toolbar.width,
      height: toolbar.height,
    }
    setToolbarFreePosition({ x: toolbar.left - viewport.left, y: toolbar.top - viewport.top })
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [])

  const moveToolbarDrag = useCallback((event) => {
    const drag = toolbarDragRef.current
    const viewport = viewportRef.current?.getBoundingClientRect()
    if (!drag || !viewport) return
    event.preventDefault()
    event.stopPropagation()
    const x = Math.max(8, Math.min(viewport.width - drag.width - 8, event.clientX - viewport.left - drag.offsetX))
    const y = Math.max(8, Math.min(viewport.height - drag.height - 8, event.clientY - viewport.top - drag.offsetY))
    setToolbarFreePosition({ x, y })
  }, [])

  const endToolbarDrag = useCallback((event) => {
    const drag = toolbarDragRef.current
    const viewport = viewportRef.current?.getBoundingClientRect()
    if (!drag || !viewport) return
    event.preventDefault()
    event.stopPropagation()
    const centerX = event.clientX - viewport.left
    const centerY = event.clientY - viewport.top
    // Dock to whichever viewport edge the drop point is closest to, so the
    // toolbar can go to any of the four sides regardless of image aspect ratio.
    const distances = {
      top: centerY,
      bottom: viewport.height - centerY,
      left: centerX,
      right: viewport.width - centerX,
    }
    const nearest = Object.keys(distances).reduce((a, b) => (distances[b] < distances[a] ? b : a))
    setToolbarDock(nearest)
    setToolbarFreePosition(null)
    toolbarDragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [])

  const panActive = spacePan || activeTool === 'pan'
  const isDrawTool = activeTool !== 'select' && activeTool !== 'pan' && activeTool !== 'text' && !spacePan
  const transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  const zoomLabel = `${Math.round(scale * 100)}%`
  const saveLabel = saving
    ? 'Saving...'
    : dirty
      ? 'Unsaved changes'
      : lastSavedAt
        ? 'Saved just now'
        : 'Saved'
  const filePositionLabel = currentFileIndex >= 0 && files.length
    ? `Image ${currentFileIndex + 1} of ${files.length}`
    : 'Image'
  const requestClose = () => {
    if (dirty && !window.confirm('Discard unsaved annotations?')) return
    onClose()
  }
  const annotationModeActive = annotationToolsOpen
  const displayedMeasurementSettings = measurementSettings || defaultMeasurementSettings(imgMeta, caseId)
  const expansionEnabled = displayedMeasurementSettings.expansionEnabled !== false
  const expansionFactor = Number(displayedMeasurementSettings.expansionFactor) || DEFAULT_EXPANSION_FACTOR
  const exportFloatingRight = sidebarCollapsed ? 18 : 338
  const exportFloatingBottom = zCount > 1 ? 108 : 64
  const exportFloatingStyle = {
    right: `${exportFloatingRight}px`,
    bottom: `${exportFloatingBottom}px`,
    maxWidth: `calc(100vw - ${exportFloatingRight + 64}px)`,
  }
  const exportPanelFloatingStyle = {
    ...exportFloatingStyle,
    bottom: `${exportFloatingBottom + 48}px`,
    maxHeight: `calc(100vh - ${exportFloatingBottom + 78}px)`,
  }

  return (
    <div className="viewer-shell fixed inset-0 z-50 flex">
      <div className="viewer-tool-rail w-12 flex-shrink-0 flex flex-col items-center gap-1 border-r py-3">
        {TOOLS.slice(0, 2).map(({ id, icon: Icon, label }) => (
          <button key={id} title={label} onClick={() => setActiveTool(id)}
            className={`ux-tool-button ${activeTool === id ? 'ux-tool-button-active' : ''}`}>
            <Icon size={16} />
          </button>
        ))}
        <div className="ux-divider mt-2 h-px w-8" />
        <button onClick={() => fitToViewport(imgMeta)}
          className="ux-tool-button"
          title="Fit image (F)">
          <Maximize2 size={16} />
        </button>
        <button onClick={() => zoomAroundCenter(1 / 1.18)}
          className="ux-tool-button"
          title="Zoom out (-)">
          <ZoomOut size={16} />
        </button>
        <button onClick={() => zoomAroundCenter(1.18)}
          className="ux-tool-button"
          title="Zoom in (+)">
          <ZoomIn size={16} />
        </button>
        <div className="ux-divider my-2 h-px w-8" />
        <button
          type="button"
          disabled={!canAnnotate}
          onClick={() => {
            if (!canAnnotate) return
            setAnnotationToolsOpen(open => {
              if (open) setActiveTool('select')
              return !open
            })
          }}
          className={`ux-tool-button ${annotationModeActive ? 'ux-tool-button-active' : ''}`}
          title={canAnnotate ? 'Annotate' : 'Viewer role cannot annotate'}
          aria-expanded={annotationModeActive}
        >
          <PenLine size={16} />
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="viewer-commandbar flex flex-shrink-0 items-center gap-2 px-2">
          <button onClick={requestClose}
            className="ux-button ux-button-ghost">
            <ChevronLeft size={14} />
            Back
          </button>
          <div className="min-w-0 flex-1 px-2">
            <p className="truncate text-sm font-semibold text-gray-100">Case: {caseId}</p>
            <p className="truncate text-[12px] text-[var(--text-subtle)]">File: {filename} · {filePositionLabel}</p>
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
          <button onClick={setActualSize}
            className="ux-button ux-button-ghost font-mono">
            {zoomLabel}
          </button>
          <span className={`ux-badge ${dirty ? 'ux-badge-warning' : 'ux-badge-success'}`}>
            {saveLabel}
          </span>
          <button
            onClick={() => setShowShortcuts(true)}
            className="ux-icon-button"
            title="Keyboard shortcuts (?)"
          >
            <Keyboard size={14} />
          </button>
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

        <div ref={viewportRef}
          className={`relative min-h-0 flex-1 overflow-hidden ${isDrawTool ? 'tool-draw' : ''} ${panActive ? 'tool-pan' : ''}`}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          {canAnnotate && annotationToolsOpen && (
            <div
              ref={toolbarRef}
              className="annotation-floating-toolbar"
              data-dock={toolbarDock}
              style={toolbarStyle}
              onPointerDown={stopToolbarEvent}
              onMouseDown={stopToolbarEvent}
            >
              <button type="button" className="annotation-floating-drag-handle" title="Drag annotation toolbar"
                onPointerDown={beginToolbarDrag} onPointerMove={moveToolbarDrag} onPointerUp={endToolbarDrag}>
                <span aria-hidden="true">⋮⋮</span>
              </button>
              <div className="annotation-floating-group" aria-label="Annotation tools">
                {TOOLS.filter(tool => ANNOTATION_TOOL_IDS.includes(tool.id)).map(({ id, icon: Icon, label }) => (
                  <button
                    key={id}
                    type="button"
                    title={label}
                    onClick={() => id === 'text' ? insertCenteredText() : setActiveTool(id)}
                    className={`annotation-floating-tool ${activeTool === id ? 'annotation-floating-tool-active' : ''}`}
                  >
                    <Icon size={15} />
                  </button>
                ))}
              </div>
              <div className="annotation-floating-divider" />
              <div className="annotation-floating-group annotation-floating-colors" aria-label="Annotation color">
                {COLORS.map(color => (
                  <button
                    key={color}
                    type="button"
                    title={color}
                    onClick={() => changeAnnotationColor(color)}
                    className={`annotation-floating-swatch ${annColor === color ? 'annotation-floating-swatch-active' : ''}`}
                    style={{ '--annotation-color': color }}
                  />
                ))}
                <input
                  type="color"
                  value={annColor}
                  onChange={event => changeAnnotationColor(event.currentTarget.value)}
                  className="annotation-floating-color-input"
                  title="Custom annotation color"
                />
              </div>
              <div className="annotation-floating-divider" />
              <label className="annotation-floating-range-label" title="Stroke thickness">
                <span>Line</span>
                <input
                  type="range"
                  min="1"
                  max="12"
                  step="1"
                  value={strokeWidth}
                  onChange={event => changeStrokeWidth(event.currentTarget.value)}
                  className="annotation-floating-range"
                />
                <span className="annotation-floating-value">{strokeWidth}px</span>
              </label>
              {(activeTool === 'text' || normalizedAnnotationType(selectedAnn) === 'text') && (
                <label className="annotation-floating-range-label" title="Text size">
                  <span>Text</span>
                  <input
                    type="range"
                    min="10"
                    max="72"
                    step="1"
                    value={fontSize}
                    onChange={event => changeFontSize(event.currentTarget.value)}
                    className="annotation-floating-range"
                  />
                  <span className="annotation-floating-value">{fontSize}px</span>
                </label>
              )}
            </div>
          )}
          <div className="inner-content" style={{ position: 'absolute', transform, transformOrigin: '0 0' }}>
            <div
              style={{ position: 'relative', width: imgMeta?.width || 0, height: imgMeta?.height || 0 }}
              className="viewer-canvas-container"
            >
              {loadError && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 text-sm text-red-300 px-6 text-center">
                  {loadError}
                </div>
              )}
              {imageReady && (
                <MultiChannelCanvas
                  apiBase={imageApiBase}
                  meta={imgMeta}
                  settings={channelSettings}
                  zIndex={zIndex}
                  zCount={zCount}
                  canvasRef={imageRef}
                  onError={setLoadError}
                  onLoadState={handleSliceLoadState}
                  onChannelStats={setChannelStats}
                  cacheAllRequest={fullImageCacheRequest}
                  onCacheProgress={handleFullImageCacheProgress}
                />
              )}
              {imgMeta && (
                <AnnotationLayer
                  svgRef={svgRef}
                  imgMeta={measurementMeta}
                  annotations={annotations}
                  setAnnotations={setAnnsAndDirty}
                  activeTool={activeTool}
                  panActive={panActive}
                  annotatorName={annotator}
                  annotationColor={annColor}
                  strokeWidth={strokeWidth}
                  fontSize={fontSize}
                  selectedId={selectedId}
                  setSelectedId={setSelectedId}
                  onEditAnnotation={handleEditAnnotation}
                  editingTextId={editingTextId}
                  setEditingTextId={setEditingTextId}
                  onExitEditMode={exitAnnotationEditMode}
                  zIndex={zIndex}
                  zCount={zCount}
                  readOnly={!canAnnotate}
                />
              )}
            </div>
          </div>
        </div>
        {zCount > 1 && (
          <div className="viewer-z-bar flex flex-shrink-0 items-center gap-3 px-4 py-2">
            <button
              type="button"
              className="ux-icon-button"
              title="Previous Z slice"
              disabled={zDraftIndex <= 0}
              onClick={() => nudgeZSlice(-1)}>
              <ChevronLeft size={16} />
            </button>
            <div className="viewer-z-slider" title="Z slice">
              <span>Z {zDraftIndex + 1}/{zCount}</span>
              <ZSliceSlider
                zCount={zCount}
                value={zDraftIndex}
                annotations={annotations}
                onInput={scrubZSlice}
                onCommit={commitZSlice}
                onJumpToSlice={commitZSlice}
              />
            </div>
            <span className="viewer-z-load-status" role="status" aria-live="polite">
              {zDraftIndex !== zIndex
                ? `Preparing Z ${zDraftIndex + 1}`
                : sliceLoadState.status === 'loading' || sliceLoadState.status === 'rendering'
                  ? `Loading ${sliceLoadState.loadedChannels}/${sliceLoadState.channelCount || 1}`
                  : sliceLoadState.status === 'error'
                    ? 'Slice failed to load'
                    : 'Ready'}
            </span>
            <button
              type="button"
              className="ux-icon-button"
              title="Next Z slice"
              disabled={zDraftIndex >= zCount - 1}
              onClick={() => nudgeZSlice(1)}>
              <ChevronRight size={16} />
            </button>
            <button
              type="button"
              className="ux-button ux-button-secondary min-h-0 whitespace-nowrap px-3 py-1.5 text-[11px]"
              title="Cache every Z slice and channel in temporary browser storage. Cached data is removed after 45 minutes without use."
              disabled={!imageReady || fullImageCacheState.status === 'caching'}
              onClick={cacheEntireImage}>
              <Download size={13} />
              {fullImageCacheState.status === 'caching'
                ? `Caching ${fullImageCacheState.completedPlanes}/${fullImageCacheState.totalPlanes || '?'}`
                : fullImageCacheState.status === 'cached'
                  ? 'Image cached'
                  : 'Cache all slices'}
            </button>
            <span className="viewer-full-cache-status" role="status" aria-live="polite">
              {fullImageCacheState.status === 'caching'
                ? `${fullImageCacheState.completedPlanes}/${fullImageCacheState.totalPlanes || '?'} planes · ${formatCacheEta(fullImageCacheState.etaMs)}`
                : fullImageCacheState.status === 'cached'
                  ? (fullImageCacheState.persistent ? 'Cached for 45 min of inactivity' : 'Cached in memory for this session')
                  : fullImageCacheState.status === 'error'
                    ? fullImageCacheState.error || 'Unable to cache all slices'
                    : ''}
            </span>
          </div>
        )}
        <div className="viewer-statusbar flex flex-shrink-0 items-center justify-between gap-3 px-4 py-2">
          <div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--text-muted)]">
            <span>Raw TIFF channels · viewer-only display controls · source unchanged</span>
            <span className="font-semibold text-[var(--danger)]">{RESEARCH_USE_NOTICE}</span>
            {!canAnnotate && <span>Read-only viewer role</span>}
            {viewStateChangedBy && <span>Display settings synced by {viewStateChangedBy}</span>}
            <span className="viewer-calibration-chip">Pixel size: {measurementMeta ? formatPixelSize(measurementMeta) : 'Loading metadata...'}</span>
            {measurementMeta?.expansionEnabled && <span>Expansion: {expansionFactor}x</span>}
            <span>{annotations.length} annotation{annotations.length === 1 ? '' : 's'}</span>
            {selectedMeasurement && <span>Selected ruler: {selectedMeasurement}</span>}
          </div>
          <div className="viewer-statusbar-actions">
            <span className="text-[12px] text-[var(--text-subtle)]">{canAnnotate ? (dirty ? 'Auto-saving annotations...' : 'Annotations saved') : 'Read-only'}</span>
          </div>
        </div>
      </div>

      {!sidebarCollapsed && (
        <aside className="viewer-inspector w-80 flex-shrink-0 border-l flex flex-col min-h-0">
          <div className="viewer-inspector-tabs px-3 py-2 border-b flex items-center gap-1">
            <button onClick={() => setSidebarTab('annotations')}
              className={`ux-tab flex-1 min-w-0 ${sidebarTab === 'annotations' ? 'ux-tab-active' : ''}`}>
              <span className="truncate">Annotations</span>
            </button>
            <button onClick={() => setSidebarTab('channels')}
              className={`ux-tab flex-1 min-w-0 ${sidebarTab === 'channels' ? 'ux-tab-active' : ''}`}>
              <span className="truncate">Channels</span>
            </button>
            <button onClick={() => setSidebarTab('settings')}
              className={`ux-tab flex-1 min-w-0 ${sidebarTab === 'settings' ? 'ux-tab-active' : ''}`}>
              <span className="truncate">Settings</span>
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {sidebarTab === 'annotations' && (
              <div className="px-3 py-3 space-y-4">
                <div className="ux-card p-3 space-y-3">
                  <p className="ux-section-label">Annotations</p>
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <User size={12} className="text-gray-500" />
                          <span className="text-[12px] text-[var(--text-subtle)]">Annotation name</span>
                        </div>
                        <p className="mt-1 truncate text-[12px] font-semibold text-[var(--text)]">{annotator || 'Name not set'}</p>
                      </div>
                      {canAnnotate && (
                        <button
                          type="button"
                          onClick={() => {
                            setAnnotatorDraft(annotatorProfile)
                            setProfileMessage('')
                            setAnnotatorNameOpen(open => !open)
                          }}
                          className="ux-button ux-button-secondary min-h-0 px-3 py-1.5 text-[11px]"
                        >
                          {annotatorNameOpen ? 'Close' : 'Edit name'}
                        </button>
                      )}
                    </div>
                    {canAnnotate && annotatorNameOpen && (
                      <div className="rounded border border-[var(--border)] bg-[var(--surface-1)] p-2">
                        <div className="grid grid-cols-2 gap-2">
                          <input value={annotatorDraft.firstName} onChange={event => { annotatorEdited.current = true; setAnnotatorDraft(current => ({ ...current, firstName: event.target.value })); setProfileMessage('') }}
                            placeholder="First name"
                            className="ux-input" />
                          <input value={annotatorDraft.lastName} onChange={event => { annotatorEdited.current = true; setAnnotatorDraft(current => ({ ...current, lastName: event.target.value })); setProfileMessage('') }}
                            placeholder="Last name"
                            className="ux-input" />
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <button type="button" onClick={saveAnnotatorProfile} disabled={profileSaving || !annotatorDraft.firstName || !annotatorDraft.lastName} className="ux-button ux-button-primary min-h-0 px-3 py-1.5 text-[11px]">
                            {profileSaving ? 'Saving...' : 'Set'}
                          </button>
                          <button type="button" onClick={() => setAnnotatorDraft(annotatorProfile)} className="ux-button ux-button-secondary min-h-0 px-3 py-1.5 text-[11px]">
                            Reset
                          </button>
                          {profileMessage && <span className="text-[11px] text-[var(--text-subtle)]">{profileMessage}</span>}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="rounded border border-[var(--border)] bg-[var(--canvas-bg)]">
                    <button onClick={() => setShowAnnPanel(open => !open)}
                      className="flex w-full items-center justify-between px-3 py-2 text-[12px] text-[var(--text-muted)] hover:text-[var(--text)]">
                      <span className="flex items-center gap-2">
                        <List size={12} />
                        Annotations ({annotations.length})
                      </span>
                      {showAnnPanel ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </button>
                    {showAnnPanel && (
                      <div className="max-h-[65vh] overflow-y-auto px-2 pb-2 space-y-1">
                        {annotations.length === 0 ? (
                          <p className="py-2 text-center text-[12px] text-[var(--text-subtle)]">No annotations yet</p>
                        ) : annotations.map(annotation => {
                          const displayName = cleanDisplayName(annotation.annotator)
                          const timestamp = formatAnnotationTimestamp(annotation.timestamp)
                          const type = normalizedAnnotationType(annotation)
                          return (
                            <div key={annotation.id}
                              onClick={() => {
                                const targetZIndex = zIndexForAnnotation(annotation, zCount)
                                if (targetZIndex !== zIndex) commitZSlice(targetZIndex)
                                setSelectedId(annotation.id === selectedId ? null : annotation.id)
                              }}
                              className={`annotation-list-item ${annotation.id === selectedId ? 'annotation-list-item-selected' : ''}`}>
                              <span className="annotation-list-color" style={{ background: annotation.color }} />
                              <div className="min-w-0 flex-1">
                                <div className="annotation-list-summary">{annotationSummary(annotation)}</div>
                                <div className="annotation-list-meta">
                                  {displayName ? (
                                    <span className="annotation-author-chip" style={{ '--annotation-color': annotation.color || '#63a4d8' }}>
                                      <span className="annotation-author-avatar">{displayInitials(displayName)}</span>
                                      <span className="annotation-author-name">{displayName}</span>
                                    </span>
                                  ) : (
                                    <span className="annotation-list-muted">No author</span>
                                  )}
                                  {timestamp && <span className="annotation-list-time">{timestamp}</span>}
                                </div>
                              </div>
                              <div className="annotation-list-actions">
                                {canAnnotate && type === 'text' && (
                                  <button title="Edit text" onClick={event => { event.stopPropagation(); handleEditAnnotation(annotation.id) }}
                                    className="ux-icon-button h-8 w-8 flex-shrink-0">
                                    <Pencil size={12} />
                                  </button>
                                )}
                                {canAnnotate && (
                                  <button title="Delete" onClick={event => { event.stopPropagation(); deleteAnnotation(annotation.id) }}
                                    className="ux-icon-button h-8 w-8 flex-shrink-0 text-[var(--danger)]">
                                    <Trash2 size={12} />
                                  </button>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  {saveError && <p className="text-[12px] leading-snug text-red-300">{saveError}</p>}
                </div>
              </div>
            )}

            {sidebarTab === 'channels' && imageReady && (
              <ChannelControls
                meta={imgMeta}
                settings={channelSettings}
                channelStats={channelStats}
                onChange={setChannelSettings}
                onAutoChannel={applyAutoChannel}
              />
            )}

            {sidebarTab === 'settings' && (
              <div className="px-3 py-3 space-y-4">
                <div className="ux-card space-y-3 p-3">
                  <div className="flex items-center gap-2 text-[12px] font-semibold text-[var(--text)]">
                    <Settings size={13} /> Measurement settings
                  </div>

                  <label className="block">
                    <span className="mb-1 block text-[11px] text-[var(--text-subtle)]">Pixel size (µm/px)</span>
                    <input
                      type="number"
                      min="0.000001"
                      step="0.000001"
                      inputMode="decimal"
                      value={displayedMeasurementSettings.pixelSizeUm}
                      onChange={event => updateMeasurementSettings({ pixelSizeUm: event.currentTarget.value })}
                      className="ux-input font-mono"
                    />
                  </label>

                  <label className="flex items-center justify-between gap-3 rounded border border-[var(--border)] bg-[var(--canvas-bg)] px-3 py-2">
                    <span className="text-[12px] text-[var(--text-muted)]">Expanded sample</span>
                    <input
                      type="checkbox"
                      checked={expansionEnabled}
                      onChange={event => updateMeasurementSettings({ expansionEnabled: event.currentTarget.checked })}
                    />
                  </label>

                  {expansionEnabled && (
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-[var(--text-subtle)]">Expansion factor</span>
                      <input
                        type="number"
                        min="0.000001"
                        step="0.1"
                        inputMode="decimal"
                        value={displayedMeasurementSettings.expansionFactor}
                        onChange={event => updateMeasurementSettings({ expansionFactor: event.currentTarget.value })}
                        className="ux-input font-mono"
                      />
                    </label>
                  )}

                  <div className="rounded border border-[var(--border)] bg-[var(--canvas-bg)] p-3">
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-x-3 gap-y-2 text-[12px]">
                      <span className="text-[var(--text-muted)]">Source pixel size</span>
                      <span className="min-w-0 truncate text-right font-mono text-[var(--text)]" title={imgMeta ? formatPixelSize(imgMeta) : undefined}>
                        {imgMeta ? formatPixelSize(imgMeta) : 'Loading...'}
                      </span>
                      <span className="text-[var(--text-muted)]">Ruler unit</span>
                      <span className="font-mono text-[var(--text)]">{expansionEnabled ? 'nm' : 'µm'}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

          </div>
        </aside>
      )}

      <button
        type="button"
        onClick={() => setExportPanelOpen(open => !open)}
        className="fixed z-[55] ux-button ux-button-primary px-4 py-2 shadow-2xl"
        style={exportFloatingStyle}
        aria-expanded={exportPanelOpen}
      >
        <Download size={14} /> Export
      </button>

      {exportPanelOpen && (
        <div
          className="fixed z-[56] w-[360px] overflow-y-auto rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] p-4 shadow-2xl"
          style={exportPanelFloatingStyle}
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--text)]">Export</p>
              <p className="mt-1 text-[12px] leading-snug text-[var(--text-muted)]">Image notes and annotation export.</p>
            </div>
            <button
              type="button"
              onClick={() => setExportPanelOpen(false)}
              className="ux-icon-button h-8 w-8 flex-shrink-0"
              title="Close export"
            >
              <X size={14} />
            </button>
          </div>

          <div className="space-y-3">
            <div className="rounded border border-[var(--border)] bg-[var(--canvas-bg)] p-3">
              <p className="text-[12px] font-semibold text-[var(--text)]">Image summary</p>
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-[12px]">
                <span className="text-[var(--text-muted)]">Annotations</span>
                <span className="font-mono text-[var(--text)]">{annotations.length}</span>
                <span className="text-[var(--text-muted)]">Image size</span>
                <span className="font-mono text-[var(--text)]">
                  {imgMeta?.width && imgMeta?.height ? `${imgMeta.width} x ${imgMeta.height}` : 'Unknown'}
                </span>
                <span className="text-[var(--text-muted)]">Channels</span>
                <span className="font-mono text-[var(--text)]">{imgMeta?.channelCount || 1}</span>
              </div>
            </div>

            <label className="block">
              <span className="text-[12px] text-[var(--text-subtle)]">Note</span>
              <textarea
                value={reportNote}
                onChange={event => setReportNote(event.currentTarget.value)}
                rows={4}
                placeholder="Add note..."
                className="ux-input mt-1 resize-none"
              />
            </label>

            <button onClick={() => exportPDF(true)} disabled={exporting}
              className="ux-button ux-button-primary w-full">
              <Download size={13} /> Export annotated PDF
            </button>
            <button onClick={() => exportPDF(false)} disabled={exporting}
              className="ux-button ux-button-secondary w-full">
              <Download size={13} /> Export image-only PDF
            </button>
            {exportError && <p className="text-[12px] leading-snug text-red-300">{exportError}</p>}
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-3">
            <span className="ux-meta font-mono">v{APP_VERSION}</span>
            <button onClick={() => setShowAbout(true)}
              className="flex items-center gap-1 text-[12px] text-[var(--text-subtle)] transition-colors hover:text-gray-300">
              <Info size={12} /> About
            </button>
          </div>
        </div>
      )}

      {showAbout && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
          onClick={() => setShowAbout(false)}>
          <div className="ux-card w-80 p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-white">{APP_NAME}</h2>
                <span className="text-[10px] text-[var(--accent)] font-mono">v{APP_VERSION}</span>
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

      {showShortcuts && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
          onClick={() => setShowShortcuts(false)}>
          <div className="ux-card w-96 max-w-[90vw] p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between">
              <div className="flex items-center gap-2">
                <Keyboard size={16} className="text-[var(--accent)]" />
                <h2 className="text-sm font-semibold text-[var(--text)]">Keyboard shortcuts</h2>
              </div>
              <button onClick={() => setShowShortcuts(false)}
                className="text-gray-500 transition-colors hover:text-white">
                <X size={14} />
              </button>
            </div>
            <div className="space-y-1.5">
              {KEYBOARD_SHORTCUTS.map(shortcut => (
                <div key={shortcut.action} className="flex items-center justify-between gap-3 py-1">
                  <span className="text-[12px] text-[var(--text-muted)]">{shortcut.action}</span>
                  <span className="flex flex-shrink-0 items-center gap-1">
                    {shortcut.keys.map(key => (
                      <kbd key={key} className="rounded border border-[var(--border-strong)] bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text)]">
                        {key}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
            <button onClick={() => setShowShortcuts(false)}
              className="ux-button ux-button-secondary mt-5 w-full">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
