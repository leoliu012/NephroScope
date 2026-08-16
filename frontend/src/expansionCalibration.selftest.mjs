// Standalone smoke test for the pure EF math. No test runner required:
//
//   node frontend/src/expansionCalibration.selftest.mjs
//
// Exits non-zero on the first failed assertion. Kept dependency-free so it can
// run in CI or by hand without adding a frontend test framework.

import {
  euclideanLength,
  lineAngleDeg,
  acuteAngleDifferenceDeg,
  percentile,
  median,
  computeLinePairRow,
  summarizeLinePairs,
  consistencyForEf,
  heatColor,
  formatEf,
} from './expansionCalibration.js'

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}`)
  }
}
function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps
}

console.log('geometry')
check('euclideanLength 3-4-5', approx(euclideanLength([0, 0], [3, 4]), 5))
check('lineAngleDeg horizontal', approx(lineAngleDeg([0, 0], [1, 0]), 0))
check('lineAngleDeg vertical', approx(lineAngleDeg([0, 0], [0, 1]), 90))
check('acuteAngle 0 vs 90 = 90', approx(acuteAngleDifferenceDeg(0, 90), 90))
check('acuteAngle 10 vs 350 = 20', approx(acuteAngleDifferenceDeg(10, 350), 20))
check('acuteAngle 170 vs 10 = 20', approx(acuteAngleDifferenceDeg(170, 10), 20))

console.log('percentiles (numpy linear interpolation)')
const s = [1, 2, 3, 4, 5]
check('median [1..5] = 3', approx(percentile(s, 50), 3))
check('q1 [1..5] = 2', approx(percentile(s, 25), 2))
check('q3 [1..5] = 4', approx(percentile(s, 75), 4))
check('median helper matches', approx(median([5, 3, 1, 4, 2]), 3))
check('median even [1,2,3,4] = 2.5', approx(median([1, 2, 3, 4]), 2.5))

console.log('EF row computation')
const row = computeLinePairRow({
  a: { p0: [0, 0], p1: [700, 0] },
  b: { p0: [0, 0], p1: [100, 0] },
  pxA: 0.1,
  pxB: 0.1,
})
check('lenApx 700', approx(row.lenApx, 700))
check('lenAum 70', approx(row.lenAum, 70))
check('lenBum 10', approx(row.lenBum, 10))
check('EF = 7.0', approx(row.ef, 7))
check('scaleBtoApx = 7', approx(row.scaleBtoApx, 7))
check('EF 7 flagged outside 5.5-8.8? no', row.qualityNote === 'OK')

const shortRow = computeLinePairRow({
  a: { p0: [0, 0], p1: [10, 0] },
  b: { p0: [0, 0], p1: [5, 0] },
  pxA: 0.1,
  pxB: 0.1,
})
check('short line flagged', /short/.test(shortRow.qualityNote))
check('EF 2.0 flagged out of range', /outside expected/.test(shortRow.qualityNote))

console.log('robust summary')
const summ = summarizeLinePairs([7.0, 7.1, 6.9, 7.2, 6.8])
check('n pairs = 5', summ.nPairs === 5)
check('median ~ 7.0', approx(summ.efMedian, 7.0, 1e-9))
check('min 6.8', approx(summ.efMin, 6.8, 1e-9))
check('max 7.2', approx(summ.efMax, 7.2, 1e-9))
check('iqr = q3-q1 = 0.2', approx(summ.efIqr, 0.2, 1e-9))
check('mad robust >= 0', summ.efMadRobust >= 0)
check('cv percent finite', Number.isFinite(summ.cvPercent))
check('bootstrap CI present (n>=3)', Number.isFinite(summ.medianCi95Low) && Number.isFinite(summ.medianCi95High))
check('CI brackets median', summ.medianCi95Low <= summ.efMedian && summ.efMedian <= summ.medianCi95High)

const summBoot1 = summarizeLinePairs([6.0, 7.0, 8.0], { seed: 42 })
const summBoot2 = summarizeLinePairs([6.0, 7.0, 8.0], { seed: 42 })
check('bootstrap deterministic for fixed seed', summBoot1.medianCi95Low === summBoot2.medianCi95Low)

check('empty summary is null', summarizeLinePairs([]) === null)
check('single-pair summary has NaN std/CI', (() => {
  const one = summarizeLinePairs([7.0])
  return one.nPairs === 1 && Number.isNaN(one.efStd) && Number.isNaN(one.medianCi95Low)
})())

console.log('consistency heat mapping')
const c0 = consistencyForEf(7.0, 7.0)
check('EF == median -> score 0 (green)', approx(c0.score, 0))
const cEdge = consistencyForEf(7.0 * 1.15, 7.0)
check('15% deviation -> score 1 (red)', approx(cEdge.score, 1))
const cHalf = consistencyForEf(7.0 * 1.075, 7.0)
check('7.5% deviation -> score ~0.5', approx(cHalf.score, 0.5, 1e-9))
check('heatColor(0) is greenish', /hsl\(140/.test(heatColor(0)))
check('heatColor(1) is red', /hsl\(0/.test(heatColor(1)))
check('formatEf rounds', formatEf(7.123456) === '7.123')

if (failures) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll expansionCalibration self-tests passed.')
