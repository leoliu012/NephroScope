import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeftRight,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Check,
  Crosshair,
  FolderOpen,
  Info,
  Loader2,
  Ruler,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react'
import EfImagePanel from './EfImagePanel.jsx'
import { APP_NAME } from '../appInfo.js'
import { authFetch } from '../auth.js'
import { collaborationClientId, fetchViewState, updateViewState } from '../collaboration.js'
import {
  autoWindowChannelSettings,
  createDefaultChannelSettings,
  loadChannelSettings,
  normalizeChannelSettings,
  saveChannelSettings,
} from '../channelDisplay.js'
import { DEFAULT_PIXEL_SIZE_UM } from '../measurement.js'
import {
  computeLinePairRow,
  summarizeLinePairs,
  consistencyForEf,
  heatColor,
  heatColorSoft,
  formatEf,
  formatMicronLength,
} from '../expansionCalibration.js'

const API = '/agh/api'
const RESEARCH_USE_NOTICE = 'Research use only. Not validated for clinical diagnosis or treatment decisions.'
const MEASUREMENT_SETTINGS_PREFIX = 'agh-viewer:measurement-settings:v1:'
const IMAGE_ACCEPT = '.tif,.tiff,.nd2'
const RECOMMENDED_PAIRS = 3

const STEPS = [
  { id: 'select', label: 'Choose images' },
  { id: 'draw', label: 'Draw line pairs' },
  { id: 'apply', label: 'Apply factor' },
]

function measurementSettingsKey(caseId, filename) {
  return `${MEASUREMENT_SETTINGS_PREFIX}${encodeURIComponent(caseId)}/${encodeURIComponent(filename)}`
}

function caseFileBase(caseId, filename) {
  return `${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}`
}

function apiBaseFor(source) {
  if (!source) return null
  return source.origin === 'upload'
    ? `${API}/ef/uploads/${source.uploadId}`
    : caseFileBase(source.caseId, source.filename)
}

async function fetchJson(url, options = {}) {
  const res = await authFetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
  return body
}

function metaPixelSize(meta) {
  const value = Number(meta?.pixelSizeXUm ?? meta?.pixelSizeUm)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PIXEL_SIZE_UM
}

function metaSummary(meta) {
  if (!meta) return ''
  const parts = []
  if (meta.width && meta.height) parts.push(`${meta.width}×${meta.height}`)
  if (meta.channelCount) parts.push(`${meta.channelCount}ch`)
  if (Number(meta.zCount) > 1) parts.push(`${meta.zCount}z`)
  if (meta.sourceFormat) parts.push(meta.sourceFormat)
  return parts.join(' · ')
}

function imageFileType(filename, meta) {
  const format = String(meta?.sourceFormat || '').trim().toLowerCase()
  const extMatch = String(filename || '').match(/\.([^.]+)$/)
  const ext = (extMatch?.[1] || '').toLowerCase()
  const value = format || ext
  if (value.includes('nd2') || ext === 'nd2') return { label: 'ND2', kind: 'nd2' }
  if (value.includes('nh2') || ext === 'nh2') return { label: 'NH2', kind: 'nh2' }
  if (value.includes('tiff') || ext === 'tiff') return { label: 'TIFF', kind: 'tiff' }
  if (value.includes('tif') || ext === 'tif') return { label: 'TIF', kind: 'tif' }
  return { label: ext ? ext.toUpperCase() : 'IMAGE', kind: 'other' }
}

function imageZTag(meta, loading = false) {
  if (loading || !meta) return { label: 'Z loading', kind: 'unknown' }
  const zCount = Number(meta.zCount)
  if (Number.isFinite(zCount) && zCount > 1) return { label: `${zCount} z slices`, kind: 'multi' }
  return { label: 'single z', kind: 'single' }
}

function ImageTags({ filename, meta, loading = false }) {
  const typeTag = imageFileType(filename, meta)
  const zTag = imageZTag(meta, loading)
  return (
    <span className="image-tags">
      <span className={`image-tag image-tag-type image-tag-type-${typeTag.kind}`}>
        <span className="image-tag-prefix">Type</span>
        <span>{typeTag.label}</span>
      </span>
      <span className={`image-tag image-tag-z image-tag-z-${zTag.kind}`}>
        <span className="image-tag-prefix">Z</span>
        <span>{zTag.label}</span>
      </span>
    </span>
  )
}

function parseHexColor(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(value || '')
  const hex = match ? match[1] : 'ffffff'
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  }
}

function colorDistance(a, b) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)
}

function chooseLineColor(...settingsGroups) {
  const visibleColors = settingsGroups
    .flatMap(settings => settings || [])
    .filter(setting => setting?.visible !== false)
    .map(setting => parseHexColor(setting.color))

  const candidates = ['#facc15', '#38bdf8', '#fb7185', '#ffffff', '#22c55e', '#f97316', '#c084fc']
  if (!visibleColors.length) return candidates[0]

  let best = candidates[0]
  let bestScore = -Infinity
  for (const candidate of candidates) {
    const rgb = parseHexColor(candidate)
    const nearestChannel = Math.min(...visibleColors.map(color => colorDistance(rgb, color)))
    const brightness = (rgb.r * 0.299) + (rgb.g * 0.587) + (rgb.b * 0.114)
    const score = nearestChannel + (brightness * 0.35)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

function selectWidthCh(values, placeholder) {
  const longest = [placeholder, ...(values || [])]
    .map(value => String(value || '').length)
    .reduce((max, length) => Math.max(max, length), 0)
  return `${Math.min(72, Math.max(18, longest + 5))}ch`
}

// Per-image display state (channels + Z), shared across the choose and draw
// steps and rendered through the same pipeline as the viewer.
function useEfImageState(source, clientId) {
  const meta = source?.meta || null
  const apiBase = apiBaseFor(source)
  const zCount = Math.max(1, Number(meta?.zCount) || 1)
  const key = apiBase || ''
  const [z, setZ] = useState(0)
  const [channelSettings, setChannelSettings] = useState(null)
  const [channelStats, setChannelStats] = useState(null)
  const [readyToPublish, setReadyToPublish] = useState(false)
  const autoApplied = useRef(false)

  useEffect(() => {
    let active = true
    setReadyToPublish(false)
    if (!meta) { setChannelSettings(null); setChannelStats(null); return undefined }
    const fallback = source.origin === 'case'
      ? loadChannelSettings(source.caseId, source.filename, meta)
      : createDefaultChannelSettings(meta)
    setChannelSettings(fallback)
    setChannelStats(null)
    autoApplied.current = false
    setZ(0)
    if (source.origin === 'case') {
      fetchViewState(source.caseId, source.filename)
        .then(state => {
          if (!active || !state?.channelSettings) return
          setChannelSettings(normalizeChannelSettings(state.channelSettings, meta))
        })
        .catch(() => {})
        .finally(() => { if (active) setReadyToPublish(true) })
    } else {
      setReadyToPublish(false)
    }
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (source?.origin !== 'case' || !readyToPublish || !channelSettings) return undefined
    saveChannelSettings(source.caseId, source.filename, channelSettings)
    const id = window.setTimeout(() => {
      updateViewState(source.caseId, source.filename, { clientId, channelSettings }).catch(() => {})
    }, 350)
    return () => window.clearTimeout(id)
  }, [source?.origin, source?.caseId, source?.filename, readyToPublish, channelSettings, clientId])

  useEffect(() => {
    if (!meta || !channelSettings || !channelStats || autoApplied.current) return
    autoApplied.current = true
    setChannelSettings(current => autoWindowChannelSettings(current, channelStats, meta, { onlyUninitialized: true }))
  }, [meta, channelSettings, channelStats])

  const applyAuto = useCallback((index) => {
    setChannelSettings(current => autoWindowChannelSettings(current, channelStats, meta, { channelIndex: index, advanceAutoStep: true }))
  }, [channelStats, meta])

  return { meta, apiBase, zCount, z, setZ, channelSettings, setChannelSettings, channelStats, setChannelStats, applyAuto }
}

// ---------------------------------------------------------------------------
// Source picker (one per side): existing case image or a local upload.
// ---------------------------------------------------------------------------
function SourcePicker({ side, title, cases, source, onPick, onClear }) {
  const [mode, setMode] = useState('case')
  const [caseId, setCaseId] = useState('')
  const [files, setFiles] = useState([])
  const [fileMetaByName, setFileMetaByName] = useState({})
  const [filename, setFilename] = useState('')
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!caseId) { setFiles([]); setFileMetaByName({}); return undefined }
    const controller = new AbortController()
    setBusy(true)
    setError(null)
    setFileMetaByName({})
    fetchJson(`${API}/cases/${encodeURIComponent(caseId)}/files`, { signal: controller.signal })
      .then(data => setFiles(data.files || []))
      .catch(err => { if (err.name !== 'AbortError') setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [caseId])

  useEffect(() => {
    if (!caseId || !files.length) return undefined
    const controller = new AbortController()
    let cancelled = false

    async function loadFileMetadata() {
      const batchSize = 6
      for (let index = 0; index < files.length && !cancelled; index += batchSize) {
        const batch = files.slice(index, index + batchSize)
        // eslint-disable-next-line no-await-in-loop
        const loaded = await Promise.all(batch.map(async item => {
          try {
            const meta = await fetchJson(`${caseFileBase(caseId, item)}/meta`, { signal: controller.signal })
            return [item, meta]
          } catch (err) {
            if (err.name === 'AbortError') return null
            return [item, null]
          }
        }))
        if (cancelled || controller.signal.aborted) return
        setFileMetaByName(current => {
          const next = { ...current }
          for (const item of loaded) {
            if (item) next[item[0]] = item[1]
          }
          return next
        })
      }
    }

    loadFileMetadata()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [caseId, files])

  const pickCaseFile = useCallback(async (chosen) => {
    setFilename(chosen)
    setFileMenuOpen(false)
    if (!chosen) return
    setBusy(true)
    setError(null)
    try {
      const meta = fileMetaByName[chosen] || await fetchJson(`${caseFileBase(caseId, chosen)}/meta`)
      onPick({ origin: 'case', caseId, filename: chosen, label: chosen, meta })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [caseId, fileMetaByName, onPick])

  const uploadFile = useCallback(async (file) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const result = await fetchJson(`${API}/ef/uploads`, { method: 'POST', body: form })
      onPick({ origin: 'upload', uploadId: result.uploadId, label: result.originalName, meta: result.meta })
    } catch (err) {
      setError(err.message || 'Upload failed')
    } finally {
      setBusy(false)
    }
  }, [onPick])

  const badgeColor = side === 'A' ? 'var(--accent)' : '#a855f7'
  const caseSelectWidth = selectWidthCh(cases, 'Select a case...')
  const fileSelectWidth = selectWidthCh(files, busy ? 'Loading...' : 'Select an image...')
  const selectedMetaKnown = filename ? Object.prototype.hasOwnProperty.call(fileMetaByName, filename) : false

  if (source) {
    return (
      <div className="ef-source ef-source-chosen">
        <div className="ef-source-head">
          <span className="ef-source-badge" style={{ borderColor: badgeColor }}>{side}</span>
          <span className="ef-source-role">{title}</span>
        </div>
        <p className="ef-source-name" title={source.label}>{source.label}</p>
        <ImageTags filename={source.label || source.filename} meta={source.meta} />
        <p className="ef-source-meta">
          {source.origin === 'upload' ? 'Uploaded · ' : `Case ${source.caseId} · `}{metaSummary(source.meta)}
        </p>
        {source.meta?.pixelSizeIsDefault && (
          <p className="ef-source-warn"><TriangleAlert size={12} /> No pixel calibration in metadata</p>
        )}
        <button type="button" className="ux-button ux-button-ghost mt-2" onClick={onClear}>Change</button>
      </div>
    )
  }

  return (
    <div className="ef-source">
      <div className="ef-source-head">
        <span className="ef-source-badge" style={{ borderColor: badgeColor }}>{side}</span>
        <span className="ef-source-role">{title}</span>
      </div>
      <div className="ef-source-tabs">
        <button type="button" className={`ux-tab ${mode === 'case' ? 'ux-tab-active' : ''}`} onClick={() => setMode('case')}>
          <FolderOpen size={12} /> From case
        </button>
        <button type="button" className={`ux-tab ${mode === 'upload' ? 'ux-tab-active' : ''}`} onClick={() => setMode('upload')}>
          <Upload size={12} /> Upload
        </button>
      </div>

      {mode === 'case' ? (
        <div className="ef-source-selects">
          <select className="ux-select ef-source-select" style={{ width: caseSelectWidth }} value={caseId} onChange={e => { setCaseId(e.target.value); setFilename('') }}>
            <option value="">Select a case…</option>
            {cases.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
          <div className="ef-file-picker" style={{ width: fileSelectWidth }}>
            <button
              type="button"
              className="ux-select ef-file-picker-button"
              disabled={!caseId || busy}
              onClick={() => setFileMenuOpen(open => !open)}
            >
              <span className="ef-file-picker-title">{filename || (busy ? 'Loading...' : 'Select an image...')}</span>
              {filename && <ImageTags filename={filename} meta={fileMetaByName[filename]} loading={!selectedMetaKnown} />}
            </button>
            {fileMenuOpen && caseId && !busy && (
              <div className="ef-file-picker-menu">
                {files.map(item => {
                  const metaKnown = Object.prototype.hasOwnProperty.call(fileMetaByName, item)
                  return (
                    <button
                      key={item}
                      type="button"
                      className={`ef-file-picker-option ${filename === item ? 'ef-file-picker-option-selected' : ''}`}
                      onClick={() => pickCaseFile(item)}
                    >
                      <span className="ef-file-picker-name">{item}</span>
                      <ImageTags filename={item} meta={fileMetaByName[item]} loading={!metaKnown} />
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        <label className="ef-upload-drop">
          <input type="file" accept={IMAGE_ACCEPT} className="hidden" onChange={e => uploadFile(e.target.files?.[0])} />
          {busy ? (
            <span className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Uploading & reading metadata…</span>
          ) : (
            <span className="flex flex-col items-center gap-1 text-center">
              <Upload size={18} />
              <span className="text-[12px] text-[var(--text)]">Choose a .tif / .tiff / .nd2 file</span>
              <span className="text-[11px] text-[var(--text-subtle)]">Stays local to this calibration — not added to any case</span>
            </span>
          )}
        </label>
      )}
      {error && <p className="ef-source-warn mt-2"><TriangleAlert size={12} /> {error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Viewer-grade preview (channels + Z + zoom) plus pixel size.
// ---------------------------------------------------------------------------
function ImagePreviewCalibration({ side, title, subtitle, imageState, pixelInput, setPixelInput }) {
  const meta = imageState.meta
  const isDefault = Boolean(meta?.pixelSizeIsDefault)
  const detected = metaPixelSize(meta)
  return (
    <div className="ef-setup-column">
      <EfImagePanel
        side={side}
        title={title}
        subtitle={subtitle}
        apiBase={imageState.apiBase}
        meta={meta}
        zCount={imageState.zCount}
        zIndex={imageState.z}
        onZChange={imageState.setZ}
        channelSettings={imageState.channelSettings}
        onChannelSettingsChange={imageState.setChannelSettings}
        channelStats={imageState.channelStats}
        onChannelStats={imageState.setChannelStats}
        onAutoChannel={imageState.applyAuto}
        pixelSizeUm={Number(pixelInput) || 0}
        drawingEnabled={false}
      />
      <div className="ef-setup-calibration">
        <span className="ef-field-label">
          Pixel size (µm/px){isDefault && <span className="ef-field-required"> — required, no metadata found</span>}
        </span>
        <div className="flex items-center gap-2">
          <input
            type="number" min="0.000001" step="0.000001" inputMode="decimal"
            className="ux-input font-mono"
            placeholder={isDefault ? String(detected) : undefined}
            value={pixelInput}
            onChange={e => setPixelInput(e.currentTarget.value)}
          />
          {isDefault && (
            <button type="button" className="ux-button ux-button-ghost whitespace-nowrap" onClick={() => setPixelInput(String(detected))} title="Fill with the app default">
              Use {detected}
            </button>
          )}
        </div>
        {!isDefault
          ? <p className="ef-field-hint">Detected from {meta?.pixelSizeSource || 'metadata'}. Edit if you know a better value.</p>
          : <p className="ef-field-hint ef-field-hint-warn"><TriangleAlert size={11} /> No calibration in this image. Enter the correct pixel size — the default is only a placeholder.</p>}
      </div>
    </div>
  )
}

function SelectColumn({ side, title, previewTitle, cases, source, imageState, pixelInput, setPixelInput, onPick, onClear }) {
  return (
    <div className="ef-select-column">
      <SourcePicker side={side} title={title} cases={cases} source={source} onPick={onPick} onClear={onClear} />
      {source && (
        <ImagePreviewCalibration
          side={side}
          title={previewTitle}
          subtitle={source.label}
          imageState={imageState}
          pixelInput={pixelInput}
          setPixelInput={setPixelInput}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page.
// ---------------------------------------------------------------------------
export default function ExpansionCalibrationPage({ cases = [], onClose }) {
  const [step, setStep] = useState('select')
  const clientId = useRef(collaborationClientId()).current

  const [sourceA, setSourceA] = useState(null)
  const [sourceB, setSourceB] = useState(null)
  const [pixelA, setPixelA] = useState('')
  const [pixelB, setPixelB] = useState('')

  const [pairs, setPairs] = useState([])
  const [draft, setDraft] = useState({ A: null, B: null })
  const [selectedPairId, setSelectedPairId] = useState(null)
  const [lineColor, setLineColor] = useState('#facc15')
  const [lineThickness, setLineThickness] = useState(2.8)
  const lineColorEdited = useRef(false)
  const nextPairId = useRef(1)

  const imgA = useEfImageState(sourceA, clientId)
  const imgB = useEfImageState(sourceB, clientId)

  const pxA = Number(pixelA)
  const pxB = Number(pixelB)

  const autoLineColor = useMemo(() => chooseLineColor(imgA.channelSettings, imgB.channelSettings), [imgA.channelSettings, imgB.channelSettings])

  useEffect(() => {
    if (!lineColorEdited.current) setLineColor(autoLineColor)
  }, [autoLineColor])

  const seedPixel = useCallback((source, setter) => {
    if (!source) { setter(''); return }
    setter(String(metaPixelSize(source.meta)))
  }, [])

  const resetPairs = useCallback(() => {
    setPairs([])
    setDraft({ A: null, B: null })
    setSelectedPairId(null)
  }, [])

  const pickA = useCallback(src => { setSourceA(src); seedPixel(src, setPixelA); resetPairs() }, [resetPairs, seedPixel])
  const pickB = useCallback(src => { setSourceB(src); seedPixel(src, setPixelB); resetPairs() }, [resetPairs, seedPixel])
  const clearA = useCallback(() => { setSourceA(null); seedPixel(null, setPixelA); resetPairs() }, [resetPairs, seedPixel])
  const clearB = useCallback(() => { setSourceB(null); seedPixel(null, setPixelB); resetPairs() }, [resetPairs, seedPixel])

  const swapSources = useCallback(() => {
    setSourceA(sourceB)
    setSourceB(sourceA)
    setPixelA(pixelB)
    setPixelB(pixelA)
    setDraft(current => ({ A: current.B, B: current.A }))
    setPairs(current => current.map(pair => ({ ...pair, a: pair.b, b: pair.a })))
    setSelectedPairId(null)
  }, [pixelA, pixelB, sourceA, sourceB])

  useEffect(() => {
    if (draft.A && draft.B) {
      const id = nextPairId.current
      nextPairId.current += 1
      setPairs(prev => [...prev, { id, a: draft.A, b: draft.B }])
      setDraft({ A: null, B: null })
      setSelectedPairId(id)
    }
  }, [draft])

  const rows = useMemo(() => {
    const computed = pairs.map(pair => ({ pair, ...computeLinePairRow({ a: pair.a, b: pair.b, pxA, pxB }) }))
    const summary = summarizeLinePairs(computed.map(row => row.ef))
    const medianEf = summary?.efMedian
    const withConsistency = computed.map(row => ({ ...row, consistency: consistencyForEf(row.ef, medianEf) }))
    return { computed: withConsistency, summary, medianEf }
  }, [pairs, pxA, pxB])

  const deletePair = useCallback((pairId) => {
    setPairs(prev => prev.filter(p => p.id !== pairId))
    setSelectedPairId(current => (current === pairId ? null : current))
  }, [])

  useEffect(() => {
    if (step !== 'draw') return undefined
    const onKeyDown = event => {
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedPairId != null) {
        event.preventDefault()
        deletePair(selectedPairId)
      } else if (event.key === 'Escape') {
        if (draft.A || draft.B) setDraft({ A: null, B: null })
        else setSelectedPairId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [step, selectedPairId, draft, deletePair])

  const linesFor = useCallback((sideKey) => {
    const lines = rows.computed.map((row, index) => {
      const geom = sideKey === 'A' ? row.pair.a : row.pair.b
      return { id: `${row.pair.id}:${sideKey}`, p0: geom.p0, p1: geom.p1, color: lineColor, labelPrefix: `#${index + 1}` }
    })
    const pending = draft[sideKey]
    if (pending) lines.push({ id: `pending:${sideKey}`, p0: pending.p0, p1: pending.p1, color: lineColor, pending: true, labelPrefix: 'pending' })
    return lines
  }, [rows.computed, draft, lineColor])

  const handleDraw = useCallback((sideKey, line) => { setDraft(prev => ({ ...prev, [sideKey]: line })) }, [])

  const handleUpdateLine = useCallback((lineId, patch) => {
    const [head, sideKey] = lineId.split(':')
    if (head === 'pending') { setDraft(prev => ({ ...prev, [sideKey]: { ...prev[sideKey], ...patch } })); return }
    const pairId = Number(head)
    const key = sideKey === 'A' ? 'a' : 'b'
    setPairs(prev => prev.map(p => (p.id === pairId ? { ...p, [key]: { ...p[key], ...patch } } : p)))
  }, [])

  const handleSelectLine = useCallback((lineId) => {
    if (!lineId) { setSelectedPairId(null); return }
    const [head] = lineId.split(':')
    if (head === 'pending') return
    setSelectedPairId(Number(head))
  }, [])

  const setupReady = sourceA && sourceB
  const calibrationReady = pxA > 0 && pxB > 0
  const canApply = pairs.length >= 1
  const visibleSteps = STEPS

  const currentStepIndex = visibleSteps.findIndex(s => s.id === step)

  return (
    <div className="ef-page">
      <header className="app-header flex flex-shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={onClose} className="ux-button ux-button-ghost" title="Back to browser">
            <ChevronLeft size={14} /> Back
          </button>
          <span className="app-brand-mark"><Crosshair size={15} /></span>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold leading-tight text-[var(--text)]">Expansion factor calibration</h1>
            <p className="text-[11px] leading-tight text-[var(--text-subtle)]">Measure matched line pairs to estimate the linear expansion factor · {APP_NAME}</p>
          </div>
        </div>
        <nav className="ef-steps">
          {visibleSteps.map((item, index) => {
            const active = item.id === step
            const done = currentStepIndex > index
            return (
              <div key={item.id} className={`ef-step ${active ? 'ef-step-active' : ''} ${done ? 'ef-step-done' : ''}`}>
                <span className="ef-step-index">{done ? <Check size={12} /> : index + 1}</span>
                <span className="ef-step-label">{item.label}</span>
              </div>
            )
          })}
        </nav>
      </header>
      <div className="border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-1.5 text-center text-[11px] font-semibold text-[var(--danger)]">
        {RESEARCH_USE_NOTICE}
      </div>

      <div className="ef-page-body">
        {(step === 'select' || step === 'draw') && (
          <div className="ef-swap-row">
            <button type="button" className="ux-button ux-button-secondary" onClick={swapSources} disabled={!sourceA || !sourceB}>
              <ArrowLeftRight size={14} /> Swap expanded/reference
            </button>
          </div>
        )}

        {step === 'select' && (
          <div className="ef-select-grid">
            <SelectColumn
              side="A"
              title="Expanded sample (10X)"
              previewTitle="Expanded sample"
              cases={cases}
              source={sourceA}
              imageState={imgA}
              pixelInput={pixelA}
              setPixelInput={setPixelA}
              onPick={pickA}
              onClear={clearA}
            />
            <SelectColumn
              side="B"
              title="Reference / unexpanded (60X)"
              previewTitle="Reference sample"
              cases={cases}
              source={sourceB}
              imageState={imgB}
              pixelInput={pixelB}
              setPixelInput={setPixelB}
              onPick={pickB}
              onClear={clearB}
            />
          </div>
        )}

        {step === 'draw' && (
          <div className="ef-draw-layout">
            <div className="ef-draw-canvases">
              <EfImagePanel
                side="A" title="Expanded sample" subtitle={sourceA?.label}
                apiBase={imgA.apiBase} meta={imgA.meta} zCount={imgA.zCount} zIndex={imgA.z} onZChange={imgA.setZ}
                channelSettings={imgA.channelSettings} onChannelSettingsChange={imgA.setChannelSettings}
                channelStats={imgA.channelStats} onChannelStats={imgA.setChannelStats} onAutoChannel={imgA.applyAuto}
                pixelSizeUm={pxA} drawingEnabled={!draft.A} lines={linesFor('A')}
                lineColor={lineColor}
                lineThickness={lineThickness}
                selectedId={selectedPairId != null ? `${selectedPairId}:A` : null}
                onSelectLine={handleSelectLine} onDraw={line => handleDraw('A', line)} onUpdateLine={handleUpdateLine}
                emptyHint="Click twice or drag to draw a line"
              />
              <EfImagePanel
                side="B" title="Reference sample" subtitle={sourceB?.label}
                apiBase={imgB.apiBase} meta={imgB.meta} zCount={imgB.zCount} zIndex={imgB.z} onZChange={imgB.setZ}
                channelSettings={imgB.channelSettings} onChannelSettingsChange={imgB.setChannelSettings}
                channelStats={imgB.channelStats} onChannelStats={imgB.setChannelStats} onAutoChannel={imgB.applyAuto}
                pixelSizeUm={pxB} drawingEnabled={!draft.B} lines={linesFor('B')}
                lineColor={lineColor}
                lineThickness={lineThickness}
                selectedId={selectedPairId != null ? `${selectedPairId}:B` : null}
                onSelectLine={handleSelectLine} onDraw={line => handleDraw('B', line)} onUpdateLine={handleUpdateLine}
                emptyHint="Click twice or drag to draw a line"
              />
            </div>
            <aside className="ef-draw-sidebar">
              <EfSummaryCard summary={rows.summary} />
              <div className="ef-draw-instructions">
                <p><span className="ef-kbd">Space</span>+drag pans · wheel zooms · <span className="ef-kbd">Del</span> deletes selected pair.</p>
              </div>
              <div className="ef-line-style-card">
                <div className="flex items-center justify-between gap-2">
                  <span className="ef-summary-label">Line style</span>
                  <button
                    type="button"
                    className="ux-button ux-button-ghost min-h-0 px-2 py-1 text-[11px]"
                    onClick={() => { lineColorEdited.current = false; setLineColor(autoLineColor) }}
                  >
                    Auto
                  </button>
                </div>
                <label className="ef-line-style-row">
                  <span>Color</span>
                  <input
                    type="color"
                    value={lineColor}
                    onChange={event => { lineColorEdited.current = true; setLineColor(event.currentTarget.value) }}
                    className="annotation-color-input"
                  />
                </label>
                <label className="ef-line-style-row">
                  <span>Thickness</span>
                  <input
                    type="range"
                    min={1}
                    max={8}
                    step={0.5}
                    value={lineThickness}
                    onChange={event => setLineThickness(Number(event.currentTarget.value))}
                    className="annotation-range"
                  />
                  <em>{lineThickness}px</em>
                </label>
              </div>
              <PairTable rows={rows.computed} selectedPairId={selectedPairId} onSelect={setSelectedPairId} onDelete={deletePair} />
              {pairs.length > 0 && pairs.length < RECOMMENDED_PAIRS && (
                <p className="ef-pending-note"><Info size={12} /> Draw at least {RECOMMENDED_PAIRS} pairs for a stable median.</p>
              )}
              {pairs.length > 0 && (
                <button type="button" className="ux-button ux-button-ghost mt-2" onClick={() => { setPairs([]); setDraft({ A: null, B: null }); setSelectedPairId(null) }}>
                  <Trash2 size={13} /> Clear all pairs
                </button>
              )}
            </aside>
          </div>
        )}

        {step === 'apply' && (
          <ApplyStep cases={cases} clientId={clientId} medianEf={rows.medianEf} summary={rows.summary} onDone={onClose} />
        )}
      </div>

      <footer className="ef-page-footer">
        <div>
          {step !== 'select' && (
            <button type="button" className="ux-button ux-button-ghost" onClick={() => setStep(visibleSteps[currentStepIndex - 1].id)}>
              <ChevronLeft size={14} /> Back
            </button>
          )}
        </div>
        <div className="ef-footer-right">
          {step === 'select' && (
            <button type="button" className="ux-button ux-button-primary" disabled={!setupReady || !calibrationReady} onClick={() => setStep('draw')}
              title={!setupReady ? 'Choose both images first' : calibrationReady ? undefined : 'Enter a pixel size for both images first'}>
              Continue <ChevronRight size={14} />
            </button>
          )}
          {step === 'draw' && (
            <button type="button" className="ux-button ux-button-primary" disabled={!canApply} onClick={() => setStep('apply')}
              title={canApply ? undefined : 'Draw at least one line pair'}>
              Choose where to apply <ArrowRight size={14} />
            </button>
          )}
        </div>
      </footer>
    </div>
  )
}

function EfSummaryCard({ summary }) {
  return (
    <div className="ef-summary-card">
      <p className="ef-summary-label">Median expansion factor</p>
      <p className="ef-summary-value">{summary ? formatEf(summary.efMedian) : '—'}</p>
      {summary ? (
        <div className="ef-summary-stats">
          <span>n = {summary.nPairs}</span>
          <span>IQR {formatEf(summary.efQ1)}–{formatEf(summary.efQ3)}</span>
          {Number.isFinite(summary.efMadRobust) && <span>MAD {formatEf(summary.efMadRobust)}</span>}
          {Number.isFinite(summary.cvPercent) && <span>CV {summary.cvPercent.toFixed(1)}%</span>}
          {Number.isFinite(summary.medianCi95Low) && <span>95% CI {formatEf(summary.medianCi95Low)}–{formatEf(summary.medianCi95High)}</span>}
        </div>
      ) : (
        <p className="ef-summary-empty">Draw line pairs to compute the factor</p>
      )}
      <div className="ef-heat-legend">
        <span className="ef-heat-title">Consistency</span>
        <span className="ef-heat-bar" />
        <span className="ef-heat-ends"><em style={{ color: heatColor(0) }}>match</em><em style={{ color: heatColor(1) }}>outlier</em></span>
      </div>
    </div>
  )
}

function PairTable({ rows, selectedPairId, onSelect, onDelete }) {
  if (!rows.length) return <p className="ef-table-empty">No line pairs yet.</p>
  return (
    <div className="ef-table-wrap">
      <table className="ef-table">
        <thead>
          <tr><th>#</th><th>Len A</th><th>Len B</th><th>EF</th><th>Δ%</th><th aria-label="delete" /></tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const selected = row.pair.id === selectedPairId
            const relPct = Number.isFinite(row.consistency.relativeDeviation) ? `${(row.consistency.relativeDeviation * 100).toFixed(1)}%` : '—'
            return (
              <tr
                key={row.pair.id}
                className={`ef-table-row ${selected ? 'ef-table-row-selected' : ''}`}
                style={{ background: selected ? undefined : heatColorSoft(row.consistency.score) }}
                onClick={() => onSelect(row.pair.id)}
                title={row.qualityNote}
              >
                <td><span className="ef-dot" style={{ background: row.consistency.color }} />{index + 1}</td>
                <td className="font-mono">{formatMicronLength(row.lenAum)}</td>
                <td className="font-mono">{formatMicronLength(row.lenBum)}</td>
                <td className="font-mono font-semibold">{formatEf(row.ef)}</td>
                <td className="font-mono">{relPct}</td>
                <td>
                  <button type="button" className="ux-icon-button ef-row-delete" title="Delete pair"
                    onClick={event => { event.stopPropagation(); onDelete(row.pair.id) }}>
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ApplyStep({ cases, clientId, medianEf, summary, onDone }) {
  const [targetCase, setTargetCase] = useState('')
  const [files, setFiles] = useState([])
  const [fileMetaByName, setFileMetaByName] = useState({})
  const [selected, setSelected] = useState(() => new Set())
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const caseSelectWidthCh = useMemo(() => {
    const longest = cases.reduce((max, item) => Math.max(max, String(item).length), 'Select a case...'.length)
    return Math.min(longest + 5, 82)
  }, [cases])

  useEffect(() => {
    if (!targetCase) { setFiles([]); setFileMetaByName({}); setSelected(new Set()); return undefined }
    const controller = new AbortController()
    setLoadingFiles(true)
    setError(null)
    setFileMetaByName({})
    fetchJson(`${API}/cases/${encodeURIComponent(targetCase)}/files`, { signal: controller.signal })
      .then(data => { setFiles(data.files || []); setSelected(new Set()) })
      .catch(err => { if (err.name !== 'AbortError') setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoadingFiles(false) })
    return () => controller.abort()
  }, [targetCase])

  useEffect(() => {
    if (!targetCase || !files.length) return undefined
    const controller = new AbortController()
    let cancelled = false

    async function loadFileMetadata() {
      const batchSize = 6
      for (let index = 0; index < files.length && !cancelled; index += batchSize) {
        const batch = files.slice(index, index + batchSize)
        // eslint-disable-next-line no-await-in-loop
        const loaded = await Promise.all(batch.map(async filename => {
          try {
            const meta = await fetchJson(`${caseFileBase(targetCase, filename)}/meta`, { signal: controller.signal })
            return [filename, meta]
          } catch (err) {
            if (err.name === 'AbortError') return null
            return [filename, null]
          }
        }))
        if (cancelled || controller.signal.aborted) return
        setFileMetaByName(current => {
          const next = { ...current }
          for (const item of loaded) {
            if (item) next[item[0]] = item[1]
          }
          return next
        })
      }
    }

    loadFileMetadata()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [targetCase, files])

  const toggle = useCallback((filename) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(filename)) next.delete(filename)
      else next.add(filename)
      return next
    })
  }, [])

  const applyToFile = useCallback(async (caseId, filename) => {
    let meta = null
    try { meta = await fetchJson(`${caseFileBase(caseId, filename)}/meta`) } catch { /* fall back below */ }
    let existing = null
    try { existing = await fetchViewState(caseId, filename) } catch { /* first-time target */ }
    const existingPixel = existing?.measurementSettings?.pixelSizeUm
    const pixelSizeUm = String(existingPixel != null && Number(existingPixel) > 0 ? existingPixel : metaPixelSize(meta))
    const settings = { pixelSizeUm, expansionEnabled: true, expansionFactor: String(medianEf) }
    try { localStorage.setItem(measurementSettingsKey(caseId, filename), JSON.stringify(settings)) } catch { /* storage optional */ }
    await updateViewState(caseId, filename, { clientId, measurementSettings: settings })
  }, [clientId, medianEf])

  const apply = useCallback(async () => {
    if (!targetCase || selected.size === 0) return
    setApplying(true)
    setError(null)
    setResult(null)
    const applied = []
    const failed = []
    for (const filename of selected) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await applyToFile(targetCase, filename)
        applied.push(filename)
      } catch (err) {
        failed.push({ filename, error: err.message })
      }
    }
    setApplying(false)
    setResult({ applied, failed })
  }, [applyToFile, selected, targetCase])

  if (!Number.isFinite(medianEf)) {
    return <p className="ef-table-empty">No expansion factor computed yet — go back and draw line pairs.</p>
  }

  return (
    <div className="ef-apply">
      <div className="ef-apply-value">
        <p className="ef-summary-label">Expansion factor to apply</p>
        <p className="ef-summary-value">{formatEf(medianEf)}</p>
        {summary && <p className="ef-summary-empty">median of {summary.nPairs} line pair{summary.nPairs === 1 ? '' : 's'}</p>}
      </div>

      <div className="ef-apply-target">
        <p className="ef-field-label">Apply to which case / images?</p>
        <select
          className="ux-select ef-apply-case-select"
          style={{ width: `${caseSelectWidthCh}ch` }}
          value={targetCase}
          onChange={e => setTargetCase(e.target.value)}
        >
          <option value="">Select a case…</option>
          {cases.map(item => <option key={item} value={item}>{item}</option>)}
        </select>

        {targetCase && (
          <div className="ef-apply-files">
            <div className="ef-apply-files-head">
              <span>{loadingFiles ? 'Loading images…' : `${files.length} images`}</span>
              {files.length > 0 && (
                <div className="flex gap-2">
                  <button type="button" className="ux-button ux-button-ghost" onClick={() => setSelected(new Set(files))}>Select all</button>
                  <button type="button" className="ux-button ux-button-ghost" onClick={() => setSelected(new Set())}>None</button>
                </div>
              )}
            </div>
            <div className="ef-apply-file-list">
              {files.map(filename => {
                const metaKnown = Object.prototype.hasOwnProperty.call(fileMetaByName, filename)
                return (
                  <label key={filename} className={`ef-apply-file ${selected.has(filename) ? 'ef-apply-file-selected' : ''}`}>
                    <input type="checkbox" checked={selected.has(filename)} onChange={() => toggle(filename)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{filename}</span>
                      <ImageTags filename={filename} meta={fileMetaByName[filename]} loading={!metaKnown} />
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        )}

        {error && <p className="ef-source-warn mt-2"><TriangleAlert size={12} /> {error}</p>}

        <div className="mt-3 flex items-center gap-2">
          <button type="button" className="ux-button ux-button-primary" disabled={!targetCase || selected.size === 0 || applying} onClick={apply}>
            {applying ? <Loader2 size={14} className="animate-spin" /> : <Ruler size={14} />}
            Apply factor to {selected.size || 0} image{selected.size === 1 ? '' : 's'}
          </button>
          {result && result.applied.length > 0 && (
            <button type="button" className="ux-button ux-button-ghost" onClick={onDone}>Done</button>
          )}
        </div>

        {result && (
          <div className="ef-apply-result">
            {result.applied.length > 0 && (
              <p className="ef-apply-ok"><Check size={13} /> Applied EF {formatEf(medianEf)} to {result.applied.length} image{result.applied.length === 1 ? '' : 's'}. Open an image to see calibrated measurements.</p>
            )}
            {result.failed.length > 0 && (
              <p className="ef-source-warn"><TriangleAlert size={12} /> {result.failed.length} failed: {result.failed.map(f => f.filename).join(', ')}</p>
            )}
          </div>
        )}
        <p className="ef-field-hint mt-2">
          <Info size={11} /> This sets each image's measurement expansion factor (shared with collaborators). The source images stay unchanged.
        </p>
      </div>
    </div>
  )
}
