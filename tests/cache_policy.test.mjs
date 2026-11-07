// @ts-check
/** Service Worker 缓存隔离策略：node --test web/tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_NAME, CACHE_PREFIX, isOwnCache, shouldDeleteCache } from '../js/cache_policy.js';

test('本项目缓存使用独立前缀', () => {
  assert.equal(CACHE_PREFIX, 'afc-web:');
  assert.equal(CACHE_NAME.startsWith(CACHE_PREFIX), true);
});

test('只清理本项目旧版本缓存', () => {
  assert.equal(shouldDeleteCache('afc-web:shell:v8'), true);
  assert.equal(shouldDeleteCache(CACHE_NAME), false);
  assert.equal(shouldDeleteCache('zhifujing-v3'), false);
  assert.equal(shouldDeleteCache('workbox-precache-v2'), false);
  assert.equal(shouldDeleteCache('ai-fitness-coach-web'), false);
});

test('isOwnCache 只认本项目前缀', () => {
  assert.equal(isOwnCache('afc-web:shell:v9'), true);
  assert.equal(isOwnCache('other-project:shell:v9'), false);
});

test('模拟 activate：其他项目缓存全部保留', () => {
  const keys = ['afc-web:shell:v8', 'afc-web:shell:v9', 'zhifujing-v3', 'another-pages-cache'];
  const removed = keys.filter((key) => shouldDeleteCache(key, CACHE_NAME));
  assert.deepEqual(removed, ['afc-web:shell:v8']);
});
