// @ts-check
/** 周目标预测与动作分类筛选：node --test web/tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';

import { weekForecast, addDays, weekStart, weekday, loadAll } from '../js/data.js';
import { matchesCategory, CATEGORIES } from '../js/dataset.js';
import { DEMO_DATA } from '../js/demo.js';

class NotFound extends Error {
  constructor(path) { super(path); this.name = 'NotFoundError'; }
}

/** @param {{mode: 'csv'|'api', syncMissing?: boolean}} opts */
function fakeApi({ mode, syncMissing = true }) {
  return {
    lastOffline: null,
    async raw(path) {
      if (path === 'config.json') return JSON.stringify({ hevy_mode: mode });
      if (path === 'data/sync_state.json' && syncMissing) throw new NotFound(path);
      if (path === 'review/index.json') throw new NotFound(path);
      if (path === 'data/summary.json') {
        return JSON.stringify({ week: { start: '2026-11-02', end: '2026-11-08' } });
      }
      return '';
    },
  };
}

const routine = {
  rotation: {},
  days: [
    { weekday: 1, type: 'strength', title: '下肢 A' },
    { weekday: 2, type: 'rest', title: '休息' },
    { weekday: 3, type: 'strength', title: '上肢' },
    { weekday: 4, type: 'rest', title: '休息' },
    { weekday: 5, type: 'cardio', title: '快走', segments_min: [30, 30] },
    { weekday: 6, type: 'rest', title: '休息' },
    { weekday: 7, type: 'rest', title: '休息' },
  ],
};

const summary = {
  strength_sessions: 1,
  cardio_minutes: 30,
  targets: { strength_sessions: 3, cardio_minutes: 90, cardio_minutes_max: 150 },
};

test('周中预测：把剩余课表算进最多能到的量', () => {
  const items = weekForecast(summary, routine, null, '2026-11-04');
  const strength = items.find((i) => i.key === 'strength');
  const cardio = items.find((i) => i.key === 'cardio');

  // 11-04 是周三：只剩周三力量日；周五有氧 60 分钟
  assert.equal(strength.remaining, 1);
  assert.equal(strength.projected, 2);
  assert.equal(strength.reachable, false);

  assert.equal(cardio.remaining, 60);
  assert.equal(cardio.projected, 90);
  assert.equal(cardio.reachable, true);
});

test('周一预测：计划和目标都够', () => {
  const items = weekForecast(summary, routine, null, '2026-11-02');
  const strength = items.find((i) => i.key === 'strength');
  assert.equal(strength.remaining, 2);
  assert.equal(strength.projected, 3);
  assert.equal(strength.reachable, true);
});

test('没有课表时剩余为 0，只按已完成算', () => {
  const items = weekForecast(summary, null, null, '2026-11-04');
  assert.equal(items.every((i) => i.remaining === 0), true);
  assert.equal(items.find((i) => i.key === 'strength').projected, 1);
});

test('没有 summary 时返回空数组', () => {
  assert.deepEqual(weekForecast(null, routine, null, '2026-11-04'), []);
});

test('动作分类筛选只看部位/目标肌群', () => {
  assert.deepEqual(CATEGORIES.slice(0, 2), ['全部', '胸']);
  const legs = { body_part: 'upper legs', target: 'quads' };
  const chest = { body_part: 'chest', target: 'pectorals' };
  assert.equal(matchesCategory(legs, '腿'), true);
  assert.equal(matchesCategory(legs, '胸'), false);
  assert.equal(matchesCategory(chest, '胸'), true);
  assert.equal(matchesCategory(chest, '全部'), true);
});

test('日期边界：周日归本周，跨年加天', () => {
  assert.equal(weekday('2026-11-08'), 7);
  assert.equal(weekStart('2026-11-08'), '2026-11-02');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekStart('2027-01-01'), '2026-12-28');
});

test('演示数据是虚构人物且结构完整', () => {
  assert.equal(DEMO_DATA.demo, true);
  assert.equal(DEMO_DATA.config.athlete.name, '演示用户');
  assert.equal(DEMO_DATA.routine.days.length, 7);
  assert.ok(DEMO_DATA.summary.body.waist_weekly_8w.length > 0);
});

test('CSV 模式下 sync_state.json 缺失不算“缺失文件”', async () => {
  const data = await loadAll(fakeApi({ mode: 'csv' }));
  assert.equal(data.missing.includes('data/sync_state.json'), false);
  // 其它真正缺的文件仍然要提示
  assert.equal(data.missing.includes('review/index.json'), true);
});

test('API 模式下 sync_state.json 缺失要提示', async () => {
  const data = await loadAll(fakeApi({ mode: 'api' }));
  assert.equal(data.missing.includes('data/sync_state.json'), true);
});

test('loadAll：频繁变化的文件用短 TTL，刷新时 fresh 透传', async () => {
  /** @type {{path: string, fresh?: boolean, maxAgeMs?: number}[]} */
  const seen = [];
  const api = {
    lastOffline: null,
    async raw(path, opts = {}) {
      seen.push({ path, fresh: opts.fresh, maxAgeMs: opts.maxAgeMs });
      if (path === 'config.json') return '{}';
      return '';
    },
  };

  await loadAll(api);
  const byPath = new Map(seen.map((item) => [item.path, item]));
  assert.equal(byPath.get('data/summary.json')?.maxAgeMs, 30_000);
  assert.equal(byPath.get('data/sync_state.json')?.maxAgeMs, 30_000);
  assert.equal(byPath.get('config.json')?.maxAgeMs, 60_000);
  assert.equal(byPath.get('data/summary.json')?.fresh, undefined);

  seen.length = 0;
  await loadAll(api, { fresh: true });
  assert.equal(seen.find((item) => item.path === 'data/summary.json')?.fresh, true);
  assert.equal(seen.find((item) => item.path === 'config.json')?.fresh, true);
});
