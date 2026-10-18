import assert from 'node:assert/strict'
import test from 'node:test'
import { annotationMarkers, clusterAnnotationPins, modelSliceMarks, zIndexForAnnotation } from './zSliceMarkers.js'

test('crowded annotation pins merge into one pin with the total count', () => {
  const markers = annotationMarkers([{ zIndex: 0 }, { zIndex: 1 }, { zIndex: 1 }, { zIndex: 2 }, { zIndex: 30 }, {}], 40)
  assert.deepEqual(markers, [{ zIndex: 0, count: 2 }, { zIndex: 1, count: 2 }, { zIndex: 2, count: 1 }, { zIndex: 30, count: 1 }])
  const pins = clusterAnnotationPins(markers, 40, 390)
  assert.deepEqual(pins.map(pin => [pin.slices, pin.count]), [[[0, 1, 2], 5], [[30], 1]])
  assert.equal(pins[0].zIndex, 0)
  // Wide sliders keep every slice separate.
  assert.equal(clusterAnnotationPins(markers, 40, 4000).length, 4)
  assert.equal(zIndexForAnnotation({ zIndex: 99 }, 5), 4)
})

test('segmented and running slices become slider marks; running wins', () => {
  const marks = modelSliceMarks({
    0: { status: 'SUCCEEDED' }, 1: { status: 'queued' }, 2: { status: 'FAILED' }, 7: { status: 'SUCCEEDED' },
    x: { status: 'SUCCEEDED', requestedZIndex: 3 }, 9: { status: 'SUCCEEDED' },
  }, 8)
  assert.deepEqual(marks, [
    { zIndex: 0, state: 'segmented' }, { zIndex: 1, state: 'running' }, { zIndex: 3, state: 'segmented' }, { zIndex: 7, state: 'segmented' },
  ])
})
