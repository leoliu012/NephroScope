import assert from 'node:assert/strict'

const {
  CLASS_EXCLUDED, CLASS_KEPT, MIN_3D_SLICES, buildSurface, classAtPoint, parseVolume, pickSurface, sliceAtPoint,
  volumeAvailability, volumeScale,
} = await import('./gbmVolume.js')
const {
  VIEW_PRESETS, cameraBasis, classPalette, createCamera, modelFrame, orbit, pan, rayAtTargetDepth, viewRay,
  voxelToWorld, worldDirectionToVoxel, worldToVoxel, zoom,
} = await import('./gbm3dRenderer.js')

const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message || 'value'}: ${actual} is not within ${tolerance} of ${expected}`)

// ---- When 3D is offered ------------------------------------------------------------
const runs = count => Object.fromEntries(Array.from({ length: count }, (_, z) => [String(z), { runId: `run-${z}`, status: 'SUCCEEDED', imageKey: 'case/a.tif' }]))
assert.equal(MIN_3D_SLICES, 11)
const short = volumeAvailability(10, runs(10), 'case/a.tif')
assert.equal(short.available, false)
assert.match(short.reason, /more than 10 Z slices; this image has 10/)
const whole = volumeAvailability(12, runs(12), 'case/a.tif')
assert.equal(whole.available, true)
assert.deepEqual(whole.runIds, Array.from({ length: 12 }, (_, z) => `run-${z}`))
const partial = runs(12)
delete partial['4']
partial['7'] = { runId: 'run-7', status: 'RUNNING', imageKey: 'case/a.tif' }
const waiting = volumeAvailability(12, partial, 'case/a.tif')
assert.equal(waiting.available, false)
assert.match(waiting.reason, /every Z slice \(10 of 12 done, 1 running\)/)
// Predictions of another image do not count towards this one.
assert.equal(volumeAvailability(12, runs(12), 'case/b.tif').available, false)
assert.equal(volumeAvailability(12, { ...runs(12), 3: { runId: 'run-3', status: 'FAILED', imageKey: 'case/a.tif' } }, 'case/a.tif').available, false)

// ---- Reading the volume ------------------------------------------------------------
function encodeVolume(header, volumes) {
  const text = new TextEncoder().encode(JSON.stringify(header))
  const bytes = new Uint8Array(8 + text.length + volumes.reduce((total, volume) => total + volume.length, 0))
  bytes.set([0x47, 0x42, 0x56, 0x31])
  new DataView(bytes.buffer).setUint32(4, text.length, true)
  bytes.set(text, 8)
  let offset = 8 + text.length
  for (const volume of volumes) { bytes.set(volume, offset); offset += volume.length }
  return bytes.buffer
}
const tiny = { size: [2, 3, 2], zIndices: [0, 1] }
const parsed = parseVolume(encodeVolume(tiny, [new Uint8Array(12).fill(9), new Uint8Array(12).fill(8), new Uint8Array(12).fill(7)]))
assert.deepEqual(parsed.size, [2, 3, 2])
assert.deepEqual([parsed.coverage.length, parsed.coverage[0], parsed.kept[11], parsed.reason[5]], [12, 9, 8, 7])
assert.throws(() => parseVolume(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]).buffer), /could not be read/)
assert.throws(() => parseVolume(encodeVolume(tiny, [new Uint8Array(12), new Uint8Array(12)])), /incomplete/)

// ---- Surface -----------------------------------------------------------------------
function makeVolume(size, amount, { keptWhere = () => true, reasonCode = 2 } = {}) {
  const [nx, ny, nz] = size
  const coverage = new Uint8Array(nx * ny * nz), kept = new Uint8Array(nx * ny * nz), reason = new Uint8Array(nx * ny * nz)
  for (let z = 0; z < nz; z += 1) for (let y = 0; y < ny; y += 1) for (let x = 0; x < nx; x += 1) {
    const index = (z * ny + y) * nx + x
    coverage[index] = Math.round(255 * Math.max(0, Math.min(1, amount(x, y, z))))
    if (keptWhere(x, y, z)) kept[index] = coverage[index]
    else if (coverage[index]) reason[index] = reasonCode
  }
  return { size, coverage, kept, reason }
}

// Every edge of a closed surface belongs to exactly two triangles.
function edgeUse(surface) {
  const edges = new Map()
  for (let at = 0; at < surface.indices.length; at += 3) {
    for (let side = 0; side < 3; side += 1) {
      const a = surface.indices[at + side], b = surface.indices[at + (side + 1) % 3]
      const key = a < b ? `${a}-${b}` : `${b}-${a}`
      edges.set(key, (edges.get(key) || 0) + 1)
    }
  }
  return edges
}

const CENTER = 10, RADIUS = 6
const ball = makeVolume([21, 21, 21], (x, y, z) => RADIUS + 0.5 - Math.hypot(x - CENTER, y - CENTER, z - CENTER), { keptWhere: x => x < CENTER })
const sphere = buildSurface(ball)
assert.equal(sphere.positions.length, sphere.vertexCount * 3)
assert.equal(sphere.indices.length, sphere.triangleCount * 3)
const sphereEdges = edgeUse(sphere)
assert.ok([...sphereEdges.values()].every(count => count === 2), 'the sphere is closed')
// One closed surface without holes: vertices - edges + faces = 2.
assert.equal(sphere.vertexCount - sphereEdges.size + sphere.triangleCount, 2)
let outward = 0, keptVertices = 0, excludedVertices = 0
for (let vertex = 0; vertex < sphere.vertexCount; vertex += 1) {
  const x = sphere.positions[vertex * 3] - CENTER, y = sphere.positions[vertex * 3 + 1] - CENTER, z = sphere.positions[vertex * 3 + 2] - CENTER
  const distance = Math.hypot(x, y, z)
  near(distance, RADIUS, 0.6, 'a vertex is on the sphere')
  outward += (sphere.normals[vertex * 3] * x + sphere.normals[vertex * 3 + 1] * y + sphere.normals[vertex * 3 + 2] * z) / (127 * distance)
  // The half that counts is class 0, the other carries its reason.
  if (x < -1.5) { assert.equal(sphere.classes[vertex], CLASS_KEPT); keptVertices += 1 }
  if (x > 1.5) { assert.equal(sphere.classes[vertex], 2); excludedVertices += 1 }
}
assert.ok(outward / sphere.vertexCount > 0.97, 'normals point out of the GBM')
assert.ok(keptVertices > 50 && excludedVertices > 50)
// Faces wind anticlockwise seen from outside, in step with their normals.
{
  const [a, b, c] = [0, 1, 2].map(corner => {
    const vertex = sphere.indices[corner]
    return [sphere.positions[vertex * 3] - CENTER, sphere.positions[vertex * 3 + 1] - CENTER, sphere.positions[vertex * 3 + 2] - CENTER]
  })
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const face = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  assert.ok(face[0] * a[0] + face[1] * a[1] + face[2] * a[2] > 0)
}

// A wall running through every slice is closed where the stack ends, by flat caps.
const wall = makeVolume([12, 12, 5], x => (x >= 4 && x <= 6 ? 1 : 0))
const slab = buildSurface(wall)
assert.ok([...edgeUse(slab).values()].every(count => count === 2), 'a wall cut by the stack is capped')
let lowZ = Infinity, highZ = -Infinity, lowX = Infinity, highX = -Infinity
for (let vertex = 0; vertex < slab.vertexCount; vertex += 1) {
  lowZ = Math.min(lowZ, slab.positions[vertex * 3 + 2]); highZ = Math.max(highZ, slab.positions[vertex * 3 + 2])
  lowX = Math.min(lowX, slab.positions[vertex * 3]); highX = Math.max(highX, slab.positions[vertex * 3])
}
// Half a slice beyond the first and last, and half a voxel beyond the wall.
near(lowZ, -0.5, 0.01); near(highZ, 4.5, 0.01); near(lowX, 3.5, 0.01); near(highX, 6.5, 0.01)
assert.equal(buildSurface(makeVolume([6, 6, 6], () => 0)).vertexCount, 0)

// ---- Picking -----------------------------------------------------------------------
const fromAbove = pickSurface(ball, [CENTER, CENTER, -20], [0, 0, 1])
near(fromAbove.z, CENTER - RADIUS, 0.2, 'a ray from above meets the top of the sphere')
near(fromAbove.x, CENTER, 1e-6)
assert.equal(pickSurface(ball, [1, 1, -20], [0, 0, 1]), null)
assert.equal(pickSurface(ball, [CENTER, CENTER, -20], [0, 0, -1]), null)
assert.equal(pickSurface(ball, [CENTER, CENTER, -20], [0, 0, 0]), null)
// From the side that does not count: hit it when it is drawn, pass through it when it is hidden.
const fromExcluded = pickSurface(ball, [40, CENTER, CENTER], [-1, 0, 0])
near(fromExcluded.x, CENTER + RADIUS, 0.2)
assert.equal(classAtPoint(ball, fromExcluded), 2)
const through = pickSurface(ball, [40, CENTER, CENTER], [-1, 0, 0], { keptOnly: true })
assert.ok(through.x < CENTER + 0.5 && through.x > CENTER - 1.5, `the kept half starts at the middle, not ${through.x}`)
assert.equal(classAtPoint(ball, pickSurface(ball, [-20, CENTER, CENTER], [1, 0, 0])), CLASS_KEPT)
assert.equal(classAtPoint(ball, { x: 0.2, y: 0.2, z: 0.2 }), null)
assert.equal(classAtPoint(makeVolume([4, 4, 4], () => 1, { keptWhere: () => false, reasonCode: 0 }), { x: 1.5, y: 1.5, z: 1.5 }), CLASS_EXCLUDED)

// ---- From the model to a slice -----------------------------------------------------
const header = {
  size: [100, 80, 3], zIndices: [0, 1, 2], runIds: ['a', 'b', 'c'], source: { width: 400, height: 320 },
  // Reduced four times; the last slice is seen 10 px further along x.
  planeFromVoxel: [[4, 0, 1.5, 0, 4, 1.5], [4, 0, 1.5, 0, 4, 1.5], [4, 0, 1.5, 0, 4, 11.5]],
  voxelUm: { x: 0.4, y: 0.4, z: 0.3 },
}
assert.deepEqual(sliceAtPoint(header, { x: 10, y: 20, z: 0.4 }), { layer: 0, zIndex: 0, runId: 'a', x: 41.5, y: 81.5 })
assert.deepEqual(sliceAtPoint(header, { x: 10, y: 20, z: 1.6 }), { layer: 2, zIndex: 2, runId: 'c', x: 51.5, y: 81.5 })
// The caps lie half a slice outside the stack, and still belong to its end slices.
assert.equal(sliceAtPoint(header, { x: 10, y: 20, z: -0.5 }).zIndex, 0)
assert.equal(sliceAtPoint(header, { x: 10, y: 20, z: 2.5 }).zIndex, 2)
assert.equal(sliceAtPoint(header, { x: 500, y: -3, z: 1 }).x, 400)
assert.equal(sliceAtPoint(header, { x: 500, y: -3, z: 1 }).y, 0)
assert.deepEqual(volumeScale(header), { x: 0.4, y: 0.4, z: 0.3, knownZ: true })
assert.deepEqual(volumeScale({ voxelUm: { x: 0.4, y: 0.2, z: null } }), { x: 0.4, y: 0.2, z: 0.30000000000000004, knownZ: false })

// ---- Camera ------------------------------------------------------------------------
const frame = modelFrame([100, 80, 30], { x: 0.4, y: 0.4, z: 0.3 }, 2)
assert.deepEqual(frame.extent, [40, 32, 18])
const corner = voxelToWorld(frame, [0, 0, 0])
// The image's first row is at the top, and the first slice is nearest a camera looking down.
assert.ok(corner[0] < 0 && corner[1] > 0 && corner[2] > 0)
const back = worldToVoxel(frame, voxelToWorld(frame, [12, 34, 5]))
back.forEach((value, index) => near(value, [12, 34, 5][index], 1e-9))
assert.deepEqual(worldDirectionToVoxel(frame, [0.4, -0.4, -0.6]).map(value => Math.round(value * 1e6) / 1e6), [1, 1, 1])

// From the top the model looks as the 2D viewer shows the image: x to the right, y down.
const top = { ...createCamera(frame, 'top') }
const basis = cameraBasis(top)
near(basis.right[0], 1, 1e-6); near(basis.up[1], 1, 1e-6); near(basis.forward[2], -1, 1e-6)
assert.ok(basis.eye[2] > frame.radius)
assert.deepEqual(Object.keys(VIEW_PRESETS), ['top', 'front', 'side', 'angled'])

const camera = createCamera(frame)
const middle = viewRay(camera, 400, 300, 800, 600)
const atTarget = rayAtTargetDepth(camera, middle)
atTarget.forEach((value, index) => near(value, camera.target[index], 1e-6, 'the middle of the view is the target'))
// The whole model is in view to begin with.
assert.ok(camera.distance > frame.radius * 3)

// Zooming keeps what is under the pointer under the pointer.
const direction = (from, to) => {
  const delta = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
  const length = Math.hypot(...delta)
  return delta.map(value => value / length)
}
const anchor = [3, -4, 2]
const closer = zoom(camera, 0.5, anchor, frame)
near(closer.distance, camera.distance / 2, 1e-9)
const before = direction(cameraBasis(camera).eye, anchor), after = direction(cameraBasis(closer).eye, anchor)
before.forEach((value, index) => near(after[index], value, 1e-9, 'the anchor stays on its ray'))
// It cannot go through the model, or out of sight.
assert.ok(zoom(camera, 1e-9, null, frame).distance >= frame.radius * 0.01)
assert.ok(zoom(camera, 1e9, null, frame).distance <= frame.radius * 12)

// Dragging right moves the model right, so the target moves left on screen.
const moved = pan(camera, 50, 0, 600)
const right = cameraBasis(camera).right
assert.ok((moved.target[0] - camera.target[0]) * right[0] + (moved.target[1] - camera.target[1]) * right[1] + (moved.target[2] - camera.target[2]) * right[2] < 0)
assert.ok(orbit(camera, 0, 1e6).polar > 0)
assert.ok(orbit(camera, 0, -1e6).polar < Math.PI)
assert.notEqual(orbit(camera, 30, 0).azimuth, camera.azimuth)

// ---- Colours -----------------------------------------------------------------------
const palette = classPalette({ keptColor: '#00d4ff', reasonColors: { 1: '#ef4444' }, showExcluded: true })
assert.deepEqual([...palette.subarray(0, 4)], [0, 212, 255, 255])
assert.deepEqual([...palette.subarray(4, 8)], [239, 68, 68, 255])
assert.deepEqual([...palette.subarray(255 * 4, 256 * 4)], [148, 163, 184, 255])
const hidden = classPalette({ keptColor: '#00d4ff', reasonColors: { 1: '#ef4444' }, showExcluded: false })
assert.equal(hidden[3], 255)
assert.equal(hidden[7], 0)

console.log('gbmVolume.selftest: ok')
