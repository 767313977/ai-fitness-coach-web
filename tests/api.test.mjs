// @ts-check
/** GitHub API 安全校验与 request_id：node --test web/tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, GitHubApi, PublicRepoError, newRequestId, pickBranch, resolveBranch } from '../js/api.js';

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
      && error.rateLimited === true
      && error.rateLimitKind === 'secondary'
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
    (error) => error instanceof ApiError
      && /每小时 5000 次/
      && error.rateLimited === true
      && error.rateLimitKind === 'primary',
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

test('403 只带 Retry-After 不算二级限流（避免误报）', async () => {
  globalThis.fetch = async () => new Response('{"message":"Resource not accessible by personal access token"}', {
    status: 403,
    headers: { 'Retry-After': '60', 'X-RateLimit-Remaining': '4999' },
  });
  const api = new GitHubApi({ owner: 'owner', repo: 'retry-after-only', token: 'dummy', ref: 'master' });
  await assert.rejects(
    api.raw('config.json'),
    (error) => error instanceof ApiError
      && !/二级限流/.test(error.message)
      && /读取权限/.test(error.message)
      && error.rateLimited === false,
  );
});

test('403 主限流即使带 Retry-After 也不误报成二级限流', async () => {
  globalThis.fetch = async () => new Response('{"message":"API rate limit exceeded for user ID 1"}', {
    status: 403,
    headers: { 'Retry-After': '60', 'X-RateLimit-Remaining': '0' },
  });
  const api = new GitHubApi({ owner: 'owner', repo: 'primary-with-retry', token: 'dummy', ref: 'master' });
  await assert.rejects(
    api.raw('config.json'),
    (error) => error instanceof ApiError
      && /每小时 5000 次/
      && !/二级限流/.test(error.message),
  );
});

test('429 也统一提示限流，而不是「GitHub 返回 429」', async () => {
  globalThis.fetch = async () => new Response('{"message":"Too Many Requests"}', { status: 429 });
  const api = new GitHubApi({ owner: 'owner', repo: 'too-many', token: 'dummy', ref: 'master' });
  await assert.rejects(
    api.raw('config.json'),
    (error) => error instanceof ApiError
      && /限流/.test(error.message)
      && error.rateLimited === true
      && error.rateLimitKind === 'unknown',
  );
});

test('写操作前确认私有：公开仓库不派发', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(`${init.method || 'GET'} ${u}`);
    if (u.endsWith('/repos/owner/public-write')) return json({ private: false });
    throw new Error(`不应访问：${u}`);
  };
  const api = new GitHubApi({ owner: 'owner', repo: 'public-write', token: 'dummy', ref: 'main' });
  await assert.rejects(api.dispatch('checkin.yml', {}), (error) => error instanceof PublicRepoError);
  assert.equal(calls.some((line) => line.includes('/dispatches')), false);
});

test('写操作前确认私有：隐私状态未知时禁止写入', async () => {
  let dispatched = false;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/repos/owner/unknown-private')) {
      return json({ message: 'Resource not accessible' }, 403);
    }
    if (u.includes('/dispatches')) { dispatched = true; return new Response(null, { status: 204 }); }
    throw new Error(`不应访问：${u}`);
  };
  const api = new GitHubApi({ owner: 'owner', repo: 'unknown-private', token: 'dummy', ref: 'main' });
  await assert.rejects(api.dispatch('checkin.yml', {}), (error) => error instanceof ApiError);
  assert.equal(dispatched, false);
});

test('确认私有后才真正派发', async () => {
  let dispatched = false;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/repos/owner/private-write')) {
      return json({ private: true, permissions: { push: true } });
    }
    if (u.includes('/dispatches')) {
      dispatched = true;
      assert.equal(init.method, 'POST');
      return new Response(null, { status: 204 });
    }
    throw new Error(`不应访问：${u}`);
  };
  const api = new GitHubApi({ owner: 'owner', repo: 'private-write', token: 'dummy', ref: 'main' });
  await api.dispatch('checkin.yml', { request_id: 'abcd1234' });
  assert.equal(dispatched, true);
});

test('putFile：公开仓库拒绝上传', async () => {
  let put = false;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/repos/owner/public-upload')) return json({ private: false });
    if (init.method === 'PUT') { put = true; return json({}); }
    throw new Error(`不应访问：${u}`);
  };
  const api = new GitHubApi({ owner: 'owner', repo: 'public-upload', token: 'dummy', ref: 'main' });
  await assert.rejects(api.putFile('uploads/hevy/a.csv', 'AA==', 'x'), (error) => error instanceof PublicRepoError);
  assert.equal(put, false);
});

test('deleteFile：只允许删 uploads/ 下的文件', async () => {
  const api = new GitHubApi({ owner: 'owner', repo: 'repo', token: 'dummy', ref: 'main' });
  await assert.rejects(api.deleteFile('data/diet.csv', 'x'), /uploads/);
  await assert.rejects(api.deleteFile('uploads/../data/diet.csv', 'x'), /uploads/);
});

test('request_id 是 32 位小写十六进制且不重复', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const id = newRequestId();
    assert.match(id, /^[0-9a-f]{32}$/);
    seen.add(id);
  }
  assert.ok(seen.size >= 499);
});

test('request_id 使用 crypto.getRandomValues，不用 Math.random', () => {
  const originalRandom = Math.random;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const lengths = [];
  Math.random = () => { throw new Error('不应使用 Math.random'); };
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      getRandomValues(array) {
        lengths.push(array.length);
        array.fill(0xab);
        return array;
      },
    },
    configurable: true,
  });
  try {
    assert.equal(newRequestId(), 'ab'.repeat(16));
    assert.deepEqual(lengths, [16]);
  } finally {
    Math.random = originalRandom;
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  }
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

test('resolveBranch：填了用填的，没填用默认分支，最后兜底 main', () => {
  assert.equal(resolveBranch('', 'main'), 'main');
  assert.equal(resolveBranch('  dev  ', 'main'), 'dev');
  assert.equal(resolveBranch(undefined, 'master'), 'master');
  assert.equal(resolveBranch(undefined, ''), 'main');
  assert.equal(resolveBranch(null, undefined), 'main');
});

test('pickBranch：用户填的分支没有 config 时回退到仓库默认分支', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('ref=typo')) return json({ message: 'Not Found' }, 404);
    if (u.includes('ref=main')) return raw('{"athlete":{"weight_kg":70}}');
    throw new Error(`不应访问：${u}`);
  };
  const picked = await pickBranch({ owner: 'owner', repo: 'fallback-default', token: 'dummy', ref: 'typo' }, 'main');
  assert.equal(picked.branch, 'main');
  assert.equal(picked.api.cfg.ref, 'main');
  assert.equal(seen.length, 2);
  assert.ok(seen.every((u) => u.includes('/contents/config.json')));
});

test('pickBranch：没有默认分支信息时先试 main 再试 master', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('ref=main')) return json({ message: 'Not Found' }, 404);
    if (u.includes('ref=master')) return raw('{}');
    throw new Error(`不应访问：${u}`);
  };
  const picked = await pickBranch({ owner: 'owner', repo: 'legacy-master', token: 'dummy', ref: '' }, undefined);
  assert.equal(picked.branch, 'master');
});

test('pickBranch：账号错误不换分支重试', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return json({ message: 'Bad credentials' }, 401);
  };
  await assert.rejects(
    pickBranch({ owner: 'owner', repo: 'bad-pat', token: 'dummy', ref: 'main' }, 'main'),
    (error) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(calls, 1);
});

test('pickBranch：所有候选分支都没有 config 时报分支错误', async () => {
  globalThis.fetch = async () => json({ message: 'Not Found' }, 404);
  await assert.rejects(
    pickBranch({ owner: 'owner', repo: 'no-config', token: 'dummy', ref: '' }, undefined),
    (error) => error instanceof ApiError
      && error.status === 404
      && /config\.json/.test(error.message),
  );
});

test('putFile：只有 404 按新文件处理，403/429/500 都中止', async () => {
  const scenarios = [
    { meta: () => json({ message: 'Not Found' }, 404), shouldPut: true },
    { meta: () => json({ message: 'Forbidden' }, 403), shouldPut: false },
    { meta: () => json({ message: 'Too Many Requests' }, 429), shouldPut: false },
    { meta: () => json({ message: 'boom' }, 500), shouldPut: false },
  ];
  for (const item of scenarios) {
    let put = false;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/repos/owner/put-repo')) return json({ private: true });
      if (init.method === 'PUT') { put = true; return json({ content: { sha: 'x' } }); }
      if (u.includes('/contents/uploads/')) return item.meta();
      throw new Error(`不应访问：${u}`);
    };
    const api = new GitHubApi({ owner: 'owner', repo: 'put-repo', token: 'dummy', ref: 'main' });
    if (item.shouldPut) {
      await api.putFile('uploads/hevy/a.csv', 'AA==', 'upload');
      assert.equal(put, true);
    } else {
      await assert.rejects(api.putFile('uploads/hevy/a.csv', 'AA==', 'upload'));
      assert.equal(put, false);
    }
  }
});

test('putFile：查询 SHA 时网络异常中止，不发 PUT', async () => {
  let put = false;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/repos/owner/put-net')) return json({ private: true });
    if (init.method === 'PUT') { put = true; return json({}); }
    if (u.includes('/contents/uploads/')) throw new TypeError('fetch failed');
    throw new Error(`不应访问：${u}`);
  };
  const api = new GitHubApi({ owner: 'owner', repo: 'put-net', token: 'dummy', ref: 'main' });
  await assert.rejects(api.putFile('uploads/hevy/a.csv', 'AA==', 'upload'), /fetch failed/);
  assert.equal(put, false);
});

test('putFile：已存在文件必须带上 sha', async () => {
  let body = null;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/repos/owner/put-sha')) return json({ private: true });
    if (init.method === 'PUT') { body = JSON.parse(String(init.body)); return json({}); }
    if (u.includes('/contents/uploads/')) return json({ sha: 'abc123' });
    throw new Error(`不应访问：${u}`);
  };
  const api = new GitHubApi({ owner: 'owner', repo: 'put-sha', token: 'dummy', ref: 'main' });
  await api.putFile('uploads/hevy/a.csv', 'AA==', 'upload');
  assert.equal(body.sha, 'abc123');
});

test('deleteFile：成功删除带 sha，文件不存在视为成功，403 报错', async () => {
  let deleted = false;
  let body = null;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/repos/owner/del-repo')) return json({ private: true });
    if (init.method === 'DELETE') { deleted = true; body = JSON.parse(String(init.body)); return json({}); }
    if (u.includes('/contents/uploads/')) return json({ sha: 'sha1' });
    throw new Error(`不应访问：${u}`);
  };
  await new GitHubApi({ owner: 'owner', repo: 'del-repo', token: 'dummy', ref: 'main' })
    .deleteFile('uploads/hevy/a.csv', 'cleanup');
  assert.equal(deleted, true);
  assert.equal(body.sha, 'sha1');

  deleted = false;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/repos/owner/del-missing')) return json({ private: true });
    if (init.method === 'DELETE') { deleted = true; return json({}); }
    if (u.includes('/contents/uploads/')) return json({ message: 'Not Found' }, 404);
    throw new Error(`不应访问：${u}`);
  };
  await new GitHubApi({ owner: 'owner', repo: 'del-missing', token: 'dummy', ref: 'main' })
    .deleteFile('uploads/hevy/a.csv', 'cleanup');
  assert.equal(deleted, false);

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/repos/owner/del-403')) return json({ private: true });
    if (init.method === 'DELETE') return json({ message: 'Forbidden' }, 403);
    if (u.includes('/contents/uploads/')) return json({ sha: 'sha1' });
    throw new Error(`不应访问：${u}`);
  };
  await assert.rejects(
    new GitHubApi({ owner: 'owner', repo: 'del-403', token: 'dummy', ref: 'main' })
      .deleteFile('uploads/hevy/a.csv', 'cleanup'),
    /Contents/,
  );
});

test('缓存键按账户、仓库、分支隔离', () => {
  const a = new GitHubApi({ owner: 'a', repo: 'r', token: 't', ref: 'main' });
  const b = new GitHubApi({ owner: 'b', repo: 'r', token: 't', ref: 'main' });
  const c = new GitHubApi({ owner: 'a', repo: 'r', token: 't', ref: 'dev' });
  assert.notEqual(a.cacheKey('config.json'), b.cacheKey('config.json'));
  assert.notEqual(a.cacheKey('config.json'), c.cacheKey('config.json'));
});

test('urlFor 使用传入的分支，不写死 master', () => {
  const api = new GitHubApi({ owner: 'owner', repo: 'repo', token: 'dummy', ref: 'main' });
  assert.match(api.urlFor('config.json'), /ref=main/);
});
