import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { ingest } from '../lib/pipeline.js';
import rules from '../rules/thread.js';

const ME = 'alice';
const batch = (events, over = {}) => ({ item: { key: 'o/r#1', kind: 'pull', title: 'T', url: 'u', repo: 'o/r', actors: [], my_role: 'subscribed', last_activity: '2026-09-01T02:00:00Z', last_seen: '2026-09-01T02:00:00Z', ...over }, events });
const ev = (key, kind, actor, ts, over = {}) => ({ key, kind, actor, ts, body: '', data: {}, ...over });

class FakeDeliver { constructor() { this.calls = []; } async deliver(x) { this.calls.push(x); return { delivered: true, note: 'sent D1 1.0' }; } }

test('a batch becomes an item, its events, one decision; nothing new decides nothing', async () => {
  const s = new Store();
  const b = batch([ev('n1', 'notification', null, '2026-09-01T02:00:00Z', { data: { reason: 'comment' } }), ev('c1', 'comment', 'ann', '2026-09-01T00:00:00Z'), ev('c2', 'comment', ME, '2026-09-01T01:00:00Z'), ev('c3', 'comment', 'ann', '2026-09-01T02:00:00Z')]);
  const d = new FakeDeliver();
  // The clock is pinned: the score decays with age, and an unpinned `now`
  // made this pass in September and fail from October on.
  const r = await ingest(s, { user: ME, source: 'github', batches: [b] }, { rules, deliver: d, now: new Date('2026-09-01T03:00:00Z') });
  assert.deepEqual([r.items, r.created, r.events, r.delivered], [1, 1, 4, 1]);
  assert.equal(r.decisions[0].rule, 'reply_to_my_comment');
  const it = s.items()[0];
  assert.equal(it.tier, 'P0');
  assert.equal(it.my_role, 'commented');
  assert.ok(it.score > 1000);
  assert.equal(d.calls[0].event.actor, 'ann');
  assert.equal(s.decisions()[0].delivered, true);
  assert.equal(s.decisions()[0].note, 'sent D1 1.0');
  const again = await ingest(s, { user: ME, source: 'github', batches: [b] }, { rules, deliver: d });
  assert.deepEqual([again.items, again.created, again.events, again.decisions.length], [1, 0, 0, 0]);
  assert.equal(d.calls.length, 1);
  s.close();
});

test('P1–P3 verdicts are logged and never delivered; P0 without delivery says so', async () => {
  const s = new Store();
  const d = new FakeDeliver();
  const mine = batch([ev('o1', 'opened', ME, '2026-09-01T00:00:00Z'), ev('c1', 'comment', 'coderabbitai[bot]', '2026-09-01T01:00:00Z')], { my_role: 'authored' });
  let r = await ingest(s, { user: ME, source: 'github', batches: [mine] }, { rules, deliver: d });
  assert.equal(r.decisions[0].tier, 'P3');
  assert.equal(r.decisions[0].rule, 'bot_only');
  assert.equal(d.calls.length, 0);
  const p0 = batch([ev('c9', 'comment', 'ann', '2026-09-01T03:00:00Z', { body: 'hey @alice' })], { key: 'o/r#2' });
  r = await ingest(s, { user: ME, source: 'github', batches: [p0] }, { rules });
  assert.equal(r.decisions[0].tier, 'P0');
  assert.equal(r.decisions[0].delivered, false);
  assert.match(r.decisions[0].note, /no delivery configured/);
  assert.equal(s.decisions({ tier: 'P0', delivered: false }).length, 1);
  s.close();
});

test('a muted or snoozed item is tiered but not delivered', async () => {
  const s = new Store();
  const d = new FakeDeliver();
  const b = batch([ev('c1', 'comment', 'ann', '2026-09-01T03:00:00Z', { body: 'hey @alice' })]);
  await ingest(s, { user: ME, source: 'github', batches: [b] }, { rules, deliver: d });
  s.setState(s.items()[0].id, 'muted');
  const b2 = batch([ev('c2', 'comment', 'ann', '2026-09-01T04:00:00Z', { body: 'still @alice' })]);
  const r = await ingest(s, { user: ME, source: 'github', batches: [b2] }, { rules, deliver: d });
  assert.equal(r.decisions[0].tier, 'P0');
  assert.match(r.decisions[0].note, /item is muted/);
  assert.equal(d.calls.length, 1);
  s.close();
});

test('a failing delivery is recorded on the decision, not thrown', async () => {
  const s = new Store();
  const d = { deliver: async () => { throw new Error('socket closed'); } };
  const b = batch([ev('c1', 'comment', 'ann', '2026-09-01T03:00:00Z', { body: 'hey @alice' })]);
  const r = await ingest(s, { user: ME, source: 'github', batches: [b] }, { rules, deliver: d });
  assert.match(r.decisions[0].note, /delivery failed: socket closed/);
  s.close();
});

// --- the clock half (M3) ---------------------------------------------------
// A source may declare `due(ctx)`: what became true because time passed, not
// because the far end changed. It runs before the poll, in its own try, and
// its batches go through this same pipeline — so a P0 from the clock is
// delivered, logged and coalesced exactly like a P0 from a poll.
test('a source\'s due() runs on the clock, before the poll, and survives a poll that fails', async () => {
  const { Runner } = await import('../lib/runner.js');
  const { default: calendar } = await import('../sources/calendar.js');
  const { default: calRules } = await import('../rules/calendar.js');
  const s = new Store();
  const d = new FakeDeliver();
  const NOW = new Date('2026-09-09T12:00:00Z');
  const start = new Date(NOW.getTime() + 12 * 60_000).toISOString();
  // An event already in the store, twelve minutes out. Nothing changed at
  // Google; only the clock moved.
  s.upsertItem({ user: ME, source: 'calendar', key: 'e1', kind: 'event', title: 'Design review', url: 'https://cal/e1', last_activity: NOW.toISOString(),
    data: { start, all_day: false, status: 'confirmed', response: 'accepted', mine: false, guests: 3, organizer: 'ann@example.com', join: 'https://meet.google.com/x' } });
  const logs = [];
  const runner = new Runner(s, [{ ...calendar, poll: async () => { throw new Error('Google 503'); } }],
    { user: ME, rules: { calendar: calRules }, deliver: d, log: (m) => logs.push(m), extras: { calendar: {} } });
  runner.now = () => NOW;
  const r = await runner.run('calendar');
  assert.equal(r.ok, false);                       // the poll failed…
  assert.equal(r.due.decisions.length, 1);         // …and the alarm still rang
  const dec = s.decisions()[0];
  assert.equal(dec.tier, 'P0');
  assert.equal(dec.rule, 'starts_in_15_min');
  assert.match(dec.reason, /starts in \d+ min · a video call/);
  assert.equal(dec.delivered, true);
  assert.equal(d.calls[0].item.key, 'e1');
  // The alarm is an event, keyed by the start it is about: run it again and
  // nothing new is emitted, so the DM is not sent twice.
  const again = await runner.run('calendar');
  assert.deepEqual([again.due.events, again.due.decisions.length], [0, 0]);
  assert.equal(s.decisions().length, 1);
  assert.equal(d.calls.length, 1);
  s.close();
});

test('a source with no due() is unchanged, and one whose due() throws still polls', async () => {
  const { Runner } = await import('../lib/runner.js');
  const s = new Store();
  const logs = [];
  const b = batch([ev('c1', 'comment', 'ann', '2026-09-01T03:00:00Z', { body: 'hey @alice' })]);
  const src = { name: 'github', every: 60_000, due: () => { throw new Error('clock broke'); }, poll: async () => ({ batches: [b], cursor: 1 }) };
  const runner = new Runner(s, [src], { user: ME, rules: { github: rules }, log: (m) => logs.push(m) });
  const r = await runner.run('github');
  assert.equal(r.ok, true);
  assert.equal(r.decisions.length, 1);
  assert.match(logs.find((m) => m.includes('due')), /due — Error: clock broke/);
  s.close();
});
