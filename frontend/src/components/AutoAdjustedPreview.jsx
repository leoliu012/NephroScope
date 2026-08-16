import { useEffect, useRef, useState } from 'react'
import MultiChannelCanvas from './MultiChannelCanvas.jsx'
import { autoWindowChannelSettings } from '../channelDisplay.js'

export default function AutoAdjustedPreview({ apiBase, meta, channelSettings, onError }) {
  const [loading, setLoading] = useState(true)
  const [displaySettings, setDisplaySettings] = useState(channelSettings)
  const autoWindowAppliedRef = useRef(false)
  const imageKey = `${apiBase || ''}:${meta?.sourceSize || ''}:${meta?.sourceMtimeNs || ''}`

  useEffect(() => {
    setLoading(true)
    autoWindowAppliedRef.current = false
  }, [imageKey])

  useEffect(() => {
    setDisplaySettings(channelSettings)
    autoWindowAppliedRef.current = false
  }, [channelSettings])

  const handleChannelStats = stats => {
    if (!meta || !displaySettings || autoWindowAppliedRef.current) return
    autoWindowAppliedRef.current = true
    setDisplaySettings(current => autoWindowChannelSettings(current, stats, meta, { onlyUninitialized: true }))
  }

  if (!meta?.width || !meta?.height) return null

  return (
    <div className="preview-auto-canvas">
      {displaySettings && (
        <MultiChannelCanvas
          apiBase={apiBase}
          meta={meta}
          settings={displaySettings}
          className="preview-auto-render"
          canvasClassName="preview-auto-canvas-element"
          loadingLabel={null}
          onLoad={() => setLoading(false)}
          onError={message => {
            setLoading(false)
            onError?.(message || 'Preview failed to load')
          }}
          onChannelStats={handleChannelStats}
        />
      )}
      {loading && <div className="preview-auto-loading">Loading preview...</div>}
    </div>
  )
}
