export const CHANNEL_ROLES = [
  { id: 'dapi', label: 'DAPI', color: '#4488ff', defaultDisplayColor: '#4488ff' },
  { id: 'nhs', label: 'NHS Ester', color: '#d8d8d8', defaultDisplayColor: '#ffffff' },
  { id: 'actn4', label: 'ACTN4', color: '#44ff88', defaultDisplayColor: '#44ff88' },
  { id: 'unassigned', label: 'Unassigned', color: '#8b90a0', defaultDisplayColor: '#ffffff' },
]

const DEFAULT_ROLE_ORDER = ['dapi', 'nhs', 'actn4']
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export function roleInfo(role) {
  return CHANNEL_ROLES.find(item => item.id === role) || CHANNEL_ROLES[CHANNEL_ROLES.length - 1]
}

export function defaultDisplaySettingForRole(role) {
  const info = roleInfo(role)
  return {
    displayColor: info.defaultDisplayColor || '#ffffff',
  }
}

export function normalizeChannelDisplaySetting(value, role = 'unassigned') {
  const fallback = defaultDisplaySettingForRole(role)
  // Migrate settings saved by the older two-mode UI. A white tint is the
  // black-and-white representation, so a separate displayMode is unnecessary.
  const legacyGrayscale = value?.displayMode === 'grayscale'
  const displayColor = legacyGrayscale
    ? '#ffffff'
    : (typeof value?.displayColor === 'string' && HEX_COLOR.test(value.displayColor)
      ? value.displayColor
      : fallback.displayColor)
  return {
    enabled: value?.enabled !== false,
    minVal: Number.isFinite(Number(value?.minVal)) ? Number(value.minVal) : 0,
    maxVal: Number.isFinite(Number(value?.maxVal)) ? Number(value.maxVal) : 255,
    displayColor,
  }
}

export function displaySwatchStyle(setting, role = 'unassigned') {
  const normalized = normalizeChannelDisplaySetting(setting, role)
  if (normalized.displayColor.toLowerCase() === '#ffffff') {
    return { background: 'linear-gradient(90deg, #111827 0%, #ffffff 100%)' }
  }
  return { background: normalized.displayColor }
}

export function defaultChannelMapping(numChannels) {
  return Array.from({ length: Math.max(0, numChannels) }, (_, index) => ({
    channel: index,
    role: DEFAULT_ROLE_ORDER[index] || 'unassigned',
  }))
}

export function normalizeChannelMapping(value, numChannels) {
  const fallback = defaultChannelMapping(numChannels)
  if (!Array.isArray(value)) return fallback

  return fallback.map((entry, index) => {
    const saved = value[index]
    const role = CHANNEL_ROLES.some(item => item.id === saved?.role)
      ? saved.role
      : entry.role
    return { channel: index, role }
  })
}

export function channelIndexForRole(mapping, role) {
  const match = (mapping || []).find(item => item.role === role)
  return match ? match.channel : null
}

export function channelLabel(mapping, channelIndex) {
  const entry = (mapping || []).find(item => item.channel === channelIndex)
  const info = roleInfo(entry?.role)
  return `${info.label} · Ch ${channelIndex}`
}

export function roleOptions(mapping, role) {
  return (mapping || [])
    .filter(item => item.role === role)
    .map(item => ({ value: item.channel, label: channelLabel(mapping, item.channel) }))
}
