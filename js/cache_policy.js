// @ts-check
/** Service Worker 缓存策略：纯函数，供 sw.js 与测试共用。
 *
 * Cache Storage 按源站共享（github.io 下所有项目共用），
 * 所以清理时必须只删本项目前缀的缓存，绝不能清空整个 Cache Storage。
 */
export const CACHE_PREFIX = 'afc-web:';
export const CACHE_NAME = `${CACHE_PREFIX}shell:v9`;

/** @param {string} key */
export function isOwnCache(key) {
  return String(key).startsWith(CACHE_PREFIX);
}

/**
 * 只删除本项目的旧版本缓存；其他 GitHub Pages 项目的缓存一律不动。
 * @param {string} key
 * @param {string} [current]
 */
export function shouldDeleteCache(key, current = CACHE_NAME) {
  return isOwnCache(key) && key !== current;
}
