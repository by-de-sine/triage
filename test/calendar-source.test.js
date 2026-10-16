import { test } from 'node:test';
import assert from 'node:assert/strict';
import calendar, { normalise } from '../sources/calendar.js';
import { fakeCalendar, event, attendee, me } from './fake-calendar.js';
import { GoogleApi, readCredentials, GoogleError } from '../lib/google-api.js';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const at = (h) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const poll = (api, cursor = null, now = NOW, extra = {}) => calendar.poll({ api, cursor, now, ...extra });

function calendarOf() {
  return [
    event({ id: 'a', summary: 'Standup', start: at(1), attendees: [me(), attendee('ann@example.com')] }),
    event({ id: 'b', summary: 'Design review', start: at(30), organizer: 'bob@example.com', attendees: [me('needsAction'), attendee('bob@example.com')] }),
    event({ id: 'c', summary: 'Dentist', start: at(200), mine: true }),        // past the window
    event({ id: 'd', summary: 'Long ago', start: at(-100), mine: true }),      // past
  ];
}

test('a full sync takes the window, remembers what is further out, and keeps the token', async () => {
  const api = fakeCalendar(calendarOf());
  const r = await poll(api);
  assert.deepEqual(r.batches.map((b) => b.item.key), ['a', 'b']);
  assert.equal(r.cursor.sync_token, 'sync-2');           // one refresh, then one list
  assert.deepEqual(Object.keys(r.cursor.upcoming), ['c']);
  assert.equal(r.cursor.synced_at, NOW.toISOString());
  assert.match(r.status, /full sync — 3 changed, 2 in the next 48 h, 1 further out/);
  // The full sync is bounded at a month: singleEvents=true expands recurring
  // events into instances, so an open-ended one is an unbounded read.
  const list = api.calls.find((c) => c.includes('/events'));
  assert.match(list, /timeMin=2026-09-09T12/);
  assert.match(list, /timeMax=2026-10-10T12/);
});

test('the second poll is incremental and costs one list; nothing changed means no batches', async () => {
  const api = fakeCalendar(calendarOf());
  const first = await poll(api);
  api.calls.length = 0;
  const second = await poll(api, first.cursor, new Date(NOW.getTime() + 60_000));
  assert.equal(second.batches.length, 0);
  assert.equal(api.calls.filter((c) => c.includes('/events')).length, 1);
  assert.match(api.calls.find((c) => c.includes('/events')), /syncToken=sync-2/);
  assert.match(second.status, /^incremental/);
  // The token advances; the last full sync's date does not.
  assert.equal(second.cursor.sync_token, 'sync-3');
  assert.equal(second.cursor.synced_at, NOW.toISOString());
});

test('an event that moves comes back through the sync token alone', async () => {
  const api = fakeCalendar(calendarOf());
  const first = await poll(api);
  api.events[0] = event({ id: 'a', summary: 'Standup (moved)', start: at(2), updated: '2026-09-09T12:30:00.000Z', attendees: [me(), attendee('ann@example.com')] });
  const r = await poll(api, first.cursor, new Date(NOW.getTime() + 1_800_000));
  assert.equal(r.batches.length, 1);
  assert.equal(r.batches[0].item.title, 'Standup (moved)');
  assert.equal(r.batches[0].events[0].key, 'calendar:a:2026-09-09T12:30:00.000Z');
  assert.equal(r.batches[0].events[0].kind, 'update');
});

test('an expired sync token (410) falls back to a full sync in the same poll', async () => {
  const api = fakeCalendar(calendarOf());
  const first = await poll(api);
  const logs = [];
  const api2 = fakeCalendar(calendarOf(), { fail: '410' });
  const r = await calendar.poll({ api: api2, cursor: first.cursor, now: NOW, log: (m) => logs.push(m) });
  assert.match(r.status, /full sync \(410\)/);
  assert.deepEqual(r.batches.map((b) => b.item.key), ['a', 'b']);
  assert.ok(r.cursor.sync_token);
  assert.match(logs[0], /sync token expired/);
});

test('an event that enters the window is picked up, and the cursor forgets it', async () => {
  const api = fakeCalendar(calendarOf());
  const first = await poll(api);
  assert.deepEqual(Object.keys(first.cursor.upcoming), ['c']);
  // Eight days later 'c' (at +200 h) is inside the 48 h window, and nothing
  // about it changed — only the clock did, so only the window list finds it.
  const later = new Date(NOW.getTime() + 160 * 3_600_000);
  api.clock = later.toISOString();
  const r = await poll(api, { ...first.cursor, synced_at: later.toISOString() }, later);
  assert.ok(r.batches.some((b) => b.item.key === 'c'), 'c entered the window');
  assert.deepEqual(Object.keys(r.cursor.upcoming), []);
  assert.match(r.status, /1 entered the window/);
  // The window was asked for by time, not by token — a sync token cannot
  // carry timeMin/timeMax, which is the whole reason `upcoming` exists.
  const windowed = api.calls.filter((c) => /timeMax=2026-09-1[68]/.test(c));
  assert.equal(windowed.length, 1);
  assert.doesNotMatch(windowed[0], /syncToken/);
});

test('an event that left the calendar stops asking for the window every minute', async () => {
  const api = fakeCalendar(calendarOf());
  const first = await poll(api);
  assert.deepEqual(Object.keys(first.cursor.upcoming), ['c']);
  // 'c' is now inside the window — and has been deleted at Google, so no
  // read of any kind returns it. It must still leave the cursor: an entry
  // whose start is inside the window has either become an item or is gone.
  const later = new Date(NOW.getTime() + 160 * 3_600_000);
  api.clock = later.toISOString();
  api.events = api.events.filter((e) => e.id !== 'c');
  const r = await poll(api, { ...first.cursor, synced_at: later.toISOString() }, later);
  assert.equal(r.batches.some((b) => b.item.key === 'c'), false);
  assert.deepEqual(Object.keys(r.cursor.upcoming), []);
  api.calls.length = 0;
  await poll(api, r.cursor, new Date(later.getTime() + 60_000));
  assert.equal(api.calls.filter((c) => c.includes('timeMax=')).length, 0, 'no window read the second time');
});

test('a full sync that mints no token says so, and the next poll is another full sync', async () => {
  const api = fakeCalendar(calendarOf(), { fail: 'notoken' });
  const logs = [];
  const r = await calendar.poll({ api, cursor: null, now: NOW, log: (m) => logs.push(m) });
  assert.equal(r.batches.length, 2, 'the items are right either way');
  assert.equal(r.cursor.sync_token, null);
  assert.match(logs.at(-1), /no sync token from the full sync/);
  const again = await calendar.poll({ api, cursor: r.cursor, now: NOW, log: () => {} });
  assert.match(again.status, /^full sync —/);
  assert.equal(again.batches.length, 2);
});

test('the sync token is dropped and re-established every 24 h', async () => {
  const api = fakeCalendar(calendarOf());
  const first = await poll(api);
  const day = new Date(NOW.getTime() + 25 * 3_600_000);
  api.clock = day.toISOString();
  const r = await poll(api, first.cursor, day);
  assert.match(r.status, /full sync \(24 h\)/);
  assert.equal(r.cursor.synced_at, day.toISOString());
});

test('normalise: what a rule and the DM read off an event', () => {
  const b = normalise(event({ id: 'x', summary: 'Design review', start: at(2), organizer: 'bob@example.com', location: 'Room 2', hangout: 'https://meet.google.com/abc-defg-hij', attendees: [me('needsAction'), attendee('bob@example.com'), attendee('ann@example.com')] }));
  assert.equal(b.item.kind, 'event');
  assert.equal(b.item.repo, null);
  assert.equal(b.item.my_role, 'invited');
  assert.deepEqual(b.item.actors, ['alice@example.com', 'bob@example.com', 'ann@example.com']);
  assert.equal(b.item.data.join, 'https://meet.google.com/abc-defg-hij');
  assert.equal(b.item.data.location, 'Room 2');
  assert.equal(b.item.data.guests, 2, 'everyone but you');
  assert.equal(b.item.data.response, 'needsAction');
  assert.equal(b.item.data.mine, false);
  assert.equal(b.events[0].kind, 'invite');
  // Yours, no guests: the P3 the rules call `solo`.
  const solo = normalise(event({ id: 'y', summary: 'Focus', start: at(3), mine: true }));
  assert.equal(solo.item.my_role, 'organizer');
  assert.equal(solo.item.data.guests, 0);
  assert.equal(solo.item.data.mine, true);
  assert.equal(solo.events[0].kind, 'update');
  // All-day entries keep their date, and say so.
  const day = normalise(event({ id: 'z', summary: 'Holiday', start: '2026-09-11', allDay: true, mine: true }));
  assert.equal(day.item.data.all_day, true);
  assert.equal(day.item.data.start, '2026-09-11');
  // A cancelled event is an event: the rules tier it P3, they do not guess.
  const off = normalise(event({ id: 'w', summary: 'Cancelled', start: at(4), status: 'cancelled' }));
  assert.equal(off.events[0].kind, 'cancelled');
  assert.equal(off.item.data.status, 'cancelled');
});

test('due(): the clock, not the poll — one alarm per event, and never for what you are not going to', () => {
  const item = (over = {}) => ({ id: 1, key: 'a', url: 'u', data: { start: at(0.2), all_day: false, status: 'confirmed', response: 'accepted', ...over } });
  const r = calendar.due({ items: [item()], now: NOW });
  assert.equal(r.batches.length, 1);
  assert.equal(r.batches[0].events[0].kind, 'starts');
  assert.equal(r.batches[0].events[0].key, `calendar:starts:a:${at(0.2)}`);
  assert.equal(r.batches[0].events[0].data.in_min, 12);
  // The key is the same a minute later, so the store emits it once. That is
  // the whole reason the alarm is an event and not a message.
  const again = calendar.due({ items: [item()], now: new Date(NOW.getTime() + 60_000) });
  assert.equal(again.batches[0].events[0].key, r.batches[0].events[0].key);
  // Too early, already begun, declined, cancelled, all-day: no alarm.
  for (const [why, it] of [
    ['too early', item({ start: at(3) })],
    ['already begun', item({ start: at(-0.1) })],
    ['declined', item({ response: 'declined' })],
    ['cancelled', item({ status: 'cancelled' })],
    ['all day', item({ all_day: true })],
    ['no start', item({ start: null })],
  ]) assert.equal(calendar.due({ items: [it], now: NOW }).batches.length, 0, why);
});

test('a deleted event arrives as a bare tombstone, and loses the start the alarm reads', async () => {
  const api = fakeCalendar(calendarOf());
  const first = await poll(api);
  assert.ok(first.batches.find((b) => b.item.key === 'a').item.data.start);
  // What an incremental sync actually returns for a deletion: an id, a
  // status, and nothing else. No start to parse, and none needed.
  api.events = [{ kind: 'calendar#event', id: 'a', status: 'cancelled', updated: '2026-09-09T12:30:00.000Z' }];
  const r = await poll(api, first.cursor, new Date(NOW.getTime() + 1_800_000));
  const gone = r.batches.find((b) => b.item.key === 'a');
  assert.ok(gone, 'the tombstone became a batch');
  assert.equal(gone.item.data.status, 'cancelled');
  assert.equal(gone.item.data.start, null, 'no start means due() cannot alarm it');
  assert.equal(gone.events[0].kind, 'cancelled');
  // upsertItem keeps what the tombstone did not carry, so the row is still
  // readable on the page.
  assert.equal(gone.item.title, undefined);
  assert.equal(calendar.due({ items: [{ id: 1, key: 'a', url: 'u', data: gone.item.data }], now: NOW }).batches.length, 0);
  // And the rules call it P3, rather than any rule having to guess.
  const { default: calRules } = await import('../rules/calendar.js');
  const { decide } = await import('../lib/rules.js');
  assert.equal(decide(calRules, { ...gone.item, id: 1 }, gone.events, { me: 'alice', history: gone.events, now: NOW }).rule, 'cancelled');
});

test('a full sync asks for no tombstones; only the incremental sync wants them', async () => {
  const api = fakeCalendar(calendarOf());
  const first = await poll(api);
  assert.match(api.calls.find((c) => c.includes('/events')), /showDeleted=false/);
  api.calls.length = 0;
  await poll(api, first.cursor, new Date(NOW.getTime() + 60_000));
  assert.match(api.calls.find((c) => c.includes('/events')), /showDeleted=true/);
});

test('a read cut short by the page cap keeps its cursor and forgets nothing', async () => {
  // Every page links to another, so the walk ends at the cap and no sync
  // token is minted. The events already remembered must survive that.
  let n = 0;
  const api = new GoogleApi({ clientId: 'c', refreshToken: 'r', fetch: async (url) => {
    if (url.startsWith('https://oauth2')) return { status: 200, ok: true, headers: new Headers(), text: async () => JSON.stringify({ access_token: 'a', expires_in: 3600 }) };
    n++;
    return { status: 200, ok: true, headers: new Headers(), text: async () => JSON.stringify({ items: [], nextPageToken: `p${n}` }) };
  } });
  const logs = [];
  const before = { sync_token: 'sync-1', synced_at: NOW.toISOString(), upcoming: { c: at(200), d: at(20) } };
  const r = await calendar.poll({ api, cursor: before, now: NOW, log: (m) => logs.push(m) });
  assert.match(r.status, /PAGE CAP REACHED/);
  assert.match(logs.at(-1), /read what fitted and kept the cursor as it was/);
  assert.equal(r.cursor.sync_token, 'sync-1', 'the old token stands rather than being lost');
  assert.deepEqual(Object.keys(r.cursor.upcoming).sort(), ['c', 'd'], 'nothing is forgotten on an incomplete read');
});

test('describeCursor never prints the sync token', async () => {
  const api = fakeCalendar(calendarOf());
  const r = await poll(api);
  const d = calendar.describeCursor(r.cursor);
  assert.deepEqual(d, { sync_token: 'held', synced_at: NOW.toISOString(), upcoming: 1 });
  assert.doesNotMatch(JSON.stringify(d), /sync-\d/);
});

test('the access token is refreshed once, reused, and re-fetched on a 401', async () => {
  const api = fakeCalendar(calendarOf());
  await poll(api);
  await poll(api, null, NOW);
  assert.equal(api.calls.filter((c) => c.startsWith('POST /token')).length, 1, 'the second poll reused the token');
  const api2 = fakeCalendar(calendarOf(), { fail: '401' });
  const r = await poll(api2);
  assert.equal(r.batches.length, 2);
  assert.equal(api2.calls.filter((c) => c.startsWith('POST /token')).length, 2, 'refreshed and retried');
});

test('a dead refresh token says what to do about it', async () => {
  const api = fakeCalendar([], { fail: 'invalid_grant' });
  await assert.rejects(() => poll(api), (e) => e instanceof GoogleError && /invalid_grant/.test(e.message) && /google-consent/.test(e.message));
});

test('readCredentials wants a client and a refresh token, and says no rather than half-yes', () => {
  assert.equal(readCredentials({ clientFile: '/nonexistent', tokenFile: '/nonexistent' }), null);
  assert.equal(readCredentials({ clientId: 'id', clientSecret: 's', tokenFile: '/nonexistent' }), null);
  assert.deepEqual(readCredentials({ clientId: 'id', clientSecret: 's', refreshToken: 'r' }), { clientId: 'id', clientSecret: 's', refreshToken: 'r' });
});

test('GoogleApi.list stops at the page cap and does not claim a sync token it never saw', async () => {
  let page = 0;
  const api = new GoogleApi({ clientId: 'c', refreshToken: 'r', fetch: async (url) => {
    if (url.startsWith('https://oauth2')) return { status: 200, ok: true, headers: new Headers(), text: async () => JSON.stringify({ access_token: 'a', expires_in: 3600 }) };
    page++;
    return { status: 200, ok: true, headers: new Headers(), text: async () => JSON.stringify({ items: [{ id: `e${page}` }], nextPageToken: 'more' }) };
  } });
  const r = await api.list('/calendars/primary/events', { pages: 3 });
  assert.equal(r.items.length, 3);
  assert.equal(r.complete, false);
  assert.equal(r.syncToken, null);
});

// ---------------------------------------------------------------------------
// The feed (plan §16, G4): the default path. Dates are relative to FNOW, and
// FNOW is handed to every call, so nothing here reads the wall clock.
import { ics, alice, ann, bob, demoIcs } from './fake-calendar.js';
import { loadConfig, calendarFeed, parseCalendarMe } from '../lib/config.js';
import { Store } from '../lib/store.js';
import { Runner } from '../lib/runner.js';
import calendarRules from '../rules/calendar.js';

const FNOW = new Date('2026-09-10T12:00:00Z');
const FME = 'alice@example.com';
const fat = (min) => new Date(FNOW.getTime() + min * 60_000).toISOString();
const feedOf = () => ics([
  { uid: 'soon', summary: 'Design review', start: fat(12), updated: fat(-600), organizer: ann, attendees: [alice(), ann, bob], location: 'Room 2', join: 'https://meet.google.com/x' },
  { uid: 'invite', summary: 'Roadmap', start: fat(26 * 60), updated: fat(-60), organizer: bob, attendees: [alice('needs-action'), bob] },
  { uid: 'allday', summary: 'Out', start: '2026-09-11T00:00:00Z', allDay: true },
  { uid: 'solo', summary: 'Focus', start: fat(3 * 60) },
  { uid: 'declined', summary: 'All-hands', start: fat(7 * 60), organizer: bob, attendees: [alice('declined'), bob] },
  { uid: 'past', summary: 'Just ended', start: fat(-90), organizer: ann, attendees: [alice(), ann] },
  { uid: 'far', summary: 'Next week', start: fat(7 * 24 * 60), organizer: ann, attendees: [alice(), ann] },
]);
const fpoll = (feed, cursor = null, extra = {}) => calendar.poll({ feed, cursor, me: FME, now: FNOW, tz: 'UTC', ...extra });

test('the feed: the window becomes items carrying what a rule and a message read, in the shape the Google half makes', async () => {
  const r = await fpoll({ text: feedOf() });
  const by = Object.fromEntries(r.batches.map((b) => [b.item.key, b]));
  assert.deepEqual(Object.keys(by).sort(), ['allday', 'declined', 'invite', 'past', 'solo', 'soon'], 'a meeting that just ended is still in the window; next week is not');
  const soon = by.soon.item;
  assert.equal(soon.source, 'calendar');
  assert.equal(soon.kind, 'event');
  assert.equal(soon.my_role, 'attendee');
  assert.deepEqual([soon.data.start, soon.data.location, soon.data.join, soon.data.organizer, soon.data.guests, soon.data.response, soon.data.mine, soon.data.calendar_id], [fat(12), 'Room 2', 'https://meet.google.com/x', 'Ann Lee', 2, 'accepted', false, 'Alice'], 'the project is the feed\'s own name');
  assert.equal(soon.last_activity, fat(-600), 'when it last changed is LAST-MODIFIED');
  assert.equal(by.soon.events[0].kind, 'update');
  assert.equal(by.invite.events[0].kind, 'invite');
  assert.equal(by.invite.item.my_role, 'invited');
  assert.equal(by.invite.item.data.response, 'needsAction', 'the feed\'s NEEDS-ACTION in the words the rules read');
  assert.deepEqual([by.allday.item.data.all_day, by.allday.item.data.start], [true, '2026-09-11']);
  assert.deepEqual([by.solo.item.data.mine, by.solo.item.my_role, by.solo.item.data.guests], [true, 'organizer', 0]);
  assert.equal(by.declined.item.data.response, 'declined');
  assert.deepEqual([r.cursor.reader, r.cursor.ok, Object.keys(r.cursor.hashes).length, r.cursor.name], ['ics', true, 6, 'Alice']);
  assert.deepEqual(calendar.describeCursor(r.cursor), { reader: 'ics', fetched_at: FNOW.toISOString(), read_at: FNOW.toISOString(), ok: true, error: null, entries: 7, in_window: 6, name: 'Alice' });
  // TRIAGE_CALENDAR_ID names the project instead of the feed.
  assert.equal((await fpoll({ text: feedOf() }, null, { calendarId: 'work' })).batches[0].item.data.calendar_id, 'work');
});

test('the feed: an unchanged feed emits nothing; a reschedule, an answer or a cancellation re-emits that one event', async () => {
  const a = await fpoll({ text: feedOf() });
  const same = await fpoll({ text: feedOf() }, a.cursor);
  assert.deepEqual(same.batches, []);
  assert.match(same.status, /7 entries, 6 in the window, 0 changed/);
  const moved = feedOf().replace(`DTSTART:${fat(3 * 60).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`, `DTSTART:${fat(4 * 60).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`);
  const b = await fpoll({ text: moved }, a.cursor);
  assert.deepEqual(b.batches.map((x) => x.item.key), ['solo']);
  assert.notEqual(b.batches[0].events[0].key, a.batches.find((x) => x.item.key === 'solo').events[0].key, 'a new event key, so the rules see it');
  const answered = await fpoll({ text: feedOf().replace('PARTSTAT=NEEDS-ACTION', 'PARTSTAT=ACCEPTED') }, a.cursor);
  assert.deepEqual(answered.batches.map((x) => [x.item.key, x.events[0].kind]), [['invite', 'update']]);
  const cancelled = await fpoll({ text: feedOf().replace(/(UID:soon[\s\S]*?)STATUS:CONFIRMED/, '$1STATUS:CANCELLED') }, a.cursor);
  assert.deepEqual(cancelled.batches.map((x) => [x.item.key, x.events[0].kind, x.item.data.status]), [['soon', 'cancelled', 'cancelled']]);
});

test('the feed: without TRIAGE_CALENDAR_ME no invitation is yours to answer, and an entry with nobody on it is still your own', async () => {
  const r = await calendar.poll({ feed: { text: feedOf() }, cursor: null, me: '', now: FNOW });
  const by = Object.fromEntries(r.batches.map((b) => [b.item.key, b]));
  assert.equal(by.invite.events[0].kind, 'update');
  assert.equal(by.invite.item.my_role, 'subscribed');
  assert.equal(by.solo.item.data.mine, true);
});

test('the feed through the runner: the brief, then the 15-minute alarm on the clock, then an event gone from the feed resolved by the source', async () => {
  const store = new Store();
  let now = FNOW, text = feedOf();
  const runner = new Runner(store, [calendar], { user: 'alice', rules: { calendar: calendarRules }, identity: { calendar: FME }, extras: { calendar: { feed: { text: () => text }, tz: 'UTC' } }, now: () => now });
  let r = await runner.run('calendar');
  assert.deepEqual(Object.fromEntries(r.decisions.map((d) => [d.item, d.rule])), { soon: 'day_ahead', invite: 'new_invitation', allday: 'all_day', solo: 'own_event', declined: 'declined', past: 'day_ahead' });
  now = new Date(FNOW.getTime() + 60_000);
  r = await runner.run('calendar');
  assert.deepEqual(r.decisions, [], 'the feed has not changed');
  assert.deepEqual(r.due.decisions.map((d) => [d.item, d.rule, d.tier]), [['soon', 'starts_in_15_min', 'P0']]);
  assert.equal(store.itemByKey('alice', 'calendar', 'soon').tier, 'P0');
  text = ics([{ uid: 'invite', summary: 'Roadmap', start: fat(26 * 60), updated: fat(-60), organizer: bob, attendees: [alice('needs-action'), bob] }]);
  now = new Date(FNOW.getTime() + 120_000);
  r = await runner.run('calendar');
  assert.deepEqual(r.reconciled.resolved.sort(), ['allday', 'declined', 'past', 'solo', 'soon']);
  const soon = store.itemByKey('alice', 'calendar', 'soon');
  assert.equal(soon.state, 'done');
  assert.equal(store.actionsFor(soon.id).at(-1).by, 'source:calendar');
  store.close();
});

test('the feed: a read that fails keeps the last set, says so, and resolves nothing; the Google cursor reconciles nothing at all', async () => {
  const a = await fpoll({ text: feedOf() });
  const fetch = async () => ({ ok: false, status: 503, headers: new Headers(), text: async () => '' });
  const feed = { url: 'https://calendar.example.com/private-s3cr3t/basic.ics', host: 'calendar.example.com' };
  const r = await fpoll(feed, a.cursor, { fetch });
  assert.equal(r.cursor.ok, false);
  assert.equal(r.status, 'feed not read: the feed answered HTTP 503');
  assert.doesNotMatch(JSON.stringify([r.status, r.cursor, calendar.describeCursor(r.cursor)]), /s3cr3t/, 'the URL is the credential; it is in no message and no cursor');
  assert.deepEqual(Object.keys(r.cursor.hashes), Object.keys(a.cursor.hashes));
  assert.equal(calendar.reconcile({ cursor: r.cursor, now: FNOW }).complete, false);
  assert.equal(calendar.reconcile({ cursor: null }), null);
  assert.equal(calendar.reconcile({ cursor: { sync_token: 't', synced_at: FNOW.toISOString() } }), null, 'the Google path has no whole set to hand over');
  const notIcs = await fpoll(feed, null, { fetch: async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => '<html>sign in</html>' }) });
  assert.match(notIcs.status, /not a calendar/);
});

test('the feed over HTTP: fetched at most every few minutes, then conditionally, and a 304 re-reads what it had', async () => {
  const seen = [];
  const fetch = async (url, { headers }) => {
    seen.push(headers['if-none-match'] || null);
    if (headers['if-none-match'] === '"v1"') return { ok: false, status: 304, headers: new Headers(), text: async () => '' };
    return { ok: true, status: 200, headers: new Headers({ etag: '"v1"' }), text: async () => feedOf() };
  };
  const feed = { url: 'https://calendar.example.com/feed.ics' };
  const a = await fpoll(feed, null, { fetch });
  assert.match(a.status, /^fetched — /);
  const b = await fpoll(feed, a.cursor, { fetch, now: new Date(FNOW.getTime() + 60_000) });
  assert.match(b.status, /^cached — /);
  assert.deepEqual(seen, [null], 'inside the interval nothing is fetched');
  const c = await fpoll(feed, b.cursor, { fetch, now: new Date(FNOW.getTime() + 6 * 60_000) });
  assert.match(c.status, /^not modified — /);
  assert.deepEqual(seen, [null, '"v1"']);
  assert.equal(c.batches.length, 0, 'the same text, so nothing changed');
  assert.equal(Object.keys(c.cursor.hashes).length, 6);
});

test('the feed\'s configuration: a URL or a file, https off loopback, webcal read as https, your addresses checked', () => {
  assert.equal(calendarFeed({}), null);
  assert.deepEqual(calendarFeed({ TRIAGE_CALENDAR_FILE: '/home/alice/work.ics' }), { file: '/home/alice/work.ics', name: 'work' });
  assert.deepEqual(calendarFeed({ TRIAGE_CALENDAR_URL: 'webcal://p01-caldav.icloud.com/published/2/abc' }), { url: 'https://p01-caldav.icloud.com/published/2/abc', host: 'p01-caldav.icloud.com', name: 'p01-caldav.icloud.com' });
  assert.equal(calendarFeed({ TRIAGE_CALENDAR_URL: 'http://127.0.0.1:8080/x.ics' }).url, 'http://127.0.0.1:8080/x.ics');
  assert.throws(() => calendarFeed({ TRIAGE_CALENDAR_URL: 'http://calendar.example.com/x.ics' }), /must be https for calendar\.example\.com/);
  assert.throws(() => calendarFeed({ TRIAGE_CALENDAR_URL: 'https://a/x.ics', TRIAGE_CALENDAR_FILE: '/x.ics' }), /name one feed/);
  assert.throws(() => calendarFeed({ TRIAGE_CALENDAR_URL: 'not a url' }), /not a URL/);
  assert.deepEqual(parseCalendarMe('Alice@Example.com, mailto:alice@work.example'), ['alice@example.com', 'alice@work.example']);
  assert.throws(() => parseCalendarMe('alice'), /not an email address/);
  const c = loadConfig({ TRIAGE_ENV: '/nonexistent/triage.env', TRIAGE_CALENDAR_URL: 'https://calendar.google.com/calendar/ical/x/private-y/basic.ics', TRIAGE_CALENDAR_ME: 'alice@example.com' }).calendar;
  assert.deepEqual([c.mode, c.feed.host, c.me, c.fetchMs, c.id], [null, 'calendar.google.com', ['alice@example.com'], 300_000, null]);
  assert.equal(loadConfig({ TRIAGE_ENV: '/nonexistent/triage.env', TRIAGE_CALENDAR: 'ics' }).calendar.mode, 'ics');
  assert.throws(() => loadConfig({ TRIAGE_ENV: '/nonexistent/triage.env', TRIAGE_CALENDAR: 'outlook' }), /TRIAGE_CALENDAR must be off, google, ics, fake/);
});

test('TRIAGE_CALENDAR=fake is the feed: the canned day has one of each thing the rules separate, and a standup with an occurrence moved', async () => {
  const r = await calendar.poll({ feed: { text: demoIcs({ now: () => FNOW }) }, cursor: null, me: FME, now: FNOW, tz: 'UTC' });
  assert.ok(r.batches.every((b) => b.item.title.startsWith('(fake)')));
  const kinds = new Set(r.batches.map((b) => b.events[0].kind));
  assert.ok(kinds.has('invite') && kinds.has('update'));
  const standups = r.batches.filter((b) => b.item.key.startsWith('demo-standup@'));
  assert.ok(standups.length >= 2 && standups.every((b) => b.item.data.recurring), 'the standup recurs, one item per occurrence');
  assert.ok(r.batches.some((b) => b.item.title === '(fake) Standup (moved)'));
  assert.ok(!r.batches.some((b) => b.item.key === 'demo-far'), 'a week out is not in the window');
  assert.equal(calendar.due({ items: r.batches.map((b) => b.item), now: FNOW }).batches.map((b) => b.item.key).join(), 'demo-soon', 'the design review is the alarm');
});

test('the feed: a change undone is still a change — 10:00, 11:00, 10:00 are three events, the revision kept in the cursor', async () => {
  const at10 = ics([{ uid: 'm', summary: 'Sync', start: fat(60), organizer: ann, attendees: [alice(), ann] }]);
  const at11 = ics([{ uid: 'm', summary: 'Sync', start: fat(120), organizer: ann, attendees: [alice(), ann] }]);
  const a = await fpoll({ text: at10 });
  const b = await fpoll({ text: at11 }, a.cursor);
  const c = await fpoll({ text: at10 }, b.cursor);
  const keys = [a, b, c].map((r) => r.batches[0]?.events[0].key);
  assert.equal(new Set(keys).size, 3, keys.join(' · '));
  assert.deepEqual(c.cursor.revisions.m.n, 3);
  assert.deepEqual((await fpoll({ text: at10 }, c.cursor)).batches, [], 'and unchanged is still nothing');
  // A revision outlives the instance leaving the window, so a return counts on.
  const gone = await fpoll({ text: ics([]) }, c.cursor);
  assert.equal(gone.cursor.revisions.m.n, 3);
  const back = await fpoll({ text: at10 }, gone.cursor);
  assert.ok(!keys.includes(back.batches[0].events[0].key));
});

test('the feed over HTTP: a redirect is followed by hand, to https only and at most five times; the body is cut off at the size limit', async () => {
  const feedText = feedOf();
  const hops = [];
  const routes = {
    'https://p01.example.com/published/s3cr3t': { status: 301, location: 'https://p42.example.com/published/s3cr3t' },
    'https://p42.example.com/published/s3cr3t': { status: 200, body: feedText },
    'https://down.example.com/s3cr3t': { status: 302, location: 'http://plain.example.com/s3cr3t' },
    'https://loop.example.com/s3cr3t': { status: 307, location: '/s3cr3t' },
  };
  const fetch = async (url, { redirect }) => {
    hops.push(url);
    assert.equal(redirect, 'manual', 'never fetch\'s own following');
    const r = routes[url];
    return { ok: r.status < 300, status: r.status, headers: new Headers(r.location ? { location: r.location } : {}), text: async () => r.body || '' };
  };
  const ok = await fpoll({ url: 'https://p01.example.com/published/s3cr3t' }, null, { fetch });
  assert.match(ok.status, /^fetched — 7 entries/);
  assert.deepEqual(hops, ['https://p01.example.com/published/s3cr3t', 'https://p42.example.com/published/s3cr3t'], 'iCloud-style: the partition the calendar lives on');
  const down = await fpoll({ url: 'https://down.example.com/s3cr3t' }, null, { fetch });
  assert.equal(down.status, 'feed not read: the feed redirected to http://plain.example.com — only https is followed');
  const loop = await fpoll({ url: 'https://loop.example.com/s3cr3t' }, null, { fetch });
  assert.equal(loop.status, 'feed not read: the feed redirected more than 5 times');
  for (const r of [down, loop]) assert.doesNotMatch(JSON.stringify([r.status, r.cursor]), /s3cr3t/);
  // A body with no Content-Length, larger than the limit: read until it
  // passes, then abandoned — not held whole and measured after.
  let pulled = 0;
  const MB = new Uint8Array(1024 * 1024).fill(65);
  const huge = new ReadableStream({ pull(ctrl) { pulled++; ctrl.enqueue(MB); } });
  const big = await fpoll({ url: 'https://big.example.com/x.ics' }, null, { fetch: async () => new Response(huge, { status: 200 }) });
  assert.equal(big.status, 'feed not read: the feed is larger than 20 MB');
  assert.ok(pulled <= 22, `stopped at the limit (${pulled} MB pulled)`);
});
