import assert from 'node:assert/strict'
import {
  DAPI_DEFAULT_COLOR,
  createDefaultChannelSettings,
  normalizeChannelSettings,
} from './channelDisplay.js'

const meta = { channelCount: 3, bitsPerSample: 16 }
const defaults = createDefaultChannelSettings(meta)

assert.equal(DAPI_DEFAULT_COLOR, '#0050d0')
assert.equal(defaults[0].marker, 'DAPI')
assert.equal(defaults[0].color, '#0050d0')
assert.equal(defaults[0].denoiseEnabled, false)
assert.equal(defaults[0].denoise, 0.5)
assert.equal(defaults[0].localContrastEnabled, false)
assert.equal(defaults[0].localContrast, 0.35)

const migrated = normalizeChannelSettings([
  { ...defaults[0], color: '#4488ff' },
  { ...defaults[1], color: '#abcdef' },
  { ...defaults[2], color: '#123456' },
], meta)

assert.equal(migrated[0].color, '#0050d0')
assert.equal(migrated[1].color, '#abcdef')
assert.equal(migrated[2].color, '#123456')

const normalizedEffects = normalizeChannelSettings([
  {
    ...defaults[0],
    denoiseEnabled: true,
    denoise: 10,
    localContrastEnabled: true,
    localContrast: -2,
  },
], { channelCount: 1, bitsPerSample: 16 })

assert.equal(normalizedEffects[0].denoiseEnabled, true)
assert.equal(normalizedEffects[0].denoise, 1)
assert.equal(normalizedEffects[0].localContrastEnabled, true)
assert.equal(normalizedEffects[0].localContrast, 0)

console.log('All channel display self-tests passed.')
