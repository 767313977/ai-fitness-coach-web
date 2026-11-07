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
   * @param {{rateLimited?: boolean, rateLimitKind?: 'primary'|'secondary'|'unknown'}} [extra]
   */
  constructor(message, status, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.rateLimited = Boolean(extra.rateLimited);
    /** 限流级别：一级（配额用尽）/ 二级（短时间请求过多）/ 未知（429 未说明） */
    this.rateLimitKind = extra.rateLimitKind ?? null;
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

/** 401 统一文案：不只说「无效」，直接告诉用户下一步去哪做。 */
function invalidTokenMessage() {
  return 'PAT 无效或已过期：到 GitHub → Settings → Developer settings → Personal access tokens 重新生成一个'
    + '（建议有效期 90 天内），再填进来';
}

/**
 * 403/429 的真实原因：二级限流 / 主限流 / 权限不足。
 * 只认 GitHub 自己给出的证据：错误信息里写明限流，或配额确实归零。
 * 不能只看 Retry-After：代理、CDN 以及部分权限错误也会带这个头，
 * 单独用它判定会把普通 403 误报成二级限流。
 * @param {Response} response
 * @param {string} permissionMessage
 * @returns {Promise<ApiError>}
 */
async function forbiddenError(response, permissionMessage) {
  let body = '';
  try { body = (await response.text()).toLowerCase(); } catch { /* 读不到 body 就按权限处理 */ }
  if (body.includes('secondary rate limit') || body.includes('abuse detection')) {
    return new ApiError('GitHub 触发了二级限流，请等 1–2 分钟再试', response.status, {
      rateLimited: true,
      rateLimitKind: 'secondary',
    });
  }
  if (body.includes('rate limit exceeded') || response.headers.get('X-RateLimit-Remaining') === '0') {
    return new ApiError('GitHub API 限流了（每小时 5000 次），过一会儿再试', response.status, {
      rateLimited: true,
      rateLimitKind: 'primary',
    });
  }
  // 429 本身就是限流，只是没说明是哪一级
  if (response.status === 429) {
    return new ApiError('GitHub API 限流了，过一会儿再试', 429, {
      rateLimited: true,
      rateLimitKind: 'unknown',
    });
  }
  return new ApiError(permissionMessage, response.status);
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

/** 都不确定时的兜底分支：GitHub 新仓库默认是 main，master 由 pickBranch 兜底再试。 */
const FALLBACK_BRANCH = 'main';

/**
 * 选择目标分支：用户填了就用填的，否则用仓库默认分支，最后兜底 main。
 * 不写死 master，main / master 两种默认分支的仓库都能用。
 * @param {string|undefined} savedBranch
 * @param {string|undefined} defaultBranch
 * @returns {string}
 */
export function resolveBranch(savedBranch, defaultBranch) {
  const own = String(savedBranch ?? '').trim();
  if (own) return own;
  const fallback = String(defaultBranch ?? '').trim();
  return fallback || FALLBACK_BRANCH;
}

export class GitHubApi {
  /** @param {ApiConfig} cfg */
  constructor(cfg) {
    this.cfg = { ...cfg, ref: cfg.ref || FALLBACK_BRANCH };
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
      throw new NotFoundError(`仓库里找不到 ${path}：核对账号名、仓库名和分支（当前分支 ${this.cfg.ref}）`);
    }
    if (res.status === 401) throw new ApiError(invalidTokenMessage(), 401);
    if (res.status === 403 || res.status === 429) {
      throw await forbiddenError(res, 'PAT 没有这个仓库的读取权限：把 Contents 设为 Read（导入 Hevy 要 Read and write），并确认 PAT 已选中这个仓库');
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
    if (res.status === 401) throw new ApiError(invalidTokenMessage(), 401);
    if (res.status === 404) {
      throw new ApiError(
        '找不到这个仓库：先核对 Github 账号和仓库名有没有打错；如果没错，说明 PAT 没有这个私有仓库的访问权限'
        + '（fine-grained PAT 要在 Repository access 里勾选它）',
        404,
      );
    }
    if (res.status === 403 || res.status === 429) {
      throw await forbiddenError(res, 'PAT 没有读取仓库信息的权限：把 Contents 设为 Read（导入 Hevy 要 Read and write），并确认 PAT 已选中这个仓库');
    }
    if (!res.ok) throw new ApiError(`读取仓库信息失败：GitHub 返回 ${res.status}`, res.status);
    const data = await res.json();
    return {
      private: data?.private === true,
      fullName: typeof data?.full_name === 'string' ? data.full_name : `${this.cfg.owner}/${this.cfg.repo}`,
      canPush: data?.permissions?.push !== false,
      /** 仓库默认分支：优先用 GitHub 返回的 default_branch，缺失时才兜底 */
      defaultBranch: typeof data?.default_branch === 'string' && data.default_branch
        ? data.default_branch
        : FALLBACK_BRANCH,
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
    if (res.status === 401) throw new ApiError(invalidTokenMessage(), 401);
    if (res.status === 404) throw new ApiError('找不到仓库或工作流：核对账号名、仓库名，以及 PAT 是否选中了这个仓库', 404);
    if (res.status === 403 || res.status === 429) {
      throw await forbiddenError(res, 'PAT 缺少 Actions 读取权限：在 PAT 里把 Actions 设为 Read and write');
    }
    if (!res.ok) throw new ApiError(`Actions 接口返回 ${res.status}`, res.status);
    const data = await res.json();
    return (data?.total_count ?? 0);
  }

  /**
   * 写操作前的强制校验：仓库必须仍是 Private，且元信息必须读取成功。
   * 隐私状态未知（401/403/404/断网）时抛错，调用方不得继续写入。
   */
  async assertPrivateRepo() {
    const meta = await this.repoMeta();
    if (!meta.private) throw new PublicRepoError();
    return meta;
  }

  /**
   * 派发一个写入工作流。
   * @param {string} workflowFile 例如 checkin.yml
   * @param {Record<string,string>} inputs
   */
  async dispatch(workflowFile, inputs) {
    await this.assertPrivateRepo();
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
    if (res.status === 401) throw new ApiError(invalidTokenMessage(), 401);
    if (res.status === 404) {
      throw new ApiError('工作流不存在，或 PAT 没有 Actions 权限：确认工作流文件还在，且 Actions 权限为 Read and write', 404);
    }
    if (res.status === 403 || res.status === 429) {
      throw await forbiddenError(res, 'PAT 缺少 Actions: write 权限：在 PAT 里把 Actions 设为 Read and write 后再提交');
    }
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
    if (res.status === 403 || res.status === 429) {
      throw await forbiddenError(res, 'PAT 没有读取 Actions 运行记录的权限：在 PAT 里把 Actions 设为 Read and write');
    }
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
    await this.assertPrivateRepo();
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const url = `${API_ROOT}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}/contents/${encoded}`;
    /** @type {Record<string, any>} */
    const body = { message, content: contentBase64, branch: this.cfg.ref };
    try {
      const meta = await this.actionsGet(`contents/${encoded}?ref=${encodeURIComponent(this.cfg.ref)}`);
      if (meta?.sha) body.sha = meta.sha;
    } catch (error) {
      // 只有 404 才是「文件不存在，可以新建」；403/429/5xx/网络异常必须中止，
      // 否则会在不知道文件状态的情况下覆盖或新建，可能丢内容。
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }

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
    if (res.status === 403 || res.status === 429) {
      throw await forbiddenError(res, 'PAT 缺少 Contents 写权限：导入 Hevy 需要把 Contents 设为 Read and write');
    }
    if (!res.ok) throw new ApiError(`上传失败：GitHub 返回 ${res.status}`, res.status);
    return res.json();
  }

  /**
   * 删除 uploads/ 下的临时文件（Hevy 上传失败或人工放弃时清理）。
   * 限定 uploads/ 前缀，避免误删数据文件；文件已不存在视为成功。
   * @param {string} path
   * @param {string} message
   */
  async deleteFile(path, message) {
    if (!/^uploads\/[A-Za-z0-9._/-]+$/.test(path) || path.includes('..')) {
      throw new ApiError('只允许删除 uploads/ 下的临时文件', 400);
    }
    await this.assertPrivateRepo();
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const url = `${API_ROOT}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}/contents/${encoded}`;

    let sha = null;
    try {
      const meta = await this.actionsGet(`contents/${encoded}?ref=${encodeURIComponent(this.cfg.ref)}`);
      sha = meta?.sha ?? null;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    }
    if (!sha) return;

    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, sha, branch: this.cfg.ref }),
    });
    if (res.status === 404) return;
    if (res.status === 403 || res.status === 429) {
      throw await forbiddenError(res, 'PAT 缺少 Contents 写权限：清理临时文件需要 Read and write');
    }
    if (!res.ok) throw new ApiError(`删除临时文件失败：GitHub 返回 ${res.status}`, res.status);
  }
}

/**
 * 逐个探测可用分支：用户指定 → 仓库默认 → main → master。
 * 只有 config.json 真的能读到，才算这个分支可用；404 就换下一个。
 * 401/403/断网换分支也没用，直接抛出，避免把账号问题误判成分支问题。
 * @param {ApiConfig} cfg 其中的 ref 视为用户指定的分支
 * @param {string|undefined} defaultBranch
 * @returns {Promise<{branch: string, api: GitHubApi}>}
 */
export async function pickBranch(cfg, defaultBranch) {
  /** @type {string[]} */
  const candidates = [];
  const add = (value) => {
    const branch = String(value ?? '').trim();
    if (branch && !candidates.includes(branch)) candidates.push(branch);
  };
  add(cfg.ref);
  add(defaultBranch);
  add('main');
  add('master');

  /** @type {any} */
  let lastError = null;
  for (const branch of candidates) {
    const api = new GitHubApi({ ...cfg, ref: branch });
    try {
      await api.json('config.json', { fresh: true });
      return { branch, api };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new ApiError('仓库里没有可用的分支（试过 main / master）', 404);
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 8 位小写十六进制 request_id，和 App 的口径一致 */
export function newRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
