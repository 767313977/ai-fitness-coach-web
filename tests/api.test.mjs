// @ts-check
/** GitHub API 安全校验与 request_id：node --test web/tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, GitHubApi, PublicRepoError, newRequestId, resolveBranch } from '../js/api.js';

/** @param {any} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** @param {string} body @param {number} [status] */
function raw(body, status = 200) {
  return new Response(body, { status });
}

test('公开仓库：verifyRepo 直接拒绝，且不继续读 config', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/repos/owner/public-repo')) return json({ private: false });
    throw new Error(`不应访问：${url}`);
  };
  const api = new GitHubApi({ owner: 'owner', repo: 'public-repo', token: 'dummy', ref: 'master' });
  await assert.rejects(
    api.verifyRepo(),
    (error) => error instanceof PublicRepoError
      && /私有仓库/.test(error.message)
      && !error.message.includes('dummy'),
  );
  assert.equal(calls.length, 1);
});

test('私有仓库：Contents + Actions 可读时通过', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/repos/owner/private-repo')) {
      return json({ private: true, full_name: 'owner/private-repo', permissions: { push: true } });
    }
    if (u.includes('/contents/config.json')) return raw('{"athlete":{"weight_kg":70}}');
    if (u.includes('/actions/workflows')) return json({ total_count: 7 });
    if (u.includes('/contents/data/summary.json')) return raw('{"generated_at":"2026-11-07T00:00:00Z"}');
    throw new Error(`不应访问：${u}`);
  };
  const api = new GitHubApi({ owner: 'owner', repo: 'private-repo', token: 'dummy', ref: 'master' });
  const report = await api.verifyRepo();
  assert.equal(report.private, true);
  assert.equal(report.workflowCount, 7);
  assert.equal(report.athlete, 70);
  assert.equal(report.summaryAt, '2026-11-07T00:00:00Z');
});

test('PAT 无效 / 没有仓库权限：给出明确错误且不泄露 token', async () => {
  globalThis.fetch = async () => json({ message: 'Bad credentials' }, 401);
  const api = new GitHubApi({ owner: 'owner', repo: 'repo', token: 'dummy', ref: 'master' });
  await assert.rejects(
    api.verifyRepo(),
    (error) => error instanceof ApiError
      && /PAT 无效|过期/.test(error.message)
      && !error.message.includes('dummy'),
  );

  globalThis.fetch = async () => json({ message: 'Not Found' }, 404);
  const missing = new GitHubApi({ owner: 'owner', repo: 'ghost', token: 'dummy', ref: 'master' });
  await assert.rejects(
    missing.verifyRepo(),
    (error) => error instanceof ApiError
      && /PAT 没有/.test(error.message)
      && !error.message.includes('dummy'),
  );
});

test('Actions 权限不足：单独提示', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/repos/owner/no-actions')) {
      return json({ private: true, full_name: 'owner/no-actions', permissions: { push: true } });
    }
    if (u.includes('/contents/config.json')) return raw('{}');
    if (u.includes('/actions/workflows')) return json({ message: 'Forbidden' }, 403);
    throw new Error(`不应访问：${u}`);
  };
  const api = new GitHubApi({ owner: 'owner', repo: 'no-actions', token: 'dummy', ref: 'master' });
  await assert.rejects(
    api.verifyRepo(),
    (error) => error instanceof ApiError && /Actions 读取权限/.test(error.message),
  );
});

test('只读账号：permissions.push=false 时拒绝', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/repos/owner/readonly')) {
      return json({ private: true, full_name: 'owner/readonly', permissions: { push: false } });
    }
    throw new Error(`不应访问：${url}`);
  };
  const api = new GitHubApi({ owner: 'owner', repo: 'readonly', token: 'dummy', ref: 'master' });
  await assert.rejects(
    api.verifyRepo(),
    (error) => error instanceof ApiError && /没有写权限/.test(error.message),
  );
});

test('403 二级限流：不误报成 PAT 权限不足', async () => {
  globalThis.fetch = async () => new Response('{"message":"You have exceeded a secondary rate limit"}', {
    status: 403,
    headers: { 'Retry-After': '60', 'X-RateLimit-Remaining': '4999' },
  });
  const api = new GitHubApi({ owner: 'owner', repo: 'secondary-limit', token: 'dummy', ref: 'master' });
  await assert.rejects(
    api.raw('config.json'),
    (error) => error instanceof ApiError
      && /二级限流/.test(error.message)
      && !/读取权限/.test(error.message),
  );
});

test('403 主限流：剩余次数为 0 时提示限流', async () => {
  globalThis.fetch = async () => new Response('{"message":"API rate limit exceeded"}', {
    status: 403,
    headers: { 'X-RateLimit-Remaining': '0' },
  });
  const api = new GitHubApi({ owner: 'owner', repo: 'primary-limit', token: 'dummy', ref: 'master' });
  await assert.rejects(
    api.raw('config.json'),
    (error) => error instanceof ApiError && /限流/.test(error.message),
  );
});

test('403 普通权限不足：仍提示 PAT 读取权限', async () => {
  globalThis.fetch = async () => new Response('{"message":"Resource not accessible"}', {
    status: 403,
    headers: { 'X-RateLimit-Remaining': '4999' },
  });
  const api = new GitHubApi({ owner: 'owner', repo: 'forbidden', token: 'dummy', ref: 'master' });
  await assert.rejects(
    api.raw('config.json'),
    (error) => error instanceof ApiError && /读取权限/.test(error.message),
  );
});

test('request_id 是 8 位小写十六进制且不重复', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const id = newRequestId();
    assert.match(id, /^[0-9a-f]{8}$/);
    seen.add(id);
  }
  assert.ok(seen.size >= 499);
});

test('repoMeta 返回仓库默认分支，main 仓库也能自动识别', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/repos/owner/main-repo')) {
      return json({ private: true, default_branch: 'main', permissions: { push: true } });
    }
    throw new Error(`不应访问：${u}`);
  };
  const api = new GitHubApi({ owner: 'owner', repo: 'main-repo', token: 'dummy' });
  const meta = await api.repoMeta();
  assert.equal(meta.defaultBranch, 'main');
});

test('resolveBranch：填了用填的，没填用默认分支，最后兜底 master', () => {
  assert.equal(resolveBranch('', 'main'), 'main');
  assert.equal(resolveBranch('  dev  ', 'main'), 'dev');
  assert.equal(resolveBranch(undefined, ''), 'master');
  assert.equal(resolveBranch(null, undefined), 'master');
});

test('urlFor 使用传入的分支，不写死 master', () => {
  const api = new GitHubApi({ owner: 'owner', repo: 'repo', token: 'dummy', ref: 'main' });
  assert.match(api.urlFor('config.json'), /ref=main/);
});
