import { Eye, EyeOff } from 'lucide-react'

const CH_DEFAULTS = [
  { label: 'Ch 0 – DAPI',        color: '#4488ff', dot: '#4488ff' },
  { label: 'Ch 1 – Pan-protein', color: '#ffffff', dot: '#aaaaaa' },
  { label: 'Ch 2 – Albumin',     color: '#ff4444', dot: '#ff4444' },
  { label: 'Ch 3 – IgM',         color: '#ff44ff', dot: '#ff44ff' },
]

export default function ChannelControls({ settings, onChange, numChannels }) {
  if (!settings.length) return null

  return (
    <div className="flex flex-col gap-3 w-full">
      {settings.slice(0, numChannels).map((ch, i) => {
        const def = CH_DEFAULTS[i] || { label: `Ch ${i}`, color: '#ffffff', dot: '#888' }
        return (
          <div key={i} className="bg-[#0f1a30] rounded-lg p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => onChange(i, { enabled: !ch.enabled })}
                className="flex-shrink-0 text-gray-400 hover:text-white transition-colors"
                title={ch.enabled ? 'Hide channel' : 'Show channel'}
              >
                {ch.enabled
                  ? <Eye size={15} style={{ color: def.dot }} />
                  : <EyeOff size={15} className="text-gray-600" />}
              </button>
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ background: def.dot }}
              />
              <span className="text-xs text-gray-300 flex-1 leading-tight">{def.label}</span>
            </div>

            {ch.enabled && (
              <div className="flex flex-col gap-1 pl-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-500 w-6">Min</span>
                  <input
                    type="range" min={0} max={254} step={1}
                    value={ch.minVal}
                    onChange={e => onChange(i, { minVal: +e.target.value })}
                    className="flex-1"
                    style={{ accentColor: def.dot }}
                  />
                  <span className="text-[10px] text-gray-500 w-7 text-right">{ch.minVal}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-500 w-6">Max</span>
                  <input
                    type="range" min={1} max={255} step={1}
                    value={ch.maxVal}
                    onChange={e => onChange(i, { maxVal: +e.target.value })}
                    className="flex-1"
                    style={{ accentColor: def.dot }}
                  />
                  <span className="text-[10px] text-gray-500 w-7 text-right">{ch.maxVal}</span>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
