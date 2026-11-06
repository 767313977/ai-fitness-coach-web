// @ts-check
/** 动作库数据：仓库内置的精选动作（30 个，中文步骤）。
 *
 * 为什么不是完整的 1324 动作数据集：那份 JSON 有 17MB，首次打开要下载很久；
 * 完整数据集见 hasaneyldrm/exercises-dataset（数据 MIT），需要时把它的
 * data/exercises.json 转换成同样的 { exercises: [...] } 结构放进 web/data/ 即可。
 * 不包含 Gym visual 的图片/GIF（媒体版权属于 Gym visual，需单独授权）。
 */
const URL_DATASET = './data/exercises.json';

/** 本计划动作 key → 数据集里英文名的匹配词（按顺序尝试） */
export const PLAN_MATCHERS = {
  goblet_box_squat: ['goblet squat', 'box squat'],
  glute_bridge: ['glute bridge', 'hip thrust'],
  calf_raise: ['calf raise'],
  dead_bug: ['dead bug'],
  dumbbell_floor_press: ['floor press'],
  one_arm_dumbbell_row: ['one arm', 'row'],
  seated_dumbbell_shoulder_press: ['shoulder press'],
  lateral_raise: ['lateral raise'],
  dumbbell_biceps_curl: ['biceps curl', 'curl'],
  bent_over_fly: ['bent over fly'],
  romanian_deadlift: ['romanian deadlift'],
  split_squat: ['split squat', 'lunge'],
  plank: ['plank'],
};

/** 中文分类 → 关键词 */
export const ZH_TAGS = {
  胸: ['chest', 'pectorals'],
  背: ['back', 'upper back', 'spine'],
  腿: ['upper legs', 'lower legs', 'quads', 'hamstrings', 'glutes', 'calves'],
  肩: ['shoulders', 'delts'],
  手臂: ['upper arms', 'biceps', 'triceps'],
  核心: ['waist', 'abs'],
  有氧: ['cardio'],
  拉伸: ['stretch', 'mobility'],
};

/** @type {any[]|null} */
let memo = null;

/** @returns {Promise<any[]>} */
export async function loadExercises() {
  if (memo) return memo;
  const res = await fetch(URL_DATASET, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`动作库加载失败：HTTP ${res.status}`);
  const data = await res.json();
  memo = Array.isArray(data) ? data : (data.exercises ?? []);
  return memo;
}

/**
 * 给本计划的每个动作找数据条目。
 * @param {any} routine
 * @param {any[]} dataset
 */
export function matchPlan(routine, dataset) {
  /** @type {Map<string, any>} */
  const out = new Map();
  const seen = new Set();
  for (const day of routine?.days ?? []) {
    for (const ex of day.exercises ?? []) {
      if (!ex.key || seen.has(ex.key)) continue;
      seen.add(ex.key);
      const matchers = PLAN_MATCHERS[ex.key] ?? [];
      let hit = null;
      for (const m of matchers) {
        hit = dataset.find((item) => String(item.name).toLowerCase().includes(m));
        if (hit) break;
      }
      if (hit) out.set(ex.key, hit);
    }
  }
  return out;
}

/** @param {any[]} dataset @param {string} query @param {number} [limit] */
export function searchExercises(dataset, query, limit = 80) {
  const q = query.trim().toLowerCase();
  if (!q) return dataset.slice(0, limit);
  const zhKey = Object.keys(ZH_TAGS).find((k) => q.includes(k));
  const zhTerms = zhKey ? ZH_TAGS[zhKey] : [];
  return dataset.filter((item) => {
    const hay = `${item.name} ${item.zh ?? ''} ${item.body_part} ${item.target} ${item.equipment}`.toLowerCase();
    if (hay.includes(q)) return true;
    return zhTerms.some((term) => hay.includes(term));
  }).slice(0, limit);
}

/** @param {any} item */
export function zhSteps(item) {
  return Array.isArray(item?.steps) ? item.steps : [];
}

/** @param {any} item */
export function zhText(item) {
  return zhSteps(item).join('');
}
