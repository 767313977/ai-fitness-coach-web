// @ts-check
/** 今天：今日课表 + 本周还差什么 + 快捷记录 + 数据状态。 */
import { h, icon, banner, lineChart } from '../js/ui.js';
import {
  dayFor, cycleLabel, weekGaps, weekForecast, exerciseHistory,
  fmtDate, fmtDateTime, fmtNum, num, todayISO,
  hevyMode, hevySyncStatus, HEVY_SYNC_STALE_HOURS,
} from '../js/data.js';

const TYPE_LABEL = { strength: '力量', cardio: '有氧', rest: '休息' };

/** @param {any} ctx */
export function renderToday(ctx) {
  const { data, navigate } = ctx;
  const iso = todayISO();
  const plan = dayFor(data.routine, iso);
  const summary = data.summary;

  const grid = h('div', { class: 'grid-2' });
  const left = h('div', { class: 'stack' });
  const right = h('div', { class: 'stack' });

  left.append(hero(plan, summary, iso));

  if (!data.routine) {
    left.append(banner('还没读到 plan/routine.json，先确认仓库里有没有这份课表', 'warn'));
  }

  if (plan?.type === 'strength') left.append(strengthCard(plan, summary, iso));
  else if (plan?.type === 'cardio') left.append(cardioCard(plan, navigate));
  else left.append(restCard(plan));

  right.append(gaps(summary, data.config, data.routine, iso));
  const trend = bodyTrend(summary);
  if (trend) right.append(trend);
  right.append(quickActions(navigate));
  right.append(statusCard(data, summary, navigate));

  grid.append(left, right);
  return grid;
}

function hero(plan, summary, iso) {
  const chips = [];
  if (plan) {
    chips.push(h('span', { class: `chip ${plan.type === 'rest' ? '' : 'lime'}` }, TYPE_LABEL[plan.type] ?? plan.type));
    if (plan.duration_min) chips.push(h('span', { class: 'chip' }, `${plan.duration_min} 分钟`));
    if (plan.type === 'strength') chips.push(h('span', { class: 'chip' }, `${plan.exercises?.length ?? 0} 个动作`));
    if (plan.type === 'cardio' && plan.segments_min) {
      chips.push(h('span', { class: 'chip' }, `分段 ${plan.segments_min.join('+')} 分钟`));
    }
  }
  return h('section', { class: 'hero' },
    h('div', { class: 'eyebrow' }, `${cycleLabel(summary) || '本周'} · ${fmtDate(iso)}`),
    h('h1', {}, plan?.title ?? '今天没有排课'),
    h('p', { class: 'lede' }, plan?.focus ?? (plan?.type === 'rest' ? '休息也是训练的一部分' : '没有课表数据')),
    h('div', { class: 'chip-row' }, chips),
  );
}

function gaps(summary, config, routine, iso) {
  const items = weekGaps(summary, config);
  const forecast = new Map(weekForecast(summary, routine, config, iso).map((f) => [f.key, f]));
  const card = h('section', { class: 'card' }, h('div', { class: 'card-title' }, '本周进度'));
  if (!items.length) {
    card.append(h('div', { class: 'empty' }, '还没有本周数据'));
    return card;
  }
  for (const item of items) {
    const done = item.done ?? 0;
    const target = item.target ?? 0;
    const ratio = target > 0 ? Math.min(done / target, 1) : 0;
    const over = item.max && done > item.max;
    card.append(h('div', { class: 'metric' },
      h('div', { class: 'top' },
        h('span', { class: 'k' }, item.label),
        h('span', { class: 'v' }, h('b', {}, fmtNum(done)), ` / ${fmtNum(target)} ${item.unit}`),
      ),
      h('div', { class: 'bar' }, h('i', {
        class: over ? 'over' : ratio >= 1 ? '' : 'warn',
        style: `width:${Math.round(ratio * 100)}%`,
      })),
      forecast.has(item.key)
        ? h('div', { class: 'hint', style: 'margin-top:0' }, forecastText(forecast.get(item.key)))
        : null,
    ));
  }
  if (summary?.generated_at) {
    card.append(h('div', { class: 'hint' }, `summary 更新于 ${new Date(summary.generated_at).toLocaleString('zh-CN', { hour12: false })}`));
  }
  return card;
}

/** @param {any} f */
function forecastText(f) {
  if (f.done >= f.target) return `已达标（目标 ${fmtNum(f.target)} ${f.unit}）`;
  const left = f.key === 'strength' ? `剩 ${f.remaining} 个力量日` : `剩 ${fmtNum(f.remaining)} 分钟计划`;
  if (f.reachable) return `${left}，最多到 ${fmtNum(f.projected)} ${f.unit}，可以达标`;
  return `${left}，最多到 ${fmtNum(f.projected)} ${f.unit}，还差 ${fmtNum(f.target - f.projected)} ${f.unit}`;
}

function strengthCard(plan, summary, iso) {
  const history = summary?.exercise_history ?? {};
  const exercises = plan.exercises ?? [];
  const doneKey = `afc.today.done.${iso}`;
  const done = loadDone(doneKey);
  /** @type {{key:string, boxes:HTMLInputElement[], nodes:Element[]}[]} */
  const links = [];

  const counter = h('span', { class: 'chip' }, '');
  const progress = h('i', { style: 'width:0%' });
  const updateProgress = () => {
    const count = exercises.filter((ex, index) => done.has(exKeyOf(ex, index))).length;
    counter.textContent = `今日已完成 ${count} / ${exercises.length} 个动作`;
    counter.className = `chip ${exercises.length && count === exercises.length ? 'lime' : ''}`.trim();
    progress.style.width = `${exercises.length ? Math.round((count / exercises.length) * 100) : 0}%`;
  };

  const toggle = (key, checked) => {
    if (checked) done.add(key); else done.delete(key);
    try { sessionStorage.setItem(doneKey, JSON.stringify([...done])); } catch { /* 隐私模式忽略 */ }
    for (const link of links.filter((item) => item.key === key)) {
      for (const box of link.boxes) box.checked = checked;
      for (const node of link.nodes) node.classList.toggle('done', checked);
    }
    updateProgress();
  };

  /**
   * 同一动作在桌面表格和手机卡片里各有一个勾选框，状态共用。
   * @param {string} key
   * @param {Element} node
   */
  const bind = (key, node) => {
    const box = h('input', { type: 'checkbox', class: 'ex-check', 'aria-label': '标记完成' });
    box.checked = done.has(key);
    box.addEventListener('change', () => toggle(key, box.checked));
    const link = { key, boxes: [box], nodes: [node] };
    links.push(link);
    if (done.has(key)) node.classList.add('done');
    return box;
  };

  const rows = exercises.map((ex, index) => {
    const key = exKeyOf(ex, index);
    const last = exerciseHistory(history, ex.key);
    const checkCell = h('td', { class: 'check-cell' });
    const row = h('tr', {},
      checkCell,
      h('td', { class: 'muted' }, index + 1),
      h('td', {}, h('div', { class: 'name' }, ex.name), ex.cue ? h('div', { class: 'sub' }, ex.cue) : null),
      h('td', { class: 'muted' }, repLabel(ex), h('br'), weightLabel(ex)),
      h('td', { class: 'muted' }, last ? `${last.date ? fmtDate(last.date) : ''} ${lastValueText(last)}` : '—'),
      h('td', {}, last?.next_hint ? h('span', { class: 'chip lime' }, last.next_hint) : h('span', { class: 'muted' }, '—')),
    );
    checkCell.appendChild(bind(key, row));
    return row;
  });

  const table = h('table', { class: 'table strength-table' },
    h('thead', {}, h('tr', {},
      h('th', { style: 'width:34px' }, '✓'),
      h('th', { style: 'width:34px' }, '#'),
      h('th', {}, '动作'),
      h('th', {}, '处方'),
      h('th', {}, '上次'),
      h('th', {}, '建议'),
    )),
    h('tbody', {}, rows),
  );

  const cards = exercises.map((ex, index) => {
    const key = exKeyOf(ex, index);
    const last = exerciseHistory(history, ex.key);
    const card = h('div', { class: 'ex-card' },
      h('div', { class: 'ex-card-head' },
        h('span', { class: 'idx' }, String(index + 1)),
        h('div', { class: 'grow' },
          h('div', { class: 'n' }, ex.name),
          ex.cue ? h('div', { class: 'sub' }, ex.cue) : null,
        ),
      ),
      h('div', { class: 'ex-meta' },
        h('span', {}, repLabel(ex)),
        h('span', {}, weightLabel(ex)),
      ),
      h('div', { class: 'ex-meta' },
        h('span', { class: 'muted' }, last ? `上次 ${fmtDate(last.date)} ${lastValueText(last)}` : '还没有记录'),
        last?.next_hint ? h('span', { class: 'chip lime' }, last.next_hint) : null,
      ),
    );
    const head = card.querySelector('.ex-card-head');
    if (head) head.appendChild(bind(key, card));
    return card;
  });

  updateProgress();

  return h('section', { class: 'card pad-0' },
    h('div', { style: 'padding:18px 18px 8px' },
      h('div', { class: 'card-head', style: 'margin-bottom:5px;flex-wrap:wrap;gap:8px' },
        h('div', { class: 'grow' },
          h('h3', {}, plan.title),
          h('div', { class: 'sub' }, plan.hevy_routine_id ? `Hevy 模板：${plan.hevy_routine_id}` : ''),
        ),
        counter,
        plan.warmup ? h('span', { class: 'chip' }, `热身 ${plan.warmup_min ?? 8} 分钟`) : null,
      ),
      h('div', { class: 'bar', style: 'margin:8px 0 6px' }, progress),
      plan.warmup ? h('div', { class: 'hint', style: 'margin-bottom:6px' }, plan.warmup) : null,
    ),
    h('div', { class: 'only-desktop', style: 'padding:0 18px 14px' }, table),
    h('div', { class: 'only-mobile ex-cards' }, cards),
    h('div', { class: 'hint', style: 'padding:0 18px 14px' }, '勾选只存在本机浏览器，当天有效，不会写回仓库。'),
  );
}

/** 动作在本地的稳定 key：优先用课表 key，其次动作名。 */
function exKeyOf(ex, index) {
  return ex?.key || ex?.name || `idx-${index}`;
}

/** @param {string} key */
function loadDone(key) {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) || '[]');
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch { return new Set(); }
}

function cardioCard(plan, navigate) {
  const segments = plan.segments_min ?? [];
  const total = segments.reduce((a, b) => a + b, 0);
  const hr = plan.hr_zone ?? [];
  return h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '有氧'),
    h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, plan.title),
        h('div', { class: 'sub' },
          segments.length ? `分段 ${segments.join(' + ')} 分钟（合计 ${total}）` : '—',
          hr.length ? ` · 心率 ${hr[0]}–${hr[1]}` : ''),
        plan.focus ? h('div', { class: 'sub', style: 'margin-top:4px' }, plan.focus) : null,
      ),
      h('div', { class: 'val' }, `${total}`, h('small', {}, ' 分钟')),
    ),
    h('button', { class: 'btn primary block', style: 'margin-top:12px', onClick: () => navigate('/record/cardio') },
      '记录今天的有氧'),
  );
}

function restCard(plan) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '休息日'),
    h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, plan?.title ?? '完全休息'),
        h('div', { class: 'sub' }, plan?.note ?? plan?.focus ?? '睡够、吃够蛋白，不做额外训练'),
      ),
      h('div', { class: 'val' }, '恢复'),
    ),
  );
}

function quickActions(navigate) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-title' }, '快速记录'),
    h('div', { class: 'grid-2 even', style: 'gap:8px' },
      h('button', { class: 'btn', onClick: () => navigate('/record/checkin') }, '打卡'),
      h('button', { class: 'btn', onClick: () => navigate('/record/cardio') }, '有氧'),
      h('button', { class: 'btn', onClick: () => navigate('/record/diet') }, '饮食'),
      h('button', { class: 'btn', onClick: () => navigate('/record/body') }, '身体'),
    ),
  );
}

function statusCard(data, summary, navigate) {
  const last = summary?.strength_last_date;
  let days = null;
  if (last) days = Math.floor((Date.now() - new Date(`${last}T00:00:00+08:00`).getTime()) / 86400000);
  const card = h('section', { class: 'card tight' },
    h('div', { class: 'card-title' }, '数据状态'),
    h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, last ? `上次力量记录 ${fmtDate(last)}` : '还没有力量记录'),
        h('div', { class: 'sub' }, days != null && days >= 7 ? `已经 ${days} 天没导入了，去「记录 → 导入 Hevy」` : '数据是最新的'),
      ),
      h('span', { class: `chip ${days != null && days >= 7 ? 'red' : ''}` }, days == null ? '待导入' : `${days} 天前`),
    ),
  );

  if (hevyMode(data.config) === 'api') {
    const sync = hevySyncStatus(data.syncState);
    const text = sync.unknown
      ? '还没有同步记录'
      : `${fmtDateTime(sync.at)} · ${agoText(sync.hours)}${sync.stale ? `（超过 ${HEVY_SYNC_STALE_HOURS} 小时）` : ''}`;
    card.append(h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, 'Hevy 自动同步'),
        h('div', { class: 'sub' }, text),
      ),
      h('span', { class: `chip ${sync.unknown || sync.stale ? 'red' : 'lime'}` },
        sync.unknown ? '未同步' : sync.stale ? '已超时' : '正常'),
    ));
    if (sync.unknown || sync.stale) {
      card.append(h('div', { class: 'hint' }, '去导入页点「立即同步」，或到 Actions 看「Hevy 自动同步」是不是失败了。'));
    }
    card.append(h('button', { class: 'btn ghost small', style: 'margin-top:8px', onClick: () => navigate('/record/import') }, '去导入页'));
  } else {
    card.append(h('button', { class: 'btn ghost small', style: 'margin-top:8px', onClick: () => navigate('/record/import') }, '导入 Hevy'));
  }

  card.append(h('button', { class: 'btn ghost small', style: 'margin-top:8px;margin-left:8px', onClick: () => navigate('/week') }, '看本周汇总'));
  return card;
}

/** @param {number|null} hours */
function agoText(hours) {
  if (hours === null || hours === undefined) return '';
  if (hours < 1) return '刚刚';
  if (hours < 24) return `${Math.round(hours)} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/** 体重 / 腰围小图：数据来自 summary，不额外请求。 */
function bodyTrend(summary) {
  const weight = (summary?.weight_weekly ?? [])
    .map((w) => ({ label: shortDate(w.week_start), value: num(w.avg_weight_kg) }))
    .filter((p) => p.value !== null);
  const waistRows = summary?.body?.waist_weekly_8w ?? summary?.body?.waist_weeks ?? [];
  const waist = waistRows
    .map((w) => ({ label: shortDate(w.week_start ?? w.date), value: num(w.waist_cm) }))
    .filter((p) => p.value !== null);
  const latest = num(summary?.body?.latest_waist?.waist_cm ?? summary?.body?.latest_waist_cm);
  if (!weight.length && !waist.length && latest == null) return null;

  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'grow' },
        h('h3', {}, '身体趋势'),
        h('div', { class: 'sub' }, '体重按周均；腰围取最近记录'),
      ),
      latest != null ? h('span', { class: 'chip' }, `腰围 ${fmtNum(latest)} cm`) : null,
    ),
    weight.length ? h('div', { class: 'hint' }, '体重（kg）') : null,
    weight.length ? h('div', { html: lineChart(weight, { height: 110, unit: ' kg', yPad: 0.5 }) }) : null,
    waist.length ? h('div', { class: 'hint', style: 'margin-top:8px' }, '腰围（cm）') : null,
    waist.length ? h('div', { html: lineChart(waist, { height: 110, unit: ' cm', yPad: 0.5 }) }) : null,
  );
}

/** @param {string} iso */
function shortDate(iso) {
  if (!iso) return '';
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
}

function lastValueText(last) {
  if (!last) return '—';
  if (last.hold_s != null && Number(last.hold_s) > 0) return `${fmtNum(last.hold_s)} 秒`;
  const weight = Number(last.weight_kg);
  const reps = last.reps != null ? fmtNum(last.reps) : '—';
  if (!Number.isFinite(weight) || weight === 0) return `自重 ×${reps}`;
  return `${fmtNum(weight)}×${reps}`;
}
function repLabel(ex) {
  const core = ex.hold_s != null
    ? `${ex.sets}×${ex.hold_s} 秒`
    : ex.rep_min === ex.rep_max ? `${ex.sets}×${ex.rep_min}` : `${ex.sets}×${ex.rep_min}–${ex.rep_max}`;
  return ex.per_side ? `${core}/侧` : core;
}

function weightLabel(ex) {
  if (ex.load === 'bodyweight' || ex.weight_kg == null || ex.weight_kg === 0) return '自重';
  const value = fmtNum(ex.weight_kg);
  if (ex.weight_note) return `${value} kg（${ex.weight_note}）`;
  return ex.load === 'pair' ? `${value} kg 每手` : `${value} kg 单只`;
}
