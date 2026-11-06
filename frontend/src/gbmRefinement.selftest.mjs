import assert from 'node:assert/strict'

const store = new Map()
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, value),
  removeItem: key => store.delete(key),
}

const {
  DEFAULT_FILTER_SETTINGS, REASON_INFO, decodeLabel, excludedColorTable, filterIsActive, filterIsWaiting, filterKey, filterLabel,
  filterPayload, filterTotals, isTemporaryFailure, keptPieceTable, loadFilterSettings, loadZStepOverride, normalizeFilterSettings,
  pieceInfoAt, recalculationMessage, refinedLayers, reportFilterLine, saveFilterSettings, saveZStepOverride, workerHasStopped,
} = await import('./gbmRefinement.js')
const { distributionNeeded, fetchDistributions, monitorSavedAnalysis } = await import('./caseAnalysis.js')
const { distributionCacheKey } = await import('./distributionCache.js')
const { nearbyZSlices } = await import('./imageThickness.js')

// Settings
assert.deepEqual(normalizeFilterSettings(null), { ...DEFAULT_FILTER_SETTINGS })
assert.equal(normalizeFilterSettings({}).minNm, 30)
assert.equal(normalizeFilterSettings({}).maxNm, 3400)
assert.equal(normalizeFilterSettings({ crossSection: false }).crossSection, false)
assert.equal(normalizeFilterSettings({ maxTiltDeg: 500 }).maxTiltDeg, 89)
// Crossed limits fall back to the defaults instead of excluding everything.
const crossed = normalizeFilterSettings({ minNm: 900, maxNm: 100 })
assert.deepEqual([crossed.minNm, crossed.maxNm], [30, 3400])
saveFilterSettings({ ...DEFAULT_FILTER_SETTINGS, thicknessLimits: false })
assert.equal(loadFilterSettings().thicknessLimits, false)
store.clear()

saveZStepOverride('case', 'a.tif', 0.25)
assert.equal(loadZStepOverride('case', 'a.tif'), 0.25)
assert.equal(loadZStepOverride('case', 'b.tif'), null)
saveZStepOverride('case', 'a.tif', null)
assert.equal(loadZStepOverride('case', 'a.tif'), null)

// Requests carry only what was chosen, so "auto" stays the server's decision.
const auto = filterPayload(DEFAULT_FILTER_SETTINGS)
assert.equal('maxTiltDeg' in auto, false)
assert.equal('zStepUm' in auto, false)
assert.equal(auto.window, 30)
assert.equal(filterPayload({ ...DEFAULT_FILTER_SETTINGS, tiltAuto: false, maxTiltDeg: 22 }).maxTiltDeg, 22)
assert.equal(filterPayload({ ...DEFAULT_FILTER_SETTINGS, windowAuto: false, window: 12 }).window, 12)
assert.equal(filterPayload(DEFAULT_FILTER_SETTINGS, 0.4).zStepUm, 0.4)
assert.notEqual(filterKey(auto), filterKey(filterPayload(DEFAULT_FILTER_SETTINGS, 0.4)))
assert.equal(filterIsActive(DEFAULT_FILTER_SETTINGS), true)
assert.equal(filterIsActive({ ...DEFAULT_FILTER_SETTINGS, crossSection: false, thicknessLimits: false }), false)
assert.match(filterLabel(DEFAULT_FILTER_SETTINGS), /Cross-sections only.*30–3400 nm/)
assert.equal(filterLabel({ ...DEFAULT_FILTER_SETTINGS, crossSection: false, thicknessLimits: false }), 'All model predictions')

// Label raster: 2 x 2, pieces 1 and 300, skeleton artifact stays hidden.
const rgba = new Uint8ClampedArray([
  1, 0, 255, 255, /* piece 1, measured centerline */
  44, 1, 0, 255, /* piece 300 */
  1, 0, 128, 255, /* piece 1, artifact centerline */
  0, 0, 0, 255, /* background */
])
const label = decodeLabel(rgba, 2, 2)
assert.deepEqual([...label.pieces], [1, 300, 1, 0])
const reasons = new Array(300).fill(1)
reasons[0] = 0
const names = { 0: 'kept', 1: 'oblique' }
const table = keptPieceTable(reasons, names)
assert.equal(table[1], 1)
assert.equal(table[300], 0)
const colors = excludedColorTable(reasons, names)
const alpha = refinedLayers(label, table, colors)
assert.deepEqual([...alpha.kept.alpha], [255, 0, 255, 0])
assert.deepEqual([...alpha.skeleton.alpha], [255, 0, 0, 0])
assert.deepEqual([...alpha.wholeSkeleton.alpha], [255, 0, 255, 0], 'a kept centerline stays unbroken across tapers and junctions')
// Excluded GBM is filled in the colour of its reason; kept GBM is not in that layer.
const red = [0xef, 0x44, 0x44, 255]
assert.deepEqual([...alpha.excluded.fill.slice(0, 4)], [0, 0, 0, 0])
assert.deepEqual([...alpha.excluded.fill.slice(4, 8)], red)
assert.deepEqual([...alpha.excluded.fill.slice(12, 16)], [0, 0, 0, 0])
// A kept piece's artifact centerline is shown as such, since it is not measured.
const gray = Number.parseInt(REASON_INFO.artifact.color.slice(1), 16)
assert.deepEqual([...alpha.excluded.lines.slice(8, 12)], [(gray >> 16) & 255, (gray >> 8) & 255, gray & 255, 255])
assert.deepEqual([...alpha.excluded.lines.slice(0, 4)], [0, 0, 0, 0], 'measured centerline stays in the skeleton layer')
// Every reason has its own colour, or the legend would not identify it.
const reasonColors = Object.values(REASON_INFO).map(info => info.color)
assert.equal(new Set(reasonColors).size, reasonColors.length)

const view = { pieces: { reason: reasons, reasonNames: names, tiltDeg: new Array(300).fill(41), widthNm: new Array(300).fill(1500) } }
assert.deepEqual(pieceInfoAt(label, view, 1.2, 0.5), { piece: 299, reason: 'oblique', tiltDeg: 41, widthNm: 1500 })
assert.equal(pieceInfoAt(label, view, 1.5, 1.5), null)
assert.equal(pieceInfoAt(label, view, -1, 0), null)
assert.equal(pieceInfoAt(label, view, 5, 0), null)
assert.equal(pieceInfoAt(null, view, 0, 0), null)

// What the recalculating popup says, and that it says nothing when nothing is running.
assert.equal(recalculationMessage({}), '')
assert.equal(recalculationMessage({ stack: { state: 'ready' } }), '')
assert.match(recalculationMessage({ fetching: true }), /Recalculating/)
assert.match(recalculationMessage({ remeasuring: true }), /thickness/)
assert.match(recalculationMessage({ stack: { state: 'running', job: { progress: { percent: 42 } } } }), /42%/)
assert.match(recalculationMessage({ stack: { state: 'waiting' }, fetching: true }), /segmentation finishes/)
// A gone worker is reported as such, not as progress stuck at its last percent.
const silent = { state: 'running', job: { heartbeatAgeSeconds: 500, progress: { percent: 87 } } }
assert.equal(workerHasStopped(silent), true)
assert.equal(workerHasStopped({ state: 'running', job: { heartbeatAgeSeconds: 20 } }), false)
assert.equal(workerHasStopped({ state: 'running', job: {} }), false)
assert.equal(workerHasStopped({ state: 'ready', job: { heartbeatAgeSeconds: 500 } }), false)
assert.doesNotMatch(recalculationMessage({ stack: silent }), /87/)
assert.match(recalculationMessage({ stack: silent }), /worker/)
// Dropped requests are tried again; refusals and cancellations are not.
assert.equal(isTemporaryFailure(new TypeError('Failed to fetch')), true)
assert.equal(isTemporaryFailure(Object.assign(new Error('bad gateway'), { status: 502 })), true)
assert.equal(isTemporaryFailure(Object.assign(new Error('refused'), { status: 409 })), false)
assert.equal(isTemporaryFailure(Object.assign(new Error('server bug'), { status: 500 })), false)
assert.equal(isTemporaryFailure(Object.assign(new Error('stop'), { name: 'AbortError' })), false)
assert.equal(normalizeFilterSettings({ brushRadius: 5000 }).brushRadius, 200)
assert.equal(filterKey(filterPayload({ ...DEFAULT_FILTER_SETTINGS, brushRadius: 40 })), filterKey(auto), 'brush size is not a filter change')

// A failed analysis must not look as if it were still coming, and report text says so.
assert.equal(filterIsWaiting({ pending: true, state: 'running' }), true)
assert.equal(filterIsWaiting({ pending: true, state: 'failed' }), false)
assert.equal(filterIsWaiting({ pending: false, state: 'ready' }), false)
const totals = filterTotals([
  { filter: { keptSamples: 10, totalSamples: 40, applied: true, pending: false, crossSection: true, hasNeighbours: true, byReason: { kept: 10, oblique: 30 } } },
  { filter: { keptSamples: 5, totalSamples: 5, applied: false, pending: true, state: 'queued', crossSection: true } },
  { filter: { keptSamples: 7, totalSamples: 7, applied: false, pending: true, state: 'failed', crossSection: true } },
  { filter: { keptSamples: 2, totalSamples: 2, applied: true, pending: false, crossSection: true, hasNeighbours: false } },
  { valuesUm: [] },
])
assert.equal(totals.kept, 24)
assert.equal(totals.total, 54)
assert.equal(totals.pending, 1)
assert.equal(totals.failed, 1)
assert.equal(totals.singlePlane, 1)
assert.equal(totals.byReason.oblique, 30)
assert.equal(filterTotals([{ filter: { applied: true, crossSection: true, hasNeighbours: true, zStep: { um: null } } }]).noZStep, 1)
assert.equal(filterTotals([{ filter: { applied: true, crossSection: true, hasNeighbours: true, zStep: { um: 0.4 } } }]).noZStep, 0)
const line = reportFilterLine(DEFAULT_FILTER_SETTINGS, [{ filter: { keptSamples: 3, totalSamples: 9, pending: true, state: 'running' } }])
assert.match(line, /3 of 9 centerline points kept/)
assert.match(line, /PENDING FOR 1 Z/)

// When a measurement has to be requested again
const key = 'run|cal|filter'
assert.equal(distributionNeeded(null, key), true)
assert.equal(distributionNeeded({ cacheKey: 'other' }, key), true)
assert.equal(distributionNeeded({ cacheKey: key, retryable: true }, key), true)
assert.equal(distributionNeeded({ cacheKey: key, token: 'a' }, key, 'a'), false)
assert.equal(distributionNeeded({ cacheKey: key, token: 'a' }, key, 'b'), true, 'a correction changes the token')
assert.equal(distributionNeeded({ cacheKey: key, token: null, waiting: true }, key, null, 'running'), false, 'not measured again while waiting')
assert.equal(distributionNeeded({ cacheKey: key, token: null, waiting: true }, key, 'ready-token', 'ready'), true)
assert.equal(distributionNeeded({ cacheKey: key, token: null, waiting: true }, key, null, 'failed'), true)
assert.equal(distributionNeeded({ cacheKey: key, token: null, waiting: false }, key, null, 'failed'), false)

// Filtered and raw measurements of a run never share a cache entry.
const calibration = { pixelSizeXUm: 0.1 }
assert.notEqual(distributionCacheKey('r', calibration), distributionCacheKey('r', calibration, auto))
assert.equal(distributionCacheKey('r', calibration), 'r|' + JSON.stringify(calibration))

// Requests: pending results are never cached; ready ones are, under their token.
function serverWith(handler) {
  const log = []
  const request = async (url, options) => {
    const body = JSON.parse(options.body)
    log.push({ url, body })
    return handler(url, body)
  }
  return { request, log }
}
const distribution = (token, pending = false) => ({
  analysisRunId: 'x', valuesUm: [1], counts: [1], sampleCount: 1,
  filter: { token, pending, applied: !pending, state: pending ? 'queued' : 'ready', keptSamples: 1, totalSamples: 2 },
})
{
  const { request, log } = serverWith((url, body) => {
    if (url.endsWith('refinement-tokens')) return { tokens: { r1: null }, states: { r1: 'queued' } }
    return { results: body.items.map(() => ({ distribution: distribution(null, true) })) }
  })
  const seen = []
  await fetchDistributions([{ key: 'k', runId: 'r1', calibration, filter: auto }], { request, onResult: (_, result) => seen.push(result) })
  assert.equal(seen[0].waiting, true)
  assert.equal(seen[0].token, null)
  assert.equal(log.at(-1).body.items[0].filter.crossSection, true)
  await fetchDistributions([{ key: 'k', runId: 'r1', calibration, filter: auto }], { request, onResult: (_, result) => seen.push(result) })
  assert.equal(log.filter(entry => entry.url.endsWith('distributions')).length, 2, 'pending results are not cached')
}
{
  const { request, log } = serverWith((url, body) => {
    if (url.endsWith('refinement-tokens')) return { tokens: { r2: 'stack:0' }, states: { r2: 'ready' } }
    return { results: body.items.map(() => ({ distribution: distribution('stack:0') })) }
  })
  const seen = []
  await fetchDistributions([{ key: 'k', runId: 'r2', calibration, filter: auto }], { request, onResult: (_, result) => seen.push(result) })
  await fetchDistributions([{ key: 'k', runId: 'r2', calibration, filter: auto }], { request, onResult: (_, result) => seen.push(result) })
  assert.equal(log.filter(entry => entry.url.endsWith('distributions')).length, 1, 'ready results come from the cache')
  assert.equal(seen[1].token, 'stack:0')
  assert.equal(seen[1].distribution.filter.keptSamples, 1)
}

// A saved analysis keeps waiting for the Z analysis, then measures with its token.
{
  const analysis = {
    id: 'a', images: [{ key: 'i', caseId: 'c', filename: 'f', calibration }],
    jobs: [{ id: 'j', imageKey: 'i', zIndex: 0, run: { runId: 'r3', status: 'SUCCEEDED' } }],
  }
  let polls = 0
  const { request } = serverWith((url, body) => {
    if (url.endsWith('refinement-tokens')) {
      polls += 1
      return polls === 1 ? { tokens: { r3: null }, states: { r3: 'queued' } } : { tokens: { r3: 'stack:0' }, states: { r3: 'ready' } }
    }
    const ready = polls > 1
    return { results: body.items.map(() => ({ distribution: distribution(ready ? 'stack:0' : null, !ready) })) }
  })
  const updates = []
  const { distributions } = await monitorSavedAnalysis(analysis, {
    request, pollMs: 1, tokenPollMs: 0, filterFor: () => auto, onChange: next => updates.push(next),
  })
  assert.equal(distributions.get('j').waiting, false)
  assert.equal(distributions.get('j').token, 'stack:0')
  assert.equal(polls, 2)
}
// Changing the filter drops values measured under the previous one before anything shows them.
{
  const analysis = {
    id: 'b', images: [{ key: 'i', caseId: 'c', filename: 'f', calibration }],
    jobs: [{ id: 'j', imageKey: 'i', zIndex: 0, run: { runId: 'r4', status: 'SUCCEEDED' } }],
  }
  const { request } = serverWith((url, body) => (url.endsWith('refinement-tokens')
    ? { tokens: { r4: 'stack:1' }, states: { r4: 'ready' } }
    : { results: body.items.map(() => ({ distribution: distribution('stack:1') })) }))
  const seen = []
  const previous = new Map([['j', { runId: 'r4', cacheKey: 'stale', token: 'stack:1', distribution: { sampleCount: 99 } }]])
  await monitorSavedAnalysis(analysis, {
    request, pollMs: 1, tokenPollMs: 0, filterFor: () => auto, distributions: previous,
    onChange: next => seen.push(next.distributions.get('j')?.distribution?.sampleCount),
    measure: async (items, { onResult }) => { await fetchDistributions(items, { request, onResult }) },
  })
  assert.equal(seen.includes(99), false)
}

assert.deepEqual(nearbyZSlices(100, 50, 4, 2), [46, 48, 50, 52, 54])
assert.deepEqual(nearbyZSlices(5, 0, 4, 2), [0, 2, 4])
console.log('gbmRefinement selftest passed')
