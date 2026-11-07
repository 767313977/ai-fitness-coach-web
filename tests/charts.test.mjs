// @ts-check
/** 图表空状态：空数据 / 单点 / 正常数据三种情况都要有合理输出 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { barChart, heatmap, lineChart } from '../js/ui.js';

test('lineChart：空数据与单点分别给出提示', () => {
  assert.match(lineChart([]), /还没有数据/);
  assert.match(lineChart([{ label: '11-01', value: 70 }]), /只有 1 个数据点/);
});

test('lineChart：两个点正常输出 SVG', () => {
  const html = lineChart([
    { label: '11-01', value: 70 },
    { label: '11-02', value: 69.5 },
  ]);
  assert.match(html, /<svg class="chart"/);
  assert.match(html, /role="img"/);
});

test('barChart：空数据提示，单点仍能画柱', () => {
  assert.match(barChart([]), /还没有记录/);
  const one = barChart([{ label: '11-07', value: 1800 }], { target: 2000 });
  assert.match(one, /<svg class="chart"/);
  assert.match(one, /<rect class="cbar/);
});

test('heatmap：没有记录时给出文案，不渲染空网格', () => {
  assert.match(heatmap([]), /还没有记录/);
  assert.match(heatmap([{ date: '2026-11-07', value: 0 }]), /还没有记录/);
});

test('heatmap：有记录时正常渲染格子', () => {
  const html = heatmap([{ date: '2026-11-07', value: 2 }], { weeks: 4 });
  assert.match(html, /<div class="heat">/);
  assert.match(html, /l2/);
});
