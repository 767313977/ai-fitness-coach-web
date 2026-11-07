// @ts-check
/** 记录：打卡 / 饮食 / 有氧 / 身体指标 / 导入 Hevy / 生成周复盘 / 采纳提案。
 *
 * 所有提交都进全局串行队列（js/queue.js）：一次只发一个，避免 GitHub 并发组把排队任务顶掉。
 */
import { h, banner, clear, toast, icon } from '../js/ui.js';
import { todayISO, hevyMode, hevySyncStatus, fmtDateTime, HEVY_SYNC_STALE_HOURS } from '../js/data.js';
import { describeRun } from '../js/submit.js';
import { enqueue, enqueueHevyImport, resumeTaskById } from '../js/queue.js';
import { dateRule, intRule, numberRule, requireAny, validateValues } from '../js/validate.js';

/** @param {any} ctx @param {string[]} rest */
export function renderRecord(ctx, rest = []) {
  const sub = rest[0];
  switch (sub) {
    case 'checkin': return checkinPage(ctx);
    case 'diet': return dietPage(ctx);
    case 'cardio': return cardioPage(ctx);
    case 'body': return bodyPage(ctx);
    case 'import': return importPage(ctx);
    case 'weekly': return weeklyPage(ctx);
    case 'proposal': return proposalPage(ctx);
    default: return hub(ctx);
  }
}

const ITEMS = [
  { key: 'checkin', title: '打卡', desc: '膝痛 / 精力 / 睡眠感受', icon: 'check' },
  { key: 'diet', title: '饮食', desc: '热量 / 蛋白 / 碳水 / 脂肪 / 体重', icon: 'review' },
  { key: 'cardio', title: '有氧', desc: '快走 / 骑车，可分段', icon: 'today' },
  { key: 'body', title: '身体指标', desc: '腰围 / 体脂 / 骨骼肌', icon: 'week' },
  { key: 'import', title: '导入 Hevy', desc: '上传导出的 workouts.csv', icon: 'upload' },
  { key: 'weekly', title: '生成周复盘', desc: 'AI 写 5.1–5.4 + 下周提案', icon: 'refresh' },
  { key: 'proposal', title: 'AI 提案', desc: '看下周课表提案，采纳或不采纳', icon: 'link' },
];

function hub(ctx) {
  const wrap = h('div');
  if (ctx.state.demo) wrap.append(banner('演示模式：提交按钮不会真的写入仓库。', 'info'));
  wrap.append(banner('别同时在手机 App 和网页上提交：两边各自排队，GitHub 的并发组只保留 1 个运行 + 1 个排队，撞车时会被取消。', 'info'));
  const grid = h('div', { class: 'grid-3' });
  for (const item of ITEMS) {
    grid.append(h('div', {
      class: 'card tight',
      style: 'cursor:pointer',
      onClick: () => ctx.navigate(`/record/${item.key}`),
    },
      h('div', { class: 'row', style: 'border:0;padding:0;align-items:flex-start' },
        h('div', { class: 'idx' }, icon(item.icon, 15)),
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, item.title),
          h('div', { class: 'sub' }, item.key === 'import' && hevyMode(ctx.data?.config) === 'api'
            ? '云端每天 22:43 自动同步'
            : item.desc),
        ),
      ),
    ));
  }
  wrap.append(grid);
  return wrap;
}

// ---------------- 表单框架 ----------------

/**
 * @param {any} ctx
 * @param {{title: string, workflow: string, kind?: string, fields: any[], hint?: string,
 *          submitLabel?: string, presets?: {label: string, values: Record<string, number>}[],
 *          validate?: (v: Record<string,string>) => string|null}} def
 */
function formPage(ctx, def) {
  const wrap = h('div');
  wrap.append(back(ctx, '/record', '记录'));
  wrap.append(h('h2', { style: 'margin:6px 0 12px' }, def.title));

  /** @type {Record<string, HTMLInputElement|HTMLSelectElement>} */
  const inputs = {};
  const form = h('form', { class: 'card' });

  for (const field of def.fields) {
    const required = !field.optional;
    let el;
    if (field.type === 'select') {
      el = h('select', { class: 'input', required },
        (field.options ?? []).map((o) => h('option', { value: o.value }, o.label)));
      el.value = field.value ?? field.options?.[0]?.value ?? '';
    } else {
      el = h('input', {
        class: 'input',
        type: field.type ?? 'text',
        placeholder: field.placeholder ?? '',
        value: field.value ?? '',
        max: field.max ?? null,
        min: field.min ?? null,
        step: field.step ?? (field.type === 'number' ? (field.integer ? '1' : 'any') : null),
        required,
        inputmode: field.numeric ? (field.integer ? 'numeric' : 'decimal') : null,
      });
    }
    inputs[field.name] = el;
    form.append(h('div', { class: 'field' },
      h('label', {}, field.label, field.optional ? h('span', { style: 'color:var(--text-3)' }, '（可选）') : null),
      el,
      field.hint ? h('div', { class: 'hint' }, field.hint) : null,
    ));
  }

  if (Array.isArray(def.presets) && def.presets.length) {
    form.append(
      h('div', { class: 'card-title', style: 'margin-top:2px;margin-bottom:8px' }, '快速模板（点一下累加）'),
      h('div', { class: 'chip-row', style: 'margin-top:0;margin-bottom:14px' },
        def.presets.map((preset) => h('button', {
          type: 'button',
          class: 'chip',
          onClick: () => applyPreset(inputs, preset),
        }, preset.label))),
    );
  }

  const status = h('div', { class: 'hint', style: 'min-height:20px' });
  const note = h('div', { class: 'hint' });
  const after = h('div', { class: 'field-row', style: 'margin:8px 0 12px;flex-wrap:wrap' });
  // 用户重新输入时清掉上一次的错误提示
  for (const el of Object.values(inputs)) {
    el.addEventListener('input', () => { status.textContent = ''; });
    el.addEventListener('change', () => { status.textContent = ''; });
  }
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, def.submitLabel ?? '提交');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const values = {};
    for (const [name, el] of Object.entries(inputs)) {
      const value = String(el.value ?? '').trim();
      if (value) values[name] = value;
    }
    const missing = def.fields.filter((f) => !f.optional && !values[f.name]);
    if (missing.length) {
      status.textContent = `还缺：${missing.map((f) => f.label).join('、')}`;
      return;
    }
    // 浏览器约束校验（min/max/step/required）与统一数值校验一起执行
    if (typeof form.checkValidity === 'function' && !form.checkValidity()) {
      if (typeof form.reportValidity === 'function') form.reportValidity();
      status.textContent = '有字段不符合要求，按输入框提示修改';
      return;
    }
    const problem = validateValues(def.fields, values)
      || (typeof def.validate === 'function' ? def.validate(values) : null);
    if (problem) { status.textContent = problem; return; }

    if (ctx.state.demo) { toast('演示模式不会提交'); return; }

    submit.disabled = true;
    status.textContent = '提交中…';
    clear(after);
    try {
      const queued = enqueue(ctx.api, {
        workflow: def.workflow,
        inputs: values,
        kind: def.kind ?? 'workflow',
        onStatus: (s) => { status.textContent = s; },
      });
      if (queued.position > 0) status.textContent = `排队中（前面还有 ${queued.position} 条）`;
      note.textContent = '已派发 Actions，预计 30–60 秒生效；完成后会自动刷新。';
      const result = await queued.promise;
      showResult({
        result, status, note, after, ctx,
        taskId: queued.task.id,
        onStatus: (s) => { status.textContent = s; },
      });
    } catch (error) {
      status.textContent = `失败：${error?.message ?? error}`;
      note.textContent = '';
    } finally {
      submit.disabled = false;
    }
  });

  form.append(status, note, after, submit);
  wrap.append(form);
  if (def.hint) wrap.append(h('div', { class: 'hint' }, def.hint));
  return wrap;
}

/**
 * 统一渲染运行结果：成功/失败/取消为终态；超时/未知保留任务并给「继续检查」。
 * @param {{result: any, status: HTMLElement, note: HTMLElement, after: HTMLElement,
 *          ctx: any, taskId: string, onStatus: (s: string) => void}} args
 */
function showResult({ result, status, note, after, ctx, taskId, onStatus }) {
  status.textContent = `结果：${describeRun(result)}`;
  clear(after);

  if (result.run?.html_url) {
    after.append(h('a', {
      class: 'btn small ghost',
      href: result.run.html_url,
      target: '_blank',
      rel: 'noopener noreferrer',
    }, '查看运行'));
  }

  if (result.state === 'success') {
    note.textContent = 'Actions 已完成；如果页面数字还没变，点「刷新数据」。';
    toast('已写入仓库，正在刷新');
    after.append(h('button', { class: 'btn small ghost', onClick: () => ctx.refresh() }, '刷新数据'));
    setTimeout(() => ctx.refresh(), 600);
    return;
  }
  if (result.state === 'failure' || result.state === 'cancelled') {
    note.textContent = result.state === 'cancelled'
      ? '工作流被取消，没有写入；可以重新提交。'
      : '去 Actions 看日志；工作流有 request_id 幂等闸，重试不会重复写入。';
    return;
  }
  note.textContent = result.needsFile
    ? '需要重新选择 CSV 文件后再导入；已上传的记录不会重复写入。'
    : '任务已保留，刷新或断网都不会丢；稍后点「继续检查」。';
  after.append(h('button', {
    class: 'btn small',
    onClick: async () => {
      try {
        const resumed = await resumeTaskById(ctx.api, taskId, { onStatus });
        showResult({ result: resumed, status, note, after, ctx, taskId, onStatus });
      } catch (error) {
        status.textContent = `检查失败：${error?.message ?? error}`;
      }
    },
  }, '继续检查'));
}

/**
 * 饮食快速模板：把常见餐次的热量/蛋白累加到当前输入框。
 * @param {Record<string, HTMLInputElement|HTMLSelectElement>} inputs
 * @param {{label: string, values: Record<string, number>}} preset
 */
function applyPreset(inputs, preset) {
  for (const [name, amount] of Object.entries(preset.values)) {
    const el = inputs[name];
    if (!el) continue;
    const current = Number(el.value) || 0;
    el.value = String(Math.round((current + amount) * 10) / 10);
  }
  toast(`已累加：${preset.label}`);
}

function back(ctx, path, label) {
  return h('button', { class: 'btn ghost small', onClick: () => ctx.navigate(path) }, `← ${label}`);
}

function dateField() {
  return {
    name: 'date', label: '日期', type: 'date', value: todayISO(), max: todayISO(),
    rule: dateRule(),
  };
}

// ---------------- 各表单 ----------------

function checkinPage(ctx) {
  return formPage(ctx, {
    title: '打卡',
    workflow: 'checkin.yml',
    submitLabel: '提交打卡',
    hint: '提交后会由 GitHub Actions 写 data/checkin.csv，并刷新 summary.json。',
    validate: (v) => {
      const knee = Number(v.knee_pain);
      if (v.knee_pain && (!Number.isInteger(knee) || knee < 0 || knee > 10)) return '膝痛是 0–10 的整数';
      for (const [key, label] of [['energy', '精力'], ['sleep_feel', '睡眠感受']]) {
        if (!v[key]) continue;
        const n = Number(v[key]);
        if (!Number.isInteger(n) || n < 1 || n > 5) return `${label}是 1–5 的整数`;
      }
      return null;
    },
    fields: [
      dateField(),
      { name: 'knee_pain', label: '膝痛（0–10）', type: 'number', numeric: true, integer: true, min: 0, max: 10, rule: intRule(0, 10), placeholder: '2', hint: '平时 1–2 分；4 分以上当天停下肢动作。' },
      { name: 'energy', label: '精力（1–5）', type: 'number', numeric: true, integer: true, min: 1, max: 5, rule: intRule(1, 5), placeholder: '4' },
      { name: 'sleep_feel', label: '睡眠感受（1–5）', type: 'number', numeric: true, integer: true, min: 1, max: 5, rule: intRule(1, 5), placeholder: '4' },
      { name: 'note', label: '备注', optional: true },
    ],
  });
}

function dietPage(ctx) {
  return formPage(ctx, {
    title: '记饮食',
    workflow: 'diet.yml',
    submitLabel: '提交饮食',
    hint: '只抄薄荷「每日饮食汇总页」上的 5 个数，截图数字按 ±10% 误差看趋势。模板只是把常见餐次累加到当天总数，仍按原流程提交。',
    presets: [
      { label: '早餐 +500 kcal / 25 g', values: { kcal: 500, protein: 25 } },
      { label: '午餐 +750 kcal / 40 g', values: { kcal: 750, protein: 40 } },
      { label: '晚餐 +700 kcal / 35 g', values: { kcal: 700, protein: 35 } },
      { label: '加餐 +200 kcal / 10 g', values: { kcal: 200, protein: 10 } },
    ],
    fields: [
      dateField(),
      { name: 'kcal', label: '全天热量 kcal', type: 'number', numeric: true, rule: numberRule({ min: 0, exclusiveMin: true, max: 8000 }), placeholder: '2100' },
      { name: 'protein', label: '蛋白 g', type: 'number', numeric: true, rule: numberRule({ min: 0, max: 500 }), placeholder: '120' },
      { name: 'carbs', label: '碳水 g', optional: true, type: 'number', numeric: true, rule: numberRule({ min: 0, max: 1200 }) },
      { name: 'fat', label: '脂肪 g', optional: true, type: 'number', numeric: true, rule: numberRule({ min: 0, max: 500 }) },
      { name: 'weight', label: '晨起体重 kg', optional: true, type: 'number', numeric: true, rule: numberRule({ min: 25, max: 300 }), placeholder: '70.0' },
      { name: 'note', label: '备注', optional: true },
    ],
  });
}

function cardioPage(ctx) {
  return formPage(ctx, {
    title: '记有氧',
    workflow: 'cardio.yml',
    submitLabel: '提交有氧',
    hint: '分段写法：30,30。单次不超过 30 分钟。',
    validate: (v) => {
      if (!v.segments && !v.minutes) return '分段分钟和单段分钟至少填一个';
      if (v.segments) {
        for (const piece of String(v.segments).split(',')) {
          const n = Number(piece.trim());
          if (!Number.isInteger(n) || n < 1 || n > 30) return '分段要写成 1–30 的整数，例如 30,30';
        }
      } else {
        const n = Number(v.minutes);
        if (!Number.isInteger(n) || n < 1 || n > 30) return '单段分钟是 1–30 的整数';
      }
      return null;
    },
    fields: [
      dateField(),
      { name: 'segments', label: '分段分钟', optional: true, placeholder: '例：30,30', hint: '每段 1–30 的整数，逗号分隔' },
      { name: 'minutes', label: '或单段分钟数', optional: true, type: 'number', numeric: true, integer: true, min: 1, max: 30, rule: intRule(1, 30), placeholder: '例：30' },
      { name: 'type', label: '方式', type: 'select', options: [
        { value: '快走', label: '快走' }, { value: '骑车', label: '骑车' }, { value: '其他', label: '其他' },
      ] },
      { name: 'distance_km', label: '距离 km', optional: true, type: 'number', numeric: true, rule: numberRule({ min: 0 }) },
      { name: 'note', label: '备注', optional: true },
    ],
  });
}

function bodyPage(ctx) {
  return formPage(ctx, {
    title: '身体指标',
    workflow: 'body.yml',
    submitLabel: '提交身体指标',
    hint: '同一天同一来源后一次覆盖前一次；体重请记在饮食里。',
    validate: (v) => requireAny(v, ['waist_cm', 'body_fat_pct', 'skeletal_muscle_kg'], '至少填一项身体指标'),
    fields: [
      dateField(),
      { name: 'waist_cm', label: '腰围 cm', optional: true, type: 'number', numeric: true, rule: numberRule({ min: 50, max: 150 }) },
      { name: 'body_fat_pct', label: '体脂率 %', optional: true, type: 'number', numeric: true, rule: numberRule({ min: 3, max: 60 }) },
      { name: 'skeletal_muscle_kg', label: '骨骼肌 kg', optional: true, type: 'number', numeric: true, rule: numberRule({ min: 10, max: 80 }) },
      { name: 'source', label: '来源', optional: true, type: 'select', options: [
        { value: '', label: '按内容自动判断' }, { value: 'tape', label: 'tape（自己量）' }, { value: 'bca', label: 'bca（体成分仪）' },
      ] },
      { name: 'note', label: '备注', optional: true },
    ],
  });
}

function importPage(ctx) {
  const wrap = h('div');
  wrap.append(back(ctx, '/record', '记录'));
  wrap.append(h('h2', { style: 'margin:6px 0 12px' }, '导入 Hevy'));
  wrap.append(hevyMode(ctx.data?.config) === 'api' ? apiSyncCard(ctx) : csvImportCard(ctx));
  return wrap;
}

/** CSV 模式：上传 Hevy 导出的文件，派发导入工作流 */
function csvImportCard(ctx) {
  const card = h('div');
  const fileInput = h('input', { class: 'input', type: 'file', accept: '.csv,text/csv' });
  const status = h('div', { class: 'hint', style: 'min-height:20px' });
  const note = h('div', { class: 'hint' });
  const after = h('div', { class: 'field-row', style: 'margin:8px 0;flex-wrap:wrap' });
  const btn = h('button', { class: 'btn primary block' }, '上传并导入');

  btn.addEventListener('click', async () => {
    if (ctx.state.demo) { toast('演示模式不会提交'); return; }
    const file = fileInput.files?.[0];
    if (!file) { status.textContent = '先选一个 Hevy 导出的 CSV，再点上传'; return; }
    btn.disabled = true;
    clear(after);
    try {
      const queued = enqueueHevyImport(ctx.api, file, (s) => { status.textContent = s; });
      if (queued.position > 0) status.textContent = `排队中（前面还有 ${queued.position} 条）`;
      note.textContent = 'CSV 只上传到仓库的 uploads/ 临时目录，导入后由 Actions 删除；文件内容不会进浏览器存储。';
      const result = await queued.promise;
      showResult({
        result, status, note, after, ctx,
        taskId: queued.task.id,
        onStatus: (s) => { status.textContent = s; },
      });
    } catch (error) {
      status.textContent = `失败：${error?.message ?? error}`;
      note.textContent = '上传阶段失败时，请重新选择 CSV 文件再试。';
    } finally {
      btn.disabled = false;
    }
  });

  card.append(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, 'Hevy → 导出 CSV'),
    h('div', { class: 'hint', style: 'margin-bottom:12px' },
      'Hevy → Profile → Settings → Export & Import Data → Export Workouts。上传需要 PAT 有 Contents 读写权限；Actions 导入后会删除临时文件。'),
    fileInput,
    status,
    note,
    after,
    btn,
  ));
  return card;
}

/** API 模式：密钥在 Actions 里，网页只展示同步状态、按需手动补一次 */
function apiSyncCard(ctx) {
  const info = hevySyncStatus(ctx.data?.syncState);
  const state = ctx.data?.syncState ?? {};

  const chip = info.unknown
    ? h('span', { class: 'chip red' }, '还没同步过')
    : h('span', { class: `chip ${info.stale ? 'red' : 'lime'}` }, info.stale ? '同步超时' : '正常');

  const status = h('div', { class: 'hint', style: 'min-height:20px' });
  const note = h('div', { class: 'hint' });
  const after = h('div', { class: 'field-row', style: 'margin:8px 0;flex-wrap:wrap' });
  const btn = h('button', { class: 'btn primary block' }, '立即同步');

  btn.addEventListener('click', async () => {
    if (ctx.state.demo) { toast('演示模式不会提交'); return; }
    btn.disabled = true;
    clear(after);
    try {
      const queued = enqueue(ctx.api, {
        workflow: 'hevy_sync.yml',
        inputs: {},
        kind: 'hevy-sync',
        onStatus: (s) => { status.textContent = s; },
      });
      if (queued.position > 0) status.textContent = `排队中（前面还有 ${queued.position} 条）`;
      note.textContent = '已派发 Actions，预计 30–60 秒生效；完成后会自动刷新。';
      const result = await queued.promise;
      showResult({
        result, status, note, after, ctx,
        taskId: queued.task.id,
        onStatus: (s) => { status.textContent = s; },
      });
    } catch (error) {
      status.textContent = `失败：${error?.message ?? error}`;
      note.textContent = '';
    } finally {
      btn.disabled = false;
    }
  });

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'grow' },
        h('div', { class: 'card-title', style: 'margin:0' }, 'Hevy 云端自动同步'),
        h('div', { class: 'sub' }, '每天 22:43 拉一次，App 和网页共用这份数据'),
      ),
      chip,
    ),
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 'name' }, '上次同步')),
      h('div', { class: 'val' }, info.at ? `${fmtDateTime(info.at)} · ${agoText(info.hours)}` : '无记录'),
    ),
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 'name' }, '已同步训练')),
      h('div', { class: 'val' }, `${Number(state.workouts_seen ?? 0)} 次`),
    ),
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 'name' }, '写入组数')),
      h('div', { class: 'val' }, `${Number(state.rows_written ?? 0)} 组`),
    ),
    info.stale
      ? h('div', { style: 'margin-top:12px' }, banner(
        info.unknown
          ? '还没有同步记录。先去 Actions 手动运行一次「Hevy 自动同步」，或点下面的按钮。'
          : `超过 ${HEVY_SYNC_STALE_HOURS} 小时没同步，去 Actions 看「Hevy 自动同步」是不是失败了。`,
        'warn',
      ))
      : null,
    h('div', { class: 'hint', style: 'margin:12px 0' },
      '同步只替换带 workout_id 的行，手动补录（source=manual）不会被改动；Hevy 的 api-key 只存在 Actions Secret 里，不会进浏览器。'),
    btn,
    status,
    note,
    after,
  );
}

function agoText(hours) {
  if (hours === null || hours === undefined) return '';
  if (hours < 1) return '刚刚';
  if (hours < 24) return `${Math.round(hours)} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function weeklyPage(ctx) {
  const wrap = h('div');
  wrap.append(back(ctx, '/record', '记录'));
  wrap.append(h('h2', { style: 'margin:6px 0 12px' }, '生成周复盘'));
  const status = h('div', { class: 'hint', style: 'min-height:20px' });
  const note = h('div', { class: 'hint' });
  const after = h('div', { class: 'field-row', style: 'margin:8px 0;flex-wrap:wrap' });
  const btn = h('button', { class: 'btn primary block' }, '立即生成（消耗一次 Actions）');

  btn.addEventListener('click', async () => {
    if (ctx.state.demo) { toast('演示模式不会提交'); return; }
    btn.disabled = true;
    status.textContent = '提交中…';
    clear(after);
    try {
      const queued = enqueue(ctx.api, {
        workflow: 'weekly.yml',
        inputs: {},
        kind: 'weekly',
        onStatus: (s) => { status.textContent = s; },
      });
      if (queued.position > 0) status.textContent = `排队中（前面还有 ${queued.position} 条）`;
      note.textContent = '已派发 Actions，预计 30–60 秒生效；完成后会自动刷新。';
      const result = await queued.promise;
      showResult({
        result, status, note, after, ctx,
        taskId: queued.task.id,
        onStatus: (s) => { status.textContent = s; },
      });
    } catch (error) {
      status.textContent = `失败：${error?.message ?? error}`;
      note.textContent = '';
    } finally {
      btn.disabled = false;
    }
  });

  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'hint', style: 'margin-bottom:12px' },
      '会生成 review/week-*.md 的第 1–4 节，并让 AI 写 5.1–5.4 与下周提案。周日 21:17 会自动跑一次。'),
    status,
    note,
    after,
    btn,
  ));
  return wrap;
}

function proposalPage(ctx) {
  const wrap = h('div');
  wrap.append(back(ctx, '/record', '记录'));
  wrap.append(h('h2', { style: 'margin:6px 0 12px' }, 'AI 课表提案'));
  const list = h('div', { class: 'card' }, h('div', { class: 'empty' }, '读取中…'));
  wrap.append(list);

  (async () => {
    try {
      if (ctx.state.demo) {
        clear(list);
        list.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '演示模式没有提案'), h('div', {}, '真实仓库里 AI 会在周复盘时生成 plan/proposals/week-*.json')));
        return;
      }
      const ref = encodeURIComponent(ctx.api.cfg.ref);
      const dir = await ctx.api.actionsGet(`contents/plan/proposals?ref=${ref}`).catch(() => []);
      const files = (dir || []).filter((f) => f.name.endsWith('.json'));
      clear(list);
      if (!files.length) {
        list.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '暂无提案'), h('div', {}, 'AI 会在周复盘时生成下周课表提案。')));
        return;
      }
      for (const file of files) {
        let detail = {};
        try { detail = JSON.parse(await ctx.api.raw(`plan/proposals/${file.name}`)); } catch { /* 忽略 */ }
        const status = detail.status ?? 'pending';
        const pending = status === 'pending';
        list.append(h('div', { class: 'card tight', style: 'margin-bottom:10px' },
          h('div', { class: 'row', style: 'border:0;padding:0' },
            h('div', { class: 'grow' },
              h('div', { class: 'name' }, file.name),
              h('div', { class: 'sub' }, `生效 ${detail.effective_from ?? '—'} · 状态 ${status}`),
            ),
            pending
              ? h('div', { class: 'field-row', style: 'max-width:170px' },
                  h('button', { class: 'btn small', onClick: () => decide(ctx, file.name, 'apply') }, '采纳'),
                  h('button', { class: 'btn small danger', onClick: () => decide(ctx, file.name, 'reject') }, '不采纳'),
                )
              : h('span', { class: `chip ${status === 'expired' ? '' : status === 'applied' ? 'lime' : ''}`, style: status === 'expired' ? 'opacity:.55' : '' },
                  status === 'expired' ? '已过期' : status === 'applied' ? '已采纳' : status === 'rejected' ? '未采纳' : status),
          ),
        ));
      }
    } catch (error) {
      clear(list);
      list.append(banner(`读取失败：${error?.message ?? error}`, 'err'));
    }
  })();

  return wrap;
}

async function decide(ctx, file, decision) {
  if (ctx.state.demo) { toast('演示模式不会提交'); return; }
  toast(decision === 'apply' ? '正在排队采纳…' : '正在排队标记不采纳…');
  try {
    const { promise } = enqueue(ctx.api, {
      workflow: 'apply_proposal.yml',
      inputs: { path: `plan/proposals/${file}`, decision },
    });
    const result = await promise;
    toast(describeRun(result));
    if (result.state === 'success') setTimeout(() => ctx.refresh(), 800);
  } catch (error) {
    toast(`失败：${error?.message ?? error}`);
  }
}
