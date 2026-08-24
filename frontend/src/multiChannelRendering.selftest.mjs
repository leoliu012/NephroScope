import assert from 'node:assert/strict'
import test from 'node:test'

import {
  denoiseCrossSample,
  localContrastIntensity,
  medianOfFive,
  webGlImagePixelGlsl,
  webGlSourceRowForFragment,
} from './multiChannelRendering.js'

test('maps WebGL fragment rows to top-left image rows without an offset', () => {
  const renderedTopToBottom = [2.5, 1.5, 0.5]
    .map(fragmentY => webGlSourceRowForFragment(fragmentY, 3))
  assert.deepEqual(renderedTopToBottom, [0, 1, 2])
})

test('emits the coordinate formula used by the image shader', () => {
  assert.equal(webGlImagePixelGlsl(3), `ivec2 pixel = ivec2(gl_FragCoord.xy);
      pixel.y = 3 - 1 - pixel.y;`)
  assert.throws(() => webGlImagePixelGlsl(0), /positive integer/)
  assert.throws(() => webGlSourceRowForFragment(Number.NaN, 3), /finite/)
})

test('median denoise removes an isolated cross-neighbourhood spike and blends by amount', () => {
  const samples = [100, 10, 12, 11, 9]
  const preserved = [...samples]
  assert.equal(medianOfFive(...samples), 11)
  assert.equal(denoiseCrossSample(...samples, 0), 100)
  assert.equal(denoiseCrossSample(...samples, 0.5), 55.5)
  assert.equal(denoiseCrossSample(...samples, 1), 11)
  assert.deepEqual(samples, preserved)
})

test('local contrast blends the global and neighbourhood-normalized intensity', () => {
  assert.equal(localContrastIntensity(0.2, 50, 0, 100, false, 0.5), 0.35)
  assert.equal(localContrastIntensity(0.8, 25, 0, 100, true, 0.5), 0.775)
  assert.equal(localContrastIntensity(0.4, 5, 5, 5, false, 1), 0.4)
  assert.equal(localContrastIntensity(0.2, 50, 0, 100, false, 10), 0.5)
})
