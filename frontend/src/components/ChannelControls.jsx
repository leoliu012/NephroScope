import { Eye, EyeOff } from 'lucide-react'
import { CHANNEL_ROLES, displaySwatchStyle, normalizeChannelDisplaySetting, roleInfo } from '../channelMapping.js'

export default function ChannelControls({
  settings,
  onChange,
  numChannels,
  channelMapping,
  onMappingChange,
}) {
  if (!settings.length) return null

  return (
    <div className="w-full">
      {settings.slice(0, numChannels).map((rawSetting, i) => {
        const mapping = channelMapping?.[i] || { channel: i, role: 'unassigned' }
        const def = roleInfo(mapping.role)
        const ch = normalizeChannelDisplaySetting(rawSetting, mapping.role)
        return (
          <div key={i} className={`channel-row ${ch.enabled ? '' : 'opacity-50'}`}>
            <div className="flex items-center gap-2">
              <span className="channel-swatch" style={displaySwatchStyle(ch, mapping.role)} />
              <span className="w-9 flex-shrink-0 font-mono text-[11px] text-[var(--text-subtle)]">Ch {i}</span>
              <select
                value={mapping.role}
                onChange={e => onMappingChange?.(i, e.target.value)}
                className="ux-select h-8 min-w-0 flex-1 py-1 text-[11px]"
              >
                {CHANNEL_ROLES.map(role => (
                  <option key={role.id} value={role.id}>{role.label}</option>
                ))}
              </select>
              <button
                onClick={() => onChange(i, { enabled: !ch.enabled })}
                className="ux-icon-button h-6 w-6 flex-shrink-0"
                title={ch.enabled ? 'Hide channel' : 'Show channel'}
              >
                {ch.enabled
                  ? <Eye size={15} style={{ color: ch.displayMode === 'color' ? ch.displayColor : def.color }} />
                  : <EyeOff size={15} className="text-gray-600" />}
              </button>
            </div>

            {ch.enabled && (
              <div className="mt-2 flex flex-col gap-1.5 pl-5">
                <div className="grid grid-cols-[3.2rem_1fr_auto] items-center gap-2">
                  <span className="text-[11px] text-[var(--text-subtle)]">Display</span>
                  <select
                    value={ch.displayMode}
                    onChange={e => onChange(i, { displayMode: e.target.value })}
                    className="ux-select h-7 py-0 text-[11px]"
                  >
                    <option value="grayscale">Black &amp; white</option>
                    <option value="color">Color tint</option>
                  </select>
                  {ch.displayMode === 'color' ? (
                    <input
                      type="color"
                      value={ch.displayColor}
                      onChange={e => onChange(i, { displayColor: e.target.value })}
                      className="h-7 w-8 cursor-pointer rounded border border-[var(--border)] bg-transparent p-0.5"
                      title="Custom channel color"
                    />
                  ) : (
                    <span className="h-6 w-8 rounded border border-[var(--border)]" style={displaySwatchStyle(ch, mapping.role)} />
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-8 text-[11px] text-[var(--text-subtle)]">Min</span>
                  <input
                    type="range" min={0} max={254} step={1}
                    value={ch.minVal}
                    onChange={e => onChange(i, { minVal: +e.target.value })}
                    className="flex-1"
                  />
                  <span className="w-8 text-right font-mono text-[11px] text-[var(--text-subtle)]">{ch.minVal}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-8 text-[11px] text-[var(--text-subtle)]">Max</span>
                  <input
                    type="range" min={1} max={255} step={1}
                    value={ch.maxVal}
                    onChange={e => onChange(i, { maxVal: +e.target.value })}
                    className="flex-1"
                  />
                  <span className="w-8 text-right font-mono text-[11px] text-[var(--text-subtle)]">{ch.maxVal}</span>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
