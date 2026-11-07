// @ts-check
/** Service Worker：只缓存应用外壳，数据永远走网络（git 仓库里的健康数据不进 SW 缓存）。 */
const CACHE = 'afc-shell-v7';
const ILLUSTRATION_INDEX = './data/illustrations/index.json';
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
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    // 课表 13 个动作的插图（39 帧）单独预缓存：离线时打开动作详情也能看。
    // 完整动作库（1324 条）不缓存，离线时由页面提示不可用。
    try {
      const res = await fetch(ILLUSTRATION_INDEX);
      if (res.ok) {
        await cache.put(ILLUSTRATION_INDEX, res.clone());
        const index = await res.json();
        const frames = new Set();
        for (const item of Object.values(index)) {
          for (const frame of item?.frames ?? []) frames.add(`./${frame}`);
        }
        await Promise.all([...frames].map(async (url) => {
          try {
            const frame = await fetch(url);
            if (frame.ok) await cache.put(url, frame);
          } catch {
            // 单帧失败不影响其它帧
          }
        }));
      }
    } catch {
      // 首次安装时离线也不阻塞激活
    }
    await self.skipWaiting();
  })());
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
