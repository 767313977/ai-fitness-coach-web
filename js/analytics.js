// @ts-check
/** 训练分析：纯函数，不碰 DOM，不依赖任何第三方库。
 *
 * 数据来源是 data/strength.csv（网页已读到的 data.strength），列为
 * date, exercise, set_no, weight_kg, reps, rpe, note, source。
 * 判进口径严格按 AGENTS.md 第 4 节：按训练次数比较，不按周。
 */

/** @param {any} value */
export function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** @param {any} row */
export function isBodyweightRow(row) {
  const weight = num(row?.weight_kg);
  return weight === null || weight === 0;
}

/** @param {string} name */
export function isAssisted(name) {
  return /assisted|助力/i.test(String(name ?? ''));
}

/** Epley 公式估算 1RM；只在该区间内算，界面上必须标「估算」。 */
/** @param {any} weightKg @param {any} reps */
export function estimated1RM(weightKg, reps) {
  const weight = num(weightKg);
  const r = num(reps);
  if (weight === null || r === null) return null;
  if (weight <= 0 || r <= 0 || r > 12) return null;
  return Math.round(weight * (1 + r / 30) * 100) / 100;
}

/**
 * 每个训练日最好的一组：负重按 重量×次数，自重按次数。
 * @param {any[]} rows
 * @param {string} exercise
 * @returns {{date: string, weight: number, reps: number, volume: number, score: number}[]} 按日期升序
 */
export function bestSetByDay(rows, exercise) {
  /** @type {Map<string, any>} */
  const byDate = new Map();
  for (const row of rows ?? []) {
    if (row?.exercise !== exercise) continue;
    const reps = num(row.reps);
    if (reps === null || reps <= 0) continue;
    const weight = num(row.weight_kg) ?? 0;
    const volume = weight * reps;
    const score = weight > 0 ? volume : reps;
    const current = byDate.get(row.date);
    if (!current || score > current.score) {
      byDate.set(row.date, { date: row.date, weight, reps, volume, score });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 判断课表动作的进步状态。
 * @param {any[]} rows
 * @param {string} exercise
 * @returns {{status: 'up'|'down'|'plateau'|'insufficient', sessions: number, last?: any, previous?: any}}
 */
export function progressStatus(rows, exercise) {
  const sessions = bestSetByDay(rows, exercise);
  if (sessions.length < 3) return { status: 'insufficient', sessions: sessions.length };
  const last = sessions[sessions.length - 1];
  const prev = sessions[sessions.length - 2];

  // 先看最近一次相对上一次：升/降更具体；持平且已有 3 次记录才算停滞
  if (last.score > prev.score) return { status: 'up', sessions: sessions.length, last, previous: prev };
  if (last.score < prev.score) return { status: 'down', sessions: sessions.length, last, previous: prev };
  return { status: 'plateau', sessions: sessions.length, last, previous: prev };
}

/**
 * 按动作统计个人纪录。自重/助力动作不计入容量，只统计最多次数。
 * @param {any[]} rows
 * @returns {Record<string, {
 *   maxWeight?: {value: number, date: string, reps: number},
 *   best1RM?: {value: number, date: string, weight: number, reps: number},
 *   maxSetVolume?: {value: number, date: string, weight: number, reps: number},
 *   maxSessionVolume?: {value: number, date: string},
 *   maxReps?: {value: number, date: string, weight: number}
 * }>}
 */
export function personalRecords(rows) {
  /** @type {Map<string, any[]>} */
  const byExercise = new Map();
  for (const row of rows ?? []) {
    const name = row?.exercise;
    if (!name) continue;
    if (!byExercise.has(name)) byExercise.set(name, []);
    byExercise.get(name).push(row);
  }

  /** @type {Record<string, any>} */
  const out = {};
  for (const [name, list] of byExercise) {
    const assisted = isAssisted(name);
    const bodyweight = list.every((r) => isBodyweightRow(r));
    const rec = {};

    // 最大重量（助力动作的重量是机器分担，不算负重纪录）
    if (!assisted) {
      for (const row of list) {
        const weight = num(row.weight_kg);
        const reps = num(row.reps) ?? 0;
        if (weight === null || weight <= 0) continue;
        if (!rec.maxWeight || weight > rec.maxWeight.value) {
          rec.maxWeight = { value: weight, date: row.date, reps };
        }
      }
    }

    // 最佳估算 1RM
    if (!assisted) {
      for (const row of list) {
        const value = estimated1RM(row.weight_kg, row.reps);
        if (value === null) continue;
        if (!rec.best1RM || value > rec.best1RM.value) {
          rec.best1RM = { value, date: row.date, weight: num(row.weight_kg) ?? 0, reps: num(row.reps) ?? 0 };
        }
      }
    }

    // 单组最大容量 / 单次训练最大容量（自重与助力不计）
    if (!assisted && !bodyweight) {
      /** @type {Map<string, number>} */
      const sessionVolume = new Map();
      for (const row of list) {
        const weight = num(row.weight_kg) ?? 0;
        const reps = num(row.reps) ?? 0;
        if (weight <= 0 || reps <= 0) continue;
        const volume = weight * reps;
        if (!rec.maxSetVolume || volume > rec.maxSetVolume.value) {
          rec.maxSetVolume = { value: volume, date: row.date, weight, reps };
        }
        sessionVolume.set(row.date, (sessionVolume.get(row.date) ?? 0) + volume);
      }
      for (const [date, value] of sessionVolume) {
        if (!rec.maxSessionVolume || value > rec.maxSessionVolume.value) {
          rec.maxSessionVolume = { value, date };
        }
      }
    }

    // 自重/助力：只统计最多次数
    if (assisted || bodyweight) {
      for (const row of list) {
        const reps = num(row.reps) ?? 0;
        if (reps <= 0) continue;
        if (!rec.maxReps || reps > rec.maxReps.value) {
          rec.maxReps = { value: reps, date: row.date, weight: num(row.weight_kg) ?? 0 };
        }
      }
    }

    out[name] = rec;
  }
  return out;
}

/**
 * 本周破纪录的动作：返回 [{exercise, kind, value, date}]。
 * @param {any[]} rows @param {string} weekStart 周一（YYYY-MM-DD）
 */
export function recordsThisWeek(rows, weekStart) {
  const end = addDaysISO(weekStart, 6);
  const inWeek = (date) => date >= weekStart && date <= end;
  const records = personalRecords(rows);
  const out = [];
  for (const [exercise, rec] of Object.entries(records)) {
    for (const [kind, label] of [
      ['maxWeight', '最大重量'],
      ['best1RM', '最佳估算 1RM'],
      ['maxSetVolume', '单组最大容量'],
      ['maxSessionVolume', '单次训练最大容量'],
      ['maxReps', '最多次数'],
    ]) {
      const entry = rec[kind];
      if (entry && inWeek(entry.date)) {
        out.push({ exercise, kind, label, value: entry.value, date: entry.date });
      }
    }
  }
  return out;
}

/**
 * 本周各肌群组数。muscleMap: 动作名 → target（英文肌群）。
 * @param {any[]} rows @param {Map<string,string>} muscleMap @param {string} weekStart
 * @returns {{muscle: string, sets: number}[]}
 */
export function weeklySetsByMuscle(rows, muscleMap, weekStart) {
  const end = addDaysISO(weekStart, 6);
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const row of rows ?? []) {
    if (!row?.date || row.date < weekStart || row.date > end) continue;
    const muscle = muscleMap.get(row.exercise) ?? '未分类';
    counts.set(muscle, (counts.get(muscle) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([muscle, sets]) => ({ muscle, sets }))
    .sort((a, b) => b.sets - a.sets);
}

/** @param {string} iso @param {number} days */
export function addDaysISO(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const STATUS_LABEL = {
  up: '进步',
  down: '下降',
  plateau: '停滞',
  insufficient: '数据不足',
};
