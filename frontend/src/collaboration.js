import { v4 as uuidv4 } from 'uuid'
import { authFetch } from './auth.js'

const API = '/agh/api'
const CLIENT_ID_KEY = 'agh-viewer:collaboration-client-id'

export function collaborationClientId() {
  try {
    let id = sessionStorage.getItem(CLIENT_ID_KEY)
    if (!id) {
      id = uuidv4()
      sessionStorage.setItem(CLIENT_ID_KEY, id)
    }
    return id
  } catch {
    return uuidv4()
  }
}

export async function fetchCollaboration() {
  return fetchJson(`${API}/collaboration`)
}

export async function sendHeartbeat(payload) {
  return fetchJson(`${API}/collaboration/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function updateWorkspace(payload) {
  return fetchJson(`${API}/collaboration/workspace`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function fetchViewState(caseId, filename, options = {}) {
  return fetchJson(viewStateUrl(caseId, filename), options)
}

export async function updateViewState(caseId, filename, payload) {
  return fetchJson(viewStateUrl(caseId, filename), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function viewStateUrl(caseId, filename) {
  return `${API}/cases/${encodeURIComponent(caseId)}/files/${encodeURIComponent(filename)}/view-state`
}

async function fetchJson(url, options = {}) {
  const res = await authFetch(url, options)
  if (!res.ok) {
    const message = await res.text().catch(() => '')
    const error = new Error(message || `Request failed with ${res.status}`)
    error.status = res.status
    throw error
  }
  return res.json()
}
