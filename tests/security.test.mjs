// @ts-check
/** 安全回归：CSP 收紧、Markdown 防 XSS、外链 rel。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { markdown } from '../js/ui.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

test('CSP 只允许 GitHub API，并限制 object / frame', () => {
  assert.match(html, /connect-src 'self' https:\/\/api\.github\.com/);
  assert.ok(!html.includes('raw.githubusercontent.com'));
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-ancestors 'none'/);
  assert.match(html, /script-src 'self'/);
});

test('Markdown 渲染：脚本被转义，javascript: 链接不可点击', () => {
  const script = markdown('<script>alert(1)</script>');
  assert.ok(script.includes('&lt;script&gt;'));
  assert.ok(!script.includes('<script>'));

  const badLink = markdown('[点我](javascript:alert(1))');
  assert.ok(!badLink.includes('href="javascript'));
  assert.match(badLink, /javascript:alert/);
});

test('Markdown 外部链接带 noopener noreferrer', () => {
  const safe = markdown('[示例](https://example.com/a)');
  assert.match(safe, /target="_blank"/);
  assert.match(safe, /rel="noopener noreferrer"/);
});
