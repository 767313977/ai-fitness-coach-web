// @ts-check
/** Hevy CSV 上传前的本地校验：大小、扩展名、类型、表头。纯函数，方便单测。 */

/** 2 MB：正常 Hevy 导出远小于这个值，超过多半是选错文件。 */
export const MAX_CSV_BYTES = 2 * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  '',
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
]);

const EXERCISE_COLUMNS = ['exercise_title', 'exercise', '动作'];
const DATE_COLUMNS = ['start_time', 'date', '日期', '开始时间'];

/**
 * @param {{name?: string, size?: number, type?: string}|null|undefined} file
 * @returns {string|null} 错误文案；null 表示通过
 */
export function validateFileMeta(file) {
  if (!file) return '没有选择 CSV 文件';
  const name = String(file.name || '');
  if (!/\.csv$/i.test(name)) return '只支持 Hevy 导出的 .csv 文件';
  const size = Number(file.size);
  if (Number.isFinite(size) && size > MAX_CSV_BYTES) {
    return `文件太大（${(size / 1024 / 1024).toFixed(1)} MB），上限 2 MB；请在 Hevy 里按时间范围分几次导出`;
  }
  const type = String(file.type || '').toLowerCase();
  if (!ALLOWED_TYPES.has(type)) return `文件类型不像 CSV（${file.type}）`;
  return null;
}

/** @param {string} headerLine @returns {string|null} */
export function validateHeader(headerLine) {
  const cols = String(headerLine || '')
    .replace(/^\uFEFF/, '')
    .split(',')
    .map((cell) => cell.trim().replace(/^"|"$/g, '').toLowerCase())
    .filter(Boolean);
  if (!cols.length) return 'CSV 是空的，连表头都没有';
  const hasExercise = EXERCISE_COLUMNS.some((name) => cols.includes(name));
  const hasDate = DATE_COLUMNS.some((name) => cols.includes(name));
  if (!hasExercise || !hasDate) {
    return 'CSV 表头不对：需要 Hevy 导出的 workouts.csv（至少包含练习名和开始时间两列）';
  }
  return null;
}

/**
 * 读取文件前 4 KB 校验表头；不把整个文件读进内存。
 * @param {Blob & {name?: string, size?: number, type?: string}} file
 * @returns {Promise<string|null>}
 */
export async function validateFile(file) {
  const metaError = validateFileMeta(file);
  if (metaError) return metaError;
  if (typeof file.slice !== 'function') return null;
  const head = await file.slice(0, 4096).text();
  return validateHeader(head.split(/\r?\n/)[0]);
}
