export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function stableMetricNumber(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Number(parsed.toPrecision(12))
}

function normalizePixelUnit(value) {
  return String(value || 'um')
    .trim()
    .toLowerCase()
    .replace('µ', 'u')
}

function canonicalRoi(roi) {
  if (!roi) return null
  return {
    x: stableMetricNumber(roi.x),
    y: stableMetricNumber(roi.y),
    width: stableMetricNumber(roi.width),
    height: stableMetricNumber(roi.height),
  }
}

function canonicalCalibration(calibration, fallbackEffectivePixelSize = null) {
  const source = calibration || {}
  return {
    effectivePixelSize: stableMetricNumber(source.effectivePixelSize ?? fallbackEffectivePixelSize),
    pixelUnit: normalizePixelUnit(source.pixelUnit),
  }
}

function canonicalWatershed(watershed) {
  if (!watershed) return null
  return {
    minDistanceUm: stableMetricNumber(watershed.minDistanceUm),
    maxPairDistanceUm: stableMetricNumber(watershed.maxPairDistanceUm),
    thresholdRelative: stableMetricNumber(watershed.thresholdRelative),
    sigma: stableMetricNumber(watershed.sigma),
    minAreaPercentile: stableMetricNumber(watershed.minAreaPercentile ?? 0),
    maxAreaPercentile: stableMetricNumber(watershed.maxAreaPercentile ?? 100),
  }
}

export function metricFingerprint({
  runId,
  roi,
  calibration,
  effectivePixelSize,
  watershed,
}) {
  return stableJson({
    runId: runId || null,
    roi: canonicalRoi(roi),
    calibration: canonicalCalibration(calibration, effectivePixelSize),
    watershed: canonicalWatershed(watershed),
  })
}
