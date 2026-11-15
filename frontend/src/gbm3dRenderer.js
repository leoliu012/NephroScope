// Draws the 3D GBM model with WebGL 2, and the camera that looks at it.
//
// The model is kept in voxels (x and y along the reduced image, z in slices) and placed in
// the world by one matrix: micrometres as imaged, the image's y pointing down the screen
// from above, and deeper slices further from a camera looking down at the first one.

// ---- Camera ---------------------------------------------------------------------------

const FIELD_OF_VIEW = 35 * Math.PI / 180
const MIN_POLAR = 0.0005

const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

// Size of the volume in the world, and the voxel at its middle.
export function modelFrame(size, scale, stretch = 1) {
  const step = [scale.x, scale.y, scale.z * stretch]
  const extent = [size[0] * step[0], size[1] * step[1], size[2] * step[2]]
  return {
    step,
    extent,
    center: [(size[0] - 1) / 2, (size[1] - 1) / 2, (size[2] - 1) / 2],
    radius: 0.5 * Math.hypot(extent[0], extent[1], extent[2]),
  }
}

export function voxelToWorld(frame, point) {
  return [
    (point[0] - frame.center[0]) * frame.step[0],
    -(point[1] - frame.center[1]) * frame.step[1],
    -(point[2] - frame.center[2]) * frame.step[2],
  ]
}

export function worldToVoxel(frame, point) {
  return [
    point[0] / frame.step[0] + frame.center[0],
    -point[1] / frame.step[1] + frame.center[1],
    -point[2] / frame.step[2] + frame.center[2],
  ]
}

// A direction, which has no position.
export function worldDirectionToVoxel(frame, direction) {
  return [direction[0] / frame.step[0], -direction[1] / frame.step[1], -direction[2] / frame.step[2]]
}

export const VIEW_PRESETS = Object.freeze({
  // Looking down at the first slice, as the 2D viewer shows it.
  top: { polar: MIN_POLAR, azimuth: -Math.PI / 2 },
  front: { polar: Math.PI / 2, azimuth: -Math.PI / 2 },
  side: { polar: Math.PI / 2, azimuth: 0 },
  angled: { polar: 55 * Math.PI / 180, azimuth: -62 * Math.PI / 180 },
})

export function createCamera(frame, preset = 'angled') {
  return {
    target: [0, 0, 0],
    ...VIEW_PRESETS[preset],
    distance: frame.radius / Math.sin(FIELD_OF_VIEW / 2) * 1.02,
  }
}

export function cameraBasis(camera) {
  const sinPolar = Math.sin(camera.polar), cosPolar = Math.cos(camera.polar)
  const cosAzimuth = Math.cos(camera.azimuth), sinAzimuth = Math.sin(camera.azimuth)
  const outward = [sinPolar * cosAzimuth, sinPolar * sinAzimuth, cosPolar]
  const eye = [
    camera.target[0] + camera.distance * outward[0],
    camera.target[1] + camera.distance * outward[1],
    camera.target[2] + camera.distance * outward[2],
  ]
  const forward = [-outward[0], -outward[1], -outward[2]]
  // Well defined looking straight down too, where "up" is the far edge of the image.
  const up = [-cosPolar * cosAzimuth, -cosPolar * sinAzimuth, sinPolar]
  const right = normalize(cross(forward, up))
  return { eye, forward, right, up: cross(right, forward) }
}

export function orbit(camera, dx, dy) {
  return {
    ...camera,
    azimuth: camera.azimuth - dx * 0.008,
    polar: Math.max(MIN_POLAR, Math.min(Math.PI - MIN_POLAR, camera.polar - dy * 0.008)),
  }
}

// Slide the model with the pointer, by pixels on a viewport this many pixels high.
export function pan(camera, dx, dy, viewportHeight) {
  const { right, up } = cameraBasis(camera)
  const perPixel = 2 * camera.distance * Math.tan(FIELD_OF_VIEW / 2) / Math.max(1, viewportHeight)
  return {
    ...camera,
    target: [
      camera.target[0] - (right[0] * dx - up[0] * dy) * perPixel,
      camera.target[1] - (right[1] * dx - up[1] * dy) * perPixel,
      camera.target[2] - (right[2] * dx - up[2] * dy) * perPixel,
    ],
  }
}

// Move towards or away from ``anchor``, which stays where it is on screen.
export function zoom(camera, factor, anchor, frame) {
  const distance = Math.max(frame.radius * 0.01, Math.min(frame.radius * 12, camera.distance * factor))
  const applied = distance / camera.distance
  const fixed = anchor || camera.target
  return {
    ...camera,
    distance,
    target: [
      fixed[0] + (camera.target[0] - fixed[0]) * applied,
      fixed[1] + (camera.target[1] - fixed[1]) * applied,
      fixed[2] + (camera.target[2] - fixed[2]) * applied,
    ],
  }
}

// The ray through a point of the viewport, in the world.
export function viewRay(camera, x, y, width, height) {
  const { eye, forward, right, up } = cameraBasis(camera)
  const tangent = Math.tan(FIELD_OF_VIEW / 2)
  const across = (2 * x / width - 1) * tangent * (width / height)
  const along = (1 - 2 * y / height) * tangent
  return {
    origin: eye,
    direction: normalize([
      forward[0] + right[0] * across + up[0] * along,
      forward[1] + right[1] * across + up[1] * along,
      forward[2] + right[2] * across + up[2] * along,
    ]),
  }
}

// Where the ray meets the plane through the target that faces the camera.
export function rayAtTargetDepth(camera, ray) {
  const { forward } = cameraBasis(camera)
  const t = dot(subtract(camera.target, ray.origin), forward) / dot(ray.direction, forward)
  return [ray.origin[0] + ray.direction[0] * t, ray.origin[1] + ray.direction[1] * t, ray.origin[2] + ray.direction[2] * t]
}

// Column-major 4 x 4 matrices, as WebGL takes them.
function viewMatrix(camera) {
  const { eye, forward, right, up } = cameraBasis(camera)
  return [
    right[0], up[0], -forward[0], 0,
    right[1], up[1], -forward[1], 0,
    right[2], up[2], -forward[2], 0,
    -dot(right, eye), -dot(up, eye), dot(forward, eye), 1,
  ]
}

function projectionMatrix(aspect, near, far) {
  const f = 1 / Math.tan(FIELD_OF_VIEW / 2)
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, 2 * far * near / (near - far), 0,
  ]
}

function modelMatrix(frame) {
  const [sx, sy, sz] = frame.step
  return [
    sx, 0, 0, 0,
    0, -sy, 0, 0,
    0, 0, -sz, 0,
    -frame.center[0] * sx, frame.center[1] * sy, frame.center[2] * sz, 1,
  ]
}

function multiply(a, b) {
  const out = new Array(16)
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let total = 0
      for (let k = 0; k < 4; k += 1) total += a[k * 4 + row] * b[column * 4 + k]
      out[column * 4 + row] = total
    }
  }
  return out
}

// ---- Colours --------------------------------------------------------------------------

export function hexToRgb(value, fallback = [255, 255, 255]) {
  const match = /^#([0-9a-f]{6})$/i.exec(value || '')
  if (!match) return fallback
  const number = Number.parseInt(match[1], 16)
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
}

// Colour of each vertex class: 0 is GBM that counts, the others are reason codes.
// Alpha 0 hides a class.
export function classPalette({ keptColor, reasonColors = {}, excludedColor = '#94a3b8', showExcluded = true }) {
  const palette = new Uint8Array(256 * 4)
  const fallback = hexToRgb(excludedColor)
  for (let code = 1; code < 256; code += 1) {
    const [red, green, blue] = reasonColors[code] ? hexToRgb(reasonColors[code], fallback) : fallback
    palette.set([red, green, blue, showExcluded ? 255 : 0], code * 4)
  }
  palette.set([...hexToRgb(keptColor, [0, 212, 255]), 255], 0)
  return palette
}

// From the first slice to the last.
export const DEPTH_COLORS = ['#5b8cff', '#22d3ee', '#4ade80', '#facc15', '#fb7185']

// ---- Drawing --------------------------------------------------------------------------

const SURFACE_VERTEX = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in float a_class;
uniform mat4 u_modelView;
uniform mat4 u_projection;
uniform vec3 u_normalScale;
out vec3 v_normal;
out vec3 v_position;
out float v_layer;
flat out float v_class;
void main() {
  vec4 position = u_modelView * vec4(a_position, 1.0);
  gl_Position = u_projection * position;
  v_position = position.xyz;
  // The view matrix only turns and moves, so it carries normals as it does directions.
  v_normal = mat3(u_modelView) * (a_normal * u_normalScale);
  v_layer = a_position.z;
  v_class = a_class;
}`

const SURFACE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_palette;
uniform vec3 u_depthColors[5];
uniform bool u_colorByDepth;
uniform float u_lastLayer;
uniform float u_slice;
uniform float u_hoverSlice;
in vec3 v_normal;
in vec3 v_position;
in float v_layer;
flat in float v_class;
out vec4 color;
void main() {
  vec4 base = texelFetch(u_palette, ivec2(int(v_class + 0.5), 0), 0);
  if (base.a < 0.5) discard;
  if (u_colorByDepth) {
    float position = clamp(v_layer / max(u_lastLayer, 1.0), 0.0, 1.0) * 4.0;
    int stop = int(min(floor(position), 3.0));
    base.rgb = mix(u_depthColors[stop], u_depthColors[stop + 1], position - float(stop));
  }
  vec3 normal = normalize(v_normal);
  vec3 toEye = normalize(-v_position);
  // GBM is a sheet seen from either side.
  if (dot(normal, toEye) < 0.0) normal = -normal;
  vec3 light = normalize(vec3(0.35, 0.55, 0.75));
  float diffuse = max(dot(normal, light), 0.0);
  float sky = 0.5 + 0.5 * normal.y;
  float shine = pow(max(dot(normal, normalize(light + toEye)), 0.0), 48.0);
  vec3 lit = base.rgb * (0.30 + 0.58 * diffuse + 0.14 * sky) + vec3(0.16) * shine;
  // Where the slice open in the 2D viewer cuts the model, and the slice under the pointer.
  float onSlice = 1.0 - smoothstep(0.35, 0.5, abs(v_layer - u_slice));
  float onHover = 1.0 - smoothstep(0.35, 0.5, abs(v_layer - u_hoverSlice));
  lit = mix(lit, vec3(1.0), 0.75 * onSlice);
  lit = mix(lit, vec3(1.0, 0.82, 0.4), 0.8 * onHover * (1.0 - onSlice));
  color = vec4(lit, 1.0);
}`

const LINE_VERTEX = `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_modelView;
uniform mat4 u_projection;
uniform float u_pointSize;
void main() {
  gl_Position = u_projection * (u_modelView * vec4(a_position, 1.0));
  gl_PointSize = u_pointSize;
}`

const LINE_FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 u_color;
uniform bool u_round;
out vec4 color;
void main() {
  if (u_round) {
    float distance = length(gl_PointCoord - vec2(0.5));
    if (distance > 0.5) discard;
    color = distance > 0.32 ? vec4(0.05, 0.07, 0.1, u_color.a) : u_color;
    return;
  }
  color = u_color;
}`

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Unable to prepare 3D drawing: ${message}`)
  }
  return shader
}

function createProgram(gl, vertex, fragment) {
  const program = gl.createProgram()
  const shaders = [compile(gl, gl.VERTEX_SHADER, vertex), compile(gl, gl.FRAGMENT_SHADER, fragment)]
  shaders.forEach(shader => gl.attachShader(program, shader))
  gl.linkProgram(program)
  shaders.forEach(shader => gl.deleteShader(shader))
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`Unable to prepare 3D drawing: ${message}`)
  }
  const uniforms = {}
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS)
  for (let index = 0; index < count; index += 1) {
    const name = gl.getActiveUniform(program, index).name.replace(/\[0\]$/, '')
    uniforms[name] = gl.getUniformLocation(program, name)
  }
  return { program, uniforms }
}

// The outline of the volume, and of one slice of it.
function boxLines(size) {
  const low = [-0.5, -0.5, -0.5], high = [size[0] - 0.5, size[1] - 0.5, size[2] - 0.5]
  const corner = index => [(index & 1) ? high[0] : low[0], (index & 2) ? high[1] : low[1], (index & 4) ? high[2] : low[2]]
  const lines = []
  for (let index = 0; index < 8; index += 1) {
    for (const bit of [1, 2, 4]) if (!(index & bit)) lines.push(...corner(index), ...corner(index | bit))
  }
  return new Float32Array(lines)
}

function sliceLines(size, z) {
  const x0 = -0.5, y0 = -0.5, x1 = size[0] - 0.5, y1 = size[1] - 0.5
  return new Float32Array([x0, y0, z, x1, y0, z, x1, y0, z, x1, y1, z, x1, y1, z, x0, y1, z, x0, y1, z, x0, y0, z])
}

export function createModelRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' })
  if (!gl) throw new Error('3D needs WebGL 2, which this browser does not provide')
  const surface = createProgram(gl, SURFACE_VERTEX, SURFACE_FRAGMENT)
  const line = createProgram(gl, LINE_VERTEX, LINE_FRAGMENT)

  const surfaceArray = gl.createVertexArray()
  const buffers = { positions: gl.createBuffer(), normals: gl.createBuffer(), classes: gl.createBuffer(), indices: gl.createBuffer() }
  const lineArray = gl.createVertexArray()
  const lineBuffer = gl.createBuffer()
  gl.bindVertexArray(lineArray)
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)

  const paletteTexture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, paletteTexture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  let indexCount = 0
  let lost = false
  const onLost = event => { event.preventDefault(); lost = true }
  canvas.addEventListener('webglcontextlost', onLost)

  const drawLines = (vertices, modelView, projection, color, mode = gl.LINES, pointSize = 1) => {
    gl.bindVertexArray(lineArray)
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW)
    gl.uniformMatrix4fv(line.uniforms.u_modelView, false, modelView)
    gl.uniformMatrix4fv(line.uniforms.u_projection, false, projection)
    gl.uniform4fv(line.uniforms.u_color, color)
    gl.uniform1f(line.uniforms.u_pointSize, pointSize)
    gl.uniform1i(line.uniforms.u_round, mode === gl.POINTS ? 1 : 0)
    gl.drawArrays(mode, 0, vertices.length / 3)
  }

  return {
    get lost() { return lost },

    setSurface({ positions, normals, classes, indices }) {
      gl.bindVertexArray(surfaceArray)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.positions)
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normals)
      gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 3, gl.BYTE, true, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.classes)
      gl.bufferData(gl.ARRAY_BUFFER, classes, gl.STATIC_DRAW)
      gl.enableVertexAttribArray(2)
      gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 0, 0)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.indices)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
      gl.bindVertexArray(null)
      indexCount = indices.length
    },

    draw({ camera, frame, size, palette, colorByDepth = false, slice = -10, hoverSlice = -10, marker = null }) {
      if (lost) return
      const width = canvas.width, height = canvas.height
      gl.viewport(0, 0, width, height)
      gl.clearColor(0.043, 0.059, 0.086, 1)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.enable(gl.DEPTH_TEST)
      gl.disable(gl.CULL_FACE)
      gl.disable(gl.BLEND)

      const reach = Math.hypot(camera.target[0], camera.target[1], camera.target[2]) + frame.radius
      const near = Math.max(frame.radius * 0.002, camera.distance - reach)
      const far = camera.distance + reach
      const projection = projectionMatrix(width / Math.max(1, height), near, far)
      const modelView = multiply(viewMatrix(camera), modelMatrix(frame))

      if (indexCount) {
        gl.useProgram(surface.program)
        gl.uniformMatrix4fv(surface.uniforms.u_modelView, false, modelView)
        gl.uniformMatrix4fv(surface.uniforms.u_projection, false, projection)
        // The model matrix scales and flips; normals take the inverse of that. The flips are
        // undone by the view's own turn of the model's axes, so only the sizes are left here.
        gl.uniform3f(surface.uniforms.u_normalScale, 1 / (frame.step[0] ** 2), 1 / (frame.step[1] ** 2), 1 / (frame.step[2] ** 2))
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, paletteTexture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, palette)
        gl.uniform1i(surface.uniforms.u_palette, 0)
        gl.uniform1i(surface.uniforms.u_colorByDepth, colorByDepth ? 1 : 0)
        gl.uniform3fv(surface.uniforms.u_depthColors, DEPTH_COLORS.flatMap(color => hexToRgb(color).map(value => value / 255)))
        gl.uniform1f(surface.uniforms.u_lastLayer, size[2] - 1)
        gl.uniform1f(surface.uniforms.u_slice, slice)
        gl.uniform1f(surface.uniforms.u_hoverSlice, hoverSlice)
        gl.bindVertexArray(surfaceArray)
        gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0)
      }

      gl.useProgram(line.program)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      drawLines(boxLines(size), modelView, projection, [0.58, 0.64, 0.72, 0.32])
      if (slice >= 0) drawLines(sliceLines(size, slice), modelView, projection, [1, 1, 1, 0.85])
      if (hoverSlice >= 0 && hoverSlice !== slice) drawLines(sliceLines(size, hoverSlice), modelView, projection, [1, 0.82, 0.4, 0.8])
      if (marker) {
        gl.disable(gl.DEPTH_TEST)
        drawLines(new Float32Array(marker), modelView, projection, [1, 0.82, 0.4, 1], gl.POINTS, 12 * (window.devicePixelRatio || 1))
      }
      gl.bindVertexArray(null)
    },

    destroy() {
      canvas.removeEventListener('webglcontextlost', onLost)
      Object.values(buffers).forEach(buffer => gl.deleteBuffer(buffer))
      gl.deleteBuffer(lineBuffer)
      gl.deleteVertexArray(surfaceArray)
      gl.deleteVertexArray(lineArray)
      gl.deleteTexture(paletteTexture)
      gl.deleteProgram(surface.program)
      gl.deleteProgram(line.program)
    },
  }
}
