// @ts-check
/** 提交一次写入：派发工作流 → 找到运行 → 轮询结果；以及 Hevy CSV 上传。 */
import { newRequestId, sleep } from './api.js';
import { enqueueJob } from './queue.js';

/**
 * @param {import('./api.js').GitHubApi} api
 * @param {{workflow: string, inputs: Record<string,string>, requestId?: string, onStatus?: (s: string, detail?: any) => void}} opts
 */
export async function runWorkflow(api, opts) {
  const id = opts.requestId || newRequestId();
  const status = opts.onStatus || (() => {});
  status('派发中');
  await api.dispatch(opts.workflow, { ...opts.inputs, request_id: id });

  status('等待 GitHub 接单');
  const run = await api.findRun(id, { timeoutMs: 80_000 });
  if (!run) return { id, state: 'unknown', run: null };

  let current = run;
  const started = Date.now();
  while (current.status !== 'completed' && Date.now() - started < 6 * 60_000) {
    status('运行中', current);
    await sleep(5_000);
    current = await api.runStatus(current.id);
  }
  status(current.status === 'completed' ? '已完成' : '超时', current);
  return { id, state: current.conclusion || current.status, run: current };
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

/**
 * 上传 Hevy CSV 到 uploads/hevy/，再派发导入。
 * 排进全局队列，避免和打卡/饮食同时触发把排队任务顶掉。
 * @param {import('./api.js').GitHubApi} api
 * @param {File} file
 * @param {(s: string) => void} onStatus
 * @param {() => void} [onStart]
 */
export function importHevy(api, file, onStatus, onStart) {
  const id = newRequestId();
  const { position, promise } = enqueueJob(async () => {
    onStart?.();
    onStatus(position ? `排队中（前面还有 ${position} 条）` : '上传 CSV');
    // 文件名统一小写 .csv，工作流路径校验是 ^uploads/hevy/[^/]+\.csv$
    const base = file.name.replace(/[^\w.\-]+/g, '_');
    const safeName = base.replace(/\.csv$/i, '') + '.csv';
    const path = `uploads/hevy/${id}-${safeName}`;
    const base64 = await fileToBase64(file);
    await api.putFile(path, base64, `upload: hevy [${id}]`);
    onStatus('已上传，派发导入');
    let result = await runWorkflow(api, {
      workflow: 'import_hevy_csv.yml',
      inputs: { path },
      requestId: id,
      onStatus,
    });
    if (result.state === 'cancelled') {
      onStatus('被排队取消，用同一个 request_id 重试一次…');
      result = await runWorkflow(api, {
        workflow: 'import_hevy_csv.yml',
        inputs: { path },
        requestId: id,
        onStatus,
      });
    }
    return result;
  });
  return { position, promise };
}

/**
 * API 模式下手动触发一次云端同步。
 * Hevy 的 api-key 存在 Actions Secret 里，浏览器只负责派发工作流，不碰密钥。
 * @param {import('./api.js').GitHubApi} api
 * @param {(s: string) => void} onStatus
 * @param {() => void} [onStart]
 */
export function syncHevy(api, onStatus, onStart) {
  const { position, promise } = enqueueJob(async () => {
    onStart?.();
    onStatus(position ? `排队中（前面还有 ${position} 条）` : '派发同步');
    return runWorkflow(api, { workflow: 'hevy_sync.yml', inputs: {}, onStatus });
  });
  return { position, promise };
}

/** 运行结果 → 人能看懂的一句话 */
export function describeRun(result) {
  if (!result) return '没有拿到结果';
  if (result.state === 'success') return '已写入';
  if (result.state === 'unknown') return '派发了，但没等到运行记录（去 Actions 页面确认一下，别重复提交）';
  if (result.state === 'failure') return '失败：去 Actions 看日志';
  if (result.state === 'cancelled') return '被取消了（已用同一 request_id 重试过一次）';
  return result.state;
}
