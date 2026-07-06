// Minimal service worker — presence + a fetch handler makes the app installable
// as a PWA. It intentionally does NOT cache responses (Next.js assets are
// content-hashed and a naive cache would serve stale builds); it just passes
// requests through to the network.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => { /* network passthrough */ })
