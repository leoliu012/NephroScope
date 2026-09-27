import assert from 'node:assert/strict'
import test from 'node:test'
import {
  batchProgress, comparisonGroups, distributionSummary, imageApi, imageKey, is60X, isPost60X,
  loadAnalysisBatch, makeAnalysisBatch, monitorCaseAnalysis, retryAnalysisBatch,
  representativeSamples, saveAnalysisBatch, selectedZSlices, weightedQuantile,
} from './caseAnalysis.js'
import { defaultMeasurementSettings, loadMeasurementSettings, saveMeasurementSettings } from './measurementSettings.js'

const calibration = { pixelSizeXUm: 0.5, pixelSizeYUm: 0.5, expansionEnabled: true, expansionFactor: 2 }
const image = (caseId = 'case1', filename = '60X.tif', zCount = 1, gap = null) => ({
  key: imageKey(caseId, filename), caseId, filename, zCount, gap, channelIndex: 1, calibration,
})
const distribution = (valuesUm = [0.1, 0.2], counts = [3, 1]) => ({
  valuesUm, counts, sampleCount: counts.reduce((sum, value) => sum + value, 0), calibration,
})

test('all gaps choose valid ordered slices; short stacks use their middle', () => {
  assert.deepEqual(selectedZSlices(5, 0), [0, 1, 2, 3, 4])
  assert.deepEqual(selectedZSlices(6, 1), [0, 2, 4])
  assert.deepEqual(selectedZSlices(7, 2), [0, 3, 6])
  assert.deepEqual(selectedZSlices(4, 8), [2])
  assert.deepEqual(selectedZSlices(2, 1), [1])
  for (let count = 1; count <= 25; count++) {
    for (let gap = 0; gap <= 8; gap++) {
      const indices = selectedZSlices(count, gap)
      assert.ok(indices.every(z => Number.isInteger(z) && z >= 0 && z < count))
      assert.equal(new Set(indices).size, indices.length)
      if (gap && count <= gap + 1) assert.deepEqual(indices, [Math.floor(count / 2)])
      else assert.deepEqual(indices, Array.from({ length: count }, (_, z) => z).filter(z => z % (gap + 1) === 0))
    }
  }
})

test('batch respects per-image gap overrides and existing 60X grouping', () => {
  const batch = makeAnalysisBatch([image('case1', 'a_60x.tif', 6), image('case2', 'b_60x.nd2', 3, 8)], 1, 'batch')
  assert.deepEqual(batch.jobs.map(job => job.zIndex), [0, 2, 4, 1])
  assert.equal(is60X('ABC_POST_60X.nd2'), true)
  assert.equal(is60X('ABC_pre_10X.nd2'), false)
  assert.equal(is60X('unknown.tif'), false)
  assert.equal(imageApi('#3', 'a b+.tif'), '/agh/api/cases/%233/files/a%20b%2B.tif')
})

test('only the files browser Post 60X group is automatically selected', () => {
  const names = ['sample_POST_60X.nd2', 'sample_post_60x.tif', 'sample_pre_60X.tif',
    'sample_60X.tif', 'sample_post_10X.tif', 'sample_pre_post_60X.tif', 'unknown.tif']
  assert.deepEqual(names.filter(isPost60X), names.slice(0, 2))
  assert.deepEqual(['sample_pre_60X.tif', 'sample_60X.tif'].filter(isPost60X), [])
})

test('quantiles exactly match the full expanded sample population, including uneven counts', () => {
  const values = [1, 2, 9, 30], counts = [23, 2, 7, 1]
  const expanded = values.flatMap((value, i) => Array(counts[i]).fill(value))
  for (const q of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    const rank = q * (expanded.length - 1), fraction = rank % 1
    const expected = expanded[Math.floor(rank)] + fraction * (expanded[Math.ceil(rank)] - expanded[Math.floor(rank)])
    assert.equal(weightedQuantile(values, counts, q), expected)
  }
  assert.equal(weightedQuantile([], [], 0.5), null)
  assert.equal(distributionSummary([], []), null)
  assert.deepEqual(distributionSummary([4], [1]), {
    count: 1, q1: 4, median: 4, q3: 4, low: 4, high: 4, min: 4, max: 4, outliers: 0,
  })
  const withOutlier = distributionSummary([1, 2, 3, 100], [5, 5, 5, 1])
  assert.equal(withOutlier.high, 3)
  assert.equal(withOutlier.outliers, 1)
})

test('case comparisons pool actual points rather than giving images equal weight', () => {
  const batch = makeAnalysisBatch([image('case1', 'a'), image('case1', 'b'), image('case2', 'c')], 0, 'batch')
  batch.jobs.forEach((job, i) => Object.assign(job, { runId: String(i), status: 'SUCCEEDED',
    distribution: i === 0 ? distribution([0.1], [101]) : distribution([0.9], [1]),
  }))
  const groups = comparisonGroups(batch)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].summary.count, 102)
  assert.equal(groups[0].summary.median, 100)
  assert.equal(groups[0].imageCount, 2)
  assert.equal(comparisonGroups(batch, { groupBy: 'image' }).length, 3)
  assert.equal(comparisonGroups(batch, { groupBy: 'slice' }).length, 3)
  assert.equal(comparisonGroups(batch, { observed: true })[0].summary.median, 200)
  assert.equal(comparisonGroups(batch, { unit: 'µm' })[0].summary.median, 0.1)
  assert.equal(comparisonGroups(batch, { excluded: [batch.images[0].key] })[0].summary.count, 1)
  batch.jobs.push({ ...batch.jobs[0], id: 'duplicate' })
  assert.equal(comparisonGroups(batch)[0].summary.count, 102)
})

test('empty masks contribute no fabricated values to comparison groups', () => {
  const batch = makeAnalysisBatch([image()], 0, 'batch')
  Object.assign(batch.jobs[0], { runId: 'run', status: 'SUCCEEDED', distribution: distribution([], []) })
  assert.deepEqual(comparisonGroups(batch), [])
  assert.equal(batchProgress(batch.jobs).empty, 1)
  assert.equal(batchProgress(batch.jobs).complete, 1)
})

test('representative dots use actual samples and show every sample for small groups', () => {
  assert.deepEqual(representativeSamples([1, 2, 3], [3, 1, 1]), [1, 1, 1, 2, 3])
  assert.deepEqual(representativeSamples([], []), [])
  const dots = representativeSamples([1, 2], [990, 10])
  assert.equal(dots.length, 120)
  assert.ok(dots.every(value => value === 1 || value === 2))
  assert.ok(dots.filter(value => value === 1).length > 115)
})

test('orchestration joins saved segmentations and polls queued jobs before measuring', async () => {
  const initial = makeAnalysisBatch([image('case1', 'a', 2)], 0, 'batch')
  const calls = [], updates = []
  let polls = 0
  const request = async (url, options = {}) => {
    calls.push([url, options])
    if (url.endsWith('/analysis-runs')) {
      const body = JSON.parse(options.body)
      assert.equal(body.channelIndex, 1)
      return { runId: `run${body.zIndex}`, status: body.zIndex === 0 ? 'SUCCEEDED' : 'QUEUED', reused: body.zIndex === 0 }
    }
    if (url.endsWith('/gbm-distribution')) {
      assert.deepEqual(JSON.parse(options.body), { calibration })
      return distribution()
    }
    assert.equal(url, '/agh/api/analysis-runs/run1')
    polls++
    return polls === 1 ? { status: 'RUNNING', progress: { fraction: 0.5 } } : { status: 'SUCCEEDED' }
  }
  const done = await monitorCaseAnalysis(initial, { request, onChange: next => updates.push(next), pollMs: 0 })
  assert.equal(calls.filter(([url]) => url.endsWith('/analysis-runs')).length, 2)
  assert.equal(calls.filter(([url]) => url.endsWith('/gbm-distribution')).length, 2)
  assert.equal(polls, 2)
  assert.ok(updates.some(batch => batch.jobs[1].status === 'RUNNING'))
  assert.equal(batchProgress(done.jobs).complete, 2)
  assert.equal(batchProgress(done.jobs).reused, 1)
  assert.equal(batchProgress(done.jobs).percent, 100)
  assert.equal(initial.jobs[0].status, 'PENDING')
})

test('failed submissions, deleted runs and distribution failures can be retried', async () => {
  const initial = makeAnalysisBatch([image('case1', 'a', 3)], 0, 'batch')
  Object.assign(initial.jobs[1], { status: 'QUEUED', runId: 'deleted' })
  Object.assign(initial.jobs[2], { status: 'SUCCEEDED', runId: 'saved' })
  const done = await monitorCaseAnalysis(initial, { onChange() {}, request: async url => {
    if (url.endsWith('/analysis-runs')) throw new Error('Cannot submit')
    if (url.endsWith('/deleted')) throw Object.assign(new Error('Gone'), { status: 404 })
    throw new Error('Cannot load geometry')
  } })
  assert.equal(batchProgress(done.jobs).failed, 3)
  const retried = retryAnalysisBatch(done)
  assert.deepEqual(retried.jobs.map(job => job.status), ['PENDING', 'PENDING', 'SUCCEEDED'])
  assert.deepEqual(retried.jobs.map(job => job.runId), [null, null, 'saved'])
  assert.ok(retried.jobs.every(job => !job.distributionError))
})

test('abort stops additional submissions and auth errors stop monitoring', async () => {
  const initial = makeAnalysisBatch([image('case1', 'a', 20)], 0, 'batch')
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(monitorCaseAnalysis(initial, { signal: controller.signal, onChange() {}, request: async () => {
    calls++
    controller.abort()
    throw new DOMException('Aborted', 'AbortError')
  } }), { name: 'AbortError' })
  assert.equal(calls, 1)
  await assert.rejects(monitorCaseAnalysis(makeAnalysisBatch([image()], 0, 'batch'), {
    onChange() {}, request: async () => { throw Object.assign(new Error('Session expired'), { status: 401 }) },
  }), { status: 401 })
})

test('saved browser batch retains run IDs and calibration; reopens without resubmitting runs', async () => {
  const data = new Map()
  globalThis.localStorage = { setItem: (key, value) => data.set(key, value), getItem: key => data.get(key), removeItem: key => data.delete(key) }
  const batch = makeAnalysisBatch([image()], 0, 'batch')
  Object.assign(batch.jobs[0], { status: 'SUCCEEDED', runId: 'cached', distribution: distribution() })
  assert.equal(saveAnalysisBatch('alice', batch), true)
  assert.equal(loadAnalysisBatch('bob'), null)
  const restored = loadAnalysisBatch('alice')
  assert.equal(restored.jobs[0].distribution, null)
  assert.deepEqual(restored.images[0].calibration, calibration)
  const done = await monitorCaseAnalysis(restored, { onChange() {}, request: async url => {
    assert.equal(url, '/agh/api/analysis-runs/cached/measurements/gbm-distribution')
    return distribution()
  } })
  assert.equal(batchProgress(done.jobs).complete, 1)
  saveAnalysisBatch('alice', null)
  assert.equal(loadAnalysisBatch('alice'), null)
  delete globalThis.localStorage
})

test('analysis shares the viewer calibration defaults and saved per-image settings', () => {
  const meta = { pixelSizeXUm: 0.015, pixelSizeIsDefault: false }
  assert.equal(defaultMeasurementSettings(meta, '#4').expansionFactor, '7.23')
  assert.equal(defaultMeasurementSettings(meta, '#4').expansionEnabled, false)
  assert.equal(defaultMeasurementSettings({ ...meta, pixelSizeIsDefault: true }, '#1').expansionEnabled, true)
  const data = new Map()
  globalThis.localStorage = { setItem: (key, value) => data.set(key, value), getItem: key => data.get(key) }
  const settings = { pixelSizeUm: '0.25', expansionEnabled: true, expansionFactor: '7.1' }
  saveMeasurementSettings('#4', 'a.tif', settings)
  assert.deepEqual(loadMeasurementSettings('#4', 'a.tif', meta), settings)
  delete globalThis.localStorage
})
