// triage — the stats page (plan §15). Reads /api/reports/* over one window
// and draws each report as a chart with its table beside it. No build, no
// chart library: the marks are SVG built here, in the list page's tokens.
//
// Two series colours, ever — teal for the far end and the machine, copper
// for you — because those are what the list page already means by them and
// they pass the palette checks in both themes as a pair. Anything else is
// one hue light to dark (the heatmaps), or gray as the context a highlighted
// series sits against (verdicts under interrupts, closures resolved
// elsewhere under the ones you closed).
/** querySelector, short. */
const $ = (s, el = document) => el.querySelector(s);
/** An HTML element with a class and text. */
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const svgNS = 'http://www.w3.org/2000/svg';
/** An SVG element with attributes; a null attribute is left off. */
const sv = (tag, attrs = {}, text) => { const e = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
/** A token's current value, so the marks follow the theme. */
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** The chart colours, read from the tokens at draw time. */
const C = () => ({ teal: css('--teal'), copper: css('--copper'), crimson: css('--crimson'), gray: css('--ink-4'), ink: css('--ink-3'), surface: css('--surface') });
const DAY = 86_400_000;
/** A count for an axis or a tile: compact past ten thousand. */
const fmtN = (n) => (n == null ? '—' : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n * 100) / 100));
/** A duration in hours as minutes, hours or days. */
const hours = (h) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24 * 10) / 10} d`);

// --- state -----------------------------------------------------------------
const state = { days: 30, bucket: '', whereBy: 'repo', whenSource: '' };
try {
  const u = new URLSearchParams(location.search);
  state.days = parseInt(u.get('days') || localStorage.getItem('triage.stats.days') || '30', 10) || 30;
  state.bucket = u.get('bucket') || '';
  state.whereBy = u.get('by') || localStorage.getItem('triage.stats.by') || 'repo';
  state.whenSource = u.get('source') || '';
} catch {}
/** The bucket for a window: the one asked for, else the hour, the day or the week by its length. */
const bucketFor = (days) => state.bucket || (days <= 3 ? 'hour' : days <= 120 ? 'day' : 'week');
/** The window the page is looking at, as the API takes it. */
function window_() {
  const until = new Date();
  const since = new Date(until.getTime() - state.days * DAY);
  return { since: since.toISOString(), until: until.toISOString(), bucket: bucketFor(state.days) };
}
/** Keep the controls in the URL and in local storage, so a reload and a shared link both land on the same view. */
function remember() {
  try { localStorage.setItem('triage.stats.days', String(state.days)); localStorage.setItem('triage.stats.by', state.whereBy); } catch {}
  const u = new URL(location.href);
  u.searchParams.set('days', String(state.days));
  if (state.bucket) u.searchParams.set('bucket', state.bucket); else u.searchParams.delete('bucket');
  if (state.whereBy !== 'repo') u.searchParams.set('by', state.whereBy); else u.searchParams.delete('by');
  if (state.whenSource) u.searchParams.set('source', state.whenSource); else u.searchParams.delete('source');
  history.replaceState(null, '', u);
}

// --- the shared tooltip ------------------------------------------------------
const tip = $('#tip');
/** Show the one tooltip near a point: a title and a row per series, the value first. */
function showTip(x, y, title, rows) {
  tip.replaceChildren();
  tip.append(el('b', null, title));
  for (const [label, value, color] of rows) {
    const r = el('div', 'row');
    const k = el('span', 'k');
    if (color) { const i = el('i'); i.style.setProperty('--sw', color); k.append(i); }
    k.append(label);
    r.append(el('span', null, String(value)), k);
    tip.append(r);
  }
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.min(x + 14, innerWidth - w - 8)}px`;
  tip.style.top = `${y - h - 12 < 8 ? y + 16 : y - h - 12}px`;
}
/** Hide the tooltip. */
const hideTip = () => { tip.hidden = true; };

// --- pieces ------------------------------------------------------------------
/** A legend row: a swatch and a label per series. Present for two or more series, always. */
function legend(items) {
  const l = el('div', 'legend');
  for (const [label, color, kind] of items) { const s = el('span', kind || '', label); s.style.setProperty('--sw', color); l.append(s); }
  return l;
}
/** The chart's table, folded under a summary: every number reachable without a pointer. */
function table(head, rows) {
  const d = el('details');
  d.append(el('summary', null, 'the numbers'));
  const wrap = el('div', 'tablewrap');
  const t = el('table');
  const tr = el('tr'); for (const h of head) tr.append(el('th', null, h)); t.append(tr);
  for (const r of rows) { const tr = el('tr'); for (const c of r) tr.append(el('td', null, c == null ? '—' : String(c))); t.append(tr); }
  wrap.append(t); d.append(wrap);
  return d;
}
/** A figure caption: a title, a note on the right and, when the figure is
 *  drawn from one report, a link to that report's JSON for this window —
 *  the chart is a picture of the data; the data is one click away. */
function caption(title, note, report = null, params = {}) {
  const c = el('figcaption'); c.append(el('b', null, title));
  const right = el('span', 'note');
  if (note) right.append(note);
  if (report) { const a = el('a', 'json', 'json'); a.href = reportUrl(report, params); a.target = '_blank'; a.rel = 'noopener'; a.title = `this report, as JSON, for this window`; right.append(note ? ' · ' : '', a); }
  c.append(right);
  return c;
}
/** The API URL for one report over the page's window. */
function reportUrl(name, params = {}) {
  const w = window_();
  return `/api/reports/${name}?${new URLSearchParams({ since: w.since, until: w.until, bucket: w.bucket, ...params })}`;
}
/** Every report for the window, as one JSON file the browser saves —
 *  the export. The same four answers the page just drew, unchanged. */
async function exportWindow() {
  const w = window_();
  const names = ['flow', 'when', 'where', 'response'];
  const params = { when: state.whenSource ? { source: state.whenSource } : {}, where: { by: state.whereBy } };
  const reports = await Promise.all(names.map((n) => fetchReport(n, params[n] || {})));
  const body = { exported: new Date().toISOString(), since: w.since, until: w.until, bucket: w.bucket, reports: Object.fromEntries(names.map((n, i) => [n, reports[i]])) };
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = `triage-reports-${w.since.slice(0, 10)}-${w.until.slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
/** A bucket key as an axis label: `09-12` for a day, `12 14h` for an hour,
 *  `wk 09-07` for a week. */
function label(key, bucket) {
  if (bucket === 'hour') return `${key.slice(8, 10)} ${key.slice(11)}h`;
  if (bucket === 'week') return `wk ${key.slice(5)}`;
  return key.slice(5);
}
/** A round axis maximum at or above `max`. */
function nice(max) {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}
/** The drawing width of a figure, from its box on the page. */
const width = (fig) => Math.max(280, fig.clientWidth - 30);

/** Columns per bucket: `up` series stacked above the baseline, `down`
 *  series stacked below it (arrivals over closures, the created-versus-
 *  resolved shape). Each series is { key, label, color, values, ghost? }.
 *  One tooltip lists every series at the hovered bucket; the whole column
 *  is the hit target. */
function columns(fig, { keys, bucket, up = [], down = [], height = 190, labelEvery = null, yLabel = null }) {
  const W = width(fig), padL = 34, padR = 8, padT = 14, padB = 22;
  const iw = W - padL - padR, ih = height - padT - padB;
  const n = keys.length;
  const sumUp = keys.map((_, i) => up.reduce((a, s) => a + (s.values[i] || 0), 0));
  const sumDown = keys.map((_, i) => down.reduce((a, s) => a + (s.values[i] || 0), 0));
  // One scale for both halves: an arrival and a closure are both one item,
  // and a second scale below the line would be a dual axis lying down.
  const scale = nice(Math.max(1, ...sumUp, ...sumDown));
  const maxUp = scale, maxDown = down.length ? scale : 0;
  const total = maxUp + maxDown;
  const zero = padT + ih * (maxUp / total);
  const y = (v) => ih * (v / total);
  const slot = iw / n, bw = Math.min(24, Math.max(2, slot - Math.max(2, slot * 0.35)));
  const x = (i) => padL + slot * i + (slot - bw) / 2;
  const svg = sv('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img' });
  const grid = sv('g', { class: 'grid' });
  const axis = sv('g', { class: 'axis' });
  const ticks = scale >= 2 ? [scale / 2, scale] : [scale];
  for (const v of ticks) { const yy = zero - y(v); grid.append(sv('line', { x1: padL, x2: W - padR, y1: yy, y2: yy })); axis.append(sv('text', { x: padL - 6, y: yy + 3.5, 'text-anchor': 'end' }, fmtN(v))); }
  if (down.length) for (const v of ticks) { const yy = zero + y(v); grid.append(sv('line', { x1: padL, x2: W - padR, y1: yy, y2: yy })); axis.append(sv('text', { x: padL - 6, y: yy + 3.5, 'text-anchor': 'end' }, fmtN(v))); }
  axis.append(sv('line', { x1: padL, x2: W - padR, y1: zero, y2: zero }));
  axis.append(sv('text', { x: padL - 6, y: zero + 3.5, 'text-anchor': 'end' }, '0'));
  svg.append(grid, axis);
  const marks = sv('g');
  const every = labelEvery || Math.max(1, Math.ceil(n / Math.floor(iw / 44)));
  keys.forEach((k, i) => {
    let top = zero;
    for (const s of up) {
      const v = s.values[i] || 0; if (!v) continue;
      const h = y(v); const r = sv('rect', { class: 'mark', x: x(i), y: top - h, width: bw, height: Math.max(0, h - 2), rx: 3, fill: s.color, 'data-i': i });
      if (s.ghost) r.setAttribute('opacity', '.45');
      marks.append(r); top -= h;
    }
    let bot = zero;
    for (const s of down) {
      const v = s.values[i] || 0; if (!v) continue;
      const h = y(v); const r = sv('rect', { class: 'mark', x: x(i), y: bot + 2, width: bw, height: Math.max(0, h - 2), rx: 3, fill: s.color, 'data-i': i });
      if (s.ghost) r.setAttribute('opacity', '.45');
      marks.append(r); bot += h;
    }
    if (i % every === 0 || (i === n - 1 && (i % every) * slot >= 44)) axis.append(sv('text', { x: x(i) + bw / 2, y: height - 6, 'text-anchor': 'middle' }, label(k, bucket)));
  });
  svg.append(marks);
  // The hit layer: one target per bucket, the whole column tall, keyboard reachable.
  const cross = sv('line', { class: 'cross', y1: padT, y2: height - padB, visibility: 'hidden' });
  svg.append(cross);
  const hits = sv('g');
  keys.forEach((k, i) => {
    const h = sv('rect', { class: 'hit', x: padL + slot * i, y: padT, width: slot, height: ih, tabindex: 0 });
    const show = (ev) => {
      cross.setAttribute('x1', x(i) + bw / 2); cross.setAttribute('x2', x(i) + bw / 2); cross.setAttribute('visibility', 'visible');
      for (const m of marks.children) m.classList.toggle('dim', m.dataset.i !== String(i));
      const rows = [...up, ...down].map((s) => [s.label, s.values[i] || 0, s.color]);
      const b = h.getBoundingClientRect();
      showTip(ev?.clientX ?? b.x + b.width / 2, ev?.clientY ?? b.y, k, rows);
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); for (const m of marks.children) m.classList.remove('dim'); hideTip(); };
    h.addEventListener('pointermove', show); h.addEventListener('pointerleave', hide);
    h.addEventListener('focus', () => show()); h.addEventListener('blur', hide);
    hits.append(h);
  });
  svg.append(hits);
  if (yLabel) svg.append(sv('text', { class: 'dl', x: padL, y: 9 }, yLabel));
  return svg;
}

/** One line with its wash, a dot and a label at the end. */
function line(fig, { keys, bucket, values, color, height = 190, unit = '' }) {
  const W = width(fig), padL = 34, padR = 40, padT = 14, padB = 22;
  const iw = W - padL - padR, ih = height - padT - padB;
  const n = keys.length;
  const max = nice(Math.max(1, ...values));
  const x = (i) => padL + (n > 1 ? iw * (i / (n - 1)) : iw / 2);
  const y = (v) => padT + ih - ih * (v / max);
  const svg = sv('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img' });
  const grid = sv('g', { class: 'grid' }), axis = sv('g', { class: 'axis' });
  for (const v of [0, max / 2, max]) { grid.append(sv('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v) })); axis.append(sv('text', { x: padL - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, fmtN(v))); }
  const every = Math.max(1, Math.ceil(n / Math.floor(iw / 44)));
  keys.forEach((k, i) => { if (i % every === 0 || (i === n - 1 && (i % every) * (iw / Math.max(1, n - 1)) >= 44)) axis.append(sv('text', { x: x(i), y: height - 6, 'text-anchor': 'middle' }, label(k, bucket))); });
  svg.append(grid, axis);
  const pts = values.map((v, i) => `${x(i)},${y(v)}`);
  svg.append(sv('path', { class: 'area', d: `M${x(0)},${y(0)} L${pts.join(' L')} L${x(n - 1)},${y(0)} Z`, fill: color }));
  svg.append(sv('path', { class: 'line', d: `M${pts.join(' L')}`, stroke: color }));
  const last = values[n - 1] ?? 0;
  svg.append(sv('circle', { class: 'end', cx: x(n - 1), cy: y(last), r: 4.5, fill: color }));
  svg.append(sv('text', { class: 'dl', x: x(n - 1) + 8, y: y(last) + 3.5 }, `${fmtN(last)}${unit}`));
  const cross = sv('line', { class: 'cross', y1: padT, y2: height - padB, visibility: 'hidden' });
  const dot = sv('circle', { class: 'end', r: 4.5, fill: color, visibility: 'hidden' });
  svg.append(cross, dot);
  const hit = sv('rect', { class: 'hit', x: padL, y: padT, width: iw, height: ih, tabindex: 0 });
  const at = (i, ev) => { cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible'); dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(values[i])); dot.setAttribute('visibility', 'visible'); const b = hit.getBoundingClientRect(); showTip(ev?.clientX ?? b.x + b.width / 2, ev?.clientY ?? b.y, keys[i], [['open', values[i], color]]); };
  hit.addEventListener('pointermove', (ev) => { const b = svg.getBoundingClientRect(); const px = (ev.clientX - b.left) * (W / b.width); at(Math.max(0, Math.min(n - 1, Math.round((px - padL) / (iw / Math.max(1, n - 1))))), ev); });
  const off = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); };
  hit.addEventListener('pointerleave', off); hit.addEventListener('focus', () => at(n - 1)); hit.addEventListener('blur', off);
  svg.append(hit);
  return svg;
}

/** Seven rows by twenty-four columns, one hue, light to dark. */
function heat(fig, { weekdays, grid, color, height = 150 }) {
  const W = width(fig), padL = 30, padR = 4, padT = 4, padB = 18;
  const cw = (W - padL - padR) / 24, ch = (height - padT - padB) / 7;
  const max = Math.max(1, ...grid.flat());
  const svg = sv('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img' });
  const axis = sv('g', { class: 'axis' });
  weekdays.forEach((d, r) => axis.append(sv('text', { x: padL - 6, y: padT + ch * r + ch / 2 + 3.5, 'text-anchor': 'end' }, d)));
  for (const h of [0, 6, 12, 18, 23]) axis.append(sv('text', { x: padL + cw * h + cw / 2, y: height - 4, 'text-anchor': 'middle' }, `${h}h`));
  svg.append(axis);
  grid.forEach((row, r) => row.forEach((v, h) => {
    const c = sv('rect', { class: 'cell', x: padL + cw * h, y: padT + ch * r, width: cw, height: ch, rx: 2, fill: color, 'fill-opacity': v ? 0.12 + 0.88 * (v / max) : 0.04, tabindex: v ? 0 : null });
    const show = (ev) => { const b = c.getBoundingClientRect(); showTip(ev?.clientX ?? b.x, ev?.clientY ?? b.y, `${weekdays[r]} ${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`, [['events', v, color]]); };
    c.addEventListener('pointermove', show); c.addEventListener('pointerleave', hideTip); c.addEventListener('focus', () => show()); c.addEventListener('blur', hideTip);
    svg.append(c);
  }));
  return svg;
}

/** Horizontal bars, one hue, each with a sparkline of its buckets and a
 *  count of your actions on it. */
function bars(fig, { rows, series, buckets, bucket, color, you }) {
  const W = width(fig), rowH = 30, padT = 4, labelW = Math.min(240, Math.max(120, W * 0.3)), sparkW = Math.min(140, W * 0.2), numW = 44, gap = 14;
  const height = padT + rows.length * rowH + 4;
  const barX = labelW + gap, barW = W - barX - numW - gap - sparkW - gap - (you ? 40 : 0);
  const lead = series[0];
  const max = Math.max(1, ...rows.map((r) => r[lead].total));
  const svg = sv('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img' });
  rows.forEach((r, i) => {
    const y = padT + rowH * i;
    const name = r.key + (r.folded ? ` (${r.folded} more)` : '');
    const t = sv('text', { class: 'bar-label', x: labelW, y: y + 19, 'text-anchor': 'end' }, name.length > 34 ? '…' + name.slice(-33) : name);
    const w = barW * (r[lead].total / max);
    const bar = sv('rect', { class: 'mark', x: barX, y: y + 6, width: Math.max(w, r[lead].total ? 2 : 0), height: 18, rx: 4, fill: color });
    const num = sv('text', { class: 'bar-label small', x: barX + barW + 6, y: y + 19 }, fmtN(r[lead].total));
    svg.append(t, bar, num);
    // The sparkline: this key's share of each bucket, as a tiny column set.
    const sx = barX + barW + numW + gap;
    const vals = r[lead].buckets, m = Math.max(1, ...vals), n = vals.length, sw = sparkW / n;
    vals.forEach((v, j) => { if (v) svg.append(sv('rect', { x: sx + sw * j, y: y + 24 - 18 * (v / m), width: Math.max(1, sw - 1), height: 18 * (v / m), fill: color, opacity: .55 })); });
    svg.append(sv('line', { x1: sx, x2: sx + sparkW, y1: y + 24.5, y2: y + 24.5, stroke: css('--rule') }));
    if (you) svg.append(sv('text', { class: 'bar-label small', x: W - 2, y: y + 19, 'text-anchor': 'end', fill: r.actions?.total ? css('--copper-2') : null }, r.actions?.total ? `you ${r.actions.total}` : ''));
    const hit = sv('rect', { class: 'hit', x: 0, y, width: W, height: rowH, tabindex: 0 });
    const show = (ev) => { const b = hit.getBoundingClientRect(); const top = Math.max(...vals), peak = vals.indexOf(top); showTip(ev?.clientX ?? b.x, ev?.clientY ?? b.y, r.key, [...series.map((s) => [s, r[s].total, s === 'actions' ? css('--copper') : s === lead ? color : null]), ...(top > 0 ? [['busiest', `${label(buckets[peak], bucket)} · ${top}`]] : [])]); };
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerleave', hideTip); hit.addEventListener('focus', () => show()); hit.addEventListener('blur', hideTip);
    svg.append(hit);
  });
  return svg;
}

// --- the reports, drawn -----------------------------------------------------
/** One report over the page's window, from the API. */
async function fetchReport(name, params = {}) {
  const r = await fetch(reportUrl(name, params));
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}
/** A stat tile: a label, a value with an optional aside, and a line beneath. */
const kpi = (cls, label_, value, small, sub) => { const k = el('div', `kpi ${cls || ''}`); k.append(el('div', 'label', label_)); const v = el('div', 'value', String(value)); if (small) v.append(el('small', null, small)); k.append(v); if (sub) k.append(el('div', 'sub', sub)); return k; };

/** The KPI row, the two flow charts and the interrupts chart, from `flow`. */
function drawFlow(r) {
  const c = C();
  const keys = r.buckets.map((b) => b.key);
  const T = r.totals;
  $('#kpis').replaceChildren(
    kpi('', 'open now', T.open.now, null, `${T.open.start} at the start of the window`),
    kpi('machine', 'arrived', T.arrived, null, `${T.verdicts} verdicts`),
    kpi('you', 'closed by you', T.closed.you, null, `${T.parked} parked — snoozed, later, muted`),
    kpi('', 'resolved elsewhere', T.closed.elsewhere, null, 'a row deleted, an issue closed'),
    kpi('alarm', 'interrupts', T.interrupts, `${T.interrupt_rate.per_hour}/h`, T.interrupt_rate.busiest ? `busiest ${T.interrupt_rate.busiest.key}: ${T.interrupt_rate.busiest.n}` : 'none in the window'),
  );
  const io = $('#flow-io'); io.replaceChildren();
  io.append(caption('arrivals over closures', `per ${r.bucket}`, 'flow'));
  io.append(columns(io, { keys, bucket: r.bucket,
    up: [{ label: 'arrived', color: c.teal, values: r.buckets.map((b) => b.arrived) }],
    down: [{ label: 'closed by you', color: c.copper, values: r.buckets.map((b) => b.closed.you) }, { label: 'resolved elsewhere', color: c.gray, values: r.buckets.map((b) => b.closed.elsewhere), ghost: false }] }));
  io.append(legend([['arrived', c.teal], ['closed by you', c.copper], ['resolved elsewhere', c.gray]]));
  io.append(table([r.bucket, 'arrived', 'verdicts', 'you closed', 'elsewhere', 'parked', 'reopened'], r.buckets.map((b) => [b.key, b.arrived, b.verdicts, b.closed.you, b.closed.elsewhere, b.parked, b.reopened])));
  const op = $('#flow-open'); op.replaceChildren();
  op.append(caption('open, at the end of each ' + r.bucket, `${T.open.start} → ${T.open.end}`, 'flow'));
  op.append(line(op, { keys, bucket: r.bucket, values: r.buckets.map((b) => b.states.open), color: c.teal }));
  const lead = el('div', 'lead', T.open.end > T.open.start ? `the list grew by ${T.open.end - T.open.start} over the window` : T.open.end < T.open.start ? `the list shrank by ${T.open.start - T.open.end} over the window` : 'the list is the same size it was');
  op.append(lead);
  op.append(table([r.bucket, 'open', 'snoozed', 'later', 'done', 'muted'], r.buckets.map((b) => [b.key, b.states.open, b.states.snoozed, b.states.later, b.states.done, b.states.muted])));
  const it = $('#int-chart'); it.replaceChildren();
  it.append(caption('verdicts, and the ones that interrupted', `${T.interrupts} of ${T.verdicts} reached Slack`, 'flow'));
  it.append(columns(it, { keys, bucket: r.bucket, height: 170,
    up: [{ label: 'interrupted', color: c.crimson, values: r.buckets.map((b) => b.interrupts) }, { label: 'placed in the list', color: c.gray, values: r.buckets.map((b) => b.verdicts - b.interrupts), ghost: true }] }));
  it.append(legend([['interrupted', c.crimson], ['placed in the list', c.gray]]));
  it.append(el('div', 'lead', `${T.interrupt_rate.per_hour} an hour over the window. ${T.interrupt_rate.trigger}.`));
  it.append(table([r.bucket, 'verdicts', 'interrupted'], r.buckets.map((b) => [b.key, b.verdicts, b.interrupts])));
}

/** The three heatmaps, from `when`. */
function drawWhen(r) {
  const c = C();
  const wrap = $('#when-charts'); wrap.replaceChildren();
  $('#when-blurb').textContent = `hour of the day by day of the week, ${r.tz}`;
  const panels = [['them', 'theirs', c.teal, 'people who are not you, at the far end'], ['you', 'mine', c.copper, 'your comments and reviews there, your actions here'], ['interrupts', 'interrupts', c.crimson, 'when Slack was told']];
  // Every figure goes into the grid before any is drawn: a chart measures
  // its figure's width, and the first figure alone in the grid is as wide
  // as the grid.
  const figs = panels.map(() => { const f = el('figure', 'chart'); wrap.append(f); return f; });
  panels.forEach(([title, key, color, sub], n) => {
    const fig = figs[n];
    const p = r.peak[key];
    fig.append(caption(title, `${r.totals[key]}${p ? ` · peak ${p.weekday} ${p.hour}h` : ''}`, 'when', r.source ? { source: r.source } : {}));
    if (!r.totals[key]) { fig.append(el('div', 'empty', 'nothing in the window')); return; }
    fig.append(heat(fig, { weekdays: r.weekdays, grid: r.series[key], color }));
    fig.append(el('div', 'lead', sub));
    fig.append(table(['', ...Array.from({ length: 24 }, (_, h) => `${h}`)], r.series[key].map((row, i) => [r.weekdays[i], ...row])));
  });
  if (r.totals.bots) { const n = el('div', 'lead'); n.textContent = `bots are not people: ${r.totals.bots} bot events in the window are left off these grids.`; wrap.append(n); }
}

/** The bars by key with a sparkline each, from `where`. */
function drawWhere(r) {
  const c = C();
  const fig = $('#where-chart'); fig.replaceChildren();
  const lead = r.series[0];
  fig.append(caption(`${lead} by ${r.by}`, `top ${r.rows.filter((x) => x.key !== 'other').length}, per ${bucketFor(state.days)} alongside`, 'where', { by: r.by }));
  if (!r.rows.length) { fig.append(el('div', 'empty', 'nothing in the window')); return; }
  fig.append(bars(fig, { rows: r.rows, series: r.series, buckets: r.buckets, bucket: bucketFor(state.days), color: c.teal, you: r.series.includes('actions') }));
  const items = [[lead, c.teal]]; if (r.series.includes('actions')) items.push(['your actions', c.copper]);
  fig.append(legend(items));
  fig.append(table([r.by, ...r.series.map((s) => s === 'actions' ? 'yours' : s)], r.rows.map((x) => [x.key + (x.folded ? ` (${x.folded} folded)` : ''), ...r.series.map((s) => x[s].total)])));
}

/** The response tiles and the sample table, from `response`. */
function drawResponse(r) {
  const c = C();
  const fig = $('#resp-chart'); fig.replaceChildren();
  fig.append(caption('from verdict to your action', r.note || `${r.n} of your actions`, 'response'));
  const row = el('div', 'kpis');
  row.append(kpi('you', 'your actions', r.n, null, Object.entries(r.by_action).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none in the window'));
  row.append(kpi('', 'median wait', hours(r.median_h), null, `p90 ${hours(r.p90_h)}`));
  row.append(kpi('alarm', 'interrupts answered', `${r.interrupts.answered}`, `of ${r.interrupts.sent}`, r.interrupts.answered ? `median ${hours(r.interrupts.median_h)} to your first action` : r.interrupts.sent ? 'none acted on here yet' : 'none sent in the window'));
  fig.append(row);
  if (r.note) fig.append(el('div', 'thin', r.note + '; every number above is that small'));
  if (r.n) fig.append(table(['when', 'item', 'action', 'waited', 'since'], r.samples.slice().reverse().map((s) => [s.at.slice(0, 16).replace('T', ' '), s.item_key || s.item_id, s.action, hours(s.hours), s.from])));
}

// --- load ---------------------------------------------------------------------
let generation = 0;
/** Fetch every report for the window and draw the page. Only the newest load may draw. */
async function load() {
  const gen = ++generation;
  for (const f of document.querySelectorAll('.chart')) f.classList.add('loading');
  const w = window_();
  $('#window').textContent = `${new Date(w.since).toLocaleDateString([], { month: 'short', day: 'numeric' })} → today · by the ${w.bucket}`;
  for (const b of $('#range').children) b.setAttribute('aria-pressed', String(parseInt(b.dataset.days, 10) === state.days));
  try {
    const [flow, when, where, response, health] = await Promise.all([
      fetchReport('flow'), fetchReport('when', state.whenSource ? { source: state.whenSource } : {}), fetchReport('where', { by: state.whereBy }), fetchReport('response'),
      fetch('/healthz').then((r) => r.json()),
    ]);
    if (gen !== generation) return;
    drawFlow(flow); drawWhen(when); drawWhere(where); drawResponse(response);
    $('#dot').className = `dot ${health.failing?.length ? 'bad' : 'ok'}`;
    $('#observed').textContent = `${health.user} · ${health.items} items · ${health.decisions} verdicts · ${flow.tz}`;
    const glance = $('#glance'); glance.replaceChildren();
    const tile = (cls, text) => { const t = el('span', `tile ${cls}`); t.textContent = text; return t; };
    glance.append(tile('', `${flow.totals.open.now} open`), tile('p1', `${flow.totals.closed.you} closed by you`), tile('p0', `${flow.totals.interrupts} interrupts`));
  } catch (e) {
    if (gen !== generation) return;
    $('#dot').className = 'dot bad';
    $('#observed').textContent = `cannot draw the reports: ${e.message}`;
  } finally {
    if (gen === generation) for (const f of document.querySelectorAll('.chart')) f.classList.remove('loading');
  }
}
// --- controls -------------------------------------------------------------------
$('#range').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.days = parseInt(b.dataset.days, 10); remember(); load(); });
$('#bucket').value = state.bucket;
$('#bucket').onchange = (e) => { state.bucket = e.target.value; remember(); load(); };
$('#where-by').value = state.whereBy;
$('#where-by').onchange = (e) => { state.whereBy = e.target.value; remember(); load(); };
$('#when-source').onchange = (e) => { state.whenSource = e.target.value; remember(); load(); };
$('#export').onclick = () => exportWindow().catch((e) => { $('#observed').textContent = `export failed: ${e.message}`; });
$('#theme').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('triage.theme', next); } catch {}
  load();   // the marks read their colours from the tokens at draw time
};
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select, button')) return;
  if (e.key === 'r') load();
  if (e.key === 't') $('#theme').click();
  if (e.key === 'e') $('#export').click();
});
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(load, 200); });
// The source list for `when` comes from /api/sources once, so the filter is
// populated before the first report answers.
fetch('/api/sources').then((r) => r.json()).then((s) => { const sel = $('#when-source'); for (const x of s.sources || []) if (![...sel.options].some((o) => o.value === x.name)) sel.append(new Option(x.name, x.name)); sel.value = state.whenSource; }).catch(() => {});
load();
setInterval(load, 5 * 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
