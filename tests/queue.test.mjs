// @ts-check
/** 统一提交队列：持久化、恢复、状态与 Hevy 上传恢复：node --test web/tests/ */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearLocalState, discardTask, dropOtherScopes, enqueue, enqueueHevyImport, hevyRecoveryTasks,
  isLeaseExpired, pendingSummary, pruneStaleTasks, receiptOnlyCount, resumeTaskById, resumeUnfinished,
  setQueueScope, taskKindLabel, taskStatusLabel, unsentCount, unsentTasks, withWriteLock,
} from '../js/queue.js';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

function freshEnv() {
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.localStorage = new MemoryStorage();
  setQueueScope(null);
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
  discardTask(unsentTasks()[0].id);
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

test('租约过期后可重新获取，心跳不会阻止进程退出', async () => {
  freshEnv();
  assert.equal(isLeaseExpired(null), true);
  assert.equal(isLeaseExpired({ until: Date.now() - 1 }), true);
  assert.equal(isLeaseExpired({ until: Date.now() + 60_000 }), false);

  // Node 自带 navigator.locks，这里强制走 localStorage 租约兜底路径
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { locks: undefined }, configurable: true });
  try {
    localStorage.setItem('afc.queue.lease.v1', JSON.stringify({ id: 'other-tab', until: Date.now() - 1000 }));
    const value = await withWriteLock(async () => 'ok');
    assert.equal(value, 'ok');
    assert.equal(localStorage.getItem('afc.queue.lease.v1'), null);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
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

test('pendingSummary：终态不需要继续检查，未知类型有兜底文案', () => {
  const summary = pendingSummary([{ id: 'a', kind: 'diet', status: 'failure', createdAt: '' }]);
  assert.equal(summary.needsCheck, false);
  assert.equal(taskKindLabel('unknown-kind'), '提交');
  assert.equal(taskKindLabel(undefined), '提交');
  assert.equal(taskStatusLabel(undefined), '未知');
  assert.equal(pendingSummary([]).needsCheck, false);
});
