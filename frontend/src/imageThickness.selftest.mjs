import assert from 'node:assert/strict'
import test from 'node:test'
import { jobFromRun } from './caseAnalysis.js'
import {
  combinedThicknessExportLayout, gapRunCounts, imageThicknessReport, imageThicknessScope, loadGapPreference,
  makeImageThicknessBatch, saveGapPreference, thicknessReportPages, viewerGapOptions,
} from './imageThickness.js'

const calibration = { pixelSizeXUm: 0.5, pixelSizeYUm: 0.5, expansionEnabled: true, expansionFactor: 2 }
const input = { caseId: 'case1', filename: 'image.tif', zCount: 6, gap: 1, channelIndex: 1, calibration }

test('viewer analysis uses the same slice selection and copies calibration', () => {
  const batch = makeImageThicknessBatch(input, 'image-analysis')
  assert.deepEqual(batch.jobs.map(job => job.zIndex), [0, 2, 4])
  assert.deepEqual(batch.images[0].calibration, calibration)
  assert.notEqual(batch.images[0].calibration, calibration)
  assert.deepEqual(makeImageThicknessBatch({ ...input, zCount: 2, gap: 8 }, 'short').jobs.map(job => job.zIndex), [1])
})

test('Z sampling choices collapse duplicates and count saved runs', () => {
  assert.deepEqual(viewerGapOptions(1).map(option => option.gap), [0])
  assert.deepEqual(viewerGapOptions(3).map(option => [option.gap, option.slices]), [[0, [0, 1, 2]], [1, [0, 2]], [2, [1]]])
  assert.equal(viewerGapOptions(40).length, 9)
  const runs = { 0: { status: 'SUCCEEDED' }, 2: { status: 'QUEUED' }, 4: { status: 'FAILED' } }
  assert.deepEqual(gapRunCounts([0, 2, 4], runs), { total: 3, ready: 1, active: 1, failed: 1, missing: 1 })
})

test('the remembered Z sampling is per image source', () => {
  const data = new Map()
  globalThis.localStorage = { getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, value) }
  const meta = { sourceId: 'path-a', sourceSize: 10, sourceMtimeNs: 123 }
  const scope = imageThicknessScope('case1', 'image.tif', meta)
  assert.equal(loadGapPreference(scope), null)
  saveGapPreference(scope, 3)
  assert.equal(loadGapPreference(scope), 3)
  for (const different of [
    imageThicknessScope('case2', 'image.tif', meta),
    imageThicknessScope('case1', 'another.tif', meta),
    imageThicknessScope('case1', 'image.tif', { ...meta, sourceMtimeNs: 124 }),
  ]) assert.equal(loadGapPreference(different), null)
  delete globalThis.localStorage
})

test('report and sidebar share exact point-weighted statistics and record partial/empty runs', () => {
  const batch = makeImageThicknessBatch(input, 'viewer')
  batch.jobs = batch.jobs.map((job, index) => jobFromRun(job, { runId: `run${index}`, status: 'SUCCEEDED' }, index === 0
    ? { runId: 'run0', distribution: { calibration, valuesUm: [0.1, 0.5], counts: [100, 1], sampleCount: 101 } }
    : index === 1 ? { runId: 'run1', distribution: { calibration, valuesUm: [], counts: [], sampleCount: 0 } } : null))
  const report = imageThicknessReport(batch, { unit: 'nm', observed: false })
  assert.equal(report.groups.length, 1)
  assert.equal(report.groups[0].summary.count, 101)
  assert.equal(report.groups[0].summary.median, 100)
  assert.ok(Math.abs(report.groups[0].summary.mean - (100 * 100 + 500) / 101) < 1e-9)
  assert.equal(report.groups[0].title, 'All analyzed Z slices')
  assert.equal(report.gapLabel, 'Every 2nd Z slice')
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
