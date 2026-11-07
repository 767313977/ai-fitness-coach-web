// @ts-check
/** Service Worker 预缓存与清理范围回归测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

import { CACHE_NAME, CACHE_PREFIX } from '../js/cache_policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\];/);
if (!shellBlock) throw new Error('sw.js 没有 SHELL 列表');
const shellEntries = new Set(
  [...shellBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1]),
);

/** @param {string} file */
function importsOf(file) {
  const text = readFileSync(file, 'utf8');
  const out = [];
  for (const match of text.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), match[1]);
    if (existsSync(target)) out.push(target);
  }
  return out;
}

/** @param {string} entry */
function collectModules(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of importsOf(file)) queue.push(dep);
  }
  return seen;
}

test('SHELL 自动覆盖 app.js 的全部本地模块依赖', () => {
  const modules = collectModules(join(root, 'app.js'));
  for (const file of modules) {
    const rel = `./${relative(root, file).split('\\').join('/')}`;
    assert.ok(shellEntries.has(rel), `${rel} 缺失于 SHELL，离线时会白屏`);
  }
  // sw.js 自身 import 的模块不在 app.js 依赖图里
  assert.ok(shellEntries.has('./js/cache_policy.js'), 'sw.js import 的 cache_policy.js 也要预缓存');
});

test('SHELL 包含静态入口资源', () => {
  for (const file of [
    './index.html',
    './style.css',
    './manifest.webmanifest',
    './data/exercises.json',
  ]) {
    assert.ok(shellEntries.has(file), `${file} 应在 SHELL 预缓存列表里`);
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
