// Minimal service worker: makes Llamble installable as an app (Chromebooks, Chrome, Edge).
// Network-first; no offline caching of chat data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
