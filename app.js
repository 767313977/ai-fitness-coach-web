// @ts-check
/** 应用外壳：登录、路由、数据加载、侧边栏。 */
import { ApiError, GitHubApi, PublicRepoError, clearCache, pickBranch, resolveBranch, setCachePersistence } from './js/api.js';
import { loadAll, todayISO, fmtDate } from './js/data.js';
import { h, clear, icon, toast, banner } from './js/ui.js';
import { DEMO_DATA } from './js/demo.js';
import { noticeFromError, offlineText } from './js/status.js';
import {
  clearLocalState, discardTask, hasPending, hevyRecoveryTasks, lastCleanupPersistError,
  pendingCleanups, pendingSummary, pruneStaleTasks, resumeUnfinished, runCleanups, setQueueScope,
  dropOtherScopes, unsentCount, unsentTasks,
} from './js/queue.js';
import { renderToday } from './pages/today.js';
import { renderWeek } from './pages/week.js';
import { renderReviewList, renderReviewDetail } from './pages/review.js';
import { renderRecord } from './pages/record.js';
import { renderSettings } from './pages/settings.js';
import { renderLibrary } from './pages/library.js';

const AUTH_KEY = 'afc.auth.v1';
const DEMO_KEY = 'afc.demo';

/** @typedef {{owner: string, repo: string, branch?: string, token: string, remember: boolean}} Auth */

const state = {
  /** @type {Auth|null} */
  auth: null,
  /** @type {GitHubApi|null} */
  api: null,
  /** @type {any} */
  data: null,
  loading: false,
  /** @type {Error|null} */
  error: null,
  demo: false,
  /** @type {string[]} */
  route: [],
  refreshing: false,
  /** @type {{kind: 'offline'|'rate-limit'|'storage', text: string}|null} 常驻状态：离线 / 限流 / 本地存储异常 */
  notice: null,
};

const NAV = [
  { key: 'today', label: '今天', icon: 'today' },
  { key: 'week', label: '本周', icon: 'week' },
  { key: 'review', label: '复盘', icon: 'review' },
  { key: 'library', label: '动作库', icon: 'library' },
  { key: 'record', label: '记录', icon: 'record' },
  { key: 'settings', label: '设置', icon: 'settings' },
];

const TITLES = {
  today: ['今天', '今日课表与本周剩余目标'],
  week: ['本周', '关键数字、趋势与数据新鲜度'],
  review: ['复盘', '周复盘与周期报告'],
  library: ['动作库', '动作说明、目标肌群与训练历史'],
  record: ['记录', '打卡 / 饮食 / 有氧 / 身体 / 导入 / 提案'],
  settings: ['设置', '连接、缓存与安全'],
};

// ---------------- 认证 ----------------

/** @returns {Auth|null} */
function loadAuth() {
  for (const store of [localStorage, sessionStorage]) {
    try {
      const raw = store.getItem(AUTH_KEY);
      if (!raw) continue;
      const auth = JSON.parse(raw);
      if (auth?.token && auth?.owner && auth?.repo) return auth;
    } catch { /* 忽略坏数据 */ }
  }
  return null;
}

/** @param {Auth|null} auth */
function saveAuth(auth) {
  localStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(AUTH_KEY);
  if (!auth) return;
  const store = auth.remember ? localStorage : sessionStorage;
  store.setItem(AUTH_KEY, JSON.stringify(auth));
}

// ---------------- 路由 ----------------

function parseRoute() {
  const raw = (location.hash || '#/today').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  return parts.length ? parts : ['today'];
}

/** @param {string} path */
function navigate(path) {
  if (location.hash === `#${path}`) return;
  location.hash = path;
}

// ---------------- 数据 ----------------

async function connect(opts = {}) {
  if (!state.auth && !state.demo) return;
  state.loading = true;
  state.error = null;
  render();
  try {
    if (state.demo) {
      state.data = DEMO_DATA;
    } else {
      const auth = /** @type {Auth} */ (state.auth);
      // repoMeta 与分支无关：先确认是不是私有仓库，再探测分支
      const probe = new GitHubApi({ ...auth, ref: resolveBranch(auth.branch) });
      let meta = null;
      try {
        meta = await probe.repoMeta();
      } catch {
        // 断网时忽略仓库检查，继续用缓存；分支沿用已保存的值
        meta = null;
      }
      if (meta && meta.private !== true) throw new PublicRepoError();
      /** @type {{branch: string, api: GitHubApi}} */
      let picked;
      try {
        picked = await pickBranch(auth, meta?.defaultBranch);
      } catch (error) {
        // 连不上时不要卡在分支探测上：沿用已保存分支，交给 loadAll 用缓存兜底
        if (!(error instanceof ApiError) || error.status !== 0) throw error;
        const branch = resolveBranch(auth.branch, meta?.defaultBranch);
        picked = { branch, api: new GitHubApi({ ...auth, ref: branch }) };
      }
      state.auth = { ...auth, branch: picked.branch };
      state.api = picked.api;
      // 任务/凭证按「账户/仓库@分支」隔离：切仓后不恢复别的仓的任务，并清掉 7 天前的残留
      setQueueScope(`${auth.owner}/${auth.repo}@${picked.branch}`);
      dropOtherScopes();
      pruneStaleTasks();
      const pruneError = lastCleanupPersistError();
      state.data = await loadAll(state.api, { fresh: Boolean(opts.fresh) });
      // 成功加载后：只有确实回落缓存才保留离线提示，联网恢复即自动消失
      state.notice = state.data.offline
        ? { kind: 'offline', text: offlineText(state.data.offlineAt) }
        : null;
      if (pruneError) {
        // 清理队列写不进去时宁可保留原任务，也不能静默丢掉远程文件路径
        state.notice = {
          kind: 'storage',
          text: `本机存储写入失败，过期任务没有清理（远程文件路径仍保留）：${pruneError}`,
        };
      }
    }
  } catch (error) {
    state.error = /** @type {Error} */ (error);
    state.notice = noticeFromError(state.error);
  } finally {
    state.loading = false;
    render();
  }
}

async function refresh() {
  if (state.loading) return;
  if (state.demo) { toast('演示模式不会去 GitHub 取数'); return; }
  state.refreshing = true;
  render();
  await connect({ fresh: true });
  state.refreshing = false;
  render();
  if (state.error) {
    // 刷新失败必须给反馈，否则用户会以为按钮没反应
    toast(errorText(state.error));
    return;
  }
  toast(state.notice?.kind === 'offline' ? '已刷新，但部分数据仍来自缓存' : '已刷新');
}

// ---------------- 渲染 ----------------

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  clear(app);

  if (!state.auth && !state.demo) {
    app.append(loginView());
    return;
  }

  const shell = h('div', { class: 'shell' });
  shell.append(sidebar());

  const main = h('div', { class: 'main' });
  main.append(topbar());
  const content = h('div', { class: 'content' });

  if (state.loading && !state.data) {
    content.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '正在读取仓库…')));
  } else if (state.error && !state.data) {
    content.append(renderError(state.error));
  } else {
    // 离线 / 限流是持续状态，不是一次性 toast：成功刷新后自动消失
    if (state.notice && !state.demo) {
      content.append(h('div', { class: 'card' },
        banner(state.notice.text, 'warn'),
        h('button', { class: 'btn small', onClick: () => refresh() }, '重试'),
        h('div', { class: 'hint', style: 'margin-top:8px' },
          state.notice.kind === 'offline'
            ? '离线期间不会丢数据；提交会被保留，联网后继续检查。'
            : state.notice.kind === 'storage'
              ? '请清理浏览器存储空间或退出隐私模式后再试；任务和远程文件路径都还在。'
              : '限流只影响读取，不会重复写入；恢复后点「重试」即可。'),
      ));
    }
    const unsent = state.demo ? 0 : unsentCount();
    const tasks = state.demo ? [] : unsentTasks();
    const summary = pendingSummary(tasks);
    const hevyPending = state.demo ? [] : hevyRecoveryTasks();
    if (unsent > 0 || hevyPending.length > 0) {
      const receiptOnly = unsent - tasks.length;
      content.append(h('div', { class: 'card' },
        banner(`有 ${unsent} 条提交还没确认结果（刷新、断网或超时都不会丢）。`, 'warn'),
        ...summary.items.slice(0, 4).map((item) => h('div', { class: 'hint', style: 'margin-top:0' },
          `${item.label} · ${item.statusLabel}${item.createdAt ? ` · ${relTime(item.createdAt)}` : ''}`,
          item.cleanupError ? ` · 清理失败：${item.cleanupError}` : '',
          ['unknown', 'timeout', 'uploaded'].includes(item.status)
            ? h('button', {
              class: 'btn small ghost',
              style: 'margin-left:8px;padding:2px 8px',
              onClick: async () => {
                if (!confirm('放弃后不会再检查这次提交；如果上传过 CSV，会同时删掉仓库里的临时文件。确定？')) return;
                const result = await discardTask(item.id, state.api ?? undefined);
                toast(result.ok
                  ? '已放弃，临时文件已清理'
                  : `清理失败：${result.error}。恢复记录已保留，可点「重试清理」`);
                render();
              },
            }, item.cleanupError ? '重试清理' : '放弃')
            : null)),
        receiptOnly > 0
          ? h('div', { class: 'hint', style: 'margin-top:0' },
            `另有 ${receiptOnly} 条是关页面时留下的提交凭证，只能确认结果、不能重发。`)
          : null,
        hevyPending.length
          ? h('div', { class: 'hint' },
            `${hevyPending.length} 条 Hevy 导入已经上传过 CSV，点「继续检查」即可，不用重新选文件。`)
          : null,
        h('button', { class: 'btn small', style: 'margin-top:10px', onClick: async () => {
          if (!state.api) return;
          const results = await resumeUnfinished(state.api, { onStatus: (s) => toast(s) });
          const stateOf = (item) => item.result?.state;
          const success = results.filter((item) => stateOf(item) === 'success').length;
          const failed = results.filter((item) => stateOf(item) === 'failure').length;
          const open = results.filter(
            (item) => item.error || !['success', 'failure', 'cancelled'].includes(stateOf(item)),
          ).length;
          const needsFile = results.filter((item) => item.result?.needsFile).length;
          toast(needsFile
            ? `已检查；${needsFile} 条需要重新选择 CSV 文件`
            : `已确认：成功 ${success} 条，失败 ${failed} 条，未结束 ${open} 条`);
          refresh();
        } }, summary.needsCheck ? '继续检查' : '确认结果'),
        h('div', { class: 'hint', style: 'margin-top:8px' },
          '恢复时沿用原 request_id，不会重复写入；超时/未知的任务不会自动丢弃。'),
      ));
    }
    const cleanups = state.demo ? [] : pendingCleanups();
    if (cleanups.length) {
      content.append(h('div', { class: 'card' },
        banner(`有 ${cleanups.length} 个 Hevy 临时文件待清理；删除失败会保留文件索引，不会丢路径。`, 'warn'),
        h('div', { class: 'hint', style: 'margin-top:0;word-break:break-all' },
          cleanups.slice(0, 3).map((item) => item.path).join('、')),
        h('button', { class: 'btn small', style: 'margin-top:10px', onClick: async () => {
          if (!state.api) return;
          const results = await runCleanups(state.api);
          const failed = results.filter((item) => !item.ok).length;
          toast(failed ? `还有 ${failed} 个文件没删掉，稍后可重试` : '临时文件已清理');
          render();
        } }, '重试清理'),
      ));
    }
    if (state.data?.corrupt?.length) {
      content.append(h('div', { class: 'card' },
        banner(`缓存文件损坏：${state.data.corrupt.join('、')}。清缓存后会重新从仓库拉取。`, 'err'),
        h('button', {
          class: 'btn small danger',
          onClick: () => { clearCache(); refresh(); },
        }, '清缓存并刷新'),
      ));
    }
    content.append(pageView());
  }

  main.append(content);
  shell.append(main);
  app.append(shell);
  app.append(bottomNav());
}

function pageView() {
  const [section, ...rest] = state.route;
  const ctx = { state, data: state.data, api: state.api, navigate, refresh, toast };

  switch (section) {
    case 'week': return renderWeek(ctx);
    case 'review':
      return rest[0] ? renderReviewDetail(ctx, rest[0]) : renderReviewList(ctx);
    case 'library': return renderLibrary(ctx, rest);
    case 'record': return renderRecord(ctx, rest);
    case 'settings': return renderSettings(ctx);
    case 'today': return renderToday(ctx);
    default: return renderToday(ctx);
  }
}

function sidebar() {
  const section = state.route[0] || 'today';
  return h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' },
      h('div', { class: 'mark' }, 'AI'),
      h('div', {},
        h('div', { class: 'name' }, 'AI 私人教练'),
        h('div', { class: 'sub' }, '数据在自己的仓库里'),
      ),
    ),
    h('nav', { class: 'nav', 'aria-label': '主导航' },
      NAV.map((item) => h('a', {
        class: section === item.key ? 'on' : '',
        href: `#/${item.key}`,
        'aria-current': section === item.key ? 'page' : null,
        onClick: (event) => { event.preventDefault(); navigate(`/${item.key}`); },
      }, icon(item.icon), h('span', {}, item.label))),
    ),
    h('div', { class: 'sidefoot' },
      repoCard(),
      h('div', { class: 'sync-line' },
        h('span', { class: `dot ${state.error ? 'warn' : state.demo ? 'warn' : 'ok'}` }),
        h('span', {}, state.demo ? '演示数据' : state.data ? `数据 ${relTime(state.data.loadedAt)}` : '未连接'),
      ),
      h('div', { class: 'tip' }, '快捷键：', h('span', { class: 'kbd' }, 'g'), ' 后接 ',
        h('span', { class: 'kbd' }, 't'), h('span', { class: 'kbd' }, 'w'), h('span', { class: 'kbd' }, 'r'),
        h('span', { class: 'kbd' }, 'l'), h('span', { class: 'kbd' }, 'c'), h('span', { class: 'kbd' }, 's'), ' 跳转；',
        h('span', { class: 'kbd' }, 'r'), ' 刷新；', h('span', { class: 'kbd' }, 'Esc'), ' 关菜单'),
    ),
  );
}

function repoCard() {
  if (state.demo) {
    return h('div', { class: 'repo-card' },
      h('div', { class: 'r' }, '演示模式'),
      h('div', { class: 's' }, '不连接 GitHub'),
    );
  }
  const auth = state.auth;
  if (!auth) return h('div');
  return h('div', { class: 'repo-card' },
    h('a', { class: 'r', href: `https://github.com/${auth.owner}/${auth.repo}`, target: '_blank', rel: 'noopener noreferrer' },
      `${auth.owner}/${auth.repo}`),
    h('div', { class: 's' }, auth.remember ? '已记住 PAT' : '本次会话有效'),
  );
}

function topbar() {
  const section = state.route[0] || 'today';
  const [title, desc] = TITLES[section] ?? TITLES.today;
  return h('header', { class: 'topbar' },
    h('div', {},
      h('h1', {}, title),
      h('div', { class: 'desc' }, desc),
    ),
    h('div', { class: 'spacer' }),
    state.demo ? h('span', { class: 'chip' }, '演示模式') : null,
    h('div', { class: 'sync-line' },
      h('span', { class: `dot ${state.error || state.demo ? 'warn' : 'ok'}` }),
      h('span', {}, state.demo ? '演示数据' : state.data ? relTime(state.data.loadedAt) : ''),
    ),
    h('button', { class: 'icon-btn', title: '刷新', 'aria-label': '刷新', onClick: () => refresh() },
      state.refreshing ? h('span', { class: 'dot busy' }) : icon('refresh', 17)),
  );
}

let moreOpen = false;

/** 窄屏底部导航：今天 / 记录 / 本周 / 复盘 / 更多（动作库与设置） */
function bottomNav() {
  const section = state.route[0] || 'today';
  const items = [
    { key: 'today', label: '今天', icon: 'today' },
    { key: 'record', label: '记录', icon: 'record' },
    { key: 'week', label: '本周', icon: 'week' },
    { key: 'review', label: '复盘', icon: 'review' },
  ];
  const nav = h('nav', { class: 'bottom-nav', 'aria-label': '底部导航' },
    items.map((item) => h('a', {
      class: section === item.key ? 'on' : '',
      href: `#/${item.key}`,
      'aria-current': section === item.key ? 'page' : null,
      onClick: (event) => { event.preventDefault(); moreOpen = false; navigate(`/${item.key}`); },
    }, icon(item.icon), h('span', {}, item.label))),
    h('button', {
      class: moreOpen ? 'on' : '',
      'aria-label': '更多导航',
      'aria-expanded': moreOpen ? 'true' : 'false',
      'aria-haspopup': 'menu',
      onClick: (event) => { event.stopPropagation(); moreOpen = !moreOpen; render(); },
    }, icon('settings'), h('span', {}, '更多')),
  );

  if (moreOpen) {
    nav.append(h('div', {
      class: 'more-sheet',
      role: 'menu',
      'aria-label': '更多',
      onClick: (event) => event.stopPropagation(),
    },
    h('a', {
      href: '#/library',
      role: 'menuitem',
      onClick: (event) => { event.preventDefault(); moreOpen = false; navigate('/library'); },
    }, icon('library'), h('span', {}, '动作库')),
    h('a', {
      href: '#/settings',
      role: 'menuitem',
      onClick: (event) => { event.preventDefault(); moreOpen = false; navigate('/settings'); },
    }, icon('settings'), h('span', {}, '设置')),
    ));
  }
  return nav;
}
function loginView() {
  const saved = loadAuth();
  const owner = h('input', { id: 'owner', class: 'input', placeholder: '你的 GitHub 用户名', value: saved?.owner ?? '' });
  const repo = h('input', { id: 'repo', class: 'input', placeholder: 'ai-fitness-coach', value: saved?.repo ?? 'ai-fitness-coach' });
  // 留空 = 连接时自动识别仓库默认分支（main / master 都行），不再写死 master
  const branch = h('input', { id: 'branch', class: 'input', placeholder: '留空自动识别（如 main / master）', value: saved?.branch ?? '' });
  const token = h('input', { id: 'token', class: 'input', type: 'password', placeholder: 'github_pat_… 或 ghp_…', autocomplete: 'off' });
  // 默认不勾：同域名下的其他 GitHub Pages 也能读到 localStorage 里的 PAT
  const remember = h('input', { type: 'checkbox', id: 'remember', checked: false });
  const errorBox = h('div');

  const connectBtn = h('button', { class: 'btn primary block', onClick: async () => {
    let rememberValue = remember.checked;
    if (rememberValue) {
      const okay = confirm(
        '「记住我」会把有写权限的 PAT 存进 localStorage。'
        + '浏览器按域名隔离存储，同域名下的其他 GitHub Pages（例如 767313977.github.io/zhifujing/）'
        + '也能读到它。确定要记住吗？',
      );
      if (!okay) {
        remember.checked = false;
        rememberValue = false;
      }
    }
    const auth = {
      owner: owner.value.trim(),
      repo: repo.value.trim() || 'ai-fitness-coach',
      branch: branch.value.trim(),
      token: token.value.trim(),
      remember: rememberValue,
    };
    if (!auth.owner || !auth.token) {
      clear(errorBox);
      errorBox.append(banner('把账号和 PAT 都填上'));
      return;
    }
    connectBtn.disabled = true;
    connectBtn.textContent = '验证仓库…';
    try {
      const probe = new GitHubApi({ ...auth, ref: resolveBranch(auth.branch) });
      // 必须确认是私有仓库，否则不保存 PAT（健康数据不能进公开仓库）
      const meta = await probe.repoMeta();
      if (!meta.private) throw new PublicRepoError();
      // 用户填的分支 → 仓库默认分支 → main → master，谁先能读到 config.json 就用谁
      const picked = await pickBranch(auth, meta.defaultBranch);
      await picked.api.verifyRepo();
      state.auth = { ...auth, branch: picked.branch };
      state.demo = false;
      sessionStorage.removeItem(DEMO_KEY);
      saveAuth(state.auth);
      setCachePersistence(auth.remember);
      await connect();
      navigate('/today');
      toast(`已验证私有仓库并连接成功（分支 ${picked.branch}）`);
    } catch (error) {
      clear(errorBox);
      errorBox.append(banner(errorText(error), 'err'));
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = '连接仓库';
    }
  } }, '连接仓库');

  return h('div', { class: 'login-wrap' },
    h('div', { class: 'login' },
      h('div', { class: 'logo' }, 'AI'),
      h('h1', {}, 'AI 私人教练'),
      h('p', { class: 'sub' }, '数据只存在你自己的 GitHub 私有仓库里。网页不需要服务器，也不用注册账号。'),
      h('div', { class: 'card' },
        h('div', { class: 'field' }, h('label', { for: 'owner' }, 'GitHub 账号'), owner),
        h('div', { class: 'field' }, h('label', { for: 'repo' }, '仓库名'), repo),
        h('div', { class: 'field' },
          h('label', { for: 'branch' }, '分支'), branch,
          h('div', { class: 'hint' }, '留空会用仓库的默认分支（main 或 master 都行）；填了就必须真实存在。'),
        ),
        h('div', { class: 'field' },
          h('label', { for: 'token' }, 'Fine-grained PAT'), token,
          h('div', { class: 'hint' }, '权限：Contents 读写（导入 Hevy 要用）+ Actions 读写；范围只授权这一个仓库。'),
          h('div', { class: 'hint' }, '连接时会强制检查仓库必须是 Private，并验证 Contents / Actions 读取权限；验证失败不会保存 PAT。'),
          h('div', { class: 'hint' }, '建议把 PAT 的过期时间设在 90 天以内。'),
        ),
        h('label', { class: 'row', style: 'border:0;padding:0 0 12px' },
          remember, h('span', {}, '在这台设备记住我（不勾选时，PAT 和数据缓存都只在本次会话有效）')),
        errorBox,
        connectBtn,
        h('p', { class: 'fine' },
          'PAT 只保存在浏览器本地，直接发往 api.github.com，不经过任何第三方服务器。',
          h('br'), '仓库必须设为私有——里面是你的完整健康数据。'),
      ),
      h('button', { class: 'btn ghost block', style: 'margin-top:12px', onClick: () => {
        state.demo = true;
        state.auth = null;
        sessionStorage.setItem(DEMO_KEY, '1');
        state.data = DEMO_DATA;
        state.loading = false;
        state.error = null;
        state.notice = null;
        navigate('/today');
        render();
      } }, '先看看演示（不连接）'),
    ),
  );
}

/** @param {Error} error */
function errorText(error) {
  if (error instanceof ApiError) return error.message;
  if (error?.message?.includes('Failed to fetch')) return '连不上 api.github.com，检查网络或代理';
  return error?.message ?? String(error);
}

/** @param {Error} error */
function renderError(error) {
  return h('div', { class: 'card' },
    banner(errorText(error), 'err'),
    h('button', { class: 'btn block', onClick: () => connect({ fresh: true }) }, '重试'),
    h('button', { class: 'btn ghost block', style: 'margin-top:8px', onClick: () => {
      clearCache(); clearLocalState(); saveAuth(null);
      state.auth = null; state.data = null; state.error = null; state.notice = null; render();
    } }, '重新登录'),
  );
}

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚更新';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

// 有提交还没完成就关页面，提醒一下
window.addEventListener('beforeunload', (event) => {
  if (!hasPending()) return;
  event.preventDefault();
  event.returnValue = '';
});

// ---------------- 启动 ----------------

window.addEventListener('hashchange', () => {
  moreOpen = false;
  state.route = parseRoute();
  render();
  window.scrollTo({ top: 0 });
});

// 键盘快捷键：g 后接 t/w/r/l/c/s；r 刷新；Esc 关闭「更多」菜单
let gPressed = false;
let gTimer = 0;
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Escape') {
    if (moreOpen) { moreOpen = false; render(); }
    return;
  }
  const map = { t: 'today', w: 'week', r: 'review', l: 'library', c: 'record', s: 'settings' };
  if (event.key === 'g') { gPressed = true; clearTimeout(gTimer); gTimer = setTimeout(() => { gPressed = false; }, 1200); return; }
  if (gPressed && map[event.key]) { navigate(`/${map[event.key]}`); gPressed = false; return; }
  if (event.key === 'r') { event.preventDefault(); refresh(); }
});

function boot() {
  // 方便截图/演示：?demo=1 直接进演示模式
  try {
    if (new URLSearchParams(location.search).get('demo') === '1') sessionStorage.setItem(DEMO_KEY, '1');
  } catch { /* 忽略 */ }
  state.auth = loadAuth();
  // 演示标记优先于登录态，但不清掉 auth；退出演示即可回到真实数据
  state.demo = sessionStorage.getItem(DEMO_KEY) === '1';
  setCachePersistence(Boolean(state.auth?.remember));
  state.route = parseRoute();
  if (!location.hash) location.hash = '#/today';
  if (state.auth || state.demo) connect();
  else render();
}

boot();

if ('serviceWorker' in navigator
    && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  window.addEventListener('load', () => {
    // 已有旧 SW 时，新版本接管后自动刷新一次，避免旧缓存里的模块和新模块混用
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js', { type: 'module', updateViaCache: 'none' }).catch(() => { /* 忽略 */ });
  });
}

export { state, navigate, refresh, connect, saveAuth, toast, fmtDate, todayISO };
