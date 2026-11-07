// @ts-check
/** 表单字段校验：纯函数，规则与 scripts/log_*.py + config.json limits 对齐。
 *
 * 后端（Actions）仍然是最终防线；这里只是提前拦住明显非法的值，
 * 避免派发一次注定失败的工作流。
 */
import { todayISO } from './data.js';

/**
 * @typedef {{kind:'int', min:number, max:number}} IntRule
 * @typedef {{kind:'number', min?:number, max?:number, exclusiveMin?:boolean}} NumberRule
 * @typedef {{kind:'date'}} DateRule
 * @typedef {IntRule|NumberRule|DateRule} FieldRule
 */

/** @param {number} min @param {number} max @returns {IntRule} */
export function intRule(min, max) { return { kind: 'int', min, max }; }

/**
 * @param {{min?:number, max?:number, exclusiveMin?:boolean}} [opts]
 * @returns {NumberRule}
 */
export function numberRule(opts = {}) { return { kind: 'number', ...opts }; }

/** @returns {DateRule} */
export function dateRule() { return { kind: 'date' }; }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 校验单个字段；通过返回 null，否则返回中文错误。
 * 空字符串视为“未填写”，由 required 检查负责。
 * @param {FieldRule|undefined} rule
 * @param {string} raw
 * @param {string} label
 * @param {string} [today]
 * @returns {string|null}
 */
export function validateField(rule, raw, label, today = todayISO()) {
  if (!rule) return null;
  const value = String(raw ?? '').trim();
  if (value === '') return null;

  if (rule.kind === 'date') {
    if (!ISO_DATE.test(value)) return `${label} 格式不对，应为 YYYY-MM-DD`;
    const parsed = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(parsed)) return `${label} 不是有效日期`;
    // 2026-02-31 这类日期会被 Date.parse 自动进位，必须回写比对
    if (new Date(parsed).toISOString().slice(0, 10) !== value) return `${label} 不是有效日期`;
    if (value > today) return `${label} 不能晚于今天`;
    return null;
  }

  const num = Number(value);
  if (!Number.isFinite(num)) return `${label} 要填数字`;

  if (rule.kind === 'int') {
    if (!Number.isInteger(num)) return `${label} 要填整数`;
    if (num < rule.min || num > rule.max) return `${label} 要在 ${rule.min}–${rule.max} 之间`;
    return null;
  }

  if (rule.exclusiveMin && !(num > (rule.min ?? 0))) {
    return `${label} 要大于 ${rule.min ?? 0}`;
  }
  if (!rule.exclusiveMin && rule.min != null && num < rule.min) {
    return `${label} 不能小于 ${rule.min}`;
  }
  if (rule.max != null && num > rule.max) return `${label} 不能大于 ${rule.max}`;
  return null;
}

/**
 * 按字段定义批量校验；返回第一条错误。
 * @param {{name:string, label:string, rule?:FieldRule}[]} fields
 * @param {Record<string,string>} values
 * @param {string} [today]
 * @returns {string|null}
 */
export function validateValues(fields, values, today = todayISO()) {
  for (const field of fields) {
    const problem = validateField(field.rule, values[field.name] ?? '', field.label, today);
    if (problem) return problem;
  }
  return null;
}

/**
 * 多个字段至少填一个（例如身体指标不能只提交日期）。
 * @param {Record<string,string>} values
 * @param {string[]} names
 * @param {string} message
 * @returns {string|null}
 */
export function requireAny(values, names, message) {
  const filled = names.some((name) => String(values[name] ?? '').trim() !== '');
  return filled ? null : message;
}
