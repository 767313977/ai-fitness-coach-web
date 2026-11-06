// @ts-check
/** 本周：关键数字 + 趋势图 + 记录热力图 + 数据新鲜度。 */
import { h, banner, lineChart, barChart, heatmap } from '../js/ui.js';
import { fmtNum, fmtDate, num } from '../js/data.js';

/** @param {any} ctx */
export function renderWeek(ctx) {
  const { data, navigate } = ctx;
  const s = data.summary;
  const t = s?.targets ?? {};
  const cfg = data.config?.weekly_targets ?? {};

  if (!s) {
    return h('div', { class: 'card' },
      h('div', { class: 'empty' },
        h('div', { class: 'big' }, '还没有 data/summary.json'),
        h('div', {}, '去记一次打卡或饮食，Actions 会自动生成它。'),
      ),
      h('button', { class: 'btn', onClick: () => navigate('/record/checkin') }, '去打卡'),
    );
  }

  const wrap = h('div', { class: 'stack' });

  const strengthLast = s.strength_last_date;
  if (strengthLast) {
    const days = Math.floor((Date.now() - new Date(`${strengthLast}T00:00:00+08:00`).getTime()) / 86400000);
    if (days >= 7) {
      wrap.append(banner(`力量数据已经 ${days} 天没导入了（上次 ${fmtDate(strengthLast)}），本周的力量数字会偏低。`, 'warn'));
    }
  } else {
    wrap.append(banner('还没有任何力量记录。第一次导入 Hevy 后这里才会有数字。', 'info'));
  }

  wrap.append(statsGrid([
    ['力量训练', fmtNum(s.strength_sessions), '次', t.strength_sessions],
    ['训练容量', fmtNum(s.tonnage_kg), 'kg', null],
    ['有氧', fmtNum(s.cardio_minutes), '分钟', `${fmtNum(t.cardio_minutes ?? cfg.cardio_minutes)}–${fmtNum(t.cardio_minutes_max ?? cfg.cardio_minutes_max)}`],
    ['日均热量', fmtNum(s.avg_kcal), 'kcal', fmtNum(t.target_kcal ?? cfg.target_kcal)],
    ['日均蛋白', fmtNum(s.avg_protein_g), 'g', fmtNum(t.target_protein_g)],
    ['记录天数', fmtNum(s.diet_days), '天', '≥5'],
  ]));

  const charts = h('div', { class: 'grid-2 even' },
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', { class: 'grow' },
          h('h3', {}, '体重趋势'),
          h('div', { class: 'sub' }, '近 4 周 · 周均体重'),
        ),
        h('span', { class: 'chip' }, '只改方向不改口径'),
      ),
      h('div', { html: lineChart(
        (s.weight_weekly ?? []).map((w) => ({ label: shortDate(w.week_start), value: num(w.avg_weight_kg) })),
        { unit: ' kg', height: 150, yPad: 1 },
      ) }),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', { class: 'grow' },
          h('h3', {}, '每日热量'),
          h('div', { class: 'sub' }, `红线 = 目标 ${fmtNum(t.target_kcal ?? cfg.target_kcal)} kcal`),
        ),
      ),
      h('div', { html: barChart(
        (s.daily_kcal ?? []).map((d) => ({ label: shortDate(d.date), value: num(d.kcal) })),
        { target: num(t.target_kcal ?? cfg.target_kcal), height: 150 },
      ) }),
    ),
  );
  wrap.append(charts);

  const lower = h('div', { class: 'grid-2 even' },
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', { class: 'grow' },
          h('h3', {}, '膝痛'),
          h('div', { class: 'sub' }, '近 7 天 · 红线 4 分 = 比基准高 2 分'),
        ),
      ),
      h('div', { html: lineChart(
        (s.knee_pain_7d ?? []).map((d) => ({ label: shortDate(d.date), value: num(d.knee_pain) })),
        { height: 130, redline: 4, yMin: 0, yMax: kneeAxisMax(s) },
      ) }),
      h('div', { class: 'hint', style: 'margin-top:6px' }, '碰到 4 分就当天停下肢动作，连续两次建议就医。'),
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', { class: 'grow' },
          h('h3', {}, '记录热力图'),
          h('div', { class: 'sub' }, '近 26 周 · 每天记了几类（训练/饮食/打卡/手表/身体）'),
        ),
      ),
      h('div', { html: heatmap(activityDays(data), { weeks: 26 }) }),
      h('div', { class: 'hint', style: 'margin-top:8px' }, activitySummary(data)),
    ),
  );
  wrap.append(lower);

  wrap.append(h('div', { class: 'grid-2 even' },
    h('section', { class: 'card' },
      h('div', { class: 'card-title' }, '数据来源'),
      h('div', { class: 'hint' },
        '所有数字来自仓库里的 CSV，由 Actions 写入；summary.json 由 build_summary.py 生成，网页只读不写。',
        h('br'),
        s.generated_at ? `summary 生成于 ${new Date(s.generated_at).toLocaleString('zh-CN', { hour12: false })}` : 'summary 缺少生成时间'),
    ),
    h('div', { class: 'stack', style: 'gap:10px' },
      h('button', { class: 'btn ghost', onClick: () => navigate('/review') }, '看本周复盘'),
      h('button', { class: 'btn ghost', onClick: () => navigate('/record/import') }, '导入 Hevy'),
    ),
  ));

  return wrap;
}

/**
 * 每天记了几类数据。
 * @param {any} data
 */
function activityDays(data) {
  /** @type {Map<string, Set<string>>} */
  const map = new Map();
  const add = (rows, kind, field = 'date') => {
    for (const row of rows ?? []) {
      const d = row?.[field];
      if (!d) continue;
      if (!map.has(d)) map.set(d, new Set());
      map.get(d).add(kind);
    }
  };
  add(data.strength, 'strength');
  add(data.diet, 'diet');
  add(data.checkin, 'checkin');
  add(data.daily, 'watch');
  add(data.body, 'body');
  add(data.summary?.cardio_manual_14d, 'cardio');
  return [...map.entries()].map(([date, kinds]) => ({ date, value: kinds.size }));
}

/** @param {any} data */
function activitySummary(data) {
  const days = activityDays(data);
  if (!days.length) return '还没有任何记录';
  const full = days.filter((d) => d.value >= 3).length;
  const total = days.length;
  return `${total} 天有记录，其中 ${full} 天记了 3 类以上。`;
}

/**
 * @param {[string, string, string, string|null][]} items
 */
function statsGrid(items) {
  return h('div', { class: 'stats' },
    items.map(([label, value, unit, target]) => h('div', { class: 'stat' },
      h('div', { class: 'k' }, label),
      h('div', { class: 'v' }, value, h('small', {}, unit)),
      target ? h('div', { class: 't' }, `目标 ${target}`) : null,
    )),
  );
}

function kneeAxisMax(summary) {
  const values = (summary?.knee_pain_7d ?? []).map((d) => Number(d.knee_pain)).filter((v) => Number.isFinite(v));
  return Math.max(5, ...values.map((v) => v + 1));
}

function weekRange(week) {
  if (!week) return '';
  return `${shortDate(week.start)} – ${shortDate(week.end)}`;
}

function shortDate(iso) {
  if (!iso) return '';
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
}
