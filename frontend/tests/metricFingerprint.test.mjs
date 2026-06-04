import assert from 'node:assert/strict'
import test from 'node:test'

import { metricFingerprint } from '../src/components/analysis/metricFingerprint.js'

test('does not mark a newly computed GBM metric stale after backend calibration normalization', () => {
  const current = metricFingerprint({
    runId: 'nhs-run-1',
    roi: null,
    calibration: {
      pixelSize: 0.014,
      pixelUnit: 'um',
      expanded: true,
      expansionFactor: 7,
      effectivePixelSizeOverride: null,
    },
    effectivePixelSize: 0.002,
  })

  const stored = metricFingerprint({
    runId: 'nhs-run-1',
    roi: null,
    calibration: {
      pixelSize: 0.014,
      pixelUnit: 'um',
      expanded: true,
      expansionFactor: 7,
      effectivePixelSizeOverride: null,
      effectivePixelSize: 0.002,
      effectivePixelSizeSource: 'raw-pixel-size/expansion-factor',
    },
  })

  assert.equal(current, stored)
})

test('marks GBM metric stale when effective calibration changes', () => {
  const original = metricFingerprint({
    runId: 'nhs-run-1',
    roi: null,
    calibration: { effectivePixelSize: 0.002, pixelUnit: 'um' },
  })

  const changed = metricFingerprint({
    runId: 'nhs-run-1',
    roi: null,
    calibration: { effectivePixelSize: 0.003, pixelUnit: 'um' },
  })

  assert.notEqual(original, changed)
})

test('does not mark a newly computed Process NND metric stale after watershed normalization', () => {
  const current = metricFingerprint({
    runId: 'actn4-run-1',
    roi: null,
    calibration: { effectivePixelSize: 0.002, pixelUnit: 'um' },
    watershed: {
      preset: 'balanced',
      label: 'Balanced',
      minDistanceUm: 0.08,
      maxPairDistanceUm: 1.5,
      thresholdRelative: 0.26,
      sigma: 0,
      minAreaPercentile: 0,
      maxAreaPercentile: 100,
    },
  })

  const stored = metricFingerprint({
    runId: 'actn4-run-1',
    roi: null,
    calibration: { effectivePixelSize: 0.002, pixelUnit: 'um' },
    watershed: {
      preset: 'balanced',
      label: 'Balanced',
      minDistanceUm: 0.08,
      maxPairDistanceUm: 1.5,
      minDistance: 40,
      maxPairDistance: 750,
      thresholdRelative: 0.26,
      sigma: 0,
      minAreaPercentile: 0,
      maxAreaPercentile: 100,
      effectivePixelSize: 0.002,
      effectivePixelSizeUm: 0.002,
      pixelUnit: 'um',
    },
  })

  assert.equal(current, stored)
})

test('marks Process NND metric stale when process area filter changes', () => {
  const original = metricFingerprint({
    runId: 'actn4-run-1',
    roi: null,
    calibration: { effectivePixelSize: 0.002, pixelUnit: 'um' },
    watershed: {
      minDistanceUm: 0.08,
      maxPairDistanceUm: 1.5,
      thresholdRelative: 0.26,
      sigma: 0,
      minAreaPercentile: 0,
      maxAreaPercentile: 100,
    },
  })

  const changed = metricFingerprint({
    runId: 'actn4-run-1',
    roi: null,
    calibration: { effectivePixelSize: 0.002, pixelUnit: 'um' },
    watershed: {
      minDistanceUm: 0.08,
      maxPairDistanceUm: 1.5,
      thresholdRelative: 0.26,
      sigma: 0,
      minAreaPercentile: 10,
      maxAreaPercentile: 90,
    },
  })

  assert.notEqual(original, changed)
})
