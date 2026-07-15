// Service Worker für Offline-Nutzung (PWA). Cached die App-Shell (Aufbauplan,
// SPS-Editor, Stromlaufplan, Icons) und liefert sie offline aus dem Cache aus.
// API-Aufrufe (/api/*) und version.txt laufen bewusst nie über den Cache, damit
// Login/Cloud-Speichern und der Auto-Reload-Check ihr normales Verhalten behalten.
const CACHE = 'elektrosim-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/logo-editor.html',
  '/stromlaufplan.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/favicon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/version.txt') return; // immer Netzwerk

  // Stale-while-revalidate: sofort aus dem Cache antworten (auch offline),
  // im Hintergrund aktualisieren, sobald Netzwerk verfügbar ist.
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req);
      const network = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || (await network) || new Response('Offline und nicht im Cache.', { status: 503 });
    })
  );
});
