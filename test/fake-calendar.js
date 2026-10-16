// The calendar, both ways it is read: an ICS feed built from a list of
// events (below, `ics()` and `demoIcs()` — the default path, plan §16 G4),
// and the Google path's API. The Google half leaves with the Google path.
//
// A GoogleApi stand-in, the shape test/fake-github.js sets: routes to
// fixtures, counts calls, refreshes a token like the real one and can be
// told to answer 410 (the sync token aged out), 401 (the access token did)
// or `invalid_grant` (the refresh token is dead).
//
// The calendar is modelled as a list of events with an `updated` stamp, so
// the fake answers both halves for real: a full sync returns everything from
// `timeMin` on and mints a token, and an incremental sync returns only what
// was updated after that token was minted. That is what makes the source's
// cursor testable without a Google project. `api.clock` is when the fake
// thinks it is — move it forward and the same fixtures become "changed".
import { GoogleApi } from '../lib/google-api.js';

export function fakeCalendar(events = [], { fail = null, clock = '2026-09-09T12:00:00.000Z' } = {}) {
  const calls = [];
  const stamps = new Map();     // sync token -> the moment it was minted
  let n = 0;
  const api = new GoogleApi({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt', fetch: (url, init) => call(url, init) });
  api.clock = clock;
  api.calls = calls;
  api.events = events;
  async function call(url, { method = 'GET', body } = {}) {
    const u = new URL(url);
    calls.push(`${method} ${u.pathname}${u.search}`);
    if (u.origin + u.pathname === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(body || '');
      if (fail === 'invalid_grant') return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      if (form.get('grant_type') !== 'refresh_token' || !form.get('refresh_token')) return json(400, { error: 'invalid_request' });
      return json(200, { access_token: `at-${++n}`, expires_in: 3600, token_type: 'Bearer' });
    }
    if (fail === '401') { fail = null; return json(401, { error: { code: 401, message: 'Invalid Credentials' } }); }
    const q = u.searchParams;
    const sync = q.get('syncToken');
    if (sync && (fail === '410' || !stamps.has(sync))) { fail = null; return json(410, { error: { code: 410, message: 'Sync token is no longer valid, a full sync is required.', errors: [{ reason: 'fullSyncRequired' }] } }); }
    let list;
    if (sync) list = api.events.filter((e) => (e.updated || '') > stamps.get(sync));
    else {
      const min = q.get('timeMin'), max = q.get('timeMax');
      list = api.events.filter((e) => {
        if (e.status === 'cancelled' && q.get('showDeleted') !== 'true') return false;
        const end = e.end?.dateTime || e.end?.date || e.start?.dateTime || e.start?.date || '';
        const start = e.start?.dateTime || e.start?.date || '';
        return (!min || end >= min) && (!max || start <= max);
      });
    }
    const body_ = { kind: 'calendar#events', items: list };
    // Google mints a token on any request that did not carry one. What it
    // refuses is timeMin/timeMax *beside* a token, which is why the source
    // filters the window itself — and `fail: 'notoken'` is the pessimistic
    // reading, where a time-restricted full sync mints none at all.
    if (fail !== 'notoken') { const t = `sync-${++n}`; stamps.set(t, api.clock); body_.nextSyncToken = t; }
    return json(200, body_);
  }
  return api;
}

const json = (status, body) => ({ status, ok: status < 400, statusText: String(status), headers: new Headers(), text: async () => JSON.stringify(body) });

const iso = (d) => new Date(d).toISOString();

/** A Google event resource, with the fields the source reads. */
export function event({ id, summary = 'A meeting', start, end = null, updated = '2026-09-09T12:00:00.000Z', status = 'confirmed', organizer = 'ann@example.com', mine = false, attendees = null, location = null, hangout = null, allDay = false, description = null, recurringEventId = null }) {
  return {
    kind: 'calendar#event', id, status, summary, description,
    htmlLink: `https://calendar.google.com/event?eid=${id}`,
    updated,
    start: allDay ? { date: start } : { dateTime: iso(start) },
    end: allDay ? { date: end || start } : { dateTime: iso(end || new Date(Date.parse(start) + 1_800_000)) },
    location,
    creator: { email: mine ? 'alice@example.com' : organizer, self: mine },
    organizer: { email: mine ? 'alice@example.com' : organizer, displayName: mine ? null : organizer, self: mine },
    ...(hangout ? { hangoutLink: hangout } : {}),
    ...(attendees ? { attendees } : {}),
    ...(recurringEventId ? { recurringEventId } : {}),
  };
}

/** An attendee line. `self: true` is you; `response` is what you answered. */
export const attendee = (email, { self = false, response = 'accepted', name = null } = {}) => ({ email, self, responseStatus: response, ...(name ? { displayName: name } : {}) });
export const me = (response = 'accepted') => attendee('alice@example.com', { self: true, response });

/** A calendar shaped like a working day, relative to `now` — what
 *  `TRIAGE_CALENDAR=fake` runs a worktree against so the whole flow (poll,
 *  the clock's alarm, the rules, the P0 DM, the page) can
 *  be seen without a Google project. Obviously fake: every title says so.
 *
 *  It has one of each thing the rules exist to separate — something about to
 *  start, an unanswered invitation, an ordinary meeting today, an all-day
 *  entry, your own focus block, one you declined, and one a week out that
 *  the window should not show yet. */
export function demoCalendar({ now = () => new Date() } = {}) {
  const t = now().getTime();
  const at_ = (min) => new Date(t + min * 60_000).toISOString();
  const stamp = new Date(t - 3_600_000).toISOString();
  const evs = [
    event({ id: 'demo-soon', summary: '(fake) Design review', start: at_(12), updated: stamp, organizer: 'ann@example.com', location: 'Room 2', hangout: 'https://meet.google.com/fake-demo-abc', attendees: [me(), attendee('ann@example.com', { name: 'Ann Lee' }), attendee('bob@example.com')] }),
    event({ id: 'demo-invite', summary: '(fake) Roadmap sync', start: at_(26 * 60), updated: stamp, organizer: 'bob@example.com', attendees: [me('needsAction'), attendee('bob@example.com', { name: 'Bob Ray' })] }),
    event({ id: 'demo-today', summary: '(fake) One-to-one', start: at_(5 * 60), updated: stamp, organizer: 'ann@example.com', attendees: [me(), attendee('ann@example.com', { name: 'Ann Lee' })] }),
    event({ id: 'demo-allday', summary: '(fake) Ann out of office', start: new Date(t + 86_400_000).toISOString().slice(0, 10), allDay: true, updated: stamp, mine: true }),
    event({ id: 'demo-solo', summary: '(fake) Focus block', start: at_(3 * 60), updated: stamp, mine: true }),
    event({ id: 'demo-declined', summary: '(fake) All-hands', start: at_(7 * 60), updated: stamp, organizer: 'bob@example.com', attendees: [me('declined'), attendee('bob@example.com')] }),
    event({ id: 'demo-far', summary: '(fake) Quarterly review', start: at_(7 * 24 * 60), updated: stamp, organizer: 'ann@example.com', attendees: [me(), attendee('ann@example.com')] }),
  ];
  return fakeCalendar(evs, { clock: stamp });
}

// --- the feed (plan §16, G4) ---------------------------------------------------
// The same calendar as an ICS text, built from a list of events, so the feed
// reader is tested and demonstrated with no feed on the network.
const icsStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const icsDay = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

/** One VEVENT. `start`/`end` are ISO strings or ms; `allDay` writes dates
 *  (`start` then names the UTC day); `tzid` writes a zoned local time. */
export function vevent({ uid, summary = 'A meeting', start, end = null, allDay = false, status = 'CONFIRMED', organizer = null, attendees = [], location = null, description = null, url = null, rrule = null, exdates = [], recurrenceId = null, updated = null, join = null, tzid = null, local = null }) {
  const s = typeof start === 'number' ? start : Date.parse(start);
  const e = end == null ? s + (allDay ? 86_400_000 : 1_800_000) : typeof end === 'number' ? end : Date.parse(end);
  const lines = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsStamp(updated ? Date.parse(updated) : s)}`, `SUMMARY:${summary}`, `STATUS:${status}`];
  if (updated) lines.push(`LAST-MODIFIED:${icsStamp(Date.parse(updated))}`);
  if (local) lines.push(`DTSTART;TZID=${tzid}:${local}`);
  else lines.push(allDay ? `DTSTART;VALUE=DATE:${icsDay(s)}` : `DTSTART:${icsStamp(s)}`, allDay ? `DTEND;VALUE=DATE:${icsDay(e)}` : `DTEND:${icsStamp(e)}`);
  if (recurrenceId) lines.push(`RECURRENCE-ID:${icsStamp(Date.parse(recurrenceId))}`);
  if (rrule) lines.push(`RRULE:${rrule}`);
  for (const x of exdates) lines.push(`EXDATE:${icsStamp(Date.parse(x))}`);
  if (organizer) lines.push(`ORGANIZER;CN=${organizer.name || organizer.email}:mailto:${organizer.email}`);
  for (const a of attendees) lines.push(`ATTENDEE;CN=${a.name || a.email};PARTSTAT=${(a.response || 'ACCEPTED').toUpperCase()}:mailto:${a.email}`);
  if (location) lines.push(`LOCATION:${location}`);
  if (description) lines.push(`DESCRIPTION:${description.replace(/\n/g, '\\n')}`);
  if (url) lines.push(`URL:${url}`);
  if (join) lines.push(`X-GOOGLE-CONFERENCE:${join}`);
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

/** A whole feed. A string in the list is written as it is. */
export function ics(events, { name = 'Alice' } = {}) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//triage//fake//EN', ...(name ? [`X-WR-CALNAME:${name}`] : []), ...events.map((e) => (typeof e === 'string' ? e : vevent(e))), 'END:VCALENDAR', ''].join('\r\n');
}

/** People on an invitation, in the feed's terms. */
export const alice = (response = 'accepted') => ({ email: 'alice@example.com', name: 'Alice', response });
export const ann = { email: 'ann@example.com', name: 'Ann Lee' };
export const bob = { email: 'bob@example.com', name: 'Bob Ray' };

/** The working day of `demoCalendar`, as a feed — what `TRIAGE_CALENDAR=fake`
 *  and the demo read, since the feed is the default path. One of each thing
 *  the rules separate, and a daily standup that recurs, with an occurrence
 *  moved. Obviously fake: every title says so. Written once, relative to
 *  `now`, so an unchanged poll emits nothing. You are alice@example.com. */
export function demoIcs({ now = () => new Date() } = {}) {
  const t = now().getTime();
  const at = (min) => t + min * 60_000;
  const stamp = new Date(t - 3_600_000).toISOString();
  // The standup is at a fixed time of day, an hour and a half from now
  // yesterday — so today's is ninety minutes away and tomorrow's is moved.
  const first = at(-24 * 60 + 90);
  return ics([
    { uid: 'demo-soon', summary: '(fake) Design review', start: at(12), updated: stamp, organizer: ann, location: 'Room 2', join: 'https://meet.google.com/fake-demo-abc', attendees: [alice(), ann, bob] },
    { uid: 'demo-invite', summary: '(fake) Roadmap sync', start: at(26 * 60), updated: stamp, organizer: bob, attendees: [alice('needs-action'), bob] },
    { uid: 'demo-today', summary: '(fake) One-to-one', start: at(5 * 60), updated: stamp, organizer: ann, attendees: [alice(), ann] },
    { uid: 'demo-allday', summary: '(fake) Ann out of office', start: at(24 * 60), allDay: true, updated: stamp },
    { uid: 'demo-solo', summary: '(fake) Focus block', start: at(3 * 60), updated: stamp },
    { uid: 'demo-declined', summary: '(fake) All-hands', start: at(7 * 60), updated: stamp, organizer: bob, attendees: [alice('declined'), bob] },
    { uid: 'demo-standup', summary: '(fake) Standup', start: first, updated: stamp, organizer: ann, attendees: [alice(), ann, bob], rrule: 'FREQ=DAILY;COUNT=30' },
    { uid: 'demo-standup', summary: '(fake) Standup (moved)', start: first + 2 * 86_400_000 + 3_600_000, recurrenceId: new Date(first + 2 * 86_400_000).toISOString(), updated: stamp, organizer: ann, attendees: [alice(), ann, bob] },
    { uid: 'demo-far', summary: '(fake) Quarterly review', start: at(7 * 24 * 60), updated: stamp, organizer: ann, attendees: [alice(), ann] },
  ], { name: 'Alice (fake)' });
}
