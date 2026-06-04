import { artifactUrl } from './analysis/analysisApi.js'

function isRemovedDapiArtifact(name) {
  const basename = String(name).split('/').pop()
  return basename === 'overlay_DAPI.png' || basename === 'overlay_NHS_NUCLEI.png'
}

function processArtifactFor(name, processMetric) {
  const basename = String(name).split('/').pop()
  const preview = processMetric?.areaPreview
  if (basename === 'overlay_ACTN4.png') return preview?.includedMaskOverlay || processMetric?.includedProcessOverlay
  if (basename === 'proc_outer_contours.png') return preview?.includedOuterOverlay
  if (basename === 'proc_included_contours.png') return preview?.includedOverlay
  if (basename === 'proc_excluded_contours.png') return preview?.excludedOverlay
  return null
}

export default function AnalysisMaskCanvas({ run, visibleOverlays, processMetric, imgMeta }) {
  if (!run?.runId || !run?.result || !imgMeta) return null

  const overlays = [
    ...(run.result.overlays || []),
    ...(processMetric?.contourOverlays || []),
  ].filter(name => !isRemovedDapiArtifact(name))

  return (
    <div
      style={{ position: 'absolute', inset: 0, width: imgMeta.width, height: imgMeta.height, pointerEvents: 'none' }}
      aria-hidden="true"
    >
      {overlays.map(name => {
        const state = visibleOverlays[name]
        if (state === false) return null
        const opacity = typeof state === 'number' ? state : 1
        const processArtifact = processArtifactFor(name, processMetric)
        const artifact = processArtifact || name
        const revision = processMetric?.areaPreview && processArtifact ? processMetric.areaPreview.previewRevision : null
        return (
          <img
            key={`${name}:${artifact}:${revision || ''}`}
            src={artifactUrl(run.runId, artifact, revision)}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: imgMeta.width,
              height: imgMeta.height,
              imageRendering: 'pixelated',
              pointerEvents: 'none',
              opacity,
            }}
          />
        )
      })}
    </div>
  )
}
