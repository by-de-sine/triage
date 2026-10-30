import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { createActor, parseUntil } from '../lib/actions.js';
import { ingest, wake } from '../lib/pipeline.js';
import { score } from '../lib/rules.js';
import rules from '../rules/thread.js';
import github from '../sources/github.js';

const ME = 'alice';
const NOW = new Date('2026-09-08T12:00:00Z');
const seed = (store, over = {}) => {
  const { item } = store.upsertItem({ user: ME, source: 'github', key: 'o/r#1', kind: 'pull', title: 'T', url: 'https://github.com/o/r/pull/1', repo: 'o/r', last_activity: '2026-09-08T11:00:00Z', data: { thread_id: '77' }, ...over });
  store.setTier(item.id, 'P0', score('P0', item.last_activity, NOW.getTime()));
  return store.item(item.id);
};
function fakeGithub(fail = null) {
  const calls = [];
  return { calls, request: async (method, url) => { calls.push([method, url]); if (fail) throw fail; return { status: 205, body: null }; } };
}
/** What server.js builds: the source's own `mark`, handed its client. */
const marksFor = (api) => ({ github: (item) => github.mark(item, { api }) });

test('until accepts durations and future ISO times, refuses the past and nonsense', () => {
  assert.equal(parseUntil('1h', NOW), '2026-09-08T13:00:00.000Z');
  assert.equal(parseUntil('30m', NOW), '2026-09-08T12:30:00.000Z');
  assert.equal(parseUntil('1d', NOW), '2026-09-09T12:00:00.000Z');
  assert.equal(parseUntil('2026-09-09T07:30:00Z', NOW), '2026-09-09T07:30:00.000Z');
  assert.equal(parseUntil('2026-09-01T00:00:00Z', NOW), null);
  assert.equal(parseUntil('soon', NOW), null);
  assert.equal(parseUntil(undefined, NOW), null);
});

test('done sets the state, marks the GitHub thread read, and records both', async () => {
  const store = new Store();
  const item = seed(store);
  const github = fakeGithub();
  const reflected = [];
  const act = createActor({ store, marks: marksFor(github), deliver: { reflect: async (r) => reflected.push(r) }, now: () => NOW });
  const r = await act({ id: item.id, action: 'done', by: 'slack' });
  assert.equal(r.item.state, 'done');
  assert.equal(r.marked, 'marked read');
  assert.deepEqual(github.calls, [['PATCH', '/notifications/threads/77']]);
  const [a] = store.actionsFor(item.id);
  assert.equal(a.action, 'done'); assert.equal(a.by, 'slack'); assert.equal(a.data.marked, 'marked read');
  assert.equal(reflected.length, 1);
  assert.equal(reflected[0].action, 'done');
});

test('done still lands locally when GitHub refuses, and says why', async () => {
  const store = new Store();
  const item = seed(store);
  const logs = [];
  const act = createActor({ store, marks: marksFor(fakeGithub(Object.assign(new Error('GitHub 403 on PATCH …: Resource not accessible'), { status: 403 }))), now: () => NOW, log: (m) => logs.push(m) });
  const r = await act({ id: item.id, action: 'done' });
  assert.equal(r.item.state, 'done');
  assert.match(r.marked, /not marked read: GitHub 403 .* notifications scope/);
  assert.match(logs[0], /not marked read/);
  const none = seed(store, { key: 'o/r#2', data: {} });
  assert.match((await act({ id: none.id, action: 'done' })).marked, /no thread id/);
});

test('snooze needs an until; later sinks the score; mute and open flip state', async () => {
  const store = new Store();
  const item = seed(store);
  const act = createActor({ store, now: () => NOW });
  await assert.rejects(act({ id: item.id, action: 'snooze' }), { status: 400 });
  await assert.rejects(act({ id: item.id, action: 'snooze', until: 'yesterday' }), { status: 400 });
  let r = await act({ id: item.id, action: 'snooze', until: '1h' });
  assert.equal(r.item.state, 'snoozed'); assert.equal(r.item.state_until, '2026-09-08T13:00:00.000Z'); assert.equal(r.until, r.item.state_until);
  r = await act({ id: item.id, action: 'later' });
  assert.equal(r.item.state, 'later'); assert.equal(r.item.state_until, null);
  assert.ok(r.item.score < score('P3', '2026-09-08T11:00:00Z', NOW.getTime()), 'a Later P0 sinks beneath an open P3');
  assert.ok(r.item.score > score('P3', '2026-09-08T11:00:00Z', NOW.getTime(), { later: true }), 'and above a Later P3');
  r = await act({ id: item.id, action: 'mute' });
  assert.equal(r.item.state, 'muted');
  r = await act({ id: item.id, action: 'open' });
  assert.equal(r.item.state, 'open'); assert.ok(r.item.score > 1000);
  await assert.rejects(act({ id: item.id, action: 'archive' }), { status: 400 });
  await assert.rejects(act({ id: 999, action: 'done' }), { status: 404 });
  assert.deepEqual(store.actionsFor(item.id).map((a) => a.action), ['snooze', 'later', 'mute', 'open']);
});

const batch = (events, over = {}) => ({ item: { key: 'o/r#1', kind: 'pull', title: 'T', url: 'u', repo: 'o/r', actors: [], my_role: 'subscribed', last_activity: '2026-09-08T11:00:00Z', data: { thread_id: '77' }, ...over }, events });
const ev = (key, kind, actor, ts, over = {}) => ({ key, kind, actor, ts, body: '', data: {}, ...over });
class FakeDeliver { constructor() { this.calls = []; } async deliver(x) { this.calls.push(x); return { delivered: true, note: 'sent D1 1.0' }; } }

test('seen changes nothing but writes the row, by whoever ticked', async () => {
  const store = new Store();
  const item = seed(store);
  const reflected = [];
  const act = createActor({ store, marks: marksFor(fakeGithub()), deliver: { reflect: async (r) => reflected.push(r) }, now: () => NOW });
  const r = await act({ id: item.id, action: 'seen', by: 'seat' });
  assert.equal(r.item.state, 'open');
  assert.equal(r.item.score, item.score, 'the rank is untouched');
  assert.equal(r.marked, null, 'nothing is marked at the far end');
  const [a] = store.actionsFor(item.id);
  assert.deepEqual([a.action, a.by, a.until, a.data], ['seen', 'seat', null, {}]);
  assert.deepEqual(reflected, [], 'the DM is not redrawn: it keeps its buttons, and what the delivery holds is not dropped — nothing was dealt with');
  // A second look is a second row; a Later item stays later.
  await act({ id: item.id, action: 'later' });
  assert.equal(reflected.length, 1, 'later is reflected, as every state change is');
  await act({ id: item.id, action: 'seen' });
  assert.equal(reflected.length, 1, 'seen on a later item is still not');
  assert.equal(store.item(item.id).state, 'later');
  assert.deepEqual(store.actionsFor(item.id).map((x) => x.action), ['seen', 'later', 'seen']);
});

test('a snooze that has passed wakes on the next poll and re-delivers at its tier, however old the event', async () => {
  const store = new Store();
  const d = new FakeDeliver();
  await ingest(store, { user: ME, source: 'github', batches: [batch([ev('c1', 'comment', 'ann', '2026-09-08T11:00:00Z', { body: 'hey @alice' })])] }, { rules, deliver: d, now: NOW });
  const item = store.items()[0];
  assert.equal(d.calls.length, 1);
  const act = createActor({ store, now: () => NOW });
  await act({ id: item.id, action: 'snooze', until: '1d' });
  assert.deepEqual(await wake(store, { deliver: d, now: new Date('2026-09-09T11:59:00Z') }), []);
  const woke = await wake(store, { deliver: d, now: new Date('2026-09-09T12:00:00Z') });
  assert.equal(woke.length, 1);
  assert.equal(woke[0].rule, 'snooze_wake'); assert.equal(woke[0].tier, 'P0'); assert.equal(woke[0].delivered, true);
  assert.equal(d.calls.length, 2);
  assert.equal(d.calls[1].ignoreAge, true);
  assert.equal(d.calls[1].event.actor, 'ann');
  const after = store.item(item.id);
  assert.equal(after.state, 'open'); assert.equal(after.state_until, null);
  assert.deepEqual(store.actionsFor(item.id).map((a) => a.action), ['snooze', 'wake']);
  const decs = store.decisionsFor(item.id);
  assert.equal(decs.at(-1).by, 'wake'); assert.match(decs.at(-1).reason, /snooze ended — ann mentioned you/);
  // A P1 that wakes is placed, not sent, and its wake row says so — there
  // is no batch for it to wait on any more.
  store.setTier(item.id, 'P1', 100);
  await act({ id: item.id, action: 'snooze', until: '1h' });
  const w2 = await wake(store, { deliver: d, now: new Date('2026-09-09T13:00:00Z') });
  assert.equal(w2[0].tier, 'P1'); assert.equal(w2[0].delivered, false);
  assert.match(w2[0].note, /^not delivered: woke as P1; it is back in the list$/);
  assert.match(store.decisionsFor(item.id).at(-1).note, /woke as P1/);
  assert.equal(d.calls.length, 2);
});

test('a done item reopens on a new P1; a Later item only on a P0; muted stays muted', async () => {
  const store = new Store();
  const d = new FakeDeliver();
  const mine = (events) => batch(events, { my_role: 'authored' });
  await ingest(store, { user: ME, source: 'github', batches: [mine([ev('o1', 'opened', ME, '2026-09-08T10:00:00Z')])] }, { rules, deliver: d, now: NOW });
  const item = store.items()[0];
  const act = createActor({ store, now: () => NOW });
  await act({ id: item.id, action: 'done' });
  let r = await ingest(store, { user: ME, source: 'github', batches: [mine([ev('c1', 'comment', 'ann', '2026-09-08T12:30:00Z')])] }, { rules, deliver: d, now: NOW });
  assert.equal(r.decisions[0].tier, 'P1');
  assert.equal(store.item(item.id).state, 'open');
  await act({ id: item.id, action: 'later' });
  const sunk = store.item(item.id).score;
  r = await ingest(store, { user: ME, source: 'github', batches: [mine([ev('c2', 'comment', 'ann', '2026-09-08T12:40:00Z')])] }, { rules, deliver: d, now: NOW });
  assert.equal(r.decisions[0].tier, 'P1');
  assert.equal(store.item(item.id).state, 'later', 'a P1 does not lift Later');
  assert.ok(store.item(item.id).score < 1, `re-tiered while Later, still sunk (${store.item(item.id).score}, was ${sunk})`);
  r = await ingest(store, { user: ME, source: 'github', batches: [mine([ev('c3', 'comment', 'ann', '2026-09-08T12:50:00Z', { body: '@alice?' })])] }, { rules, deliver: d, now: NOW });
  assert.equal(r.decisions[0].tier, 'P0');
  assert.equal(store.item(item.id).state, 'open', 'a P0 does');
  assert.equal(r.decisions[0].delivered, true);
  await act({ id: item.id, action: 'mute' });
  r = await ingest(store, { user: ME, source: 'github', batches: [mine([ev('c4', 'comment', 'ann', '2026-09-08T12:55:00Z', { body: '@alice!!' })])] }, { rules, deliver: d, now: NOW });
  assert.equal(store.item(item.id).state, 'muted');
  assert.match(r.decisions[0].note, /item is muted/);
  assert.deepEqual(store.actionsFor(item.id).map((a) => `${a.action}:${a.by}`), ['done:api', 'reopen:system', 'later:api', 'reopen:system', 'mute:api']);
});

test('a snooze wakes on the poll even when GitHub is failing', async () => {
  const { Runner } = await import('../lib/runner.js');
  const store = new Store();
  const item = seed(store);
  const act = createActor({ store, now: () => NOW });
  await act({ id: item.id, action: 'snooze', until: '1h' });
  const d = new FakeDeliver();
  const runner = new Runner(store, [{ name: 'github', every: 60_000, poll: async () => { throw new Error('GitHub 502'); } }], { user: ME, rules: { github: rules }, deliver: d });
  const later = Date.now() + 2 * 3_600_000;
  const realDate = Date; globalThis.Date = class extends realDate { constructor(...a) { super(...(a.length ? a : [later])); } static now() { return later; } };
  try {
    const r = await runner.run('github');
    assert.equal(r.ok, false); assert.equal(r.woke.length, 1); assert.equal(r.woke[0].delivered, true);
  } finally { globalThis.Date = realDate; }
  assert.equal(store.item(item.id).state, 'open');
});
