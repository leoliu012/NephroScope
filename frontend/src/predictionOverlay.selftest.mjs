import assert from 'node:assert/strict'

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const { REASON_INFO } = await import('./gbmRefinement.js')
const {
  createPieceTable, fillPieceTable, fillPlainTable, lineColor, overlayUniforms, pieceAtPixel, spanColor,
} = await import('./predictionOverlay.js')
const { PredictionFrameLoader, frameKey, nearestFirst } = await import('./predictionFrames.js')
const { frameBytes, scanPrediction, scanSkeleton } = await import('./predictionScan.js')

const hex = value => { const n = Number.parseInt(value.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
const names = { 0: 'kept', 1: 'oblique', 10: 'manual' }
const near = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 0.01, `${actual} vs ${expected}`))

// Scanning a label image: rows of runs, with every centerline point.
function image(rows) {
  const height = rows.length, width = rows[0].length
  const rgba = new Uint8ClampedArray(width * height * 4)
  rows.forEach((row, y) => row.forEach(([piece, code], x) => {
    const at = (y * width + x) * 4
    rgba[at] = piece & 255
    rgba[at + 1] = piece >> 8
    rgba[at + 2] = code
    rgba[at + 3] = 255
  }))
  return { rgba, width, height }
}
const _ = [0, 0]
const A = [1, 0], B = [300, 0], a = [1, 255], t = [1, 128]
{
  const { rgba, width, height } = image([
    [_, A, A, B, B, _],
    [_, a, t, B, _, _],
    [A, _, _, _, _, B],
  ])
  const frame = scanPrediction(rgba, width, height)
  assert.deepEqual([...frame.spans], [
    1, 0, 2, 1, 3, 0, 2, 300,
    1, 1, 2, 1, 3, 1, 1, 300,
    0, 2, 1, 1, 5, 2, 1, 300,
  ])
  assert.deepEqual([...frame.lines], [1, 1, 1, 255, 2, 1, 1, 128])
  assert.equal(frame.edges.length, 0)
  assert.equal(frameBytes(frame), frame.spans.byteLength + frame.lines.byteLength)

  // Finding the piece under the pointer, including between and past runs.
  assert.equal(pieceAtPixel(frame.spans, 1.5, 0.5), 1)
  assert.equal(pieceAtPixel(frame.spans, 4, 0), 300)
  assert.equal(pieceAtPixel(frame.spans, 0, 0), 0)
  assert.equal(pieceAtPixel(frame.spans, 5, 0), 0)
  assert.equal(pieceAtPixel(frame.spans, 3, 1), 300)
  assert.equal(pieceAtPixel(frame.spans, 2, 2), 0)
  assert.equal(pieceAtPixel(frame.spans, 5, 2), 300)
  assert.equal(pieceAtPixel(frame.spans, 0, 9), 0)
  assert.equal(pieceAtPixel(frame.spans, -1, 0), 0)
  assert.equal(pieceAtPixel(new Uint16Array(0), 0, 0), 0)
}
{
  // A run reaching the edge of the row, and growth past the starting capacity.
  const width = 3000, height = 3
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let x = 0; x < width; x += 2) { rgba[(x + width) * 4] = 1; rgba[(x + width) * 4 + 3] = 255 }
  const frame = scanPrediction(rgba, width, height)
  assert.equal(frame.spans.length / 4, 1500)
  const full = new Uint8ClampedArray(8)
  full[0] = full[4] = 7
  assert.deepEqual([...scanPrediction(full, 2, 1).spans], [0, 0, 2, 7])
}
{
  // A plain mask is one piece, whatever its grey level; contours keep only boundary pixels.
  const size = 5
  const rgba = new Uint8ClampedArray(size * size * 4)
  for (let y = 1; y < 4; y += 1) for (let x = 1; x < 4; x += 1) rgba[(y * size + x) * 4] = 255
  const frame = scanPrediction(rgba, size, size, { raw: true, contour: true })
  assert.deepEqual([...frame.spans], [1, 1, 3, 1, 1, 2, 3, 1, 1, 3, 3, 1])
  assert.deepEqual([...frame.edges], [1, 1, 3, 1, 1, 2, 1, 1, 3, 2, 1, 1, 1, 3, 3, 1])
  assert.deepEqual([...scanSkeleton(rgba, size, size).lines.slice(0, 4)], [1, 1, 1, 255])
}

// Table: piece 1 kept, piece 300 excluded in its reason's colour, no piece at 0.
const reasons = new Array(300).fill(1)
reasons[0] = 0
const table = fillPieceTable(createPieceTable(), reasons, names)
const entry = identity => [...table.slice(((identity >> 8) * 256 + (identity & 255)) * 4, ((identity >> 8) * 256 + (identity & 255)) * 4 + 4)]
assert.equal(entry(0)[3], 0)
assert.equal(entry(1)[3], 255)
assert.deepEqual(entry(300), [...hex(REASON_INFO.oblique.color), 128])
assert.equal(entry(301)[3], 0)
// Refilling replaces, so one slice's decisions never leak into the next.
fillPieceTable(table, [0], names)
assert.equal(entry(300)[3], 0)
fillPieceTable(table, new Array(70000).fill(0), names) // more pieces than the label can name
fillPieceTable(table, reasons, names)
const plain = fillPlainTable(createPieceTable())
assert.equal(plain[4 + 3], 255)
assert.equal(plain[3], 0)

const look = (changes = {}) => overlayUniforms({ maskColor: '#0000ff', skeletonColor: '#ffff00', opacity: 0.5, thickness: 2, ...changes })
const oblique = hex(REASON_INFO.oblique.color).map(value => value / 255)

// How a run of a piece is drawn.
near(spanColor(table, 1, look()), [0, 0, 0.5, 0.5])
{
  const alpha = look().excludedAlpha
  near(spanColor(table, 300, look()), [...oblique.map(value => value * alpha), alpha])
}
assert.equal(spanColor(table, 301, look()), null, 'a piece with no decision is not drawn')
assert.equal(spanColor(table, 300, look({ showExcluded: false })), null, 'export and the toggle hide what is excluded')
assert.equal(spanColor(table, 1, look({ showMask: false })), null)
// In contour mode kept GBM is drawn from its edge list, excluded GBM still filled.
assert.equal(spanColor(table, 1, look({ contour: true })), null)
assert.ok(spanColor(table, 1, look({ contour: true }), { edgesOnly: true }))
assert.ok(spanColor(table, 300, look({ contour: true })))
assert.equal(spanColor(table, 300, look({ contour: true }), { edgesOnly: true }), null)

// How a centerline point is drawn.
near(lineColor(table, 1, 255, look()), [1, 1, 0, 1])
near(lineColor(table, 1, 128, look()), [...hex(REASON_INFO.artifact.color).map(value => value / 255), 1])
near(lineColor(table, 1, 128, look({ showExcluded: false })), [1, 1, 0, 1])
near(lineColor(table, 300, 255, look()), [...oblique, 1])
assert.equal(lineColor(table, 300, 255, look({ showExcluded: false })), null)
assert.equal(lineColor(table, 1, 255, look({ showSkeleton: false })), null)
assert.equal(look({ thickness: 99 }).thickness, 12)

// Slices to prepare: nearest first, ahead of the motion before behind it.
assert.deepEqual(nearestFirst([0, 1, 2, 3, 4, 5, 6], 3, 1), [3, 4, 2, 5, 1, 6, 0])
assert.deepEqual(nearestFirst([0, 1, 2, 3, 4, 5, 6], 3, -1), [3, 2, 4, 1, 5, 0, 6])

// The loader shares requests, keeps what it made, and stays within its budget.
const made = bytes => ({ spans: new Uint16Array(bytes / 2), lines: new Uint16Array(0), edges: new Uint16Array(0) })
{
  const requested = []
  const finish = []
  const pool = { load: request => { requested.push(request.url); return new Promise(resolve => finish.push(() => resolve(made(10)))) } }
  const loader = new PredictionFrameLoader({ pool, maxBytes: 25, concurrency: 1 })
  const first = loader.want({ url: 'a' })
  const second = loader.want({ url: 'a' })
  assert.equal(first, second)
  assert.equal(loader.peek({ url: 'a' }), null)
  assert.deepEqual(requested, ['a'])
  loader.warm([{ url: 'b' }, { url: 'c' }, { url: 'd' }])
  loader.warm([{ url: 'd' }, { url: 'b' }])
  // Going to the front: what someone is waiting on goes before the background list.
  const urgent = loader.want({ url: 'z' })
  finish.shift()()
  await first
  assert.ok(loader.peek({ url: 'a' }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(requested[1], 'z')
  finish.shift()()
  await urgent
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(requested[2], 'd', 'a new position reorders what was still waiting')
  finish.shift()()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(loader.bytes, 20, 'the oldest goes when over budget')
  assert.equal(loader.peek({ url: 'a' }), null)
  // Contours are a separate frame from fills of the same image.
  assert.notEqual(frameKey({ url: 'a', contour: true }), frameKey({ url: 'a', contour: false }))
  loader.close()
}
{
  // A failed request is not kept, so it can be tried again.
  let attempts = 0
  const pool = { load: async () => { attempts += 1; if (attempts === 1) throw new Error('down'); return made(2) } }
  const loader = new PredictionFrameLoader({ pool, concurrency: 2 })
  await assert.rejects(loader.want({ url: 'x' }))
  assert.ok(await loader.want({ url: 'x' }))
  loader.close()
}
console.log('predictionOverlay selftest passed')
