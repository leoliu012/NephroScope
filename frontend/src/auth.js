// Session handling for the AGH Viewer SPA.
//
// The server issues an HttpOnly, SameSite=Strict session cookie at login, so
// the browser attaches it automatically and JavaScript can neither read nor
// exfiltrate it. The password is sent once, at login, and is never stored on
// the client. CSRF protection uses a synchronizer token: the server returns a
// per-session token in JSON (from /login and /session) which we keep in memory
// and echo in the X-AGH-CSRF header on every state-changing request.

const API = '/agh/api'
const CSRF_HEADER = 'X-AGH-CSRF'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

let csrfToken = ''
let currentUserName = ''
let currentUserRole = ''
let currentUserFirstName = ''
let currentUserLastName = ''
let currentUserDisplayName = ''

export function currentUser() {
  return currentUserName
}

export function currentRole() {
  return currentUserRole
}

export function currentProfile() {
  return {
    firstName: currentUserFirstName,
    lastName: currentUserLastName,
    displayName: currentUserDisplayName || currentUserName,
  }
}

export function rememberProfile(profile = {}) {
  currentUserFirstName = profile.firstName || ''
  currentUserLastName = profile.lastName || ''
  currentUserDisplayName = profile.displayName || [currentUserFirstName, currentUserLastName].filter(Boolean).join(' ') || currentUserName
}

function rememberSession(user, role, token, profile = {}) {
  currentUserName = user || ''
  currentUserRole = role || ''
  csrfToken = token || ''
  rememberProfile(profile)
}

function forgetSession() {
  currentUserName = ''
  currentUserRole = ''
  currentUserFirstName = ''
  currentUserLastName = ''
  currentUserDisplayName = ''
  csrfToken = ''
}

// Check the current session (validates the cookie server-side). Returns
// { authenticated, user }.
export async function fetchSession() {
  try {
    const res = await fetch(`${API}/session`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      forgetSession()
      return { authenticated: false, user: '', role: '' }
    }
    const body = await res.json().catch(() => ({}))
    if (body.authenticated) {
      rememberSession(body.user, body.role, body.csrfToken, body)
      return { authenticated: true, user: body.user || '', role: body.role || '', firstName: body.firstName || '', lastName: body.lastName || '', displayName: body.displayName || '' }
    }
    forgetSession()
    return { authenticated: false, user: '', role: '' }
  } catch (err) {
    forgetSession()
    return { authenticated: false, user: '', role: '' }
  }
}

// Exchange credentials for a session. Throws an Error (with .status) on failure.
export async function login(username, password) {
  const res = await fetch(`${API}/login`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(body.error || `Sign in failed (${res.status})`)
    error.status = res.status
    error.retryAfter = body.retryAfter
    throw error
  }
  rememberSession(body.user, body.role, body.csrfToken, body)
  return { user: body.user || '', role: body.role || '', firstName: body.firstName || '', lastName: body.lastName || '', displayName: body.displayName || '' }
}

// End the current session server-side and clear local state.
export async function logout() {
  try {
    await fetch(`${API}/logout`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
  } catch (err) {
    // Best effort: even if the network call fails, drop local state below.
  }
  forgetSession()
}

// fetch() wrapper that sends the session cookie and, for unsafe methods, the
// CSRF token. Used for every API call in the app.
export function authFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const headers = new Headers(options.headers || {})
  const needsCsrf = !SAFE_METHODS.has(method) && !headers.has(CSRF_HEADER)

  const send = () => fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers,
  })

  if (!needsCsrf) return send()

  const withFreshToken = async (retryOnForbidden = true) => {
    if (!csrfToken) await fetchSession()
    if (csrfToken) headers.set(CSRF_HEADER, csrfToken)
    const response = await send()
    if (response.status !== 403 || !retryOnForbidden) return response

    const clone = response.clone()
    const body = await clone.json().catch(() => ({}))
    const message = String(body.error || '').toLowerCase()
    if (!message.includes('csrf')) return response

    await fetchSession()
    if (csrfToken) headers.set(CSRF_HEADER, csrfToken)
    return send()
  }

  return withFreshToken()
}
