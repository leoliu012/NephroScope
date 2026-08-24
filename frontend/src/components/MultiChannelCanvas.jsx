import { useCallback, useEffect, useRef, useState } from 'react'
import { authFetch } from '../auth.js'
import {
  denoiseCrossSample,
  localContrastIntensity,
  webGlImagePixelGlsl,
} from '../multiChannelRendering.js'

const MAX_GPU_CHANNELS = 8
const HISTOGRAM_BINS = 128
const AUTO_HISTOGRAM_BINS = 256

function parseHexColor(value) {
  const hex = /^#[0-9a-f]{6}$/i.test(value || '') ? value.slice(1) : 'ffffff'
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  }
}

const PLATFORM_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

function decodePlane(buffer, bitsPerSample, expectedPixels) {
  if (bitsPerSample === 8) {
    if (buffer.byteLength !== expectedPixels) throw new Error('Unexpected 8-bit channel payload size')
    return new Uint8Array(buffer)
  }
  if (bitsPerSample === 16) {
    if (buffer.byteLength !== expectedPixels * 2) throw new Error('Unexpected 16-bit channel payload size')
    // The wire format is little-endian. On the (universally little-endian)
    // browser platforms this is a zero-copy view over the fetched bytes,
    // instead of copying every pixel through a DataView loop — a large win
    // on big planes, which is what dominated per-slice load time.
    if (PLATFORM_LITTLE_ENDIAN) return new Uint16Array(buffer)
    const view = new DataView(buffer)
    const values = new Uint16Array(expectedPixels)
    for (let index = 0; index < expectedPixels; index += 1) {
      values[index] = view.getUint16(index * 2, true)
    }
    return values
  }
  throw new Error(`Unsupported channel bit depth: ${bitsPerSample || 'unknown'}`)
}

const CHANNEL_PLANE_CACHE_MAX_BYTES = 512 * 1024 * 1024
const channelPlaneCache = new Map()
let channelPlaneCacheBytes = 0

// "Cache all slices" uses Cache Storage for the complete raw stack. It keeps
// the data out of the JS heap (the in-memory LRU above remains bounded) and is
// deliberately short-lived: a cached image is removed after 45 minutes with
// no viewer activity, or on the next app visit if the browser was closed.
const FULL_IMAGE_CACHE_NAME = 'agh-viewer-full-image-planes-v1'
const FULL_IMAGE_CACHE_METADATA_KEY = 'agh-viewer:full-image-plane-cache:v1'
const FULL_IMAGE_CACHE_TTL_MS = 45 * 60 * 1000
const FULL_IMAGE_CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000
let fullImageCacheMetadata = null
let fullImageCacheCleanupTimer = null

function supportsFullImageCache() {
  return typeof window !== 'undefined' && typeof window.caches?.open === 'function'
}

function loadFullImageCacheMetadata() {
  if (fullImageCacheMetadata) return fullImageCacheMetadata
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FULL_IMAGE_CACHE_METADATA_KEY) || 'null')
    fullImageCacheMetadata = { images: parsed?.images && typeof parsed.images === 'object' ? parsed.images : {} }
  } catch {
    fullImageCacheMetadata = { images: {} }
  }
  return fullImageCacheMetadata
}

function saveFullImageCacheMetadata() {
  try {
    window.localStorage.setItem(FULL_IMAGE_CACHE_METADATA_KEY, JSON.stringify(loadFullImageCacheMetadata()))
  } catch {
    // Cache Storage can still work when Local Storage is unavailable. The
    // browser's own quota policy is then the fallback cleanup mechanism.
  }
}

function absoluteCacheUrl(url) {
  return new URL(url, window.location.origin).href
}

function planeUrlPrefix(apiBase) {
  return absoluteCacheUrl(`${apiBase}/channels/`)
}

function scheduleFullImageCacheCleanup() {
  if (!supportsFullImageCache() || fullImageCacheCleanupTimer !== null) return
  fullImageCacheCleanupTimer = window.setTimeout(async () => {
    fullImageCacheCleanupTimer = null
    await cleanupExpiredFullImageCaches()
    scheduleFullImageCacheCleanup()
  }, FULL_IMAGE_CACHE_CLEANUP_INTERVAL_MS)
}

async function removeFullImageCache(imageKey, record) {
  if (!supportsFullImageCache()) return
  const metadata = loadFullImageCacheMetadata()
  delete metadata.images[imageKey]
  saveFullImageCacheMetadata()
  try {
    const cache = await window.caches.open(FULL_IMAGE_CACHE_NAME)
    const requests = await cache.keys()
    await Promise.all(requests
      .filter(request => {
        if (!request.url.startsWith(record?.planePrefix || '')) return false
        if (!record?.version) return true
        try {
          return new URL(request.url).searchParams.get('v') === String(record.version)
        } catch {
          return false
        }
      })
      .map(request => cache.delete(request)))
  } catch {
    // Storage can be cleared by the browser at any time; there is nothing
    // further to clean up in that case.
  }
}

async function cleanupExpiredFullImageCaches() {
  if (!supportsFullImageCache()) return
  const metadata = loadFullImageCacheMetadata()
  const now = Date.now()
  const expired = Object.entries(metadata.images)
    .filter(([, record]) => now - Number(record?.lastUsedAt || 0) > FULL_IMAGE_CACHE_TTL_MS)
  await Promise.all(expired.map(([imageKey, record]) => removeFullImageCache(imageKey, record)))
}

function activateFullImageCache(imageKey, apiBase, version) {
  if (!supportsFullImageCache()) return false
  const metadata = loadFullImageCacheMetadata()
  metadata.images[imageKey] = {
    ...(metadata.images[imageKey] || {}),
    planePrefix: planeUrlPrefix(apiBase),
    version: version || '',
    lastUsedAt: Date.now(),
  }
  saveFullImageCacheMetadata()
  void cleanupExpiredFullImageCaches()
  scheduleFullImageCacheCleanup()
  return true
}

function touchFullImageCache(imageKey) {
  if (!supportsFullImageCache() || !imageKey) return false
  const metadata = loadFullImageCacheMetadata()
  const record = metadata.images[imageKey]
  if (!record) return false
  if (Date.now() - Number(record.lastUsedAt || 0) > FULL_IMAGE_CACHE_TTL_MS) {
    void removeFullImageCache(imageKey, record)
    return false
  }
  // Avoid synchronous Local Storage writes for every plane during a scrub.
  if (Date.now() - Number(record.lastUsedAt || 0) > 30 * 1000) {
    record.lastUsedAt = Date.now()
    saveFullImageCacheMetadata()
  }
  scheduleFullImageCacheCleanup()
  return true
}

async function cachedFullImageResponse(url, imageKey) {
  if (!touchFullImageCache(imageKey)) return null
  try {
    const cache = await window.caches.open(FULL_IMAGE_CACHE_NAME)
    return await cache.match(absoluteCacheUrl(url)) || null
  } catch {
    return null
  }
}

async function persistFullImagePlane(url, plane, imageKey) {
  if (!touchFullImageCache(imageKey)) return false
  try {
    const body = plane.buffer.slice(plane.byteOffset, plane.byteOffset + plane.byteLength)
    const response = new Response(body, { headers: { 'Content-Type': 'application/octet-stream' } })
    const cache = await window.caches.open(FULL_IMAGE_CACHE_NAME)
    await cache.put(absoluteCacheUrl(url), response)
    return true
  } catch {
    // Quota pressure or a browser privacy policy should not make the viewer
    // fail. The normal bounded in-memory cache remains available instead.
    return false
  }
}

// Statistics are a pure function of the plane data. Cached planes are reused
// object-for-object, so memoizing by plane identity means scrubbing back to a
// visited Z reuses its histogram instead of recomputing it.
const planeStatsCache = new WeakMap()

function abortError() {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function rawChannelVersion(meta) {
  const size = meta?.sourceSize
  const mtime = meta?.sourceMtimeNs
  return size != null && mtime != null ? `${size}-${mtime}` : ''
}

function rawChannelUrl(apiBase, version, index, zIndex = 0) {
  const base = `${apiBase}/channels/${index}/raw`
  const params = new URLSearchParams()
  if (version) params.set('v', version)
  if (zIndex) params.set('z', String(zIndex))
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

function touchCachedPlane(key, entry) {
  channelPlaneCache.delete(key)
  channelPlaneCache.set(key, entry)
}

function evictCachedPlanes(protectedKey) {
  for (const [key, entry] of channelPlaneCache) {
    if (channelPlaneCacheBytes <= CHANNEL_PLANE_CACHE_MAX_BYTES) break
    if (key === protectedKey || !entry.value) continue
    channelPlaneCache.delete(key)
    channelPlaneCacheBytes -= entry.bytes
  }
}

async function loadCachedPlane(url, bitsPerSample, expectedPixels, signal, imageCacheKey = '', persistFullImage = false) {
  if (signal?.aborted) throw abortError()
  const key = `${url}|${bitsPerSample}|${expectedPixels}`
  let entry = channelPlaneCache.get(key)

  if (!entry) {
    entry = { value: null, bytes: 0, promise: null }
    entry.promise = cachedFullImageResponse(url, imageCacheKey)
      .then(async response => {
        if (response) return response
        return authFetch(url)
      })
      .then(async response => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}))
          throw new Error(body.error || 'Channel failed to load')
        }
        return decodePlane(await response.arrayBuffer(), bitsPerSample, expectedPixels)
      })
      .then(plane => {
        if (channelPlaneCache.get(key) === entry) {
          entry.value = plane
          entry.bytes = plane.byteLength
          entry.promise = null
          channelPlaneCacheBytes += entry.bytes
          touchCachedPlane(key, entry)
          evictCachedPlanes(key)
        }
        return plane
      })
      .catch(error => {
        if (channelPlaneCache.get(key) === entry) channelPlaneCache.delete(key)
        throw error
      })
    channelPlaneCache.set(key, entry)
  } else {
    touchCachedPlane(key, entry)
  }

  const plane = entry.value || await entry.promise
  if (persistFullImage && imageCacheKey) await persistFullImagePlane(url, plane, imageCacheKey)
  if (signal?.aborted) throw abortError()
  return plane
}

function fillHistograms(plane, min, max) {
  const bins = new Array(HISTOGRAM_BINS).fill(0)
  const autoBins = new Array(AUTO_HISTOGRAM_BINS).fill(0)
  const span = Math.max(1, max - min)
  const scale = HISTOGRAM_BINS - 1
  const autoScale = AUTO_HISTOGRAM_BINS - 1
  for (let index = 0; index < plane.length; index += 1) {
    const normalized = (plane[index] - min) / span
    let bucket = Math.floor(normalized * scale)
    if (bucket < 0) bucket = 0
    else if (bucket > scale) bucket = scale
    bins[bucket] += 1
    let autoBucket = Math.floor(normalized * autoScale)
    if (autoBucket < 0) autoBucket = 0
    else if (autoBucket > autoScale) autoBucket = autoScale
    autoBins[autoBucket] += 1
  }
  return { bins, autoBins }
}

export function analyzePlane(plane) {
  if (!plane?.length) {
    return {
      min: 0,
      max: 1,
      pixelCount: 0,
      histogramBins: Array.from({ length: HISTOGRAM_BINS }, () => 0),
      autoHistogramBins: Array.from({ length: AUTO_HISTOGRAM_BINS }, () => 0),
      autoHistogramMin: 0,
      autoHistogramBinSize: 1,
    }
  }

  const memoized = planeStatsCache.get(plane)
  if (memoized) return memoized

  let observedMin = Number(plane[0])
  let observedMax = Number(plane[0])
  for (let index = 1; index < plane.length; index += 1) {
    const value = Number(plane[index])
    if (value < observedMin) observedMin = value
    if (value > observedMax) observedMax = value
  }

  let min = observedMin
  let max = observedMax
  if (min === max) {
    if (max > 0) min = max - 1
    else max = min + 1
  }

  const span = Math.max(1, max - min)
  const { bins, autoBins } = fillHistograms(plane, min, max)
  const result = {
    min,
    max,
    pixelCount: plane.length,
    histogramBins: bins,
    autoHistogramBins: autoBins,
    autoHistogramMin: min,
    autoHistogramBinSize: span / Math.max(1, AUTO_HISTOGRAM_BINS - 1),
  }
  planeStatsCache.set(plane, result)
  return result
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Unknown WebGL shader compilation error'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'Unknown WebGL program link error'
    gl.deleteProgram(program)
    throw new Error(message)
  }
  return program
}

function createGpuRenderer(canvas, planes, width, height, bitsPerSample) {
  if (planes.length > MAX_GPU_CHANNELS) return null

  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: true,
  })
  if (!gl) return null

  if (width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
    throw new Error('This image exceeds the browser GPU texture-size limit')
  }
  if (planes.length > gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)) {
    throw new Error('This image exceeds the browser GPU channel-layer limit')
  }

  const vertexSource = `#version 300 es
    in vec2 aPosition;
    void main() {
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `

  const fragmentSource = `#version 300 es
    precision highp float;
    precision highp int;
    precision highp usampler2DArray;

    uniform highp usampler2DArray uPlanes;
    uniform int uChannelCount;
    uniform int uVisible[${MAX_GPU_CHANNELS}];
    uniform int uInverted[${MAX_GPU_CHANNELS}];
    uniform float uMinimum[${MAX_GPU_CHANNELS}];
    uniform float uMaximum[${MAX_GPU_CHANNELS}];
    uniform float uBrightness[${MAX_GPU_CHANNELS}];
    uniform float uContrast[${MAX_GPU_CHANNELS}];
    uniform float uSmoothing[${MAX_GPU_CHANNELS}];
    uniform float uDenoise[${MAX_GPU_CHANNELS}];
    uniform float uSharpening[${MAX_GPU_CHANNELS}];
    uniform float uLocalContrast[${MAX_GPU_CHANNELS}];
    uniform float uGamma[${MAX_GPU_CHANNELS}];
    uniform vec3 uColor[${MAX_GPU_CHANNELS}];

    out vec4 outputColor;

    void sortPair(inout float lower, inout float upper) {
      if (lower > upper) {
        float temporary = lower;
        lower = upper;
        upper = temporary;
      }
    }

    float medianOfFive(float first, float second, float third, float fourth, float fifth) {
      sortPair(first, second);
      sortPair(fourth, fifth);
      sortPair(first, third);
      sortPair(second, third);
      sortPair(first, fourth);
      sortPair(third, fourth);
      sortPair(second, fifth);
      sortPair(second, third);
      sortPair(fourth, fifth);
      return third;
    }

    void main() {
      ${webGlImagePixelGlsl(height)}
      vec3 composite = vec3(0.0);
      for (int index = 0; index < ${MAX_GPU_CHANNELS}; index += 1) {
        if (index >= uChannelCount) break;
        if (uVisible[index] == 0) continue;

        float sourceValue = float(texelFetch(uPlanes, ivec3(pixel.x, pixel.y, index), 0).r);
        float neighbourhoodMinimum = sourceValue;
        float neighbourhoodMaximum = sourceValue;
        if (
          uSmoothing[index] > 0.0
          || uDenoise[index] > 0.0
          || uSharpening[index] > 0.0
          || uLocalContrast[index] > 0.0
        ) {
          float neighbourhood = 0.0;
          for (int offsetY = -1; offsetY <= 1; offsetY += 1) {
            for (int offsetX = -1; offsetX <= 1; offsetX += 1) {
              ivec2 samplePixel = clamp(
                pixel + ivec2(offsetX, offsetY),
                ivec2(0),
                ivec2(${width - 1}, ${height - 1})
              );
              float sampleValue = float(texelFetch(uPlanes, ivec3(samplePixel.x, samplePixel.y, index), 0).r);
              neighbourhood += sampleValue;
              neighbourhoodMinimum = min(neighbourhoodMinimum, sampleValue);
              neighbourhoodMaximum = max(neighbourhoodMaximum, sampleValue);
            }
          }
          float meanValue = neighbourhood / 9.0;
          if (uDenoise[index] > 0.0) {
            ivec2 upperPixel = clamp(pixel + ivec2(0, -1), ivec2(0), ivec2(${width - 1}, ${height - 1}));
            ivec2 rightPixel = clamp(pixel + ivec2(1, 0), ivec2(0), ivec2(${width - 1}, ${height - 1}));
            ivec2 lowerPixel = clamp(pixel + ivec2(0, 1), ivec2(0), ivec2(${width - 1}, ${height - 1}));
            ivec2 leftPixel = clamp(pixel + ivec2(-1, 0), ivec2(0), ivec2(${width - 1}, ${height - 1}));
            float medianValue = medianOfFive(
              sourceValue,
              float(texelFetch(uPlanes, ivec3(upperPixel.x, upperPixel.y, index), 0).r),
              float(texelFetch(uPlanes, ivec3(rightPixel.x, rightPixel.y, index), 0).r),
              float(texelFetch(uPlanes, ivec3(lowerPixel.x, lowerPixel.y, index), 0).r),
              float(texelFetch(uPlanes, ivec3(leftPixel.x, leftPixel.y, index), 0).r)
            );
            sourceValue = mix(sourceValue, medianValue, uDenoise[index]);
          }
          float smoothedValue = mix(sourceValue, meanValue, uSmoothing[index]);
          sourceValue = smoothedValue + (uSharpening[index] * (sourceValue - meanValue));
        }
        float span = max(1.0, uMaximum[index] - uMinimum[index]);
        float intensity = clamp((sourceValue - uMinimum[index]) / span, 0.0, 1.0);
        if (uInverted[index] != 0) intensity = 1.0 - intensity;
        if (uLocalContrast[index] > 0.0 && neighbourhoodMaximum > neighbourhoodMinimum) {
          float localIntensity = clamp(
            (sourceValue - neighbourhoodMinimum) / (neighbourhoodMaximum - neighbourhoodMinimum),
            0.0,
            1.0
          );
          if (uInverted[index] != 0) localIntensity = 1.0 - localIntensity;
          intensity = mix(intensity, localIntensity, uLocalContrast[index]);
        }
        intensity = pow(intensity, 1.0 / max(0.25, uGamma[index]));
        intensity = clamp(((intensity - 0.5) * uContrast[index]) + 0.5 + uBrightness[index], 0.0, 1.0);
        composite += intensity * uColor[index];
      }
      outputColor = vec4(clamp(composite, 0.0, 1.0), 1.0);
    }
  `

  const program = createProgram(gl, vertexSource, fragmentSource)
  const vertexArray = gl.createVertexArray()
  const vertexBuffer = gl.createBuffer()
  const texture = gl.createTexture()

  gl.bindVertexArray(vertexArray)
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
    3, -1,
    -1, 3,
  ]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'aPosition')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const internalFormat = bitsPerSample === 8 ? gl.R8UI : gl.R16UI
  const sourceType = bitsPerSample === 8 ? gl.UNSIGNED_BYTE : gl.UNSIGNED_SHORT
  let currentPlanes = planes
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, internalFormat, width, height, planes.length, 0, gl.RED_INTEGER, sourceType, null)
  const uploadPlanes = nextPlanes => {
    if (!Array.isArray(nextPlanes) || nextPlanes.length !== currentPlanes.length) {
      throw new Error('Channel count changed while updating the display')
    }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture)
    nextPlanes.forEach((plane, index) => {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, index, width, height, 1, gl.RED_INTEGER, sourceType, plane)
    })
    currentPlanes = nextPlanes
  }
  uploadPlanes(planes)

  const locations = {
    planes: gl.getUniformLocation(program, 'uPlanes'),
    channelCount: gl.getUniformLocation(program, 'uChannelCount'),
    visible: gl.getUniformLocation(program, 'uVisible[0]'),
    inverted: gl.getUniformLocation(program, 'uInverted[0]'),
    minimum: gl.getUniformLocation(program, 'uMinimum[0]'),
    maximum: gl.getUniformLocation(program, 'uMaximum[0]'),
    brightness: gl.getUniformLocation(program, 'uBrightness[0]'),
    contrast: gl.getUniformLocation(program, 'uContrast[0]'),
    smoothing: gl.getUniformLocation(program, 'uSmoothing[0]'),
    denoise: gl.getUniformLocation(program, 'uDenoise[0]'),
    sharpening: gl.getUniformLocation(program, 'uSharpening[0]'),
    localContrast: gl.getUniformLocation(program, 'uLocalContrast[0]'),
    gamma: gl.getUniformLocation(program, 'uGamma[0]'),
    color: gl.getUniformLocation(program, 'uColor[0]'),
  }

  gl.useProgram(program)
  gl.uniform1i(locations.planes, 0)

  return {
    matches(nextWidth, nextHeight, nextBitsPerSample, nextChannelCount) {
      return nextWidth === width && nextHeight === height && nextBitsPerSample === bitsPerSample && nextChannelCount === currentPlanes.length
    },
    updatePlanes: uploadPlanes,
    draw(settings) {
      const visible = new Int32Array(MAX_GPU_CHANNELS)
      const inverted = new Int32Array(MAX_GPU_CHANNELS)
      const minimum = new Float32Array(MAX_GPU_CHANNELS)
      const maximum = new Float32Array(MAX_GPU_CHANNELS)
      const brightness = new Float32Array(MAX_GPU_CHANNELS)
      const contrast = new Float32Array(MAX_GPU_CHANNELS)
      const smoothing = new Float32Array(MAX_GPU_CHANNELS)
      const denoise = new Float32Array(MAX_GPU_CHANNELS)
      const sharpening = new Float32Array(MAX_GPU_CHANNELS)
      const localContrast = new Float32Array(MAX_GPU_CHANNELS)
      const gamma = new Float32Array(MAX_GPU_CHANNELS).fill(1)
      const color = new Float32Array(MAX_GPU_CHANNELS * 3)

      for (const setting of settings || []) {
        const index = Number(setting.index)
        if (!Number.isInteger(index) || index < 0 || index >= currentPlanes.length || index >= MAX_GPU_CHANNELS) continue
        const rgb = parseHexColor(setting.color)
        visible[index] = setting.visible ? 1 : 0
        inverted[index] = setting.inverted ? 1 : 0
        minimum[index] = Number(setting.min) || 0
        maximum[index] = Number(setting.max) || 1
        brightness[index] = (Number(setting.brightness) || 0) / 100
        contrast[index] = Number(setting.contrast) || 1
        smoothing[index] = setting.smoothingEnabled
          ? Math.min(1, Math.max(0, Number(setting.smoothing) || 0))
          : 0
        denoise[index] = setting.denoiseEnabled
          ? Math.min(1, Math.max(0, Number(setting.denoise) || 0))
          : 0
        sharpening[index] = setting.sharpeningEnabled
          ? Math.min(2, Math.max(0, Number(setting.sharpening) || 0))
          : 0
        localContrast[index] = setting.localContrastEnabled
          ? Math.min(1, Math.max(0, Number(setting.localContrast) || 0))
          : 0
        gamma[index] = setting.gammaEnabled
          ? Math.min(4, Math.max(0.25, Number(setting.gamma) || 1))
          : 1
        color[index * 3] = rgb.r / 255
        color[(index * 3) + 1] = rgb.g / 255
        color[(index * 3) + 2] = rgb.b / 255
      }

      gl.viewport(0, 0, width, height)
      gl.useProgram(program)
      gl.bindVertexArray(vertexArray)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture)
      gl.uniform1i(locations.channelCount, currentPlanes.length)
      gl.uniform1iv(locations.visible, visible)
      gl.uniform1iv(locations.inverted, inverted)
      gl.uniform1fv(locations.minimum, minimum)
      gl.uniform1fv(locations.maximum, maximum)
      gl.uniform1fv(locations.brightness, brightness)
      gl.uniform1fv(locations.contrast, contrast)
      gl.uniform1fv(locations.smoothing, smoothing)
      gl.uniform1fv(locations.denoise, denoise)
      gl.uniform1fv(locations.sharpening, sharpening)
      gl.uniform1fv(locations.localContrast, localContrast)
      gl.uniform1fv(locations.gamma, gamma)
      gl.uniform3fv(locations.color, color)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    destroy() {
      gl.deleteTexture(texture)
      gl.deleteBuffer(vertexBuffer)
      gl.deleteVertexArray(vertexArray)
      gl.deleteProgram(program)
    },
  }
}

function createCpuRenderer(canvas, planes, width, height) {
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('The browser could not create an image canvas')
  const image = context.createImageData(width, height)
  let currentPlanes = planes

  return {
    matches(nextWidth, nextHeight, _nextBitsPerSample, nextChannelCount) {
      return nextWidth === width && nextHeight === height && nextChannelCount === currentPlanes.length
    },
    updatePlanes(nextPlanes) {
      if (!Array.isArray(nextPlanes) || nextPlanes.length !== currentPlanes.length) {
        throw new Error('Channel count changed while updating the display')
      }
      currentPlanes = nextPlanes
    },
    draw(settings) {
      const activeChannels = (settings || [])
        .map(setting => ({
          ...setting,
          rgb: parseHexColor(setting.color),
          smoothing: setting.smoothingEnabled
            ? Math.min(1, Math.max(0, Number(setting.smoothing) || 0))
            : 0,
          denoise: setting.denoiseEnabled
            ? Math.min(1, Math.max(0, Number(setting.denoise) || 0))
            : 0,
          sharpening: setting.sharpeningEnabled
            ? Math.min(2, Math.max(0, Number(setting.sharpening) || 0))
            : 0,
          localContrast: setting.localContrastEnabled
            ? Math.min(1, Math.max(0, Number(setting.localContrast) || 0))
            : 0,
          gamma: setting.gammaEnabled
            ? Math.min(4, Math.max(0.25, Number(setting.gamma) || 1))
            : 1,
        }))
        .filter(setting => setting.visible)
      const output = image.data
      const pixels = width * height

      for (let pixel = 0; pixel < pixels; pixel += 1) {
        let red = 0
        let green = 0
        let blue = 0

        for (const channel of activeChannels) {
          const plane = currentPlanes[channel.index]
          if (!plane) continue
          const span = Math.max(1, channel.max - channel.min)
          const sourceValue = plane[pixel]
          let filteredValue = sourceValue
          let neighbourhoodMinimum = sourceValue
          let neighbourhoodMaximum = sourceValue
          if (
            channel.smoothing > 0
            || channel.denoise > 0
            || channel.sharpening > 0
            || channel.localContrast > 0
          ) {
            const x = pixel % width
            const y = Math.floor(pixel / width)
            const left = Math.max(0, x - 1)
            const right = Math.min(width - 1, x + 1)
            const upperRow = Math.max(0, y - 1) * width
            const middleRow = y * width
            const lowerRow = Math.min(height - 1, y + 1) * width
            const upperLeft = plane[upperRow + left]
            const upper = plane[upperRow + x]
            const upperRight = plane[upperRow + right]
            const middleLeft = plane[middleRow + left]
            const middleRight = plane[middleRow + right]
            const lowerLeft = plane[lowerRow + left]
            const lower = plane[lowerRow + x]
            const lowerRight = plane[lowerRow + right]
            const meanValue = (
              upperLeft + upper + upperRight
              + middleLeft + sourceValue + middleRight
              + lowerLeft + lower + lowerRight
            ) / 9
            neighbourhoodMinimum = Math.min(
              upperLeft, upper, upperRight,
              middleLeft, sourceValue, middleRight,
              lowerLeft, lower, lowerRight,
            )
            neighbourhoodMaximum = Math.max(
              upperLeft, upper, upperRight,
              middleLeft, sourceValue, middleRight,
              lowerLeft, lower, lowerRight,
            )
            if (channel.denoise > 0) {
              filteredValue = denoiseCrossSample(
                sourceValue,
                upper,
                middleRight,
                lower,
                middleLeft,
                channel.denoise,
              )
            }
            const smoothedValue = filteredValue + ((meanValue - filteredValue) * channel.smoothing)
            filteredValue = smoothedValue + ((filteredValue - meanValue) * channel.sharpening)
          }
          let intensity = Math.min(1, Math.max(0, (filteredValue - channel.min) / span))
          if (channel.inverted) intensity = 1 - intensity
          if (channel.localContrast > 0) {
            intensity = localContrastIntensity(
              intensity,
              filteredValue,
              neighbourhoodMinimum,
              neighbourhoodMaximum,
              channel.inverted,
              channel.localContrast,
            )
          }
          intensity = Math.pow(intensity, 1 / channel.gamma)
          intensity = Math.min(1, Math.max(0, ((intensity - 0.5) * channel.contrast) + 0.5 + (channel.brightness / 100)))
          red += intensity * channel.rgb.r
          green += intensity * channel.rgb.g
          blue += intensity * channel.rgb.b
        }

        const offset = pixel * 4
        output[offset] = Math.min(255, red)
        output[offset + 1] = Math.min(255, green)
        output[offset + 2] = Math.min(255, blue)
        output[offset + 3] = 255
      }

      context.putImageData(image, 0, 0)
    },
    destroy() {},
  }
}

function createRenderer(canvas, planes, width, height, bitsPerSample) {
  const gpuRenderer = createGpuRenderer(canvas, planes, width, height, bitsPerSample)
  return gpuRenderer || createCpuRenderer(canvas, planes, width, height)
}

export default function MultiChannelCanvas({
  apiBase,
  meta,
  settings,
  canvasRef,
  onLoad,
  onError,
  onChannelStats,
  onLoadState,
  cacheAllRequest = 0,
  onCacheProgress,
  zIndex = 0,
  zCount = 1,
  prefetchAllZ = false,
  className = '',
  canvasClassName = '',
  loadingLabel = 'Loading channels...',
}) {
  const internalRef = useRef(null)
  const rendererRef = useRef(null)
  const settingsRef = useRef(settings || [])
  const frameRef = useRef(null)
  const loadSeqRef = useRef(0)
  const previousZRef = useRef(zIndex)
  const currentZRef = useRef(zIndex)
  const displayedZRef = useRef(null)
  const statsTaskRef = useRef(null)
  const renderPendingRef = useRef(null)
  const fullImageCacheActiveRef = useRef(false)
  const [planes, setPlanes] = useState(null)
  const [loading, setLoading] = useState(false)

  const width = Number(meta?.width) || 0
  const height = Number(meta?.height) || 0
  const channelCount = Math.max(1, Number(meta?.channelCount) || 1)
  const bitsPerSample = Number(meta?.channelBitsPerSample || meta?.bitsPerSample)
  const channelVersion = rawChannelVersion(meta)
  const stackDepth = Math.max(1, Number(zCount) || 1)
  const fullImageCacheKey = `${apiBase}|${channelVersion}`

  const scheduleRender = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      rendererRef.current?.draw(settingsRef.current)
    })
  }, [])

  useEffect(() => {
    settingsRef.current = settings || []
    scheduleRender()
  }, [settings, scheduleRender])

  useEffect(() => {
    void cleanupExpiredFullImageCaches()
    scheduleFullImageCacheCleanup()
  }, [])

  useEffect(() => {
    currentZRef.current = zIndex
  }, [zIndex])

  useEffect(() => {
    setPlanes(null)
  }, [apiBase, width, height, channelCount, bitsPerSample, channelVersion])

  useEffect(() => {
    if (!apiBase || !width || !height) return undefined
    const controller = new AbortController()
    let prefetchCancelled = false
    if (statsTaskRef.current) {
      const cancel = statsTaskRef.current
      if (cancel.kind === 'idle') window.cancelIdleCallback?.(cancel.id)
      else window.clearTimeout(cancel.id)
      statsTaskRef.current = null
    }
    const loadSeq = loadSeqRef.current + 1
    loadSeqRef.current = loadSeq
    const expectedPixels = width * height
    const previousZ = previousZRef.current
    const direction = zIndex === previousZ ? 1 : Math.sign(zIndex - previousZ)
    previousZRef.current = zIndex
    setLoading(true)
    onLoadState?.({
      status: 'loading',
      requestedZIndex: zIndex,
      displayedZIndex: displayedZRef.current,
      loadedChannels: 0,
      channelCount,
    })

    let loadedChannels = 0

    Promise.all(Array.from({ length: channelCount }, (_, index) => (
      loadCachedPlane(
        rawChannelUrl(apiBase, channelVersion, index, zIndex),
        bitsPerSample,
        expectedPixels,
        controller.signal,
        fullImageCacheKey,
      ).then(plane => {
        loadedChannels += 1
        if (loadSeq === loadSeqRef.current) {
          onLoadState?.({
            status: 'loading',
            requestedZIndex: zIndex,
            displayedZIndex: displayedZRef.current,
            loadedChannels,
            channelCount,
          })
        }
        return plane
      })
    )))
      .then(nextPlanes => {
        if (loadSeq !== loadSeqRef.current) return
        renderPendingRef.current = { loadSeq, zIndex, channelCount }
        setPlanes(nextPlanes)
        onLoadState?.({
          status: 'rendering',
          requestedZIndex: zIndex,
          displayedZIndex: displayedZRef.current,
          loadedChannels: channelCount,
          channelCount,
        })

        const forward = direction >= 0 ? 1 : -1
        const nearbySlices = [
          zIndex + forward,
          zIndex + (2 * forward),
          zIndex - forward,
          zIndex + (3 * forward),
          zIndex - (2 * forward),
          zIndex + (4 * forward),
        ]
          .filter(nextZ => nextZ >= 0 && nextZ < stackDepth)
        // Warm neighbours one complete slice at a time. The previous version
        // launched every neighbouring slice together, which could compete
        // with the next foreground request on large TIFF/ND2 files.
        const warmNearbySlices = async () => {
          for (const nextZ of nearbySlices) {
            if (prefetchCancelled || fullImageCacheActiveRef.current) return
            await Promise.all(Array.from({ length: channelCount }, (_, index) => (
              loadCachedPlane(
                rawChannelUrl(apiBase, channelVersion, index, nextZ),
                bitsPerSample,
                expectedPixels,
                undefined,
                fullImageCacheKey,
              ).catch(() => {})
            )))
          }
        }
        void warmNearbySlices()
      })
      .catch(error => {
        if (error.name === 'AbortError') return
        if (loadSeq !== loadSeqRef.current) return
        setLoading(false)
        onLoadState?.({
          status: 'error',
          requestedZIndex: zIndex,
          displayedZIndex: displayedZRef.current,
          loadedChannels,
          channelCount,
          error: error.message,
        })
        onError?.(error.message)
      })

    return () => {
      prefetchCancelled = true
      controller.abort()
    }
  }, [apiBase, width, height, channelCount, bitsPerSample, channelVersion, zIndex, stackDepth, fullImageCacheKey, onLoad, onError, onChannelStats, onLoadState])

  // Optional: warm the entire Z stack in the background (bounded concurrency,
  // nearest-first) so scrubbing the slider renders every slice from cache
  // instead of aborting each mid-load. Keyed on image identity, not zIndex, so
  // it runs once per image and is cancelled when the image changes/unmounts.
  useEffect(() => {
    if (!prefetchAllZ || !apiBase || !width || !height || stackDepth <= 1) return undefined
    const expectedPixels = width * height
    const center = Math.max(0, Math.min(stackDepth - 1, previousZRef.current || 0))
    const order = []
    for (let distance = 0; distance < stackDepth; distance += 1) {
      if (center + distance < stackDepth) order.push(center + distance)
      if (distance > 0 && center - distance >= 0) order.push(center - distance)
    }

    let cancelled = false
    let cursor = 0
    const CONCURRENCY = 3
    const warmNext = () => {
      if (cancelled || cursor >= order.length) return
      const z = order[cursor]
      cursor += 1
      Promise.all(Array.from({ length: channelCount }, (_, index) => (
        loadCachedPlane(rawChannelUrl(apiBase, channelVersion, index, z), bitsPerSample, expectedPixels, undefined, fullImageCacheKey).catch(() => {})
      ))).then(() => { if (!cancelled) warmNext() })
    }
    for (let worker = 0; worker < Math.min(CONCURRENCY, order.length); worker += 1) warmNext()

    return () => { cancelled = true }
  }, [apiBase, width, height, channelCount, bitsPerSample, channelVersion, stackDepth, prefetchAllZ, fullImageCacheKey])

  useEffect(() => {
    if (!cacheAllRequest || !apiBase || !width || !height || stackDepth <= 1) return undefined
    let cancelled = false
    let cursor = 0
    let completedPlanes = 0
    const totalPlanes = stackDepth * channelCount
    const startedAt = performance.now()
    const persistent = activateFullImageCache(fullImageCacheKey, apiBase, channelVersion)
    fullImageCacheActiveRef.current = true

    const order = []
    const center = Math.max(0, Math.min(stackDepth - 1, currentZRef.current))
    for (let distance = 0; distance < stackDepth; distance += 1) {
      if (center + distance < stackDepth) order.push(center + distance)
      if (distance > 0 && center - distance >= 0) order.push(center - distance)
    }

    const report = (status, error = '') => {
      if (cancelled) return
      const elapsedMs = performance.now() - startedAt
      const etaMs = completedPlanes > 0 && completedPlanes < totalPlanes
        ? Math.max(0, (elapsedMs / completedPlanes) * (totalPlanes - completedPlanes))
        : 0
      onCacheProgress?.({
        status,
        completedPlanes,
        totalPlanes,
        completedSlices: Math.floor(completedPlanes / channelCount),
        totalSlices: stackDepth,
        elapsedMs,
        etaMs,
        persistent,
        error,
      })
    }

    report('caching')
    const expectedPixels = width * height
    const worker = async () => {
      while (!cancelled && cursor < order.length) {
        const nextZ = order[cursor]
        cursor += 1
        await Promise.all(Array.from({ length: channelCount }, (_, index) => (
          loadCachedPlane(
            rawChannelUrl(apiBase, channelVersion, index, nextZ),
            bitsPerSample,
            expectedPixels,
            undefined,
            fullImageCacheKey,
            true,
          ).then(plane => {
            completedPlanes += 1
            report('caching')
            return plane
          })
        )))
      }
    }

    // Two slices at a time fills local storage quickly without monopolizing
    // the browser's connection pool when the user resumes viewing.
    Promise.all([worker(), worker()])
      .then(() => {
        if (!cancelled) report('cached')
      })
      .catch(error => {
        if (!cancelled) report('error', error.message || 'Unable to cache every slice')
      })
      .finally(() => { fullImageCacheActiveRef.current = false })

    return () => {
      cancelled = true
      fullImageCacheActiveRef.current = false
    }
  }, [apiBase, width, height, channelCount, bitsPerSample, channelVersion, stackDepth, fullImageCacheKey, cacheAllRequest, onCacheProgress])

  useEffect(() => {
    if (!planes || !width || !height || !internalRef.current) return undefined
    const canvas = internalRef.current
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    try {
      const previousRenderer = rendererRef.current
      if (previousRenderer?.matches(width, height, bitsPerSample, planes.length)) {
        previousRenderer.updatePlanes(planes)
        previousRenderer.draw(settingsRef.current)
      } else {
        const nextRenderer = createRenderer(canvas, planes, width, height, bitsPerSample)
        rendererRef.current = nextRenderer
        nextRenderer.draw(settingsRef.current)
        previousRenderer?.destroy()
      }

      const completed = renderPendingRef.current
      if (completed) {
        renderPendingRef.current = null
        if (completed.loadSeq === loadSeqRef.current) {
          displayedZRef.current = completed.zIndex
          setLoading(false)
          onLoadState?.({
            status: 'ready',
            requestedZIndex: completed.zIndex,
            displayedZIndex: completed.zIndex,
            loadedChannels: completed.channelCount,
            channelCount: completed.channelCount,
          })
          onLoad?.({ zIndex: completed.zIndex })

          // Histogram generation touches every source pixel more than once.
          // Schedule it only after the new texture has been drawn.
          const computeStats = () => {
            statsTaskRef.current = null
            if (completed.loadSeq !== loadSeqRef.current) return
            onChannelStats?.(planes.map(analyzePlane))
          }
          if (typeof window.requestIdleCallback === 'function') {
            statsTaskRef.current = { kind: 'idle', id: window.requestIdleCallback(computeStats, { timeout: 600 }) }
          } else {
            statsTaskRef.current = { kind: 'timeout', id: window.setTimeout(computeStats, 0) }
          }
        }
      }
    } catch (error) {
      const pending = renderPendingRef.current
      renderPendingRef.current = null
      if (pending?.loadSeq === loadSeqRef.current) {
        setLoading(false)
        onLoadState?.({
          status: 'error',
          requestedZIndex: pending.zIndex,
          displayedZIndex: displayedZRef.current,
          loadedChannels: pending.channelCount,
          channelCount: pending.channelCount,
          error: error.message,
        })
      }
      onError?.(`Unable to initialize real-time channel display: ${error.message}`)
    }
    return undefined
  }, [planes, width, height, bitsPerSample, onError, onLoad, onChannelStats, onLoadState])

  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    rendererRef.current?.destroy()
    rendererRef.current = null
    if (statsTaskRef.current) {
      const cancel = statsTaskRef.current
      if (cancel.kind === 'idle') window.cancelIdleCallback?.(cancel.id)
      else window.clearTimeout(cancel.id)
      statsTaskRef.current = null
    }
  }, [apiBase, width, height, bitsPerSample, channelVersion])

  const attachRef = useCallback(node => {
    internalRef.current = node
    if (typeof canvasRef === 'function') canvasRef(node)
    else if (canvasRef) canvasRef.current = node
  }, [canvasRef])

  return (
    <div className={`relative ${className}`.trim()}>
      <canvas
        ref={attachRef}
        width={width}
        height={height}
        aria-label="Multi-channel microscopy display"
        className={`block select-none ${canvasClassName}`.trim()}
      />
      {loadingLabel && loading && (
        <div className={planes ? 'absolute left-3 top-3 z-10 flex items-center gap-2 rounded-md bg-black/75 px-3 py-2 text-xs text-white shadow-lg' : 'absolute inset-0 z-10 flex items-center justify-center bg-black/60 text-sm text-[var(--text-muted)]'} role="status" aria-live="polite">
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white" aria-hidden="true" />
          <span>
            {loadingLabel} Z {zIndex + 1}/{stackDepth}
            {planes && displayedZRef.current !== null && displayedZRef.current !== zIndex && ` (showing Z ${displayedZRef.current + 1})`}
          </span>
        </div>
      )}
    </div>
  )
}
