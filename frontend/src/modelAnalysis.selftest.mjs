import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calibrationPayload,
  dynamicThicknessMeasurements,
  formatThicknessMeasurement,
  formatThicknessValue,
  indexModelRunsByZ,
  normalizeModelOverlaySettings,
  normalizeModelSkeletonSettings,
  normalizePolygonRoi,
  polygonArea,
} from './modelAnalysis.js'

test('normalizes model overlay settings', () => {
  assert.deepEqual(normalizeModelOverlaySettings({ visible: false, color: '#ABCDEF', opacity: 4 }), {
    visible: false,
    color: '#abcdef',
    opacity: 1,
  })
})

test('normalizes model skeleton display settings', () => {
  assert.deepEqual(normalizeModelSkeletonSettings({ visible: false, color: '#ABCDEF', thickness: 99 }), {
    visible: false,
    color: '#abcdef',
    thickness: 12,
  })
  assert.equal(normalizeModelSkeletonSettings({ thickness: 2.4 }).thickness, 2)
})

test('clamps and validates polygon ROIs', () => {
  const roi = normalizePolygonRoi([[-5, -4], [12, 0], [12, 8], [0, 8], [-5, -4]], 10, 6)
  assert.deepEqual(roi, {
    type: 'polygon',
    points: [[0, 0], [10, 0], [10, 6], [0, 6]],
  })
  assert.equal(polygonArea(roi.points), 60)
  assert.equal(normalizePolygonRoi([[1, 1], [1, 1], [1, 1]], 10, 10), null)
})

test('builds the requested physical calibration contract', () => {
  assert.deepEqual(calibrationPayload({
    pixelSizeXUm: 0.02,
    pixelSizeYUm: 0.03,
    expansionEnabled: true,
    expansionFactor: 7.1,
  }), {
    pixelSizeXUm: 0.02,
    pixelSizeYUm: 0.03,
    expansionEnabled: true,
    expansionFactor: 7.1,
  })
})

test('formats common thickness response variants', () => {
  assert.equal(formatThicknessMeasurement({ meanThickness: 123.456, unit: 'nm' }), '123.5 nm')
  assert.equal(formatThicknessMeasurement({ meanThicknessUm: 0.1234 }), '0.123 µm')
})

test('restores saved runs by Z and dynamically applies pixel size and EF', () => {
  const runs = indexModelRunsByZ([{
    runId: 'run-1',
    status: 'SUCCEEDED',
    request: { zIndex: 3, channelIndex: 1 },
  }], 'case/image.tif')
  assert.equal(runs['3'].runId, 'run-1')
  assert.equal(runs['3'].maskStatus, 'loading')
  assert.equal(runs['3'].imageKey, 'case/image.tif')

  const values = dynamicThicknessMeasurements({ meanThicknessPixels: 4 }, {
    pixelSizeXUm: 0.02,
    pixelSizeYUm: 0.02,
    expansionEnabled: true,
    expansionFactor: 5,
  })
  assert.equal(values.before.value, 0.08)
  assert.equal(values.before.unit, 'µm')
  assert.equal(values.after.value, 16)
  assert.equal(values.after.unit, 'nm')
  assert.equal(formatThicknessValue(values.after), '16.00 nm')
})
