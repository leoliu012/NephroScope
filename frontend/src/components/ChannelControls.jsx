import { Eye, EyeOff } from 'lucide-react'
import { CHANNEL_ROLES, roleInfo } from '../channelMapping.js'

export default function ChannelControls({
  settings,
  onChange,
  numChannels,
  channelMapping,
  onMappingChange,
}) {
  if (!settings.length) return null

  return (
    <div className="flex flex-col gap-3 w-full">
      {settings.slice(0, numChannels).map((ch, i) => {
        const mapping = channelMapping?.[i] || { channel: i, role: 'unassigned' }
        const def = roleInfo(mapping.role)
        return (
          <div key={i} className="ux-card flex flex-col gap-2 p-3">
            <div className="flex items-center gap-2">
              <button
                onClick={() => onChange(i, { enabled: !ch.enabled })}
                className="ux-icon-button h-6 w-6 flex-shrink-0"
                title={ch.enabled ? 'Hide channel' : 'Show channel'}
              >
                {ch.enabled
                  ? <Eye size={15} style={{ color: def.color }} />
                  : <EyeOff size={15} className="text-gray-600" />}
              </button>
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ background: def.color }}
              />
              <span className="text-xs text-gray-300 flex-1 leading-tight">Ch {i}</span>
              <select
                value={mapping.role}
                onChange={e => onMappingChange?.(i, e.target.value)}
                className="ux-select max-w-[8.25rem] py-1 text-[11px]"
              >
                {CHANNEL_ROLES.map(role => (
                  <option key={role.id} value={role.id}>{role.label}</option>
                ))}
              </select>
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
                    style={{ accentColor: def.color }}
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
                    style={{ accentColor: def.color }}
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


