// @ts-check
/** 动作剂量展示：次数区间、计时动作、每侧标记。 */

/** @param {any} ex */
export function repRange(ex) {
  if (ex?.hold_s != null) return `${ex.hold_s} 秒`;
  if (ex?.rep_min == null) return '—';
  if (ex.rep_max == null || ex.rep_min === ex.rep_max) return `${ex.rep_min}`;
  return `${ex.rep_min}–${ex.rep_max}`;
}

/** 列表简短剂量：3×8、3×8–12、3×30 秒，带 /侧。 */
export function repDose(ex) {
  if (ex?.hold_s != null) return `${ex.sets}×${ex.hold_s} 秒${ex.per_side ? '/侧' : ''}`;
  if (ex?.rep_min == null) return '';
  return `${ex.sets}×${repRange(ex)}${ex.per_side ? '/侧' : ''}`;
}

/** 详情 chip：8 次 / 30 秒。 */
export function repQuantity(ex) {
  if (ex?.hold_s != null) return `${ex.hold_s} 秒`;
  if (ex?.rep_min == null) return '';
  return `${repRange(ex)} 次`;
}

/** 计划处方：3 组 × 8 次 / 3 组 × 30 秒。 */
export function planDose(ex) {
  if (ex?.hold_s != null) return `${ex.sets} 组 × ${ex.hold_s} 秒`;
  if (ex?.rep_min == null) return '';
  return `${ex.sets} 组 × ${repRange(ex)} 次`;
}
