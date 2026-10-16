// ics.js — enough of RFC 5545 to read a calendar feed (plan §16, G4):
// unfolding, VEVENT properties with their parameters, dates in UTC, in a
// named zone or floating, all-day entries, EXDATE, RECURRENCE-ID overrides,
// and RRULE expansion for DAILY, WEEKLY (BYDAY), MONTHLY (BYMONTHDAY,
// ordinal BYDAY) and YEARLY (BYMONTH) with INTERVAL, COUNT and UNTIL. Zone
// arithmetic is done with Intl, so there is no zone database to ship and no
// VTIMEZONE to parse. Stdlib only, and pure: nothing here reads a clock.
const DAY = 86_400_000;
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** Unfold continuation lines and split each into `{ name, params, value }`.
 *  A colon inside a quoted parameter (`CN="Lee: Ann"`) is not the value's. */
export function parseLines(text) {
  const out = [];
  for (const raw of String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n')) {
    if (!raw) continue;
    let i = 0, q = false;
    for (; i < raw.length; i++) { const c = raw[i]; if (c === '"') q = !q; else if (c === ':' && !q) break; }
    if (i >= raw.length) continue;
    const [name, ...ps] = raw.slice(0, i).split(';');
    const params = {};
    for (const p of ps) { const eq = p.indexOf('='); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, ''); }
    out.push({ name: name.toUpperCase(), params, value: raw.slice(i + 1) });
  }
  return out;
}

/** The VEVENTs of a feed, each as `{ [NAME]: [{ params, value }] }`, and the
 *  calendar's own name (`X-WR-CALNAME`). A component nested in an event (an
 *  alarm) is skipped, so its properties never read as the event's. */
export function parseIcs(text) {
  const events = [];
  let cur = null, depth = 0, name = null;
  for (const l of parseLines(text)) {
    if (l.name === 'BEGIN') { if (l.value === 'VEVENT' && !cur) { cur = {}; depth = 0; } else if (cur) depth++; continue; }
    if (l.name === 'END') { if (cur && depth === 0 && l.value === 'VEVENT') { events.push(cur); cur = null; } else if (cur) depth--; continue; }
    if (l.name === 'X-WR-CALNAME' && !cur) name = unescape_(l.value);
    if (!cur || depth) continue;
    (cur[l.name] ||= []).push({ params: l.params, value: l.value });
  }
  return { events, name };
}

export const unescape_ = (s) => String(s ?? '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
export const prop = (ev, name) => ev[name]?.[0] ?? null;
export const text = (ev, name) => { const p = prop(ev, name); return p ? unescape_(p.value) : null; };

// --- zones -------------------------------------------------------------------
const fmts = new Map();
function fmt(tz) {
  if (!fmts.has(tz)) {
    let f;
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch { f = null; }
    fmts.set(tz, f);
  }
  return fmts.get(tz);
}

/** The Windows names Outlook and Exchange write as a TZID, for the zones
 *  most feeds carry. Intl knows none of them, and read as UTC every meeting
 *  in an Outlook feed would be hours out. Not the whole CLDR table: a name
 *  missing here falls back to your own zone, which is the likelier guess. */
const WINDOWS_ZONES = {
  'Pacific Standard Time': 'America/Los_Angeles', 'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix',
  'Central Standard Time': 'America/Chicago', 'Eastern Standard Time': 'America/New_York', 'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns', 'Alaskan Standard Time': 'America/Anchorage', 'Hawaiian Standard Time': 'Pacific/Honolulu',
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik', 'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev', 'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow', 'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo', 'Singapore Standard Time': 'Asia/Singapore', 'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland', 'South Africa Standard Time': 'Africa/Johannesburg', 'E. South America Standard Time': 'America/Sao_Paulo',
  'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
};

/** A TZID as written -> a zone Intl knows, or null. Takes an IANA name, a
 *  Windows name, or a path that ends in an IANA name (some exporters write
 *  `/mozilla.org/20050126_1/America/New_York`). */
export function zoneOf(tzid) {
  const t = String(tzid || '').trim();
  if (!t) return null;
  if (fmt(t)) return t;
  if (WINDOWS_ZONES[t]) return WINDOWS_ZONES[t];
  const tail = /([A-Za-z_]+\/[A-Za-z_+-]+)$/.exec(t)?.[1];
  return tail && fmt(tail) ? tail : null;
}
export const knownZone = (tz) => !!fmt(tz);

/** The local calendar parts of an instant in a zone. */
export function partsIn(ms, tz) {
  const f = fmt(tz) || fmt('UTC');
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
const asUtc = (p) => Date.UTC(p.y, p.mo - 1, p.d, p.h || 0, p.mi || 0, p.s || 0);

/** A wall-clock time in a zone -> the instant. Two passes, so a clock change
 *  between the guess and the answer is caught; a time that does not exist
 *  (inside a spring-forward gap) is moved forward, as calendars do. */
export function zonedToUtc(p, tz) {
  if (!tz || tz === 'UTC' || !fmt(tz)) return asUtc(p);
  const guess = asUtc(p);
  const off = asUtc(partsIn(guess, tz)) - guess;
  const utc = guess - off;
  const off2 = asUtc(partsIn(utc, tz)) - utc;
  if (off2 === off) return utc;
  const alt = guess - off2;
  return asUtc(partsIn(alt, tz)) === guess ? alt : utc;
}

/** `YYYY-MM-DD` of local parts. */
export const ymd = (p) => `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;

/** A DATE or DATE-TIME property -> `{ ms, allDay, tz, parts }`. A floating
 *  time (no Z, no TZID) and an all-day date are read in `defaultTz` — your
 *  zone — because that is what they mean: "9 am wherever I am", "the 20th".
 *  A TZID nothing can resolve is read there too, rather than as UTC. */
export function parseDate(p, defaultTz = 'UTC') {
  if (!p) return null;
  const v = p.value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || p.params.VALUE === 'DATE') {
    m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    const parts = { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0 };
    return { ms: zonedToUtc(parts, defaultTz), allDay: true, tz: defaultTz, parts };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const parts = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
  const tz = m[7] ? 'UTC' : zoneOf(p.params.TZID) || defaultTz;
  return { ms: zonedToUtc(parts, tz), allDay: false, tz, parts };
}

/** `P1DT2H30M` -> milliseconds. */
export function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * DAY + (+m[4] || 0) * 3_600_000 + (+m[5] || 0) * 60_000 + (+m[6] || 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

export function parseRrule(v) {
  const r = {};
  for (const part of String(v || '').split(';')) {
    const [k, val] = part.split('=');
    if (!k || val == null) continue;
    r[k.trim().toUpperCase()] = val.trim();
  }
  const out = { freq: (r.FREQ || '').toUpperCase(), interval: Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1), count: r.COUNT ? parseInt(r.COUNT, 10) : null, until: r.UNTIL || null, wkst: (r.WKST || 'MO').toUpperCase() };
  out.byday = r.BYDAY ? r.BYDAY.split(',').map((d) => { const m = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(d.trim()); return m ? { n: m[1] ? parseInt(m[1], 10) : 0, day: WEEKDAYS.indexOf(m[2].toUpperCase()) } : null; }).filter(Boolean) : [];
  out.bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map((x) => parseInt(x, 10)).filter(Number.isFinite) : [];
  out.bymonth = r.BYMONTH ? r.BYMONTH.split(',').map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= 12) : [];
  return out;
}

// --- expansion -----------------------------------------------------------------
const weekdayOf = (p) => (new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay() + 6) % 7;   // 0 = Monday
const addDays = (p, n) => { const d = new Date(Date.UTC(p.y, p.mo - 1, p.d + n)); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: p.h, mi: p.mi, s: p.s }; };
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const withDay = (p, y, mo, d) => ({ ...p, y, mo, d });
const dayNumber = (p) => Math.floor(Date.UTC(p.y, p.mo - 1, p.d) / DAY);

/** The candidate days of one month, per the rule, as local parts, in order.
 *  A day the month does not have (the 31st, an ordinal past the last) is
 *  skipped, never rolled into the next month. */
function monthCandidates(rule, y, mo, base) {
  const n = daysInMonth(y, mo);
  const out = [];
  if (rule.bymonthday.length) { for (const md of rule.bymonthday) { const d = md > 0 ? md : n + 1 + md; if (d >= 1 && d <= n) out.push(withDay(base, y, mo, d)); } }
  else if (rule.byday.length) {
    for (const { n: ord, day } of rule.byday) {
      const days = [];
      for (let d = 1; d <= n; d++) if (weekdayOf({ y, mo, d }) === day) days.push(d);
      if (ord === 0) for (const d of days) out.push(withDay(base, y, mo, d));
      else { const d = ord > 0 ? days[ord - 1] : days[days.length + ord]; if (d) out.push(withDay(base, y, mo, d)); }
    }
  } else if (base.d <= n) out.push(withDay(base, y, mo, base.d));
  return out.sort((a, b) => a.d - b.d);
}

/** Every occurrence of a rule from `dtstart` (local parts, in `tz`) whose
 *  start falls in [`fromMs`, `toMs`], honouring COUNT and UNTIL, as
 *  instants in order. EXDATEs are left out but still count toward COUNT,
 *  as RFC 5545 says.
 *
 *  **A rule without COUNT starts near `fromMs`, not at DTSTART.** A daily
 *  standup created years ago is thousands of occurrences before today, and
 *  walking them all every poll would either cost a lot or — with a cap —
 *  stop before today and lose the meeting. With COUNT the walk has to start
 *  at the beginning to count, and COUNT itself bounds it. `cap` bounds what
 *  is walked after the start either way. */
export function expandRrule(rule, dtstart, tz, { fromMs = -Infinity, toMs, exdates = new Set(), cap = 5000 } = {}) {
  const out = [];
  const startMs = zonedToUtc(dtstart, tz);
  let until = null;
  if (rule.until) { const u = parseDate({ params: {}, value: rule.until }, tz); if (u) until = u.allDay ? u.ms + DAY - 1 : u.ms; }
  // How many periods to skip: one fewer than the whole periods between
  // DTSTART and the window, rounded down to the interval — a margin, so a
  // clock change or a short month never skips an occurrence that counts.
  const skip = (periods) => (rule.count == null && Number.isFinite(fromMs) && fromMs > startMs ? Math.max(0, Math.floor(periods / rule.interval) - 1) * rule.interval : 0);
  const from = Number.isFinite(fromMs) ? partsIn(fromMs, tz) : dtstart;
  let count = 0, walked = 0;
  const push = (p) => {
    const ms = zonedToUtc(p, tz);
    if (ms < startMs) return true;
    if (until != null && ms > until) return false;
    if (rule.count != null && ++count > rule.count) return false;
    if (ms > toMs) return false;
    if (ms >= fromMs && !exdates.has(ms)) out.push(ms);
    return ++walked < cap;
  };
  const F = rule.freq;
  if (F === 'DAILY') {
    for (let i = skip(dayNumber(from) - dayNumber(dtstart)); ; i += rule.interval) if (!push(addDays(dtstart, i))) break;
  } else if (F === 'WEEKLY') {
    const days = rule.byday.length ? rule.byday.map((b) => b.day) : [weekdayOf(dtstart)];
    const wk = Math.max(0, WEEKDAYS.indexOf(rule.wkst));
    const order = [...new Set(days.map((d) => ((d - wk) % 7 + 7) % 7))].sort((a, b) => a - b);
    const weekStart = addDays(dtstart, -(((weekdayOf(dtstart) - wk) % 7 + 7) % 7));
    outer: for (let w = skip(Math.floor((dayNumber(from) - dayNumber(weekStart)) / 7)); ; w += rule.interval) for (const o of order) if (!push(addDays(weekStart, w * 7 + o))) break outer;
  } else if (F === 'MONTHLY') {
    const k0 = skip((from.y - dtstart.y) * 12 + (from.mo - dtstart.mo));
    outer: for (let k = k0; k - k0 <= 12 * 200; k += rule.interval) {
      const t = dtstart.mo - 1 + k, y = dtstart.y + Math.floor(t / 12), mo = (t % 12) + 1;
      for (const p of monthCandidates(rule, y, mo, dtstart)) if (!push(p)) break outer;
    }
  } else if (F === 'YEARLY') {
    const months = rule.bymonth.length ? [...rule.bymonth].sort((a, b) => a - b) : [dtstart.mo];
    const byDay = rule.bymonthday.length || rule.byday.length;
    const k0 = skip(from.y - dtstart.y);
    outer: for (let k = k0; k - k0 <= 200; k += rule.interval) {
      for (const mo of months) {
        const y = dtstart.y + k;
        // 29 February in a year without one is not an occurrence (RFC 5545),
        // not 1 March.
        const cands = byDay ? monthCandidates(rule, y, mo, dtstart) : dtstart.d <= daysInMonth(y, mo) ? [withDay(dtstart, y, mo, dtstart.d)] : [];
        for (const p of cands) if (!push(p)) break outer;
      }
    }
  } else if (startMs >= fromMs && startMs <= toMs) out.push(startMs);   // a FREQ this does not know: the first occurrence, honestly
  return out;
}

/** Every instance of every event that overlaps [fromMs, toMs]:
 *  `{ ev, uid, start, end, allDay, recurrenceId, tz }`, with RECURRENCE-ID
 *  overrides applied — an override replaces the occurrence it names, keeps
 *  that occurrence's identity, and a cancelled one removes it — and `start`
 *  and `end` as instants. */
export function instances(events, { fromMs, toMs, tz = 'UTC' } = {}) {
  const masters = [], overrides = new Map();
  for (const ev of events) {
    const uid = text(ev, 'UID');
    if (!uid) continue;
    const rid = prop(ev, 'RECURRENCE-ID');
    if (rid) { const d = parseDate(rid, tz); if (d) { if (!overrides.has(uid)) overrides.set(uid, new Map()); overrides.get(uid).set(d.ms, ev); } }
    else masters.push(ev);
  }
  const out = [];
  const one = (ev, uid, startMs, recurrenceId, base) => {
    const s = base ?? parseDate(prop(ev, 'DTSTART'), tz);
    if (!s) return;
    const e = parseDate(prop(ev, 'DTEND'), tz);
    const dur = e ? Math.max(0, e.ms - s.ms) : (parseDuration(text(ev, 'DURATION')) ?? (s.allDay ? DAY : 0));
    const start = startMs ?? s.ms, end = start + dur;
    // A zero-length event is still in the window at its own instant.
    if (end < fromMs || start > toMs) return;
    out.push({ ev, uid, start, end, allDay: s.allDay, recurrenceId, tz: s.tz });
  };
  const handled = new Set();   // `${uid}@${rid}` of every override already placed
  for (const ev of masters) {
    const uid = text(ev, 'UID');
    const s = parseDate(prop(ev, 'DTSTART'), tz);
    if (!s) continue;
    const rrule = text(ev, 'RRULE');
    if (!rrule) { one(ev, uid, null, null, s); continue; }
    const e = parseDate(prop(ev, 'DTEND'), tz);
    const dur = e ? Math.max(0, e.ms - s.ms) : (parseDuration(text(ev, 'DURATION')) ?? (s.allDay ? DAY : 0));
    const exdates = new Set();
    for (const x of ev.EXDATE || []) for (const v of x.value.split(',')) { const d = parseDate({ params: x.params, value: v }, s.tz); if (d) exdates.add(d.ms); }
    const ov = overrides.get(uid) || new Map();
    // From one duration before the window, so an occurrence that began
    // before it and is still running is found.
    for (const ms of expandRrule(parseRrule(rrule), s.parts, s.tz, { fromMs: fromMs - dur, toMs, exdates })) {
      const o = ov.get(ms);
      if (o) {
        handled.add(`${uid}@${ms}`);
        if ((text(o, 'STATUS') || '').toUpperCase() !== 'CANCELLED') one(o, uid, null, ms);
        continue;
      }
      one(ev, uid, ms, ms, s);
    }
  }
  // An override not placed above — its master is not in the feed, or the
  // occurrence it replaces is outside the window while the moved one is
  // inside — stands on its own; `one` keeps it only if it overlaps.
  for (const [uid, m] of overrides) for (const [rid, ev] of m) {
    if (handled.has(`${uid}@${rid}`) || (text(ev, 'STATUS') || '').toUpperCase() === 'CANCELLED') continue;
    one(ev, uid, null, rid);
  }
  return out;
}

/** `mailto:ann@example.com` -> `ann@example.com`. */
export const address = (v) => String(v || '').replace(/^mailto:/i, '').trim().toLowerCase();

/** A conference link, from the properties that carry one, else from the
 *  description and location. */
export function joinLink(ev) {
  for (const n of ['X-GOOGLE-CONFERENCE', 'CONFERENCE', 'X-MICROSOFT-SKYPETEAMSMEETINGURL']) { const p = prop(ev, n); if (p && /^https?:\/\//i.test(p.value)) return p.value.trim(); }
  const hay = `${text(ev, 'LOCATION') || ''}\n${text(ev, 'DESCRIPTION') || ''}`;
  const m = /https?:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us\/j|teams\.microsoft\.com\/l\/meetup-join|[\w.-]*whereby\.com|meet\.jit\.si)[^\s<>"')]*/i.exec(hay);
  return m ? m[0] : null;
}
