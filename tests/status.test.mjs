// @ts-check
/** 连接状态文案：限流分级与离线缓存提示 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { noticeFromError, offlineText, rateLimitText } from '../js/status.js';

test('一级限流：提示配额用尽并给出恢复时间', () => {
  const text = rateLimitText('primary');
  assert.match(text, /5000/);
  assert.match(text, /1 小时/);
});

test('二级限流：提示等待 1–2 分钟', () => {
  assert.match(rateLimitText('secondary'), /1–2 分钟/);
});

test('未知限流：给出兜底文案而不是空字符串', () => {
  assert.match(rateLimitText(undefined), /稍后/);
  assert.match(rateLimitText(null), /稍后/);
});

test('离线提示带缓存时间', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const text = offlineText('2026-11-07T11:45:00Z', now);
  assert.match(text, /离线/);
  assert.match(text, /15 分钟前/);
});

test('离线提示：没有缓存时间也能说清楚', () => {
  assert.match(offlineText(null), /缓存/);
});

test('noticeFromError：限流错误映射成常驻提示', () => {
  const notice = noticeFromError({ rateLimited: true, rateLimitKind: 'secondary', status: 403 });
  assert.equal(notice?.kind, 'rate-limit');
  assert.match(notice?.text ?? '', /二级限流/);
});

test('noticeFromError：断网映射成离线提示', () => {
  assert.equal(noticeFromError({ status: 0 })?.kind, 'offline');
});

test('noticeFromError：普通权限错误不占用常驻提示', () => {
  assert.equal(noticeFromError({ status: 403, message: 'Resource not accessible' }), null);
  assert.equal(noticeFromError(null), null);
});
