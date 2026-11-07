// @ts-check
/** 统一提交队列：持久化、恢复、状态与 Hevy 上传恢复：node --test web/tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertLease, clearLocalState, discardTask, dropOtherScopes, enqueue, enqueueHevyImport,
  hevyRecoveryTasks, isLeaseExpired, lastCleanupPersistError, pendingCleanups, pendingSummary,
  pruneStaleTasks, receiptOnlyCount, resumeTaskById, resumeUnfinished, runCleanups, setQueueScope,
  shouldRenewLease, taskKindLabel, taskStatusLabel, unsentCount, unsentTasks, withWriteLock,
} from '../js/queue.js';

class MemoryStorage {
  constructor() { this.map = new Map(); this.failWith = null; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) {
    if (this.failWith) {
      const error = new Error(this.failWith.message ?? 'write failed');
      error.name = this.failWith.name ?? 'Error';
      throw error;
    }
    this.map.set(key, String(value));
  }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

function freshEnv() {
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.localStorage = new MemoryStorage();
  setQueueScope(null);
}

/**
 * 极简 IndexedDB：同一数据库的 readwrite 事务串行执行，
 * 用来验证「读 → 判断 → 写」在同一个事务里是原子的。
 */
class FakeIndexedDB {
  constructor() { this.dbs = new Map(); this.failNextTransactions = 0; }

  reset() {
    this.failNextTransactions = 0;
    for (const state of this.dbs.values()) {
      state.data.clear();
      state.chain = Promise.resolve();
    }
  }

  /** @param {string} name */
  open(name) {
    if (!this.dbs.has(name)) {
      this.dbs.set(name, { data: new Map(), chain: Promise.resolve() });
    }
    const state = this.dbs.get(name);
    const request = {};
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => {},
      close: () => {},
      transaction: () => {
        if (this.failNextTransactions > 0) {
          this.failNextTransactions -= 1;
          return failingTx();
        }
        return makeTx(state);
      },
    };
    setTimeout(() => {
      request.result = db;
      request.onsuccess?.();
    }, 0);
    return request;
  }
}

/** @param {{data: Map<string, any>, chain: Promise<void>}} state */
function makeTx(state) {
  const tx = {};
  const ops = [];
  const store = {
    get(key) {
      const req = {};
      ops.push(() => {
        req.result = state.data.has(key) ? structuredClone(state.data.get(key)) : undefined;
        queueMicrotask(() => req.onsuccess?.());
      });
      return req;
    },
    put(value, key) {
      const req = {};
      ops.push(() => {
        state.data.set(key, structuredClone(value));
        queueMicrotask(() => req.onsuccess?.());
      });
      return req;
    },
    delete(key) {
      const req = {};
      ops.push(() => {
        state.data.delete(key);
        queueMicrotask(() => req.onsuccess?.());
      });
      return req;
    },
  };

  const previous = state.chain;
  let release;
  state.chain = new Promise((resolve) => { release = resolve; });
  previous.then(async () => {
    for (const op of ops) {
      op();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    tx.oncomplete?.();
    release();
  });

  return {
    objectStore: () => store,
    get oncomplete() { return tx.oncomplete; },
    set oncomplete(fn) { tx.oncomplete = fn; },
    get onerror() { return tx.onerror; },
    set onerror(fn) { tx.onerror = fn; },
    get onabort() { return tx.onabort; },
    set onabort(fn) { tx.onabort = fn; },
  };
}

/** 事务直接失败，用于模拟 IndexedDB 暂时不可用。 */
function failingTx() {
  const tx = {};
  const store = { get: () => ({}), put: () => ({}), delete: () => ({}) };
  setTimeout(() => tx.onerror?.(), 0);
  return {
    objectStore: () => store,
    get oncomplete() { return tx.oncomplete; },
    set oncomplete(fn) { tx.oncomplete = fn; },
    get onerror() { return tx.onerror; },
    set onerror(fn) { tx.onerror = fn; },
    get onabort() { return tx.onabort; },
    set onabort(fn) { tx.onabort = fn; },
  };
}

const testIdb = new FakeIndexedDB();

/** 强制走 IndexedDB 兜底（临时去掉 navigator.locks）。 */
function useIdbLease() {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.indexedDB = testIdb;
  Object.defineProperty(globalThis, 'navigator', { value: { locks: undefined }, configurable: true });
  return () => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
    delete globalThis.__AFC_LEASE_MS__;
    testIdb.reset();
  };
}

/** @param {any} lease */
function seedLease(lease) {
  if (!testIdb.dbs.has('afc-locks')) {
    testIdb.dbs.set('afc-locks', { data: new Map(), chain: Promise.resolve() });
  }
  testIdb.dbs.get('afc-locks').data.set('write-lock', lease);
}

function currentLease() {
  return testIdb.dbs.get('afc-locks')?.data.get('write-lock') ?? null;
}

/** 构造一条已上传的 Hevy 任务，用于清理/放弃测试。 */
function seedUploadedTask(overrides = {}) {
  const now = new Date().toISOString();
  const task = {
    id: 'q-hevy',
    kind: 'hevy-import',
    workflow: 'import_hevy_csv.yml',
    requestId: 'cccccccc',
    status: 'unknown',
    uploadPath: 'uploads/hevy/x.csv',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  sessionStorage.setItem('afc.queue.v2', JSON.stringify([task]));
  localStorage.setItem('afc.hevy.recovery.v1', JSON.stringify([{
    requestId: task.requestId,
    path: task.uploadPath,
    workflow: task.workflow,
    createdAt: task.createdAt,
    status: 'uploaded',
  }]));
  return task;
}

/** @param {any} [overrides] */
function makeApi(overrides = {}) {
  const calls = { dispatch: 0, upload: 0, finds: 0 };
  const api = {
    calls,
    async findRunOnce(id) {
      calls.finds += 1;
      return overrides.findRunOnce ? overrides.findRunOnce(id, calls) : null;
    },
    async dispatch(workflow, inputs) {
      calls.dispatch += 1;
      if (overrides.dispatch) return overrides.dispatch(workflow, inputs);
      return undefined;
    },
    async findRun() {
      return overrides.findRun ? overrides.findRun() : null;
    },
    async runStatus() {
      return overrides.runStatus ? overrides.runStatus() : { id: 1, status: 'completed', conclusion: 'success' };
    },
    async putFile(path, base64, message) {
      calls.upload += 1;
      if (overrides.putFile) return overrides.putFile(path, base64, message);
      return {};
    },
  };
  return api;
}

const completedSuccess = { id: 1, status: 'completed', conclusion: 'success', html_url: 'https://example.test/run/1' };

test('成功任务：写入后从队列移除', async () => {
  freshEnv();
  const api = makeApi({ findRun: () => completedSuccess });
  const queued = enqueue(api, { workflow: 'checkin.yml', inputs: { date: '2026-11-07' } });
  assert.equal(unsentCount(), 1);
  const result = await queued.promise;
  assert.equal(result.state, 'success');
  assert.equal(api.calls.dispatch, 1);
  assert.equal(unsentCount(), 0);
});

test('unknown：任务保留，刷新后能按原 request_id 恢复且不重复派发', async () => {
  freshEnv();
  const api = makeApi();
  const queued = enqueue(api, { workflow: 'diet.yml', inputs: { kcal: '2000' }, findTimeoutMs: 0 });
  const result = await queued.promise;
  assert.equal(result.state, 'unknown');
  assert.equal(unsentCount(), 1);
  const task = unsentTasks()[0];
  assert.equal(task.status, 'unknown');
  assert.match(task.requestId, /^[0-9a-f]{8}$/);

  const resumeApi = makeApi({ findRunOnce: () => completedSuccess });
  const resumed = await resumeUnfinished(resumeApi);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].result.state, 'success');
  assert.equal(resumeApi.calls.dispatch, 0);
  assert.equal(unsentCount(), 0);
});

test('timeout：运行超过等待时间时保留任务', async () => {
  freshEnv();
  const running = { id: 9, status: 'in_progress' };
  const api = makeApi({
    findRunOnce: () => running,
    runStatus: () => running,
  });
  const queued = enqueue(api, {
    workflow: 'weekly.yml',
    inputs: {},
    runTimeoutMs: 15,
    pollMs: 1,
  });
  const result = await queued.promise;
  assert.equal(result.state, 'timeout');
  assert.equal(unsentCount(), 1);
  assert.equal(unsentTasks()[0].status, 'timeout');
});

test('取消：属于终态，任务移除', async () => {
  freshEnv();
  const api = makeApi({
    findRunOnce: () => ({ id: 2, status: 'completed', conclusion: 'cancelled' }),
  });
  const result = await enqueue(api, { workflow: 'cardio.yml', inputs: {} }).promise;
  assert.equal(result.state, 'cancelled');
  assert.equal(unsentCount(), 0);
});

test('Hevy 导入：不把 CSV 内容写进 storage；上传成功后记录路径', async () => {
  freshEnv();
  const api = makeApi({ findRun: () => completedSuccess });
  const file = {
    name: 'hevy.csv',
    arrayBuffer: async () => new TextEncoder().encode('date,exercise\nSECRET-CSV-CONTENT').buffer,
  };
  const queued = enqueueHevyImport(api, file, () => {});
  assert.equal(unsentCount(), 1);
  const result = await queued.promise;
  assert.equal(result.state, 'success');
  assert.equal(api.calls.upload, 1);
  assert.equal(unsentCount(), 0);
  assert.equal(hevyRecoveryTasks().length, 0);
  const sessionText = JSON.stringify([...globalThis.sessionStorage.map.values()]);
  const localText = JSON.stringify([...globalThis.localStorage.map.values()]);
  assert.equal(sessionText.includes('SECRET-CSV-CONTENT'), false);
  assert.equal(localText.includes('SECRET-CSV-CONTENT'), false);
});

test('Hevy 导入：上传后派发失败可关页面恢复，沿用原 request_id', async () => {
  freshEnv();
  const networkError = new Error('网络不通');
  // @ts-ignore 模拟 fetch 失败（没有 HTTP 状态）
  networkError.status = 0;
  const api = makeApi({
    dispatch: () => { throw networkError; },
  });
  const file = {
    name: 'hevy.csv',
    arrayBuffer: async () => new TextEncoder().encode('date,exercise').buffer,
  };
  const queued = enqueueHevyImport(api, file, () => {});
  await assert.rejects(queued.promise, /网络不通/);
  const task = unsentTasks()[0];
  assert.ok(task.uploadPath?.startsWith('uploads/hevy/'));
  assert.equal(task.status, 'unknown');
  assert.equal(hevyRecoveryTasks().length, 1);
  const requestId = task.requestId;

  // 模拟关掉标签页：sessionStorage 清空，只剩 localStorage 里的上传路径
  globalThis.sessionStorage.clear();
  const resumeApi = makeApi({ findRunOnce: () => completedSuccess });
  const resumed = await resumeUnfinished(resumeApi);
  assert.equal(resumed[0].task.requestId, requestId);
  assert.equal(resumeApi.calls.dispatch, 0);
  assert.equal(unsentCount(), 0);
  assert.equal(hevyRecoveryTasks().length, 0);
});

test('Hevy 上传失败：任务移除并提示重新选择文件', async () => {
  freshEnv();
  const api = makeApi({
    putFile: () => { throw Object.assign(new Error('PAT 缺少 Contents 写权限'), { status: 403 }); },
  });
  const file = { name: 'hevy.csv', arrayBuffer: async () => new ArrayBuffer(4) };
  const queued = enqueueHevyImport(api, file, () => {});
  await assert.rejects(queued.promise, /重新选择文件/);
  assert.equal(unsentCount(), 0);
  assert.equal(hevyRecoveryTasks().length, 0);
});

test('关页面后：只凭 localStorage 凭证确认结果，且不含健康数据', async () => {
  freshEnv();
  const api = makeApi();
  const queued = enqueue(api, {
    workflow: 'diet.yml',
    inputs: { kcal: '1999' },
    findTimeoutMs: 0,
  });
  const result = await queued.promise;
  assert.equal(result.state, 'unknown');
  const requestId = queued.task.requestId;
  assert.equal(receiptOnlyCount(), 0); // 会话任务还在时不算“只有凭证”

  // 模拟关掉标签页：sessionStorage 清空，只留 localStorage 凭证
  globalThis.sessionStorage.clear();
  assert.equal(receiptOnlyCount(), 1);
  assert.equal(unsentCount(), 1);
  const localText = JSON.stringify([...globalThis.localStorage.map.values()]);
  assert.equal(localText.includes('1999'), false, '凭证里不能出现表单健康数据');

  const resumeApi = makeApi({ findRunOnce: () => completedSuccess });
  const resumed = await resumeUnfinished(resumeApi);
  assert.equal(resumed[0].receipt.requestId, requestId);
  assert.equal(resumed[0].result.state, 'success');
  assert.equal(receiptOnlyCount(), 0);
  assert.equal(unsentCount(), 0);
});

test('轮询期间断网：不判定失败，网络恢复后继续', async () => {
  freshEnv();
  let polls = 0;
  const running = { id: 7, status: 'in_progress' };
  const api = makeApi({
    findRunOnce: () => running,
    runStatus: () => {
      polls += 1;
      if (polls < 2) throw new Error('network down');
      return { id: 7, status: 'completed', conclusion: 'success' };
    },
  });
  const result = await enqueue(api, {
    workflow: 'checkin.yml',
    inputs: {},
    runTimeoutMs: 500,
    pollMs: 1,
  }).promise;
  assert.equal(result.state, 'success');
  assert.equal(polls, 2);
  assert.equal(unsentCount(), 0);
});

test('派发响应丢失：按原 request_id 找回运行，不重复派发', async () => {
  freshEnv();
  let lookups = 0;
  const api = makeApi({
    findRunOnce: () => {
      lookups += 1;
      return lookups === 1 ? null : { id: 3, status: 'completed', conclusion: 'success' };
    },
    dispatch: () => { throw Object.assign(new Error('网络中断'), { status: 0 }); },
  });
  const result = await enqueue(api, { workflow: 'body.yml', inputs: {} }).promise;
  assert.equal(result.state, 'success');
  assert.equal(api.calls.dispatch, 1);
  assert.equal(unsentCount(), 0);
});

test('连续提交多个任务：串行派发，全部完成后移除', async () => {
  freshEnv();
  const api = makeApi({ findRun: () => completedSuccess });
  const a = enqueue(api, { workflow: 'checkin.yml', inputs: {} });
  const b = enqueue(api, { workflow: 'diet.yml', inputs: {} });
  const [ra, rb] = await Promise.all([a.promise, b.promise]);
  assert.equal(ra.state, 'success');
  assert.equal(rb.state, 'success');
  assert.equal(api.calls.dispatch, 2);
  assert.equal(unsentCount(), 0);
});

test('多标签页：Web Locks 串行执行，不会同时派发', async () => {
  freshEnv();
  const order = [];
  let lockChain = Promise.resolve();
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: {
        request(_name, _opts, fn) {
          const run = lockChain.then(() => fn());
          lockChain = run.then(() => undefined, () => undefined);
          return run;
        },
      },
    },
  });
  try {
    await Promise.all([
      withWriteLock(async () => {
        order.push('start-a');
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('end-a');
      }),
      withWriteLock(async () => {
        order.push('start-b');
      }),
    ]);
    assert.deepEqual(order, ['start-a', 'end-a', 'start-b']);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: original });
  }
});

test('discardTask：人工放弃后不再出现在未完成列表', async () => {
  freshEnv();
  const api = makeApi();
  const queued = enqueue(api, { workflow: 'body.yml', inputs: {}, findTimeoutMs: 0 });
  await queued.promise;
  assert.equal(unsentCount(), 1);
  await discardTask(unsentTasks()[0].id);
  assert.equal(unsentCount(), 0);
});

test('resumeTaskById：未知 id 给出明确错误', async () => {
  freshEnv();
  await assert.rejects(resumeTaskById(makeApi(), 'not-exist'), /已经结束或不存在/);
});

test('pendingSummary：展示任务类型、状态和提交时间', () => {
  const summary = pendingSummary([
    { id: 'a', kind: 'hevy-import', status: 'uploaded', createdAt: '2026-11-07T10:00:00Z' },
    { id: 'b', kind: 'checkin', status: 'running', createdAt: '2026-11-07T10:01:00Z' },
  ]);
  assert.equal(summary.items[0].label, 'Hevy 导入');
  assert.equal(summary.items[0].statusLabel, '已上传，待确认');
  assert.equal(summary.items[1].label, '打卡');
  assert.equal(summary.items[1].statusLabel, '提交中');
  assert.equal(summary.items[0].createdAt, '2026-11-07T10:00:00Z');
  assert.equal(summary.needsCheck, true);
});

test('任务按仓库作用域隔离，不会恢复到别的账户', async () => {
  freshEnv();
  setQueueScope('a/b@main');
  await enqueue(makeApi(), { workflow: 'body.yml', inputs: {}, findTimeoutMs: 0 }).promise;
  assert.equal(unsentCount(), 1);

  setQueueScope('c/d@main');
  assert.equal(unsentCount(), 0);
  assert.equal(unsentTasks().length, 0);

  setQueueScope('a/b@main');
  assert.equal(unsentCount(), 1);
});

test('切换账户时清掉其他作用域的恢复任务', async () => {
  freshEnv();
  setQueueScope('a/b@main');
  await enqueue(makeApi(), { workflow: 'body.yml', inputs: {}, findTimeoutMs: 0 }).promise;

  setQueueScope('c/d@main');
  dropOtherScopes();
  setQueueScope('a/b@main');
  assert.equal(unsentCount(), 0);
});

test('过期任务会被清理，新任务保留', () => {
  freshEnv();
  const old = {
    id: 'q-old', workflow: 'body.yml', requestId: 'aaaaaaaa', status: 'unknown',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  const now = new Date().toISOString();
  const fresh = {
    id: 'q-new', workflow: 'body.yml', requestId: 'bbbbbbbb', status: 'unknown',
    createdAt: now, updatedAt: now,
  };
  sessionStorage.setItem('afc.queue.v2', JSON.stringify([old, fresh]));
  assert.equal(pruneStaleTasks(), 1);
  assert.deepEqual(unsentTasks().map((task) => task.id), ['q-new']);
});

test('退出登录时清空队列、凭证与租约', async () => {
  freshEnv();
  await enqueue(makeApi(), { workflow: 'body.yml', inputs: {}, findTimeoutMs: 0 }).promise;
  localStorage.setItem('afc.queue.lease.v1', JSON.stringify({ id: 'x', until: Date.now() + 1000 }));
  clearLocalState();
  assert.equal(unsentCount(), 0);
  assert.equal(localStorage.getItem('afc.queue.lease.v1'), null);
  assert.equal(sessionStorage.getItem('afc.queue.v2'), null);
});

test('租约判定：过期与续期', () => {
  assert.equal(isLeaseExpired(null), true);
  assert.equal(isLeaseExpired({ until: Date.now() - 1 }), true);
  assert.equal(isLeaseExpired({ until: Date.now() + 60_000 }), false);
  assert.equal(shouldRenewLease({ id: 'me', until: Date.now() + 1000 }, 'me'), true);
  assert.equal(shouldRenewLease({ id: 'other', until: Date.now() + 1000 }, 'me'), false);
});

test('IndexedDB 原子锁：两个标签页同时抢过期租约，只有一个持锁', async () => {
  freshEnv();
  const restore = useIdbLease();
  try {
    // 模拟上一个标签页崩溃留下的过期租约
    seedLease({ id: 'dead-tab', until: Date.now() - 1000 });
    const A = await import('../js/queue.js?tab=a');
    const B = await import('../js/queue.js?tab=b');
    let holders = 0;
    let maxHolders = 0;
    const job = (mod) => mod.withWriteLock(async () => {
      holders += 1;
      maxHolders = Math.max(maxHolders, holders);
      await new Promise((resolve) => setTimeout(resolve, 50));
      holders -= 1;
    });
    await Promise.all([job(A), job(B)]);
    assert.equal(maxHolders, 1);
    assert.equal(currentLease(), null);
  } finally {
    restore();
  }
});

test('标签页崩溃：租约过期后其他标签页可以接手', async () => {
  freshEnv();
  const restore = useIdbLease();
  try {
    seedLease({ id: 'crashed-tab', until: Date.now() - 1 });
    const value = await withWriteLock(async () => 'ok');
    assert.equal(value, 'ok');
    assert.equal(currentLease(), null);
  } finally {
    restore();
  }
});

test('租约续期：任务超过租约时长仍持锁，结束后释放', async () => {
  freshEnv();
  const restore = useIdbLease();
  try {
    globalThis.__AFC_LEASE_MS__ = 120;
    await withWriteLock(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
      const lease = currentLease();
      assert.ok(lease, '任务进行中应该还有租约');
      assert.ok(lease.until > Date.now(), '心跳应该已续期，而不是等它过期');
    });
    assert.equal(currentLease(), null);
  } finally {
    restore();
  }
});

test('续期失败：任务能感知锁失效并拒绝继续', async () => {
  freshEnv();
  const restore = useIdbLease();
  try {
    globalThis.__AFC_LEASE_MS__ = 120;
    await withWriteLock(async () => {
      testIdb.failNextTransactions = 1; // 下一次心跳续期失败
      await new Promise((resolve) => setTimeout(resolve, 90));
      await assert.rejects(assertLease(), /写入锁/);
    });
  } finally {
    restore();
  }
});

test('租约被其他标签页接管后，原标签页不得继续派发', async () => {
  freshEnv();
  const restore = useIdbLease();
  try {
    await withWriteLock(async () => {
      seedLease({ id: 'other-tab', until: Date.now() + 60_000 });
      await assert.rejects(assertLease(), /接管|失效|过期/);
    });
  } finally {
    restore();
  }
});

test('两个标签页不能同时执行新的写入派发', async () => {
  freshEnv();
  const restore = useIdbLease();
  try {
    const A = await import('../js/queue.js?dispatch=a');
    const B = await import('../js/queue.js?dispatch=b');
    let active = 0;
    let maxActive = 0;
    const writes = [];
    const job = (mod, name) => mod.withWriteLock(async () => {
      await mod.assertLease();
      active += 1;
      maxActive = Math.max(maxActive, active);
      writes.push(name);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
    });
    await Promise.all([job(A, 'A'), job(B, 'B')]);
    assert.equal(maxActive, 1);
    assert.equal(writes.length, 2);
  } finally {
    restore();
  }
});

test('无法获取可靠锁时失败关闭，不执行写入', async () => {
  freshEnv();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { locks: undefined }, configurable: true });
  delete globalThis.indexedDB;
  let ran = false;
  try {
    // 新实例没有缓存过 IndexedDB 连接
    const mod = await import('../js/queue.js?noidb=1');
    await assert.rejects(
      mod.withWriteLock(async () => { ran = true; }),
      /无法获取写入锁/,
    );
    assert.equal(ran, false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
    globalThis.indexedDB = testIdb;
  }
});

test('已有未确认的 Hevy 导入时禁止再导入，避免重复写入', () => {
  freshEnv();
  const now = new Date().toISOString();
  sessionStorage.setItem('afc.queue.v2', JSON.stringify([{
    id: 'q-hevy', kind: 'hevy-import', workflow: 'import_hevy_csv.yml',
    requestId: 'cccccccc', status: 'unknown', uploadPath: 'uploads/hevy/x.csv',
    createdAt: now, updatedAt: now,
  }]));
  assert.throws(
    () => enqueueHevyImport(makeApi(), { name: 'hevy.csv', size: 10, type: 'text/csv' }, () => {}),
    /还有一次 Hevy 导入/,
  );
});

test('Hevy CSV 表头不对时本地拒绝，不上传', async () => {
  freshEnv();
  const api = makeApi();
  const file = {
    name: 'x.csv',
    size: 20,
    type: 'text/csv',
    slice: () => ({ text: async () => 'foo,bar' }),
  };
  const queued = enqueueHevyImport(api, file, () => {});
  await assert.rejects(queued.promise, /表头/);
  assert.equal(api.calls.upload, 0);
  assert.equal(unsentCount(), 0);
});

test('discardTask：远程删除成功后才清除任务与恢复记录', async () => {
  freshEnv();
  const task = seedUploadedTask();
  let deleted = '';
  const api = { async deleteFile(path) { deleted = path; } };
  const result = await discardTask(task.id, api);
  assert.equal(result.ok, true);
  assert.equal(deleted, 'uploads/hevy/x.csv');
  assert.equal(unsentCount(), 0);
  assert.equal(hevyRecoveryTasks().length, 0);
});

test('discardTask：远程删除失败保留任务、恢复记录和错误', async () => {
  freshEnv();
  const task = seedUploadedTask();
  const api = {
    async deleteFile() {
      throw Object.assign(new Error('PAT 缺少 Contents 写权限'), { status: 403 });
    },
  };
  const result = await discardTask(task.id, api);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Contents/);
  const remaining = unsentTasks()[0];
  assert.equal(remaining.id, task.id);
  assert.match(remaining.cleanupError ?? '', /Contents/);
  assert.equal(hevyRecoveryTasks().length, 1);
});

test('7 天过期：上传任务转入清理队列，不丢文件路径', () => {
  freshEnv();
  setQueueScope('a/b@main');
  seedUploadedTask({ createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
  assert.equal(pruneStaleTasks(), 1);
  assert.equal(unsentCount(), 0);
  const items = pendingCleanups();
  assert.equal(items.length, 1);
  assert.equal(items[0].path, 'uploads/hevy/x.csv');
  assert.equal(hevyRecoveryTasks().length, 0);
});

test('清理队列：成功移除索引，失败保留并记录错误', async () => {
  freshEnv();
  setQueueScope('a/b@main');
  localStorage.setItem('afc.cleanup.v1', JSON.stringify([{
    requestId: 'dddddddd', path: 'uploads/hevy/y.csv', scope: 'a/b@main',
  }]));

  const ok = await runCleanups({ async deleteFile() {} });
  assert.equal(ok[0].ok, true);
  assert.equal(pendingCleanups().length, 0);

  localStorage.setItem('afc.cleanup.v1', JSON.stringify([{
    requestId: 'eeeeeeee', path: 'uploads/hevy/z.csv', scope: 'a/b@main',
  }]));
  const bad = await runCleanups({ async deleteFile() { throw new Error('网络不通'); } });
  assert.equal(bad[0].ok, false);
  assert.equal(pendingCleanups().length, 1);
  assert.match(pendingCleanups()[0].lastError ?? '', /网络不通/);
});

test('清理队列持久化失败：保留任务与恢复记录，并给出错误', () => {
  freshEnv();
  setQueueScope('a/b@main');
  seedUploadedTask({ createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
  const store = globalThis.localStorage;
  store.failWith = { name: 'Error', message: 'setItem failed' };
  try {
    assert.equal(pruneStaleTasks(), 0);
    assert.equal(unsentCount(), 1);
    assert.equal(hevyRecoveryTasks().length, 1);
    assert.match(lastCleanupPersistError(), /setItem failed/);
  } finally {
    store.failWith = null;
  }
  // 存储恢复后，同一个任务仍能被正常转入清理队列
  assert.equal(pruneStaleTasks(), 1);
  assert.equal(pendingCleanups().length, 1);
});

test('存储配额不足：同样保留任务，不丢远程路径', () => {
  freshEnv();
  setQueueScope('a/b@main');
  seedUploadedTask({ createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
  const store = globalThis.localStorage;
  store.failWith = { name: 'QuotaExceededError', message: 'quota exceeded' };
  try {
    assert.equal(pruneStaleTasks(), 0);
    assert.equal(unsentCount(), 1);
    assert.equal(hevyRecoveryTasks().length, 1);
    assert.match(lastCleanupPersistError(), /配额/);
  } finally {
    store.failWith = null;
  }
});

test('localStorage 完全不可用：不删除本地任务', () => {
  freshEnv();
  setQueueScope('a/b@main');
  seedUploadedTask({ createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
  globalThis.localStorage = null;
  try {
    assert.equal(pruneStaleTasks(), 0);
    assert.equal(unsentCount(), 1);
    assert.match(lastCleanupPersistError(), /localStorage/);
  } finally {
    freshEnv();
  }
});

test('discardTask：没有 uploadPath 时可以直接放弃', async () => {
  freshEnv();
  const now = new Date().toISOString();
  sessionStorage.setItem('afc.queue.v2', JSON.stringify([{
    id: 'q-nopath', kind: 'checkin', workflow: 'checkin.yml',
    requestId: 'dddddddd', status: 'unknown', createdAt: now, updatedAt: now,
  }]));
  const result = await discardTask('q-nopath');
  assert.equal(result.ok, true);
  assert.equal(unsentCount(), 0);
});

test('discardTask：有 uploadPath 但没有 api 时保留任务和恢复记录', async () => {
  freshEnv();
  const task = seedUploadedTask();
  const result = await discardTask(task.id);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /没有可用的仓库连接/);
  assert.equal(unsentCount(), 1);
  assert.equal(hevyRecoveryTasks().length, 1);
  assert.match(unsentTasks()[0].cleanupError ?? '', /没有可用的仓库连接/);
});

test('Hevy 上传：Base64 转换后锁被接管，绝不调用 putFile', async () => {
  freshEnv();
  const restore = useIdbLease();
  try {
    const api = makeApi();
    const csv = 'start_time,exercise_title\n2026-11-07,Squat';
    const file = {
      name: 'hevy.csv',
      size: csv.length,
      type: 'text/csv',
      slice: () => ({ text: async () => csv }),
      arrayBuffer: async () => {
        // 模拟 Base64 转换期间另一个标签页接管租约
        seedLease({ id: 'other-tab', until: Date.now() + 60_000 });
        return new TextEncoder().encode(csv).buffer;
      },
    };
    const queued = enqueueHevyImport(api, file, () => {});
    await assert.rejects(queued.promise, /写入锁/);
    assert.equal(api.calls.upload, 0);
    // 任务保留，且因为还没上传，不能伪造 uploadPath
    assert.equal(unsentCount(), 1);
    assert.equal(unsentTasks()[0].uploadPath, undefined);
  } finally {
    restore();
  }
});

test('Hevy 上传：Base64 转换后锁仍有效时正常上传', async () => {
  freshEnv();
  const restore = useIdbLease();
  try {
    const csv = 'start_time,exercise_title\n2026-11-07,Squat';
    const file = {
      name: 'hevy.csv',
      size: csv.length,
      type: 'text/csv',
      slice: () => ({ text: async () => csv }),
      arrayBuffer: async () => new TextEncoder().encode(csv).buffer,
    };
    const api = makeApi({ findRun: () => completedSuccess });
    const queued = enqueueHevyImport(api, file, () => {});
    const result = await queued.promise;
    assert.equal(result.state, 'success');
    assert.equal(api.calls.upload, 1);
  } finally {
    restore();
  }
});

test('pendingSummary：终态不需要继续检查，未知类型有兜底文案', () => {
  const summary = pendingSummary([{ id: 'a', kind: 'diet', status: 'failure', createdAt: '' }]);
  assert.equal(summary.needsCheck, false);
  assert.equal(taskKindLabel('unknown-kind'), '提交');
  assert.equal(taskKindLabel(undefined), '提交');
  assert.equal(taskStatusLabel(undefined), '未知');
  assert.equal(pendingSummary([]).needsCheck, false);
});
