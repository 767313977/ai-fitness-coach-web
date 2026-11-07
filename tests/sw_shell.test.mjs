// @ts-check
/** Service Worker 预缓存与清理范围回归测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CACHE_NAME, CACHE_PREFIX } from '../js/cache_policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const sw = readFileSync(join(here, '..', 'sw.js'), 'utf8');

test('SHELL 包含核心模块与新增依赖', () => {
  for (const file of [
    './app.js',
    './style.css',
    './js/api.js',
    './js/queue.js',
    './js/submit.js',
    './js/illustrations.js',
    './js/validate.js',
    './js/cache_policy.js',
    './pages/today.js',
    './pages/record.js',
    './pages/library.js',
    './data/exercises.json',
  ]) {
    assert.ok(sw.includes(`'${file}'`), `${file} 应在 SHELL 预缓存列表里`);
  }
});

test('activate 只清理本项目旧缓存', () => {
  assert.match(sw, /shouldDeleteCache\(k, CACHE\)/);
  assert.ok(!/caches\.keys\(\)\.then\(\(keys\) => Promise\.all\(keys\.filter\(\(k\) => k !== CACHE\)/.test(sw));
  assert.equal(CACHE_PREFIX, 'afc-web:');
  assert.ok(CACHE_NAME.startsWith(CACHE_PREFIX));
});

test('离线回退只查本项目缓存，不跨项目 match', () => {
  assert.match(sw, /caches\.open\(CACHE\)/);
  assert.match(sw, /cache\.match\(event\.request\)/);
  assert.ok(!/caches\.match\(event\.request\)/.test(sw));
  assert.match(sw, /cache: 'no-cache'/);
});

test('运行时只缓存外壳与插图，完整动作库不进缓存', () => {
  assert.match(sw, /isCacheable\(url\)/);
  assert.match(sw, /response\.ok && isCacheable\(url\)/);
  assert.ok(!/data\/exercises-full/.test(sw));
});
