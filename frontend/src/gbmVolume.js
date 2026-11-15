// The 3D mode's data: a coarse volume of every slice's GBM prediction, its surface, and
// what a click on that surface points at.
//
// The server reduces each slice's prediction and stacks them (backend/agh_api/gbm_volume.py).
// Here the volume becomes a surface where half of a voxel is GBM. Nothing is smoothed
// between slices, so what the model shows is what the slices hold.
//
// Nothing here touches the page or the network, so it also runs in a worker and in tests.

export const MIN_3D_SLICES = 11
const MAGIC = [0x47, 0x42, 0x56, 0x31] // "GBV1"
const ISO = 127.5
// A vertex whose surroundings are GBM that does not count has this class instead of a reason.
export const CLASS_KEPT = 0
export const CLASS_EXCLUDED = 255

// Whether an image can be shown in 3D, and why not.
export function volumeAvailability(zCount, runsByZ, imageKey) {
  const count = Math.max(1, Number(zCount) || 1)
  if (count < MIN_3D_SLICES) {
    return { available: false, runIds: [], ready: 0, total: count, reason: `3D needs more than ${MIN_3D_SLICES - 1} Z slices; this image has ${count}` }
  }
  const runIds = []
  let running = 0
  for (let z = 0; z < count; z += 1) {
    const run = runsByZ?.[String(z)]
    if (!run?.runId || (imageKey && run.imageKey !== imageKey)) continue
    const status = String(run.status || '').toUpperCase()
    if (status === 'SUCCEEDED') runIds.push(run.runId)
    else if (status === 'SUBMITTING' || status === 'QUEUED' || status === 'RUNNING') running += 1
  }
  if (runIds.length < count) {
    const progress = `${runIds.length} of ${count} done${running ? `, ${running} running` : ''}`
    return { available: false, runIds: [], ready: runIds.length, total: count, reason: `3D needs a prediction on every Z slice (${progress})` }
  }
  return { available: true, runIds, ready: count, total: count, reason: '' }
}

export function parseVolume(buffer) {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 8 || MAGIC.some((value, index) => bytes[index] !== value)) throw new Error('The 3D volume could not be read')
  const headerLength = new DataView(buffer).getUint32(4, true)
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)))
  const [nx, ny, nz] = header.size
  const count = nx * ny * nz
  const start = 8 + headerLength
  if (bytes.length < start + 3 * count) throw new Error('The 3D volume is incomplete')
  return {
    header,
    size: [nx, ny, nz],
    coverage: bytes.subarray(start, start + count),
    kept: bytes.subarray(start + count, start + 2 * count),
    reason: bytes.subarray(start + 2 * count, start + 3 * count),
  }
}

// ---- Surface ------------------------------------------------------------------------

class Growable {
  constructor(Type, capacity) {
    this.Type = Type
    this.values = new Type(capacity)
    this.length = 0
  }

  reserve(extra) {
    if (this.length + extra <= this.values.length) return
    const grown = new this.Type(Math.max(this.values.length * 2, this.length + extra))
    grown.set(this.values.subarray(0, this.length))
    this.values = grown
  }

  result() {
    return this.values.slice(0, this.length)
  }
}

// Corner order: bit 0 is +x, bit 1 is +y, bit 2 is +z.
const EDGES = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]]

// The surface where half a voxel is GBM, by surface nets: one vertex per cell the surface
// passes through, joined across every grid edge that crosses it. The volume is treated as
// empty beyond its faces, so GBM cut by the first or last slice is closed with a flat cap.
//
// Positions are in voxels: x and y along the reduced image, z in slices. Normals point out
// of the GBM. Each vertex has a class: 0 where the GBM around it counts, otherwise the
// reason code it does not.
export function buildSurface({ size, coverage, kept, reason }, { iso = ISO } = {}) {
  const [nx, ny, nz] = size
  // Two empty voxels on every side: one closes the surface, one more keeps gradients simple.
  const PAD = 2
  const px = nx + 2 * PAD, py = ny + 2 * PAD, pz = nz + 2 * PAD
  const rowStride = px, sliceStride = px * py
  const field = new Uint8Array(px * py * pz)
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      const from = (z * ny + y) * nx
      field.set(coverage.subarray(from, from + nx), (z + PAD) * sliceStride + (y + PAD) * rowStride + PAD)
    }
  }
  const corner = [0, 1, rowStride, rowStride + 1, sliceStride, sliceStride + 1, sliceStride + rowStride, sliceStride + rowStride + 1]

  const positions = new Growable(Float32Array, 3 << 16)
  const normals = new Growable(Int8Array, 3 << 16)
  const classes = new Growable(Uint8Array, 1 << 16)
  const indices = new Growable(Uint32Array, 6 << 16)
  // Vertex of each cell in this layer of cells and the one below, to join them.
  const layer = [new Int32Array(px * py).fill(-1), new Int32Array(px * py).fill(-1)]
  const value = new Float32Array(8)
  let vertexCount = 0

  const sourceIndex = (x, y, z) => {
    const sx = x - PAD, sy = y - PAD, sz = z - PAD
    return sx >= 0 && sy >= 0 && sz >= 0 && sx < nx && sy < ny && sz < nz ? (sz * ny + sy) * nx + sx : -1
  }

  for (let z = 1; z < pz - 2; z += 1) {
    const current = layer[z & 1], below = layer[(z + 1) & 1]
    current.fill(-1)
    for (let y = 1; y < py - 2; y += 1) {
      let base = z * sliceStride + y * rowStride + 1
      for (let x = 1; x < px - 2; x += 1, base += 1) {
        let mask = 0
        for (let index = 0; index < 8; index += 1) {
          const sample = field[base + corner[index]]
          value[index] = sample
          if (sample >= iso) mask |= 1 << index
        }
        if (mask === 0 || mask === 255) continue

        // The vertex: the middle of where this cell's edges cross the surface.
        let sumX = 0, sumY = 0, sumZ = 0, crossings = 0
        for (let edge = 0; edge < 12; edge += 1) {
          const a = EDGES[edge][0], b = EDGES[edge][1]
          if (((mask >> a) & 1) === ((mask >> b) & 1)) continue
          const t = (iso - value[a]) / (value[b] - value[a])
          sumX += (a & 1) + t * ((b & 1) - (a & 1))
          sumY += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1))
          sumZ += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1))
          crossings += 1
        }
        const fx = sumX / crossings, fy = sumY / crossings, fz = sumZ / crossings

        // Its normal: the field's slope at the vertex, from the slopes at the cell's corners.
        let gx = 0, gy = 0, gz = 0
        for (let index = 0; index < 8; index += 1) {
          const at = base + corner[index]
          const weight = ((index & 1) ? fx : 1 - fx) * ((index & 2) ? fy : 1 - fy) * ((index & 4) ? fz : 1 - fz)
          gx += weight * (field[at + 1] - field[at - 1])
          gy += weight * (field[at + rowStride] - field[at - rowStride])
          gz += weight * (field[at + sliceStride] - field[at - sliceStride])
        }
        const length = Math.hypot(gx, gy, gz) || 1

        // Its class: whether the GBM around it counts, and if not, the reason found there.
        let all = 0, counted = 0, why = 0, whyWeight = -1
        for (let index = 0; index < 8; index += 1) {
          const source = sourceIndex(x + (index & 1), y + ((index >> 1) & 1), z + ((index >> 2) & 1))
          if (source < 0) continue
          all += coverage[source]
          counted += kept[source]
          if (reason[source] && coverage[source] > whyWeight) {
            why = reason[source]
            whyWeight = coverage[source]
          }
        }

        positions.reserve(3)
        normals.reserve(3)
        classes.reserve(1)
        positions.values[positions.length++] = x - PAD + fx
        positions.values[positions.length++] = y - PAD + fy
        positions.values[positions.length++] = z - PAD + fz
        normals.values[normals.length++] = Math.round(-gx / length * 127)
        normals.values[normals.length++] = Math.round(-gy / length * 127)
        normals.values[normals.length++] = Math.round(-gz / length * 127)
        classes.values[classes.length++] = counted * 2 >= all ? CLASS_KEPT : (why || CLASS_EXCLUDED)
        const cell = y * rowStride + x
        current[cell] = vertexCount

        // Faces: across each grid edge leaving this cell's first corner that the surface crosses.
        const inside = mask & 1
        for (let axis = 0; axis < 3; axis += 1) {
          if (inside === ((mask >> (1 << axis)) & 1)) continue
          let a, b, c
          if (axis === 0) {
            a = current[cell - rowStride]; b = below[cell - rowStride]; c = below[cell]
          } else if (axis === 1) {
            a = below[cell]; b = below[cell - 1]; c = current[cell - 1]
          } else {
            a = current[cell - 1]; b = current[cell - rowStride - 1]; c = current[cell - rowStride]
          }
          if (a < 0 || b < 0 || c < 0) continue
          indices.reserve(6)
          const out = indices.values
          let at = indices.length
          if (inside) {
            out[at++] = vertexCount; out[at++] = a; out[at++] = b
            out[at++] = vertexCount; out[at++] = b; out[at++] = c
          } else {
            out[at++] = vertexCount; out[at++] = b; out[at++] = a
            out[at++] = vertexCount; out[at++] = c; out[at++] = b
          }
          indices.length = at
        }
        vertexCount += 1
      }
    }
  }
  return {
    positions: positions.result(), normals: normals.result(), classes: classes.result(), indices: indices.result(),
    vertexCount, triangleCount: indices.length / 3,
  }
}

// ---- Picking --------------------------------------------------------------------------

function sampler(values, [nx, ny, nz]) {
  return (x, y, z) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z)
    const fx = x - x0, fy = y - y0, fz = z - z0
    let total = 0
    for (let index = 0; index < 8; index += 1) {
      const cx = x0 + (index & 1), cy = y0 + ((index >> 1) & 1), cz = z0 + ((index >> 2) & 1)
      if (cx < 0 || cy < 0 || cz < 0 || cx >= nx || cy >= ny || cz >= nz) continue
      total += values[(cz * ny + cy) * nx + cx]
        * ((index & 1) ? fx : 1 - fx) * ((index & 2) ? fy : 1 - fy) * ((index & 4) ? fz : 1 - fz)
    }
    return total
  }
}

// Where a ray first meets the surface, in voxels, or null. ``origin`` and ``direction`` are
// in voxels too. With ``keptOnly``, GBM that does not count is passed through, as when it
// is hidden.
export function pickSurface(volume, origin, direction, { iso = ISO, keptOnly = false } = {}) {
  const { size } = volume
  const length = Math.hypot(direction[0], direction[1], direction[2])
  if (!(length > 0)) return null
  const step = [direction[0] / length, direction[1] / length, direction[2] / length]
  // The stretch of the ray inside the volume, one voxel of margin around it.
  let near = 0, far = Infinity
  for (let axis = 0; axis < 3; axis += 1) {
    const low = -1, high = size[axis]
    if (Math.abs(step[axis]) < 1e-12) {
      if (origin[axis] < low || origin[axis] > high) return null
      continue
    }
    const a = (low - origin[axis]) / step[axis], b = (high - origin[axis]) / step[axis]
    near = Math.max(near, Math.min(a, b))
    far = Math.min(far, Math.max(a, b))
  }
  if (!(far > near)) return null
  const field = sampler(volume.coverage, size)
  const counted = keptOnly ? sampler(volume.kept, size) : null
  const solid = (x, y, z) => {
    const amount = field(x, y, z)
    if (amount < iso) return false
    return !counted || counted(x, y, z) * 2 >= amount
  }
  const at = t => [origin[0] + step[0] * t, origin[1] + step[1] * t, origin[2] + step[2] * t]
  const STEP = 0.4
  let previous = near
  for (let t = near; t <= far + STEP; t += STEP) {
    const point = at(t)
    if (!solid(point[0], point[1], point[2])) { previous = t; continue }
    // Between the last empty sample and this one, by halving.
    let outside = previous, inside = t
    for (let round = 0; round < 6; round += 1) {
      const middle = (outside + inside) / 2
      const probe = at(middle)
      if (solid(probe[0], probe[1], probe[2])) inside = middle
      else outside = middle
    }
    const hit = at(inside)
    return { x: hit[0], y: hit[1], z: hit[2], distance: inside }
  }
  return null
}

// The slice a point of the volume belongs to, and where it is in that slice's image.
export function sliceAtPoint(header, point) {
  const layers = header.zIndices.length
  const layer = Math.max(0, Math.min(layers - 1, Math.round(point.z)))
  const m = header.planeFromVoxel[layer]
  const y = m[0] * point.y + m[1] * point.x + m[2]
  const x = m[3] * point.y + m[4] * point.x + m[5]
  return {
    layer,
    zIndex: header.zIndices[layer],
    runId: header.runIds[layer],
    x: Math.max(0, Math.min(header.source.width, x)),
    y: Math.max(0, Math.min(header.source.height, y)),
  }
}

// What the GBM at a point is: 0 where it counts, else its reason code.
export function classAtPoint(volume, point) {
  const [nx, ny, nz] = volume.size
  const x0 = Math.floor(point.x), y0 = Math.floor(point.y), z0 = Math.floor(point.z)
  let all = 0, counted = 0, why = 0, whyWeight = -1
  for (let index = 0; index < 8; index += 1) {
    const cx = x0 + (index & 1), cy = y0 + ((index >> 1) & 1), cz = z0 + ((index >> 2) & 1)
    if (cx < 0 || cy < 0 || cz < 0 || cx >= nx || cy >= ny || cz >= nz) continue
    const source = (cz * ny + cy) * nx + cx
    all += volume.coverage[source]
    counted += volume.kept[source]
    if (volume.reason[source] && volume.coverage[source] > whyWeight) {
      why = volume.reason[source]
      whyWeight = volume.coverage[source]
    }
  }
  if (!all) return null
  return counted * 2 >= all ? CLASS_KEPT : (why || CLASS_EXCLUDED)
}

// How large the volume is as imaged. Without a recorded Z step, slices are drawn one voxel apart.
export function volumeScale(header) {
  const x = Number(header.voxelUm?.x) || 1
  const y = Number(header.voxelUm?.y) || x
  const knownZ = Number(header.voxelUm?.z) > 0
  const z = knownZ ? Number(header.voxelUm.z) : (x + y) / 2
  return { x, y, z, knownZ }
}
