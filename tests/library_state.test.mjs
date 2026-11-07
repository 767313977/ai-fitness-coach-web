// @ts-check
/** 动作库降级 / 重试的状态逻辑：不依赖 DOM。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { collectPlanEntries, reconcileSelection } from '../js/library_state.js';

const routine = {
  days: [
    {
      weekday: 1,
      exercises: [
        { key: 'goblet_box_squat', name: '箱式高脚杯深蹲' },
        { key: 'glute_bridge', name: '臀桥' },
      ],
    },
    { weekday: 2, type: 'cardio', segments_min: [30] },
    {
      weekday: 3,
      exercises: [
        { key: 'goblet_box_squat', name: '箱式高脚杯深蹲' },
        { key: 'plank', name: '平板支撑' },
        { name: '没有 key 的动作' },
      ],
    },
  ],
};

test('collectPlanEntries：不依赖精选数据集，按课表顺序去重', () => {
  const entries = collectPlanEntries(routine);
  assert.deepEqual(entries.map((ex) => ex.key), ['goblet_box_squat', 'glute_bridge', 'plank']);
});

test('collectPlanEntries：课表缺失或只有有氧/休息日时不报错', () => {
  assert.deepEqual(collectPlanEntries(undefined), []);
  assert.deepEqual(collectPlanEntries({}), []);
  assert.deepEqual(collectPlanEntries({ days: [{ type: 'rest' }] }), []);
});

test('reconcileSelection：重试成功后，降级期间的空条目会被补上', () => {
  const ex = { key: 'goblet_box_squat', name: '箱式高脚杯深蹲' };
  const item = { id: 'goblet-squat', name: 'Goblet Squat' };
  const selected = { item: null, ex };

  const next = reconcileSelection(selected, new Map([[ex.key, item]]));

  assert.notEqual(next, selected);
  assert.equal(next.item, item);
  assert.equal(next.ex, ex);
});

test('reconcileSelection：已经有条目时不覆盖', () => {
  const ex = { key: 'plank' };
  const own = { id: 'plank-old' };
  const selected = { item: own, ex };

  const next = reconcileSelection(selected, new Map([['plank', { id: 'plank-new' }]]));

  assert.equal(next, selected);
  assert.equal(next.item, own);
});

test('reconcileSelection：数据集里仍没有该动作时保持原样', () => {
  const selected = { item: null, ex: { key: 'dead_bug' } };
  assert.equal(reconcileSelection(selected, new Map()), selected);
  assert.equal(reconcileSelection(selected, null), selected);
});

test('reconcileSelection：选的是精选库条目（没有 ex）时不动', () => {
  const selected = { item: { id: 'push-up' } };
  assert.equal(reconcileSelection(selected, new Map()), selected);
  assert.equal(reconcileSelection(null, new Map()), null);
});
