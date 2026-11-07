// @ts-check
/** Hevy CSV 本地校验：大小、扩展名、类型、表头 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CSV_BYTES, validateFile, validateFileMeta, validateHeader,
} from '../js/hevy_csv.js';

/** @param {string} head @param {{name?: string, size?: number, type?: string}} [meta] */
function fakeFile(head, meta = {}) {
  return {
    name: meta.name ?? 'workouts.csv',
    size: meta.size ?? head.length,
    type: meta.type ?? 'text/csv',
    slice: () => ({ text: async () => head }),
  };
}

test('扩展名与类型：只接受 CSV', () => {
  assert.match(validateFileMeta(null) ?? '', /没有选择/);
  assert.match(validateFileMeta({ name: 'a.txt', size: 10, type: 'text/plain' }) ?? '', /\.csv/);
  assert.match(validateFileMeta({ name: 'a.csv', size: 10, type: 'image/png' }) ?? '', /文件类型/);
  assert.equal(validateFileMeta({ name: 'a.csv', size: 10, type: 'text/csv' }), null);
});

test('大小：超过 2 MB 直接拒绝', () => {
  assert.match(
    validateFileMeta({ name: 'a.csv', size: MAX_CSV_BYTES + 1, type: 'text/csv' }) ?? '',
    /文件太大/,
  );
  assert.equal(validateFileMeta({ name: 'a.csv', size: MAX_CSV_BYTES, type: 'text/csv' }), null);
});

test('表头：缺少练习名或开始时间时拒绝', () => {
  assert.match(validateHeader('') ?? '', /空的/);
  assert.match(validateHeader('foo,bar') ?? '', /表头不对/);
  assert.equal(validateHeader('start_time,exercise_title,reps'), null);
  assert.equal(validateHeader('\uFEFF"Date","Exercise","Reps"'), null);
  assert.equal(validateHeader('日期,动作,次数'), null);
});

test('validateFile：正常文件通过，错误表头给出提示', async () => {
  assert.equal(await validateFile(fakeFile('start_time,exercise_title\n2026-11-07,Squat')), null);
  assert.match(await validateFile(fakeFile('foo,bar\n1,2')) ?? '', /表头不对/);
});

test('validateFile：超大文件不读取内容', async () => {
  let sliced = false;
  const file = {
    name: 'huge.csv',
    size: MAX_CSV_BYTES + 1024,
    type: 'text/csv',
    slice: () => { sliced = true; return { text: async () => '' }; },
  };
  assert.match(await validateFile(file) ?? '', /文件太大/);
  assert.equal(sliced, false);
});
