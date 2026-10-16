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
