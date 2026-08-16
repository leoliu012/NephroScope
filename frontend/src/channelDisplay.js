export const CHANNEL_MARKERS = [
  'Unassigned',
  'NHS ester',
  'DAPI',
  'ACTN4',
  'C3',
  'Albumin',
  'IgM',
  'C1q',
  'Fibrinogen',
  'Collagen IV',
  'Laminin',
  'CD31',
  'PanCK',
  'WT1',
  'Nephrin',
  'Podocin',
  'Synaptopodin',
  'AQP1',
  'AQP2',
  'CD68',
  'Vimentin',
  'Ki-67',
  'Custom',
]

export const CHANNEL_COLORS = [
  '#4488ff',
  '#ffffff',
  '#44ff88',
  '#ff44ff',
  '#ffcc44',
  '#ff4444',
  '#44ffff',
  '#ff8844',
]

const STORAGE_PREFIX = 'agh-viewer:channel-display:v6:'
const IMAGEJ_AUTO_THRESHOLD = 5000
const MAX_AUTO_STEP = 8

const DEFAULT_MULTICHANNEL_LAYOUT = [
  { marker: 'DAPI', color: '#4488ff' },
  { marker: 'NHS ester', color: '#ffffff' },
  { marker: 'ACTN4', color: '#44ff88' },
]

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function storageKey(caseId, filename) {
  return `${STORAGE_PREFIX}${encodeURIComponent(caseId)}/${encodeURIComponent(filename)}`
}

function channelCount(meta) {
  return Math.max(1, Number(meta?.channelCount) || 1)
}

function defaultLayout(index, meta) {
  const count = channelCount(meta)
  if (count === 1) {
    return { marker: 'NHS ester', color: '#ffffff', visible: true }
  }
  const mapped = DEFAULT_MULTICHANNEL_LAYOUT[index]
  const marker = mapped?.marker || 'Unassigned'
  return {
    marker,
    color: mapped?.color || CHANNEL_COLORS[index % CHANNEL_COLORS.length],
    visible: marker === 'NHS ester',
  }
}

export function isNhsEsterChannel(setting) {
  return (setting?.marker || '').trim().toLowerCase() === 'nhs ester'
}

export function sourceValueMax(meta) {
  const explicit = Number(meta?.channelValueMax)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return Number(meta?.bitsPerSample) > 8 ? 65535 : 255
}

export function defaultChannelSetting(index, meta) {
  const max = sourceValueMax(meta)
  const layout = defaultLayout(index, meta)
  return {
    index,
    marker: layout.marker,
    customMarker: '',
    visible: layout.visible,
    color: layout.color,
    min: 0,
    max,
    brightness: 0,
    contrast: 1,
    inverted: isNhsEsterChannel(layout),
    autoStep: 0,
  }
}

function normalizeChannelSetting(raw, index, meta) {
  const fallback = defaultChannelSetting(index, meta)
  const sourceMax = sourceValueMax(meta)
  const marker = CHANNEL_MARKERS.includes(raw?.marker) ? raw.marker : fallback.marker
  const min = clamp(Number.isFinite(Number(raw?.min)) ? Number(raw.min) : fallback.min, 0, sourceMax)
  const max = clamp(Number.isFinite(Number(raw?.max)) ? Number(raw.max) : fallback.max, 0, sourceMax)
  return {
    ...fallback,
    marker,
    customMarker: typeof raw?.customMarker === 'string' ? raw.customMarker : '',
    visible: typeof raw?.visible === 'boolean' ? raw.visible : fallback.visible,
    color: /^#[0-9a-f]{6}$/i.test(raw?.color || '') ? raw.color : fallback.color,
    min: Math.min(min, Math.max(0, max - 1)),
    max: Math.max(max, Math.min(sourceMax, min + 1)),
    // Version 4 stores the effective display window directly. Older hidden
    // post-window brightness/contrast transforms are intentionally reset.
    brightness: 0,
    contrast: 1,
    inverted: typeof raw?.inverted === 'boolean' ? raw.inverted : fallback.inverted,
    autoStep: clamp(Math.round(Number(raw?.autoStep) || 0), 0, MAX_AUTO_STEP),
  }
}

export function createDefaultChannelSettings(meta) {
  return Array.from({ length: channelCount(meta) }, (_, index) => defaultChannelSetting(index, meta))
}

export function normalizeChannelSettings(raw, meta) {
  return Array.from({ length: channelCount(meta) }, (_, index) => normalizeChannelSetting(raw?.[index], index, meta))
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function histogramWindow(stats, sourceMax, autoStep = 0) {
  const bins = Array.isArray(stats?.autoHistogramBins) && stats.autoHistogramBins.length
    ? stats.autoHistogramBins
    : Array.isArray(stats?.histogramBins) && stats.histogramBins.length
      ? stats.histogramBins
      : null

  const observedMin = Number.isFinite(Number(stats?.min)) ? Number(stats.min) : 0
  const observedMax = Number.isFinite(Number(stats?.max)) ? Number(stats.max) : sourceMax
  if (!bins?.length) return { min: observedMin, max: observedMax }

  const pixelCount = positiveNumber(stats?.pixelCount, bins.reduce((sum, count) => sum + (Number(count) || 0), 0))
  const histMin = Number.isFinite(Number(stats?.autoHistogramMin)) ? Number(stats.autoHistogramMin) : observedMin
  const binSize = positiveNumber(
    stats?.autoHistogramBinSize,
    Math.max(1, observedMax - observedMin) / Math.max(1, bins.length - 1),
  )
  const dominantBinLimit = pixelCount / 10
  const divisor = Math.max(10, IMAGEJ_AUTO_THRESHOLD / (2 ** clamp(autoStep, 0, MAX_AUTO_STEP)))
  const threshold = pixelCount / divisor

  let low = 0
  while (low < bins.length - 1) {
    const count = Number(bins[low]) || 0
    if (count <= dominantBinLimit && count > threshold) break
    low += 1
  }

  let high = bins.length - 1
  while (high > 0) {
    const count = Number(bins[high]) || 0
    if (count <= dominantBinLimit && count > threshold) break
    high -= 1
  }

  if (high < low) return { min: observedMin, max: observedMax }

  const min = histMin + (low * binSize)
  const max = histMin + (high * binSize)
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return { min: observedMin, max: observedMax }
  }
  return { min, max }
}

export function imageJAutoWindow(stats, meta, autoStep = 0) {
  const sourceMax = sourceValueMax(meta)
  const window = histogramWindow(stats, sourceMax, autoStep)
  const nextMin = Math.max(0, Math.min(sourceMax - 1, Math.round(window.min)))
  const nextMax = Math.max(nextMin + 1, Math.min(sourceMax, Math.round(window.max)))
  return { min: nextMin, max: nextMax }
}

export function autoWindowChannelSettings(settings, statsByChannel, meta, options = {}) {
  const {
    onlyUninitialized = false,
    channelIndex = null,
    advanceAutoStep = false,
  } = options
  const sourceMax = sourceValueMax(meta)

  return (settings || []).map((setting, index) => {
    if (channelIndex !== null && Number(setting.index) !== Number(channelIndex)) return setting
    const stats = statsByChannel?.[index]
    if (!stats) return setting
    const looksUninitialized = Number(setting.min) === 0
      && Number(setting.max) === sourceMax
      && Number(setting.brightness) === 0
      && Number(setting.contrast) === 1
    if (onlyUninitialized && !looksUninitialized) return setting

    const currentStep = advanceAutoStep
      ? clamp(Math.round(Number(setting.autoStep) || 0), 0, MAX_AUTO_STEP)
      : 0
    const next = imageJAutoWindow(stats, meta, currentStep)

    return {
      ...setting,
      min: next.min,
      max: next.max,
      brightness: 0,
      contrast: 1,
      autoStep: advanceAutoStep ? clamp(currentStep + 1, 0, MAX_AUTO_STEP) : 0,
    }
  })
}

export function loadChannelSettings(caseId, filename, meta) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(caseId, filename)) || 'null')
    return normalizeChannelSettings(saved, meta)
  } catch {
    return createDefaultChannelSettings(meta)
  }
}

export function saveChannelSettings(caseId, filename, settings) {
  try {
    localStorage.setItem(storageKey(caseId, filename), JSON.stringify(settings))
  } catch {
    // Display controls remain usable even when storage is unavailable.
  }
}

export function markerLabel(setting) {
  if (setting?.marker === 'Custom') return setting.customMarker.trim() || 'Custom marker'
  return setting?.marker || 'Unassigned'
}
