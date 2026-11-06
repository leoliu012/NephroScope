// Draws one slice's GBM prediction on the GPU, from compact lists of runs and points.
//
// A small table says how each piece of centerline is shown, so changing slice, decisions or
// colours costs one draw call and no per-pixel work, which is what keeps scrubbing smooth.
import { REASON_INFO } from './gbmRefinement.js'
import { pieceAtPixel } from './predictionScan.js'

const TABLE_SIZE = 256
const GPU_BUFFER_BYTES = 512 * 1024 * 1024
const MAX_LINE_THICKNESS = 12

export { pieceAtPixel }

function hexColor(value, fallback = [255, 255, 255]) {
  const match = /^#([0-9a-f]{6})$/i.exec(value || '')
  if (!match) return fallback
  const number = Number.parseInt(match[1], 16)
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
}

export function createPieceTable() {
  return new Uint8Array(TABLE_SIZE * TABLE_SIZE * 4)
}

// A table entry's alpha says what a piece is: 0 none, 255 kept, 128 excluded.
const KEPT = 255
const EXCLUDED = 128

export function fillPieceTable(table, reasons, reasonNames) {
  table.fill(0)
  ;(reasons || []).forEach((code, index) => {
    const identity = index + 1
    const target = (identity >> 8) * TABLE_SIZE * 4 + (identity & 255) * 4
    if (target >= table.length) return
    const name = reasonNames?.[String(code)]
    if (name === 'kept') {
      table[target + 3] = KEPT
      return
    }
    const [red, green, blue] = hexColor((REASON_INFO[name] || REASON_INFO.artifact).color)
    table[target] = red
    table[target + 1] = green
    table[target + 2] = blue
    table[target + 3] = EXCLUDED
  })
  return table
}

// The plain mask is one kept piece.
export function fillPlainTable(table) {
  table.fill(0)
  table[4 + 3] = KEPT
  return table
}

export function overlayUniforms({
  maskColor, skeletonColor, opacity = 0.5, showMask = true, showSkeleton = true, contour = false, showExcluded = true, thickness = 2,
}) {
  const level = Math.max(0, Math.min(1, Number(opacity) || 0))
  return {
    keptColor: hexColor(maskColor, [0, 212, 255]).map(value => value / 255),
    lineColor: hexColor(skeletonColor, [255, 209, 102]).map(value => value / 255),
    artifactColor: hexColor(REASON_INFO.artifact.color).map(value => value / 255),
    keptAlpha: showMask ? level : 0,
    excludedAlpha: showExcluded ? 0.42 * Math.max(0.3, Math.min(1, level * 2)) : 0,
    showLines: Boolean(showSkeleton),
    showExcluded: Boolean(showExcluded),
    contour: Boolean(contour),
    thickness: Math.max(1, Math.min(MAX_LINE_THICKNESS, Math.round(Number(thickness) || 1))),
  }
}

// Premultiplied colour of a run of a piece, or null if it is not drawn. The shader does the same.
export function spanColor(table, piece, uniforms, { edgesOnly = false } = {}) {
  const at = (piece >> 8) * TABLE_SIZE * 4 + (piece & 255) * 4
  const kind = table[at + 3]
  if (kind === KEPT) {
    if (uniforms.keptAlpha <= 0 || uniforms.contour !== edgesOnly) return null
    return [...uniforms.keptColor.map(value => value * uniforms.keptAlpha), uniforms.keptAlpha]
  }
  if (kind === EXCLUDED && !edgesOnly && uniforms.excludedAlpha > 0) {
    const alpha = uniforms.excludedAlpha
    return [table[at] / 255 * alpha, table[at + 1] / 255 * alpha, table[at + 2] / 255 * alpha, alpha]
  }
  return null
}

// Colour of a centerline point, or null if it is not drawn. The shader does the same.
export function lineColor(table, piece, code, uniforms) {
  const at = (piece >> 8) * TABLE_SIZE * 4 + (piece & 255) * 4
  const kind = table[at + 3]
  if (kind === KEPT) {
    if (!uniforms.showLines) return null
    return [...(code < 200 && uniforms.showExcluded ? uniforms.artifactColor : uniforms.lineColor), 1]
  }
  if (kind === EXCLUDED && uniforms.showExcluded) return [table[at] / 255, table[at + 1] / 255, table[at + 2] / 255, 1]
  return null
}

// ---- Software drawing, where WebGL 2 is not available ------------------------------

function createSoftwareRenderer(canvas, width, height) {
  const context = canvas.getContext('2d', { alpha: true })
  if (!context) return null
  const css = ([r, g, b, a]) => `rgba(${Math.round(r / Math.max(a, 1e-6) * 255)},${Math.round(g / Math.max(a, 1e-6) * 255)},${Math.round(b / Math.max(a, 1e-6) * 255)},${a})`
  const drawSpans = (spans, table, uniforms, options) => {
    for (let at = 0; at < spans.length; at += 4) {
      const color = spanColor(table, spans[at + 3], uniforms, options)
      if (!color) continue
      context.fillStyle = css(color)
      context.fillRect(spans[at], spans[at + 1], spans[at + 2], 1)
    }
  }
  return {
    draw({ fill, lines, table, uniforms }) {
      context.clearRect(0, 0, width, height)
      drawSpans(fill.spans, table, uniforms)
      if (uniforms.contour) drawSpans(fill.edges, table, uniforms, { edgesOnly: true })
      const size = uniforms.thickness
      const shift = Math.floor((size - 1) / 2)
      for (let at = 0; at < lines.length; at += 4) {
        const color = lineColor(table, lines[at + 2], lines[at + 3], uniforms)
        if (!color) continue
        context.fillStyle = css(color)
        context.fillRect(lines[at] - shift, lines[at + 1] - shift, size, size)
      }
    },
    clear() { context.clearRect(0, 0, width, height) },
    destroy() {},
  }
}

// ---- GPU drawing ------------------------------------------------------------------

const SPAN_VERTEX = `#version 300 es
  precision highp float;
  precision highp int;
  in uvec4 aSpan;
  uniform highp sampler2D uTable;
  uniform vec2 uSize;
  uniform vec3 uKeptColor;
  uniform float uKeptAlpha;
  uniform float uExcludedAlpha;
  flat out vec4 vColor;
  void main() {
    int piece = int(aSpan.w);
    vec4 entry = texelFetch(uTable, ivec2(piece & 255, piece >> 8), 0);
    vec4 color = vec4(0.0);
    if (entry.a > 0.75) color = vec4(uKeptColor * uKeptAlpha, uKeptAlpha);
    else if (entry.a > 0.25) color = vec4(entry.rgb * uExcludedAlpha, uExcludedAlpha);
    vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
    vec2 position = vec2(aSpan.xy) + corner * vec2(float(aSpan.z), 1.0);
    gl_Position = color.a > 0.0 ? vec4(position.x / uSize.x * 2.0 - 1.0, 1.0 - position.y / uSize.y * 2.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
    vColor = color;
  }
`

const LINE_VERTEX = `#version 300 es
  precision highp float;
  precision highp int;
  in uvec4 aPoint;
  uniform highp sampler2D uTable;
  uniform vec2 uSize;
  uniform vec3 uLineColor;
  uniform vec3 uArtifactColor;
  uniform bool uShowLines;
  uniform bool uShowExcluded;
  uniform float uThickness;
  flat out vec4 vColor;
  void main() {
    int piece = int(aPoint.z);
    vec4 entry = texelFetch(uTable, ivec2(piece & 255, piece >> 8), 0);
    vec4 color = vec4(0.0);
    if (entry.a > 0.75) {
      if (uShowLines) color = vec4(int(aPoint.w) < 200 && uShowExcluded ? uArtifactColor : uLineColor, 1.0);
    } else if (entry.a > 0.25 && uShowExcluded) {
      color = vec4(entry.rgb, 1.0);
    }
    // An even width has no centre pixel, so it sits half a pixel off.
    float offset = mod(uThickness, 2.0) == 0.0 ? 1.0 : 0.5;
    vec2 position = vec2(aPoint.xy) + vec2(offset);
    gl_Position = color.a > 0.0 ? vec4(position.x / uSize.x * 2.0 - 1.0, 1.0 - position.y / uSize.y * 2.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = uThickness;
    vColor = color;
  }
`

const FRAGMENT = `#version 300 es
  precision highp float;
  flat in vec4 vColor;
  uniform bool uRound;
  out vec4 outputColor;
  void main() {
    if (uRound && length(gl_PointCoord - vec2(0.5)) > 0.55) discard;
    outputColor = vColor;
  }
`

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'shader failed to compile'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

function program(gl, vertexSource, fragmentSource) {
  const made = gl.createProgram()
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  gl.attachShader(made, vertex)
  gl.attachShader(made, fragment)
  gl.linkProgram(made)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(made, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(made) || 'shader failed to link')
  return made
}

function createGpuRenderer(canvas, width, height) {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true })
  if (!gl) return null
  const spansProgram = program(gl, SPAN_VERTEX, FRAGMENT)
  const linesProgram = program(gl, LINE_VERTEX, FRAGMENT)
  const locate = (made, names) => Object.fromEntries(names.map(name => [name, gl.getUniformLocation(made, name)]))
  const spanUniforms = locate(spansProgram, ['uTable', 'uSize', 'uKeptColor', 'uKeptAlpha', 'uExcludedAlpha', 'uRound'])
  const lineUniforms = locate(linesProgram, ['uTable', 'uSize', 'uLineColor', 'uArtifactColor', 'uShowLines', 'uShowExcluded', 'uThickness', 'uRound'])
  const spanAttribute = gl.getAttribLocation(spansProgram, 'aSpan')
  const lineAttribute = gl.getAttribLocation(linesProgram, 'aPoint')

  gl.viewport(0, 0, width, height)
  gl.clearColor(0, 0, 0, 0)
  gl.disable(gl.BLEND)
  gl.disable(gl.DEPTH_TEST)

  const tableTexture = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tableTexture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, TABLE_SIZE, TABLE_SIZE)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)

  // Frames stay on the GPU, and a whole stack fits, so reaching any slice costs nothing.
  const buffers = new Map()
  let bufferBytes = 0
  const bufferFor = values => {
    if (!values.length) return null
    let buffer = buffers.get(values)
    if (buffer) {
      buffers.delete(values)
      buffers.set(values, buffer)
      return buffer
    }
    buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW)
    buffers.set(values, buffer)
    bufferBytes += values.byteLength
    for (const [key, old] of buffers) {
      if (bufferBytes <= GPU_BUFFER_BYTES) break
      if (key === values) continue
      gl.deleteBuffer(old)
      buffers.delete(key)
      bufferBytes -= key.byteLength
    }
    return buffer
  }
  const bind = (attribute, values, divisor) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, bufferFor(values))
    gl.enableVertexAttribArray(attribute)
    gl.vertexAttribIPointer(attribute, 4, gl.UNSIGNED_SHORT, 0, 0)
    gl.vertexAttribDivisor(attribute, divisor)
  }
  const drawSpans = (values, uniforms, keptAlpha, excludedAlpha) => {
    if (!values.length) return
    gl.useProgram(spansProgram)
    gl.uniform1i(spanUniforms.uTable, 0)
    gl.uniform2f(spanUniforms.uSize, width, height)
    gl.uniform3fv(spanUniforms.uKeptColor, uniforms.keptColor)
    gl.uniform1f(spanUniforms.uKeptAlpha, keptAlpha)
    gl.uniform1f(spanUniforms.uExcludedAlpha, excludedAlpha)
    gl.uniform1i(spanUniforms.uRound, 0)
    bind(spanAttribute, values, 1)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, values.length / 4)
  }

  return {
    draw({ fill, lines, table, uniforms }) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tableTexture)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TABLE_SIZE, TABLE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, table)
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (uniforms.contour) {
        drawSpans(fill.spans, uniforms, 0, uniforms.excludedAlpha)
        drawSpans(fill.edges, uniforms, uniforms.keptAlpha, 0)
      } else {
        drawSpans(fill.spans, uniforms, uniforms.keptAlpha, uniforms.excludedAlpha)
      }
      if (lines.length && (uniforms.showLines || uniforms.showExcluded)) {
        gl.useProgram(linesProgram)
        gl.uniform1i(lineUniforms.uTable, 0)
        gl.uniform2f(lineUniforms.uSize, width, height)
        gl.uniform3fv(lineUniforms.uLineColor, uniforms.lineColor)
        gl.uniform3fv(lineUniforms.uArtifactColor, uniforms.artifactColor)
        gl.uniform1i(lineUniforms.uShowLines, uniforms.showLines ? 1 : 0)
        gl.uniform1i(lineUniforms.uShowExcluded, uniforms.showExcluded ? 1 : 0)
        gl.uniform1f(lineUniforms.uThickness, uniforms.thickness)
        gl.uniform1i(lineUniforms.uRound, uniforms.thickness >= 4 ? 1 : 0)
        bind(lineAttribute, lines, 0)
        gl.drawArrays(gl.POINTS, 0, lines.length / 4)
      }
    },
    clear() { gl.clear(gl.COLOR_BUFFER_BIT) },
    destroy() {
      buffers.forEach(buffer => gl.deleteBuffer(buffer))
      buffers.clear()
      gl.deleteTexture(tableTexture)
      gl.deleteVertexArray(vao)
      gl.deleteProgram(spansProgram)
      gl.deleteProgram(linesProgram)
    },
  }
}

export function createOverlayRenderer(canvas, width, height) {
  return createGpuRenderer(canvas, width, height) || createSoftwareRenderer(canvas, width, height)
}
