import { useState, useEffect } from 'react'
import { FolderOpen, FileImage, ChevronRight, Loader2, Eye } from 'lucide-react'
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

export default function App() {
  const [cases, setCases]           = useState([])
  const [selectedCase, setCase]     = useState(null)
  const [files, setFiles]           = useState([])
  const [loadingCases, setLC]       = useState(true)
  const [loadingFiles, setLF]       = useState(false)
  const [casesError, setCasesError] = useState(null)
  const [filesError, setFilesError] = useState(null)
  const [casesReload, setCasesReload] = useState(0)
  const [filesReload, setFilesReload] = useState(0)
  const [previewFile, setPreview]   = useState(null)   // hovered file name
  const [previewError, setPreviewError] = useState(null)
  const [openFile, setOpenFile]     = useState(null)   // {case, filename} currently in viewer

  useEffect(() => {
    const controller = new AbortController()
    setLC(true)
    setCasesError(null)
    fetchJson(`${API}/cases`, { signal: controller.signal })
      .then(d => { setCases(d.cases || []) })
      .catch(err => { if (err.name !== 'AbortError') setCasesError(err.message) })
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
      .then(d => { setFiles(d.files || []) })
      .catch(err => { if (err.name !== 'AbortError') setFilesError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLF(false) })
    return () => controller.abort()
  }, [selectedCase, filesReload])

  const openViewer = (filename) => setOpenFile({ case: selectedCase, filename })

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0d0d1a] text-gray-200">
      {/* ── Left: Case list ─────────────────────────────────────────── */}
      <aside className="w-56 flex-shrink-0 bg-[#1a1a2e] border-r border-[#223] flex flex-col">
        <div className="px-4 py-3 border-b border-[#223] flex items-center gap-2">
          <FolderOpen size={16} className="text-[#e94560]" />
          <span className="text-sm font-semibold tracking-wide uppercase text-gray-400">Cases</span>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {loadingCases
            ? <div className="flex justify-center mt-8"><Loader2 size={20} className="animate-spin text-gray-500" /></div>
            : casesError
              ? (
                <div className="px-4 mt-4 text-xs text-red-300">
                  <p className="break-words">{casesError}</p>
                  <button onClick={() => setCasesReload(v => v + 1)} className="mt-2 px-2 py-1 rounded bg-[#223] text-gray-200 hover:bg-[#334]">Retry</button>
                </div>
              )
            : cases.length === 0
              ? <p className="text-xs text-gray-500 px-4 mt-4">No cases found</p>
              : cases.map(c => (
                  <button
                    key={c}
                    onClick={() => { setCase(c); setFiles([]); setPreview(null); setPreviewError(null) }}
                    className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2 transition-colors
                      ${selectedCase === c
                        ? 'bg-[#0f3460] text-white'
                        : 'hover:bg-[#223] text-gray-300'}`}
                  >
                    <ChevronRight size={12} className={selectedCase === c ? 'text-[#e94560]' : 'text-gray-600'} />
                    {c}
                  </button>
                ))
          }
        </div>
      </aside>

      {/* ── Center: File list ───────────────────────────────────────── */}
      <aside className="w-72 flex-shrink-0 bg-[#16213e] border-r border-[#223] flex flex-col">
        <div className="px-4 py-3 border-b border-[#223] flex items-center gap-2">
          <FileImage size={16} className="text-[#e94560]" />
          <span className="text-sm font-semibold tracking-wide uppercase text-gray-400">
            {selectedCase ? selectedCase : 'Files'}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {!selectedCase
            ? <p className="text-xs text-gray-500 px-4 mt-4">Select a case</p>
            : loadingFiles
              ? <div className="flex justify-center mt-8"><Loader2 size={20} className="animate-spin text-gray-500" /></div>
              : filesError
                ? (
                  <div className="px-4 mt-4 text-xs text-red-300">
                    <p className="break-words">{filesError}</p>
                    <button onClick={() => setFilesReload(v => v + 1)} className="mt-2 px-2 py-1 rounded bg-[#223] text-gray-200 hover:bg-[#334]">Retry</button>
                  </div>
                )
              : files.length === 0
                ? <p className="text-xs text-gray-500 px-4 mt-4">No TIFF files found</p>
                : files.map(f => (
                    <div
                      key={f}
                      onMouseEnter={() => { setPreview(f); setPreviewError(null) }}
                      onMouseLeave={() => { setPreview(null); setPreviewError(null) }}
                      onDoubleClick={() => openViewer(f)}
                      onClick={() => { setPreview(f); setPreviewError(null) }}
                      className="px-3 py-2 mx-2 my-0.5 rounded cursor-pointer flex items-start gap-2 hover:bg-[#0f3460] group transition-colors"
                    >
                      <FileImage size={14} className="mt-0.5 flex-shrink-0 text-gray-500 group-hover:text-[#e94560]" />
                      <div className="min-w-0">
                        <p className="text-xs text-gray-200 break-all leading-snug">{f}</p>
                        <p className="text-[10px] text-gray-500 mt-0.5">Double-click to open</p>
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); openViewer(f) }}
                        className="ml-auto flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Open in viewer"
                      >
                        <Eye size={14} className="text-[#e94560]" />
                      </button>
                    </div>
                  ))
          }
        </div>
      </aside>

      {/* ── Right: Preview pane ─────────────────────────────────────── */}
      <main className="flex-1 flex flex-col items-center justify-center bg-[#0d0d1a] relative overflow-hidden">
        {previewFile && selectedCase ? (
          <div className="flex flex-col items-center gap-4 w-full h-full p-6">
            <p className="text-xs text-gray-500 text-center max-w-md break-all">{previewFile}</p>
            <div className="flex-1 w-full flex items-center justify-center">
              <img
                src={`${API}/cases/${encodeURIComponent(selectedCase)}/files/${encodeURIComponent(previewFile)}/thumbnail`}
                alt="Preview"
                onError={() => setPreviewError('Preview failed to load')}
                className="max-w-full max-h-full object-contain rounded border border-[#223]"
                style={{ imageRendering: 'pixelated' }}
              />
              {previewError && <p className="absolute bottom-24 text-xs text-red-300">{previewError}</p>}
            </div>
            <button
              onClick={() => openViewer(previewFile)}
              className="px-5 py-2 bg-[#e94560] hover:bg-[#c73050] rounded text-sm font-medium transition-colors"
            >
              Open in Viewer
            </button>
          </div>
        ) : (
          <div className="text-center text-gray-600">
            <FileImage size={64} className="mx-auto mb-4 opacity-20" />
            <p className="text-sm">Hover a file to preview · Double-click to open</p>
          </div>
        )}
      </main>

      {/* ── Full-screen Image Viewer ─────────────────────────────────── */}
      {openFile && (
        <ImageViewer
          caseId={openFile.case}
          filename={openFile.filename}
          onClose={() => setOpenFile(null)}
        />
      )}
    </div>
  )
}
