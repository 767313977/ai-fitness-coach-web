// @ts-check
/** 分步说明按语言取值：zh 用上游中文译文，en 用英文原文。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { stepsFor } from '../js/dataset.js';

const ITEM = {
  steps: ['平躺，膝盖弯曲。', '收紧腹肌起身。'],
  steps_en: ['Lie flat with knees bent.', 'Tighten your abs and lift.'],
};

test('默认返回中文步骤', () => {
  assert.deepEqual(stepsFor(ITEM, 'zh'), ITEM.steps);
  assert.deepEqual(stepsFor(ITEM, undefined), ITEM.steps);
});

test('英文步骤按 en 返回原文', () => {
  assert.deepEqual(stepsFor(ITEM, 'en'), ITEM.steps_en);
});

test('缺字段时返回空数组而不是报错', () => {
  assert.deepEqual(stepsFor({}, 'en'), []);
  assert.deepEqual(stepsFor(null, 'zh'), []);
  assert.deepEqual(stepsFor({ steps: ['a'] }, 'en'), []);
});
