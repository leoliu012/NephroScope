import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAnalysisBatch, saveAnalysisBatch } from './caseAnalysis.js'
import {
  combinedThicknessExportLayout, imageThicknessReport, imageThicknessScope,
  imageThicknessSettingsChanged, makeImageThicknessBatch, thicknessReportPages,
} from './imageThickness.js'

const calibration = { pixelSizeXUm: 0.5, pixelSizeYUm: 0.5, expansionEnabled: true, expansionFactor: 2 }
const input = { caseId: 'case1', filename: 'image.tif', zCount: 6, gap: 1, channelIndex: 1, calibration }

test('viewer analysis uses the same slice selection and snapshots calibration', () => {
  const batch = makeImageThicknessBatch(input, 'image-analysis')
  assert.deepEqual(batch.jobs.map(job => job.zIndex), [0, 2, 4])
  assert.deepEqual(batch.images[0].calibration, calibration)
  assert.notEqual(batch.images[0].calibration, calibration)
  assert.equal(imageThicknessSettingsChanged(batch, input), false)
  for (const update of [{ gap: 0 }, { channelIndex: 0 }, { calibration: { ...calibration, expansionFactor: 7 } }]) {
    assert.equal(imageThicknessSettingsChanged(batch, { ...input, ...update }), true)
  }
  assert.deepEqual(makeImageThicknessBatch({ ...input, zCount: 2, gap: 8 }, 'short').jobs.map(job => job.zIndex), [1])
})

test('image/user/source-specific persistence does not replace Case analysis', () => {
  const data = new Map()
  globalThis.localStorage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
  const meta = { sourceId: 'path-a', sourceSize: 10, sourceMtimeNs: 123 }
  const scope = imageThicknessScope('case1', 'image.tif', meta)
  const batch = makeImageThicknessBatch(input, 'viewer')
  saveAnalysisBatch('alice', { ...batch, id: 'cases' })
  saveAnalysisBatch('alice', batch, scope)
  assert.equal(loadAnalysisBatch('alice').id, 'cases')
  assert.equal(loadAnalysisBatch('alice', scope).id, 'viewer')
  assert.equal(loadAnalysisBatch('bob', scope), null)
  for (const different of [
    imageThicknessScope('case2', 'image.tif', meta),
    imageThicknessScope('case1', 'another.tif', meta),
    imageThicknessScope('case1', 'image.tif', { ...meta, sourceMtimeNs: 124 }),
    imageThicknessScope('case1', 'image.tif', { ...meta, sourceId: 'path-b' }),
  ]) assert.equal(loadAnalysisBatch('alice', different), null)
  delete globalThis.localStorage
})

test('report and sidebar share exact point-weighted statistics and record partial/empty runs', () => {
  const batch = makeImageThicknessBatch(input, 'viewer')
  batch.jobs.forEach((job, index) => Object.assign(job, { runId: `run${index}`, status: 'SUCCEEDED' }))
  batch.jobs[0].distribution = { calibration, valuesUm: [0.1, 0.5], counts: [100, 1], sampleCount: 101 }
  batch.jobs[1].distribution = { calibration, valuesUm: [], counts: [], sampleCount: 0 }
  const report = imageThicknessReport(batch, { unit: 'nm', observed: false })
  assert.equal(report.groups.length, 1)
  assert.equal(report.groups[0].summary.count, 101)
  assert.equal(report.groups[0].summary.median, 100)
  assert.equal(report.progress.complete, 2)
  assert.equal(report.progress.empty, 1)
  assert.deepEqual(report.slices, [1, 3, 5])
  assert.deepEqual(report.measuredSlices, [1, 3])
  const observed = imageThicknessReport(batch, { unit: 'µm', observed: true, groupBy: 'slice' })
  assert.equal(observed.groups[0].label, 'Z1')
  assert.equal(observed.groups[0].summary.median, 0.2)
  assert.equal(imageThicknessReport(makeImageThicknessBatch(input, 'empty')), null)
})

test('PDF report pagination retains every group exactly once', () => {
  const groups = Array.from({ length: 19 }, (_, index) => ({ label: `Z${index + 1}` }))
  const pages = thicknessReportPages({ groups })
  assert.deepEqual(pages.map(page => page.length), [6, 6, 6, 1])
  assert.deepEqual(pages.flat(), groups)
})

test('PNG/JPEG composition preserves the image and appends complete reports without clipping', () => {
  const layout = combinedThicknessExportLayout({ width: 2000, height: 1000 }, [{ width: 1400, height: 700 }, { width: 1400, height: 1400 }])
  assert.deepEqual(layout, { width: 2000, height: 4048, items: [
    { y: 1024, width: 2000, height: 1000 }, { y: 2048, width: 2000, height: 2000 },
  ] })
  assert.throws(() => combinedThicknessExportLayout({ width: 12000, height: 12000 }, [{ width: 1400, height: 900 }]), /Choose PDF/)
})
