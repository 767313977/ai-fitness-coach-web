// @ts-check
/** GitHub 只读 + Actions 派发客户端。
 *
 * 设计约束（见 docs/数据契约.md）：
 * - 读：Contents API（raw），带 ETag 做 304 缓存
 * - 写：所有数据写入只走 Actions workflow_dispatch；
 *   **唯一例外**：导入 Hevy 时先把 CSV 上传到 uploads/（和 App 相同做法），
 *   这一步需要 PAT 有 Contents 读写权限。
 */
const API_ROOT = 'https://api.github.com';
const CACHE_KEY = 'afc.cache.v1';

/** @typedef {{ token: string, owner: string, repo: string, ref?: string }} ApiConfig */

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {{rateLimited?: boolean}} [extra]
   */
  constructor(message, status, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.rateLimited = Boolean(extra.rateLimited);
  }
}

export class NotFoundError extends ApiError {
  constructor(message) { super(message, 404); this.name = 'NotFoundError'; }
}

/** 目标仓库是公开的：拒绝连接，避免健康数据被公开索引。 */
export class PublicRepoError extends ApiError {
  constructor() {
    super('这个仓库是公开的。健康数据只能放在私有仓库，请先在 GitHub 把仓库改成 Private，再回来连接。', 403);
    this.name = 'PublicRepoError';
  }
}

/** @type {Map<string, {etag: string|null, text: string, at: number}>} */
let memoryCache = new Map();

/** 缓存跟 PAT 放在同一个 storage：勾了「记住」才用 localStorage，否则 sessionStorage */
let cacheStorage = (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
let loadedFrom = null;

/**
 * 切换缓存持久化方式，并清掉另一边的缓存。
 * @param {boolean} remember
 */
export function setCachePersistence(remember) {
  const next = remember ? localStorage : sessionStorage;
  const other = remember ? sessionStorage : localStorage;
  if (cacheStorage === next && loadedFrom === next) {
    try { other.removeItem(CACHE_KEY); } catch { /* noop */ }
    return;
  }
  try { other.removeItem(CACHE_KEY); } catch { /* noop */ }
  cacheStorage = next;
  loadedFrom = null;
  memoryCache = new Map();
  ensureLoaded();
}

function ensureLoaded() {
  if (!cacheStorage || loadedFrom === cacheStorage) return;
  loadedFrom = cacheStorage;
  memoryCache = new Map();
  try {
    const raw = cacheStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const [k, v] of Object.entries(parsed || {})) {
      if (v && typeof v.text === 'string') memoryCache.set(k, v);
    }
  } catch { /* 忽略坏缓存 */ }
}

let saveTimer = 0;
function saveDiskCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!cacheStorage) return;
    try {
      /** @type {Record<string, unknown>} */
      const obj = {};
      // 只缓存小文件，避免把 storage 撑爆
      for (const [k, v] of memoryCache) if (v.text.length < 400_000) obj[k] = v;
      cacheStorage.setItem(CACHE_KEY, JSON.stringify(obj));
    } catch { /* 配额满了就算了 */ }
  }, 400);
}

export function clearCache() {
  memoryCache = new Map();
  loadedFrom = null;
  try { localStorage.removeItem(CACHE_KEY); } catch { /* noop */ }
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* noop */ }
}

export class GitHubApi {
  /** @param {ApiConfig} cfg */
  constructor(cfg) {
    this.cfg = { ...cfg, ref: cfg.ref || 'master' };
    /** 最近一次因网络失败而回落到缓存的时间；loadAll 用它提示「离线」 */
    this.lastOffline = null;
    ensureLoaded();
  }

  get repoLabel() { return `${this.cfg.owner}/${this.cfg.repo}`; }

  /** @param {string} path */
  cacheKey(path) { return `${this.cfg.owner}/${this.cfg.repo}@${this.cfg.ref}/${path}`; }

  /** @param {string} path */
  urlFor(path) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return `${API_ROOT}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}/contents/${encoded}?ref=${encodeURIComponent(this.cfg.ref)}`;
  }

  /** @param {string} path @param {{fresh?: boolean, maxAgeMs?: number}} [opts] */
  async raw(path, opts = {}) {
    const key = this.cacheKey(path);
    const cached = memoryCache.get(key);
    // 短有效期：summary / sync_state 这类频繁变化的文件在 TTL 内直接用内存缓存，不打网络。
    // 「刷新」按钮会传 fresh:true，绕过 TTL。
    if (!opts.fresh && cached && opts.maxAgeMs && Date.now() - cached.at < opts.maxAgeMs) {
      return cached.text;
    }
    /** @type {Record<string,string>} */
    const headers = {
      Accept: 'application/vnd.github.raw+json',
      Authorization: `Bearer ${this.cfg.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (!opts.fresh && cached?.etag) headers['If-None-Match'] = cached.etag;

    let res;
    try {
      res = await fetch(this.urlFor(path), { headers, cache: 'no-cache' });
    } catch (error) {
      if (cached) {
        this.lastOffline = { path, at: cached.at };
        return cached.text; // 离线时用缓存兜底
      }
      throw new ApiError('网络不通，检查一下网络连接', 0);
    }

    if (res.status === 304 && cached) return cached.text;
    if (res.status === 404) {
      throw new NotFoundError(`仓库里找不到 ${path}（核对一下 owner/repo 和分支）`);
    }
    if (res.status === 401) throw new ApiError('PAT 无效或已过期，重新填一个', 401);
    if (res.status === 403) {
      const remaining = res.headers.get('X-RateLimit-Remaining');
      const rateLimited = remaining === '0';
      throw new ApiError(
        rateLimited
          ? 'GitHub API 限流了（每小时 5000 次），过一会儿再试'
          : 'PAT 没有这个仓库的读取权限',
        403,
        { rateLimited },
      );
    }
    if (!res.ok) throw new ApiError(`GitHub 返回 ${res.status}`, res.status);

    const text = await res.text();
    memoryCache.set(key, { etag: res.headers.get('ETag'), text, at: Date.now() });
    saveDiskCache();
    return text;
  }

  /** @param {string} path @param {{fresh?: boolean}} [opts] */
  async json(path, opts = {}) {
    const text = await this.raw(path, opts);
    try { return JSON.parse(text); }
    catch { throw new ApiError(`${path} 不是合法 JSON`, 200); }
  }

  /** @param {string} path 不存在时返回 null @param {{fresh?: boolean}} [opts] */
  async jsonOptional(path, opts = {}) {
    try { return await this.json(path, opts); }
    catch (e) { if (e instanceof NotFoundError) return null; throw e; }
  }

  /** 读取仓库元数据：private 与当前账号的写权限。 */
  async repoMeta() {
    const url = `${API_ROOT}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 401) throw new ApiError('PAT 无效或已过期，重新填一个', 401);
    if (res.status === 404) {
      throw new ApiError('仓库不存在，或 PAT 没有这个私有仓库的访问权限（fine-grained PAT 要选中该仓库）', 404);
    }
    if (res.status === 403) throw new ApiError('PAT 没有读取仓库信息的权限（或 API 限流）', 403);
    if (!res.ok) throw new ApiError(`读取仓库信息失败：GitHub 返回 ${res.status}`, res.status);
    const data = await res.json();
    return {
      private: data?.private === true,
      fullName: typeof data?.full_name === 'string' ? data.full_name : `${this.cfg.owner}/${this.cfg.repo}`,
      canPush: data?.permissions?.push !== false,
    };
  }

  /** 测试连接：读 config.json，返回仓库信息 */
  async test() {
    const meta = await this.verifyRepo();
    return {
      private: meta.private,
      workflowCount: meta.workflowCount,
      athlete: meta.athlete,
      weekly: null,
      summaryAt: meta.summaryAt,
    };
  }

  /**
   * 登录前的完整验证：必须私有、Contents 可读、Actions 可读。
   * Actions 写权限无法在不派发工作流的前提下验证，首次提交时再由 403 提示。
   */
  async verifyRepo() {
    const meta = await this.repoMeta();
    if (!meta.private) throw new PublicRepoError();
    if (!meta.canPush) {
      throw new ApiError('当前 GitHub 账号对这个仓库没有写权限；请用管理员或已授权的账号。', 403);
    }
    const cfg = await this.json('config.json', { fresh: true });
    const workflowCount = await this.countWorkflows();
    const summary = await this.jsonOptional('data/summary.json', { fresh: true });
    return {
      private: true,
      fullName: meta.fullName,
      workflowCount,
      athlete: cfg?.athlete?.weight_kg ?? null,
      summaryAt: summary?.generated_at ?? null,
    };
  }

  /** Actions 读权限：列出工作流；403 单独提示。 */
  async countWorkflows() {
    const url = `${API_ROOT}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}/actions/workflows?per_page=1`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 401) throw new ApiError('PAT 无效或已过期，重新填一个', 401);
    if (res.status === 404) throw new ApiError('PAT 没有这个仓库的访问权限', 404);
    if (res.status === 403) throw new ApiError('PAT 缺少 Actions 读取权限', 403);
    if (!res.ok) throw new ApiError(`Actions 接口返回 ${res.status}`, res.status);
    const data = await res.json();
    return (data?.total_count ?? 0);
  }

  /**
   * 派发一个写入工作流。
   * @param {string} workflowFile 例如 checkin.yml
   * @param {Record<string,string>} inputs
   */
  async dispatch(workflowFile, inputs) {
    const url = `${API_ROOT}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.cfg.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: this.cfg.ref, inputs }),
      });
    } catch {
      throw new ApiError('网络不通，提交没有发出去', 0);
    }
    if (res.status === 204) return;
    if (res.status === 401) throw new ApiError('PAT 无效或已过期', 401);
    if (res.status === 404) throw new ApiError('工作流不存在，或 PAT 没有 Actions 权限', 404);
    if (res.status === 403) throw new ApiError('PAT 缺少 Actions: write 权限', 403);
    if (res.status === 422) throw new ApiError('提交参数被 GitHub 拒绝了（检查工作流 inputs）', 422);
    throw new ApiError(`派发失败：GitHub 返回 ${res.status}`, res.status);
  }

  /**
   * 按 request_id 查一次最近的运行；用于刷新后恢复、避免重复派发。
   * @param {string} requestId
   */
  async findRunOnce(requestId) {
    const data = await this.actionsGet('actions/runs?event=workflow_dispatch&per_page=100');
    const runs = data?.workflow_runs ?? [];
    return runs.find((r) => String(r.display_title || r.name || '').includes(requestId)) ?? null;
  }

  /**
   * 找到本次 request_id 对应的运行。
   * @param {string} requestId
   * @param {{timeoutMs?: number, intervalMs?: number}} [opts]
   */
  async findRun(requestId, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const intervalMs = opts.intervalMs ?? 4_000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const hit = await this.findRunOnce(requestId);
      if (hit) return hit;
      await sleep(intervalMs);
    }
    return null;
  }

  /** @param {number} runId */
  async runStatus(runId) {
    const res = await this.actionsGet(`actions/runs/${runId}`);
    return res;
  }

  /** @param {string} path 相对 /repos/{owner}/{repo}/ 的路径 */
  async actionsGet(path) {
    const url = `${API_ROOT}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}/${path}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw new ApiError(`GitHub 返回 ${res.status}`, res.status);
    return res.json();
  }

  /**
   * 上传文件（只用于 uploads/，临时文件由 Actions 消费后删除）。
   * @param {string} path 例如 uploads/hevy/abcd1234.csv
   * @param {string} contentBase64
   * @param {string} message 提交信息（沿用 App 的 `upload: hevy [id]` 约定）
   */
  async putFile(path, contentBase64, message) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const url = `${API_ROOT}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}/contents/${encoded}`;
    /** @type {Record<string, any>} */
    const body = { message, content: contentBase64, branch: this.cfg.ref };
    try {
      const meta = await this.actionsGet(`contents/${encoded}?ref=${encodeURIComponent(this.cfg.ref)}`);
      if (meta?.sha) body.sha = meta.sha;
    } catch { /* 不存在就新建 */ }

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 403) {
      throw new ApiError('PAT 缺少 Contents 写权限（导入 Hevy 需要）', 403);
    }
    if (!res.ok) throw new ApiError(`上传失败：GitHub 返回 ${res.status}`, res.status);
    return res.json();
  }
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 8 位小写十六进制 request_id，和 App 的口径一致 */
export function newRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
