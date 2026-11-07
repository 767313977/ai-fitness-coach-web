// @ts-check
/** 设置：账号、连接测试、数据导出、缓存、演示模式。 */
import { h, banner, toast } from '../js/ui.js';
import { clearCache } from '../js/api.js';
import { hevyMode, hevySyncStatus, fmtDateTime, HEVY_SYNC_STALE_HOURS } from '../js/data.js';

const AUTH_KEY = 'afc.auth.v1';
const DEMO_KEY = 'afc.demo';

/** @param {any} ctx */
export function renderSettings(ctx) {
  const { state } = ctx;
  const wrap = h('div');

  if (state.demo) {
    wrap.append(banner('当前是演示模式，所有数据都是假的，提交也不会生效。', 'info'));
    const grid = h('div', { class: 'grid-2' });
    grid.append(h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('div', { class: 'card-title' }, state.auth ? '演示模式' : '切换到真实仓库'),
        h('button', { class: 'btn primary block', onClick: () => {
          sessionStorage.removeItem(DEMO_KEY);
          location.hash = '#/settings';
          location.reload();
        } }, state.auth ? '退出演示，回到我的仓库' : '用 PAT 连接我的仓库'),
      ),
      exportCard(ctx),
    ));
    grid.append(h('div', { class: 'stack' }, aboutCard()));
    wrap.append(grid);
    return wrap;
  }

  const auth = state.auth;
  if (!auth) return wrap;

  const left = h('div', { class: 'stack' });
  const right = h('div', { class: 'stack' });

  left.append(h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '仓库'),
    h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, `${auth.owner}/${auth.repo}`),
        h('div', { class: 'sub' }, `分支 ${auth.branch || 'master'} · PAT ${maskToken(auth.token)} · ${auth.remember ? '已记住' : '仅本次会话'}`),
      ),
      h('a', { class: 'chip ice', href: `https://github.com/${auth.owner}/${auth.repo}`, target: '_blank', rel: 'noopener noreferrer' }, '打开仓库'),
    ),
  ));

  const testStatus = h('div', { class: 'hint', style: 'min-height:20px' });
  left.append(h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '连接'),
    h('div', { class: 'field-row' },
      h('button', { class: 'btn', onClick: async () => {
        testStatus.textContent = '测试中…';
        try {
          const info = await state.api.test();
          testStatus.textContent = `连接正常 · 私有仓库 · 工作流 ${info.workflowCount} 个 · summary ${info.summaryAt ?? '缺失'}`;
        } catch (error) {
          testStatus.textContent = `失败：${error?.message ?? error}`;
        }
      } }, '测试连接'),
      h('button', { class: 'btn ghost', onClick: () => ctx.refresh() }, '重新拉取数据'),
    ),
    testStatus,
  ));

  left.append(exportCard(ctx));
  left.append(dataStatusCard(ctx));

  right.append(h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '本机缓存'),
    h('div', { class: 'hint', style: 'margin-bottom:10px' }, '网页会缓存读取过的文件（ETag 做 304 校验）。summary / sync_state 只缓存 30 秒，其它数据 60 秒，点「刷新」会强制重新拉取。缓存损坏时清一下。'),
    h('div', { class: 'field-row' },
      h('button', { class: 'btn small', onClick: () => { clearCache(); toast('缓存已清，正在重新拉取'); ctx.refresh(); } }, '清缓存并刷新'),
      h('button', { class: 'btn small danger', onClick: () => {
        if (!confirm('退出后会清掉本机保存的 PAT 和缓存的数据，确定？')) return;
        clearCache();
        localStorage.removeItem(AUTH_KEY);
        sessionStorage.removeItem(AUTH_KEY);
        sessionStorage.removeItem(DEMO_KEY);
        location.hash = '#/today';
        location.reload();
      } }, '退出登录'),
    ),
  ));

  right.append(h('section', { class: 'card' },
    h('div', { class: 'card-title' }, 'PAT 与同域名风险'),
    h('div', { class: 'hint' },
      'localStorage 按域名隔离，不按路径。本站和同一账号下的其他 GitHub Pages（例如 /zhifujing/）同域，'
      + '勾选「记住我」后，那边的任何脚本也能读到这个有写权限的 PAT。登录页默认不勾。',
      h('br'),
      '根本解决二选一：(a) 给 Web 版配独立域名或子域名；(b) 把 zhifujing 的 Pages 迁到别处。'
      + '在定下来之前，建议不要勾「记住我」，每次开新标签页重新填 PAT。'),
  ));

  right.append(h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '演示模式'),
    h('div', { class: 'hint', style: 'margin-bottom:10px' }, '用假数据看看界面，不会连接 GitHub。'),
    h('button', { class: 'btn block', onClick: () => {
      sessionStorage.setItem(DEMO_KEY, '1');
      location.hash = '#/today';
      location.reload();
    } }, '进入演示模式'),
  ));

  right.append(aboutCard());

  wrap.append(h('div', { class: 'grid-2' }, left, right));
  return wrap;
}

/** 数据状态：离线、缺失文件、缓存损坏、Hevy 同步。 */
function dataStatusCard(ctx) {
  const d = ctx.data ?? {};
  const card = h('section', { class: 'card' }, h('div', { class: 'card-title' }, '数据状态'));
  if (d.offline) {
    const at = d.offlineAt
      ? new Date(d.offlineAt).toLocaleString('zh-CN', { hour12: false })
      : '上次';
    card.append(banner(`离线：显示的是 ${at} 的缓存数据。`, 'warn'));
  }
  const missing = d.missing ?? [];
  card.append(statusRow(
    '缺失文件',
    missing.length ? `${missing.length} 个：${missing.join('、')}` : '无',
    missing.length ? 'red' : 'lime',
  ));
  const corrupt = d.corrupt ?? [];
  if (corrupt.length) card.append(statusRow('缓存损坏', corrupt.join('、'), 'red'));
  if (hevyMode(d.config) === 'api') {
    const sync = hevySyncStatus(d.syncState);
    const text = sync.unknown
      ? '还没有同步记录'
      : `${fmtDateTime(sync.at)} · ${sync.stale ? `超过 ${HEVY_SYNC_STALE_HOURS} 小时` : '正常'}`;
    card.append(statusRow('Hevy 同步', text, sync.unknown || sync.stale ? 'red' : 'lime'));
  } else {
    card.append(statusRow('Hevy 同步', '手动上传 CSV', ''));
  }
  card.append(h('div', { class: 'field-row', style: 'margin-top:10px' },
    h('button', { class: 'btn small', onClick: () => ctx.navigate('/record/import') }, '去导入页'),
    h('button', { class: 'btn small ghost', onClick: () => { clearCache(); ctx.refresh(); } }, '清缓存并刷新'),
  ));
  return card;
}

/** @param {string} label @param {string} text @param {'red'|'lime'|''} tone */
function statusRow(label, text, tone) {
  return h('div', { class: 'row' },
    h('div', { class: 'grow' },
      h('div', { class: 'name' }, label),
      h('div', { class: 'sub', style: 'word-break:break-all' }, text)),
    tone ? h('span', { class: `chip ${tone}` }, tone === 'red' ? '需处理' : '正常') : null,
  );
}

/** 导出当前读到的全部数据为 JSON 文件 */
function exportCard(ctx) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '导出'),
    h('div', { class: 'hint', style: 'margin-bottom:10px' },
      '把当前读到的数据（配置 / 汇总 / 课表 / 复盘索引 / 五张 CSV：daily、strength、diet、checkin、body）打包成一个 JSON 下载。原始文件仍然在仓库里。'),
    h('button', { class: 'btn block', onClick: () => {
      const d = ctx.data ?? {};
      const payload = {
        exported_at: new Date().toISOString(),
        source: ctx.state.demo ? 'demo' : `${ctx.state.auth?.owner}/${ctx.state.auth?.repo}`,
        config: d.config,
        summary: d.summary,
        routine: d.routine,
        review_index: d.reviewIndex,
        daily: d.daily,
        strength: d.strength,
        diet: d.diet,
        checkin: d.checkin,
        body: d.body,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ai-fitness-coach-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('已导出');
    } }, '下载 JSON'),
  );
}

function aboutCard() {
  return h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '关于'),
    h('div', { class: 'hint' },
      'Web 版是手机 App 之外的第二个客户端：读 GitHub Contents API；数据写入只通过 Actions，唯一例外是导入 Hevy 时先把 CSV 上传到 uploads/（需要 Contents 读写权限）。',
      h('br'),
      '数据和 App 完全同源，不经过任何中间服务器。',
      h('br'),
      '动作库数据 © hasaneyldrm/exercises-dataset（MIT），不含 Gym visual 的图片/GIF。动作插图 © Bryl Lim / Everkinetic，CC BY-SA 4.0。',
      h('br'),
      '版本 web-0.3.0 · 契约见仓库 docs/数据契约.md'),
  );
}

function maskToken(token) {
  if (!token) return '—';
  if (token.length <= 12) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
