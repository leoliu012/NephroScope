import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  ArrowRight,
  ChevronRight,
  Eye,
  FileImage,
  FolderOpen,
  Loader2,
  Microscope,
  Search,
} from 'lucide-react'
import ImageViewer from './components/ImageViewer.jsx'

const API = '/agh/api'

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options)
  if (!res.ok) {
    const message = await res.text().catch(() => '')
    throw new Error(message || `Request failed with ${res.status}`)
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
  if (!meta) return 'TIFF image'
  const parts = []
  if (meta.width && meta.height) parts.push(`${meta.width} x ${meta.height}`)
  if (meta.numChannels) parts.push(`${meta.numChannels} channel${meta.numChannels === 1 ? '' : 's'}`)
  if (meta.numZSlices) parts.push(`${meta.numZSlices} Z-slice${meta.numZSlices === 1 ? '' : 's'}`)
  const size = formatBytes(meta.sourceSize)
  if (size) parts.push(size)
  return parts.join(' | ') || 'TIFF image'
}

export default function App() {
  const [cases, setCases] = useState([])
  const [selectedCase, setCase] = useState(null)
  const [files, setFiles] = useState([])
  const [loadingCases, setLC] = useState(true)
  const [loadingFiles, setLF] = useState(false)
  const [casesError, setCasesError] = useState(null)
  const [filesError, setFilesError] = useState(null)
  const [casesReload, setCasesReload] = useState(0)
  const [filesReload, setFilesReload] = useState(0)
  const [caseQuery, setCaseQuery] = useState('')
  const [fileQuery, setFileQuery] = useState('')
  const [selectedFile, setSelectedFile] = useState(null)
  const [previewError, setPreviewError] = useState(null)
  const [previewMeta, setPreviewMeta] = useState(null)
  const [previewMetaLoading, setPreviewMetaLoading] = useState(false)
  const [openFile, setOpenFile] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    setLC(true)
    setCasesError(null)
    fetchJson(`${API}/cases`, { signal: controller.signal })
      .then(data => { setCases(data.cases || []) })
      .catch(error => { if (error.name !== 'AbortError') setCasesError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setLC(false) })
    return () => controller.abort()
  }, [casesReload])

  useEffect(() => {
    if (!selectedCase) return
    const controller = new AbortController()
    setLF(true)
    setFiles([])
    setFilesError(null)
    fetchJson(`${API}/cases/${encodeURIComponent(selectedCase)}/files`, { signal: controller.signal })
      .then(data => { setFiles(data.files || []) })
      .catch(error => { if (error.name !== 'AbortError') setFilesError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setLF(false) })
    return () => controller.abort()
  }, [selectedCase, filesReload])

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
    if (!selectedCase || !selectedFile) {
      setPreviewMeta(null)
      setPreviewMetaLoading(false)
      return
    }
    const controller = new AbortController()
    setPreviewMeta(null)
    setPreviewMetaLoading(true)
    fetchJson(`${API}/cases/${encodeURIComponent(selectedCase)}/files/${encodeURIComponent(selectedFile)}/meta`, { signal: controller.signal })
      .then(meta => setPreviewMeta(meta))
      .catch(error => {
        if (error.name !== 'AbortError') setPreviewMeta(null)
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewMetaLoading(false)
      })
    return () => controller.abort()
  }, [selectedCase, selectedFile])

  const openViewer = useCallback((filename = selectedFile) => {
    if (!selectedCase || !filename) return
    setSelectedFile(filename)
    setPreviewError(null)
    setOpenFile({ case: selectedCase, filename })
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
    if (!selectedCase || openFile) return
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
  }, [selectedCase, openFile, moveSelection, openViewer])

  useEffect(() => {
    window.addEventListener('keydown', handleFileKeyDown)
    return () => window.removeEventListener('keydown', handleFileKeyDown)
  }, [handleFileKeyDown])

  return (
    <div className="app-shell flex h-screen w-screen flex-col overflow-hidden">
      <header className="app-header flex flex-shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <span className="app-brand-mark"><Microscope size={15} /></span>
          <div>
            <h1 className="text-sm font-semibold leading-tight text-[var(--text)]">AGH Viewer</h1>
            <p className="text-[11px] leading-tight text-[var(--text-subtle)]">Microscopy image review</p>
          </div>
        </div>
        <div className="text-[11px] text-[var(--text-subtle)]">
          <span>{cases.length} cases</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="app-pane flex w-60 flex-shrink-0 flex-col border-r">
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

        <aside className="app-pane app-pane-secondary flex w-80 flex-shrink-0 flex-col border-r">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <div className="min-w-0">
              <span className="truncate text-xs font-semibold text-[var(--text)]">Images</span>
              {selectedCase && <p className="mt-1 truncate text-[11px] text-[var(--text-subtle)]">{selectedCase}</p>}
            </div>
            {selectedCase && <span className="ux-meta">{filteredFiles.length} TIFF</span>}
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
                    ? <EmptyState>No TIFF images found</EmptyState>
                    : filteredFiles.length === 0
                      ? <EmptyState icon={Search}>No matching TIFF images</EmptyState>
                      : filteredFiles.map(item => (
                        <div
                          key={item}
                          onDoubleClick={() => openViewer(item)}
                          onClick={() => { setSelectedFile(item); setPreviewError(null) }}
                          className={`ux-list-item group mx-2 my-0.5 flex cursor-pointer items-start gap-2 rounded-r-md px-3 py-2.5 ${selectedFile === item ? 'ux-list-item-selected' : ''}`}
                        >
                          <FileImage size={14} className={`mt-0.5 flex-shrink-0 ${selectedFile === item ? 'text-[var(--accent)]' : 'text-[var(--text-subtle)]'}`} />
                          <div className="min-w-0 flex-1">
                            <p className="break-all text-xs leading-snug text-[var(--text)]">{item}</p>
                            <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
                              {selectedFile === item
                                ? previewMetaLoading ? 'Loading metadata' : formatImageMeta(previewMeta)
                                : 'TIFF image'}
                            </p>
                          </div>
                          <button
                            onClick={event => { event.stopPropagation(); openViewer(item) }}
                            className="ux-icon-button h-6 w-6 flex-shrink-0 opacity-0 group-hover:opacity-100"
                            title="Open in viewer"
                          >
                            <Eye size={13} />
                          </button>
                        </div>
                      ))}
          </div>
        </aside>

        <main className="app-canvas relative flex flex-1 items-center justify-center overflow-hidden">
          {selectedFile && selectedCase ? (
            <div className="flex h-full w-full flex-col p-6">
              <div className="mb-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="mt-1 truncate text-sm font-medium text-[var(--text)]">{selectedFile}</h2>
                  <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
                    {selectedCase}
                    {previewMetaLoading ? ' | Loading metadata' : previewMeta ? ` | ${formatImageMeta(previewMeta)}` : ''}
                  </p>
                </div>
                <button onClick={() => openViewer(selectedFile)} className="ux-button ux-button-primary flex-shrink-0">
                  Open viewer <ArrowRight size={13} />
                </button>
              </div>
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <div className="app-preview-frame flex h-full w-full items-center justify-center overflow-hidden p-3">
                  <img
                    src={`${API}/cases/${encodeURIComponent(selectedCase)}/files/${encodeURIComponent(selectedFile)}/thumbnail`}
                    alt="Preview"
                    onError={() => setPreviewError('Preview failed to load')}
                    className="max-h-full max-w-full object-contain"
                    style={{ imageRendering: 'pixelated' }}
                  />
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
          onNavigateFile={filename => {
            setSelectedFile(filename)
            setPreviewError(null)
            setOpenFile(current => current ? { ...current, filename } : { case: selectedCase, filename })
          }}
          onClose={() => setOpenFile(null)}
        />
      )}
    </div>
  )
}
