import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analysisRequest, analysisToBatch, batchProgress, caseAnalysisJson, comparisonGroups, distributionSummary,
  fetchDistributions, gapCoverage, gapLabel, imageApi, imageKey, is60X, isPost60X, makeAnalysisBatch,
  monitorSavedAnalysis, selectedZSlices, selectionSignature, weightedQuantile,
} from './caseAnalysis.js'
import { distributionCacheKey } from './distributionCache.js'
import { densityCurve, formatThickness, niceScale } from './thicknessStats.js'
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
    count: 1, mean: 4, sd: 0, q1: 4, median: 4, q3: 4, low: 4, high: 4, min: 4, max: 4, outliers: 0,
  })
  const weighted = distributionSummary([1, 3], [3, 1])
  assert.equal(weighted.mean, 1.5)
  assert.ok(Math.abs(weighted.sd - 1) < 1e-12)
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

test('axis ticks fall on whole 1, 2 or 5 steps with a finer minor grid', () => {
  const nm = niceScale(306.346, 1531.732, 7)
  assert.equal(nm.step, 200)
  assert.deepEqual(nm.ticks, [200, 400, 600, 800, 1000, 1200, 1400, 1600])
  assert.equal(nm.minorStep, 50)
  assert.ok(nm.minorTicks.includes(250) && !nm.minorTicks.includes(400))
  const compact = niceScale(212, 388, 4)
  assert.equal(compact.step, 50)
  assert.deepEqual(compact.ticks, [200, 250, 300, 350, 400])
  assert.equal(compact.minorStep, 10)
  const um = niceScale(0.212, 0.388, 4)
  assert.equal(um.step, 0.05)
  assert.equal(um.decimals, 2)
  assert.deepEqual(um.ticks, [0.2, 0.25, 0.3, 0.35, 0.4])
  for (const [low, high] of [[0, 1], [37, 41], [123, 9876], [0.0012, 0.0019]]) {
    const scale = niceScale(low, high, 7)
    const units = scale.step / 10 ** Math.floor(Math.log10(scale.step) + 1e-9)
    assert.ok([1, 2, 5].some(value => Math.abs(units - value) < 1e-9), `${scale.step} is a 1/2/5 step`)
    assert.ok(scale.min <= low && scale.max >= high)
  }
  assert.ok(niceScale(5, 5).ticks.length > 1)
  assert.equal(formatThickness(312.44, 'nm'), '312 nm')
  assert.equal(formatThickness(0.31244, 'µm'), '0.312 µm')
})

test('density curve is normalized and covers the axis', () => {
  const curve = densityCurve([100, 110, 300], [50, 50, 1], { min: 0, max: 400 }, 41)
  assert.equal(curve.length, 41)
  assert.equal(Math.max(...curve.map(([, density]) => density)), 1)
  const peak = curve.reduce((best, point) => point[1] > best[1] ? point : best)
  assert.ok(peak[0] >= 90 && peak[0] <= 120)
  assert.deepEqual(densityCurve([], [], { min: 0, max: 1 }), [])
})

test('Z sampling labels, coverage and saved-analysis requests', () => {
  assert.equal(gapLabel(0), 'Every Z slice')
  assert.equal(gapLabel(1), 'Every 2nd Z slice')
  assert.equal(gapLabel(2), 'Every 3rd Z slice')
  assert.equal(gapLabel(3), 'Every 4th Z slice')
  const entry = { runs: { 0: { status: 'SUCCEEDED' }, 2: { status: 'RUNNING' }, 4: { status: 'FAILED' } } }
  assert.deepEqual(gapCoverage(entry, 6, 1), { total: 3, ready: 1, active: 1, missing: 1 })
  assert.deepEqual(gapCoverage(entry, 6, 8), { total: 1, ready: 0, active: 0, missing: 1 })
  const images = [image('case1', 'a', 6), image('case2', 'b', 3, 8)]
  const body = analysisRequest(images, 1)
  assert.deepEqual(body.jobs.map(job => [job.caseId, job.zIndex]), [['case1', 0], ['case1', 2], ['case1', 4], ['case2', 1]])
  assert.equal(body.images[1].gap, 8)
  assert.equal(body.start, true)
  assert.equal(selectionSignature(images, 1), selectionSignature([...images].reverse(), 1))
  assert.notEqual(selectionSignature(images, 1), selectionSignature(images, 2))
  assert.notEqual(selectionSignature(images, 1), selectionSignature([{ ...images[0], channelIndex: 0 }, images[1]], 1))
})

const savedAnalysis = (statuses) => ({
  id: 'analysis-1', createdAt: '2026-01-01T00:00:00Z', gap: 0, status: 'running',
  images: [{ ...image('case1', 'a', statuses.length), key: imageKey('case1', 'a') }],
  jobs: statuses.map((status, z) => ({
    id: `${imageKey('case1', 'a')}:${z}`, imageKey: imageKey('case1', 'a'), caseId: 'case1', filename: 'a', zIndex: z,
    run: status ? { runId: `run${z}`, status } : null,
  })),
})

test('saved analyses map onto the comparison view model', () => {
  const analysis = savedAnalysis(['SUCCEEDED', 'QUEUED', 'CANCELED', null])
  const batch = analysisToBatch(analysis, new Map([[analysis.jobs[0].id, { runId: 'run0', distribution: distribution() }]]))
  assert.deepEqual(batch.jobs.map(job => job.status), ['SUCCEEDED', 'QUEUED', 'CANCELED', 'MISSING'])
  const progress = batchProgress(batch.jobs)
  assert.deepEqual([progress.complete, progress.queued, progress.canceled, progress.missing], [1, 1, 1, 1])
  assert.equal(comparisonGroups(batch)[0].summary.count, 4)
  // A measurement of an older run is not shown for a newer run of the same slice.
  const stale = analysisToBatch(analysis, new Map([[analysis.jobs[0].id, { runId: 'old', distribution: distribution() }]]))
  assert.equal(stale.jobs[0].distribution, null)
})

test('monitoring polls one analysis request and measures finished slices once', async () => {
  const first = savedAnalysis(['SUCCEEDED', 'RUNNING'])
  const second = savedAnalysis(['SUCCEEDED', 'SUCCEEDED'])
  const calls = []
  const measured = []
  const request = async url => { calls.push(url); return second }
  const measure = async (items, { onResult }) => {
    measured.push(...items.map(item => item.runId))
    items.forEach(item => onResult(item.key, { runId: item.runId, cacheKey: distributionCacheKey(item.runId, item.calibration), distribution: distribution() }))
  }
  const updates = []
  const done = await monitorSavedAnalysis(first, { request, measure, pollMs: 0, onChange: next => updates.push(next) })
  assert.deepEqual(calls, ['/agh/api/case-analyses/analysis-1'])
  assert.deepEqual(measured, ['run0', 'run1'])
  assert.equal(done.distributions.size, 2)
  assert.ok(updates.length >= 2)
})

test('distribution requests are batched and cached results need no request', async () => {
  const items = [{ key: 'a', runId: 'r1', calibration }, { key: 'b', runId: 'r2', calibration }]
  let requests = 0
  const request = async (url, options) => {
    requests++
    assert.equal(url, '/agh/api/analysis-runs/distributions')
    const body = JSON.parse(options.body)
    return { results: body.items.map(item => item.runId === 'r2'
      ? { runId: item.runId, status: 409, error: 'not finished' }
      : { runId: item.runId, distribution: distribution() }) }
  }
  const first = new Map()
  await fetchDistributions(items, { request, onResult: (key, result) => first.set(key, result) })
  assert.equal(requests, 1)
  assert.equal(first.get('a').distribution.sampleCount, 4)
  assert.equal(first.get('b').error, 'not finished')
  const second = new Map()
  await fetchDistributions(items, { request, onResult: (key, result) => second.set(key, result) })
  assert.equal(requests, 2, 'only the unfinished run is requested again')
  assert.ok(second.get('a').distribution)
})

test('requests dropped by a proxy are retried', async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) return new Response('', { status: 502 })
    if (calls === 2) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    assert.deepEqual(await caseAnalysisJson('/agh/api/case-analyses'), { ok: true })
    assert.equal(calls, 3)
    calls = 10
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Nope' }), { status: 400 })
    await assert.rejects(caseAnalysisJson('/agh/api/case-analyses'), { status: 400 })
  } finally {
    globalThis.fetch = realFetch
  }
})
