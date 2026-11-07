// @ts-check
/** 连接状态文案：限流分级 + 离线缓存。纯函数，方便单测。 */

/** @type {Record<string, string>} */
const RATE_LIMIT_TEXT = {
  primary: 'GitHub API 配额用尽（每小时 5000 次），通常 1 小时内恢复；期间可以先看缓存数据。',
  secondary: 'GitHub 触发了二级限流（短时间请求过多），请等 1–2 分钟再试。',
  unknown: 'GitHub 暂时拒绝了请求，可能是限流，请稍后再试。',
};

/**
 * @param {'primary'|'secondary'|'unknown'|null|undefined} kind
 * @returns {string}
 */
export function rateLimitText(kind) {
  return RATE_LIMIT_TEXT[kind ?? 'unknown'] ?? RATE_LIMIT_TEXT.unknown;
}

/**
 * 离线提示：带上缓存时间，避免用户以为看到的是最新数据。
 * @param {string|null|undefined} offlineAt 上次成功读取的时间（ISO）
 * @param {number} [now]
 * @returns {string}
 */
export function offlineText(offlineAt, now = Date.now()) {
  if (!offlineAt) return '离线 · 显示的是本地缓存数据，联网后点「重试」刷新。';
  const minutes = Math.max(0, Math.round((now - new Date(offlineAt).getTime()) / 60_000));
  const when = minutes < 1
    ? '不到 1 分钟前'
    : minutes < 60
      ? `${minutes} 分钟前`
      : `${Math.round(minutes / 60)} 小时前`;
  return `离线 · 使用缓存数据（上次成功：${when}）`;
}

/**
 * 把错误映射成常驻提示；普通权限错误不在这里处理（交给页面错误态）。
 * @param {any} error
 * @returns {{kind: 'rate-limit'|'offline', text: string}|null}
 */
export function noticeFromError(error) {
  if (!error) return null;
  if (error.rateLimited) {
    return { kind: 'rate-limit', text: rateLimitText(error.rateLimitKind) };
  }
  if (error.status === 0) {
    return {
      kind: 'offline',
      text: '连不上 GitHub · 检查网络后点「重试」；当前可能显示缓存数据。',
    };
  }
  return null;
}
