// @ts-check
/** 部署闸门：Pages 工作流必须是「test 通过才 deploy」。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(join(here, '..', '.github', 'workflows', 'pages.yml'), 'utf8');

test('Pages 工作流有独立的 test 作业，并执行 npm test', () => {
  assert.match(workflow, /^  test:/m);
  assert.match(workflow, /run:\s*npm test/);
});

test('deploy 作业依赖 test，测试失败不会发布', () => {
  assert.match(workflow, /^  deploy:/m);
  assert.match(workflow, /needs:\s*test/);
  assert.match(workflow, /actions\/deploy-pages@/);
});

test('Pages 工作流具备部署所需权限', () => {
  assert.match(workflow, /pages:\s*write/);
  assert.match(workflow, /id-token:\s*write/);
});

test('PR 只跑测试，永远不会触发部署', () => {
  assert.match(workflow, /^  pull_request:/m);
  assert.match(workflow, /if:\s*github\.event_name != 'pull_request'/);
});

test('权限按 Job 最小化：test 不得拿 pages / id-token', () => {
  const testJob = workflow.split(/^  deploy:/m)[0];
  assert.match(testJob, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(testJob, /pages:\s*write/);
  assert.doesNotMatch(testJob, /id-token:\s*write/);
});

test('所有第三方 Action 固定到完整 SHA', () => {
  const uses = [...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(uses.length >= 4, `只找到 ${uses.length} 个 uses`);
  for (const ref of uses) {
    assert.match(ref, /@[0-9a-f]{40}$/, `${ref} 没有固定到完整 SHA`);
  }
});
