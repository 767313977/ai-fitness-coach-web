// @ts-check
/** 演示模式状态展示一致性回归测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('演示模式顶栏和侧边栏都显示「演示数据」', () => {
  const hits = app.match(/state\.demo \? '演示数据' : state\.data \?/g) ?? [];
  assert.equal(hits.length, 2, '顶栏和侧边栏应使用同一演示文案');
});

test('演示模式两个状态点都使用 warn', () => {
  assert.match(app, /dot \$\{state\.error \|\| state\.demo \? 'warn' : 'ok'\}/);
  assert.match(app, /dot \$\{state\.error \? 'warn' : state\.demo \? 'warn' : 'ok'\}/);
});
