// @ts-check
/** 动作库：本计划动作 + 动作检索 + 中文分步说明 + 训练历史。 */
import { h, clear, banner, lineChart } from '../js/ui.js';
import { fmtNum, fmtDate, num } from '../js/data.js';
import { loadExercises, matchPlan, searchExercises, zhSteps } from '../js/dataset.js';

let query = '';
/** @type {any} */
let selected = null; // { item, ex? }

/** @param {any} ctx */
export function renderLibrary(ctx) {
  const wrap = h('div', { class: 'grid-2' });
  const left = h('div', { class: 'stack' });
  const right = h('div', { class: 'detail-panel' });
  wrap.append(left, right);

  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: '搜动作：深蹲 / 划船 / squat / 核心…',
    value: query,
  });

  const listBox = h('div');
  const planBox = h('div');

  left.append(h('section', { class: 'card tight' },
    h('div', { class: 'card-title' }, '动作库'),
    search,
    h('div', { class: 'hint' }, '按中文名、英文名、肌群、器械或分类（胸/背/腿/肩/手臂/核心/有氧/拉伸）搜索。'),
  ));
  left.append(planBox, listBox);
  right.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, '选一个动作看说明')));

  search.addEventListener('input', () => {
    query = search.value;
    renderList();
  });

  /** @type {any[]} */
  let dataset = [];
  /** @type {Map<string, any>} */
  let planMap = new Map();
  /** @type {any[]} */
  let planEntries = [];

  const entryFor = (ex) => planMap.get(ex.key) ?? null;

  function select(item, ex) {
    selected = { item, ex };
    renderDetail();
    renderList();
  }

  function renderList() {
    clear(planBox);
    if (planEntries.length) {
      const rows = planEntries.map((ex) => {
        const item = entryFor(ex);
        const on = selected?.ex?.key === ex.key;
        return h('div', {
          class: `lib-item${on ? ' on' : ''}`,
          onClick: () => select(item, ex),
        },
          h('div', { class: 'n' }, ex.name),
          h('div', { class: 't' }, [ex.weight_kg ? `${fmtNum(ex.weight_kg)} kg` : '自重',
            ex.rep_min != null ? `${ex.sets}×${ex.rep_min}–${ex.rep_max}` : '',
            item ? '有动作说明' : '无动作说明'].filter(Boolean).join(' · ')),
        );
      });
      planBox.append(h('section', { class: 'card tight' },
        h('div', { class: 'card-title' }, '本计划的动作'),
        h('div', { class: 'lib-grid' }, rows),
      ));
    }

    clear(listBox);
    if (!dataset.length) return;
    const results = searchExercises(dataset, query, 60);
    listBox.append(h('section', { class: 'card tight' },
      h('div', { class: 'card-title' }, query ? `搜索结果 ${results.length}` : `全部动作（${dataset.length}）`),
      results.length
        ? h('div', { class: 'lib-grid' }, results.map((item) => {
            const on = selected?.item?.id === item.id && !selected?.ex;
            return h('div', {
              class: `lib-item${on ? ' on' : ''}`,
              onClick: () => select(item, null),
            },
              h('div', { class: 'n' }, item.zh ?? item.name),
              h('div', { class: 't' }, `${item.name} · ${item.equipment}`),
            );
          }))
        : h('div', { class: 'empty' }, '没有匹配的动作，换个关键词'),
    ));
  }

  function renderDetail() {
    clear(right);
    if (!selected) return;
    const { item, ex } = selected;

    if (!item) {
      right.append(h('section', { class: 'card' },
        h('h3', { style: 'margin-bottom:6px' }, ex.name),
        h('div', { class: 'chip-row', style: 'margin-top:8px' },
          h('span', { class: 'chip' }, `${ex.sets} 组`),
          ex.rep_min != null ? h('span', { class: 'chip' }, `${ex.rep_min}–${ex.rep_max} 次`) : null,
          h('span', { class: 'chip' }, ex.weight_kg ? `${fmtNum(ex.weight_kg)} kg ${ex.load === 'pair' ? '每手' : '单只'}` : '自重'),
          ex.rpe_cap != null ? h('span', { class: 'chip' }, `RPE ≤ ${ex.rpe_cap}`) : null,
        ),
        ex.cue ? h('p', { class: 'hint', style: 'margin-top:12px' }, `动作要点：${ex.cue}`) : null,
        h('p', { class: 'hint', style: 'margin-top:10px' }, '动作库里没有同名条目；可以在 js/dataset.js 的 PLAN_MATCHERS 里补关键词。'),
      ));
      return;
    }

    const steps = zhSteps(item);
    right.append(h('section', { class: 'card' },
      h('div', { class: 'card-title' }, ex ? '本计划动作' : '动作库'),
      h('h2', { style: 'font-size:20px;margin-bottom:2px' }, ex?.name ?? item.zh ?? item.name),
      h('div', { class: 'tip', style: 'margin-bottom:10px' }, item.name),
      h('div', { class: 'chip-row', style: 'margin-top:8px' },
        h('span', { class: 'chip lime' }, item.body_part),
        h('span', { class: 'chip' }, item.equipment),
        h('span', { class: 'chip' }, `目标：${item.target}`),
      ),
      ex ? h('div', { class: 'banner info', style: 'margin-top:14px' },
        h('div', { class: 'grow' }, `计划处方：${ex.sets} 组 × ${ex.rep_min ?? '—'}–${ex.rep_max ?? '—'} 次`,
          ex.weight_kg ? ` · ${fmtNum(ex.weight_kg)} kg ${ex.load === 'pair' ? '每手' : '单只'}` : ' · 自重',
          ex.rpe_cap != null ? ` · RPE ≤ ${ex.rpe_cap}` : '',
          ex.cue ? ` · 要点：${ex.cue}` : ''),
      ) : null,
      steps.length
        ? h('ol', { class: 'steps' }, steps.map((s) => h('li', {}, s)))
        : h('p', { class: 'hint', style: 'margin-top:12px' }, '这个动作还没有中文说明。'),
    ));

    if (ex) {
      const history = trainingHistory(ctx.data, ex);
      if (history) right.append(history);
    }
  }

  (async () => {
    try {
      dataset = await loadExercises();
      planMap = matchPlan(ctx.data.routine, dataset);
      const seen = new Set();
      for (const day of ctx.data.routine?.days ?? []) {
        for (const ex of day.exercises ?? []) {
          if (ex.key && !seen.has(ex.key)) { seen.add(ex.key); planEntries.push(ex); }
        }
      }
      if (!selected && planEntries.length) {
        selected = { item: entryFor(planEntries[0]), ex: planEntries[0] };
      }
      renderList();
      renderDetail();
    } catch (error) {
      clear(listBox);
      listBox.append(banner(`动作库加载失败：${error?.message ?? error}`, 'err'));
    }
  })();

  return wrap;
}

/**
 * 训练历史：从 strength.csv 取同名动作，按日期汇总最好一组和容量。
 * @param {any} data @param {any} ex
 */
function trainingHistory(data, ex) {
  const rows = (data.strength ?? []).filter((r) => r.exercise === ex.name);
  if (!rows.length) return null;

  /** @type {Map<string, any[]>} */
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const days = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, sets]) => {
    let best = null;
    let volume = 0;
    for (const s of sets) {
      const w = num(s.weight_kg) ?? 0;
      const reps = num(s.reps) ?? 0;
      volume += w * reps;
      if (!best || w * reps > best.score) best = { weight: w, reps, score: w * reps };
    }
    return { date, best, volume, count: sets.length };
  });

  const points = days.map((d) => ({ label: d.date.slice(5).replace('-', '/'), value: d.best?.weight ?? 0 }));
  const last = days[days.length - 1];
  const prev = days[days.length - 2];
  const delta = prev && last ? (last.best.weight - prev.best.weight) : 0;

  return h('section', { class: 'card', style: 'margin-top:14px' },
    h('div', { class: 'card-head' },
      h('div', { class: 'grow' },
        h('h3', {}, '训练历史'),
        h('div', { class: 'sub' }, `${days.length} 次记录 · 最近 ${fmtDate(last.date)}`),
      ),
      delta > 0 ? h('span', { class: 'chip lime' }, `+${fmtNum(delta)} kg`) : null,
    ),
    h('div', { html: lineChart(points, { unit: ' kg', height: 130 }) }),
    h('table', { class: 'table', style: 'margin-top:10px' },
      h('thead', {}, h('tr', {},
        h('th', {}, '日期'), h('th', { class: 'num' }, '最好一组'), h('th', { class: 'num' }, '组数'), h('th', { class: 'num' }, '容量'))),
      h('tbody', {}, days.slice().reverse().slice(0, 8).map((d) => h('tr', {},
        h('td', {}, d.date),
        h('td', { class: 'num' }, d.best ? `${fmtNum(d.best.weight)} × ${fmtNum(d.best.reps)}` : '—'),
        h('td', { class: 'num' }, d.count),
        h('td', { class: 'num' }, fmtNum(Math.round(d.volume))),
      ))),
    ),
  );
}
