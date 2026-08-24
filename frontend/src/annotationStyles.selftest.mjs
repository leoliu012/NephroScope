import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_ANNOTATION_STROKE_WIDTH,
  DEFAULT_ARROW_STROKE_WIDTH,
  MAX_ANNOTATION_STROKE_WIDTH,
  defaultAnnotationStrokeWidth,
  resolveAnnotationStrokeWidth,
} from './annotationStyles.js'

test('uses the requested annotation and arrow stroke defaults', () => {
  assert.equal(DEFAULT_ANNOTATION_STROKE_WIDTH, 6)
  assert.equal(DEFAULT_ARROW_STROKE_WIDTH, 8)
  assert.equal(defaultAnnotationStrokeWidth('line'), 6)
  assert.equal(defaultAnnotationStrokeWidth({ type: 'arrow' }), 8)
})

test('limits annotation strokes to the supported 20 px maximum', () => {
  assert.equal(MAX_ANNOTATION_STROKE_WIDTH, 20)
  assert.equal(resolveAnnotationStrokeWidth(21, 'line'), 20)
  assert.equal(resolveAnnotationStrokeWidth('12', 'arrow'), 12)
  assert.equal(resolveAnnotationStrokeWidth(null, 'line'), 6)
  assert.equal(resolveAnnotationStrokeWidth(undefined, 'arrow'), 8)
})
