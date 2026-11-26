// Service worker: permite instalar o app e abri-lo mesmo sem rede (com os últimos dados em cache).
// Estratégia: rede primeiro (dados sempre frescos); se a rede falhar, usa o cache.
const CACHE = 'monitor-v3';
const SHELL = ['./', 'index.html', 'app.js', 'lib.js', 'static-api.js', 'calc.js', 'invoice.js', 'pdf-text.js', 'styles.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return; // cotações ao vivo vão direto à rede
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
});
