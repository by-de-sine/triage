// lib/ics.js (plan §16, G4): the parser and the expansion. Pure functions
// over explicit ranges, so most fixtures name their dates; the one that is
// about "today" derives them from NOW, because a fixture pinned to a date
// is a test that rots (the reference tree's one failure was exactly that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, parseDate, parseDuration, parseRrule, expandRrule, instances, zonedToUtc, zoneOf, joinLink, text } from '../lib/ics.js';
import { ics, vevent } from './fake-calendar.js';

const NOW = new Date();
const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

test('lines unfold, parameters parse, quoted colons survive, a nested alarm stays out', () => {
  const feed = 'BEGIN:VCALENDAR\r\nX-WR-CALNAME:Team\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:A long\r\n  title\r\nATTENDEE;CN="Lee: Ann";PARTSTAT=ACCEPTED:mailto:ann@x.com\r\nDESCRIPTION:one\\, two\\nthree\r\nBEGIN:VALARM\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const { events, name } = parseIcs(feed);
  assert.equal(name, 'Team');
  assert.equal(events.length, 1);
  assert.equal(text(events[0], 'SUMMARY'), 'A long title');
  assert.equal(events[0].ATTENDEE[0].params.CN, 'Lee: Ann');
  assert.equal(events[0].ATTENDEE[0].value, 'mailto:ann@x.com');
  assert.equal(text(events[0], 'DESCRIPTION'), 'one, two\nthree');
  assert.equal(events[0].TRIGGER, undefined, 'a nested alarm does not leak into the event');
  assert.equal(parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:b\nEND:VEVENT\nEND:VCALENDAR').events.length, 1, 'bare LF line endings too');
});

test('dates: UTC, a named zone across a clock change, floating and all-day in your zone, Windows and path zone names', () => {
  assert.equal(parseDate({ params: {}, value: '20260920T120000Z' }).ms, Date.UTC(2026, 8, 20, 12));
  assert.equal(parseDate({ params: { TZID: 'America/New_York' }, value: '20260120T090000' }).ms, Date.UTC(2026, 0, 20, 14));
  assert.equal(parseDate({ params: { TZID: 'America/New_York' }, value: '20260720T090000' }).ms, Date.UTC(2026, 6, 20, 13));
  assert.equal(parseDate({ params: {}, value: '20260720T090000' }, 'Europe/Berlin').ms, Date.UTC(2026, 6, 20, 7), 'floating is your zone');
  const day = parseDate({ params: { VALUE: 'DATE' }, value: '20260920' }, 'America/Vancouver');
  assert.equal(day.allDay, true);
  assert.equal(day.ms, Date.UTC(2026, 8, 20, 7), 'an all-day date begins at your midnight, not UTC\'s');
  assert.equal(parseDate({ params: { VALUE: 'DATE' }, value: '20260920' }).ms, Date.UTC(2026, 8, 20));
  assert.equal(zonedToUtc({ y: 2026, mo: 3, d: 8, h: 2, mi: 30, s: 0 }, 'America/New_York'), Date.UTC(2026, 2, 8, 7, 30), 'a time inside the spring-forward gap resolves');
  // Outlook writes Windows names; Intl knows none of them.
  assert.equal(zoneOf('Pacific Standard Time'), 'America/Los_Angeles');
  assert.equal(parseDate({ params: { TZID: 'Eastern Standard Time' }, value: '20260720T090000' }).ms, Date.UTC(2026, 6, 20, 13));
  assert.equal(zoneOf('/mozilla.org/20050126_1/America/New_York'), 'America/New_York');
  assert.equal(parseDate({ params: { TZID: 'Nowhere/Land' }, value: '20260720T090000' }, 'Europe/Berlin').ms, Date.UTC(2026, 6, 20, 7), 'a zone nothing knows reads as yours, not as UTC');
  assert.equal(parseDuration('P1DT2H30M'), 95_400_000);
  assert.equal(parseDuration('-PT10M'), -600_000);
  assert.equal(parseDuration('P1W'), 7 * DAY);
  assert.equal(parseDuration('soon'), null);
});

test('rrule: daily with COUNT, weekly by day with UNTIL and an EXDATE, monthly by ordinal weekday and day, yearly, and the wall clock across a change', () => {
  const start = { y: 2026, mo: 9, d: 1, h: 9, mi: 0, s: 0 };   // a Tuesday
  const to = Date.UTC(2026, 11, 31);
  const days = (r) => r.map(isoDay);
  assert.deepEqual(days(expandRrule(parseRrule('FREQ=DAILY;COUNT=3'), start, 'UTC', { toMs: to })), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.deepEqual(days(expandRrule(parseRrule('FREQ=DAILY;INTERVAL=3;COUNT=3'), start, 'UTC', { toMs: to })), ['2026-09-01', '2026-09-04', '2026-09-07']);
  assert.deepEqual(days(expandRrule(parseRrule('FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260916T000000Z'), start, 'UTC', { toMs: to, exdates: new Set([Date.UTC(2026, 8, 9, 9)]) })), ['2026-09-02', '2026-09-07', '2026-09-14']);
  assert.deepEqual(days(expandRrule(parseRrule('FREQ=WEEKLY;BYDAY=TU;COUNT=3'), start, 'UTC', { toMs: to, exdates: new Set([Date.UTC(2026, 8, 8, 9)]) })), ['2026-09-01', '2026-09-15'], 'an EXDATE still counts toward COUNT');
  assert.deepEqual(days(expandRrule(parseRrule('FREQ=MONTHLY;BYDAY=2TU;COUNT=3'), start, 'UTC', { toMs: to })), ['2026-09-08', '2026-10-13', '2026-11-10']);
  assert.deepEqual(days(expandRrule(parseRrule('FREQ=MONTHLY;BYDAY=-1FR;COUNT=2'), start, 'UTC', { toMs: to })), ['2026-09-25', '2026-10-30']);
  assert.deepEqual(days(expandRrule(parseRrule('FREQ=MONTHLY;BYMONTHDAY=31;COUNT=2'), { ...start, d: 31, mo: 8 }, 'UTC', { toMs: to })), ['2026-08-31', '2026-10-31'], 'a month without a 31st is skipped');
  assert.deepEqual(days(expandRrule(parseRrule('FREQ=YEARLY;COUNT=2'), start, 'UTC', { toMs: Date.UTC(2030, 0, 1) })), ['2026-09-01', '2027-09-01']);
  assert.deepEqual(days(expandRrule(parseRrule('FREQ=YEARLY;COUNT=2'), { ...start, y: 2028, mo: 2, d: 29 }, 'UTC', { toMs: Date.UTC(2040, 0, 1) })), ['2028-02-29', '2032-02-29'], '29 February only in a year that has one, never 1 March');
  assert.deepEqual(expandRrule(parseRrule('FREQ=WEEKLY;COUNT=2;INTERVAL=2'), { y: 2026, mo: 10, d: 20, h: 9, mi: 0, s: 0 }, 'Europe/London', { toMs: to }).map((ms) => new Date(ms).toISOString()), ['2026-10-20T08:00:00.000Z', '2026-11-03T09:00:00.000Z'], 'the wall clock holds across the autumn change');
  assert.equal(expandRrule(parseRrule('FREQ=DAILY'), start, 'UTC', { toMs: Date.UTC(2026, 8, 3, 12) }).length, 3, 'an open-ended rule stops at the range');
  assert.deepEqual(days(expandRrule(parseRrule('FREQ=HOURLY'), start, 'UTC', { toMs: to })), ['2026-09-01'], 'a FREQ it does not know is its first occurrence, not nothing');
});

test('an open-ended rule from years ago still reaches today, without walking every occurrence since', () => {
  const t = NOW.getTime();
  const tenYears = new Date(t - 3650 * DAY);
  const dtstart = { y: tenYears.getUTCFullYear(), mo: tenYears.getUTCMonth() + 1, d: tenYears.getUTCDate(), h: 9, mi: 0, s: 0 };
  const range = { fromMs: t - DAY, toMs: t + 2 * DAY };
  const daily = expandRrule(parseRrule('FREQ=DAILY'), dtstart, 'America/New_York', range);
  assert.ok(daily.length >= 2 && daily.length <= 4, `a daily standup from ten years ago has its occurrences around today (${daily.length})`);
  for (const ms of daily) assert.ok(ms >= range.fromMs && ms <= range.toMs);
  const weekly = expandRrule(parseRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'), dtstart, 'UTC', { fromMs: t - 7 * DAY, toMs: t });
  assert.ok(weekly.length >= 4 && weekly.length <= 6, `weekdays over the last week (${weekly.length})`);
  const monthly = expandRrule(parseRrule('FREQ=MONTHLY'), dtstart, 'UTC', { fromMs: t - 40 * DAY, toMs: t });
  assert.ok(monthly.length >= 1 && monthly.length <= 2);
  // With COUNT the walk must start at the beginning to count — and has ended long ago.
  assert.deepEqual(expandRrule(parseRrule('FREQ=DAILY;COUNT=10'), dtstart, 'UTC', range), []);
});

test('instances: a window, a moved occurrence, a cancelled one, an override without its master, and one moved into the window', () => {
  const feed = ics([
    { uid: 'std', summary: 'Standup', start: '2026-09-01T09:00:00Z', rrule: 'FREQ=DAILY;COUNT=10' },
    { uid: 'std', summary: 'Standup (moved)', start: '2026-09-03T10:00:00Z', recurrenceId: '2026-09-03T09:00:00Z' },
    { uid: 'std', summary: 'Standup', start: '2026-09-04T09:00:00Z', recurrenceId: '2026-09-04T09:00:00Z', status: 'CANCELLED' },
    { uid: 'std', summary: 'Standup (pulled in)', start: '2026-09-05T16:00:00Z', recurrenceId: '2026-09-08T09:00:00Z' },
    { uid: 'orphan', summary: 'Orphan', start: '2026-09-05T15:00:00Z', recurrenceId: '2026-09-05T14:00:00Z' },
    { uid: 'one', summary: 'One-off', start: '2026-09-02T12:00:00Z' },
    { uid: 'far', summary: 'Far', start: '2026-10-02T12:00:00Z' },
  ]);
  const { events } = parseIcs(feed);
  const out = instances(events, { fromMs: Date.UTC(2026, 8, 2), toMs: Date.UTC(2026, 8, 6) });
  const got = out.map((i) => `${i.uid}:${new Date(i.start).toISOString().slice(0, 16)}:${text(i.ev, 'SUMMARY')}`).sort();
  assert.deepEqual(got, ['one:2026-09-02T12:00:One-off', 'orphan:2026-09-05T15:00:Orphan', 'std:2026-09-02T09:00:Standup', 'std:2026-09-03T10:00:Standup (moved)', 'std:2026-09-05T09:00:Standup', 'std:2026-09-05T16:00:Standup (pulled in)']);
  assert.equal(out.find((i) => text(i.ev, 'SUMMARY') === 'Standup (moved)').recurrenceId, Date.UTC(2026, 8, 3, 9), 'an override keeps the identity of the occurrence it replaces');
  assert.equal(out.find((i) => i.uid === 'one').recurrenceId, null);
  // An occurrence still running when the window opens is in it.
  const running = instances(parseIcs(ics([{ uid: 'long', start: '2026-09-01T22:00:00Z', end: '2026-09-02T02:00:00Z', rrule: 'FREQ=DAILY' }])).events, { fromMs: Date.UTC(2026, 8, 5, 1), toMs: Date.UTC(2026, 8, 5, 3) });
  assert.deepEqual(running.map((i) => new Date(i.start).toISOString()), ['2026-09-04T22:00:00.000Z']);
});

test('a conference link is found in the properties, then in the text', () => {
  const ev = parseIcs(vevent({ uid: 'x', start: '2026-09-02T12:00:00Z', description: 'Join at https://zoom.us/j/123?pwd=abc please' })).events[0];
  assert.equal(joinLink(ev), 'https://zoom.us/j/123?pwd=abc');
  assert.equal(joinLink(parseIcs(vevent({ uid: 'y', start: '2026-09-02T12:00:00Z', join: 'https://meet.google.com/abc' })).events[0]), 'https://meet.google.com/abc');
  assert.equal(joinLink(parseIcs(vevent({ uid: 'z', start: '2026-09-02T12:00:00Z' })).events[0]), null);
});
