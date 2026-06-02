const API = '/agh/api'

function artifactUrl(runId, artifactPath) {
  const encodedPath = String(artifactPath).split('/').map(encodeURIComponent).join('/')
  return `${API}/analysis-runs/${encodeURIComponent(runId)}/artifacts/${encodedPath}`
}

function isRemovedDapiArtifact(name) {
  const basename = String(name).split('/').pop()
  return basename === 'overlay_DAPI.png' || basename === 'overlay_NHS_NUCLEI.png'
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
        return (
          <img
            key={name}
            src={artifactUrl(run.runId, name)}
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
