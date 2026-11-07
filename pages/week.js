// @ts-check
/** 本周：关键数字 + 趋势图 + 记录热力图 + 个人纪录与趋势 + 数据新鲜度。 */
import { h, banner, lineChart, barChart, heatmap, escapeHtml } from '../js/ui.js';
import { fmtNum, fmtDate, num, weekStart } from '../js/data.js';
import {
  personalRecords, progressStatus, recordsThisWeek, weeklySetsByMuscle, STATUS_LABEL,
} from '../js/analytics.js';
import { loadExercises, matchPlan } from '../js/dataset.js';

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

  wrap.append(analyticsCard(data));

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

  const waistRows = s.body?.waist_weekly_8w ?? [];
  if (waistRows.length) {
    const latestWaist = num(s.body?.latest_waist?.waist_cm);
    wrap.append(h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', { class: 'grow' },
          h('h3', {}, '腰围趋势'),
          h('div', { class: 'sub' }, '近 8 周 · 每周一次，取最早一条'),
        ),
        latestWaist != null ? h('span', { class: 'chip' }, `最近 ${fmtNum(latestWaist)} cm`) : null,
      ),
      h('div', { html: lineChart(
        waistRows.map((w) => ({ label: shortDate(w.week_start), value: num(w.waist_cm) })),
        { unit: ' cm', height: 140, yPad: 1 },
      ) }),
    ));
  }

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

/**
 * 个人纪录与趋势：本周破纪录 + 动作状态 + 本周肌群组数。
 * 状态只做展示，加减重仍以 summary.exercise_history 为准。
 * @param {any} data
 */
function analyticsCard(data) {
  const rows = data.strength ?? [];
  const card = h('section', { class: 'card' });
  card.append(h('div', { class: 'card-head' },
    h('div', { class: 'grow' },
      h('h3', {}, '个人纪录与趋势'),
      h('div', { class: 'sub' }, '按训练次数比较，不按周；加减重仍以 summary.exercise_history 为准'),
    ),
  ));

  if (!rows.length) {
    card.append(h('div', { class: 'empty' },
      h('div', { class: 'big' }, '还没有力量记录'),
      h('div', {}, '导入 Hevy 后这里会出现个人纪录与动作状态。')));
    return card;
  }

  const week = weekStart();
  const prs = recordsThisWeek(rows, week);
  const prBox = h('div', { class: 'chip-row' });
  if (prs.length) {
    prs.slice(0, 8).forEach((p) => prBox.append(h('span', { class: 'chip lime' },
      `${p.exercise} · ${p.label} `, h('span', { class: 'num' }, fmtNum(p.value)))));
  } else {
    prBox.append(h('span', { class: 'hint' }, '本周还没有破纪录'));
  }
  card.append(h('div', { class: 'card-title', style: 'margin-top:14px' }, '本周破纪录'), prBox);

  const statusBox = h('div', { style: 'margin-top:14px' });
  card.append(h('div', { class: 'card-title' }, '动作状态'), statusBox);
  const muscleBox = h('div', { style: 'margin-top:14px' });
  card.append(h('div', { class: 'card-title' }, '本周肌群组数'), muscleBox);

  const names = [];
  for (const day of data.routine?.days ?? []) {
    for (const ex of day.exercises ?? []) {
      if (ex.name && !names.includes(ex.name)) names.push(ex.name);
    }
  }

  (async () => {
    for (const name of names) {
      const st = progressStatus(rows, name);
      const cls = st.status === 'up' ? 'lime' : st.status === 'down' ? 'red' : '';
      statusBox.append(h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, name),
          st.last ? h('div', { class: 'sub' }, `最近 ${fmtDate(st.last.date)}：${lastSetText(st.last)}`) : null,
        ),
        h('span', { class: `chip ${cls}` }, STATUS_LABEL[st.status] ?? st.status),
        st.status === 'plateau'
          ? h('span', { class: 'sub', style: 'margin-left:8px' }, '连续 3 次训练没有提高')
          : null,
      ));
    }

    try {
      const dataset = await loadExercises();
      const map = new Map();
      // 先按课表 key 匹配精选库（中文名与精选库不一定完全同名）
      const planMap = matchPlan(data.routine, dataset);
      for (const day of data.routine?.days ?? []) {
        for (const ex of day.exercises ?? []) {
          const hit = planMap.get(ex.key);
          if (hit?.target) map.set(ex.name, hit.target);
        }
      }
      // 其余动作按中文名/英文名兜底
      for (const item of dataset) if (item.zh && !map.has(item.zh)) map.set(item.zh, item.target);
      for (const name of names) {
        if (map.has(name)) continue;
        const hit = dataset.find((d) => d.name === name);
        if (hit) map.set(name, hit.target);
      }
      const items = weeklySetsByMuscle(rows, map, week);
      if (!items.length) {
        muscleBox.append(h('div', { class: 'hint' }, '本周还没有组数记录'));
        return;
      }
      muscleBox.append(h('div', { html: muscleBars(items), style: 'max-width:520px' }));
    } catch (error) {
      muscleBox.append(h('div', { class: 'hint' }, `肌群统计失败：${error?.message ?? error}`));
    }
  })();

  return card;
}

/** @param {any} session */
function lastSetText(session) {
  if (!session) return '';
  if (!session.weight) return `${fmtNum(session.reps)} 次`;
  return `${fmtNum(session.weight)} kg × ${fmtNum(session.reps)}`;
}

/** 横向条形图：复用 .chart .cbar，避免命中进度条的 .bar 样式 */
function muscleBars(items) {
  const max = Math.max(...items.map((i) => i.sets), 1);
  const rowH = 24;
  const W = 340;
  const labelW = 96;
  const barW = W - labelW - 34;
  const H = items.length * rowH + 6;
  const rows = items.map((item, index) => {
    const y = index * rowH + 4;
    const width = Math.max(3, (item.sets / max) * barW);
    return `<text class="axis" x="0" y="${y + 12}">${escapeHtml(item.muscle)}</text>
      <rect class="cbar" x="${labelW}" y="${y}" width="${width.toFixed(1)}" height="14" rx="3"/>
      <text class="axis" x="${(labelW + width + 6).toFixed(1)}" y="${y + 12}">${item.sets}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="本周肌群组数">${rows}</svg>`;
}
