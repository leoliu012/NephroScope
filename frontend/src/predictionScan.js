// Turns a prediction image into a compact list of what to draw.
//
// GBM covers a few percent of an image, so runs of equal pixels per row are about thirty
// times smaller than the image, need no decoding to show, and fit a whole stack on the GPU.
const FIELDS = 4

class Uint16List {
  constructor(capacity = 4096) {
    this.values = new Uint16Array(capacity * FIELDS)
    this.length = 0
  }

  push(a, b, c, d) {
    if (this.length + FIELDS > this.values.length) {
      const grown = new Uint16Array(this.values.length * 2)
      grown.set(this.values)
      this.values = grown
    }
    const { values, length } = this
    values[length] = a
    values[length + 1] = b
    values[length + 2] = c
    values[length + 3] = d
    this.length = length + FIELDS
  }

  result() {
    return this.values.slice(0, this.length)
  }
}

// Spans: [x, y, length, piece]. Lines: [x, y, piece, code]. Edges: spans of boundary pixels.
// A label image has the piece number in red + 256 green and a centerline code in blue.
// A plain mask has one piece, number 1.
export function scanPrediction(rgba, width, height, { raw = false, contour = false } = {}) {
  const spans = new Uint16List()
  const lines = new Uint16List()
  let source = 0
  for (let y = 0; y < height; y += 1) {
    let runStart = 0
    let runPiece = 0
    for (let x = 0; x < width; x += 1, source += 4) {
      const piece = raw ? (rgba[source] > 0 ? 1 : 0) : rgba[source] + 256 * rgba[source + 1]
      if (piece !== runPiece) {
        if (runPiece) spans.push(runStart, y, x - runStart, runPiece)
        runStart = x
        runPiece = piece
      }
      if (!raw && rgba[source + 2]) lines.push(x, y, piece, rgba[source + 2])
    }
    if (runPiece) spans.push(runStart, y, width - runStart, runPiece)
  }
  const frame = { spans: spans.result(), lines: lines.result(), edges: new Uint16Array(0) }
  if (contour) frame.edges = edgeSpans(rgba, width, height, raw)
  return frame
}

function edgeSpans(rgba, width, height, raw) {
  const pieceAt = index => (raw ? (rgba[index * 4] > 0 ? 1 : 0) : rgba[index * 4] + 256 * rgba[index * 4 + 1])
  const edges = new Uint16List()
  for (let y = 0; y < height; y += 1) {
    let runStart = 0
    let runPiece = 0
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const piece = pieceAt(index)
      let edge = 0
      if (piece) {
        const onBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1
        if (
          onBorder
          || !pieceAt(index - width - 1) || !pieceAt(index - width) || !pieceAt(index - width + 1)
          || !pieceAt(index - 1) || !pieceAt(index + 1)
          || !pieceAt(index + width - 1) || !pieceAt(index + width) || !pieceAt(index + width + 1)
        ) edge = piece
      }
      if (edge !== runPiece) {
        if (runPiece) edges.push(runStart, y, x - runStart, runPiece)
        runStart = x
        runPiece = edge
      }
    }
    if (runPiece) edges.push(runStart, y, width - runStart, runPiece)
  }
  return edges.result()
}

// Every set pixel of a skeleton image, as lines of piece 1.
export function scanSkeleton(rgba, width, height) {
  const lines = new Uint16List()
  let source = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1, source += 4) {
      if (rgba[source]) lines.push(x, y, 1, 255)
    }
  }
  return { spans: new Uint16Array(0), lines: lines.result(), edges: new Uint16Array(0) }
}

// Which piece a pixel belongs to. Spans are in row order, so this is a binary search.
export function pieceAtPixel(spans, x, y) {
  let low = 0
  let high = Math.floor(spans.length / FIELDS) - 1
  const column = Math.floor(x), row = Math.floor(y)
  while (low <= high) {
    const middle = (low + high) >> 1
    const at = middle * FIELDS
    const spanY = spans[at + 1]
    if (spanY < row || (spanY === row && spans[at] + spans[at + 2] <= column)) low = middle + 1
    else if (spanY > row || spans[at] > column) high = middle - 1
    else return spans[at + 3]
  }
  return 0
}

export function frameBytes(frame) {
  return frame.spans.byteLength + frame.lines.byteLength + frame.edges.byteLength
}
