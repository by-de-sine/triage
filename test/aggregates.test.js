// The queue as counts (plan §13.6): what a program asks before it reads a
// row. A query over what is already there — nothing written, nothing judged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { aggregates, AGE_BANDS } from '../lib/aggregates.js';
import { Ranker, rerank } from '../lib/rank.js';
import { createActor } from '../lib/actions.js';

const ME = 'alice';
const NOW = new Date('2026-09-10T12:00:00Z');
const HOUR = 3_600_000, DAY = 86_400_000;
const ranker = () => new Ranker({ shapes: { github: () => 'waiting' }, now: () => NOW });

function seed(store, key, { tier, rules, repo = 'o/r', ageMs = DAY, kind = 'pull', source = 'github' }) {
  const { item } = store.upsertItem({ user: ME, source, key, kind, title: key, url: `https://x/${key}`, repo, last_activity: new Date(NOW.getTime() - ageMs).toISOString() });
  store.setTier(item.id, tier, 1);
  const matches = rules.map(([rule, claim]) => ({ rule, tier, reason: `${rule} fired`, claim }));
  store.addDecision({ item_id: item.id, rule: matches[0].rule, tier, reason: matches[0].reason, event_ids: [], matches }, NOW.toISOString());
  rerank(store, ranker(), store.item(item.id), { matches, now: NOW });
  return store.item(item.id);
}

test('counts and spreads by source, repo, rule, tier, kind and age; the share of one repo; the rank distribution', async () => {
  const store = new Store();
  seed(store, 'a#1', { tier: 'P0', rules: [['reply_to_my_comment', 0.95]], repo: 'o/a', ageMs: 10 * 60_000 });
  seed(store, 'a#2', { tier: 'P2', rules: [['state_change_on_mine', 0.25], ['bot_only', 0.05]], repo: 'o/a', ageMs: 3 * HOUR });
  seed(store, 'a#3', { tier: 'P2', rules: [['state_change_on_mine', 0.25]], repo: 'o/a', ageMs: 3 * DAY, kind: 'issue' });
  seed(store, 'b#1', { tier: 'P3', rules: [['bot_only', 0.05]], repo: 'o/b', ageMs: 10 * DAY });
  seed(store, 'e1', { tier: 'P3', rules: [['ambient', 0.1]], repo: null, source: 'calendar', kind: 'event', ageMs: 40 * DAY });
  // A snoozed item is not in the open queue, and an unranked one is counted as such.
  const sn = seed(store, 'b#2', { tier: 'P1', rules: [['review_on_my_pr', 0.6]], repo: 'o/b' });
  await createActor({ store, rank: ranker(), now: () => NOW })({ id: sn.id, action: 'snooze', until: '1h' });
  store.upsertItem({ user: ME, source: 'github', key: 'b#3', kind: 'pull', title: 'unranked', url: 'u', repo: 'o/b' });

  const A = aggregates(store, { user: ME, rank: ranker(), now: NOW });
  assert.equal(A.state, 'open');
  assert.equal(A.total, 6);
  assert.deepEqual(A.by.source, { github: 5, calendar: 1 });
  assert.deepEqual(A.by.repo, { 'o/a': 3, 'o/b': 2, calendar: 1 }, 'largest first; a meeting counts under its source');
  assert.deepEqual(A.by.kind, { pull: 4, event: 1, issue: 1 });
  assert.deepEqual(A.by.tier, { P0: 1, P1: 0, P2: 2, P3: 3 }, 'the unranked item has no tier and reads as P3');
  assert.deepEqual(A.by.rule, { state_change_on_mine: 2, ambient: 1, bot_only: 1, reply_to_my_comment: 1 }, 'the strongest match per item');
  assert.deepEqual(A.by.matches, { state_change_on_mine: 2, bot_only: 2, ambient: 1, reply_to_my_comment: 1 }, 'every rule that fired — bot_only corroborated a#2');
  assert.deepEqual(Object.keys(A.by.age), AGE_BANDS.map(([l]) => l));
  assert.deepEqual(A.by.age, { '<1h': 1, '<1d': 1, '<7d': 1, '<30d': 1, '30d+': 1 }, 'the unranked item has no last_activity and no band');
  assert.equal(A.by.state, undefined, 'one state asked for, so no spread by state');
  // Saturation, said outright: half the list is one repository.
  assert.deepEqual(A.share.repo, { top: 'o/a', n: 3, of: 6, fraction: 0.5 });
  assert.equal(A.share.source.top, 'github');
  // The ranks: five ranked, one not, the same read-time numbers the page orders by.
  assert.equal(A.rank.ranked, 5);
  assert.equal(A.rank.unranked, 1);
  assert.ok(A.rank.max > A.rank.median && A.rank.median >= A.rank.min, `${JSON.stringify(A.rank)}`);
  assert.equal(Object.keys(A.rank.buckets).length, 10);
  assert.equal(Object.values(A.rank.buckets).reduce((a, b) => a + b, 0), 5);
  const live = ranker().order(store.itemsForAggregate({ user: ME, state: 'open' }), NOW).filter((r) => r.rank_at).map((r) => r.rank);
  assert.equal(A.rank.max, Math.round(Math.max(...live) * 10_000) / 10_000);
  // Nothing was written.
  assert.equal(store.decisions().length, 6);
  assert.equal(store.actionsFor(sn.id).length, 1);
  store.close();
});

test('state=all counts every state and says how they split; an empty queue is zeros, not an error', () => {
  const store = new Store();
  const empty = aggregates(store, { user: ME, now: NOW });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.by.tier, { P0: 0, P1: 0, P2: 0, P3: 0 });
  assert.equal(empty.share.repo, null);
  assert.deepEqual([empty.rank.ranked, empty.rank.min, empty.rank.median], [0, null, null]);
  const a = seed(store, 'a#1', { tier: 'P2', rules: [['assigned', 0.45]] });
  store.setState(a.id, 'done');
  seed(store, 'a#2', { tier: 'P3', rules: [['ambient', 0.1]] });
  const all = aggregates(store, { user: ME, state: 'all', now: NOW });
  assert.equal(all.total, 2);
  assert.deepEqual(all.by.state, { done: 1, open: 1 });
  assert.equal(aggregates(store, { user: ME, state: 'done', now: NOW }).total, 1);
  // Without a ranker the stored ranks are reported, not a crash.
  assert.equal(all.rank.ranked, 2);
  store.close();
});
