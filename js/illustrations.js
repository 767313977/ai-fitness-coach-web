// @ts-check
/** 动作插图索引：只在打开动作详情时才加载；失败就当没有插图。 */
const URL_INDEX = './data/illustrations/index.json';

/** @type {Record<string, any>|null} */
let memo = null;

export async function loadIllustrationIndex() {
  if (memo) return memo;
  try {
    const res = await fetch(URL_INDEX, { cache: 'no-cache' });
    if (!res.ok) {
      memo = {};
      return memo;
    }
    const data = await res.json();
    memo = data && typeof data === 'object' ? data : {};
  } catch {
    memo = {};
  }
  return memo;
}
