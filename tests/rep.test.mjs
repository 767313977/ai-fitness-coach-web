// @ts-check
/** 动作剂量格式化回归测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { planDose, repDose, repQuantity, repRange } from '../js/rep.js';

test('次数上下限相同时只显示一个数', () => {
  const ex = { sets: 3, rep_min: 8, rep_max: 8 };
  assert.equal(repRange(ex), '8');
  assert.equal(repDose(ex), '3×8');
});

test('次数区间保留上下限', () => {
  const ex = { sets: 3, rep_min: 8, rep_max: 12 };
  assert.equal(repRange(ex), '8–12');
  assert.equal(repDose(ex), '3×8–12');
  assert.equal(repQuantity(ex), '8–12 次');
  assert.equal(planDose(ex), '3 组 × 8–12 次');
});

test('每侧动作带 /侧 标记', () => {
  const ex = { sets: 3, rep_min: 8, rep_max: 8, per_side: true };
  assert.equal(repDose(ex), '3×8/侧');
});

test('计时动作显示秒数，不显示次数', () => {
  const ex = { sets: 3, hold_s: 30 };
  assert.equal(repRange(ex), '30 秒');
  assert.equal(repDose(ex), '3×30 秒');
  assert.equal(repQuantity(ex), '30 秒');
  assert.equal(planDose(ex), '3 组 × 30 秒');
});

test('缺失剂量时返回占位而不是 null', () => {
  assert.equal(repRange({}), '—');
  assert.equal(repDose({}), '');
  assert.equal(repQuantity({}), '');
  assert.equal(planDose({}), '');
});
