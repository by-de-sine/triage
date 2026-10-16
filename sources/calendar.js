// calendar — the second source (plan §5), and the proof that the seam is not
// GitHub-shaped. Two readers of one calendar, picked by what the context
// carries, and the rest — the item's shape, the rules, the clock, the curve,
// the project — shared:
//
//   - **an ICS feed** (plan §16, G4; `feed` in the context), the default:
//     every calendar publishes one — Google's "secret address in iCal
//     format", Outlook's "publish calendar", a Fastmail or Apple
//     subscription URL — so there is no OAuth client and no consent step;
//     the URL is the credential. Read whole (conditionally, and at most
//     every few minutes), expanded with lib/ics.js, and **state**: an event
//     gone from the feed is resolved by `reconcile`. Below the Google half.
//   - **Google's `events.list`** (`api` in the context), the path M3 built,
//     kept behind its own configuration until the feed has run a week in
//     production (plan §16.7 item b).
//
// Neither writes: not to the store, and not to the calendar — Done on a
// calendar item is local (lib/actions.js).
//
// For the Google path, two things happen, and they are deliberately separate:
//
//   poll(ctx)   what Google says changed. `syncToken` is the whole cursor:
//               the first call is a full sync and every one after it asks
//               only for what moved. 410 means the token aged out — drop it
//               and full-sync again, which is Google's documented flow.
//   due(ctx)    what the *clock* says. "Starts in 15 minutes" is not
//               something a poll can discover — the poll that happens to
//               land at T-14 would be luck — so it is computed from the
//               starts already stored, exactly as lib/pipeline.js `wake`
//               computes a snooze that has ended. The runner calls it before
//               every poll, in its own try, so a Google outage does not stop
//               the alarm for a meeting it already knows about.
//
// Cursor: { sync_token, upcoming: { [event id]: start }, synced_at }.
// `upcoming` is the answer to a real gap: `timeMin`/`timeMax` cannot be sent
// with a `syncToken` (Google forbids it, to keep the token's state
// consistent), so the incremental sync reports changes across the whole
// calendar and the 48 h window is applied here. An event created a week out
// therefore arrives once, outside the window, and would never be heard of
// again — so its start is remembered, and the poll that finds it has entered
// the window fetches the window afresh. A full re-sync every 24 h is the
// backstop for anything past the lookahead.
//
// Event keys are `calendar:<eventId>:<updated>` (and
// `calendar:starts:<eventId>:<start>` for the alarm), so a restart, a
// re-poll and a second `due` in the same minute all re-emit nothing.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { oneLine, isLoopback } from '../lib/util.js';
import { parseIcs, instances, text, prop, address, joinLink, partsIn, ymd } from '../lib/ics.js';

export const WINDOW_MS = 48 * 3_600_000;    // items are events starting in this
export const SOON_MS = 15 * 60_000;         // the P0 lead time
const LOOKAHEAD_MS = 31 * 86_400_000;       // how far ahead `upcoming` remembers
const RESYNC_MS = 24 * 3_600_000;           // drop the sync token this often
const PAGE = 250;

/** The one place a Google event becomes an item. Everything a rule or the
 *  P0 DM needs is in `data`; nothing else is kept. */
export function normalise(ev, { calendarId = 'primary' } = {}) {
  const allDay = !ev.start?.dateTime && !!ev.start?.date;
  const start = ev.start?.dateTime || ev.start?.date || null;
  const end = ev.end?.dateTime || ev.end?.date || null;
  const attendees = (ev.attendees || []).filter((a) => !a.resource);
  const me = attendees.find((a) => a.self) || null;
  // Everyone but you. Counting yourself would make "your own event, no
  // guests" depend on whether Google listed you as an attendee of it, which
  // it does not always do — and it is the number the DM prints anyway.
  const guests = attendees.filter((a) => !a.self).length;
  const mine = !!ev.organizer?.self || !!ev.creator?.self;
  const organizer = ev.organizer?.displayName || ev.organizer?.email || null;
  const response = me?.responseStatus || (mine ? 'accepted' : null);
  const join = ev.hangoutLink || (ev.conferenceData?.entryPoints || []).find((p) => p.entryPointType === 'video')?.uri || null;
  const item = {
    source: 'calendar',
    key: ev.id,
    kind: 'event',
    title: ev.summary || '(no title)',
    url: ev.htmlLink || null,
    repo: null,                       // a calendar item has no repo; the lists
                                      // fall back to the source name
    actors: attendees.map((a) => a.displayName || a.email).filter(Boolean),
    my_role: mine ? 'organizer' : response === 'needsAction' ? 'invited' : me ? 'attendee' : 'subscribed',
    last_activity: ev.updated || start,
    last_seen: ev.updated || start,
    data: {
      calendar_id: calendarId, start, end, all_day: allDay, status: ev.status || 'confirmed',
      location: ev.location ? oneLine(ev.location, 120) : null, join, organizer, mine, response,
      guests,
      attendees: attendees.slice(0, 20).map((a) => ({ name: a.displayName || a.email, response: a.responseStatus || null, self: !!a.self })),
      recurring: !!ev.recurringEventId,
    },
  };
  // One event per change, keyed by what changed it. `invite` is the one the
  // P1 rule reads: an attendee line that is still `needsAction` is a question
  // nobody has answered, and that is what "a new invitation" means.
  const kind = item.data.status === 'cancelled' ? 'cancelled' : (response === 'needsAction' && !mine) ? 'invite' : 'update';
  const events = [{
    key: `calendar:${ev.id}:${ev.updated || start}`,
    ts: ev.updated || start,
    kind,
    actor: organizer,
    body: ev.description ? oneLine(ev.description, 600) : null,
    url: item.url,
    data: { start, all_day: allDay, response, guests, status: item.data.status },
  }];
  return { item, events };
}

const startsAt = (ev) => Date.parse(ev.start?.dateTime || ev.start?.date || '');

/** An incremental sync reports a deleted event as little more than its id and
 *  `status: cancelled` — usually with no `start` at all. That still has to
 *  reach the store, or the item keeps the start it had and `due()` goes on
 *  alarming a meeting that no longer exists. Only the fields that should
 *  change are set: `upsertItem` keeps the rest of the row, and clearing the
 *  start is what makes the alarm impossible rather than merely unlikely. */
function cancellation(ev, calendarId) {
  const ts = ev.updated || new Date().toISOString();
  return {
    item: { source: 'calendar', key: ev.id, kind: 'event', title: ev.summary ?? undefined, url: ev.htmlLink ?? undefined, last_activity: ts, last_seen: ts,
      data: { calendar_id: calendarId, start: null, end: null, all_day: false, status: 'cancelled', location: null, join: null, organizer: null, mine: false, response: null, guests: 0, attendees: [], recurring: false } },
    events: [{ key: `calendar:${ev.id}:${ts}`, ts, kind: 'cancelled', actor: null, body: null, url: ev.htmlLink || null, data: { start: null, status: 'cancelled' } }],
  };
}

/** One read of the calendar: incremental when a token is held, a full sync
 *  when it is not. `timeMin`/`timeMax` may not be sent with a `syncToken`
 *  (Google's rule, so the token's state stays consistent), which is exactly
 *  why the 48 h window is applied above rather than asked for here. */
function read(api, path, syncToken, now) {
  const params = syncToken
    // `showDeleted` only on the incremental sync: that is where a deletion is
    // news. A full sync is establishing a view from nothing, and a month of
    // tombstones in it would become a month of P3 items about meetings that
    // are not happening.
    ? { syncToken, singleEvents: 'true', showDeleted: 'true', maxResults: PAGE }
    // The full sync reaches a month out — far enough that `upcoming` has
    // something to remember, and bounded, which matters: `singleEvents=true`
    // expands recurring events into instances, so an open-ended full sync on
    // a calendar with a daily standup in it is an unbounded read.
    : { singleEvents: 'true', showDeleted: 'false', maxResults: PAGE, timeMin: now.toISOString(), timeMax: new Date(now.getTime() + LOOKAHEAD_MS).toISOString() };
  return api.list(path, { params, pages: 20 });
}

export default {
  name: 'calendar',
  every: 60_000,
  describe: 'events.list on the primary calendar with a syncToken; items are events starting in the next 48 h, and the 15-minute alarm runs on the clock, not the poll',

  /** M5: a meeting spikes as it approaches and is worthless once it has been
   *  running an hour — the one curve a thread's could never be (plan §11.4
   *  item 2). An all-day entry has no minute to be late for, so time says
   *  nothing about it rather than saying zero. */
  //  A cancelled or declined event is the exception that proves the seam:
  //  it still has a timed start, so the clock alone would give it the spike
  //  and float it up the list in the quarter hour before a meeting nobody is
  //  going to. The rules know it is not happening; the curve reads them.
  time: (item, { rules = [] } = {}) => (item.data?.all_day || rules.includes('cancelled') || rules.includes('declined') ? 'flat' : 'spike'),

  /** Plan §14.3: the calendar the event came from. A shared team calendar
   *  and your own are genuinely different projects — "never buzz me for the
   *  on-call rota" is a sentence somebody will want to write — and the id
   *  is already on every item, put there by `normalise`. */
  project: (item) => item.data?.calendar_id || null,

  /** The feed when the context names one, else Google.
   *  @returns {Promise<{batches: Array<{item, events}>, cursor, status}>} */
  poll(ctx) { return ctx.feed ? pollFeed(ctx) : this.pollGoogle(ctx); },

  async pollGoogle({ api, cursor, now = new Date(), log = () => {}, calendarId = 'primary', windowMs = WINDOW_MS }) {
    const prev = cursor || {};
    const path = `/calendars/${encodeURIComponent(calendarId)}/events`;
    const t = now.getTime();
    const stale = !prev.synced_at || t - Date.parse(prev.synced_at) > RESYNC_MS;
    let syncToken = stale ? null : prev.sync_token || null;
    let how = syncToken ? 'incremental' : (prev.sync_token ? 'full sync (24 h)' : 'full sync');
    let r;
    try {
      r = await read(api, path, syncToken, now);
    } catch (e) {
      if (e.status !== 410) throw e;
      log('sync token expired (410); full sync');
      syncToken = null; how = 'full sync (410)';
      r = await read(api, path, null, now);
    }
    // A time-restricted full sync should still mint a token; if Google ever
    // declines to, every poll is a full sync of one bounded month — a page or
    // two a minute, correct but not cheap. Say so once per poll rather than
    // letting it look like the incremental path.
    if (!syncToken && !r.syncToken) log('no sync token from the full sync; the next poll is another full sync');
    // Anything remembered as beyond the window that has now entered it: ask
    // for the window itself rather than guessing what else moved with it.
    const upcoming = { ...(prev.upcoming || {}) };
    const entered = Object.entries(upcoming).filter(([, s]) => { const ms = Date.parse(s); return ms >= t && ms - t <= windowMs; });
    let complete = r.complete;
    if (entered.length) {
      const w = await api.list(path, { params: { singleEvents: 'true', showDeleted: 'false', maxResults: PAGE, timeMin: now.toISOString(), timeMax: new Date(t + windowMs).toISOString() }, pages: 20 });
      r.items.push(...w.items);
      complete = complete && w.complete;
      how += `, ${entered.length} entered the window`;
    }
    if (!complete) { how += ', PAGE CAP REACHED'; log(`the calendar is longer than ${20 * PAGE} entries; read what fitted and kept the cursor as it was`); }

    // Last write wins per event id: one poll can carry several revisions.
    const byId = new Map();
    for (const ev of r.items) if (ev?.id) byId.set(ev.id, ev);
    const batches = [];
    let ahead = 0;
    for (const ev of byId.values()) {
      const s = startsAt(ev);
      delete upcoming[ev.id];
      if (!Number.isFinite(s)) {
        // A tombstone from the incremental sync: no start, and that is the
        // point — an item that has one must lose it.
        if (ev.status === 'cancelled') batches.push(cancellation(ev, calendarId));
        continue;
      }
      if (s + 86_400_000 < t) continue;                     // long past; the window is ahead of us
      if (s - t > windowMs) {
        if (s - t <= LOOKAHEAD_MS) { upcoming[ev.id] = ev.start?.dateTime || ev.start?.date; ahead++; }
        continue;
      }
      batches.push(normalise(ev, { calendarId }));
    }
    // `upcoming` holds only what is still *ahead of* the window. Anything
    // inside it has either become an item above or is gone from the calendar;
    // either way it must leave, or a deleted event keeps triggering the
    // window read every minute for as long as its old start is in range.
    // Unless the read was cut short — then we did not see everything, and
    // forgetting on that basis is how an event goes missing for good.
    if (complete) for (const [id, s] of Object.entries(upcoming)) { const ms = Date.parse(s); if (!Number.isFinite(ms) || ms - t <= windowMs || ms - t > LOOKAHEAD_MS) delete upcoming[id]; }

    // A token is only replaced by a newer one: a walk cut short by the page
    // cap returns none, and forgetting the old one would re-read everything.
    // `synced_at` dates the last *full* sync, which is what RESYNC_MS times.
    const cursorOut = { sync_token: r.syncToken || syncToken || null, upcoming, synced_at: syncToken ? prev.synced_at : now.toISOString() };
    return { batches, cursor: cursorOut, status: `${how} — ${byId.size} changed, ${batches.length} in the next ${Math.round(windowMs / 3_600_000)} h, ${ahead} further out` };
  },

  /** The clock's half. Pure: the stored starts and `now`, nothing else. An
   *  event that is cancelled, all-day, or one you declined is never an
   *  alarm; one that has already begun is not either — you either made it or
   *  you did not, and a late alarm is noise. */
  due({ items = [], now = new Date(), soonMs = SOON_MS }) {
    const t = now.getTime();
    const batches = [];
    for (const item of items) {
      const d = item.data || {};
      if (d.all_day || d.status === 'cancelled' || d.response === 'declined') continue;
      const start = Date.parse(d.start || '');
      if (!Number.isFinite(start) || start < t || start - t > soonMs) continue;
      batches.push({
        item,
        events: [{ key: `calendar:starts:${item.key}:${d.start}`, ts: d.start, kind: 'starts', actor: null, body: null, url: item.url, data: { start: d.start, in_min: Math.round((start - t) / 60_000) } }],
      });
    }
    // No log line here: the alarm is keyed, so it repeats every minute until
    // the meeting begins and only the first one decides anything. The runner
    // logs the run that produced a verdict, which is the one worth reading.
    return { batches };
  },

  /** The state half, for the feed: what the last complete read held. An
   *  event gone from the feed is resolved, attributed to the source; an item
   *  whose start is outside the window the read covered is not the set's to
   *  speak for — a meeting from last week did not leave the calendar, it
   *  left the window. The Google path never resolved, and still does not:
   *  its sync is incremental, so it has no whole set to hand over. */
  reconcile({ cursor, now = new Date(), windowMs = WINDOW_MS }) {
    if (!cursor || cursor.reader !== 'ics' || !cursor.fetched_at) return null;
    const t = now.getTime();
    return { keys: Object.keys(cursor.hashes || {}), complete: !!cursor.ok, error: cursor.error || null,
      governs: (item) => { const s = Date.parse(item.data?.start || ''); return Number.isFinite(s) && s >= t - DAY && s - t <= windowMs; } };
  },

  /** What /api/sources shows. Never the sync token itself — it is opaque
   *  state, it is long, and nothing is learned by printing it — and never
   *  the feed's URL, which is the credential. */
  describeCursor(state) {
    if (!state || typeof state !== 'object') return state;
    if (state.reader === 'ics') return { reader: 'ics', fetched_at: state.fetched_at || null, read_at: state.read_at || null, ok: !!state.ok, error: state.error || null, entries: state.count ?? null, in_window: Object.keys(state.hashes || {}).length, name: state.name || null };
    return { sync_token: state.sync_token ? 'held' : null, synced_at: state.synced_at || null, upcoming: Object.keys(state.upcoming || {}).length };
  },
};

// --- the feed ----------------------------------------------------------------
const DAY = 86_400_000;
export const FETCH_MS = 5 * 60_000;           // a URL is fetched at most this often
export const MAX_FEED_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REVISION_KEEP_MS = 30 * DAY;            // how long a revision outlives its instance leaving the window
const sha = (x) => createHash('sha1').update(x).digest('hex').slice(0, 12);
// What a 304, or a poll inside FETCH_MS, re-reads: per feed object, so two
// tests (or two feeds) never share one. Lost on a restart, and then the
// next poll simply fetches.
const fetched = new WeakMap();

/** Which addresses are you, from TRIAGE_CALENDAR_ME: comma- or space-separated. */
const addresses = (me) => new Set(String(me || '').split(/[,\s]+/).map((x) => address(x)).filter((x) => x.includes('@')));

/** `20260920T120000Z` -> ISO, or null. */
function isoOf(v) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(String(v || '').trim());
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
  return null;
}

/** One instance of a feed's event -> `{ item, events }`, the same shape the
 *  Google half's `normalise` makes, so every rule, the clock, the curve and
 *  the message read both without knowing which. The item key is the UID,
 *  and `UID@<occurrence>` for one occurrence of a recurring event; the
 *  event key hashes what a rule reads, so a reschedule, a cancellation or
 *  an answer re-tiers it and an unchanged feed emits nothing. */
export function normaliseInstance(inst, { me = '', calendarId = 'calendar', revision = null } = {}) {
  const { ev, uid, start, end, allDay, recurrenceId, tz } = inst;
  const mine = addresses(me);
  const org = prop(ev, 'ORGANIZER');
  const organizerAddr = org ? address(org.value) : null;
  const attendees = (ev.ATTENDEE || []).filter((a) => !['RESOURCE', 'ROOM'].includes((a.params.CUTYPE || '').toUpperCase())).map((a) => {
    const addr = address(a.value);
    return { name: a.params.CN || addr, email: addr, response: (a.params.PARTSTAT || '').toLowerCase() || null, self: mine.has(addr) };
  });
  const self = attendees.find((a) => a.self) || null;
  const guests = attendees.filter((a) => !a.self).length;
  // Yours when you organise it, or when nobody is named at all — an entry
  // of your own in your own calendar has neither an organizer nor guests.
  const owned = !!(organizerAddr && mine.has(organizerAddr)) || (!org && attendees.length === 0);
  const organizer = org ? org.params.CN || organizerAddr : null;
  // Google's words for an answer, which the rules and the message already read.
  const part = self?.response || null;
  const response = part === 'needs-action' ? 'needsAction' : part || (owned ? 'accepted' : null);
  const status = (text(ev, 'STATUS') || 'confirmed').toLowerCase();
  // An all-day entry is a date, in the zone it was read in; a timed one an instant.
  const startIso = allDay ? ymd(partsIn(start, tz)) : new Date(start).toISOString();
  const endIso = allDay ? ymd(partsIn(end, tz)) : new Date(end).toISOString();
  const key = recurrenceId != null ? `${uid}@${new Date(recurrenceId).toISOString()}` : uid;
  const title = text(ev, 'SUMMARY') || '(no title)';
  // When it last changed, as the feed says; DTSTAMP last, because some
  // exporters stamp every event with the time of the export.
  const changed = isoOf(text(ev, 'LAST-MODIFIED')) || isoOf(text(ev, 'CREATED')) || isoOf(text(ev, 'DTSTAMP')) || startIso;
  const location = text(ev, 'LOCATION') ? oneLine(text(ev, 'LOCATION'), 120) : null;
  const item = {
    source: 'calendar', key, kind: 'event', title, url: text(ev, 'URL') || null, repo: null,
    actors: attendees.map((a) => a.name).filter(Boolean),
    my_role: owned ? 'organizer' : response === 'needsAction' ? 'invited' : self ? 'attendee' : 'subscribed',
    last_activity: changed, last_seen: changed,
    data: {
      calendar_id: calendarId, start: startIso, end: endIso, all_day: allDay, status,
      location, join: joinLink(ev), organizer, mine: owned, response, guests,
      attendees: attendees.slice(0, 20).map((a) => ({ name: a.name, response: a.response === 'needs-action' ? 'needsAction' : a.response, self: a.self })),
      recurring: recurrenceId != null,
    },
  };
  const hash = sha(JSON.stringify([title, startIso, endIso, status, location, response, guests, item.data.join, organizer, owned, calendarId]));
  const kind = status === 'cancelled' ? 'cancelled' : (response === 'needsAction' && !owned) ? 'invite' : 'update';
  // The revision is how many times this instance's hash has moved, kept in
  // the cursor: without it a change undone (10:00 → 11:00 → 10:00) would
  // repeat the first state's key and be dropped as already seen.
  const events = [{ key: `calendar:${key}:${hash}${revision != null ? `:${revision}` : ''}`, ts: changed, kind, actor: organizer, body: text(ev, 'DESCRIPTION') ? oneLine(text(ev, 'DESCRIPTION'), 600) : null, url: item.url, data: { start: startIso, all_day: allDay, response, guests, status } }];
  return { item, events, hash };
}

/** The feed's text: a literal or a function of nothing (the tests, the
 *  fake), a file, or a URL — fetched at most every `fetchMs`, and then
 *  conditionally, so a feed that has not changed costs a 304. */
async function readFeed(feed, { now, fetchMs, fetch }) {
  if (feed.text != null) return { text: typeof feed.text === 'function' ? feed.text() : feed.text, how: 'read' };
  if (feed.file) return { text: readFileSync(feed.file, 'utf8'), how: 'read' };
  const c = fetched.get(feed);
  if (c && now.getTime() - c.at < fetchMs) return { ...c, how: 'cached' };
  const headers = { accept: 'text/calendar, */*;q=0.5', 'user-agent': 'triage' };
  if (c?.etag) headers['if-none-match'] = c.etag;
  if (c?.last_modified) headers['if-modified-since'] = c.last_modified;
  // Redirects are followed by hand, at most five, and **only to https** (or
  // loopback, for a listener of your own): fetch's own following would take
  // an https feed to plain http without a word. Not refused outright,
  // because real feeds redirect — iCloud's `webcal` address answers with
  // the partition that holds the calendar. Nothing secret travels with the
  // hop: the secret is the original path, and only the server's answer is
  // followed.
  const signal = AbortSignal.timeout(30_000);
  let url = feed.url, res;
  for (let hop = 0; ; hop++) {
    res = await fetch(url, { headers, redirect: 'manual', signal });
    if (res.status < 300 || res.status >= 400 || res.status === 304) break;
    const loc = res.headers.get('location');
    if (!loc) throw new Error(`the feed answered HTTP ${res.status} with no Location`);
    if (hop >= MAX_REDIRECTS) throw new Error(`the feed redirected more than ${MAX_REDIRECTS} times`);
    const next = new URL(loc, url);
    if (next.protocol !== 'https:' && !(next.protocol === 'http:' && isLoopback(next.href))) throw new Error(`the feed redirected to ${next.protocol}//${next.host} — only https is followed`);
    url = next.href;
  }
  // The status and nothing else: the URL is the credential, and it is never
  // in a message, a log line or the cursor.
  if (res.status === 304 && c) { fetched.set(feed, { ...c, at: now.getTime() }); return { ...c, how: 'not modified' }; }
  if (!res.ok) throw new Error(`the feed answered HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_FEED_BYTES) throw new Error(`the feed is larger than ${MAX_FEED_BYTES >> 20} MB`);
  const body = await boundedText(res, MAX_FEED_BYTES);
  if (!/BEGIN:VCALENDAR/i.test(body.slice(0, 4096))) throw new Error('the feed is not a calendar (no BEGIN:VCALENDAR)');
  const out = { text: body, etag: res.headers.get('etag'), last_modified: res.headers.get('last-modified'), at: now.getTime() };
  fetched.set(feed, out);
  return { ...out, how: 'fetched' };
}

/** A response body as text, abandoned the moment it passes `max` bytes
 *  rather than held whole and measured after — a feed that does not send
 *  Content-Length is otherwise as large as it likes. */
async function boundedText(res, max) {
  const tooBig = () => new Error(`the feed is larger than ${max >> 20} MB`);
  const reader = res.body?.getReader?.();
  if (!reader) { const t = await res.text(); if (Buffer.byteLength(t) > max) throw tooBig(); return t; }
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => {}); throw tooBig(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One poll of the feed. Expands the window — from a day back, so a meeting
 *  that just ended is still spoken for, to `windowMs` ahead — and emits only
 *  the instances whose hash moved since the last read. The cursor's
 *  `hashes` is the whole set, which is what `reconcile` hands the runner.
 *  A read that fails keeps the last set and says it is not complete, so
 *  nothing is resolved on the strength of an outage. */
export async function pollFeed({ feed, cursor, me = '', now = new Date(), windowMs = WINDOW_MS, calendarId = null, tz = 'UTC', fetchMs = FETCH_MS, fetch = globalThis.fetch }) {
  const prev = cursor?.reader === 'ics' ? cursor : {};
  const t = now.getTime();
  let r;
  try { r = await readFeed(feed, { now, fetchMs, fetch }); }
  catch (e) {
    const error = e.name === 'TimeoutError' ? 'the feed did not answer in 30 s' : e.message;
    return { batches: [], cursor: { ...prev, reader: 'ics', ok: false, error, read_at: now.toISOString(), fetched_at: prev.fetched_at || now.toISOString() }, status: `feed not read: ${error}` };
  }
  const { events, name } = parseIcs(r.text);
  const id = calendarId || name || feed.name || 'calendar';
  const old = prev.hashes || {};
  // Each instance's revision — `{ n, at }`, the count of hash changes and
  // when it was last in the window — outlives the instance leaving the
  // window by a month, so one that is moved out and back counts on from
  // where it was rather than repeating a key it has used.
  const revisions = {};
  for (const [k, r] of Object.entries(prev.revisions || {})) if (t - Date.parse(r.at) <= REVISION_KEEP_MS) revisions[k] = r;
  const hashes = {}, batches = [];
  for (const inst of instances(events, { fromMs: t - DAY, toMs: t + windowMs, tz })) {
    const key = normaliseInstance(inst, { me, calendarId: id });
    const k = key.item.key;
    hashes[k] = key.hash;
    const r = revisions[k] || { n: 0 };
    const moved = old[k] !== key.hash;
    revisions[k] = { n: r.n + (moved ? 1 : 0), at: now.toISOString() };
    if (moved) { const b = normaliseInstance(inst, { me, calendarId: id, revision: revisions[k].n }); batches.push({ item: b.item, events: b.events }); }
  }
  return {
    batches,
    cursor: { reader: 'ics', fetched_at: r.how === 'cached' ? prev.fetched_at || now.toISOString() : now.toISOString(), read_at: now.toISOString(), etag: r.etag || null, last_modified: r.last_modified || null, hashes, revisions, ok: true, error: null, count: events.length, name: name || null },
    status: `${r.how} — ${events.length} entries, ${Object.keys(hashes).length} in the window, ${batches.length} changed`,
  };
}
