// reports.js — the store read over time (plan §15). `lib/aggregates.js` is
// the queue *now*, as counts; this is the queue *over a window*, bucketed by
// hour, day or week in the configured zone, and it keeps that file's
// contract: a query over what is already there, nothing written, nothing
// judged.
//
// A report is a named pure function over one bounded read — every event,
// verdict and action in the window, plus the user's items whole — and the
// registry below is the API: `GET /api/reports` lists them with the sentence
// each answers, `GET /api/reports/:name` runs one. Adding a report is adding
// an entry here.
//
// Three things are settled (§15.2) rather than left to whoever draws it:
//   - time is the far end's: an event is bucketed on `ts`, not on `seen`;
//   - "you" is `actions.by` that is neither `system` nor `source:<name>` —
//     a ledger row its owner deleted is a closure, reported as one, in its
//     own series, and never as something you did (§12.2);
//   - state over time is replayed from `actions`, not stored: every state
//     change since M1 wrote a row, so the open count at any past moment is
//     the items created by then walked through their actions to then.
import { STATES } from './store.js';
import { isBot } from './util.js';

const HOUR = 3_600_000, DAY = 86_400_000;
export const BUCKETS = { hour: HOUR, day: DAY, week: 7 * DAY };
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** How many keys `where` names before folding the tail into `other`. */
export const TOP = 7;
/** The fields `where` may cut by. Each says which rows carry it: an event's
 *  repo, source and kind are its item's; its actor is its own; a rule is a
 *  verdict's and nothing else's. */
export const WHERE_BY = {
  repo: { of: (i) => i.repo || i.source, rows: ['events', 'verdicts', 'actions'] },
  source: { of: (i) => i.source, rows: ['events', 'verdicts', 'actions'] },
  kind: { of: (i) => i.kind, rows: ['events', 'verdicts', 'actions'] },
  actor: { of: null, rows: ['events'] },
  rule: { of: null, rows: ['verdicts'] },
};

/** Whether an action row is something you did. `null` is yours too: the
 *  early rows before `by` was always written were pressed by hand. */
export const yours = (a) => a.by == null || (a.by !== 'system' && !String(a.by).startsWith('source:'));
/** What each action does to an item's state, for the replay. */
const TRANSITION = { done: 'done', answer: 'done', resolved: 'done', snooze: 'snoozed', later: 'later', mute: 'muted', open: 'open', reopen: 'open', wake: 'open' };

// --- time, in a zone -----------------------------------------------------
const fmts = new Map();
/** The formatter for a zone, made once. */
function fmt(tz) {
  if (!fmts.has(tz)) fmts.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' }));
  return fmts.get(tz);
}
/** The local calendar parts of an instant. `weekday` is 0 = Monday. */
export function local(ms, tz) {
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(ms))) p[type] = value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24, weekday: WEEKDAYS.indexOf(p.weekday), ymd: [parseInt(p.year, 10), parseInt(p.month, 10), parseInt(p.day, 10)] };
}
/** The bucket an instant falls in, as a key that sorts as time does within
 *  one bucket size — `YYYY-MM-DD`, `YYYY-MM-DD HH`, or the Monday's date. */
export function bucketKey(ms, bucket, tz) {
  const l = local(ms, tz);
  if (bucket === 'hour') return `${l.date} ${String(l.hour).padStart(2, '0')}`;
  if (bucket === 'day') return l.date;
  const [y, m, d] = l.ymd;
  return new Date(Date.UTC(y, m - 1, d) - l.weekday * DAY).toISOString().slice(0, 10);
}
/** Every bucket key from `since` to `until`, in order, none missing: a quiet
 *  day is a zero on the chart, not a gap in it. Walked at half a bucket so a
 *  clock change cannot skip one; keyed, so it cannot double one. */
export function bucketKeys(since, until, bucket, tz) {
  const keys = [];
  const seen = new Set();
  const step = BUCKETS[bucket] / 2;
  for (let t = since; t <= until + step; t += step) {
    const k = bucketKey(Math.min(t, until), bucket, tz);
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  return keys;
}

/** An ISO time as milliseconds, or null when unreadable. */
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
/** One fresh value per bucket key. */
const zeros = (keys, make) => Object.fromEntries(keys.map((k) => [k, make()]));
/** Two decimals; null stays null. */
const round = (x) => (x == null ? null : Math.round(x * 100) / 100);
/** The q-th quantile of a sorted list, or null when empty. */
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
/** The median, or null when empty. */
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

// --- the reports -----------------------------------------------------------
/** Arrivals against closures per bucket, and the state of the queue at the
 *  end of each — the created-versus-resolved chart and the cumulative flow
 *  diagram, which for one person's queue are one picture drawn twice. */
function flow(h, { keys, bucket, tz, me }) {
  const key = (iso) => bucketKey(ms(iso), bucket, tz);
  // The window is the instants, not the buckets: a bucket at either edge
  // is part outside the window, and a row in that part is not counted.
  const since = ms(h.since), until = ms(h.until);
  const inWindow = (iso) => { const t = ms(iso); return t != null && t >= since && t <= until; };
  const buckets = zeros(keys, () => ({ arrived: 0, verdicts: 0, interrupts: 0, closed: { you: 0, elsewhere: 0 }, parked: 0, reopened: 0, states: Object.fromEntries(STATES.map((s) => [s, 0])) }));
  for (const i of h.items) if (inWindow(i.created)) buckets[key(i.created)].arrived++;
  for (const d of h.decisions) { const b = buckets[key(d.ts)]; if (!b) continue; b.verdicts++; if (d.delivered) b.interrupts++; }
  for (const a of h.actions) {
    if (!inWindow(a.ts)) continue;
    const b = buckets[key(a.ts)];
    if (a.action === 'done' || a.action === 'answer') b.closed.you++;
    else if (a.action === 'resolved') b.closed.elsewhere++;
    else if (a.action === 'snooze' || a.action === 'later' || a.action === 'mute') b.parked++;
    else if (a.action === 'reopen' || a.action === 'wake' || a.action === 'open') b.reopened++;
  }
  // The replay: items and actions in time order, applied up to each
  // bucket's end; keys compare as time does, so "everything up to and
  // including this bucket" is a string comparison. Rows from before the
  // window all land in the first bucket's opening state; rows after it
  // are not history yet and are left out.
  const state = new Map();
  const items = h.items.filter((i) => ms(i.created) <= until).map((i) => ({ id: i.id, k: key(i.created) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const acts = h.actions.filter((a) => ms(a.ts) <= until).map((a) => ({ id: a.item_id, k: key(a.ts), to: TRANSITION[a.action] })).filter((a) => a.to);
  let ii = 0, ai = 0;
  for (const k of keys) {
    while (ii < items.length && items[ii].k <= k) { state.set(items[ii].id, 'open'); ii++; }
    while (ai < acts.length && acts[ai].k <= k) { if (state.has(acts[ai].id)) state.set(acts[ai].id, acts[ai].to); ai++; }
    for (const s of state.values()) buckets[k].states[s]++;
  }
  const rows = keys.map((k) => ({ key: k, ...buckets[k] }));
  const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
  const totals = { arrived: sum((r) => r.arrived), verdicts: sum((r) => r.verdicts), interrupts: sum((r) => r.interrupts), closed: { you: sum((r) => r.closed.you), elsewhere: sum((r) => r.closed.elsewhere) }, parked: sum((r) => r.parked), reopened: sum((r) => r.reopened),
    open: { start: rows[0]?.states.open ?? 0, end: rows.at(-1)?.states.open ?? 0, now: h.items.filter((i) => i.state === 'open').length } };
  // §14.7's trigger, measured: interrupts per hour over the window, and the
  // busiest single bucket.
  const hours = Math.max(1, (ms(h.until) - ms(h.since)) / HOUR);
  const busiest = rows.reduce((m, r) => (r.interrupts > (m?.interrupts ?? 0) ? r : m), null);
  totals.interrupt_rate = { per_hour: Math.round(totals.interrupts / hours * 1000) / 1000, busiest: busiest ? { key: busiest.key, n: busiest.interrupts } : null, trigger: 'more than one an hour, sustained (plan §14.7)' };
  return { buckets: rows, totals };
}

/** Hour of the day by day of the week, in the zone: when the far end is
 *  active, when you are, when bots are, and when interrupts land. The one
 *  chart no tracker draws, because a team has no single clock. `theirs` is
 *  an event whose actor is a person who is not you; `mine` is your own
 *  events at the far end plus your actions here. */
function when(h, { tz, me, source = null }) {
  const grid = () => WEEKDAYS.map(() => Array(24).fill(0));
  const series = { mine: grid(), theirs: grid(), bots: grid(), interrupts: grid() };
  const byItem = new Map(h.items.map((i) => [i.id, i]));
  const wants = (itemId) => !source || byItem.get(itemId)?.source === source;
  const put = (s, iso) => { const t = ms(iso); if (t == null) return; const l = local(t, tz); series[s][l.weekday][l.hour]++; };
  for (const e of h.events) {
    if (!e.actor || !wants(e.item_id)) continue;
    put(e.actor === me ? 'mine' : isBot(e.actor) ? 'bots' : 'theirs', e.ts);
  }
  for (const a of h.actions) if (yours(a) && wants(a.item_id) && ms(a.ts) >= ms(h.since) && ms(a.ts) <= ms(h.until)) put('mine', a.ts);
  for (const d of h.decisions) if (d.delivered && wants(d.item_id)) put('interrupts', d.ts);
  const out = { tz, source, weekdays: WEEKDAYS, series, totals: {}, by_hour: {}, by_weekday: {}, peak: {} };
  for (const [name, g] of Object.entries(series)) {
    out.by_hour[name] = Array.from({ length: 24 }, (_, hr) => g.reduce((n, row) => n + row[hr], 0));
    out.by_weekday[name] = g.map((row) => row.reduce((a, b) => a + b, 0));
    out.totals[name] = out.by_weekday[name].reduce((a, b) => a + b, 0);
    let peak = null;
    g.forEach((row, wd) => row.forEach((n, hr) => { if (n > (peak?.n ?? 0)) peak = { weekday: WEEKDAYS[wd], hour: hr, n }; }));
    out.peak[name] = peak;
  }
  return out;
}

/** Which repositories, sources, kinds, actors or rules the activity is in,
 *  per bucket — the "slice by" of every tracker's insights page. The top
 *  keys are named and the tail is folded into `other`, because a ninth
 *  series is never a ninth colour. */
function where(h, { keys, bucket, tz, me, by = 'repo' }) {
  const spec = WHERE_BY[by];
  if (!spec) throw Object.assign(new Error(`by must be one of ${Object.keys(WHERE_BY).join(', ')}`), { status: 400 });
  const key = (iso) => bucketKey(ms(iso), bucket, tz);
  const byItem = new Map(h.items.map((i) => [i.id, i]));
  const of = (row, table) => {
    if (by === 'actor') return row.actor || null;
    if (by === 'rule') return table === 'verdicts' ? row.rule : null;
    const i = byItem.get(row.item_id); return i ? spec.of(i) : null;
  };
  const since = ms(h.since), until = ms(h.until);
  const counts = {};   // k -> { events: {bucket: n}, verdicts, actions }
  const tally = (table, rows, filter = () => true) => {
    for (const r of rows) {
      if (!filter(r)) continue;
      const t = ms(r.ts); if (t == null || t < since || t > until) continue;
      const b = key(r.ts);
      const k = of(r, table); if (k == null) continue;
      counts[k] ??= {}; counts[k][table] ??= {}; counts[k][table][b] = (counts[k][table][b] || 0) + 1;
    }
  };
  if (spec.rows.includes('events')) tally('events', h.events);
  if (spec.rows.includes('verdicts')) tally('verdicts', h.decisions);
  if (spec.rows.includes('actions')) tally('actions', h.actions, yours);
  const total = (c, table) => Object.values(c[table] || {}).reduce((a, b) => a + b, 0);
  // Ranked by what the first applicable table says, since that is what the
  // bars are drawn from.
  const lead = spec.rows[0];
  const ranked = Object.entries(counts).sort((a, b) => total(b[1], lead) - total(a[1], lead) || (a[0] < b[0] ? -1 : 1));
  const head = ranked.slice(0, TOP), tail = ranked.slice(TOP);
  const row = (k, c) => ({ key: k, ...Object.fromEntries(spec.rows.map((t) => [t, { total: total(c, t), buckets: keys.map((b) => c[t]?.[b] || 0) }])) });
  const rows = head.map(([k, c]) => row(k, c));
  if (tail.length) {
    const merged = {};
    for (const [, c] of tail) for (const t of spec.rows) { merged[t] ??= {}; for (const [b, n] of Object.entries(c[t] || {})) merged[t][b] = (merged[t][b] || 0) + n; }
    rows.push({ ...row('other', merged), folded: tail.length });
  }
  return { by, series: spec.rows, buckets: keys, rows };
}

/** How long an item waited before you did something about it — the control
 *  chart, as far as the data allows. Each of your actions in the window is
 *  measured from the item's latest verdict before it (else its arrival);
 *  each interrupt sent is measured to your first action on that item after
 *  it. The sample size travels with every number, because a median of two
 *  is not a median (§15.3). */
function response(h, { keys, bucket, tz, me }) {
  const key = (iso) => bucketKey(ms(iso), bucket, tz);
  const since = ms(h.since), until = ms(h.until);
  // The verdicts an action can be measured from: the last one before the
  // window, then every one inside it, in order.
  const decisionsOf = new Map();
  for (const d of [...(h.prior || []), ...h.decisions]) { if (!decisionsOf.has(d.item_id)) decisionsOf.set(d.item_id, []); decisionsOf.get(d.item_id).push(d); }
  const created = new Map(h.items.map((i) => [i.id, ms(i.created)]));
  const byItem = new Map(h.items.map((i) => [i.id, i]));
  const acts = h.actions.filter((a) => yours(a) && ms(a.ts) >= since && ms(a.ts) <= until);
  const samples = [];
  for (const a of acts) {
    const t = ms(a.ts);
    const prior = (decisionsOf.get(a.item_id) || []).filter((d) => ms(d.ts) <= t).at(-1);
    const from = prior ? ms(prior.ts) : created.get(a.item_id);
    if (from == null) continue;
    samples.push({ item_id: a.item_id, item_key: byItem.get(a.item_id)?.key ?? null, title: byItem.get(a.item_id)?.title ?? null, url: byItem.get(a.item_id)?.url ?? null, action: a.action, by: a.by, at: a.ts, from: prior ? 'verdict' : 'arrival', hours: round(Math.max(0, t - from) / HOUR), bucket_key: key(a.ts) });
  }
  const hours = samples.map((s) => s.hours).sort((a, b) => a - b);
  const perBucket = keys.map((k) => { const xs = samples.filter((s) => s.bucket_key === k).map((s) => s.hours); return { key: k, n: xs.length, median_h: round(median(xs)) }; });
  const byAction = {};
  for (const s of samples) byAction[s.action] = (byAction[s.action] || 0) + 1;
  // Interrupts: sent, and answered by you how much later.
  const sent = h.decisions.filter((d) => d.delivered);
  const yoursAfter = (d) => h.actions.filter((a) => yours(a) && a.item_id === d.item_id && ms(a.ts) >= ms(d.ts)).sort((a, b) => ms(a.ts) - ms(b.ts))[0];
  const answered = [], unanswered = [];
  for (const d of sent) { const a = yoursAfter(d); if (a) answered.push(round((ms(a.ts) - ms(d.ts)) / HOUR)); else unanswered.push(d.item_id); }
  answered.sort((a, b) => a - b);
  return {
    n: samples.length, median_h: round(median(hours)), p90_h: round(quantile(hours, 0.9)), by_action: byAction,
    samples: samples.slice(-200), buckets: perBucket,
    interrupts: { sent: sent.length, answered: answered.length, unanswered: unanswered.length, median_h: round(median(answered)), p90_h: round(quantile(answered, 0.9)) },
    note: samples.length < 10 ? `${samples.length} of your actions on record in this window — too few to read a trend from` : null,
  };
}

export const REPORTS = {
  flow: { run: flow, describe: 'arrivals against closures per bucket, who closed what, and the state of the queue at the end of each; the interrupt rate against plan §14.7\'s trigger' },
  when: { run: when, describe: 'hour of the day by day of the week, in your zone: when the far end is active, when you are, when bots are, when interrupts land; ?source= narrows it' },
  where: { run: where, describe: 'which repositories, sources, kinds, actors or rules the activity is in, per bucket; ?by=repo|source|kind|actor|rule, the tail folded into other' },
  response: { run: response, describe: 'how long an item waited before you acted on it, and how long an interrupt waited for you — with its sample size, always' },
};

/** Run one report. `since`/`until` are ISO or ms; the default window is the
 *  last thirty days by the day. `now` is injectable so a test can pin the
 *  clock. Answers with the window it actually used, so a reader who passed
 *  nothing knows what they got. */
export function report(store, name, { user, since = null, until = null, bucket = 'day', tz = 'UTC', now = new Date(), ...rest } = {}) {
  const r = REPORTS[name];
  if (!r) throw Object.assign(new Error(`no report ${name}; one of ${Object.keys(REPORTS).join(', ')}`), { status: 404 });
  if (!BUCKETS[bucket]) throw Object.assign(new Error(`bucket must be one of ${Object.keys(BUCKETS).join(', ')}`), { status: 400 });
  const t1 = until == null ? now.getTime() : typeof until === 'number' ? until : ms(until);
  const t0 = since == null ? t1 - 30 * DAY : typeof since === 'number' ? since : ms(since);
  if (t0 == null || t1 == null) throw Object.assign(new Error('since and until must be ISO times'), { status: 400 });
  if (t1 < t0) throw Object.assign(new Error('until is before since'), { status: 400 });
  if ((t1 - t0) / BUCKETS[bucket] > 2000) throw Object.assign(new Error(`that window is more than 2000 ${bucket}s; use a coarser bucket`), { status: 400 });
  const window = { since: new Date(t0).toISOString(), until: new Date(t1).toISOString() };
  const h = { ...store.history({ user, ...window }), ...window };
  const keys = bucketKeys(t0, t1, bucket, tz);
  return { report: name, ...window, bucket, tz, now: now.toISOString(), ...r.run(h, { keys, bucket, tz, me: user, ...rest }) };
}

/** The registry, for `GET /api/reports`. */
export function describeReports() {
  return { reports: Object.fromEntries(Object.entries(REPORTS).map(([k, v]) => [k, v.describe])), buckets: Object.keys(BUCKETS), where_by: Object.keys(WHERE_BY), defaults: { window: '30 days', bucket: 'day' } };
}
