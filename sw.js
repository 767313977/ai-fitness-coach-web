// @ts-check
/** Service Worker：只缓存应用外壳，数据永远走网络（git 仓库里的健康数据不进 SW 缓存）。 */
const CACHE = 'afc-shell-v6';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './js/api.js',
  './js/data.js',
  './js/analytics.js',
  './js/ui.js',
  './js/demo.js',
  './js/submit.js',
  './js/queue.js',
  './js/dataset.js',
  './pages/today.js',
  './pages/week.js',
  './pages/review.js',
  './pages/record.js',
  './pages/settings.js',
  './pages/library.js',
  './data/exercises.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // 只处理同源的应用外壳；GitHub API 一律直连
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html'))),
  );
});
