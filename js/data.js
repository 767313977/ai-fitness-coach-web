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
    config: 'config.json',
    summary: 'data/summary.json',
    routine: 'plan/routine.json',
    reviewIndex: 'review/index.json',
    daily: 'data/daily.csv',
    strength: 'data/strength.csv',
    diet: 'data/diet.csv',
    checkin: 'data/checkin.csv',
    body: 'data/body.csv',
  };
  const entries = await Promise.all(
    Object.entries(files).map(async ([key, path]) => {
      try {
        const text = await api.raw(path, opts);
        return [key, text];
      } catch (error) {
        if (error instanceof Error && error.name === 'NotFoundError') return [key, null];
        throw error;
      }
    }),
  );
  /** @type {Record<string, string|null>} */
  const raw = Object.fromEntries(entries);

  return {
    config: parseJSON(raw.config),
    summary: parseJSON(raw.summary),
    routine: parseJSON(raw.routine),
    reviewIndex: parseJSON(raw.reviewIndex),
    daily: parseCSV(raw.daily),
    strength: parseCSV(raw.strength),
    diet: parseCSV(raw.diet),
    checkin: parseCSV(raw.checkin),
    body: parseCSV(raw.body),
    loadedAt: new Date().toISOString(),
  };
}

/** @param {string|null} text */
function parseJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
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
