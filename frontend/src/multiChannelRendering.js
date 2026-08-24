function imageHeight(value) {
  const height = Number(value)
  if (!Number.isInteger(height) || height < 1) {
    throw new RangeError('Image height must be a positive integer')
  }
  return height
}

function postProcessingAmount(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0
}

export function medianOfFive(first, second, third, fourth, fifth) {
  let a = Number(first)
  let b = Number(second)
  let c = Number(third)
  let d = Number(fourth)
  let e = Number(fifth)
  let temporary

  if (a > b) { temporary = a; a = b; b = temporary }
  if (d > e) { temporary = d; d = e; e = temporary }
  if (a > c) { temporary = a; a = c; c = temporary }
  if (b > c) { temporary = b; b = c; c = temporary }
  if (a > d) { temporary = a; a = d; d = temporary }
  if (c > d) { temporary = c; c = d; d = temporary }
  if (b > e) { temporary = b; b = e; e = temporary }
  if (b > c) { temporary = b; b = c; c = temporary }
  if (d > e) { temporary = d; d = e; e = temporary }
  return c
}

export function denoiseCrossSample(center, upper, right, lower, left, amount) {
  const mixAmount = postProcessingAmount(amount)
  const median = medianOfFive(center, upper, right, lower, left)
  return Number(center) + ((median - Number(center)) * mixAmount)
}

export function localContrastIntensity(intensity, sample, localMinimum, localMaximum, inverted, amount) {
  const baseIntensity = Math.min(1, Math.max(0, Number(intensity)))
  const range = Number(localMaximum) - Number(localMinimum)
  if (!Number.isFinite(range) || range <= 0) return baseIntensity

  let localIntensity = Math.min(1, Math.max(0, (Number(sample) - Number(localMinimum)) / range))
  if (inverted) localIntensity = 1 - localIntensity
  return Math.min(1, Math.max(0,
    baseIntensity + ((localIntensity - baseIntensity) * postProcessingAmount(amount)),
  ))
}

export function webGlImagePixelGlsl(height) {
  const rows = imageHeight(height)
  return `ivec2 pixel = ivec2(gl_FragCoord.xy);
      pixel.y = ${rows} - 1 - pixel.y;`
}

export function webGlSourceRowForFragment(fragmentY, height) {
  const rows = imageHeight(height)
  const coordinate = Number(fragmentY)
  if (!Number.isFinite(coordinate)) throw new RangeError('Fragment Y must be finite')
  return rows - 1 - Math.trunc(coordinate)
}
