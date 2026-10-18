// NephroScope network helper.
//
// Some deployments reach the app through a proxy (for example Tailscale
// serve in front of the Vite dev server) that drops requests with an empty
// 502 when too many arrive at once. A single dropped module leaves the page
// blank, so this worker limits parallel downloads of the app's own files and
// retries the ones a proxy dropped. It never caches anything.
const RETRY_STATUSES = new Set([502, 503, 504])
const MAX_ATTEMPTS = 4
const MAX_PARALLEL_FILES = 6

let active = 0
const waiting = []

function acquire() {
  if (active < MAX_PARALLEL_FILES) {
    active++
    return Promise.resolve()
  }
  return new Promise(resolve => waiting.push(resolve))
}

function release() {
  const next = waiting.shift()
  if (next) next()
  else active--
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fetchWithRetry(request, { limit, retryNetworkErrors, retryStatuses }) {
  for (let attempt = 1; ; attempt++) {
    if (limit) await acquire()
    let response
    try {
      response = await fetch(request.clone())
    } catch (error) {
      if (limit) release()
      if (!retryNetworkErrors || attempt >= MAX_ATTEMPTS || request.signal?.aborted) throw error
      await delay(250 * 2 ** attempt)
      continue
    }
    if (limit) release()
    if (!retryStatuses.has(response.status) || attempt >= MAX_ATTEMPTS) return response
    await delay(250 * 2 ** attempt)
  }
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET' && request.method !== 'HEAD') return
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return
  const url = new URL(request.url)
  const scope = new URL(self.registration.scope)
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return
  if (request.headers.get('upgrade')) return
  const api = url.pathname.startsWith(`${scope.pathname}api/`)
  // Vite answers 504 for an outdated pre-bundled dependency and then reloads
  // the page itself; retrying that response would only delay the reload.
  const viteDeps = url.pathname.includes('/node_modules/.vite/')
  event.respondWith(fetchWithRetry(request, {
    limit: !api,
    retryNetworkErrors: !api,
    retryStatuses: viteDeps ? new Set([502, 503]) : RETRY_STATUSES,
  }))
})
