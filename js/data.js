// @ts-check
/** 数据契约：把仓库里的 JSON / CSV 解析成页面能用的形状。
 *
 * 与 app/lib 的模型保持同一口径（见 docs/数据契约.md）：
 * - summary.json 由 build_summary.py 生成
 * - routine.json 的 rotation 决定「这周每天用哪个模板」
 * - 所有日期都是 Asia/Shanghai 的 YYYY-MM-DD
 */

const TZ = 'Asia/Shanghai';

/** 今天（北京时间），YYYY-MM-DD */
export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

/** @param {string} iso */
export function dateFromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** @param {Date} date */
export function isoFromDate(date) {
  return date.toISOString().slice(0, 10);
}

/** 周一为 1 */
export function weekday(iso) {
  const d = dateFromISO(iso).getUTCDay();
  return d === 0 ? 7 : d;
}

/** @param {string} iso */
export function addDays(iso, days) {
  const d = dateFromISO(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return isoFromDate(d);
}

/** 本周周一 */
export function weekStart(iso = todayISO()) {
  return addDays(iso, 1 - weekday(iso));
}

/** @param {import('./api.js').GitHubApi} api @param {{fresh?: boolean}} [opts] */
export async function loadAll(api, opts = {}) {
  const files = {
    config: { path: 'config.json', maxAgeMs: 60_000 },
    summary: { path: 'data/summary.json', maxAgeMs: 30_000 },
    routine: { path: 'plan/routine.json', maxAgeMs: 60_000 },
    reviewIndex: { path: 'review/index.json', maxAgeMs: 60_000 },
    daily: { path: 'data/daily.csv', maxAgeMs: 30_000 },
    strength: { path: 'data/strength.csv', maxAgeMs: 30_000 },
    diet: { path: 'data/diet.csv', maxAgeMs: 30_000 },
    checkin: { path: 'data/checkin.csv', maxAgeMs: 30_000 },
    body: { path: 'data/body.csv', maxAgeMs: 30_000 },
    syncState: { path: 'data/sync_state.json', maxAgeMs: 30_000 },
  };
  /** @type {string[]} */
  const missing = [];
  const entries = await Promise.all(
    Object.entries(files).map(async ([key, def]) => {
      try {
        const text = await api.raw(def.path, { ...opts, maxAgeMs: def.maxAgeMs });
        return [key, text];
      } catch (error) {
        if (error instanceof Error && error.name === 'NotFoundError') {
          missing.push(def.path);
          return [key, null];
        }
        throw error;
      }
    }),
  );
  /** @type {Record<string, string|null>} */
  const raw = Object.fromEntries(entries);

  /** @type {string[]} */
  const corrupt = [];
  const parse = (key) => {
    const text = raw[key];
    if (!text) return null;
    try { return JSON.parse(text); }
    catch { corrupt.push(files[key].path); return null; }
  };

  const config = parse('config');
  // CSV 模式不依赖 sync_state.json；它不存在是正常状态，不应报“缺失文件”。
  // 只有 API 模式（云端自动同步）才把它当作必需文件。
  const expectedMissing = hevyMode(config) === 'api'
    ? missing
    : missing.filter((path) => path !== files.syncState.path);

  return {
    config,
    summary: parse('summary'),
    routine: parse('routine'),
    reviewIndex: parse('reviewIndex'),
    daily: parseCSV(raw.daily),
    strength: parseCSV(raw.strength),
    diet: parseCSV(raw.diet),
    checkin: parseCSV(raw.checkin),
    body: parseCSV(raw.body),
    syncState: parse('syncState'),
    loadedAt: new Date().toISOString(),
    /** 仓库里不存在的可选文件，设置页会汇总提示 */
    missing: expectedMissing,
    /** 缓存里的 JSON 坏了（解析失败），引导用户清缓存 */
    corrupt,
    /** 本次是否有请求因断网回落到缓存 */
    offline: Boolean(api.lastOffline),
    offlineAt: api.lastOffline?.at ? new Date(api.lastOffline.at).toISOString() : null,
  };
}

/**
 * Hevy 导入模式：`csv` 手动上传，`api` 云端自动同步。缺省按 csv 处理。
 * @param {any} config
 * @returns {'csv'|'api'}
 */
export function hevyMode(config) {
  return String(config?.hevy_mode ?? '').trim().toLowerCase() === 'api' ? 'api' : 'csv';
}

/** 定时任务每天 22:43 跑一次；超过这个小时数还没同步就算超时。 */
export const HEVY_SYNC_STALE_HOURS = 26;

/**
 * 解析 sync_state.json，判断上次同步是否超时。
 * @param {any} syncState
 * @param {number} [now] 毫秒时间戳（测试用）
 * @returns {{at: string|null, hours: number|null, stale: boolean, unknown: boolean}}
 */
export function hevySyncStatus(syncState, now = Date.now()) {
  const raw = syncState?.last_run_at || syncState?.last_event_at || '';
  const at = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(at)) return { at: null, hours: null, stale: true, unknown: true };
  const hours = (now - at) / 3_600_000;
  return { at: new Date(at).toISOString(), hours, stale: hours > HEVY_SYNC_STALE_HOURS, unknown: false };
}

/** 北京时间「11月7日 12:44」 @param {string} iso */
export function fmtDateTime(iso) {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${Number(get('month'))}月${Number(get('day'))}日 ${get('hour')}:${get('minute')}`;
}

/** 极简 CSV 解析（支持引号与转义引号） @param {string|null} text */
export function parseCSV(text) {
  if (!text) return [];
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((v) => String(v ?? '').trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** 数字或 null */
export function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析今天的课表（复刻 app/lib/features/today/routine_models.dart 的 rotation 逻辑）。
 * @param {any} routine
 * @param {string} iso
 */
export function dayFor(routine, iso = todayISO()) {
  if (!routine) return null;
  const days = (routine.days ?? []).slice().sort((a, b) => a.weekday - b.weekday);
  const rotation = routine.rotation ?? {};
  const weeks = rotation.weeks ?? [];
  const slots = rotation.strength_slots ?? [];
  const anchor = rotation.anchor ?? '';
  const wd = weekday(iso);

  /** @type {Map<number, any>} */
  const byWeekday = new Map(days.map((d) => [d.weekday, d]));

  if (!weeks.length || !slots.length || !anchor) return byWeekday.get(wd) ?? null;

  const anchorStart = weekStart(anchor);
  const thisStart = weekStart(iso);
  const diffDays = Math.round((dateFromISO(thisStart).getTime() - dateFromISO(anchorStart).getTime()) / 86400000);
  let index = Math.floor(diffDays / 7) % weeks.length;
  if (index < 0) index += weeks.length;
  const sources = weeks[index] ?? [];

  const slot = slots.indexOf(wd);
  if (slot < 0 || slot >= sources.length) return byWeekday.get(wd) ?? null;
  const source = byWeekday.get(sources[slot]);
  if (!source) return byWeekday.get(wd) ?? null;
  return { ...source, weekday: wd, rotatedFrom: source.weekday };
}

/** 「第 2 周」这类标签：优先用 summary 里算好的 cycle */
export function cycleLabel(summary) {
  return summary?.cycle?.label ?? '';
}

/** 本周还差什么：返回 [{label, done, target, unit}] */
export function weekGaps(summary, config) {
  if (!summary) return [];
  const targets = summary.targets ?? {};
  const gap = [];
  const sessions = num(summary.strength_sessions);
  const sessionTarget = num(targets.strength_sessions ?? config?.weekly_targets?.strength_sessions);
  if (sessionTarget != null) gap.push({ key: 'strength', label: '力量', done: sessions ?? 0, target: sessionTarget, unit: '次' });
  const cardio = num(summary.cardio_minutes);
  const cardioMin = num(targets.cardio_minutes ?? config?.weekly_targets?.cardio_minutes);
  const cardioMax = num(targets.cardio_minutes_max ?? config?.weekly_targets?.cardio_minutes_max ?? 150);
  if (cardioMin != null) gap.push({ key: 'cardio', label: '有氧', done: cardio ?? 0, target: cardioMin, max: cardioMax, unit: '分钟' });
  const protein = num(summary.avg_protein_g);
  const proteinTarget = num(targets.target_protein_g);
  if (proteinTarget != null) gap.push({ key: 'protein', label: '蛋白', done: math_round(protein ?? 0), target: proteinTarget, unit: 'g' });
  return gap;
}

function math_round(v) { return Math.round(v * 10) / 10; }

/**
 * 周目标预测：当前完成量 + 本周剩下的课表，估算最多能到多少。
 * 简单估算，不判断今天是否已经练完；文案里用「最多」。
 * @param {any} summary
 * @param {any} routine
 * @param {any} config
 * @param {string} [iso]
 * @returns {{key:string,label:string,done:number,target:number,remaining:number,
 *            projected:number,unit:string,reachable:boolean}[]}
 */
export function weekForecast(summary, routine, config, iso = todayISO()) {
  if (!summary) return [];
  const targets = summary.targets ?? {};
  const cfg = config?.weekly_targets ?? {};
  /** @type {string[]} */
  const dates = [iso];
  for (let d = addDays(iso, 1); weekday(d) !== 1; d = addDays(d, 1)) dates.push(d);
  const plans = dates.map((d) => dayFor(routine, d)).filter(Boolean);

  const strengthDays = plans.filter((p) => p.type === 'strength').length;
  const cardioRemaining = plans.reduce(
    (sum, p) => sum + (p.type === 'cardio' ? cardioMinutesOf(p) : 0),
    0,
  );

  const items = [];
  const strengthTarget = num(targets.strength_sessions ?? cfg.strength_sessions);
  if (strengthTarget != null) {
    const done = num(summary.strength_sessions) ?? 0;
    items.push({
      key: 'strength', label: '力量', done, target: strengthTarget,
      remaining: strengthDays, projected: done + strengthDays, unit: '次',
      reachable: done + strengthDays >= strengthTarget,
    });
  }
  const cardioTarget = num(targets.cardio_minutes ?? cfg.cardio_minutes);
  if (cardioTarget != null) {
    const done = num(summary.cardio_minutes) ?? 0;
    items.push({
      key: 'cardio', label: '有氧', done, target: cardioTarget,
      remaining: cardioRemaining, projected: done + cardioRemaining, unit: '分钟',
      reachable: done + cardioRemaining >= cardioTarget,
    });
  }
  return items;
}

/** @param {any} plan */
function cardioMinutesOf(plan) {
  const segments = (plan.segments_min ?? []).reduce((a, b) => a + Number(b || 0), 0);
  return segments || Number(plan.duration_min || 0);
}

/** @param {any} history @param {string} key */
export function exerciseHistory(history, key) {
  if (!history || !key) return null;
  const entry = history[key];
  return entry && typeof entry === 'object' ? entry : null;
}

/** @param {string} iso */
export function fmtDate(iso) {
  if (!iso) return '';
  const wd = ['', '一', '二', '三', '四', '五', '六', '日'][weekday(iso)];
  return `${Number(iso.slice(5, 7))}月${Number(iso.slice(8, 10))}日 周${wd}`;
}

/** 数字去掉多余的 .0 */
export function fmtNum(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}
