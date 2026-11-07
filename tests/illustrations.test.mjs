// @ts-check
/** 插图索引匹配：plan key → 数据集 id → 英文名兜底。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { findIllustration } from '../js/illustrations.js';

const INDEX = {
  goblet_box_squat: { frames: ['a.svg'] },
  '0662': { frames: ['push.svg'], library_name: 'push-up' },
  '0289': { frames: ['bench.svg'], library_name: 'dumbbell bench press' },
};

test('课表动作优先按 plan key', () => {
  const hit = findIllustration(INDEX, { key: 'goblet_box_squat', name: '箱式高脚杯深蹲' }, null);
  assert.equal(hit, INDEX.goblet_box_squat);
});

test('完整库条目按数据集 id', () => {
  const hit = findIllustration(INDEX, null, { id: '0662', name: 'push-up' });
  assert.equal(hit, INDEX['0662']);
});

test('精选条目 id 不匹配时按英文名兜底', () => {
  const hit = findIllustration(INDEX, null, { id: 'push_up', name: 'push-up' });
  assert.equal(hit, INDEX['0662']);
});

test('找不到就返回 null', () => {
  assert.equal(findIllustration(INDEX, null, { id: '9999', name: 'unknown' }), null);
  assert.equal(findIllustration(null, null, null), null);
  assert.equal(findIllustration(INDEX, null, null), null);
});
