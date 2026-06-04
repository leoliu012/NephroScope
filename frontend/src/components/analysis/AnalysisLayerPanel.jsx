import { Eye, EyeOff } from 'lucide-react'

function overlayMeta(name) {
  const basename = String(name).split('/').pop()
  if (basename === 'overlay_ACTN4.png') return { group: 'Segmentation', label: 'ACTN4 process mask' }
  if (basename === 'overlay_NHS_GBM.png') return { group: 'Segmentation', label: 'NHS GBM mask' }
  if (basename === 'proc_outer_contours.png') return { group: 'Process QC', label: 'Included processes' }
  if (basename === 'proc_contours.png') return { group: 'Process QC', label: 'Split boundaries' }
  if (basename === 'proc_included_contours.png') return { group: 'Process QC', label: 'Included process labels' }
  if (basename === 'proc_excluded_contours.png') return { group: 'Process QC', label: 'Excluded processes' }
  if (basename === 'proc_all_contours.png') return { group: 'Process QC', label: 'All process labels' }
  return {
    group: 'Other',
    label: basename.replace(/^overlay_/, '').replace(/\.png$/, '').replace(/_/g, ' '),
  }
}

function LayerRow({ label, visible, opacity = 1, onToggle, onOpacity }) {
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-[12px] text-gray-400 hover:text-gray-200"
      >
        {visible ? <Eye size={11} /> : <EyeOff size={11} />}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </button>
      {visible && onOpacity && (
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={opacity}
          onChange={e => onOpacity(Number(e.target.value))}
          className="w-full"
        />
      )}
    </div>
  )
}

export default function AnalysisLayerPanel({
  overlayNames,
  visibleOverlays,
  setVisibleOverlays,
  thickness,
  processMetric,
  visibleVectors,
  setVisibleVectors,
}) {
  if (!overlayNames.length && !thickness && !processMetric) return null

  const grouped = overlayNames.reduce((acc, name) => {
    const meta = overlayMeta(name)
    if (!acc[meta.group]) acc[meta.group] = []
    acc[meta.group].push({ name, ...meta })
    return acc
  }, {})

  return (
    <div className="space-y-3 border-t border-[var(--border)] pt-3">
      <p className="ux-section-label">Layers</p>
      {Object.entries(grouped).map(([group, items]) => (
        <div key={group} className="space-y-2">
          <p className="text-[12px] font-semibold text-gray-500">{group}</p>
          {items.map(({ name, label }) => {
            const state = visibleOverlays[name]
            return (
              <LayerRow
                key={name}
                label={label}
                visible={state !== false}
                opacity={typeof state === 'number' ? state : 1}
                onToggle={() => setVisibleOverlays(prev => ({
                  ...prev,
                  [name]: prev[name] === false ? 0.85 : false,
                }))}
                onOpacity={opacity => setVisibleOverlays(prev => ({ ...prev, [name]: opacity }))}
              />
            )
          })}
        </div>
      ))}
      {(thickness || processMetric) && (
        <div className="space-y-2">
          <p className="text-[12px] font-semibold text-gray-500">Measurements</p>
          {thickness && (
            <LayerRow
              label="GBM thickness map"
              visible={visibleVectors?.thickness !== false}
              onToggle={() => setVisibleVectors?.(prev => ({ ...prev, thickness: prev.thickness === false }))}
            />
          )}
          {processMetric && (
            <LayerRow
              label="NND vectors"
              visible={visibleVectors?.process !== false}
              onToggle={() => setVisibleVectors?.(prev => ({ ...prev, process: prev.process === false }))}
            />
          )}
        </div>
      )}
    </div>
  )
}
