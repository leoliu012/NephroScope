// Markers shown on the viewer's Z slider: annotation pins and segmented slices.
const PIN_SPACING = 24

export function annotationZIndex(annotation, zCount) {
  const value = Number(annotation?.zIndex)
  // Annotations saved before Z scoping was introduced belong to the first
  // plane. This is deterministic and, importantly, stops legacy shapes from
  // appearing on every plane of a stack.
  if (!Number.isInteger(value)) return 0
  return Math.max(0, Math.min(zCount - 1, value))
}

export function annotationMarkers(annotations, zCount) {
  const slices = new Map()
  for (const annotation of annotations || []) {
    const zIndex = annotationZIndex(annotation, zCount)
    slices.set(zIndex, (slices.get(zIndex) || 0) + 1)
  }
  return Array.from(slices, ([zIndex, count]) => ({ zIndex, count }))
    .sort((left, right) => left.zIndex - right.zIndex)
}

export function modelSliceMarks(modelRuns, zCount) {
  const marks = new Map()
  for (const [zKey, run] of Object.entries(modelRuns || {})) {
    const zIndex = Number(run?.requestedZIndex ?? run?.request?.zIndex ?? zKey)
    if (!Number.isInteger(zIndex) || zIndex < 0 || zIndex >= zCount) continue
    const status = String(run?.status || '').toUpperCase()
    if (status === 'SUBMITTING' || status === 'QUEUED' || status === 'RUNNING') marks.set(zIndex, 'running')
    else if (status === 'SUCCEEDED' && marks.get(zIndex) !== 'running') marks.set(zIndex, 'segmented')
  }
  return [...marks].map(([zIndex, state]) => ({ zIndex, state })).sort((a, b) => a.zIndex - b.zIndex)
}

// Neighbouring annotation pins that would overlap become one pin with the
// combined count, so the slider keeps a single row of pins.
export function clusterAnnotationPins(markers, zCount, width, spacing = PIN_SPACING) {
  if (zCount < 2 || !width) return markers.map(marker => ({ zIndex: marker.zIndex, slices: [marker.zIndex], count: marker.count }))
  const clusters = []
  for (const marker of markers) {
    const position = marker.zIndex / (zCount - 1) * width
    const last = clusters.at(-1)
    if (last && position - last.start < spacing) {
      last.slices.push(marker.zIndex)
      last.count += marker.count
      last.end = position
    } else {
      clusters.push({ start: position, end: position, slices: [marker.zIndex], count: marker.count })
    }
  }
  return clusters.map(cluster => ({
    zIndex: cluster.slices[0],
    position: (cluster.start + cluster.end) / 2,
    slices: cluster.slices,
    count: cluster.count,
  }))
}

export function zIndexForAnnotation(annotation, zCount) {
  return annotationZIndex(annotation, zCount)
}
