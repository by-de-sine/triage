// One ordered list (M5, plan §11.3) — and the reason it matters: on
// 2026-09-10 the service held 51 open items it showed none of, because
// GROUPS listed neither P2 nor P3 and P2's only surface was a Slack digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { lists, GROUP_BY } from '../lib/lists.js';
import { Ranker, rerank } from '../lib/rank.js';

const ME = 'alice';
const NOW = new Date('2026-09-10T12:00:00Z');
const DAY = 86_400_000;
const ranker = () => new Ranker({ shapes: { github: () => 'waiting' }, now: () => NOW });

function seed(store, key, { tier, rule, claim, repo = 'o/r', ageDays = 1, source = 'github', kind = 'pull' }) {
  const { item } = store.upsertItem({ user: ME, source, key, kind, title: key, url: `https://x/${key}`, repo, last_activity: new Date(NOW.getTime() - ageDays * DAY).toISOString() });
  store.setTier(item.id, tier, 1);
  store.addDecision({ item_id: item.id, rule, tier, reason: `${rule} fired`, event_ids: [], matches: [{ rule, tier, reason: `${rule} fired`, claim }] }, NOW.toISOString());
  rerank(store, ranker(), store.item(item.id), { matches: [{ rule, tier, reason: `${rule} fired`, claim }], now: NOW });
  return store.item(item.id);
}

test('the list holds everything open — the P2s and P3s that were invisible included', () => {
  const store = new Store();
  seed(store, 'o/r#1', { tier: 'P0', rule: 'reply_to_my_comment', claim: 0.95 });
  seed(store, 'o/r#2', { tier: 'P2', rule: 'state_change_on_mine', claim: 0.25 });
  seed(store, 'o/r#3', { tier: 'P3', rule: 'bot_only', claim: 0.05 });
  const L = lists(store, { user: ME, rank: ranker(), now: NOW });
  assert.deepEqual(L.groups.map((g) => g.key), ['queue', 'snoozed', 'later']);
  assert.deepEqual(L.groups[0].items.map((i) => i.key), ['o/r#1', 'o/r#2', 'o/r#3']);
  assert.deepEqual(L.counts, { P0: 1, P1: 0, P2: 1, P3: 1 });
  // The tier is a word on the line now, not a section heading.
  assert.deepEqual(L.groups[0].items.map((i) => i.tier), ['P0', 'P2', 'P3']);
  store.close();
});

test('the order is the rank, not the tier — a stale P0 can sit under a fresh P2', () => {
  const store = new Store();
  // A P3 that has been waiting two months against a P2 from an hour ago.
  // The time term is what lets either of them cross a tier boundary, which
  // the old score() could never do.
  seed(store, 'old', { tier: 'P1', rule: 'comment_on_my_thread', claim: 0.55, ageDays: 60 });
  seed(store, 'new', { tier: 'P1', rule: 'comment_on_my_thread', claim: 0.55, ageDays: 0 });
  const L = lists(store, { user: ME, rank: ranker(), now: NOW });
  assert.deepEqual(L.groups[0].items.map((i) => i.key), ['old', 'new'], 'the wait is the cost');
  store.close();
});

test('every line carries the top term and its sentence, which is what makes it explainable', () => {
  const store = new Store();
  seed(store, 'o/r#1', { tier: 'P0', rule: 'reply_to_my_comment', claim: 0.95 });
  const [row] = lists(store, { user: ME, rank: ranker(), now: NOW }).groups[0].items;
  assert.equal(row.top, 'claim');
  assert.match(row.why, /reply_to_my_comment — reply_to_my_comment fired/);
  assert.deepEqual(row.matches, ['reply_to_my_comment']);
  assert.ok(row.rank > 0);
  // And the tier's own ordering is still on the line, untouched (§11.8).
  assert.equal(row.score, 1);
  store.close();
});

test('grouping cuts the queue without reordering it', () => {
  const store = new Store();
  seed(store, 'a#1', { tier: 'P0', rule: 'direct_mention', claim: 0.9, repo: 'o/a' });
  seed(store, 'b#1', { tier: 'P1', rule: 'review_on_my_pr', claim: 0.6, repo: 'o/b' });
  seed(store, 'a#2', { tier: 'P2', rule: 'state_change_on_mine', claim: 0.25, repo: 'o/a' });
  const flat = lists(store, { user: ME, rank: ranker(), now: NOW });
  const byRepo = lists(store, { user: ME, rank: ranker(), now: NOW, group: 'repo' });
  assert.equal(byRepo.group, 'repo');
  assert.deepEqual(byRepo.groups.map((g) => g.key), ['queue:o/a', 'queue:o/b', 'snoozed', 'later']);
  // The first group holds the item that was first in the flat list, so
  // grouping changes how the page is drawn and never what is at the top.
  assert.equal(byRepo.groups[0].items[0].key, flat.groups[0].items[0].key);
  assert.deepEqual(byRepo.groups[0].items.map((i) => i.key), ['a#1', 'a#2']);
  assert.deepEqual(Object.keys(GROUP_BY), ['source', 'repo', 'tier', 'kind', 'owner']);
  store.close();
});

test('a filter narrows every group under one clause, and leaves the tiles whole', async () => {
  const store = new Store();
  const { createActor } = await import('../lib/actions.js');
  const act = createActor({ store, rank: ranker(), now: () => NOW });
  seed(store, 'a#1', { tier: 'P0', rule: 'direct_mention', claim: 0.9, repo: 'o/a' });
  seed(store, 'b#1', { tier: 'P1', rule: 'review_on_my_pr', claim: 0.6, repo: 'o/b' });
  seed(store, 'a#2', { tier: 'P1', rule: 'state_change_on_mine', claim: 0.25, repo: 'o/a' });
  const parked = seed(store, 'a#3', { tier: 'P1', rule: 'comment_on_my_thread', claim: 0.5, repo: 'o/a' });
  await act({ id: parked.id, action: 'snooze', until: '1h' });
  store.upsertItem({ user: ME, source: 'ledger', key: 'ask-1', kind: 'todo', title: 'need the sudo password', url: null, repo: null, data: { owner: 'human-sudo' } });
  // By tier: the tile a reader pressed. The snoozed P1 is still snoozed,
  // and the counts on the tiles say what the whole queue holds.
  const p1 = lists(store, { user: ME, rank: ranker(), now: NOW, filter: { tier: 'P1' } });
  assert.deepEqual(p1.filter, { tier: 'P1' });
  assert.deepEqual(p1.groups[0].items.map((i) => i.key), ['b#1', 'a#2']);
  assert.deepEqual(p1.groups[1].items.map((i) => i.key), ['a#3']);
  assert.deepEqual(p1.counts, { P0: 1, P1: 2, P2: 0, P3: 0 }, 'the tiles count what is open, whatever is pressed');
  // By repo: the tag on a row. A source with no repo is narrowed by name.
  assert.deepEqual(lists(store, { user: ME, filter: { repo: 'o/a' } }).groups[0].items.map((i) => i.key), ['a#1', 'a#2']);
  assert.deepEqual(lists(store, { user: ME, filter: { source: 'ledger' } }).groups[0].items.map((i) => i.key), ['ask-1']);
  assert.deepEqual(lists(store, { user: ME, filter: { owner: 'human-sudo' } }).groups[0].items.map((i) => i.key), ['ask-1']);
  assert.deepEqual(lists(store, { user: ME, filter: { owner: 'agent' } }).groups[0].items, []);
  // By a word, in the title or the key or the repo, case-insensitively;
  // a LIKE wildcard in the word is a character, not a wildcard.
  assert.deepEqual(lists(store, { user: ME, filter: { q: 'SUDO' } }).groups[0].items.map((i) => i.key), ['ask-1']);
  assert.deepEqual(lists(store, { user: ME, filter: { q: 'o/b' } }).groups[0].items.map((i) => i.key), ['b#1']);
  assert.deepEqual(lists(store, { user: ME, filter: { q: '%' } }).groups[0].items, []);
  // They compose with each other and with a group, and "more" is counted
  // under the same clause: two P1s in o/a, one shown, one more.
  const both = lists(store, { user: ME, limit: 1, group: 'repo', filter: { tier: 'P1', repo: 'o/a' } });
  assert.deepEqual(both.groups.map((g) => [g.key, g.items.length, g.more]), [['queue:o/a', 1, 0], ['snoozed', 1, 0], ['later', 0, 0]]);
  const one = lists(store, { user: ME, limit: 1, filter: { repo: 'o/a' } });
  assert.deepEqual([one.groups[0].items.length, one.groups[0].more], [1, 1]);
  // Nothing asked for is nothing narrowed.
  assert.equal(lists(store, { user: ME, filter: { tier: '', q: null } }).filter, null);
  store.close();
});

test('snoozed keeps its wake-time order: it is a queue of alarms, not of claims', async () => {
  const store = new Store();
  const { createActor } = await import('../lib/actions.js');
  const act = createActor({ store, rank: ranker(), now: () => NOW });
  const soon = seed(store, 'soon', { tier: 'P3', rule: 'ambient', claim: 0.1 });
  const late = seed(store, 'late', { tier: 'P0', rule: 'direct_mention', claim: 0.9 });
  await act({ id: late.id, action: 'snooze', until: '1d' });
  await act({ id: soon.id, action: 'snooze', until: '1h' });
  const L = lists(store, { user: ME, rank: ranker(), now: NOW });
  assert.deepEqual(L.groups[1].items.map((i) => i.key), ['soon', 'late'], 'the one that rings first is first');
  store.close();
});

test('a list read without a ranker is the stored order, not a crash', () => {
  const store = new Store();
  seed(store, 'o/r#1', { tier: 'P0', rule: 'direct_mention', claim: 0.9 });
  const L = lists(store, { user: ME });
  assert.equal(L.groups[0].items.length, 1);
  // The stored rank is still on the line — what is missing is the read-time
  // time term, which is exactly what "no ranker" should cost.
  assert.equal(L.groups[0].items[0].rank, store.item(store.itemByKey(ME, 'github', 'o/r#1').id).rank);
  assert.match(L.groups[0].items[0].why, /direct_mention/);
  store.close();
});

test('/api/items orders by the rank, and says so when asked for the other one', async () => {
  const store = new Store();
  // Sunk by the tier's ordering, top of the list by the rank: a Later P0.
  const hot = seed(store, 'hot', { tier: 'P2', rule: 'assigned', claim: 0.45, ageDays: 30 });
  const cold = seed(store, 'cold', { tier: 'P0', rule: 'direct_mention', claim: 0.9 });
  store.setScore(cold.id, 0.0001);
  assert.deepEqual(store.items({ user: ME, order: 'score' }).map((i) => i.key), ['hot', 'cold']);
  assert.deepEqual(store.items({ user: ME }).map((i) => i.key), ['cold', 'hot'], 'rank is the default');
  // An item the backfill has not reached does not head the list.
  store.upsertItem({ user: ME, source: 'github', key: 'unranked', kind: 'pull', title: 'u', url: 'u', repo: 'o/r' });
  assert.equal(store.items({ user: ME }).at(-1).key, 'unranked');
  store.close();
});
