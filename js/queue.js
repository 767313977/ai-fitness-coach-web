// @ts-check
/** 提交队列：页面内一次只发一个写入请求，避免 GitHub 的 concurrency pending 被顶掉。
 *
 * 背景：7 个写工作流共用 `concurrency: repo-write`，GitHub 只保留「1 个运行中 + 1 个排队」，
 * 第 3 个会把排队那个取消。App 有完整队列；Web 版这里做最小实现：
 * - 全局串行，后面的请求排队；
 * - 结果 cancelled 时用同一个 request_id 自动重试一次（工作流有幂等闸）；
 * - 有请求未完成时关闭页面会提示。
 */
import { newRequestId } from './api.js';
import { runWorkflow } from './submit.js';

let chain = Promise.resolve();
let pending = 0;

// 队列落 sessionStorage：刷新后还能知道有哪些任务没发出去。
// 只存工作流名和 inputs，不存任何健康数据以外的内容；关掉标签页就清空。
const STORE_KEY = 'afc.queue.v1';

function readStore() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((item) => item && item.workflow && item.inputs)
      : [];
  } catch {
    return [];
  }
}

function writeStore(list) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    // 存不了就只在内存里排队
  }
}

function addStored(task) {
  const list = readStore();
  if (list.some((item) => item.id === task.id || item.requestId === task.requestId)) return;
  list.push(task);
  writeStore(list);
}

function removeStored(id) {
  writeStore(readStore().filter((item) => item.id !== id));
}

/** 刷新后还没发出去的任务（用于「上次有 N 条没发出去」提示）。 */
export function unsentTasks() {
  return readStore();
}

export function unsentCount() {
  return readStore().length;
}

export function pendingCount() {
  return pending;
}

export function hasPending() {
  return pending > 0;
}

/**
 * 把一个异步任务排进队列。
 * @template T
 * @param {() => Promise<T>} job
 * @returns {{position: number, promise: Promise<T>}}
 */
export function enqueueJob(job) {
  const position = pending;
  pending += 1;
  const run = chain.then(() => job()).finally(() => {
    pending -= 1;
  });
  // 队列本身不因为单个任务失败而断
  chain = run.then(() => undefined, () => undefined);
  return { position, promise: run };
}

/**
 * 排队派发一个工作流；cancelled 时用同一个 request_id 重试一次。
 * @param {import('./api.js').GitHubApi} api
 * @param {{workflow: string, inputs: Record<string,string>, requestId?: string,
 *          onStatus?: (s: string) => void, onStart?: () => void}} opts
 */
export function enqueue(api, opts) {
  const requestId = opts.requestId || newRequestId();
  const task = {
    id: opts.id || `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    workflow: opts.workflow,
    inputs: opts.inputs || {},
    requestId,
  };
  addStored(task);
  return enqueueJob(async () => {
    opts.onStart?.();
    opts.onStatus?.('提交中…');
    try {
      let result = await runWorkflow(api, { ...opts, requestId });
      if (result.state === 'cancelled') {
        opts.onStatus?.('被排队取消，用同一个 request_id 重试一次…');
        result = await runWorkflow(api, { ...opts, requestId });
      }
      return result;
    } finally {
      removeStored(task.id);
    }
  });
}

/**
 * 重发刷新前没跑完的任务；沿用原 request_id，工作流的幂等闸会挡住重复写入。
 * @param {import('./api.js').GitHubApi} api
 */
export async function resendUnsent(api) {
  const tasks = readStore();
  const results = [];
  for (const task of tasks) {
    try {
      const result = await enqueue(api, {
        workflow: task.workflow,
        inputs: task.inputs,
        requestId: task.requestId,
        id: task.id,
      }).promise;
      results.push({ task, result });
    } catch (error) {
      results.push({ task, error });
    }
  }
  return results;
}
