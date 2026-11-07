// @ts-check
/** Service Worker：只缓存应用外壳，数据永远走网络（git 仓库里的健康数据不进 SW 缓存）。
 *
 * Cache Storage 按源站共享（github.io 下所有项目共用），因此：
 * - 所有缓存统一用 afc-web: 前缀；
 * - 升级时只删本项目旧版本，绝不 caches.keys() 全删；
 * - 离线回退只查本项目缓存，不做全局 caches.match。
 */
import { CACHE_NAME, shouldDeleteCache } from './js/cache_policy.js';

const CACHE = CACHE_NAME;
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
  './js/illustrations.js',
  './js/library_state.js',
  './js/rep.js',
  './js/status.js',
  './js/hevy_csv.js',
  './js/validate.js',
  './js/cache_policy.js',
  './pages/today.js',
  './pages/week.js',
  './pages/review.js',
  './pages/record.js',
  './pages/settings.js',
  './pages/library.js',
  './data/exercises.json',
];

/** 允许进运行时缓存的路径：应用外壳 + 课表插图；完整动作库按设计不缓存。 */
const CACHEABLE_PATHS = new Set(
  SHELL
    .filter((entry) => entry !== './')
    .map((entry) => new URL(entry, self.location.href).pathname),
);

/** @param {URL} url */
function isCacheable(url) {
  return CACHEABLE_PATHS.has(url.pathname) || url.pathname.includes('/data/illustrations/');
}

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
      // 只清理本项目旧版本；同域其他 GitHub Pages 项目的缓存不能碰
      .then((keys) => Promise.all(keys.filter((k) => shouldDeleteCache(k, CACHE)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // 只处理同源的应用外壳；GitHub API 一律直连
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((response) => {
        // 只缓存成功的响应，且只限应用外壳/插图；避免完整动作库把 Cache Storage 撑大
        if (response.ok && isCacheable(url)) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(event.request);
        if (cached) return cached;
        // 只在页面导航时回退到外壳；JS/CSS 缺失时明确失败，避免把 HTML 当模块执行
        if (event.request.mode === 'navigate') {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        return new Response('离线且没有缓存', {
          status: 504,
          statusText: 'Offline',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }),
  );
});
