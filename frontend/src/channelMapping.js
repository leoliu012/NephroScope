export const CHANNEL_ROLES = [
  { id: 'dapi', label: 'DAPI', color: '#4488ff' },
  { id: 'nhs', label: 'NHS Ester', color: '#44ff88' },
  { id: 'actn4', label: 'ACTN4', color: '#ff5a5f' },
  { id: 'unassigned', label: 'Unassigned', color: '#8b90a0' },
]

const DEFAULT_ROLE_ORDER = ['dapi', 'nhs', 'actn4']

export function roleInfo(role) {
  return CHANNEL_ROLES.find(item => item.id === role) || CHANNEL_ROLES[CHANNEL_ROLES.length - 1]
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
