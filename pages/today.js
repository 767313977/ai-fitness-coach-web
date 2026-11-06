// @ts-check
/** 今天：今日课表 + 本周还差什么 + 快捷记录 + 数据状态。 */
import { h, icon, banner } from '../js/ui.js';
import { dayFor, cycleLabel, weekGaps, exerciseHistory, fmtDate, fmtNum, todayISO } from '../js/data.js';

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

  if (plan?.type === 'strength') left.append(strengthCard(plan, summary));
  else if (plan?.type === 'cardio') left.append(cardioCard(plan, navigate));
  else left.append(restCard(plan));

  right.append(gaps(summary, data.config));
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

function gaps(summary, config) {
  const items = weekGaps(summary, config);
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
    ));
  }
  if (summary?.generated_at) {
    card.append(h('div', { class: 'hint' }, `summary 更新于 ${new Date(summary.generated_at).toLocaleString('zh-CN', { hour12: false })}`));
  }
  return card;
}

function strengthCard(plan, summary) {
  const history = summary?.exercise_history ?? {};
  const table = h('table', { class: 'table' },
    h('thead', {}, h('tr', {},
      h('th', { style: 'width:34px' }, '#'),
      h('th', {}, '动作'),
      h('th', {}, '处方'),
      h('th', {}, '上次'),
      h('th', {}, '建议'),
    )),
    h('tbody', {}, (plan.exercises ?? []).map((ex, index) => {
      const last = exerciseHistory(history, ex.key);
      return h('tr', {},
        h('td', { class: 'muted' }, index + 1),
        h('td', {}, h('div', { class: 'name' }, ex.name), ex.cue ? h('div', { class: 'sub' }, ex.cue) : null),
        h('td', { class: 'muted' }, repLabel(ex), h('br'), weightLabel(ex)),
        h('td', { class: 'muted' }, last ? `${last.date ? fmtDate(last.date) : ''} ${fmtNum(last.weight_kg)}×${fmtNum(last.reps)}` : '—'),
        h('td', {}, last?.next_hint ? h('span', { class: 'chip lime' }, last.next_hint) : h('span', { class: 'muted' }, '—')),
      );
    })),
  );

  return h('section', { class: 'card pad-0' },
    h('div', { style: 'padding:18px 18px 8px' },
      h('div', { class: 'card-head', style: 'margin-bottom:5px' },
        h('div', { class: 'grow' },
          h('h3', {}, plan.title),
          h('div', { class: 'sub' }, plan.hevy_routine_id ? `Hevy 模板：${plan.hevy_routine_id}` : ''),
        ),
        plan.warmup ? h('span', { class: 'chip' }, `热身 ${plan.warmup_min ?? 8} 分钟`) : null,
      ),
      plan.warmup ? h('div', { class: 'hint', style: 'margin-bottom:6px' }, plan.warmup) : null,
    ),
    h('div', { style: 'padding:0 18px 14px' }, table),
  );
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
  return h('section', { class: 'card tight' },
    h('div', { class: 'card-title' }, '数据状态'),
    h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, last ? `上次力量记录 ${fmtDate(last)}` : '还没有力量记录'),
        h('div', { class: 'sub' }, days != null && days >= 7 ? `已经 ${days} 天没导入了，去「记录 → 导入 Hevy」` : '数据是最新的'),
      ),
      h('span', { class: `chip ${days != null && days >= 7 ? 'red' : ''}` }, days == null ? '待导入' : `${days} 天前`),
    ),
    h('button', { class: 'btn ghost small', style: 'margin-top:8px', onClick: () => navigate('/week') }, '看本周汇总'),
  );
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
