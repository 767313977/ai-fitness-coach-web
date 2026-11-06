// @ts-check
/** 训练分析纯函数测试：node --test web/tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bestSetByDay,
  estimated1RM,
  personalRecords,
  progressStatus,
  recordsThisWeek,
  weeklySetsByMuscle,
  addDaysISO,
} from '../js/analytics.js';

/** @param {string} date @param {string} exercise @param {number} setNo @param {number} weight @param {number} reps */
function row(date, exercise, setNo, weight, reps, source = 'hevy') {
  return {
    date,
    exercise,
    set_no: String(setNo),
    weight_kg: String(weight),
    reps: String(reps),
    rpe: '7',
    note: '',
    source,
  };
}

test('同一天多组只取最好的一组（按重量×次数）', () => {
  const rows = [
    row('2026-11-02', '深蹲', 1, 10, 10),
    row('2026-11-02', '深蹲', 2, 12, 8),
    row('2026-11-02', '深蹲', 3, 8, 12),
  ];
  const days = bestSetByDay(rows, '深蹲');
  assert.equal(days.length, 1);
  assert.equal(days[0].weight, 10);
  assert.equal(days[0].reps, 10);
  assert.equal(days[0].volume, 100);
});

test('自重动作按次数比较大小', () => {
  const rows = [
    row('2026-11-02', '平板支撑', 1, 0, 30),
    row('2026-11-02', '平板支撑', 2, 0, 45),
  ];
  const days = bestSetByDay(rows, '平板支撑');
  assert.equal(days.length, 1);
  assert.equal(days[0].score, 45);
});

test('1RM：reps 超过 12 返回 null，正好 12 可以算', () => {
  assert.equal(estimated1RM(20, 13), null);
  assert.equal(estimated1RM(0, 10), null);
  assert.equal(estimated1RM(20, 0), null);
  const value = estimated1RM(20, 12);
  assert.equal(value, 28);
});

test('连续 3 次没有提高判为停滞；只有 2 次判为数据不足', () => {
  const flat = [
    row('2026-10-01', '卧推', 1, 20, 10),
    row('2026-10-08', '卧推', 1, 20, 10),
    row('2026-10-15', '卧推', 1, 20, 10),
  ];
  assert.equal(progressStatus(flat, '卧推').status, 'plateau');

  const two = flat.slice(0, 2);
  assert.equal(progressStatus(two, '卧推').status, 'insufficient');
});

test('最近一次比上一次高判为进步，低判为下降', () => {
  const up = [
    row('2026-10-01', '卧推', 1, 20, 10),
    row('2026-10-08', '卧推', 1, 22, 10),
    row('2026-10-15', '卧推', 1, 24, 10),
  ];
  assert.equal(progressStatus(up, '卧推').status, 'up');

  const down = [
    row('2026-10-01', '卧推', 1, 24, 10),
    row('2026-10-08', '卧推', 1, 22, 10),
    row('2026-10-15', '卧推', 1, 20, 10),
  ];
  assert.equal(progressStatus(down, '卧推').status, 'down');
});

test('自重和助力动作不计入容量，只统计最多次数', () => {
  const rows = [
    row('2026-11-02', '平板支撑', 1, 0, 30),
    row('2026-11-02', '平板支撑', 2, 0, 40),
    row('2026-11-02', 'Assisted Pull Up', 1, 25, 8),
    row('2026-11-02', 'Assisted Pull Up', 2, 25, 10),
  ];
  const records = personalRecords(rows);

  assert.equal(records['平板支撑'].maxSetVolume, undefined);
  assert.equal(records['平板支撑'].maxSessionVolume, undefined);
  assert.equal(records['平板支撑'].maxReps.value, 40);

  assert.equal(records['Assisted Pull Up'].maxSetVolume, undefined);
  assert.equal(records['Assisted Pull Up'].maxSessionVolume, undefined);
  assert.equal(records['Assisted Pull Up'].maxWeight, undefined);
  assert.equal(records['Assisted Pull Up'].maxReps.value, 10);
});

test('负重动作的四项纪录都带日期', () => {
  const rows = [
    row('2026-11-02', '蹲', 1, 10, 10),
    row('2026-11-02', '蹲', 2, 12, 8),
    row('2026-11-09', '蹲', 1, 14, 6),
  ];
  const rec = personalRecords(rows)['蹲'];
  assert.equal(rec.maxWeight.value, 14);
  assert.equal(rec.maxWeight.date, '2026-11-09');
  assert.equal(rec.best1RM.value, 16.8); // 14 * (1 + 6/30)
  assert.equal(rec.maxSetVolume.value, 100); // 10×10
  assert.equal(rec.maxSessionVolume.value, 196); // 10×10 + 12×8
  assert.ok(rec.best1RM.date);
  assert.ok(rec.maxSessionVolume.date);
});

test('本周破纪录只返回本周日期', () => {
  const rows = [
    row('2026-10-26', '蹲', 1, 10, 10),
    row('2026-11-02', '蹲', 1, 12, 10),
  ];
  const records = recordsThisWeek(rows, '2026-11-02');
  assert.ok(records.some((r) => r.exercise === '蹲' && r.kind === 'maxWeight'));
  assert.equal(records.every((r) => r.date >= '2026-11-02' && r.date <= '2026-11-08'), true);
});

test('本周肌群组数统计与未分类', () => {
  const rows = [
    row('2026-11-02', '深蹲', 1, 10, 10),
    row('2026-11-02', '深蹲', 2, 10, 10),
    row('2026-11-04', '卧推', 1, 20, 10),
    row('2026-11-09', '深蹲', 1, 10, 10),
  ];
  const map = new Map([['深蹲', 'quads'], ['卧推', 'chest']]);
  const result = weeklySetsByMuscle(rows, map, '2026-11-02');
  assert.deepEqual(result, [
    { muscle: 'quads', sets: 2 },
    { muscle: 'chest', sets: 1 },
  ]);

  const withUnknown = weeklySetsByMuscle([row('2026-11-02', '未知动作', 1, 5, 10)], map, '2026-11-02');
  assert.deepEqual(withUnknown, [{ muscle: '未分类', sets: 1 }]);
});

test('addDaysISO 跨月', () => {
  assert.equal(addDaysISO('2026-11-02', 6), '2026-11-08');
  assert.equal(addDaysISO('2026-10-28', 6), '2026-11-03');
});
