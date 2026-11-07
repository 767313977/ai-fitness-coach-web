// @ts-check
/** 派发幂等：查询失败不能当成「没有历史任务」而重复派发 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resumeWorkflow, runWorkflow } from '../js/submit.js';

/** @param {any} [overrides] */
function makeApi(overrides = {}) {
  const calls = { find: 0, dispatch: 0 };
  return {
    calls,
    async findRunOnce() {
      calls.find += 1;
      if (overrides.findOnce) return overrides.findOnce(calls);
      return null;
    },
    async dispatch() {
      calls.dispatch += 1;
      if (overrides.dispatch) return overrides.dispatch(calls);
      return undefined;
    },
    async findRun() {
      return overrides.run ?? { id: 101, status: 'completed', conclusion: 'success' };
    },
    async runStatus() {
      return { id: 101, status: 'completed', conclusion: 'success' };
    },
  };
}

test('核对失败时停止派发，避免重复写入', async () => {
  const api = makeApi({
    findOnce: () => { throw new Error('GitHub 返回 403'); },
  });
  await assert.rejects(
    runWorkflow(api, { workflow: 'checkin.yml', inputs: {}, requestId: 'abcd1234' }),
    /无法确认/,
  );
  assert.equal(api.calls.dispatch, 0);
});

test('确认没有历史运行时才派发', async () => {
  const api = makeApi();
  const result = await runWorkflow(api, { workflow: 'checkin.yml', inputs: {}, requestId: 'abcd1234' });
  assert.equal(result.state, 'success');
  assert.equal(api.calls.dispatch, 1);
  assert.equal(api.calls.find, 1);
});

test('已有同一个 request_id 的运行时不重复派发', async () => {
  const api = makeApi({
    findOnce: () => ({ id: 7, status: 'completed', conclusion: 'success' }),
  });
  const result = await runWorkflow(api, { workflow: 'diet.yml', inputs: {}, requestId: 'abcd1234' });
  assert.equal(result.state, 'success');
  assert.equal(api.calls.dispatch, 0);
});

test('派发响应丢失但能查到运行：继续等结果，不再派发', async () => {
  let lookups = 0;
  const api = makeApi({
    findOnce: () => {
      lookups += 1;
      return lookups === 1 ? null : { id: 9, status: 'completed', conclusion: 'success' };
    },
    dispatch: () => { throw new Error('网络断开'); },
  });
  const result = await runWorkflow(api, { workflow: 'body.yml', inputs: {}, requestId: 'abcd1234' });
  assert.equal(result.state, 'success');
  assert.equal(api.calls.dispatch, 1);
});

test('派发失败且核对也失败：保留原错误，不重试', async () => {
  let lookups = 0;
  const api = makeApi({
    findOnce: () => {
      lookups += 1;
      if (lookups === 1) return null;
      throw new Error('又断了');
    },
    dispatch: () => { throw new Error('网络断开'); },
  });
  await assert.rejects(
    runWorkflow(api, { workflow: 'body.yml', inputs: {}, requestId: 'abcd1234' }),
    /网络断开/,
  );
  assert.equal(api.calls.dispatch, 1);
});

test('派发前的锁校验失败时立即中止，不派发也不重试', async () => {
  const api = makeApi();
  let guarded = 0;
  await assert.rejects(
    runWorkflow(api, {
      workflow: 'checkin.yml',
      inputs: {},
      requestId: 'abcd1234',
      beforeDispatch: async () => {
        guarded += 1;
        throw new Error('写入锁已失效');
      },
    }),
    /写入锁已失效/,
  );
  assert.equal(guarded, 1);
  assert.equal(api.calls.dispatch, 0);
  assert.equal(api.calls.find, 1);
});

test('resumeWorkflow：查询失败抛错，不伪装成 unknown', async () => {
  const api = makeApi({ findOnce: () => { throw new Error('403'); } });
  await assert.rejects(resumeWorkflow(api, { requestId: 'abcd1234' }), /查询运行记录失败/);
});

test('resumeWorkflow：确认没有运行时返回 unknown', async () => {
  const api = makeApi();
  const result = await resumeWorkflow(api, { requestId: 'abcd1234' });
  assert.equal(result.state, 'unknown');
});
