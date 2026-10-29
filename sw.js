/* Offline cache + static-host cross-origin isolation fallback. */
const VERSION = 'local-system-v1'
const CORE = [
  './',
  './v86/libv86.js',
  './v86/vm-worker.js',
  './v86/v86.wasm',
  './v86/v86-fallback.wasm',
  './v86/seabios.bin',
  './v86/vgabios.bin',
]

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('local-system-') && key !== VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

function isolated(response) {
  const headers = new Headers(response.headers)
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: false })
  if (cached) return isolated(cached)
  const response = await fetch(request)
  if (response.ok && response.status === 200) {
    const cache = await caches.open(VERSION)
    await cache.put(request, response.clone())
  }
  return isolated(response)
}

async function networkFirst(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(VERSION)
      await cache.put(request, response.clone())
    }
    return isolated(response)
  } catch (error) {
    const cached = await caches.match(request)
    if (cached) return isolated(cached)
    const root = await caches.match('./')
    if (root) return isolated(root)
    throw error
  }
}

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  event.respondWith(request.mode === 'navigate' ? networkFirst(request) : cacheFirst(request))
})
