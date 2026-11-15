// Builds the 3D model's surface off the main thread.
import { buildSurface } from './gbmVolume.js'

self.onmessage = ({ data: { id, volume } }) => {
  try {
    const surface = buildSurface(volume)
    self.postMessage({ id, surface }, [
      surface.positions.buffer, surface.normals.buffer, surface.classes.buffer, surface.indices.buffer,
    ])
  } catch (error) {
    self.postMessage({ id, error: error.message || 'Unable to build the 3D model' })
  }
}
