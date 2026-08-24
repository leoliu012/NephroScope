import assert from 'node:assert/strict'
import {
  getImageMagnificationGroup,
  organizeImageFilenames,
  organizeImageFilenamesByMagnification,
  sortAlphanumeric,
} from './collectionOrganization.js'

assert.deepEqual(
  sortAlphanumeric(['Case 11', 'Case 2', 'case 1', 'Case 10', 'Case A']),
  ['case 1', 'Case 2', 'Case 10', 'Case 11', 'Case A'],
)

const organized = organizeImageFilenames([
  'sample_other.tif',
  'sample_POST_2.tif',
  'sample_pre_1.tif',
  'sample_post_1.tif',
  'sample_PRE_2.tif',
])

assert.deepEqual(organized.map(group => [group.id, group.files]), [
  ['post', ['sample_POST_2.tif', 'sample_post_1.tif']],
  ['pre', ['sample_pre_1.tif', 'sample_PRE_2.tif']],
  ['other', ['sample_other.tif']],
])

assert.equal(getImageMagnificationGroup('sample_10x_post.tif'), '10x')
assert.equal(getImageMagnificationGroup('sample-10X-post.tif'), '10x')
assert.equal(getImageMagnificationGroup('sample 60x post.tif'), '60x')
assert.equal(getImageMagnificationGroup('sample.60X.post.tif'), '60x')
assert.equal(getImageMagnificationGroup('10X.tif'), '10x')
assert.equal(getImageMagnificationGroup('sample_60x'), '60x')
assert.equal(getImageMagnificationGroup('sample_10x001_post.tif'), '10x')
assert.equal(getImageMagnificationGroup('sampleabc10Xdef_post.tif'), '10x')
assert.equal(getImageMagnificationGroup('sample_110x_post.tif'), '10x')
assert.equal(getImageMagnificationGroup('sample_a10xy_post.tif'), '10x')
assert.equal(getImageMagnificationGroup('sample_60x001_post.tif'), '60x')
assert.equal(getImageMagnificationGroup('sampleabc60Xdef_post.tif'), '60x')
assert.equal(getImageMagnificationGroup('sample_10x_60x_post.tif'), '10x')
assert.equal(getImageMagnificationGroup('sample_without_magnification.tif'), 'other')

const byMagnification = organizeImageFilenamesByMagnification([
  'first_other.tif',
  'first_60X.tif',
  'first-10x.tif',
  'second_60x.tif',
  'second 10X.tif',
  'second_other.tif',
])

assert.deepEqual(byMagnification.map(group => [group.id, group.label, group.files]), [
  ['10x', '10X', ['first-10x.tif', 'second 10X.tif']],
  ['60x', '60X', ['first_60X.tif', 'second_60x.tif']],
  ['other', 'Other magnifications', ['first_other.tif', 'second_other.tif']],
])

console.log('All collection organization self-tests passed.')
