export const API = '/agh/api'

export async function fetchJson(url, options = {}) {
  const res = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
  return body
}

export function artifactUrl(runId, artifactPath) {
  const encodedPath = String(artifactPath).split('/').map(encodeURIComponent).join('/')
  return `${API}/analysis-runs/${encodeURIComponent(runId)}/artifacts/${encodedPath}`
}
