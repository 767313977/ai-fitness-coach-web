// @ts-check
/** DOM 小工具、图标、toast、Markdown 渲染、SVG 图表。 */

/**
 * 创建元素。
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {...any} children
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'for') el.htmlFor = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in el && typeof value !== 'object') {
      // @ts-ignore 动态属性
      el[key] = value;
    } else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

/** @param {Element} el @param {any[]} children */
function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

/** @param {Node} node */
export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/** @param {string} name */
export function icon(name, size = 20) {
  const paths = ICONS[name] || '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = paths;
  return svg;
}

const ICONS = {
  today: '<rect x="3" y="5" width="18" height="16" rx="4"/><path d="M8 3v4M16 3v4M3 10h18"/><circle cx="12" cy="15" r="2.4"/>',
  week: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l3-4 3 3 4-6"/>',
  review: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v5h5"/><path d="M9 13h7M9 17h5"/>',
  record: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.64a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9c.14.6.6 1.09 1.2 1.3H21a2 2 0 1 1 0 4h-.09c-.6.21-1.06.7-1.2 1.3z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  alert: '<path d="M12 3l9 16H3z"/><path d="M12 9v4M12 16.5v.01"/>',
  upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  library: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20"/><path d="M9 7h6"/>',
};

/** @param {string} message @param {number} [ms] */
export function toast(message, ms = 2600) {  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.hidden = true; }, ms);
}
toast._timer = 0;

/** 通用提示条 @param {string} text @param {'warn'|'err'|'info'} [kind] */
export function banner(text, kind = 'warn') {
  const cls = kind === 'info' ? 'info' : kind === 'err' ? 'err' : '';
  return h('div', { class: `banner ${cls}` }, icon(kind === 'info' ? 'link' : 'alert', 18),
    h('div', { class: 'grow' }, text));
}

/** 把 Markdown 渲染成 HTML（内容来自自己的私有仓库，仍然先转义再格式化）。 */
export function markdown(src) {
  if (!src) return '';
  let text = String(src).replace(/\r\n/g, '\n');
  // 去掉 <!-- AUTO:... --> 之类的注释
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  /** @type {string[]} */
  const codeBlocks = [];
  text = text.replace(/```([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/^\n/, ''))}</code></pre>`);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  const lines = text.split('\n');
  /** @type {string[]} */
  const out = [];
  let inTable = false;
  /** @type {string[]} */
  let tableRows = [];
  let listType = '';

  const closeTable = () => {
    if (!inTable) return;
    inTable = false;
    out.push(renderTable(tableRows));
    tableRows = [];
  };
  const closeList = () => {
    if (!listType) return;
    out.push(`</${listType}>`);
    listType = '';
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\u0000CODE\d+\u0000$/.test(line)) {
      closeTable(); closeList();
      out.push(codeBlocks[Number(line.replace(/\u0000CODE|(\u0000)/g, ''))]);
      continue;
    }
    if (!line.trim()) { closeTable(); closeList(); continue; }

    if (line.startsWith('|')) { inTable = true; tableRows.push(line); continue; }
    if (inTable) closeTable();

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr>'); continue; }
    if (/^>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }

    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    if (ol) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeTable(); closeList();
  return out.join('\n');
}

/** @param {string[]} rows */
function renderTable(rows) {
  if (rows.length < 2) return '';
  const cells = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map((r) => cells(r));
  const thead = `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

/** @param {string} text */
function inline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/** @param {string} text */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 年度热力图（GitHub 贡献图样式）。
 * @param {{date: string, value: number}[]} entries
 * @param {{weeks?: number}} [opts]
 */
export function heatmap(entries, opts = {}) {
  const weeks = opts.weeks ?? 26;
  const map = new Map(entries.map((e) => [e.date, e.value]));
  const today = new Date();
  const dow = (today.getDay() + 6) % 7; // 周一 = 0
  const end = new Date(today);
  const start = new Date(today);
  start.setDate(start.getDate() - dow - (weeks - 1) * 7);

  /** @type {string[]} */
  const cells = [];
  const cursor = new Date(start);
  const total = weeks * 7;
  for (let i = 0; i < total; i += 1) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    const v = map.get(iso) ?? 0;
    const level = v <= 0 ? '' : v === 1 ? 'l1' : v === 2 ? 'l2' : v === 3 ? 'l3' : 'l4';
    const future = cursor > end;
    cells.push(`<div class="cell ${future ? 'out' : level}" title="${iso}${v ? ` · ${v} 项记录` : ''}"></div>`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return `<div class="heat">${cells.join('')}</div>
    <div class="heat-legend"><span>少</span>
      <span class="cell" style="display:inline-block"></span>
      <span class="cell l1" style="display:inline-block"></span>
      <span class="cell l2" style="display:inline-block"></span>
      <span class="cell l3" style="display:inline-block"></span>
      <span class="cell l4" style="display:inline-block"></span>
      <span>多</span></div>`;
}

/**
 * 折线图（体重/膝痛这类）。
 * @param {{label: string, value: number|null}[]} points
 * @param {{height?: number, unit?: string, redline?: number|null,
 *          yMin?: number, yMax?: number, yPad?: number}} [opts]
 */
export function lineChart(points, opts = {}) {
  const data = points.filter((p) => p.value !== null && Number.isFinite(p.value));
  if (data.length < 2) return emptyChart('数据还不够画线');
  const W = 320; const H = opts.height ?? 130;
  const padL = 42; const padR = 30; const padT = 14; const padB = 22;
  const values = data.map((p) => Number(p.value));
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const pad = opts.yPad ?? 0;
  let min = opts.yMin != null ? opts.yMin : dataMin - pad;
  let max = opts.yMax != null ? opts.yMax : dataMax + pad;
  // 固定范围也要把数据包住（例如红线固定 4 分，但数据到了 6 分）
  if (dataMax > max) max = dataMax + Math.max(pad, (dataMax - dataMin) * 0.1);
  if (dataMin < min) min = Math.max(0, dataMin - Math.max(pad, (dataMax - dataMin) * 0.1));
  if (max <= min) max = min + 1;
  const span = max - min;
  const y = (v) => H - padB - ((v - min) / span) * (H - padT - padB);
  const x = (i) => padL + (i / (data.length - 1)) * (W - padL - padR);

  const path = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(Number(p.value)).toFixed(1)}`).join(' ');
  const area = `${path} L${x(data.length - 1).toFixed(1)},${H - padB} L${padL},${H - padB} Z`;
  const gridLines = [0, 0.5, 1].map((t) => {
    const gy = padT + t * (H - padT - padB);
    return `<line class="grid" x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}"/>`;
  }).join('');
  const dots = data.map((p, i) => `<circle class="point" cx="${x(i).toFixed(1)}" cy="${y(Number(p.value)).toFixed(1)}" r="2.6"/>`).join('');
  const labels = data.map((p, i) => {
    const anchor = i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle';
    return `<text class="axis" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${escapeHtml(p.label)}</text>`;
  }).join('');
  const red = opts.redline != null && opts.redline >= min && opts.redline <= max
    ? `<line class="redline" x1="${padL}" y1="${y(opts.redline).toFixed(1)}" x2="${W - padR}" y2="${y(opts.redline).toFixed(1)}"/>
       <text class="axis" x="${W - padR - 2}" y="${(y(opts.redline) - 4).toFixed(1)}" text-anchor="end">红线 ${opts.redline}${opts.unit ?? ''}</text>`
    : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="趋势图">
    ${gridLines}${red}
    <path class="area" d="${area}"/><path class="line" d="${path}"/>${dots}${labels}
    <text class="axis" x="${padL - 6}" y="${padT + 4}" text-anchor="end">${escapeHtml(fmtAxis(max))}</text>
    <text class="axis" x="${padL - 6}" y="${H - padB}" text-anchor="end" opacity=".7">${escapeHtml(fmtAxis(min))}</text>
  </svg>`;
}

/**
 * 柱状图（每日热量）。
 * @param {{label: string, value: number|null}[]} points
 * @param {{target?: number|null, height?: number}} [opts]
 */
export function barChart(points, opts = {}) {
  const data = points.filter((p) => p.value !== null && Number.isFinite(p.value));
  if (!data.length) return emptyChart('这周还没有记录');
  const W = 320; const H = opts.height ?? 130;
  const padL = 34; const padR = 12; const padT = 14; const padB = 22;
  const base = H - padB;
  const maxVal = Math.max(...data.map((p) => Number(p.value)), (opts.target ?? 0) * 1.1);
  const barW = Math.max(6, (W - padL - padR) / data.length * 0.6);
  const gap = (W - padL - padR) / data.length;
  const bars = data.map((p, i) => {
    const v = Number(p.value);
    const bh = Math.max(2, (v / maxVal) * (H - padT - padB));
    const over = opts.target != null && v > opts.target * 1.1;
    const cx = padL + gap * i + gap / 2;
    const anchor = i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle';
    return `<rect class="cbar${over ? ' over' : ''}" x="${(cx - barW / 2).toFixed(1)}" y="${(base - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3"/>
      <text class="axis" x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${escapeHtml(p.label)}</text>`;
  }).join('');
  const targetLine = opts.target != null
    ? `<line class="redline" x1="${padL}" y1="${(base - (opts.target / maxVal) * (H - padT - padB)).toFixed(1)}" x2="${W - padR}" y2="${(base - (opts.target / maxVal) * (H - padT - padB)).toFixed(1)}"/>`
    : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="柱状图">
    <line class="grid" x1="${padL}" y1="${base}" x2="${W - padR}" y2="${base}"/>
    ${targetLine}${bars}
  </svg>`;
}

/** @param {string} message */
function emptyChart(message) {
  return `<div class="empty" style="padding:18px 0"><div class="big">${escapeHtml(message)}</div></div>`;
}

function fmtAxis(v) {
  if (Math.abs(v) >= 1000) return `${Math.round(v / 100) / 10}k`;
  return String(Math.round(v * 10) / 10);
}
