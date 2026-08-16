import { useEffect, useMemo, useRef, useState } from 'react'
import { MapPin } from 'lucide-react'

function annotationZIndex(annotation, zCount) {
  const value = Number(annotation?.zIndex)
  // Annotations saved before Z scoping was introduced belong to the first
  // plane. This is deterministic and, importantly, stops legacy shapes from
  // appearing on every plane of a stack.
  if (!Number.isInteger(value)) return 0
  return Math.max(0, Math.min(zCount - 1, value))
}

function annotationMarkers(annotations, zCount) {
  const slices = new Map()
  for (const annotation of annotations || []) {
    const zIndex = annotationZIndex(annotation, zCount)
    slices.set(zIndex, (slices.get(zIndex) || 0) + 1)
  }
  return Array.from(slices, ([zIndex, count]) => ({ zIndex, count }))
    .sort((left, right) => left.zIndex - right.zIndex)
}

function pinWidth(count) {
  return count > 9 ? 38 : count > 1 ? 26 : 20
}

function assignPinLanes(markers, zCount, width) {
  if (!width || zCount < 2) return markers.map(marker => ({ ...marker, lane: 0 }))
  const rightEdges = []
  return markers.map(marker => {
    const center = (marker.zIndex / (zCount - 1)) * width
    const halfWidth = pinWidth(marker.count) / 2
    const left = center - halfWidth
    let lane = rightEdges.findIndex(right => left > right + 4)
    if (lane < 0) lane = rightEdges.length
    rightEdges[lane] = center + halfWidth
    return { ...marker, lane }
  })
}

export function zIndexForAnnotation(annotation, zCount) {
  return annotationZIndex(annotation, zCount)
}

export default function ZSliceSlider({
  zCount,
  value,
  annotations,
  onInput,
  onCommit,
  onJumpToSlice,
}) {
  const trackRef = useRef(null)
  const [trackWidth, setTrackWidth] = useState(0)
  const markers = useMemo(() => annotationMarkers(annotations, zCount), [annotations, zCount])
  const pinnedSlices = useMemo(() => assignPinLanes(markers, zCount, Math.max(0, trackWidth - 16)), [markers, zCount, trackWidth])
  const laneCount = pinnedSlices.length ? Math.max(...pinnedSlices.map(marker => marker.lane + 1)) : 0

  useEffect(() => {
    const track = trackRef.current
    if (!track) return undefined
    const updateWidth = () => setTrackWidth(track.getBoundingClientRect().width)
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(track)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={trackRef}
      className="viewer-z-slider-track"
      style={{ '--z-pin-lanes': laneCount }}
    >
      {pinnedSlices.length > 0 && (
        <div className="viewer-z-annotation-pins" aria-label="Annotated Z slices">
          {pinnedSlices.map(marker => {
            const position = zCount > 1 ? (marker.zIndex / (zCount - 1)) * 100 : 0
            const annotationWord = marker.count === 1 ? 'annotation' : 'annotations'
            return (
              <button
                key={marker.zIndex}
                type="button"
                className="viewer-z-annotation-pin"
                style={{ left: `${position}%`, top: `${marker.lane * 22}px` }}
                onClick={() => onJumpToSlice?.(marker.zIndex)}
                title={`${marker.count} ${annotationWord} on Z ${marker.zIndex + 1}. Go to slice.`}
                aria-label={`${marker.count} ${annotationWord} on Z ${marker.zIndex + 1}. Go to slice.`}
              >
                <MapPin size={17} strokeWidth={2.4} aria-hidden="true" />
                {marker.count > 1 && <span className="viewer-z-annotation-pin-count">{marker.count > 99 ? '99+' : marker.count}</span>}
              </button>
            )
          })}
        </div>
      )}
      <input
        type="range"
        min={0}
        max={zCount - 1}
        step={1}
        value={value}
        onInput={event => onInput?.(event.currentTarget.value)}
        onChange={event => onCommit?.(event.currentTarget.value)}
        aria-label="Z slice"
      />
    </div>
  )
}
