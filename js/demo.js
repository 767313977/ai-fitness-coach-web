// @ts-check
/** 演示数据：**全部是虚构人物**，和真实用户的身体数据无关。
 *  人物设定：70.0 kg / 172 cm / 28 岁 / 体脂 20% / 右肩旧伤 / 目标热量 2200 kcal。
 *  禁止在这里出现任何真实用户的数据（体重、体脂、热量目标、具体病史…）。
 */
import { todayISO, addDays, weekStart } from './data.js';

const TODAY = todayISO();
const WEEK_START = weekStart(TODAY);

/** 本周内的第 n 天（0=周一），超过今天就不生成 */
function dayInWeek(n) {
  const iso = addDays(WEEK_START, n);
  return iso <= TODAY ? iso : null;
}

/** 第 n 周（相对本周一，-3 表示三周前）的周一 */
function weekOf(offsetWeeks) {
  return addDays(WEEK_START, offsetWeeks * 7);
}

const DEMO_REVIEW = [
  '# 第 45 周复盘（演示数据）',
  '',
  '## 1. 完成度',
  '',
  '| 项目 | 实际 | 目标 | 结论 |',
  '|---|---|---|---|',
  '| 力量训练 | 2 次 | 3 次 | 差 1 |',
  '| 有氧 | 60 分钟 | 90–150 分钟 | 差 30 |',
  '',
  '## 5. AI 教练填写（演示）',
  '',
  '### 5.1 这周实际发生了什么',
  '周一周三两次训练都完成，周五因为加班顺延到周六上午。',
  '',
  '### 5.2 下周怎么调',
  '把周五的下肢 B 挪到周四晚上，周六保留两段快走，不要叠在一起。',
  '',
  '（链接防御演示：[x](javascript:alert(1)) 应显示为纯文本，不可点击。）',
  '',
  '### 5.3 下周怎么验证',
  '周四训练后右肩没有不适、周六两段快走都完成，就说明调整有效。',
  '',
  '## 6. 下周课表',
  '见 `plan/routine.md`。',
].join('\n');

/** 近 70 天的活动记录，让热力图有内容；全部是虚构的规律数据 */
function makeHistory() {
  const daily = [];
  const diet = [];
  const checkin = [];
  for (let i = 1; i <= 70; i += 1) {
    const d = addDays(TODAY, -i);
    if (i % 2 === 0) {
      daily.push({
        date: d, source: 'watch',
        steps: String(4800 + (i * 37) % 4200),
        sleep_h: (6.4 + ((i * 7) % 12) / 10).toFixed(1),
        resting_hr: String(58 + (i % 6)),
        cardio_min: String(i % 3 === 0 ? 30 : 0),
      });
    }
    if (i % 3 !== 0) {
      diet.push({
        date: d,
        weight_kg: (70.6 - i * 0.004).toFixed(1),
        kcal: String(2050 + (i * 23) % 260),
        protein_g: String(105 + (i * 11) % 35),
      });
    }
    if (i % 4 !== 0) {
      checkin.push({
        date: d,
        knee_pain: String(i % 3),
        energy: String(3 + (i % 3)),
        sleep_feel: String(3 + (i % 2)),
      });
    }
  }
  return { daily, diet, checkin };
}

const DEMO_HISTORY = makeHistory();
export const DEMO_DATA = {
  demo: true,
  config: {
    athlete: { name: '演示用户', weight_kg: 70.0, height_cm: 172, age: 28, goal: '减脂+增肌（体成分重组）' },
    weekly_targets: {
      strength_sessions: 3, cardio_minutes: 90, cardio_minutes_max: 150,
      avg_sleep_h: 7.5, target_kcal: 2200, protein_g_per_kg: 1.8,
    },
    timezone: 'Asia/Shanghai',
    knee_pain_baseline: 0,
  },
  summary: {
    generated_at: new Date().toISOString(),
    week: { start: WEEK_START, end: addDays(WEEK_START, 6) },
    cycle: { index: 1, week: 1, label: '第 1 期 第 1 周', start: WEEK_START, end: addDays(WEEK_START, 27) },
    strength_sessions: 2,
    strength_sets: 18,
    tonnage_kg: 1860,
    cardio_minutes: 60,
    avg_kcal: 2160,
    avg_protein_g: 118,
    diet_days: 4,
    weight_weekly: [
      { week_start: weekOf(-3), week_end: addDays(weekOf(-3), 6), avg_weight_kg: 70.6 },
      { week_start: weekOf(-2), week_end: addDays(weekOf(-2), 6), avg_weight_kg: 70.4 },
      { week_start: weekOf(-1), week_end: addDays(weekOf(-1), 6), avg_weight_kg: 70.2 },
      { week_start: WEEK_START, week_end: addDays(WEEK_START, 6), avg_weight_kg: 70.0 },
    ],
    daily_kcal: [
      { date: dayInWeek(0), kcal: 2120 },
      { date: dayInWeek(1), kcal: 2240 },
      { date: dayInWeek(2), kcal: 2090 },
      { date: dayInWeek(3), kcal: 2260 },
      { date: dayInWeek(4), kcal: 2140 },
    ].filter((d) => d.date),
    knee_pain_7d: [
      { date: dayInWeek(1), knee_pain: 0 },
      { date: dayInWeek(2), knee_pain: 1 },
      { date: dayInWeek(3), knee_pain: 0 },
      { date: dayInWeek(4), knee_pain: 1 },
    ].filter((d) => d.date),
    cardio_manual_14d: [{ date: dayInWeek(3), minutes: 30, segments: [30], type: 'walk' }].filter((d) => d.date),
    body: { latest_waist_cm: 78.0, waist_weeks: [] },
    cycle_baseline: { weight_kg: 70.0, body_fat_pct: 20.0, skeletal_muscle_kg: 30.0, waist_cm: 78.0 },
    strength_last_date: addDays(TODAY, -1),
    exercise_history: {
      goblet_box_squat: { date: addDays(TODAY, -2), weight_kg: 8, reps: 10, rpe: 7, next_weight_kg: 9, next_hint: '下次 +1 kg，回到 8 次' },
      glute_bridge: { date: addDays(TODAY, -2), weight_kg: 10, reps: 12, rpe: 7, next_weight_kg: 11, next_hint: '下次 +1 kg' },
      calf_raise: { date: addDays(TODAY, -2), weight_kg: 6, reps: 12, rpe: 8, next_weight_kg: 7, next_hint: '下次 +1 kg' },
      dead_bug: { date: addDays(TODAY, -2), weight_kg: 0, reps: 8, rpe: 6, next_weight_kg: null, next_hint: '每组加 2 次' },
      dumbbell_floor_press: { date: addDays(TODAY, -1), weight_kg: 7, reps: 11, rpe: 8, next_weight_kg: 7, next_hint: '维持重量，把次数做到 12' },
      one_arm_dumbbell_row: { date: addDays(TODAY, -1), weight_kg: 8, reps: 12, rpe: 7, next_weight_kg: 9, next_hint: '下次 +1 kg' },
      seated_dumbbell_shoulder_press: { date: addDays(TODAY, -1), weight_kg: 4, reps: 10, rpe: 8, next_weight_kg: 4, next_hint: '先把次数做到 12' },
      lateral_raise: { date: addDays(TODAY, -1), weight_kg: 2, reps: 12, rpe: 7, next_weight_kg: 3, next_hint: '下次 +1 kg' },
      dumbbell_biceps_curl: { date: addDays(TODAY, -4), weight_kg: 4, reps: 12, rpe: 7, next_weight_kg: 5, next_hint: '下次 +1 kg' },
      bent_over_fly: { date: addDays(TODAY, -4), weight_kg: 2, reps: 12, rpe: 8, next_weight_kg: 2, next_hint: '先稳住动作，不加重量' },
      romanian_deadlift: { date: addDays(TODAY, -4), weight_kg: 8, reps: 10, rpe: 7, next_weight_kg: 9, next_hint: '下次 +1 kg' },
      split_squat: { date: addDays(TODAY, -4), weight_kg: 0, reps: 12, rpe: 6, next_weight_kg: null, next_hint: '稳了加 2×4 kg' },
      plank: { date: addDays(TODAY, -4), weight_kg: 0, reps: 0, hold_s: 30, rpe: 6, next_weight_kg: null, next_hint: '下次 +10 秒' },
    },
    targets: {
      strength_sessions: 3, cardio_minutes: 90, cardio_minutes_max: 150,
      target_kcal: 2200, protein_g_per_kg: 1.8, target_protein_g: 126,
      ref_weight_kg: 70.0, knee_pain_baseline: 0,
    },
  },
  routine: {
    version: 1,
    effective_from: addDays(WEEK_START, 7),
    rotation: { mode: 'four_week', anchor: WEEK_START, strength_slots: [1, 3, 5], weeks: [[1, 3, 5], [3, 1, 3], [5, 3, 1], [3, 5, 3]] },
    days: [
      {
        weekday: 1, type: 'strength', title: '下肢 A · 蹲主导', duration_min: 50,
        focus: '动作稳、节奏慢', hevy_routine_id: '下肢A 蹲', warmup_min: 8,
        warmup: '原地踏步 3 min → 髋绕环、膝踝活动各 10 次 → 空手箱蹲 2×10',
        exercises: [
          { key: 'goblet_box_squat', name: '箱式高脚杯深蹲', sets: 3, rep_min: 8, rep_max: 12, weight_kg: 8, load: 'single', rest_s: 120, rpe_min: 6, rpe_cap: 7, cue: '坐到椅子即起，膝盖对准脚尖' },
          { key: 'glute_bridge', name: '臀桥', sets: 3, rep_min: 8, rep_max: 12, weight_kg: 10, load: 'single', rest_s: 90, rpe_min: 7, rpe_cap: 7, cue: '顶髋停 1 秒，不要用腰代偿' },
          { key: 'calf_raise', name: '提踵', sets: 3, rep_min: 8, rep_max: 12, weight_kg: 6, load: 'pair', rest_s: 60, rpe_min: 7, rpe_cap: 8, cue: '慢下 3 秒，全幅度' },
          { key: 'dead_bug', name: '死虫', sets: 3, rep_min: 8, rep_max: 8, weight_kg: 0, load: 'bodyweight', per_side: true, rest_s: 60, rpe_min: 6, rpe_cap: 6, cue: '腰贴地，动作慢' },
        ],
      },
      { weekday: 2, type: 'cardio', title: '有氧 · 快走', duration_min: 30, focus: '心率 110–130 bpm', mode: 'walk', segments_min: [30], hr_zone: [110, 130] },
      {
        weekday: 3, type: 'strength', title: '上肢 · 推 + 拉', duration_min: 55,
        focus: '肩胛先收再推/拉', hevy_routine_id: '上肢 推拉', warmup_min: 8,
        warmup: '肩绕环、肩胛激活各 10 次 → 最轻重量卧推 2×10',
        exercises: [
          { key: 'dumbbell_floor_press', name: '地面哑铃卧推', sets: 3, rep_min: 8, rep_max: 12, weight_kg: 7, load: 'pair', rest_s: 120, rpe_min: 6, rpe_cap: 7, cue: '躺地屈膝，肘约 45°' },
          { key: 'one_arm_dumbbell_row', name: '单臂哑铃划船', sets: 3, rep_min: 8, rep_max: 12, per_side: true, weight_kg: 8, load: 'single', rest_s: 90, rpe_min: 6, rpe_cap: 7, cue: '肩胛先收再拉' },
          { key: 'seated_dumbbell_shoulder_press', name: '坐姿哑铃推举', sets: 3, rep_min: 8, rep_max: 12, weight_kg: 4, load: 'pair', rest_s: 120, rpe_min: 6, rpe_cap: 7, cue: '背靠椅背，不塌腰' },
          { key: 'lateral_raise', name: '侧平举', sets: 3, rep_min: 8, rep_max: 12, weight_kg: 2, load: 'pair', rest_s: 60, rpe_min: 7, rpe_cap: 7, cue: '小重量，肘微屈，不甩' },
        ],
      },
      { weekday: 4, type: 'rest', title: '休息', duration_min: null, focus: '观察右肩反应', note: '观察右肩反应，不做额外训练' },
      {
        weekday: 5, type: 'strength', title: '下肢 B · 髋主导', duration_min: 50,
        focus: '髋铰链找臀部发力', hevy_routine_id: '下肢B 髋', warmup_min: 8, warmup: '髋铰链练习 2×10',
        exercises: [
          { key: 'romanian_deadlift', name: '罗马尼亚硬拉', sets: 3, rep_min: 8, rep_max: 12, weight_kg: 8, load: 'pair', rest_s: 150, rpe_min: 6, rpe_cap: 7, cue: '髋铰链，背中立' },
          { key: 'split_squat', name: '静态分腿蹲', sets: 3, rep_min: 8, rep_max: 12, per_side: true, weight_kg: 0, load: 'bodyweight', weight_note: '稳了加 2×4 kg', rest_s: 120, rpe_min: 6, rpe_cap: 6, cue: '身体垂直下沉' },
          { key: 'plank', name: '平板支撑', sets: 3, hold_s: 30, weight_kg: 0, load: 'bodyweight', rest_s: 60, rpe_min: 6, rpe_cap: 6, cue: '臀不塌，呼吸不憋' },
        ],
      },
      { weekday: 6, type: 'cardio', title: '有氧 · 快走', duration_min: 70, focus: '两段各 30 分钟，中间休息 10 分钟', mode: 'walk', segments_min: [30, 30], segment_rest_min: 10, hr_zone: [110, 130] },
      { weekday: 7, type: 'rest', title: '完全休息', duration_min: null, focus: '睡够 7.5 h', note: '完全休息，睡够 7.5 h' },
    ],
  },
  reviewIndex: {
    generated_at: new Date().toISOString(),
    latest: 'week-demo-W45.md',
    reviews: [
      { file: 'week-demo-W45.md', kind: 'week', week_start: WEEK_START, week_end: addDays(WEEK_START, 6), filled: true, missing: [] },
      { file: 'cycle-demo.md', kind: 'cycle', week_start: WEEK_START, week_end: addDays(WEEK_START, 27), filled: false, missing: ['3'] },
    ],
  },
  reviews: {
    'week-demo-W45.md': DEMO_REVIEW,
    'cycle-demo.md': '# 第 1 期周期报告（演示）\n\n## 1. 验收表\n\n| 指标 | 起点 | 目标 | 实际 | 达成与否 |\n|---|---|---|---|---|\n| 体重 | 70.0 kg | 68.5–69.0 kg | 无数据 | 无数据 |\n',
  },
  daily: DEMO_HISTORY.daily,
  diet: DEMO_HISTORY.diet,
  checkin: DEMO_HISTORY.checkin,
  strength: [],
  body: [],
  loadedAt: new Date().toISOString(),
};
