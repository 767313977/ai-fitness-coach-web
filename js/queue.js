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
  return enqueueJob(async () => {
    opts.onStart?.();
    opts.onStatus?.('提交中…');
    let result = await runWorkflow(api, { ...opts, requestId });
    if (result.state === 'cancelled') {
      opts.onStatus?.('被排队取消，用同一个 request_id 重试一次…');
      result = await runWorkflow(api, { ...opts, requestId });
    }
    return result;
  });
}
