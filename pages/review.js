// @ts-check
/** 复盘：列表 + 单篇 Markdown 阅读。 */
import { h, banner, markdown, clear, toast } from '../js/ui.js';
import { fmtDate } from '../js/data.js';

/** @param {any} ctx */
export function renderReviewList(ctx) {
  const { data, navigate } = ctx;
  const index = data.reviewIndex;
  const reviews = index?.reviews ?? [];

  const wrap = h('div');
  wrap.append(h('div', { class: 'card-title', style: 'margin:4px 0 10px' },
    index?.generated_at ? `索引更新于 ${new Date(index.generated_at).toLocaleString('zh-CN', { hour12: false })}` : ''));

  if (!reviews.length) {
    wrap.append(h('div', { class: 'card' },
      h('div', { class: 'empty' },
        h('div', { class: 'big' }, '还没有复盘'),
        h('div', {}, '周日 21:17 会自动生成；也可以现在手动触发一次。'),
      ),
      h('button', { class: 'btn primary block', onClick: () => navigate('/record/weekly') }, '生成周复盘'),
    ));
    return wrap;
  }

  const grid = h('div', { class: 'grid-2 even' });
  for (const item of reviews) {
    const isCycle = item.kind === 'cycle';
    grid.append(h('div', {
      class: 'card tight',
      style: 'cursor:pointer',
      onClick: () => navigate(`/review/${encodeURIComponent(item.file)}`),
    },
      h('div', { class: 'row', style: 'border:0;padding:0' },
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, isCycle ? `周期报告 · ${item.file.replace('.md', '')}` : `周复盘 · ${weekLabel(item.week_start)}`),
          h('div', { class: 'sub' }, `${item.week_start ?? ''} – ${item.week_end ?? ''}`),
        ),
        h('span', { class: `chip ${item.filled ? 'lime' : ''}` }, item.filled ? '已填写' : '待填写'),
        h('span', { class: 'chip ice' }, isCycle ? '周期' : '周'),
      ),
    ));
  }
  wrap.append(grid);

  wrap.append(h('button', { class: 'btn ghost block', style: 'margin-top:8px', onClick: () => navigate('/record/weekly') }, '生成/刷新本周复盘'));
  return wrap;
}

/** @param {any} ctx @param {string} file */
export function renderReviewDetail(ctx, file) {
  const { data, api, navigate, state } = ctx;
  const wrap = h('div');
  wrap.append(h('button', { class: 'btn ghost small', style: 'margin-bottom:10px', onClick: () => navigate('/review') }, '← 返回复盘列表'));
  const body = h('section', { class: 'card' }, h('div', { class: 'empty' }, '读取中…'));
  wrap.append(body);

  (async () => {
    try {
      let text = null;
      if (state.demo) {
        text = data.reviews?.[file] ?? null;
      } else {
        text = await api.raw(`review/${file}`);
      }
      clear(body);
      if (!text) {
        body.append(banner(`仓库里找不到 review/${file}`, 'err'));
        return;
      }
      body.append(
        h('div', { class: 'field-row', style: 'margin-bottom:12px;max-width:320px' },
          h('button', { class: 'btn small', onClick: () => copyReview(text) }, '复制全文'),
          h('button', { class: 'btn small ghost', onClick: () => window.print() }, '打印 / 存 PDF'),
        ),
        h('div', { class: 'md', html: markdown(text) }),
      );
    } catch (error) {
      clear(body);
      body.append(banner(`读取失败：${error?.message ?? error}`, 'err'));
    }
  })();

  return wrap;
}

/** 复制复盘全文；剪贴板 API 不可用时退回 textarea。 @param {string} text */
async function copyReview(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制全文');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const done = document.execCommand('copy');
    area.remove();
    toast(done ? '已复制全文' : '复制失败，请手动选择');
  }
}

function weekLabel(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00+08:00`);
  const first = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - first) / 86400000 + first.getDay() + 1) / 7);
  return `W${String(week).padStart(2, '0')}`;
}
