export const WATERSHED_PRESETS = {
  conservative: {
    preset: 'conservative',
    label: 'Conservative',
    description: 'Avoid over-splitting processes that are already separate.',
    minDistanceUm: 0.10,
    maxPairDistanceUm: 1.50,
    thresholdRelative: 0.34,
    sigma: 1.0,
  },
  balanced: {
    preset: 'balanced',
    label: 'Balanced',
    description: 'Recommended starting point for most kidney images.',
    minDistanceUm: 0.08,
    maxPairDistanceUm: 1.50,
    thresholdRelative: 0.26,
    sigma: 0.0,
  },
  aggressive: {
    preset: 'aggressive',
    label: 'Aggressive',
    description: 'Split more touching processes when boundaries are crowded.',
    minDistanceUm: 0.055,
    maxPairDistanceUm: 1.50,
    thresholdRelative: 0.18,
    sigma: 0.8,
  },
}

export const DEFAULT_WATERSHED_PRESET = WATERSHED_PRESETS.balanced

export function defaultWatershedPayload() {
  return { ...DEFAULT_WATERSHED_PRESET }
}

export function presetWatershedPayload(presetId) {
  return { ...(WATERSHED_PRESETS[presetId] || DEFAULT_WATERSHED_PRESET) }
}

export function watershedLabel(settings) {
  if (!settings) return DEFAULT_WATERSHED_PRESET.label
  if (settings.label) return settings.label
  if (settings.preset && WATERSHED_PRESETS[settings.preset]) return WATERSHED_PRESETS[settings.preset].label
  return 'Custom'
}
