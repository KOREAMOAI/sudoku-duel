// 스도쿠 듀얼 서비스 워커: 화면은 항상 최신 버전을 먼저 받고, 오프라인이면 저장해 둔 화면을 보여줘요.
// 게임 데이터(/api/)는 저장하지 않아요.
const CACHE = 'sd-shell-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put('/', cp)); return r; }).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(e.request).then((m) => m || fetch(e.request)));
});
