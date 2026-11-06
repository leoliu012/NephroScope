import { useEffect, useMemo, useRef, useState } from 'react'
import { MapPin } from 'lucide-react'

import { annotationMarkers, clusterAnnotationPins, modelSliceMarks } from '../zSliceMarkers.js'

// While dragging, the rest of the viewer is told the slice has settled only once it has.
const SETTLE_MS = 180

// The thumb and the Z number live here, so moving them re-renders nothing else. onScrub is
// called for every slice passed and should only draw; onCommit is for the settled slice.
export default function ZSliceSlider({
  zCount,
  value,
  annotations,
  modelRuns,
  onScrub,
  onCommit,
  onJumpToSlice,
}) {
  const trackRef = useRef(null)
  const settleRef = useRef(null)
  const [draft, setDraft] = useState(null)
  const [trackWidth, setTrackWidth] = useState(0)
  const innerWidth = Math.max(0, trackWidth - 16)
  const pins = useMemo(() => clusterAnnotationPins(annotationMarkers(annotations, zCount), zCount, innerWidth), [annotations, zCount, innerWidth])
  const marks = useMemo(() => modelSliceMarks(modelRuns, zCount), [modelRuns, zCount])
  const segmentedCount = marks.filter(mark => mark.state === 'segmented').length
  const runningCount = marks.length - segmentedCount
  const shown = draft ?? value

  useEffect(() => {
    const track = trackRef.current
    if (!track) return undefined
    const updateWidth = () => setTrackWidth(track.getBoundingClientRect().width)
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(track)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => {
    if (settleRef.current) window.clearTimeout(settleRef.current)
  }, [])

  const input = next => {
    setDraft(next)
    onScrub?.(next)
    if (settleRef.current) window.clearTimeout(settleRef.current)
    settleRef.current = window.setTimeout(() => {
      settleRef.current = null
      onCommit?.(next)
    }, SETTLE_MS)
  }

  const release = () => {
    if (draft === null) return
    if (settleRef.current) window.clearTimeout(settleRef.current)
    settleRef.current = null
    onCommit?.(draft)
    setDraft(null)
  }

  const left = zIndex => (zCount > 1 ? (zIndex / (zCount - 1)) * 100 : 0)
  const markSummary = [
    segmentedCount ? `${segmentedCount} segmented Z slice${segmentedCount === 1 ? '' : 's'} (green marks)` : '',
    runningCount ? `${runningCount} running (blue marks)` : '',
  ].filter(Boolean).join(' · ')

  return (
    <>
      <span>Z {shown + 1}/{zCount}</span>
      <div
        ref={trackRef}
        className={`viewer-z-slider-track${pins.length ? ' has-pins' : ''}`}
        title={markSummary || undefined}
      >
        {pins.length > 0 && (
          <div className="viewer-z-annotation-pins" aria-label="Z slices with annotations">
            {pins.map(pin => {
              const sliceText = pin.slices.length > 1
                ? `Z ${pin.slices[0] + 1}–${pin.slices.at(-1) + 1}`
                : `Z ${pin.zIndex + 1}`
              const label = `${pin.count} annotation${pin.count === 1 ? '' : 's'} on ${sliceText}. Go to Z ${pin.zIndex + 1}.`
              return (
                <button
                  key={`annotation:${pin.slices.join(',')}`}
                  type="button"
                  className={`viewer-z-annotation-pin${pin.slices.length > 1 ? ' is-cluster' : ''}`}
                  style={pin.position !== undefined ? { left: `${pin.position}px` } : { left: `${left(pin.zIndex)}%` }}
                  onClick={() => onJumpToSlice?.(pin.zIndex)}
                  title={label}
                  aria-label={label}
                >
                  <MapPin size={17} strokeWidth={2.4} aria-hidden="true" />
                  {pin.count > 1 && <span className="viewer-z-annotation-pin-count">{pin.count > 99 ? '99+' : pin.count}</span>}
                </button>
              )
            })}
          </div>
        )}
        <div className="viewer-z-slice-marks" aria-hidden="true">
          {marks.map(mark => (
            <span key={mark.zIndex} className={`viewer-z-slice-mark is-${mark.state}`} style={{ left: `${left(mark.zIndex)}%` }} />
          ))}
        </div>
        {markSummary && <span className="sr-only">{markSummary}</span>}
        <input
          type="range"
          min={0}
          max={zCount - 1}
          step={1}
          value={shown}
          onChange={event => input(Number(event.currentTarget.value))}
          onPointerUp={release}
          onKeyUp={release}
          onBlur={release}
          aria-label="Z slice"
        />
      </div>
    </>
  )
}
