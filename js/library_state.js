// @ts-check
/** 动作库页面的纯状态逻辑：与 DOM 无关，方便直接跑单元测试。
 *
 * 抽出来的原因：精选动作库（data/exercises.json）加载失败时页面要降级成
 * 「只看本计划动作」，恢复后还要把当时选中的空条目换成真实条目。这两段逻辑
 * 之前在 DOM 闭包里，没法自动测试，2026-11 的验证就漏掉了「重试后详情仍是空条目」。
 */

/**
 * 从课表里收集去重后的力量动作，顺序按课表出现顺序。
 * 不依赖精选数据集，所以数据集 404 时也能先渲染这一块。
 * @param {any} routine
 * @returns {any[]}
 */
export function collectPlanEntries(routine) {
  const seen = new Set();
  const out = [];
  for (const day of routine?.days ?? []) {
    for (const ex of day?.exercises ?? []) {
      if (!ex?.key || seen.has(ex.key)) continue;
      seen.add(ex.key);
      out.push(ex);
    }
  }
  return out;
}

/**
 * 精选库恢复后，把降级期间选中的「只有课表处方、没有说明条目」的动作补上条目。
 * 已经有条目、或数据集里仍没有这个动作时，保持原样。
 * @param {{item?: any, ex?: any, loading?: boolean, error?: string}|null} selected
 * @param {Map<string, any>} planMap
 * @returns {any}
 */
export function reconcileSelection(selected, planMap) {
  if (!selected?.ex || selected.item) return selected;
  const item = planMap?.get(selected.ex.key) ?? null;
  if (!item) return selected;
  return { ...selected, item };
}
