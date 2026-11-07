// @ts-check
/** 提交一次写入：派发工作流 → 找到运行 → 轮询结果；以及 Hevy CSV 上传。
 *
 * 状态口径（队列持久化依赖它）：
 * - success / failure / cancelled：Actions 运行已结束，任务可以移除；
 * - timeout：运行还没结束（或轮询超时），任务必须保留；
 * - unknown：已派发但暂时找不到运行记录，任务必须保留，稍后再查。
 */
import { newRequestId, sleep } from './api.js';

export const RUN_STATE = {
  success: 'success',
  failure: 'failure',
  cancelled: 'cancelled',
  timeout: 'timeout',
  unknown: 'unknown',
};

/** @param {string|undefined|null} conclusion */
export function classifyConclusion(conclusion) {
  if (conclusion === 'success') return RUN_STATE.success;
  if (conclusion === 'cancelled') return RUN_STATE.cancelled;
  if (['failure', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(String(conclusion))) {
    return RUN_STATE.failure;
  }
  return RUN_STATE.unknown;
}

/** 只有真正拿到结束状态才算终态。 @param {string} state */
export function isTerminalState(state) {
  return state === RUN_STATE.success || state === RUN_STATE.failure || state === RUN_STATE.cancelled;
}

/**
 * 等待已有运行结束；超时返回 timeout，任务由队列保留。
 * @param {import('./api.js').GitHubApi} api
 * @param {any} run
 * @param {{requestId?: string, timeoutMs?: number, pollMs?: number,
 *          onStatus?: (s: string, detail?: any) => void}} [opts]
 */
export async function waitForRun(api, run, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 6 * 60_000;
  const pollMs = opts.pollMs ?? 5_000;
  let current = run;
  const started = Date.now();
  while (current.status !== 'completed') {
    if (Date.now() - started >= timeoutMs) {
      opts.onStatus?.('仍在运行', current);
      return { id: opts.requestId, state: RUN_STATE.timeout, run: current };
    }
    opts.onStatus?.('运行中', current);
    await sleep(pollMs);
    try {
      current = await api.runStatus(current.id);
    } catch (error) {
      // 网络抖动不判定失败：继续等，超时后由队列保留任务
      opts.onStatus?.('网络中断，继续等待', current);
    }
  }
  opts.onStatus?.('已完成', current);
  return { id: opts.requestId, state: classifyConclusion(current.conclusion), run: current };
}

/**
 * 派发或恢复一次工作流。
 * 先按 request_id 查已有运行，查到就不重复派发（多标签/刷新/网络重试都走这里）。
 * @param {import('./api.js').GitHubApi} api
 * @param {{workflow: string, inputs: Record<string,string>, requestId?: string,
 *          onStatus?: (s: string, detail?: any) => void,
 *          beforeDispatch?: () => Promise<void>,
 *          findTimeoutMs?: number, runTimeoutMs?: number, pollMs?: number}} opts
 */
export async function runWorkflow(api, opts) {
  const id = opts.requestId || newRequestId();
  const status = opts.onStatus || (() => {});

  status('核对是否已派发');
  let run;
  try {
    run = await api.findRunOnce(id);
  } catch (error) {
    // 查询失败 ≠ 没有历史任务：此时派发可能重复写入，必须先停下来让用户「继续检查」
    throw new Error(
      `无法确认这次提交是否已经派发（${error?.message ?? error}）。为避免重复写入，已停止派发；`
      + '网络恢复后点「继续检查」。',
    );
  }

  if (!run) {
    status('派发中');
    // 派发前必须再次确认写入锁仍属于当前标签页；锁丢了直接中止，不能当成“结果未知”再核对
    if (opts.beforeDispatch) await opts.beforeDispatch();
    try {
      await api.dispatch(opts.workflow, { ...opts.inputs, request_id: id });
    } catch (error) {
      // 网络异常：先按 request_id 再查一次，可能已经派发成功但响应丢了
      status('派发结果未知，正在核对…');
      try {
        run = await api.findRunOnce(id);
      } catch {
        // 连核对都失败：保留原始派发错误，任务会以 unknown 保留，不会自动重发
        throw error;
      }
      if (!run) throw error;
    }
  }

  if (!run) {
    status('等待 GitHub 接单');
    run = await api.findRun(id, {
      timeoutMs: opts.findTimeoutMs ?? 80_000,
      intervalMs: opts.pollMs ?? 4_000,
    });
  }
  if (!run) return { id, state: RUN_STATE.unknown, run: null };

  return waitForRun(api, run, {
    requestId: id,
    onStatus: status,
    timeoutMs: opts.runTimeoutMs,
    pollMs: opts.pollMs,
  });
}

/**
 * 刷新/重开后按 request_id 恢复：不派发新任务，只查已有运行。
 * @param {import('./api.js').GitHubApi} api
 * @param {{requestId: string, onStatus?: (s: string, detail?: any) => void,
 *          runTimeoutMs?: number, pollMs?: number}} opts
 */
export async function resumeWorkflow(api, opts) {
  opts.onStatus?.('查找已有运行');
  let run;
  try {
    run = await api.findRunOnce(opts.requestId);
  } catch (error) {
    // 查不到 ≠ 没派发：保留任务，交给队列标成 unknown，稍后再查
    throw new Error(`查询运行记录失败：${error?.message ?? error}`);
  }
  if (!run) return { id: opts.requestId, state: RUN_STATE.unknown, run: null };
  if (run.status === 'completed') {
    return { id: opts.requestId, state: classifyConclusion(run.conclusion), run };
  }
  return waitForRun(api, run, {
    requestId: opts.requestId,
    onStatus: opts.onStatus,
    timeoutMs: opts.runTimeoutMs,
    pollMs: opts.pollMs,
  });
}

/** @param {File} file */
export async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 运行结果 → 人能看懂的一句话 */
export function describeRun(result) {
  if (!result) return '没有拿到结果';
  switch (result.state) {
    case RUN_STATE.success:
      return '已写入';
    case RUN_STATE.failure:
      return '失败：去 Actions 看日志';
    case RUN_STATE.cancelled:
      return '已取消（工作流没有写入成功）';
    case RUN_STATE.timeout:
      return '仍在运行（超过等待时间），任务已保留，稍后点「继续检查」';
    case RUN_STATE.unknown:
      return '已派发但暂未找到运行记录，任务已保留，稍后点「继续检查」';
    default:
      return String(result.state);
  }
}
