// @ts-check
/** 统一提交队列：所有写入（打卡/饮食/有氧/身体/周复盘/提案/Hevy 同步/Hevy 导入）都走这里。
 *
 * 设计约束：
 * - 健康数据（表单 inputs）只放 sessionStorage，关标签页即清；
 * - Hevy 上传路径 + request_id 不含健康数据，放 localStorage，关页面后还能恢复；
 * - 一次只允许一个标签页提交（Web Locks，老浏览器用 localStorage 租约兜底）；
 * - success / failure / cancelled 才移除任务；timeout / unknown 保留，供「继续检查」；
 * - 重试永远沿用原 request_id，配合 Actions 里的幂等闸避免重复写入。
 */
import { newRequestId, sleep } from './api.js';
import {
  RUN_STATE, runWorkflow, resumeWorkflow, isTerminalState, fileToBase64,
} from './submit.js';
import { validateFile } from './hevy_csv.js';

const STORE_KEY = 'afc.queue.v2';
const HEVY_KEY = 'afc.hevy.recovery.v1';
const RECEIPT_KEY = 'afc.receipts.v1';
const LOCK_NAME = 'afc.github.write';
const LEASE_KEY = 'afc.queue.lease.v1';
const LEASE_MS = 2 * 60_000;
const TAB_ID = `tab-${Math.random().toString(36).slice(2, 10)}`;

let chain = Promise.resolve();
let pending = 0;
/** 当前仓库作用域（owner/repo@branch）：任务、凭证、Hevy 恢复记录都按它隔离 */
let scope = null;

/**
 * 切换当前仓库作用域。切换账户/仓库后，其他作用域的任务不会出现在恢复列表里。
 * @param {string|null|undefined} next
 */
export function setQueueScope(next) {
  scope = next ? String(next) : null;
}

export function queueScope() {
  return scope;
}

/** @param {any} item */
function inScope(item) {
  if (!item) return false;
  // 老版本任务没有 scope：首次在某个作用域下读取时归到当前作用域，避免丢任务
  if (!item.scope) return true;
  return !scope || item.scope === scope;
}

/** @param {any[]} list */
function adoptLegacyScope(list) {
  if (!scope) return false;
  let changed = false;
  for (const item of list) {
    if (item && !item.scope) { item.scope = scope; changed = true; }
  }
  return changed;
}

/** @returns {Storage|null} */
function sessionStore() {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
}

/** @returns {Storage|null} */
function localStore() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** @returns {any[]} */
function readTasks() {
  const store = sessionStore();
  if (!store) return [];
  try {
    const raw = store.getItem(STORE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const tasks = Array.isArray(list)
      ? list.filter((item) => item && item.workflow && item.requestId)
      : [];
    if (adoptLegacyScope(tasks)) writeTasks(tasks);
    return tasks;
  } catch {
    return [];
  }
}

/** @param {any[]} list */
function writeTasks(list) {
  const store = sessionStore();
  if (!store) return;
  try { store.setItem(STORE_KEY, JSON.stringify(list)); } catch { /* 存不了就只留在内存 */ }
}

/** @param {any} task */
function upsertTask(task) {
  const list = readTasks();
  const index = list.findIndex((item) => item.id === task.id || item.requestId === task.requestId);
  if (index >= 0) list[index] = { ...list[index], ...task };
  else list.push(task);
  writeTasks(list);
}

/** @param {string} id */
function removeTask(id) {
  const list = readTasks();
  const task = list.find((item) => item.id === id);
  writeTasks(list.filter((item) => item.id !== id));
  if (task?.requestId) removeReceipt(task.requestId);
}

/**
 * @param {string} id
 * @param {string} status
 * @param {Record<string, any>} [extra]
 */
function setTaskStatus(id, status, extra = {}) {
  const list = readTasks();
  const task = list.find((item) => item.id === id);
  if (!task) return;
  task.status = status;
  task.updatedAt = new Date().toISOString();
  Object.assign(task, extra);
  writeTasks(list);
  updateReceipt(task.requestId, status);
}

/** @returns {any[]} */
export function unsentTasks() {
  return readTasks().filter(inScope);
}

export function unsentCount() {
  return unsentTasks().length + receiptOnlyCount();
}

export function pendingCount() {
  return pending;
}

/** 任务类型 → 人话标签 */
const KIND_LABEL = {
  checkin: '打卡',
  diet: '饮食',
  cardio: '有氧',
  body: '身体指标',
  weekly: '周复盘',
  proposal: 'AI 提案',
  'hevy-import': 'Hevy 导入',
  'hevy-sync': 'Hevy 同步',
  workflow: '提交',
};

/** @param {string|undefined} kind */
export function taskKindLabel(kind) {
  return KIND_LABEL[kind] ?? '提交';
}

/** @param {string|undefined} status */
export function taskStatusLabel(status) {
  const labels = {
    pending: '等待中',
    running: '提交中',
    timeout: '等待超时',
    unknown: '结果未知',
    uploaded: '已上传，待确认',
    success: '已完成',
    failure: '失败',
    cancelled: '已取消',
  };
  return labels[status] ?? status ?? '未知';
}

/**
 * 未完成任务摘要：让用户看清「什么任务、什么状态、什么时候提交的」。
 * @param {any[]} tasks
 * @returns {{items: {id: string, label: string, status: string, statusLabel: string, createdAt: string}[], needsCheck: boolean}}
 */
export function pendingSummary(tasks) {
  const items = tasks.map((task) => ({
    id: task.id,
    label: taskKindLabel(task.kind),
    status: task.status || 'unknown',
    statusLabel: taskStatusLabel(task.status),
    createdAt: task.createdAt || '',
  }));
  const needsCheck = items.some((item) => (
    ['pending', 'running', 'timeout', 'unknown', 'uploaded'].includes(item.status)
  ));
  return { items, needsCheck };
}

export function hasPending() {
  return pending > 0;
}

/** 最近一次提交的凭证：只存 request_id / 工作流 / 状态，不含任何健康数据。
 *  关页面后用它去 GitHub 查结果，避免任务“无提示消失”。
 *  @returns {any[]} */
function readReceipts() {
  const store = localStore();
  if (!store) return [];
  try {
    const raw = store.getItem(RECEIPT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const receipts = Array.isArray(list)
      ? list.filter((item) => item && item.requestId && item.workflow)
      : [];
    if (adoptLegacyScope(receipts)) writeReceipts(receipts);
    return receipts;
  } catch {
    return [];
  }
}

/** @param {any[]} list */
function writeReceipts(list) {
  const store = localStore();
  if (!store) return;
  try { store.setItem(RECEIPT_KEY, JSON.stringify(list)); } catch { /* 忽略 */ }
}

/** @param {any} task */
function upsertReceipt(task) {
  const list = readReceipts();
  const record = {
    requestId: task.requestId,
    workflow: task.workflow,
    kind: task.kind || 'workflow',
    scope: task.scope || scope,
    createdAt: task.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: task.status || 'pending',
  };
  const index = list.findIndex((item) => item.requestId === record.requestId);
  if (index >= 0) list[index] = record;
  else list.push(record);
  writeReceipts(list);
}

/** @param {string} requestId @param {string} status */
function updateReceipt(requestId, status) {
  writeReceipts(readReceipts().map((item) => (
    item.requestId === requestId ? { ...item, status, updatedAt: new Date().toISOString() } : item
  )));
}

/** @param {string} requestId */
function removeReceipt(requestId) {
  writeReceipts(readReceipts().filter((item) => item.requestId !== requestId));
}

/** 只有凭证、没有会话任务的数量（通常是提交后直接关了页面）。 */
export function receiptOnlyCount() {
  const ids = new Set(readTasks().filter(inScope).map((task) => task.requestId));
  return readReceipts().filter((item) => inScope(item) && !ids.has(item.requestId)).length;
}

/* ---------------- Hevy 上传恢复（不含健康数据） ---------------- */

/** @returns {any[]} */
function readRecovery() {
  const store = localStore();
  if (!store) return [];
  try {
    const raw = store.getItem(HEVY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const records = Array.isArray(list)
      ? list.filter((item) => item && item.requestId && item.path)
      : [];
    if (adoptLegacyScope(records)) writeRecovery(records);
    return records;
  } catch {
    return [];
  }
}

/** @param {any[]} list */
function writeRecovery(list) {
  const store = localStore();
  if (!store) return;
  try { store.setItem(HEVY_KEY, JSON.stringify(list)); } catch { /* 忽略 */ }
}

/** @param {{requestId: string, path: string, workflow: string, createdAt: string, status: string}} record */
function saveRecovery(record) {
  const list = readRecovery();
  const next = { ...record, scope: record.scope || scope };
  const index = list.findIndex((item) => item.requestId === record.requestId);
  if (index >= 0) list[index] = { ...list[index], ...next };
  else list.push(next);
  writeRecovery(list);
}

/** @param {string} requestId @param {string} status */
function updateRecovery(requestId, status) {
  writeRecovery(readRecovery().map((item) => (
    item.requestId === requestId ? { ...item, status } : item
  )));
}

/** @param {string} requestId */
function removeRecovery(requestId) {
  writeRecovery(readRecovery().filter((item) => item.requestId !== requestId));
}

/** 刷新/重开后，已上传但还没确认结果的 Hevy 导入。 */
export function hevyRecoveryTasks() {
  return readRecovery().filter((item) => inScope(item) && !isTerminalState(item.status));
}

/**
 * 清理过期未完成任务/凭证/恢复记录（默认 7 天），避免本地存储无限增长。
 * @param {number} [maxAgeMs]
 * @param {number} [now]
 * @returns {number} 清掉的任务数
 */
export function pruneStaleTasks(maxAgeMs = 7 * 86_400_000, now = Date.now()) {
  const isStale = (item) => {
    const at = Date.parse(item?.updatedAt || item?.createdAt || '');
    return Number.isFinite(at) && at < now - maxAgeMs;
  };
  const tasks = readTasks();
  const keptTasks = tasks.filter((item) => !isStale(item));
  if (keptTasks.length !== tasks.length) writeTasks(keptTasks);

  const receipts = readReceipts();
  const keptReceipts = receipts.filter((item) => !isStale(item));
  if (keptReceipts.length !== receipts.length) writeReceipts(keptReceipts);

  const recovery = readRecovery();
  const keptRecovery = recovery.filter((item) => !isStale(item));
  if (keptRecovery.length !== recovery.length) writeRecovery(keptRecovery);

  return tasks.length - keptTasks.length;
}

/**
 * 切换账户/仓库后，删掉其他作用域的恢复记录，避免把 A 仓的任务恢复到 B 仓。
 * @param {string|null} [current]
 */
export function dropOtherScopes(current = scope) {
  if (!current) return;
  const jobs = [
    [readTasks, writeTasks],
    [readReceipts, writeReceipts],
    [readRecovery, writeRecovery],
  ];
  for (const [read, write] of jobs) {
    const list = read();
    const kept = list.filter((item) => !item.scope || item.scope === current);
    if (kept.length !== list.length) write(kept);
  }
}

/** 退出登录时清空队列相关本地状态（不碰仓库里的数据）。 */
export function clearLocalState() {
  for (const store of [sessionStore(), localStore()]) {
    if (!store) continue;
    for (const key of [STORE_KEY, RECEIPT_KEY, HEVY_KEY, LEASE_KEY]) {
      try { store.removeItem(key); } catch { /* 忽略 */ }
    }
  }
  stopLeaseHeartbeat();
  pending = 0;
  chain = Promise.resolve();
}

/* ---------------- 多标签页锁 ---------------- */

/** 租约是否已过期（不存在也算过期）。 @param {any} lease @param {number} [now] */
export function isLeaseExpired(lease, now = Date.now()) {
  return !lease || !Number.isFinite(Number(lease.until)) || Number(lease.until) < now;
}

let leaseTimer = 0;

/** 只续自己的租约，避免把别的标签页刚拿到的锁续掉。 */
function renewLease() {
  const store = localStore();
  if (!store) return;
  try {
    const lease = JSON.parse(store.getItem(LEASE_KEY) || 'null');
    if (lease?.id === TAB_ID) {
      store.setItem(LEASE_KEY, JSON.stringify({ id: TAB_ID, until: Date.now() + LEASE_MS }));
    }
  } catch { /* 忽略 */ }
}

function startLeaseHeartbeat() {
  stopLeaseHeartbeat();
  const timer = setInterval(renewLease, Math.floor(LEASE_MS / 4));
  // Node 测试环境下不要阻止进程退出
  if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  leaseTimer = timer;
}

function stopLeaseHeartbeat() {
  if (leaseTimer) clearInterval(leaseTimer);
  leaseTimer = 0;
}

async function acquireLease() {
  const store = localStore();
  if (!store) return;
  for (let i = 0; i < 420; i += 1) {
    let lease = null;
    try { lease = JSON.parse(store.getItem(LEASE_KEY) || 'null'); } catch { lease = null; }
    if (isLeaseExpired(lease) || lease.id === TAB_ID) {
      store.setItem(LEASE_KEY, JSON.stringify({ id: TAB_ID, until: Date.now() + LEASE_MS }));
      // 运行超过 2 分钟时持续续期，不会中途丢掉锁；标签页崩溃后心跳停止，租约自然过期
      startLeaseHeartbeat();
      return;
    }
    await sleep(1_000);
  }
  throw new Error('另一个标签页正在提交，请等它完成后再试');
}

function releaseLease() {
  stopLeaseHeartbeat();
  const store = localStore();
  if (!store) return;
  try {
    const lease = JSON.parse(store.getItem(LEASE_KEY) || 'null');
    if (lease?.id === TAB_ID) store.removeItem(LEASE_KEY);
  } catch { /* 忽略 */ }
}

/**
 * 同一时间只允许一个标签页派发写入。
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withWriteLock(fn) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (locks && typeof locks.request === 'function') {
    return locks.request(LOCK_NAME, { mode: 'exclusive' }, fn);
  }
  await acquireLease();
  try { return await fn(); } finally { releaseLease(); }
}

/* ---------------- 任务执行 ---------------- */

/**
 * @template T
 * @param {() => Promise<T>} job
 */
function enqueueJob(job) {
  const position = pending;
  pending += 1;
  const run = chain.then(() => job()).finally(() => { pending -= 1; });
  chain = run.then(() => undefined, () => undefined);
  return { position, promise: run };
}

/** @param {string} message */
function definitiveError(message) {
  const error = new Error(message);
  // @ts-ignore 自定义标记：确定不会成功的任务，直接移除
  error.definitive = true;
  return error;
}

/** @param {any} error */
function isDefinitiveError(error) {
  return error?.definitive === true || [401, 403, 404, 422].includes(Number(error?.status));
}

/**
 * @param {string} kind
 * @param {string} workflow
 * @param {Record<string,string>} inputs
 */
function createTask(kind, workflow, inputs) {
  const now = new Date().toISOString();
  return {
    id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    workflow,
    inputs,
    requestId: newRequestId(),
    status: 'pending',
    scope,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * @param {import('./api.js').GitHubApi} api
 * @param {any} task
 * @param {{onStatus?: (s: string) => void, prepare?: (task: any) => Promise<void>,
 *          findTimeoutMs?: number, runTimeoutMs?: number, pollMs?: number}} opts
 */
function runTask(api, task, opts = {}) {
  const onStatus = opts.onStatus || (() => {});
  const { position, promise } = enqueueJob(async () => {
    onStatus(position > 0 ? `排队中（前面还有 ${position} 条）` : '排队中');
    return withWriteLock(async () => {
      setTaskStatus(task.id, 'running');
      try {
        if (opts.prepare) await opts.prepare(task);
        const result = await runWorkflow(api, {
          workflow: task.workflow,
          inputs: task.inputs,
          requestId: task.requestId,
          onStatus,
          findTimeoutMs: opts.findTimeoutMs,
          runTimeoutMs: opts.runTimeoutMs,
          pollMs: opts.pollMs,
        });
        if (isTerminalState(result.state)) {
          removeTask(task.id);
          if (task.kind === 'hevy-import') removeRecovery(task.requestId);
        } else {
          setTaskStatus(task.id, result.state, { runUrl: result.run?.html_url ?? null });
          if (task.kind === 'hevy-import') updateRecovery(task.requestId, result.state);
        }
        return result;
      } catch (error) {
        // 已上传的 Hevy CSV 即使派发被拒也保留路径，修好权限后还能用同一个 request_id 恢复
        const keepForRecovery = task.kind === 'hevy-import' && Boolean(task.uploadPath);
        if (isDefinitiveError(error) && !keepForRecovery) {
          removeTask(task.id);
          if (task.kind === 'hevy-import') removeRecovery(task.requestId);
        } else {
          setTaskStatus(task.id, RUN_STATE.unknown, {
            note: error?.message ? String(error.message) : String(error),
          });
        }
        throw error;
      }
    });
  });
  return { position, promise, task };
}

/**
 * 排队派发一个工作流。
 * @param {import('./api.js').GitHubApi} api
 * @param {{workflow: string, inputs: Record<string,string>, kind?: string, requestId?: string,
 *          onStatus?: (s: string) => void, findTimeoutMs?: number,
 *          runTimeoutMs?: number, pollMs?: number}} opts
 */
export function enqueue(api, opts) {
  const task = createTask(opts.kind || 'workflow', opts.workflow, opts.inputs || {});
  if (opts.requestId) task.requestId = opts.requestId;
  upsertTask(task);
  upsertReceipt(task);
  return runTask(api, task, opts);
}

/**
 * Hevy CSV 导入：先上传，再把路径和 request_id 记到 localStorage。
 * 不把 CSV 内容写进任何 storage。
 * @param {import('./api.js').GitHubApi} api
 * @param {File} file
 * @param {(s: string) => void} onStatus
 */
export function enqueueHevyImport(api, file, onStatus) {
  // 之前上传阶段就失败、没有路径的导入无法恢复；用户重新选文件时清掉
  for (const old of readTasks()) {
    if (old.kind === 'hevy-import' && !old.uploadPath) discardTask(old.id);
  }
  const unresolved = readTasks().filter((item) => (
    inScope(item) && item.kind === 'hevy-import' && item.uploadPath
  ));
  if (unresolved.length) {
    throw new Error('还有一次 Hevy 导入没确认结果：先点顶部「继续检查」，确认完成或放弃后再导入新文件，避免重复导入。');
  }
  const task = createTask('hevy-import', 'import_hevy_csv.yml', {});
  upsertTask(task);
  upsertReceipt(task);
  return runTask(api, task, {
    onStatus,
    prepare: async (current) => {
      if (!file) throw definitiveError('没有选择 CSV 文件，请重新选择');
      // 先做本地校验，避免把明显错误的文件传上去再失败
      const invalid = await validateFile(file);
      if (invalid) throw definitiveError(invalid);
      onStatus('上传 CSV');
      const base = file.name.replace(/[^\w.\-]+/g, '_');
      const safeName = base.replace(/\.csv$/i, '') + '.csv';
      const path = `uploads/hevy/${current.requestId}-${safeName}`;
      try {
        const base64 = await fileToBase64(file);
        await api.putFile(path, base64, `upload: hevy [${current.requestId}]`);
      } catch (error) {
        throw definitiveError(`CSV 上传失败：${error?.message ?? error}。请重新选择文件。`);
      }
      current.uploadPath = path;
      current.inputs = { path };
      upsertTask(current);
      saveRecovery({
        requestId: current.requestId,
        path,
        workflow: current.workflow,
        createdAt: current.createdAt,
        status: 'uploaded',
      });
      onStatus('已上传，派发导入');
    },
  });
}

/**
 * 按任务恢复：不重新上传、不新建 request_id，只查已有运行。
 * @param {import('./api.js').GitHubApi} api
 * @param {any} task
 * @param {{onStatus?: (s: string) => void, runTimeoutMs?: number, pollMs?: number}} [opts]
 */
export function resumeTask(api, task, opts = {}) {
  const onStatus = opts.onStatus || (() => {});
  const { position, promise } = enqueueJob(async () => {
    return withWriteLock(async () => {
      if (task.kind === 'hevy-import' && !task.uploadPath) {
        setTaskStatus(task.id, RUN_STATE.unknown, { note: '需要重新选择 CSV 文件' });
        return { id: task.requestId, state: RUN_STATE.unknown, needsFile: true };
      }
      setTaskStatus(task.id, 'running');
      try {
        const result = await resumeWorkflow(api, {
          requestId: task.requestId,
          onStatus,
          runTimeoutMs: opts.runTimeoutMs,
          pollMs: opts.pollMs,
        });
        if (isTerminalState(result.state)) {
          removeTask(task.id);
          if (task.kind === 'hevy-import') removeRecovery(task.requestId);
        } else {
          setTaskStatus(task.id, result.state, { runUrl: result.run?.html_url ?? null });
          if (task.kind === 'hevy-import') updateRecovery(task.requestId, result.state);
        }
        return result;
      } catch (error) {
        setTaskStatus(task.id, RUN_STATE.unknown, {
          note: error?.message ? String(error.message) : String(error),
        });
        throw error;
      }
    });
  });
  return { position, promise, task };
}

/** @param {import('./api.js').GitHubApi} api @param {string} id @param {any} [opts] */
export async function resumeTaskById(api, id, opts = {}) {
  const task = readTasks().filter(inScope).find((item) => item.id === id || item.requestId === id);
  if (!task) throw new Error('这条任务已经结束或不存在');
  return resumeTask(api, task, opts).promise;
}

/**
 * 恢复所有未完成任务，包括关页面后只剩 localStorage 恢复记录的 Hevy 导入。
 * @param {import('./api.js').GitHubApi} api
 * @param {{onStatus?: (s: string) => void, runTimeoutMs?: number, pollMs?: number}} [opts]
 */
export async function resumeUnfinished(api, opts = {}) {
  /** @type {{task?: any, receipt?: any, result?: any, error?: any}[]} */
  const results = [];
  const tasks = readTasks().filter(inScope);

  for (const record of hevyRecoveryTasks()) {
    if (tasks.some((task) => task.requestId === record.requestId)) continue;
    const task = {
      id: `hevy-${record.requestId}`,
      kind: 'hevy-import',
      workflow: 'import_hevy_csv.yml',
      inputs: { path: record.path },
      requestId: record.requestId,
      uploadPath: record.path,
      status: 'unknown',
      scope: record.scope || scope,
      createdAt: record.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    upsertTask(task);
    tasks.push(task);
  }

  for (const task of tasks) {
    try {
      const result = await resumeTask(api, task, opts).promise;
      results.push({ task, result });
    } catch (error) {
      results.push({ task, error });
    }
  }

  // 只有凭证、没有会话任务：通常是提交后直接关了页面，无法重提，但可以确认结果
  const known = new Set(readTasks().filter(inScope).map((task) => task.requestId));
  for (const receipt of readReceipts()) {
    if (!inScope(receipt)) continue;
    if (known.has(receipt.requestId)) continue;
    try {
      const result = await resumeWorkflow(api, {
        requestId: receipt.requestId,
        onStatus: opts.onStatus,
        runTimeoutMs: opts.runTimeoutMs ?? 15_000,
        pollMs: opts.pollMs,
      });
      if (isTerminalState(result.state)) removeReceipt(receipt.requestId);
      else updateReceipt(receipt.requestId, result.state);
      results.push({ receipt, result });
    } catch (error) {
      results.push({ receipt, error });
    }
  }
  return results;
}

/**
 * 用户主动放弃一条无法恢复的任务（例如上传阶段失败、没有文件路径）。
 * 传了 api 且任务有上传路径时，顺手删掉仓库里的临时 CSV，避免残留。
 * @param {string} id
 * @param {import('./api.js').GitHubApi} [api]
 */
export function discardTask(id, api) {
  const task = readTasks().find((item) => item.id === id);
  removeTask(id);
  if (task?.requestId) removeRecovery(task.requestId);
  if (api && task?.uploadPath && typeof api.deleteFile === 'function') {
    api.deleteFile(task.uploadPath, `cleanup: hevy [${task.requestId}]`).catch(() => { /* 清理失败不阻塞 */ });
  }
}
