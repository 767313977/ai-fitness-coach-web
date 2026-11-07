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

/**
 * 找一个动作对应的插图：课表按 plan key，动作库按数据集 id，最后按英文名兜底。
 * 名称兜底是为了精选条目（id 形如 push_up）也能命中完整库的数据集 id（0662）。
 * @param {Record<string, any>} index
 * @param {{key?: string, name?: string}|null} ex
 * @param {{id?: string, name?: string}|null} item
 */
export function findIllustration(index, ex, item) {
  if (!index) return null;
  if (ex?.key && index[ex.key]) return index[ex.key];
  if (item?.id && index[item.id]) return index[item.id];
  const name = String(item?.name ?? '').toLowerCase().trim();
  if (!name) return null;
  for (const entry of Object.values(index)) {
    if (String(entry?.library_name ?? '').toLowerCase().trim() === name) return entry;
  }
  return null;
}
