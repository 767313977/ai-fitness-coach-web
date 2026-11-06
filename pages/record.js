// @ts-check
/** 记录：打卡 / 饮食 / 有氧 / 身体指标 / 导入 Hevy / 生成周复盘 / 采纳提案。
 *
 * 所有提交都进全局串行队列（js/queue.js）：一次只发一个，避免 GitHub 并发组把排队任务顶掉。
 */
import { h, banner, clear, toast, icon } from '../js/ui.js';
import { todayISO } from '../js/data.js';
import { importHevy, describeRun } from '../js/submit.js';
import { enqueue } from '../js/queue.js';

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
          h('div', { class: 'sub' }, item.desc),
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
 * @param {{title: string, workflow: string, fields: any[], hint?: string,
 *          submitLabel?: string, validate?: (v: Record<string,string>) => string|null}} def
 */
function formPage(ctx, def) {
  const wrap = h('div');
  wrap.append(back(ctx, '/record', '记录'));
  wrap.append(h('h2', { style: 'margin:6px 0 12px' }, def.title));

  /** @type {Record<string, HTMLInputElement|HTMLSelectElement>} */
  const inputs = {};
  const form = h('div', { class: 'card' });

  for (const field of def.fields) {
    form.append(h('div', { class: 'field' },
      h('label', {}, field.label, field.optional ? h('span', { style: 'color:var(--text-3)' }, '（可选）') : null),
      field.type === 'select'
        ? (() => {
            const el = h('select', { class: 'input' }, (field.options ?? []).map((o) => h('option', { value: o.value }, o.label)));
            el.value = field.value ?? field.options?.[0]?.value ?? '';
            inputs[field.name] = el;
            return el;
          })()
        : (() => {
            const el = h('input', {
              class: 'input',
              type: field.type ?? 'text',
              placeholder: field.placeholder ?? '',
              value: field.value ?? '',
              max: field.max ?? null,
              min: field.min ?? null,
              inputmode: field.numeric ? 'decimal' : null,
            });
            inputs[field.name] = el;
            return el;
          })(),
      field.hint ? h('div', { class: 'hint' }, field.hint) : null,
    ));
  }

  const status = h('div', { class: 'hint', style: 'min-height:20px' });
  const submit = h('button', { class: 'btn primary block' }, def.submitLabel ?? '提交');
  submit.addEventListener('click', async () => {
    if (ctx.state.demo) { toast('演示模式不会提交'); return; }
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
    if (typeof def.validate === 'function') {
      const problem = def.validate(values);
      if (problem) { status.textContent = problem; return; }
    }
    submit.disabled = true;
    status.textContent = '提交中…';
    try {
      const { position, promise } = enqueue(ctx.api, {
        workflow: def.workflow,
        inputs: values,
        onStatus: (s) => { status.textContent = s; },
      });
      if (position > 0) status.textContent = `排队中（前面还有 ${position} 条）`;
      const result = await promise;
      status.textContent = `结果：${describeRun(result)}`;
      if (result.state === 'success') {
        toast('已写入仓库');
        setTimeout(() => ctx.refresh(), 600);
      }
    } catch (error) {
      status.textContent = `失败：${error?.message ?? error}`;
    } finally {
      submit.disabled = false;
    }
  });

  form.append(status, submit);
  wrap.append(form);
  if (def.hint) wrap.append(h('div', { class: 'hint' }, def.hint));
  return wrap;
}

function back(ctx, path, label) {
  return h('button', { class: 'btn ghost small', onClick: () => ctx.navigate(path) }, `← ${label}`);
}

function dateField() {
  return { name: 'date', label: '日期', type: 'date', value: todayISO(), max: todayISO() };
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
      { name: 'knee_pain', label: '膝痛（0–10）', type: 'number', numeric: true, min: 0, max: 10, placeholder: '2', hint: '平时 1–2 分；4 分以上当天停下肢动作。' },
      { name: 'energy', label: '精力（1–5）', type: 'number', numeric: true, min: 1, max: 5, placeholder: '4' },
      { name: 'sleep_feel', label: '睡眠感受（1–5）', type: 'number', numeric: true, min: 1, max: 5, placeholder: '4' },
      { name: 'note', label: '备注', optional: true },
    ],
  });
}

function dietPage(ctx) {
  return formPage(ctx, {
    title: '记饮食',
    workflow: 'diet.yml',
    submitLabel: '提交饮食',
    hint: '只抄薄荷「每日饮食汇总页」上的 5 个数，截图数字按 ±10% 误差看趋势。',
    fields: [
      dateField(),
      { name: 'kcal', label: '全天热量 kcal', type: 'number', numeric: true, placeholder: '2100' },
      { name: 'protein', label: '蛋白 g', type: 'number', numeric: true, placeholder: '120' },
      { name: 'carbs', label: '碳水 g', optional: true, type: 'number', numeric: true },
      { name: 'fat', label: '脂肪 g', optional: true, type: 'number', numeric: true },
      { name: 'weight', label: '晨起体重 kg', optional: true, type: 'number', numeric: true, placeholder: '70.0' },
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
      const parts = [];
      if (v.segments) {
        for (const piece of String(v.segments).split(',')) {
          const n = Number(piece.trim());
          if (!Number.isFinite(n) || n <= 0) return '分段要写成 30,30 这种正整数';
          parts.push(n);
        }
      } else if (v.minutes) {
        const n = Number(v.minutes);
        if (!Number.isFinite(n) || n <= 0) return '分钟数要是正整数';
        parts.push(n);
      }
      if (parts.some((n) => n > 30)) return '单段不超过 30 分钟';
      return null;
    },
    fields: [
      dateField(),
      { name: 'segments', label: '分段分钟', optional: true, placeholder: '例：30,30' },
      { name: 'minutes', label: '或单段分钟数', optional: true, type: 'number', numeric: true, placeholder: '例：30' },
      { name: 'type', label: '方式', type: 'select', options: [
        { value: '快走', label: '快走' }, { value: '骑车', label: '骑车' }, { value: '其他', label: '其他' },
      ] },
      { name: 'distance_km', label: '距离 km', optional: true, type: 'number', numeric: true },
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
    fields: [
      dateField(),
      { name: 'waist_cm', label: '腰围 cm', optional: true, type: 'number', numeric: true },
      { name: 'body_fat_pct', label: '体脂率 %', optional: true, type: 'number', numeric: true },
      { name: 'skeletal_muscle_kg', label: '骨骼肌 kg', optional: true, type: 'number', numeric: true },
      { name: 'source', label: '来源', type: 'select', options: [
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
  const fileInput = h('input', { class: 'input', type: 'file', accept: '.csv,text/csv' });
  const status = h('div', { class: 'hint', style: 'min-height:20px' });
  const btn = h('button', { class: 'btn primary block' }, '上传并导入');

  btn.addEventListener('click', async () => {
    if (ctx.state.demo) { toast('演示模式不会提交'); return; }
    const file = fileInput.files?.[0];
    if (!file) { status.textContent = '先选一个 Hevy 导出的 CSV'; return; }
    btn.disabled = true;
    try {
      const { position, promise } = importHevy(ctx.api, file, (s) => { status.textContent = s; });
      if (position > 0) status.textContent = `排队中（前面还有 ${position} 条）`;
      const result = await promise;
      status.textContent = `结果：${describeRun(result)}`;
      if (result.state === 'success') {
        toast('导入完成');
        setTimeout(() => ctx.refresh(), 600);
      }
    } catch (error) {
      status.textContent = `失败：${error?.message ?? error}`;
    } finally {
      btn.disabled = false;
    }
  });

  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, 'Hevy → 导出 CSV'),
    h('div', { class: 'hint', style: 'margin-bottom:12px' },
      'Hevy → Profile → Settings → Export & Import Data → Export Workouts。上传需要 PAT 有 Contents 读写权限；Actions 导入后会删除临时文件。'),
    fileInput,
    status,
    btn,
  ));
  return wrap;
}

function weeklyPage(ctx) {
  const wrap = h('div');
  wrap.append(back(ctx, '/record', '记录'));
  wrap.append(h('h2', { style: 'margin:6px 0 12px' }, '生成周复盘'));
  const status = h('div', { class: 'hint', style: 'min-height:20px' });
  const btn = h('button', { class: 'btn primary block' }, '立即生成（消耗一次 Actions）');

  btn.addEventListener('click', async () => {
    if (ctx.state.demo) { toast('演示模式不会提交'); return; }
    btn.disabled = true;
    status.textContent = '提交中…';
    try {
      const { position, promise } = enqueue(ctx.api, {
        workflow: 'weekly.yml',
        inputs: {},
        onStatus: (s) => { status.textContent = s; },
      });
      if (position > 0) status.textContent = `排队中（前面还有 ${position} 条）`;
      const result = await promise;
      status.textContent = `结果：${describeRun(result)}`;
      if (result.state === 'success') {
        toast('复盘已生成');
        setTimeout(() => ctx.refresh(), 800);
      }
    } catch (error) {
      status.textContent = `失败：${error?.message ?? error}`;
    } finally {
      btn.disabled = false;
    }
  });

  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'hint', style: 'margin-bottom:12px' },
      '会生成 review/week-*.md 的第 1–4 节，并让 AI 写 5.1–5.4 与下周提案。周日 21:17 会自动跑一次。'),
    status,
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
      const dir = await ctx.api.actionsGet('contents/plan/proposals?ref=master').catch(() => []);
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
