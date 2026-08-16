import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  ArrowRight,
  ChevronRight,
  Crosshair,
  Eye,
  FileImage,
  FolderOpen,
  GripVertical,
  Loader2,
  LogOut,
  Microscope,
  Ruler,
  Search,
  Settings,
  Shield,
  UserCog,
  Users,
  X,
} from 'lucide-react'
import AccountSettingsPage from './components/AccountSettingsPage.jsx'
import AutoAdjustedPreview from './components/AutoAdjustedPreview.jsx'
import AdminPage from './components/AdminPage.jsx'
import ExpansionCalibrationPage from './components/ExpansionCalibrationPage.jsx'
import ImageViewer from './components/ImageViewer.jsx'
import { APP_NAME, APP_TAGLINE } from './appInfo.js'
import { authFetch, fetchSession, login as loginRequest, logout as logoutRequest } from './auth.js'
import { collaborationClientId, fetchViewState, sendHeartbeat, updateViewState, updateWorkspace } from './collaboration.js'
import { DEFAULT_EXPANSION_FACTOR, formatPixelSizeInput } from './measurement.js'
import { loadChannelSettings, normalizeChannelSettings } from './channelDisplay.js'

const API = '/agh/api'
const RESEARCH_USE_NOTICE = 'Research use only. Not validated for clinical diagnosis or treatment decisions.'
const MEASUREMENT_SETTINGS_PREFIX = 'agh-viewer:measurement-settings:v1:'
const DEFAULT_CASE_PANEL_WIDTH = 240
const DEFAULT_IMAGE_PANEL_WIDTH = 320
const MIN_CASE_PANEL_WIDTH = 160
const MAX_CASE_PANEL_WIDTH = 420
const MIN_IMAGE_PANEL_WIDTH = 220
const MAX_IMAGE_PANEL_WIDTH = 640

async function fetchJson(url, options = {}) {
  const res = await authFetch(url, options)
  if (!res.ok) {
    const message = await res.text().catch(() => '')
    const error = new Error(message || `Request failed with ${res.status}`)
    error.status = res.status
    throw error
  }
  return res.json()
}

function EmptyState({ icon: Icon = FileImage, children }) {
  return (
    <div className="px-4 py-8 text-center text-xs text-[var(--text-subtle)]">
      <Icon size={22} className="mx-auto mb-2 opacity-50" />
      <p>{children}</p>
    </div>
  )
}

function SearchField({ value, onChange, placeholder }) {
  return (
    <label className="ux-search">
      <Search size={13} className="flex-shrink-0 text-[var(--text-subtle)]" />
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text)] outline-none placeholder:text-[var(--text-subtle)]"
      />
    </label>
  )
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = units[0]
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024
    unit = units[i]
  }
  const digits = value >= 10 || unit === 'B' ? 0 : 1
  return `${value.toFixed(digits)} ${unit}`
}

function formatImageMeta(meta) {
  if (!meta) return 'Microscopy image'
  const parts = []
  if (meta.width && meta.height) parts.push(`${meta.width} x ${meta.height}`)
  if (meta.channelCount) parts.push(`${meta.channelCount} channel${meta.channelCount === 1 ? '' : 's'}`)
  if (Number(meta.zCount) > 1) parts.push(`${meta.zCount} z`)
  if (meta.sourceFormat) parts.push(meta.sourceFormat)
  const size = formatBytes(meta.sourceSize)
  if (size) parts.push(size)
  return parts.join(' | ') || 'Microscopy image'
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

function measurementSettingsKey(caseId, filename) {
  return `${MEASUREMENT_SETTINGS_PREFIX}${encodeURIComponent(caseId)}/${encodeURIComponent(filename)}`
}

const VISIBLE_METADATA_KEYS = [
  'sourceRelPath',
  'sourceSize',
  'sourceMtimeNs',
  'width',
  'height',
  'sampleDtype',
  'bitsPerSample',
  'channelCount',
  'zCount',
  'timeCount',
  'sourceFormat',
  'pixelSizeXUm',
  'pixelSizeYUm',
  'pixelSizeSource',
  'pixelSizeIsDefault',
  'channelDisplayPolicy',
  'displayPolicy',
]

function encodeRoutePart(value) {
  return encodeURIComponent(value || '')
}

function decodeRoutePart(value) {
  try {
    return decodeURIComponent(value || '')
  } catch {
    return ''
  }
}

function parseWorkspaceRoute(hash = window.location.hash) {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const [path, query = ''] = raw.split('?')
  const parts = path.split('/').filter(Boolean)
  const route = { admin: parts[0] === 'admin', account: parts[0] === 'account', case: null, filename: null, open: false, tab: 'annotations' }
  const caseIndex = parts.indexOf('case')
  const fileIndex = parts.indexOf('file')
  if (caseIndex >= 0 && parts[caseIndex + 1]) route.case = decodeRoutePart(parts[caseIndex + 1])
  if (fileIndex >= 0 && parts[fileIndex + 1]) route.filename = decodeRoutePart(parts[fileIndex + 1])
  const params = new URLSearchParams(query)
  route.open = params.get('open') === '1'
  route.tab = params.get('tab') || 'annotations'
  return route
}

function workspaceHash({ case: caseId, filename, open = false, tab = 'annotations' }) {
  if (!caseId) return ''
  let hash = `#/case/${encodeRoutePart(caseId)}`
  if (filename) hash += `/file/${encodeRoutePart(filename)}`
  const params = new URLSearchParams()
  if (open && filename) params.set('open', '1')
  if (tab && tab !== 'annotations') params.set('tab', tab)
  const query = params.toString()
  return query ? `${hash}?${query}` : hash
}

function replaceWorkspaceHash(nextHash) {
  const normalized = nextHash || window.location.pathname
  if (window.location.hash === nextHash) return
  window.history.replaceState(null, '', normalized)
}

function clampWidth(value, fallback, min, max) {
  const number = Math.round(Number(value) || fallback)
  return Math.max(min, Math.min(max, number))
}

function presenceName(viewer) {
  return viewer?.displayName || viewer?.username || 'Viewer'
}

function presenceInitial(viewer) {
  return presenceName(viewer).trim().slice(0, 1).toUpperCase() || '?'
}

function presenceColor(viewer) {
  const key = String(viewer?.username || viewer?.displayName || viewer?.clientId || 'viewer')
  let hash = 0
  for (let index = 0; index < key.length; index += 1) hash = ((hash << 5) - hash) + key.charCodeAt(index)
  const colors = ['#63a4d8', '#6ee7b7', '#fbbf24', '#f87171', '#c4b5fd', '#fb7185', '#38bdf8', '#a3e635']
  return colors[Math.abs(hash) % colors.length]
}

function PresenceAvatar({ viewer, size = 'default' }) {
  return (
    <span className={`presence-avatar presence-avatar-${size}`} style={{ '--presence-color': presenceColor(viewer) }}>
      <span>{presenceInitial(viewer)}</span>
      <span className="presence-tooltip">{presenceName(viewer)}</span>
    </span>
  )
}

function EfSettingsModal({ cases, initialCase, clientId, onClose }) {
  const [caseId, setCaseId] = useState(initialCase || '')
  const [files, setFiles] = useState([])
  const [rows, setRows] = useState([])
  const [caseEf, setCaseEf] = useState(String(DEFAULT_EXPANSION_FACTOR))
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!caseId) {
      setFiles([])
      setRows([])
      return undefined
    }
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setRows([])
    fetchJson(`${API}/cases/${encodeURIComponent(caseId)}/files`, { signal: controller.signal })
      .then(data => {
        const nextFiles = data.files || []
        setFiles(nextFiles)
        return Promise.all(nextFiles.map(async filename => {
          let meta = null
          let viewState = null
          try { meta = await fetchJson(`${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/meta`, { signal: controller.signal }) } catch { /* row can still use defaults */ }
          try { viewState = await fetchViewState(caseId, filename, { signal: controller.signal }) } catch { /* first-time image */ }
          const currentEf = viewState?.measurementSettings?.expansionFactor || String(DEFAULT_EXPANSION_FACTOR)
          return {
            filename,
            meta,
            viewState,
            draftEf: String(currentEf),
            status: '',
          }
        }))
      })
      .then(nextRows => {
        if (!controller.signal.aborted) setRows(nextRows)
      })
      .catch(err => {
        if (err.name !== 'AbortError') setError(err.message || 'Unable to load images')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [caseId])

  const saveEf = useCallback(async (filename, efValue, rowMeta, rowViewState) => {
    const ef = Number(efValue)
    if (!Number.isFinite(ef) || ef <= 0) throw new Error('Expansion factor must be positive')
    const existing = rowViewState?.measurementSettings || {}
    const pixelSizeUm = String(
      Number(existing.pixelSizeUm) > 0
        ? existing.pixelSizeUm
        : formatPixelSizeInput(rowMeta || {}),
    )
    const settings = { pixelSizeUm, expansionEnabled: true, expansionFactor: String(efValue) }
    try { localStorage.setItem(measurementSettingsKey(caseId, filename), JSON.stringify(settings)) } catch { /* optional */ }
    await updateViewState(caseId, filename, { clientId, measurementSettings: settings })
    return settings
  }, [caseId, clientId])

  const applyRow = useCallback(async (filename) => {
    const row = rows.find(item => item.filename === filename)
    if (!row) return
    setSaving(true)
    setError('')
    setRows(current => current.map(item => item.filename === filename ? { ...item, status: 'Saving...' } : item))
    try {
      const settings = await saveEf(row.filename, row.draftEf, row.meta, row.viewState)
      setRows(current => current.map(item => item.filename === filename ? { ...item, viewState: { ...(item.viewState || {}), measurementSettings: settings }, status: 'Saved' } : item))
    } catch (err) {
      setError(err.message || 'Unable to save EF')
      setRows(current => current.map(item => item.filename === filename ? { ...item, status: 'Failed' } : item))
    } finally {
      setSaving(false)
    }
  }, [rows, saveEf])

  const applyCase = useCallback(async () => {
    if (!rows.length) return
    setSaving(true)
    setError('')
    try {
      const updated = []
      for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop
        const settings = await saveEf(row.filename, caseEf, row.meta, row.viewState)
        updated.push({ filename: row.filename, settings })
      }
      setRows(current => current.map(row => {
        const saved = updated.find(item => item.filename === row.filename)
        return saved
          ? { ...row, draftEf: String(caseEf), viewState: { ...(row.viewState || {}), measurementSettings: saved.settings }, status: 'Saved' }
          : row
      }))
    } catch (err) {
      setError(err.message || 'Unable to save EF')
    } finally {
      setSaving(false)
    }
  }, [caseEf, rows, saveEf])

  return (
    <div className="ef-settings-backdrop" onClick={onClose}>
      <div className="ef-settings-modal" onClick={event => event.stopPropagation()}>
        <div className="ef-settings-head">
          <div className="min-w-0">
            <h2>EF settings</h2>
            <p>Set expansion factors for a case or individual images.</p>
          </div>
          <button type="button" className="ux-icon-button" onClick={onClose} title="Close EF settings">
            <X size={15} />
          </button>
        </div>

        <div className="ef-settings-controls">
          <label>
            <span>Case</span>
            <select className="ux-select" value={caseId} onChange={event => setCaseId(event.currentTarget.value)}>
              <option value="">Select a case...</option>
              {cases.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label>
            <span>Case EF</span>
            <input className="ux-input font-mono" type="number" min="0.000001" step="0.1" inputMode="decimal" value={caseEf} onChange={event => setCaseEf(event.currentTarget.value)} />
          </label>
          <button type="button" className="ux-button ux-button-primary" disabled={!caseId || !rows.length || saving} onClick={applyCase}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Ruler size={13} />}
            Apply to case
          </button>
        </div>

        {error && <p className="ef-settings-error">{error}</p>}

        <div className="ef-settings-list">
          {loading ? (
            <div className="ef-settings-empty"><Loader2 size={16} className="animate-spin" /> Loading images...</div>
          ) : !caseId ? (
            <div className="ef-settings-empty">Choose a case to edit image EF settings.</div>
          ) : files.length === 0 ? (
            <div className="ef-settings-empty">No images found in this case.</div>
          ) : (
            rows.map(row => (
              <div key={row.filename} className="ef-settings-row">
                <div className="min-w-0">
                  <p className="ef-settings-file">{row.filename}</p>
                  <ImageTags filename={row.filename} meta={row.meta} loading={!row.meta} />
                  <p className="ef-settings-meta">
                    Pixel size {row.meta ? formatPixelSizeInput(row.meta) : 'default'} um/px
                    {row.status && <span> | {row.status}</span>}
                  </p>
                </div>
                <input
                  className="ux-input font-mono ef-settings-ef-input"
                  type="number"
                  min="0.000001"
                  step="0.1"
                  inputMode="decimal"
                  value={row.draftEf}
                  onChange={event => {
                    const value = event.currentTarget.value
                    setRows(current => current.map(item => item.filename === row.filename ? { ...item, draftEf: value, status: '' } : item))
                  }}
                />
                <button type="button" className="ux-button ux-button-secondary" disabled={saving} onClick={() => applyRow(row.filename)}>
                  Apply
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function LoginPage({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const submit = async (event) => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const { user, role, firstName, lastName, displayName } = await loginRequest(username.trim(), password)
      setPassword('')
      onLogin({ user: user || username.trim(), role: role || '', firstName: firstName || '', lastName: lastName || '', displayName: displayName || '' })
    } catch (err) {
      if (err.status === 429) {
        const wait = err.retryAfter ? ` Try again in ${err.retryAfter}s.` : ''
        setError(`Too many failed attempts.${wait}`)
      } else if (err.status === 401) {
        setError('Invalid username or password')
      } else {
        setError(err.message)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app-shell flex h-screen w-screen items-center justify-center p-6">
      <form onSubmit={submit} className="login-panel w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="app-brand-mark"><Microscope size={15} /></span>
          <div>
            <h1 className="text-sm font-semibold leading-tight text-[var(--text)]">{APP_NAME}</h1>
            <p className="text-[11px] leading-tight text-[var(--text-subtle)]">Sign in to continue</p>
          </div>
        </div>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-[11px] font-semibold text-[var(--text-muted)]">Username</span>
          <input
            autoFocus
            value={username}
            onChange={event => setUsername(event.target.value)}
            className="ux-input"
            autoComplete="username"
            required
          />
        </label>
        <label className="mb-4 block">
          <span className="mb-1.5 block text-[11px] font-semibold text-[var(--text-muted)]">Password</span>
          <input
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            className="ux-input"
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="mb-3 text-xs text-[var(--danger)]">{error}</p>}
        <button type="submit" disabled={loading} className="ux-button ux-button-primary w-full">
          {loading ? <Loader2 size={14} className="animate-spin" /> : null}
          Sign in
        </button>
      </form>
    </div>
  )
}

export default function App() {
  const initialRoute = useMemo(() => parseWorkspaceRoute(), [])
  const [cases, setCases] = useState([])
  const [selectedCase, setCase] = useState(initialRoute.case)
  const [files, setFiles] = useState([])
  const [loadingCases, setLC] = useState(true)
  const [loadingFiles, setLF] = useState(false)
  const [casesError, setCasesError] = useState(null)
  const [filesError, setFilesError] = useState(null)
  const [casesReload, setCasesReload] = useState(0)
  const [filesReload, setFilesReload] = useState(0)
  const [caseQuery, setCaseQuery] = useState('')
  const [fileQuery, setFileQuery] = useState('')
  const [selectedFile, setSelectedFile] = useState(initialRoute.filename)
  const [previewError, setPreviewError] = useState(null)
  const [previewMeta, setPreviewMeta] = useState(null)
  const [previewChannelSettings, setPreviewChannelSettings] = useState(null)
  const [previewViewStateRevision, setPreviewViewStateRevision] = useState(0)
  const [fileMetaByName, setFileMetaByName] = useState({})
  const [previewMetaLoading, setPreviewMetaLoading] = useState(false)
  const [metadataExpanded, setMetadataExpanded] = useState(false)
  const [calibrationOpen, setCalibrationOpen] = useState(false)
  const [efSettingsOpen, setEfSettingsOpen] = useState(false)
  const [openFile, setOpenFile] = useState(initialRoute.open && initialRoute.case && initialRoute.filename
    ? { case: initialRoute.case, filename: initialRoute.filename, initialTab: initialRoute.tab }
    : null)
  const [adminOpen, setAdminOpen] = useState(initialRoute.admin)
  const [accountOpen, setAccountOpen] = useState(initialRoute.account)
  const [auth, setAuth] = useState({ status: 'checking', authenticated: false, user: '', role: '', firstName: '', lastName: '', displayName: '' })
  const [clientId] = useState(() => collaborationClientId())
  const [casePanelWidth, setCasePanelWidth] = useState(DEFAULT_CASE_PANEL_WIDTH)
  const [imagePanelWidth, setImagePanelWidth] = useState(DEFAULT_IMAGE_PANEL_WIDTH)
  const [presence, setPresence] = useState([])
  const [workspaceUpdatedBy, setWorkspaceUpdatedBy] = useState('')
  const panelDragRef = useRef(null)

  const resetWorkspace = useCallback(() => {
    setCases([])
    setFiles([])
    setCase(null)
    setSelectedFile(null)
    setOpenFile(null)
    setAdminOpen(false)
    setAccountOpen(false)
    setPreviewMeta(null)
    setPreviewError(null)
    replaceWorkspaceHash('')
  }, [])

  const handleLogout = useCallback(async () => {
    await logoutRequest()
    setAuth({ status: 'ready', authenticated: false, user: '', role: '', firstName: '', lastName: '', displayName: '' })
    resetWorkspace()
  }, [resetWorkspace])

  const handleLogin = useCallback((session) => {
    setAuth({ status: 'ready', authenticated: true, user: session.user, role: session.role, firstName: session.firstName || '', lastName: session.lastName || '', displayName: session.displayName || '' })
    setCasesReload(value => value + 1)
  }, [])

  useEffect(() => {
    const handleHashChange = () => {
      const route = parseWorkspaceRoute()
      setAdminOpen(route.admin)
      setAccountOpen(route.account)
      setCase(route.case)
      setSelectedFile(route.filename)
      setPreviewError(null)
      setOpenFile(route.open && route.case && route.filename
        ? { case: route.case, filename: route.filename, initialTab: route.tab }
        : null)
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    if (!auth.authenticated) return
    if (adminOpen && auth.role !== 'admin') {
      setAdminOpen(false)
      return
    }
    const current = accountOpen
      ? '#/account'
      : adminOpen
      ? '#/admin'
      : openFile
      ? workspaceHash({ ...openFile, open: true })
      : workspaceHash({ case: selectedCase, filename: selectedFile })
    replaceWorkspaceHash(current)
  }, [auth.authenticated, selectedCase, selectedFile, openFile, adminOpen, accountOpen])

  // Validate any existing session cookie on load before showing the app.
  useEffect(() => {
    let active = true
    fetchSession().then(result => {
      if (!active) return
      setAuth({
        status: 'ready',
        authenticated: result.authenticated,
        user: result.user,
        role: result.role || '',
        firstName: result.firstName || '',
        lastName: result.lastName || '',
        displayName: result.displayName || '',
      })
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!auth.authenticated) {
      setLC(false)
      return undefined
    }
    const controller = new AbortController()
    setLC(true)
    setCasesError(null)
    fetchJson(`${API}/cases`, { signal: controller.signal })
      .then(data => { setCases(data.cases || []) })
      .catch(error => {
        if (error.name === 'AbortError') return
        if (error.status === 401) handleLogout()
        else setCasesError(error.message)
      })
      .finally(() => { if (!controller.signal.aborted) setLC(false) })
    return () => controller.abort()
  }, [auth.authenticated, casesReload, handleLogout])

  useEffect(() => {
    if (!auth.authenticated || !selectedCase) return
    const controller = new AbortController()
    setLF(true)
    setFiles([])
    setFilesError(null)
    setFileMetaByName({})
    fetchJson(`${API}/cases/${encodeURIComponent(selectedCase)}/files`, { signal: controller.signal })
      .then(data => { setFiles(data.files || []) })
      .catch(error => {
        if (error.name === 'AbortError') return
        if (error.status === 401) handleLogout()
        else setFilesError(error.message)
      })
      .finally(() => { if (!controller.signal.aborted) setLF(false) })
    return () => controller.abort()
  }, [auth.authenticated, selectedCase, filesReload, handleLogout])

  const filteredCases = useMemo(() => {
    const query = caseQuery.trim().toLowerCase()
    if (!query) return cases
    return cases.filter(item => item.toLowerCase().includes(query))
  }, [cases, caseQuery])

  const filteredFiles = useMemo(() => {
    const query = fileQuery.trim().toLowerCase()
    if (!query) return files
    return files.filter(item => item.toLowerCase().includes(query))
  }, [files, fileQuery])

  const otherPresence = useMemo(() => (
    presence.filter(viewer => viewer?.clientId && viewer.clientId !== clientId)
  ), [clientId, presence])

  const presenceByFile = useMemo(() => {
    const grouped = new Map()
    for (const viewer of otherPresence) {
      if (!viewer?.caseId || viewer.caseId !== selectedCase || !viewer.filename) continue
      const current = grouped.get(viewer.filename) || []
      current.push(viewer)
      grouped.set(viewer.filename, current)
    }
    return grouped
  }, [otherPresence, selectedCase])

  useEffect(() => {
    if (!selectedCase || loadingFiles) return
    if (!filteredFiles.length) {
      setSelectedFile(null)
      setPreviewError(null)
      return
    }
    if (!selectedFile || !filteredFiles.includes(selectedFile)) {
      setSelectedFile(filteredFiles[0])
      setPreviewError(null)
    }
  }, [selectedCase, loadingFiles, filteredFiles, selectedFile])

  useEffect(() => {
    if (!auth.authenticated || !selectedCase || !selectedFile || openFile) {
      setPreviewMeta(null)
      setPreviewChannelSettings(null)
      setPreviewViewStateRevision(0)
      setPreviewMetaLoading(false)
      return
    }
    const controller = new AbortController()
    setPreviewMeta(null)
    setPreviewChannelSettings(null)
    setPreviewViewStateRevision(0)
    setPreviewMetaLoading(true)
    fetchJson(`${API}/cases/${encodeURIComponent(selectedCase)}/files/${encodeURIComponent(selectedFile)}/meta`, { signal: controller.signal })
      .then(async meta => {
        if (controller.signal.aborted) return
        setPreviewMeta(meta)
        setFileMetaByName(current => ({ ...current, [selectedFile]: meta }))
        setPreviewChannelSettings(loadChannelSettings(selectedCase, selectedFile, meta))
        let sharedState = null
        try { sharedState = await fetchViewState(selectedCase, selectedFile, { signal: controller.signal }) } catch { /* local settings are enough for preview */ }
        if (controller.signal.aborted) return
        if (sharedState?.channelSettings) setPreviewChannelSettings(normalizeChannelSettings(sharedState.channelSettings, meta))
        setPreviewViewStateRevision(sharedState?.revision || 0)
      })
      .catch(error => {
        if (error.name !== 'AbortError') {
          if (error.status === 401) handleLogout()
          setPreviewMeta(null)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewMetaLoading(false)
      })
    return () => controller.abort()
  }, [auth.authenticated, selectedCase, selectedFile, openFile, handleLogout])

  useEffect(() => {
    // The full viewer owns this file's collaboration state while it is open.
    // Polling both the preview and the viewer produced duplicate reads every
    // 2.5 seconds (and showed up as a near-continuous request stream).
    if (!auth.authenticated || !selectedCase || !selectedFile || !previewMeta || openFile) return undefined
    const id = window.setInterval(() => {
      fetchViewState(selectedCase, selectedFile)
        .then(state => {
          const nextRevision = state?.revision || 0
          if (!nextRevision || nextRevision <= previewViewStateRevision) return
          if (state.channelSettings) setPreviewChannelSettings(normalizeChannelSettings(state.channelSettings, previewMeta))
          setPreviewViewStateRevision(nextRevision)
        })
        .catch(() => {})
    }, 2500)
    return () => window.clearInterval(id)
  }, [auth.authenticated, selectedCase, selectedFile, previewMeta, previewViewStateRevision, openFile])

  useEffect(() => {
    if (!auth.authenticated || !selectedCase || !files.length) return undefined
    const controller = new AbortController()
    let cancelled = false

    async function loadFileMetadata() {
      const batchSize = 6
      for (let index = 0; index < files.length && !cancelled; index += batchSize) {
        const batch = files.slice(index, index + batchSize)
        // eslint-disable-next-line no-await-in-loop
        const loaded = await Promise.all(batch.map(async filename => {
          try {
            const meta = await fetchJson(`${API}/cases/${encodeURIComponent(selectedCase)}/files/${encodeURIComponent(filename)}/meta`, { signal: controller.signal })
            return [filename, meta]
          } catch (error) {
            if (error.name === 'AbortError') return null
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
  }, [auth.authenticated, selectedCase, files])

  const openViewer = useCallback((filename = selectedFile, initialTab = 'annotations') => {
    if (!selectedCase || !filename) return
    setSelectedFile(filename)
    setPreviewError(null)
    setOpenFile({ case: selectedCase, filename, initialTab })
  }, [selectedCase, selectedFile])

  const moveSelection = useCallback((delta) => {
    if (!filteredFiles.length) return
    const current = Math.max(0, filteredFiles.findIndex(item => item === selectedFile))
    const next = Math.max(0, Math.min(filteredFiles.length - 1, current + delta))
    setSelectedFile(filteredFiles[next])
    setPreviewError(null)
  }, [filteredFiles, selectedFile])

  const handleFileKeyDown = useCallback((event) => {
    const tag = event.target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return
    if (!auth.authenticated || !selectedCase || openFile) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSelection(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      openViewer()
    }
  }, [auth.authenticated, selectedCase, openFile, moveSelection, openViewer])

  useEffect(() => {
    window.addEventListener('keydown', handleFileKeyDown)
    return () => window.removeEventListener('keydown', handleFileKeyDown)
  }, [handleFileKeyDown])

  const applyCollaborationSnapshot = useCallback((snapshot) => {
    const workspace = snapshot?.workspace || {}
    if (!panelDragRef.current) {
      const nextCaseWidth = workspace.casePanelWidth
      const nextImageWidth = workspace.imagePanelWidth
      if (nextCaseWidth || nextImageWidth) {
        if (nextCaseWidth) setCasePanelWidth(clampWidth(nextCaseWidth, DEFAULT_CASE_PANEL_WIDTH, MIN_CASE_PANEL_WIDTH, MAX_CASE_PANEL_WIDTH))
        if (nextImageWidth) setImagePanelWidth(clampWidth(nextImageWidth, DEFAULT_IMAGE_PANEL_WIDTH, MIN_IMAGE_PANEL_WIDTH, MAX_IMAGE_PANEL_WIDTH))
      } else if (workspace.selectionPanelWidth) {
        const combined = Number(workspace.selectionPanelWidth) || (DEFAULT_CASE_PANEL_WIDTH + DEFAULT_IMAGE_PANEL_WIDTH)
        setCasePanelWidth(clampWidth(Math.round(combined * 0.43), DEFAULT_CASE_PANEL_WIDTH, MIN_CASE_PANEL_WIDTH, MAX_CASE_PANEL_WIDTH))
        setImagePanelWidth(clampWidth(combined - Math.round(combined * 0.43), DEFAULT_IMAGE_PANEL_WIDTH, MIN_IMAGE_PANEL_WIDTH, MAX_IMAGE_PANEL_WIDTH))
      }
    }
    setWorkspaceUpdatedBy(snapshot?.workspace?.updatedByName || snapshot?.workspace?.updatedBy || '')
    setPresence(Array.isArray(snapshot?.presence) ? snapshot.presence : [])
  }, [])

  const publishHeartbeat = useCallback(() => {
    if (!auth.authenticated) return Promise.resolve()
    return sendHeartbeat({
      clientId,
      caseId: openFile?.case || selectedCase || null,
      filename: openFile?.filename || selectedFile || null,
      viewerOpen: Boolean(openFile),
    }).then(applyCollaborationSnapshot).catch(() => {})
  }, [applyCollaborationSnapshot, auth.authenticated, clientId, openFile, selectedCase, selectedFile])

  useEffect(() => {
    if (!auth.authenticated) return undefined
    publishHeartbeat()
    const id = window.setInterval(() => {
      publishHeartbeat()
    }, 5000)
    return () => window.clearInterval(id)
  }, [applyCollaborationSnapshot, auth.authenticated, publishHeartbeat])

  const publishPanelWidths = useCallback((nextCaseWidth = casePanelWidth, nextImageWidth = imagePanelWidth) => {
    if (!auth.authenticated) return
    updateWorkspace({
      clientId,
      casePanelWidth: clampWidth(nextCaseWidth, DEFAULT_CASE_PANEL_WIDTH, MIN_CASE_PANEL_WIDTH, MAX_CASE_PANEL_WIDTH),
      imagePanelWidth: clampWidth(nextImageWidth, DEFAULT_IMAGE_PANEL_WIDTH, MIN_IMAGE_PANEL_WIDTH, MAX_IMAGE_PANEL_WIDTH),
    }).then(result => {
      const workspace = result?.workspace || {}
      setWorkspaceUpdatedBy(workspace.updatedByName || workspace.updatedBy || '')
    }).catch(() => {})
  }, [auth.authenticated, casePanelWidth, clientId, imagePanelWidth])

  const startPanelResize = useCallback((event, panel) => {
    event.preventDefault()
    const startX = event.clientX
    const startCaseWidth = casePanelWidth
    const startImageWidth = imagePanelWidth
    panelDragRef.current = { panel, startX, startCaseWidth, startImageWidth, latestCaseWidth: startCaseWidth, latestImageWidth: startImageWidth }
    document.body.classList.add('is-resizing-panel')

    const onMove = moveEvent => {
      const drag = panelDragRef.current
      if (!drag) return
      const delta = moveEvent.clientX - drag.startX
      if (drag.panel === 'case') {
        setCasePanelWidth(clampWidth(drag.startCaseWidth + delta, DEFAULT_CASE_PANEL_WIDTH, MIN_CASE_PANEL_WIDTH, MAX_CASE_PANEL_WIDTH))
      } else {
        setImagePanelWidth(clampWidth(drag.startImageWidth + delta, DEFAULT_IMAGE_PANEL_WIDTH, MIN_IMAGE_PANEL_WIDTH, MAX_IMAGE_PANEL_WIDTH))
      }
    }
    const onUp = () => {
      const finalCaseWidth = panelDragRef.current?.latestCaseWidth || casePanelWidth
      const finalImageWidth = panelDragRef.current?.latestImageWidth || imagePanelWidth
      panelDragRef.current = null
      document.body.classList.remove('is-resizing-panel')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      publishPanelWidths(finalCaseWidth, finalImageWidth)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [casePanelWidth, imagePanelWidth, publishPanelWidths])

  useEffect(() => {
    if (!panelDragRef.current) return
    panelDragRef.current.latestCaseWidth = casePanelWidth
    panelDragRef.current.latestImageWidth = imagePanelWidth
  }, [casePanelWidth, imagePanelWidth])

  if (auth.status === 'checking') {
    return (
      <div className="app-shell flex h-screen w-screen items-center justify-center">
        <Loader2 size={20} className="animate-spin text-[var(--text-subtle)]" />
      </div>
    )
  }

  if (!auth.authenticated) return <LoginPage onLogin={handleLogin} />

  if (adminOpen && auth.role === 'admin') {
    return <AdminPage currentUser={auth.user} onBack={() => setAdminOpen(false)} />
  }

  if (accountOpen) {
    return <AccountSettingsPage user={auth.user} role={auth.role} firstName={auth.firstName} lastName={auth.lastName} displayName={auth.displayName} onProfileChange={profile => setAuth(current => ({ ...current, ...profile }))} onBack={() => setAccountOpen(false)} />
  }

  if (calibrationOpen) {
    return <ExpansionCalibrationPage cases={cases} onClose={() => setCalibrationOpen(false)} />
  }

  return (
    <div className="app-shell flex h-screen w-screen flex-col overflow-hidden">
      <header className="app-header flex flex-shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <span className="app-brand-mark"><Microscope size={15} /></span>
          <div>
            <h1 className="text-sm font-semibold leading-tight text-[var(--text)]">{APP_NAME}</h1>
            <p className="text-[11px] leading-tight text-[var(--text-subtle)]">{APP_TAGLINE}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-[var(--text-subtle)]">
          <span>{cases.length} cases</span>
          {otherPresence.length > 0 && (
            <div className="presence-strip">
              <Users size={13} />
              <span>{otherPresence.length} active</span>
              <div className="presence-avatars">
                {otherPresence.slice(0, 5).map(viewer => (
                  <PresenceAvatar key={viewer.clientId} viewer={viewer} />
                ))}
              </div>
            </div>
          )}
          {auth.user && <span>{auth.displayName || auth.user}{auth.role ? ` (${auth.role})` : ''}</span>}
          <button onClick={() => setCalibrationOpen(true)} className="ux-button ux-button-ghost min-h-0 px-2 py-1 text-[11px]" title="Calibrate expansion factor from matched line pairs">
            <Crosshair size={13} />
            Calibrate EF
          </button>
          <button onClick={() => setEfSettingsOpen(true)} className="ux-button ux-button-ghost min-h-0 px-2 py-1 text-[11px]" title="EF settings">
            <Settings size={13} />
            EF settings
          </button>
          <button onClick={() => setAccountOpen(true)} className="ux-button ux-button-ghost min-h-0 px-2 py-1 text-[11px]" title="Account settings">
            <UserCog size={13} />
            Account
          </button>
          {auth.role === 'admin' && (
            <button onClick={() => setAdminOpen(true)} className="ux-button ux-button-secondary min-h-0 px-2 py-1 text-[11px]" title="Admin">
              <Shield size={13} />
              Admin
            </button>
          )}
          <button onClick={handleLogout} className="ux-button ux-button-ghost min-h-0 px-2 py-1 text-[11px]" title="Log out">
            <LogOut size={13} />
            Log out
          </button>
        </div>
      </header>
      <div className="border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-1.5 text-center text-[11px] font-semibold text-[var(--danger)]">
        {RESEARCH_USE_NOTICE}
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          className="selection-panel-group flex min-h-0 flex-shrink-0"
          style={{ width: casePanelWidth + imagePanelWidth + 11 }}
        >
        <aside
          className="app-pane flex flex-shrink-0 flex-col border-r"
          style={{ width: casePanelWidth }}
        >
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <span className="text-xs font-semibold text-[var(--text)]">Cases</span>
            <span className="ux-meta">{filteredCases.length}</span>
          </div>
          <div className="border-b border-[var(--border)] px-3 py-3">
            <SearchField value={caseQuery} onChange={setCaseQuery} placeholder="Filter cases" />
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            {loadingCases
              ? <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-[var(--text-subtle)]" /></div>
              : casesError
                ? (
                  <div className="px-4 py-4 text-xs text-[var(--danger)]">
                    <p className="break-words">{casesError}</p>
                    <button onClick={() => setCasesReload(value => value + 1)} className="ux-button ux-button-secondary mt-3">Retry</button>
                  </div>
                )
                : cases.length === 0
                  ? <EmptyState icon={FolderOpen}>No cases found</EmptyState>
                  : filteredCases.length === 0
                    ? <EmptyState icon={Search}>No matching cases</EmptyState>
                    : filteredCases.map(item => (
                      <button
                        key={item}
                        onClick={() => { setCase(item); setFiles([]); setSelectedFile(null); setFileQuery(''); setPreviewError(null) }}
                        className={`ux-list-item flex h-9 w-full items-center gap-2 px-4 text-left text-xs ${selectedCase === item ? 'ux-list-item-selected text-[var(--text)]' : 'text-[var(--text-muted)]'}`}
                      >
                        <ChevronRight size={12} className="text-[var(--text-subtle)]" />
                        <span className="truncate">{item}</span>
                      </button>
                    ))}
          </div>
        </aside>

        <button
          type="button"
          className="selection-panel-resizer"
          onMouseDown={event => startPanelResize(event, 'case')}
          title={workspaceUpdatedBy ? `Case panel width synced by ${workspaceUpdatedBy}` : 'Resize cases panel'}
          aria-label="Resize cases panel"
        >
          <GripVertical size={14} />
        </button>

        <aside
          className="app-pane app-pane-secondary flex min-w-0 flex-shrink-0 flex-col border-r"
          style={{ width: imagePanelWidth }}
        >
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <div className="min-w-0">
              <span className="truncate text-xs font-semibold text-[var(--text)]">Images</span>
              {selectedCase && <p className="mt-1 truncate text-[11px] text-[var(--text-subtle)]">{selectedCase}</p>}
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              {selectedCase && <span className="ux-meta">{filteredFiles.length} images</span>}
            </div>
          </div>
          {selectedCase && (
            <div className="border-b border-[var(--border)] px-3 py-3">
              <SearchField value={fileQuery} onChange={setFileQuery} placeholder="Filter images" />
            </div>
          )}
          <div className="flex-1 overflow-y-auto py-2" tabIndex={0} onKeyDown={handleFileKeyDown}>
            {!selectedCase
              ? <EmptyState icon={FolderOpen}>Choose a case to browse images</EmptyState>
              : loadingFiles
                ? <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-[var(--text-subtle)]" /></div>
                : filesError
                  ? (
                    <div className="px-4 py-4 text-xs text-[var(--danger)]">
                      <p className="break-words">{filesError}</p>
                      <button onClick={() => setFilesReload(value => value + 1)} className="ux-button ux-button-secondary mt-3">Retry</button>
                    </div>
                  )
                  : files.length === 0
                    ? <EmptyState>No images found</EmptyState>
                    : filteredFiles.length === 0
                      ? <EmptyState icon={Search}>No matching images</EmptyState>
                      : filteredFiles.map(item => (
                        <div
                          key={item}
                          onDoubleClick={() => openViewer(item, 'annotations')}
                          onClick={() => { setSelectedFile(item); setPreviewError(null) }}
                          className={`ux-list-item group mx-2 my-0.5 flex cursor-pointer items-start gap-2 rounded-r-md px-3 py-2.5 ${selectedFile === item ? 'ux-list-item-selected' : ''}`}
                        >
                          <FileImage size={14} className={`mt-0.5 flex-shrink-0 ${selectedFile === item ? 'text-[var(--accent)]' : 'text-[var(--text-subtle)]'}`} />
                          <div className="min-w-0 flex-1">
                            <p className="break-all text-xs leading-snug text-[var(--text)]">{item}</p>
                            <ImageTags filename={item} meta={fileMetaByName[item]} loading={!fileMetaByName[item]} />
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span className="text-[11px] text-[var(--text-subtle)]">
                                {selectedFile === item
                                  ? previewMetaLoading ? 'Loading metadata' : formatImageMeta(previewMeta)
                                  : 'Microscopy image'}
                              </span>
                              {(presenceByFile.get(item) || []).length > 0 && (
                                <span className="presence-avatars image-presence-avatars" aria-label="Other users on this image">
                                  {(presenceByFile.get(item) || []).slice(0, 5).map(viewer => (
                                    <PresenceAvatar key={viewer.clientId} viewer={viewer} size="small" />
                                  ))}
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={event => { event.stopPropagation(); openViewer(item, 'annotations') }}
                            className="ux-button ux-button-ghost min-h-0 flex-shrink-0 px-2 py-1 text-[11px]"
                            title="Open image"
                          >
                            <Eye size={13} />
                            Open
                          </button>
                        </div>
                      ))}
          </div>
        </aside>
        </div>
        <button
          type="button"
          className="selection-panel-resizer"
          onMouseDown={event => startPanelResize(event, 'image')}
          title={workspaceUpdatedBy ? `Image panel width synced by ${workspaceUpdatedBy}` : 'Resize images panel'}
          aria-label="Resize images panel"
        >
          <GripVertical size={14} />
        </button>

        <main className="app-canvas relative flex flex-1 items-center justify-center overflow-hidden">
          {selectedFile && selectedCase ? (
            <div className="flex h-full w-full flex-col p-6">
              <div className="mb-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="mt-1 truncate text-sm font-medium text-[var(--text)]">{selectedFile}</h2>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-[12px] text-[var(--text-subtle)]">{selectedCase}</span>
                    <ImageTags filename={selectedFile} meta={previewMeta || fileMetaByName[selectedFile]} loading={previewMetaLoading && !fileMetaByName[selectedFile]} />
                    <span className="text-[12px] text-[var(--text-subtle)]">
                      {previewMetaLoading ? 'Loading metadata' : previewMeta ? formatImageMeta(previewMeta) : ''}
                    </span>
                  </div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <button onClick={() => openViewer(selectedFile, 'annotations')} className="ux-button ux-button-primary">
                    Open image <ArrowRight size={13} />
                  </button>
                  <button onClick={() => setMetadataExpanded(value => !value)} className="ux-button ux-button-ghost">
                    View technical metadata
                  </button>
                </div>
              </div>
              <div className="mb-4 rounded border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-[12px] text-[var(--text-muted)]">
                <span className="font-semibold text-[var(--text)]">{selectedCase}</span>
                <span className="mx-3 text-[var(--border)]">·</span>
                <span>{files.length} images</span>
              </div>
              {metadataExpanded && previewMeta && (
                <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1 rounded border border-[var(--border)] bg-[var(--surface-1)] p-3 text-[12px]">
                  {VISIBLE_METADATA_KEYS.filter(key => key in previewMeta).map(key => [key, previewMeta[key]]).map(([key, value]) => (
                    <div key={key} className="flex min-w-0 items-center justify-between gap-3">
                      <span className="truncate text-[var(--text-subtle)]">{key}</span>
                      <span className="truncate text-right font-mono text-[var(--text)]">{String(value)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <div className="app-preview-frame relative flex h-full w-full items-center justify-center overflow-hidden p-3">
                  <div className="image-preview-tags">
                    <ImageTags filename={selectedFile} meta={previewMeta || fileMetaByName[selectedFile]} loading={previewMetaLoading && !fileMetaByName[selectedFile]} />
                  </div>
                  {previewMetaLoading ? (
                    <div className="flex items-center gap-2 text-xs text-[var(--text-subtle)]">
                      <Loader2 size={16} className="animate-spin" />
                      Loading auto-adjusted preview...
                    </div>
                  ) : previewMeta ? (
                    <AutoAdjustedPreview
                      apiBase={`${API}/cases/${encodeURIComponent(selectedCase)}/files/${encodeURIComponent(selectedFile)}`}
                      meta={previewMeta}
                      channelSettings={previewChannelSettings}
                      onError={message => setPreviewError(message || 'Preview failed to load')}
                    />
                  ) : (
                    <p className="text-xs text-[var(--text-subtle)]">Preview metadata unavailable</p>
                  )}
                </div>
              </div>
              {previewError && <p className="mt-3 text-xs text-[var(--danger)]">{previewError}</p>}
            </div>
          ) : (
            <div className="max-w-sm text-center text-[var(--text-subtle)]">
              <h2 className="text-sm font-semibold text-[var(--text-muted)]">Select an image to preview</h2>
              <p className="mt-2 text-xs leading-relaxed">Choose a case from the left sidebar.</p>
            </div>
          )}
        </main>
      </div>

      {openFile && (
        <ImageViewer
          caseId={openFile.case}
          filename={openFile.filename}
          files={filteredFiles}
          initialTab={openFile.initialTab}
          user={auth.user}
          role={auth.role}
          firstName={auth.firstName}
          lastName={auth.lastName}
          displayName={auth.displayName}
          clientId={clientId}
          onProfileChange={profile => setAuth(current => ({ ...current, ...profile }))}
          onNavigateFile={filename => {
            setSelectedFile(filename)
            setPreviewError(null)
            setOpenFile(current => current ? { ...current, filename, initialTab: 'annotations' } : { case: selectedCase, filename, initialTab: 'annotations' })
          }}
          onClose={() => setOpenFile(null)}
        />
      )}
      {efSettingsOpen && (
        <EfSettingsModal
          cases={cases}
          initialCase={selectedCase}
          clientId={clientId}
          onClose={() => setEfSettingsOpen(false)}
        />
      )}
    </div>
  )
}
