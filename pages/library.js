// @ts-check
/** 动作库：本计划动作 + 精选 30 条 + 按需加载的完整动作库（1324 条）。 */
import { h, clear, banner, lineChart } from '../js/ui.js';
import { fmtNum, fmtDate, num } from '../js/data.js';
import { personalRecords } from '../js/analytics.js';
import { loadIllustrationIndex } from '../js/illustrations.js';
import {
  loadExercises, matchPlan, searchExercises, zhSteps,
  loadIndex, loadBodyPart, bodyPartSlug, searchFull,
} from '../js/dataset.js';

let query = '';
/** @type {any} */
let selected = null; // { item, ex? }
let fullMode = sessionStorage.getItem('afc.library.full') === '1';
let mediaTimer = 0;
/** @type {any[]|null} */
let fullIndex = null;
let fullLoading = false;
let fullError = '';

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
  const statusBox = h('div');

  const toggle = h('input', { type: 'checkbox', id: 'full-lib', checked: fullMode });
  const toggleLabel = h('label', { for: 'full-lib', class: 'row', style: 'border:0;padding:10px 0 0;gap:8px;cursor:pointer' },
    toggle,
    h('span', {}, '显示完整动作库（1324 个，打开后才下载索引）'),
  );

  left.append(h('section', { class: 'card tight' },
    h('div', { class: 'card-title' }, '动作库'),
    search,
    h('div', { class: 'hint' }, '按中文名、英文名、肌群、器械或分类（胸/背/腿/肩/手臂/核心/有氧/拉伸）搜索。'),
    toggleLabel,
    statusBox,
  ));
  left.append(planBox, listBox);
  right.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, '选一个动作看说明')));

  search.addEventListener('input', () => {
    query = search.value;
    renderList();
  });

  toggle.addEventListener('change', async () => {
    fullMode = toggle.checked;
    sessionStorage.setItem('afc.library.full', fullMode ? '1' : '0');
    if (fullMode) await ensureIndex();
    renderList();
  });

  /** @type {any[]} */
  let dataset = [];
  /** @type {Map<string, any>} */
  let planMap = new Map();
  /** @type {any[]} */
  let planEntries = [];

  const entryFor = (ex) => planMap.get(ex.key) ?? null;

  async function ensureIndex() {
    if (fullIndex || fullLoading) return;
    fullLoading = true;
    fullError = '';
    renderStatus();
    try {
      fullIndex = await loadIndex();
    } catch (error) {
      fullError = navigator.onLine === false
        ? '完整动作库需要联网，离线时不可用（课表的 13 个动作插图和说明仍可查看）'
        : error?.message ?? String(error);
      fullMode = false;
      toggle.checked = false;
      sessionStorage.setItem('afc.library.full', '0');
    } finally {
      fullLoading = false;
      renderStatus();
    }
  }

  function renderStatus() {
    clear(statusBox);
    if (fullLoading) statusBox.append(h('div', { class: 'hint' }, '正在下载动作索引…'));
    else if (fullError) statusBox.append(banner(fullError, 'err'));
    else if (fullIndex) statusBox.append(h('div', { class: 'hint' }, `完整库已加载：${fullIndex.length} 个动作`));
  }

  function isSelectedFull(entry) {
    return Boolean(entry?.zh_auto) || Boolean(entry?.steps);
  }

  async function select(entry, ex) {
    if (!entry) { selected = { item: null, ex }; renderDetail(); renderList(); return; }
    // 索引里的条目没有 steps，按需下载部位文件；精选/手写条目和课表动作直接展示
    if (Array.isArray(entry.steps) || ex) {
      selected = { item: entry, ex };
      renderDetail();
      renderList();
      return;
    }
    // 索引里的条目还没有 steps，按需下载部位文件
    selected = { item: entry, ex: null, loading: true };
    renderDetail();
    renderList();
    try {
      const slug = bodyPartSlug(entry.body_part);
      const list = await loadBodyPart(slug);
      const full = list.find((x) => x.id === entry.id) ?? entry;
      selected = { item: full, ex: null };
    } catch (error) {
      selected = { item: entry, ex: null, error: error?.message ?? String(error) };
    }
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

    const curated = searchExercises(dataset, query, 60);
    /** @type {any[]} */
    let results = curated.map((item) => ({ ...item, curated: true }));
    if (fullMode && fullIndex) {
      const seen = new Set(results.map((item) => item.name.toLowerCase()));
      for (const item of searchFull(fullIndex, query, 80)) {
        const key = String(item.name).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(item);
      }
      results = results.slice(0, 100);
    }

    listBox.append(h('section', { class: 'card tight' },
      h('div', { class: 'card-title' },
        query ? `搜索结果 ${results.length}` : (fullMode ? `精选 + 完整库（前 ${results.length}）` : `全部动作（${dataset.length}）`)),
      results.length
        ? h('div', { class: 'lib-grid' }, results.map((item) => {
            const on = selected?.item?.id === item.id && !selected?.ex;
            return h('div', {
              class: `lib-item${on ? ' on' : ''}`,
              onClick: () => select(item, null),
            },
              h('div', { class: 'n' }, item.zh ?? item.name),
              h('div', { class: 't en' }, `${item.name} · ${item.equipment}`),
              // 精选条目不算机翻；完整库里 zh_auto 缺省为 true，手写条目是 false
              !item.curated && item.zh_auto !== false
                ? h('span', { class: 'tag', style: 'margin-top:6px' }, '机翻')
                : null,
            );
          }))
        : h('div', { class: 'empty' }, '没有匹配的动作，换个关键词'),
    ));
  }

  function renderDetail() {
    clearInterval(mediaTimer);
    clear(right);
    if (!selected) return;
    const { item, ex, loading, error } = selected;

    if (loading) {
      right.append(h('section', { class: 'card' }, h('div', { class: 'empty' }, '正在下载这个动作的说明…')));
      return;
    }
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

    const steps = Array.isArray(item.steps) ? item.steps : zhSteps(item);
    right.append(h('section', { class: 'card' },
      h('div', { class: 'card-title' }, ex ? '本计划动作' : '动作库'),
      h('h2', { style: 'font-size:20px;margin-bottom:2px' }, ex?.name ?? item.zh ?? item.name),
      h('div', { class: 'tip', style: 'margin-bottom:10px' },
        item.name,
        item.zh_auto ? h('span', { class: 'tag', style: 'margin-left:8px' }, '机翻') : null),
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
      h('p', { class: 'hint', style: 'margin-top:14px' },
        '说明文字来自 hasaneyldrm/exercises-dataset（MIT）；不含 Gym visual 的图片/GIF。'),
    ));

    if (ex) {
      const history = trainingHistory(ctx.data, ex);
      if (history) right.append(history);
      const records = recordsCard(ctx.data, ex);
      if (records) right.append(records);
      right.append(illustrationCard(ex));
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
      if (fullMode) await ensureIndex();
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
    h('div', { html: lineChart(points, { unit: ' kg', height: 130, yPad: 0.5 }) }),
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

/**
 * 动作的个人纪录（负重四项；自重/助力只统计最多次数）。
 * @param {any} data @param {any} ex
 */
function recordsCard(data, ex) {
  const records = personalRecords(data.strength ?? [])[ex.name];
  if (!records || !Object.keys(records).length) return null;
  /** @type {[string, any, string][]} */
  const rows = [];
  if (records.maxWeight) rows.push(['最大重量', records.maxWeight, `${fmtNum(records.maxWeight.value)} kg`]);
  if (records.best1RM) rows.push(['最佳估算 1RM（估算）', records.best1RM, `${fmtNum(records.best1RM.value)} kg`]);
  if (records.maxSetVolume) rows.push(['单组最大容量', records.maxSetVolume, `${fmtNum(records.maxSetVolume.value)} kg`]);
  if (records.maxSessionVolume) rows.push(['单次训练最大容量', records.maxSessionVolume, `${fmtNum(records.maxSessionVolume.value)} kg`]);
  if (records.maxReps) rows.push(['最多次数', records.maxReps, `${fmtNum(records.maxReps.value)} 次`]);

  return h('section', { class: 'card', style: 'margin-top:14px' },
    h('div', { class: 'card-title' }, '个人纪录'),
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, '项目'), h('th', { class: 'num' }, '纪录'), h('th', {}, '日期'))),
      h('tbody', {}, rows.map(([label, entry, value]) => h('tr', {},
        h('td', {}, label),
        h('td', { class: 'num' }, value),
        h('td', { class: 'muted' }, entry.date ?? '—'),
      ))),
    ),
  );
}

/**
 * 动作插图（CC BY-SA 4.0）：静态帧 + 播放按钮；减少动效时不自动播放。
 * @param {any} ex
 */
function illustrationCard(ex) {
  const box = h('div');
  (async () => {
    const index = await loadIllustrationIndex();
    const entry = index?.[ex.key];
    if (!entry || !Array.isArray(entry.frames) || !entry.frames.length) return;
    const frames = entry.frames.map((p) => `./${p}`);
    const img = h('img', {
      class: 'illustration-img',
      src: frames[0],
      alt: `${ex.name} 动作示意`,
      width: 160,
      height: 160,
      loading: 'lazy',
    });
    const playBtn = h('button', { class: 'btn small' }, '播放');
    let playing = false;

    const stop = () => {
      playing = false;
      clearInterval(mediaTimer);
      playBtn.textContent = '播放';
    };
    const start = () => {
      if (frames.length < 2 || playing) return;
      playing = true;
      playBtn.textContent = '暂停';
      let frame = 0;
      mediaTimer = setInterval(() => {
        frame = (frame + 1) % frames.length;
        img.src = frames[frame];
      }, 700);
    };
    playBtn.addEventListener('click', () => (playing ? stop() : start()));

    box.append(h('section', { class: 'card', style: 'margin-top:14px' },
      h('div', { class: 'card-title' }, '动作示意'),
      h('div', { class: 'illustration' },
        img,
        h('div', { class: 'grow' },
          h('div', { class: 'hint' },
            entry.approx ? '近似动作示意：课表动作在上游没有完全一致的插图。' : '动作示意（3 帧轮换）。'),
          h('div', { class: 'field-row', style: 'margin:10px 0 0;max-width:180px' }, playBtn),
          h('div', { class: 'hint', style: 'margin-top:10px' },
            '插图：Bryl Lim / Everkinetic，CC BY-SA 4.0 ',
            h('a', { href: 'https://creativecommons.org/licenses/by-sa/4.0/', target: '_blank', rel: 'noopener' }, '许可证'),
            ' · ',
            h('a', { href: 'https://github.com/bryllim/workout-guide', target: '_blank', rel: 'noopener' }, '上游仓库'),
          ),
        ),
      ),
    ));

    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && frames.length > 1) {
      start();
      setTimeout(stop, frames.length * 700);
    }
  })();
  return box;
}
