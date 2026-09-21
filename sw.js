// NEW: minimal service worker — required by Chrome/Android for the "install app" (PWA) prompt
// to appear at all. Keeps a small offline cache of the app shell so it also opens (showing the
// last-loaded version) even with no network.
const CACHE_NAME = 'toyota-navi-shell-v1';
const SHELL_FILES = ['./', './index.html', './style.css', './script.js', './manifest.json'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    // Network-first for everything (so live map/route data is never served stale), falling back
    // to the cached app shell only when offline.
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});
