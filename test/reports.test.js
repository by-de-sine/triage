// The store over time (plan §15): one read, bucketed in a zone, nothing
// written. Seeded by hand so every number below is one you can count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { report, describeReports, bucketKey, bucketKeys, local, yours, TOP } from '../lib/reports.js';

const ME = 'alice';
const TZ = 'America/Vancouver';   // UTC-7 in September
const NOW = new Date('2026-09-15T20:00:00Z');   // Tue 13:00 local
const HOUR = 3_600_000, DAY = 86_400_000;
const at = (iso) => new Date(iso).toISOString();

/** An item that arrived at `created`, with one verdict at the same instant
 *  and whatever events are given. */
function seed(store, key, { created, source = 'github', repo = 'o/r', kind = 'pull', tier = 'P2', rule = 'state_change_on_mine', events = [], delivered = false }) {
  const { item } = store.upsertItem({ user: ME, source, key, kind, title: key, url: `https://x/${key}`, repo, last_activity: created }, created);
  store.addEvents(item.id, events.map((e, n) => ({ key: `${key}:${n}`, ts: e.ts, kind: e.kind || 'comment', actor: e.actor ?? null })), created);
  store.setTier(item.id, tier, 1, created);
  const id = store.addDecision({ item_id: item.id, rule, tier, reason: 'seeded', event_ids: [], matches: [{ rule, tier, reason: 'seeded' }] }, created);
  if (delivered) store.markDelivered(id, true, 'sent webhook');
  return item;
}

function fixture() {
  const store = new Store();
  // Day 1 (Sep 10, Thu local): two arrivals; ann replies on one; the owner comments on it.
  const a = seed(store, 'o/r#1', { created: at('2026-09-10T16:00:00Z'), events: [
    { ts: '2026-09-10T16:00:00Z', actor: 'ann' },              // Thu 09:00 local
    { ts: '2026-09-10T18:30:00Z', actor: ME },                 // Thu 11:00 local
    { ts: '2026-09-10T19:00:00Z', actor: 'coderabbitai[bot]', kind: 'review' },
  ] });
  seed(store, 'o/r#2', { created: at('2026-09-10T17:00:00Z'), repo: 'o/q', events: [{ ts: '2026-09-10T17:00:00Z', actor: 'bob' }] });
  // Day 2 (Sep 11): an interrupt on #1, which the owner does 3 h later from the page.
  const d = store.addDecision({ item_id: a.id, rule: 'reply_to_my_comment', tier: 'P0', reason: 'ann replied', event_ids: [], matches: [] }, at('2026-09-11T15:00:00Z'));
  store.markDelivered(d, true, 'sent webhook');
  store.setState(a.id, 'done', null, at('2026-09-11T18:00:00Z'));
  store.addAction({ item_id: a.id, action: 'done', by: 'web' }, at('2026-09-11T18:00:00Z'));
  // Day 3 (Sep 12): a ledger row arrives and is resolved by its owner the same day; #2 is snoozed.
  const l = seed(store, 'row:abc', { created: at('2026-09-12T15:00:00Z'), source: 'ledger', repo: null, kind: 'todo', tier: 'P1', rule: 'past_its_nudge', events: [{ ts: '2026-09-12T15:00:00Z', actor: 'human-laptop', kind: 'row' }] });
  store.setState(l.id, 'done', null, at('2026-09-12T20:00:00Z'));
  store.addAction({ item_id: l.id, action: 'resolved', by: 'source:ledger' }, at('2026-09-12T20:00:00Z'));
  const b = store.itemByKey(ME, 'github', 'o/r#2');
  store.setState(b.id, 'snoozed', at('2026-09-13T20:00:00Z'), at('2026-09-12T21:00:00Z'));
  store.addAction({ item_id: b.id, action: 'snooze', by: 'web', until: at('2026-09-13T20:00:00Z') }, at('2026-09-12T21:00:00Z'));
  // Day 4 (Sep 13): the snooze wakes.
  store.setState(b.id, 'open', null, at('2026-09-13T20:00:00Z'));
  store.addAction({ item_id: b.id, action: 'wake', by: 'system' }, at('2026-09-13T20:00:00Z'));
  // Before the window: an old item, still open, so the opening state is not zero.
  seed(store, 'o/r#0', { created: at('2026-08-01T12:00:00Z'), events: [{ ts: '2026-08-01T12:00:00Z', actor: 'ann' }] });
  return store;
}

test('buckets are the local calendar, walked without gaps or doubles, and keys sort as time does', () => {
  // 2026-09-10T06:30Z is the evening of the 9th in Vancouver.
  const t = Date.parse('2026-09-10T06:30:00Z');
  assert.deepEqual(local(t, TZ), { date: '2026-09-09', hour: 23, weekday: 2, ymd: [2026, 9, 9] });
  assert.equal(bucketKey(t, 'day', TZ), '2026-09-09');
  assert.equal(bucketKey(t, 'hour', TZ), '2026-09-09 23');
  assert.equal(bucketKey(t, 'week', TZ), '2026-09-07', 'the Monday of that week');
  assert.equal(bucketKey(t, 'day', 'UTC'), '2026-09-10');
  const days = bucketKeys(Date.parse('2026-09-08T00:00:00Z'), Date.parse('2026-09-12T00:00:00Z'), 'day', TZ);
  assert.deepEqual(days, ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']);
  // Across a clock change (2026-11-01 in Vancouver) a day is neither skipped nor doubled.
  const fall = bucketKeys(Date.parse('2026-10-30T12:00:00Z'), Date.parse('2026-11-03T12:00:00Z'), 'day', TZ);
  assert.deepEqual(fall, ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  assert.equal(bucketKeys(Date.parse('2026-09-08T00:00:00Z'), Date.parse('2026-09-08T03:00:00Z'), 'hour', 'UTC').length, 4);
  assert.deepEqual(bucketKeys(Date.parse('2026-09-01T00:00:00Z'), Date.parse('2026-09-15T00:00:00Z'), 'week', 'UTC'), ['2026-08-31', '2026-09-07', '2026-09-14']);
});

test('yours is what you did: not the system, not a source', () => {
  assert.equal(yours({ by: 'web' }), true);
  assert.equal(yours({ by: 'api' }), true);
  assert.equal(yours({ by: null }), true);
  assert.equal(yours({ by: 'system' }), false);
  assert.equal(yours({ by: 'source:ledger' }), false);
});

test('flow: arrivals against closures, who closed what, and the state of the queue replayed from actions', () => {
  const store = fixture();
  const r = report(store, 'flow', { user: ME, since: '2026-09-10T07:00:00Z', until: NOW.toISOString(), tz: TZ, now: NOW });
  assert.equal(r.report, 'flow');
  assert.equal(r.bucket, 'day');
  assert.deepEqual(r.buckets.map((b) => b.key), ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15']);
  const by = Object.fromEntries(r.buckets.map((b) => [b.key, b]));
  assert.deepEqual([by['2026-09-10'].arrived, by['2026-09-11'].arrived, by['2026-09-12'].arrived], [2, 0, 1]);
  assert.deepEqual([by['2026-09-10'].verdicts, by['2026-09-11'].verdicts, by['2026-09-11'].interrupts], [2, 1, 1]);
  assert.deepEqual(by['2026-09-11'].closed, { you: 1, elsewhere: 0 }, 'Done from the page is yours');
  assert.deepEqual(by['2026-09-12'].closed, { you: 0, elsewhere: 1 }, 'a row its owner deleted is resolved elsewhere, never yours');
  assert.equal(by['2026-09-12'].parked, 1);
  assert.equal(by['2026-09-13'].reopened, 1, 'the wake');
  // The replay: the August item is open from the first bucket; states follow the actions.
  assert.deepEqual(by['2026-09-10'].states, { open: 3, snoozed: 0, later: 0, done: 0, muted: 0 });
  assert.deepEqual(by['2026-09-11'].states, { open: 2, snoozed: 0, later: 0, done: 1, muted: 0 });
  assert.deepEqual(by['2026-09-12'].states, { open: 1, snoozed: 1, later: 0, done: 2, muted: 0 });
  assert.deepEqual(by['2026-09-13'].states, { open: 2, snoozed: 0, later: 0, done: 2, muted: 0 });
  assert.deepEqual(by['2026-09-15'].states, by['2026-09-13'].states, 'a quiet day carries the state forward');
  assert.deepEqual(r.totals.closed, { you: 1, elsewhere: 1 });
  assert.deepEqual(r.totals.open, { start: 3, end: 2, now: 2 });
  assert.equal(r.totals.interrupts, 1);
  assert.deepEqual(r.totals.interrupt_rate.busiest, { key: '2026-09-11', n: 1 });
  assert.ok(r.totals.interrupt_rate.per_hour < 0.01);
  // Nothing written.
  assert.equal(store.decisions().length, 5);
  store.close();
});

test('flow by the hour, and the window it used is on the answer', () => {
  const store = fixture();
  const r = report(store, 'flow', { user: ME, since: '2026-09-11T14:00:00Z', until: '2026-09-11T19:00:00Z', bucket: 'hour', tz: TZ, now: NOW });
  assert.deepEqual([r.since, r.until, r.tz], ['2026-09-11T14:00:00.000Z', '2026-09-11T19:00:00.000Z', TZ]);
  assert.deepEqual(r.buckets.map((b) => b.key), ['2026-09-11 07', '2026-09-11 08', '2026-09-11 09', '2026-09-11 10', '2026-09-11 11', '2026-09-11 12']);
  assert.equal(r.buckets.find((b) => b.key === '2026-09-11 08').interrupts, 1);
  assert.equal(r.buckets.find((b) => b.key === '2026-09-11 11').closed.you, 1);
  store.close();
});

test('the window is the instants, not the buckets: an edge bucket counts only its part inside', () => {
  const store = fixture();
  // Sep 10 local runs 07:00Z–07:00Z; a window from 16:30Z that day starts
  // after o/r#1 arrived (16:00Z) and before o/r#2 did (17:00Z).
  const r = report(store, 'flow', { user: ME, since: '2026-09-10T16:30:00Z', until: '2026-09-12T20:30:00Z', tz: TZ, now: NOW });
  assert.equal(r.buckets[0].key, '2026-09-10');
  assert.equal(r.buckets[0].arrived, 1, 'only o/r#2 arrived inside the window');
  assert.equal(r.totals.arrived, 2, 'o/r#2 and the ledger row');
  // The snooze at 21:00Z on the 12th is after `until`: neither counted nor replayed.
  assert.equal(r.buckets.at(-1).parked, 0);
  assert.deepEqual(r.buckets.at(-1).states, { open: 2, snoozed: 0, later: 0, done: 2, muted: 0 });
  // The opening state still knows everything that happened before the window.
  assert.deepEqual(r.buckets[0].states, { open: 3, snoozed: 0, later: 0, done: 0, muted: 0 });
  const w = report(store, 'where', { user: ME, since: '2026-09-12T21:30:00Z', until: NOW.toISOString(), tz: TZ, now: NOW });
  assert.equal(w.rows.find((x) => x.key === 'o/q')?.actions.total ?? 0, 0, 'the snooze is before this window');
  store.close();
});

test('response measures from the last verdict before the window when the action is early in it', () => {
  const store = fixture();
  // The window opens after the P0 verdict (15:00Z) and before the Done (18:00Z).
  const r = report(store, 'response', { user: ME, since: '2026-09-11T16:00:00Z', until: NOW.toISOString(), tz: TZ, now: NOW });
  const done = r.samples.find((s) => s.action === 'done');
  assert.deepEqual([done.item_key, done.from, done.hours, done.bucket_key], ['o/r#1', 'verdict', 3, '2026-09-11']);
  store.close();
});

test('when: hour by weekday in the zone, yours apart from theirs apart from the bots, narrowed by source', () => {
  const store = fixture();
  const r = report(store, 'when', { user: ME, since: '2026-09-01T00:00:00Z', until: NOW.toISOString(), tz: TZ, now: NOW });
  assert.equal(r.tz, TZ);
  // Thu 09:00 local: ann on #1. Thu 10:00: bob on #2. Thu 11:00: the owner. Thu 12:00: the bot.
  const THU = 3;
  assert.equal(r.series.theirs[THU][9], 1);
  assert.equal(r.series.theirs[THU][10], 1);
  assert.equal(r.series.mine[THU][11], 1);
  assert.equal(r.series.bots[THU][12], 1);
  // the owner's Done from the page counts as his, at Fri 11:00 local; the snooze at Sat 14:00.
  assert.equal(r.series.mine[4][11], 1);
  assert.equal(r.series.mine[5][14], 1);
  // The interrupt landed Fri 08:00 local. The wake and the resolve are nobody's.
  assert.equal(r.series.interrupts[4][8], 1);
  assert.deepEqual(r.totals, { mine: 3, theirs: 3, bots: 1, interrupts: 1 }, 'the ledger row\'s owner kind counts as an actor, because the source said it was one');
  assert.deepEqual(r.peak.mine, { weekday: 'Thu', hour: 11, n: 1 });
  assert.equal(r.by_hour.theirs[9], 1);
  assert.equal(r.by_weekday.mine[THU], 1);
  // ?source= narrows every series to that source's items.
  const g = report(store, 'when', { user: ME, since: '2026-09-01T00:00:00Z', until: NOW.toISOString(), tz: TZ, now: NOW, source: 'github' });
  assert.deepEqual(g.totals, { mine: 3, theirs: 2, bots: 1, interrupts: 1 });
  assert.equal(g.source, 'github');
  store.close();
});

test('where: activity per key per bucket, ranked, with the tail folded into other', () => {
  const store = fixture();
  const opts = { user: ME, since: '2026-09-10T07:00:00Z', until: NOW.toISOString(), tz: TZ, now: NOW };
  const r = report(store, 'where', opts);
  assert.equal(r.by, 'repo');
  assert.deepEqual(r.series, ['events', 'verdicts', 'actions']);
  assert.equal(r.buckets.length, 6);
  assert.deepEqual(r.rows.map((x) => x.key), ['o/r', 'ledger', 'o/q'], 'by events, largest first; a row with no repo is under its source');
  const or = r.rows[0];
  assert.equal(or.events.total, 3);
  assert.deepEqual(or.events.buckets, [3, 0, 0, 0, 0, 0]);
  assert.deepEqual(or.verdicts.buckets, [1, 1, 0, 0, 0, 0]);
  assert.deepEqual(or.actions.buckets, [0, 1, 0, 0, 0, 0], 'the Done; not the wake, not the resolve');
  assert.deepEqual(r.rows[2].actions.buckets, [0, 0, 1, 0, 0, 0], 'the snooze on o/q is yours');
  // A rule is a verdict's; an actor is an event's.
  const rule = report(store, 'where', { ...opts, by: 'rule' });
  assert.deepEqual(rule.series, ['verdicts']);
  assert.deepEqual(rule.rows.map((x) => [x.key, x.verdicts.total]), [['state_change_on_mine', 2], ['past_its_nudge', 1], ['reply_to_my_comment', 1]]);
  const actor = report(store, 'where', { ...opts, by: 'actor' });
  assert.deepEqual(actor.series, ['events']);
  assert.deepEqual(actor.rows.map((x) => x.key), ['alice', 'ann', 'bob', 'coderabbitai[bot]', 'human-laptop']);
  assert.throws(() => report(store, 'where', { ...opts, by: 'colour' }), /by must be one of/);
  // Past TOP keys, the rest is one `other` row that says how many it holds.
  for (let n = 0; n < TOP + 3; n++) seed(store, `z/r${n}#1`, { created: at('2026-09-14T12:00:00Z'), repo: `z/r${n}`, events: [{ ts: '2026-09-14T12:00:00Z', actor: 'ann' }, { ts: '2026-09-14T12:01:00Z', actor: 'ann' }] });
  const many = report(store, 'where', opts);
  assert.equal(many.rows.length, TOP + 1);
  assert.equal(many.rows.at(-1).key, 'other');
  assert.equal(many.rows.at(-1).folded, TOP + 3 + 3 - TOP);
  store.close();
});

test('response: how long things waited for you, with the sample size on it; how long interrupts waited', () => {
  const store = fixture();
  const r = report(store, 'response', { user: ME, since: '2026-09-10T07:00:00Z', until: NOW.toISOString(), tz: TZ, now: NOW });
  // Two of the owner's actions: the Done, 3 h after the P0 verdict; the snooze, 52 h after #2's arrival verdict.
  assert.equal(r.n, 2);
  assert.deepEqual(r.samples.map((s) => [s.action, s.hours, s.from]), [['done', 3, 'verdict'], ['snooze', 52, 'verdict']]);
  assert.equal(r.median_h, 27.5);
  assert.equal(r.p90_h, 52);
  assert.deepEqual(r.by_action, { done: 1, snooze: 1 });
  assert.match(r.note, /2 of your actions/);
  assert.equal(r.buckets.find((b) => b.key === '2026-09-11').median_h, 3);
  assert.equal(r.buckets.find((b) => b.key === '2026-09-14').n, 0);
  assert.deepEqual(r.interrupts, { sent: 1, answered: 1, unanswered: 0, median_h: 3, p90_h: 3 });
  store.close();
});

test('the registry describes itself, and a bad ask is refused with a status', () => {
  const d = describeReports();
  assert.deepEqual(Object.keys(d.reports), ['flow', 'when', 'where', 'response']);
  assert.deepEqual(d.buckets, ['hour', 'day', 'week']);
  const store = new Store();
  assert.throws(() => report(store, 'nope', { user: ME }), (e) => e.status === 404);
  assert.throws(() => report(store, 'flow', { user: ME, bucket: 'fortnight' }), (e) => e.status === 400);
  assert.throws(() => report(store, 'flow', { user: ME, since: 'yesterday' }), (e) => e.status === 400);
  assert.throws(() => report(store, 'flow', { user: ME, since: '2026-09-02T00:00:00Z', until: '2026-09-01T00:00:00Z' }), /before/);
  assert.throws(() => report(store, 'flow', { user: ME, since: '2020-01-01T00:00:00Z', bucket: 'hour', now: NOW }), /coarser/);
  // The default window is thirty days by the day, ending now — and an empty store is zeros, not an error.
  const r = report(store, 'flow', { user: ME, now: NOW, tz: 'UTC' });
  assert.equal(r.until, NOW.toISOString());
  assert.equal(r.since, new Date(NOW.getTime() - 30 * DAY).toISOString());
  assert.equal(r.buckets.length, 31);
  assert.deepEqual(r.totals.open, { start: 0, end: 0, now: 0 });
  assert.equal(report(store, 'response', { user: ME, now: NOW }).median_h, null);
  store.close();
});
