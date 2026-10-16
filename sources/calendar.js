// calendar — the second source (plan §5), and the proof that the seam is not
// GitHub-shaped. Reads one Google calendar with `events.list`, owns a
// `syncToken` as its cursor, and turns the events starting in the next 48 h
// into items. Never writes: not to the store, and not to Google — the scope
// is `calendar.readonly`, so Done on a calendar item is local (lib/actions.js).
//
// Two things happen here, and they are deliberately separate:
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
import { oneLine } from '../lib/util.js';

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

  /** @returns {Promise<{batches: Array<{item, events}>, cursor, status}>} */
  async poll({ api, cursor, now = new Date(), log = () => {}, calendarId = 'primary', windowMs = WINDOW_MS }) {
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

  /** What /api/sources shows. Never the sync token itself: it is opaque
   *  state, it is long, and nothing is learned by printing it. */
  describeCursor(state) {
    if (!state || typeof state !== 'object') return state;
    return { sync_token: state.sync_token ? 'held' : null, synced_at: state.synced_at || null, upcoming: Object.keys(state.upcoming || {}).length };
  },
};
