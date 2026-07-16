// Service Worker für Offline-Nutzung (PWA). Cached die App-Shell (Aufbauplan,
// SPS-Editor, Stromlaufplan, Icons) und liefert sie offline aus dem Cache aus.
// API-Aufrufe (/api/*) und version.txt laufen bewusst nie über den Cache, damit
// Login/Cloud-Speichern und der Auto-Reload-Check ihr normales Verhalten behalten.
const CACHE = 'elektrosim-shell-v2';
const SHELL = [
  '/',
  '/logo-editor',
  '/stromlaufplan',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/favicon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(SHELL.map(u => cache.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
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
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/version.txt') return; // immer Netzwerk

  // Navigationen (Seitenaufrufe / neue Tabs, z.B. der SPS-Editor per window.open):
  // immer zuerst das Netzwerk versuchen. So können serverseitige Redirects
  // (z.B. .html -> kanonische URL) und frischer Code nie durch einen Cache-Bug
  // blockiert werden. Nur bei echtem Netzwerkausfall auf den Cache zurückfallen.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
        return res;
      }).catch(async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        const root = await cache.match('/');
        return root || new Response('Offline und nicht im Cache.', { status: 503 });
      })
    );
    return;
  }

  // Statische Assets: stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      }).catch(() => null);
      return cached || (await network) || new Response('Offline und nicht im Cache.', { status: 503 });
    }).catch(() => fetch(req))
  );
});
