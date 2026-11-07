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
