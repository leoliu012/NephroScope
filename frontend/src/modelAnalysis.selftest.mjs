import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calibrationPayload,
  dynamicThicknessMeasurements,
  formatThicknessMeasurement,
  formatThicknessValue,
  indexModelRunsByZ,
  modelMaskContourAlpha,
  normalizeModelOverlaySettings,
  normalizeModelSkeletonSettings,
  normalizePolygonRoi,
  polygonArea,
} from './modelAnalysis.js'

test('normalizes model overlay settings', () => {
  assert.deepEqual(normalizeModelOverlaySettings({ visible: false, color: '#ABCDEF', opacity: 4, displayMode: 'contour' }), {
    visible: false,
    color: '#abcdef',
    opacity: 1,
    displayMode: 'contour',
  })
  assert.equal(normalizeModelOverlaySettings({ displayMode: 'unknown' }).displayMode, 'filled')
  assert.equal(normalizeModelOverlaySettings(null).displayMode, 'filled')
})

test('derives a one-pixel inner mask contour without mutating the mask', () => {
  const full = new Uint8ClampedArray(9).fill(255)
  const original = full.slice()
  assert.deepEqual(Array.from(modelMaskContourAlpha(full, 3, 3)), [
    255, 255, 255,
    255, 0, 255,
    255, 255, 255,
  ])
  assert.deepEqual(full, original)

  const isolated = new Uint8ClampedArray([
    0, 0, 0,
    0, 255, 0,
    0, 0, 0,
  ])
  assert.deepEqual(modelMaskContourAlpha(isolated, 3, 3), isolated)

  const hole = new Uint8ClampedArray(25).fill(255)
  hole[12] = 0
  const holeContour = modelMaskContourAlpha(hole, 5, 5)
  assert.equal(holeContour[6], 255)
  assert.equal(holeContour[7], 255)
  assert.equal(holeContour[12], 0)
  assert.equal(holeContour[0], 255)
  assert.throws(() => modelMaskContourAlpha(hole, 4, 5), /length/)
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
