import assert from 'node:assert/strict'
import {
  DEFAULT_EXPORT_FORMAT,
  EXPORT_FORMAT_OPTIONS,
  exportFilename,
  exportFormatOption,
} from './exportOptions.js'

assert.equal(DEFAULT_EXPORT_FORMAT, 'pdf')
assert.deepEqual(EXPORT_FORMAT_OPTIONS.map(option => option.id), ['pdf', 'png', 'jpeg'])
assert.equal(exportFormatOption('png').mimeType, 'image/png')
assert.equal(exportFormatOption('unknown').id, 'pdf')
assert.equal(exportFilename('sample.ome.tif', 'pdf', true), 'sample.ome_annotated.pdf')
assert.equal(exportFilename('sample.tiff', 'png', false), 'sample.png')
assert.equal(exportFilename('folder\\sample.TIF', 'jpeg', true), 'sample_annotated.jpeg')
assert.equal(exportFilename('', 'png', true), 'image_annotated.png')

console.log('exportOptions self-test passed')
