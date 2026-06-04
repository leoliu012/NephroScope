import { Eye, EyeOff } from 'lucide-react'
import { CHANNEL_ROLES, displaySwatchStyle, normalizeChannelDisplaySetting } from '../channelMapping.js'

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
        const ch = normalizeChannelDisplaySetting(rawSetting, mapping.role)
        const isBlackAndWhite = ch.displayColor.toLowerCase() === '#ffffff'
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
                  ? <Eye size={15} style={{ color: ch.displayColor }} />
                  : <EyeOff size={15} className="text-gray-600" />}
              </button>
            </div>

            {ch.enabled && (
              <div className="mt-2 flex flex-col gap-1.5 pl-5">
                <div className="grid grid-cols-[3.2rem_auto_1fr] items-center gap-2">
                  <span className="text-[11px] text-[var(--text-subtle)]">Tint</span>
                  <input
                    type="color"
                    value={ch.displayColor}
                    onChange={e => onChange(i, { displayColor: e.target.value })}
                    className="h-7 w-8 cursor-pointer rounded border border-[var(--border)] bg-transparent p-0.5"
                    title="Channel color tint"
                  />
                  <button
                    type="button"
                    onClick={() => onChange(i, { displayColor: '#ffffff' })}
                    className={`ux-button min-h-0 justify-self-start px-2 py-1 text-[10px] ${isBlackAndWhite ? 'ux-button-secondary' : 'ux-button-ghost'}`}
                    aria-pressed={isBlackAndWhite}
                    title="Grayscale mode"
                  >
                    Grayscale
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-8 text-[11px] text-[var(--text-subtle)]">Dark</span>
                  <input
                    type="range" min={0} max={254} step={1}
                    value={ch.minVal}
                    onChange={e => onChange(i, { minVal: +e.target.value })}
                    className="flex-1"
                    title="Minimum brightness threshold"
                  />
                  <span className="w-8 text-right font-mono text-[11px] text-[var(--text-subtle)]">{ch.minVal}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-8 text-[11px] text-[var(--text-subtle)]">Bright</span>
                  <input
                    type="range" min={1} max={255} step={1}
                    value={ch.maxVal}
                    onChange={e => onChange(i, { maxVal: +e.target.value })}
                    className="flex-1"
                    title="Maximum brightness threshold"
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
