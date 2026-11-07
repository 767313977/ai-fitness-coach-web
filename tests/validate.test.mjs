// @ts-check
/** 表单校验规则：node --test web/tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';

import { dateRule, intRule, numberRule, requireAny, validateValues } from '../js/validate.js';

const today = '2026-11-07';

test('负数热量被拒绝', () => {
  assert.ok(validateValues(
    [{ name: 'kcal', label: '热量', rule: numberRule({ min: 0, exclusiveMin: true }) }],
    { kcal: '-1' },
    today,
  ));
});

test('体脂率必须是 3–60（与后端 config limits 一致）', () => {
  const fields = [{ name: 'body_fat_pct', label: '体脂率', rule: numberRule({ min: 3, max: 60 }) }];
  assert.ok(validateValues(fields, { body_fat_pct: '-2' }, today));
  assert.ok(validateValues(fields, { body_fat_pct: '101' }, today));
  assert.equal(validateValues(fields, { body_fat_pct: '20.5' }, today), null);
});

test('有氧分钟必须是 1–30 的整数', () => {
  const fields = [{ name: 'minutes', label: '有氧分钟', rule: intRule(1, 30) }];
  assert.ok(validateValues(fields, { minutes: '30.5' }, today));
  assert.ok(validateValues(fields, { minutes: '0' }, today));
  assert.ok(validateValues(fields, { minutes: '31' }, today));
  assert.equal(validateValues(fields, { minutes: '30' }, today), null);
});

test('日期不能晚于今天，也不能是非法日期', () => {
  const fields = [{ name: 'date', label: '日期', rule: dateRule() }];
  assert.ok(validateValues(fields, { date: '2026-11-08' }, today));
  assert.ok(validateValues(fields, { date: '2026-13-01' }, today));
  assert.ok(validateValues(fields, { date: '2026-02-31' }, today));
  assert.equal(validateValues(fields, { date: '2026-11-07' }, today), null);
});

test('至少填一项：身体指标不能只提交日期', () => {
  const names = ['waist_cm', 'body_fat_pct', 'skeletal_muscle_kg'];
  assert.equal(requireAny({}, names, '至少填一项身体指标'), '至少填一项身体指标');
  assert.equal(requireAny({ waist_cm: '  ' }, names, '至少填一项身体指标'), '至少填一项身体指标');
  assert.equal(requireAny({ body_fat_pct: '20' }, names, '至少填一项身体指标'), null);
});

test('非数字与空值：空值跳过，非数字报错', () => {
  const fields = [{ name: 'weight', label: '体重', rule: numberRule({ min: 25, max: 300 }) }];
  assert.equal(validateValues(fields, { weight: '' }, today), null);
  assert.ok(validateValues(fields, { weight: 'abc' }, today));
});

test('合法数据通过', () => {
  const fields = [
    { name: 'date', label: '日期', rule: dateRule() },
    { name: 'knee_pain', label: '膝痛', rule: intRule(0, 10) },
    { name: 'energy', label: '精力', rule: intRule(1, 5) },
    { name: 'sleep_feel', label: '睡眠感受', rule: intRule(1, 5) },
  ];
  assert.equal(validateValues(fields, {
    date: '2026-11-06', knee_pain: '2', energy: '4', sleep_feel: '3',
  }, today), null);
});
