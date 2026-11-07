// @ts-check
/** Hevy 导入模式与同步状态纯函数测试：node --test web/tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';

import { hevyMode, hevySyncStatus, fmtDateTime, HEVY_SYNC_STALE_HOURS } from '../js/data.js';

test('hevy_mode 只认 api，其余一律按 csv', () => {
  assert.equal(hevyMode({ hevy_mode: 'api' }), 'api');
  assert.equal(hevyMode({ hevy_mode: ' API ' }), 'api');
  assert.equal(hevyMode({ hevy_mode: 'csv' }), 'csv');
  assert.equal(hevyMode({}), 'csv');
  assert.equal(hevyMode(null), 'csv');
});

test('刚同步过不算超时', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const status = hevySyncStatus({ last_run_at: '2026-11-07T10:00:00Z' }, now);
  assert.equal(status.unknown, false);
  assert.equal(status.stale, false);
  assert.equal(Math.round(status.hours ?? NaN), 2);
});

test('超过阈值算超时', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const status = hevySyncStatus({ last_run_at: '2026-11-05T09:00:00Z' }, now);
  assert.equal(status.stale, true);
  assert.ok((status.hours ?? 0) > HEVY_SYNC_STALE_HOURS);
});

test('没有 sync_state 视为未同步', () => {
  assert.equal(hevySyncStatus(null).unknown, true);
  assert.equal(hevySyncStatus({}).unknown, true);
  assert.equal(hevySyncStatus({}).stale, true);
});

test('last_run_at 缺失时回退到 last_event_at', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const status = hevySyncStatus({ last_event_at: '2026-11-07T11:00:00Z' }, now);
  assert.equal(Math.round(status.hours ?? NaN), 1);
});

test('同步时间按北京时间展示', () => {
  assert.equal(fmtDateTime('2026-11-07T04:44:16.737Z'), '11月7日 12:44');
  assert.equal(fmtDateTime(''), '');
  assert.equal(fmtDateTime('not-a-date'), '');
});
