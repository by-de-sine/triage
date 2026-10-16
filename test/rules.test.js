import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, score } from '../lib/rules.js';
import rules from '../rules/github.js';

const ME = 'alice';
let n = 0;
const ev = (kind, actor, ts, over = {}) => ({ id: ++n, key: `k${n}`, kind, actor, ts, body: '', data: {}, ...over });
const item = (over = {}) => ({ id: 1, kind: 'pull', repo: 'o/r', my_role: 'subscribed', ...over });
const run = (it, history, freshCount) => decide(rules, it, history.slice(-freshCount), { me: ME, history });

test('every rule has a name, a tier and a match; the last is a catch-all', () => {
  for (const r of rules) { assert.ok(r.name && r.tier && typeof r.match === 'function', r.name); }
  assert.equal(rules.at(-1).name, 'ambient');
  assert.equal(run(item(), [ev('notification', null, '2026-09-01T00:00:00Z', { data: { reason: 'subscribed' } })], 1).tier, 'P3');
});

test('P0: a human comments on a thread you commented in, after your last comment', () => {
  const h = [ev('comment', 'ann', '2026-09-01T00:00:00Z'), ev('comment', ME, '2026-09-01T01:00:00Z'), ev('comment', 'ann', '2026-09-01T02:00:00Z')];
  const d = run(item(), h, 1);
  assert.equal(d.rule, 'reply_to_my_comment');
  assert.equal(d.tier, 'P0');
  assert.match(d.reason, /ann commented after you/);
  // Before your comment is not a reply; a bot is not a person.
  assert.notEqual(run(item(), [ev('comment', 'ann', '2026-09-01T00:00:00Z'), ev('comment', ME, '2026-09-01T01:00:00Z')], 2).tier, 'P0');
  const bot = [ev('comment', ME, '2026-09-01T01:00:00Z'), ev('comment', 'coderabbitai[bot]', '2026-09-01T02:00:00Z')];
  assert.equal(run(item(), bot, 1).rule, 'bot_only');
});

test('P0: a review-comment reply whose in_reply_to_id is yours', () => {
  const h = [ev('review_comment', ME, '2026-09-01T00:00:00Z', { data: { id: 10 } }), ev('review_comment', 'bob', '2026-09-01T00:30:00Z', { data: { id: 11, in_reply_to_id: 10 } })];
  const d = run(item(), h, 1);
  assert.equal(d.rule, 'reply_to_my_review_comment');
  const other = [ev('review_comment', ME, '2026-09-01T00:00:00Z', { data: { id: 10 } }), ev('review_comment', 'bob', '2026-09-01T00:30:00Z', { data: { id: 11, in_reply_to_id: 99 } })];
  assert.equal(run(item(), other, 1).rule, 'reply_to_my_comment'); // still after your last comment
});

test('P0: a direct @mention, but not a substring or your own', () => {
  assert.equal(run(item(), [ev('comment', 'ann', '2026-09-01T00:00:00Z', { body: 'cc @alice for the migration' })], 1).rule, 'direct_mention');
  assert.equal(run(item(), [ev('comment', 'ann', '2026-09-01T00:00:00Z', { body: 'cc @alicent' })], 1).rule, 'ambient');
  assert.equal(run(item(), [ev('comment', ME, '2026-09-01T00:00:00Z', { body: 'note to @alice' })], 1).rule, 'own_activity');
  assert.equal(run(item(), [ev('opened', 'ann', '2026-09-01T00:00:00Z', { body: '@Alice please look' })], 1).rule, 'direct_mention');
});

test('P0: review requested by a human; not by a bot', () => {
  assert.equal(run(item({ my_role: 'review_requested' }), [ev('review_request', 'ann', '2026-09-01T00:00:00Z', { data: { by_bot: false } })], 1).rule, 'review_requested');
  assert.equal(run(item({ my_role: 'review_requested' }), [ev('review_request', 'dependabot[bot]', '2026-09-01T00:00:00Z', { data: { by_bot: true } })], 1).rule, 'bot_only');
});

test('P0: a human just opened a pull request in a repo you follow; not a bot, not yours, not an old one met for the first time', () => {
  const now = new Date('2026-10-15T20:00:00Z');
  const runAt = (it, history) => decide(rules, it, history, { me: ME, history, now });
  const d = runAt(item(), [ev('opened', 'carol-contrib', '2026-10-15T19:22:18Z')]);
  assert.equal(d.rule, 'new_pull_request');
  assert.equal(d.tier, 'P0');
  assert.equal(d.reason, 'carol-contrib opened a pull request');
  assert.equal(runAt(item(), [ev('opened', 'carol-contrib', '2026-10-14T21:00:00Z')]).rule, 'new_pull_request', 'opened overnight is still news');
  assert.equal(runAt(item(), [ev('opened', 'dependabot[bot]', '2026-10-15T19:00:00Z')]).rule, 'bot_only', 'a bot is not waiting on you');
  assert.equal(runAt(item({ my_role: 'authored' }), [ev('opened', ME, '2026-10-15T19:00:00Z')]).rule, 'own_activity');
  assert.equal(runAt(item(), [ev('opened', 'ann', '2025-03-01T00:00:00Z'), ev('comment', 'bob', '2026-10-15T19:00:00Z')]).rule, 'ambient',
    'the first sighting of an old pull request synthesises `opened`; that is not somebody who just opened it');
  assert.equal(runAt(item({ kind: 'issue' }), [ev('opened', 'ann', '2026-10-15T19:00:00Z')]).rule, 'new_issue', 'an issue stays P2');
  // A review request on the same pull request is the stronger statement and leads.
  const both = runAt(item(), [ev('opened', 'ann', '2026-10-15T19:00:00Z'), ev('review_request', 'ann', '2026-10-15T19:00:01Z', { data: { by_bot: false } })]);
  assert.deepEqual(both.matches.map((m) => m.rule), ['review_requested', 'new_pull_request']);
});

test('P1: comments and reviews on what you authored', () => {
  const mine = item({ my_role: 'authored' });
  assert.equal(run(mine, [ev('comment', 'ann', '2026-09-01T00:00:00Z')], 1).rule, 'comment_on_my_thread');
  const d = run(mine, [ev('review', 'ann', '2026-09-01T00:00:00Z', { data: { state: 'CHANGES_REQUESTED' } })], 1);
  assert.equal(d.rule, 'review_on_my_pr');
  assert.equal(d.reason, 'ann changes requested your PR');
  // Once you have replied in the thread, a further human comment is P0.
  const h = [ev('opened', ME, '2026-08-31T00:00:00Z'), ev('comment', 'ann', '2026-09-01T00:00:00Z'), ev('comment', ME, '2026-09-01T01:00:00Z'), ev('comment', 'ann', '2026-09-01T02:00:00Z')];
  assert.equal(run(mine, h, 1).tier, 'P0');
});

test('P2: state changes on yours, assignment, new issues in any repo you follow', () => {
  assert.equal(run(item({ my_role: 'authored' }), [ev('state', null, '2026-09-01T00:00:00Z', { data: { state: 'merged' } })], 1).rule, 'state_change_on_mine');
  assert.equal(run(item(), [ev('notification', null, '2026-09-01T00:00:00Z', { data: { reason: 'assign' } })], 1).rule, 'assigned');
  // Was `new_issue_on_my_repo`: the owner condition excluded every repo you
  // actually file in (plan §12.1), so it is gone and the rule is `new_issue`.
  assert.equal(run(item({ kind: 'issue', repo: 'Alice/thing' }), [ev('opened', 'ann', '2026-09-01T00:00:00Z')], 1).rule, 'new_issue');
  assert.equal(run(item({ kind: 'issue', repo: 'other/thing' }), [ev('opened', 'ann', '2026-09-01T00:00:00Z')], 1).rule, 'new_issue');
  assert.equal(run(item({ kind: 'pull', repo: 'other/thing' }), [ev('opened', 'ann', '2026-09-01T00:00:00Z')], 1).rule, 'ambient', 'a pull request is not an issue');
  assert.equal(run(item({ kind: 'issue' }), [ev('opened', 'Alice', '2026-09-01T00:00:00Z')], 1).rule, 'own_activity', 'a login is the same login in any case');
});

test('P2 as state: an open issue assigned to you, or filed by you, is a fact about the item and not about the poll', () => {
  const open = (data, over = {}) => item({ kind: 'issue', repo: 'o/r', data: { state: 'open', author: 'ann', assignees: [], ...data }, ...over });
  const tick = [ev('open', null, '2026-09-01T00:00:00Z', { data: { assignees: [] } })];
  let d = run(open({ assignees: ['Alice'] }), tick, 1);
  assert.equal(d.rule, 'issue_assigned_to_me'); assert.equal(d.tier, 'P2'); assert.match(d.reason, /assigned to you and still open/);
  d = run(open({ author: 'ALICE' }, { my_role: 'authored' }), tick, 1);
  assert.equal(d.rule, 'my_open_issue'); assert.match(d.reason, /you filed it/);
  // Both at once: the assignment is the stronger claim, and the other corroborates.
  d = run(open({ author: 'alice', assignees: ['alice'] }), tick, 1);
  assert.deepEqual(d.matches.map((m) => m.rule), ['issue_assigned_to_me', 'my_open_issue']);
  // An agent filed it as you and nobody has touched it: `own_activity` no longer buries it.
  d = run(open({ author: 'alice' }, { my_role: 'authored' }), [ev('opened', ME, '2026-09-01T00:00:00Z')], 1);
  assert.equal(d.rule, 'my_open_issue');
  assert.ok(d.matches.some((m) => m.rule === 'own_activity'), 'still observed, just not on top');
  // Closed, or somebody else's: nothing.
  assert.equal(run(open({ state: 'closed', assignees: ['alice'] }), tick, 1).rule, 'ambient');
  assert.equal(run(open({ assignees: ['bob'] }), tick, 1).rule, 'ambient');
  assert.equal(run(item({ kind: 'pull', data: { state: 'open', author: 'alice' } }), tick, 1).rule, 'ambient', 'a pull request of yours is not an open issue');
  // The inbox's comment on your open issue: both the movement and the state.
  d = run(open({ author: 'alice' }, { my_role: 'authored' }), [ev('comment', 'ann', '2026-09-01T00:00:00Z')], 1);
  assert.deepEqual(d.matches.map((m) => m.rule), ['comment_on_my_thread', 'my_open_issue']);
});

test('P3: releases, your own activity, bot-only threads', () => {
  assert.equal(run(item({ kind: 'release' }), [ev('notification', null, 'x', { data: { reason: 'subscribed' } })], 1).rule, 'release');
  assert.equal(run(item({ my_role: 'authored' }), [ev('comment', ME, 'x')], 1).rule, 'own_activity');
  assert.equal(run(item({ my_role: 'authored' }), [ev('comment', 'coderabbitai[bot]', 'x'), ev('review', 'github-code-quality[bot]', 'x')], 2).rule, 'bot_only');
});

test('score orders by tier then recency', () => {
  const now = Date.parse('2026-09-08T00:00:00Z');
  assert.ok(score('P0', '2026-01-01T00:00:00Z', now) > score('P1', '2026-09-08T00:00:00Z', now));
  assert.ok(score('P1', '2026-09-07T00:00:00Z', now) > score('P1', '2026-09-01T00:00:00Z', now));
});

test('bot detection needs a delimiter after a known prefix', async () => {
  const { isBot } = await import('../lib/util.js');
  for (const b of ['dependabot[bot]', 'renovate-bot', 'coderabbitai', 'github-actions[bot]', 'Copilot']) assert.equal(isBot(b), true, b);
  for (const h of ['copilotalice', 'renovater', 'alice', 'codecovfan']) assert.equal(isBot(h), false, h);
});

// --- calendar (M3) ---------------------------------------------------------
// The same contract, a different source: pure, named, ordered, first match
// wins, and the last one always matches.
const { default: cal } = await import('../rules/calendar.js');

const CNOW = new Date('2026-09-09T12:00:00Z');
const cin = (min) => new Date(CNOW.getTime() + min * 60_000).toISOString();
const cev = (kind, over = {}) => ({ id: ++n, key: `c${n}`, kind, actor: 'ann@example.com', ts: cin(0), body: null, data: {}, ...over });
const cItem = (data = {}) => ({ id: 1, key: 'e1', kind: 'event', source: 'calendar', repo: null, my_role: 'attendee', data: { start: cin(12), all_day: false, status: 'confirmed', response: 'accepted', mine: false, guests: 3, organizer: 'ann@example.com', join: null, location: null, ...data } });
const crun = (it, fresh) => decide(cal, it, fresh, { me: ME, history: fresh, now: CNOW });

test('calendar: every rule has a name, a tier and a match; the last is a catch-all', () => {
  for (const r of cal) assert.ok(r.name && r.tier && typeof r.match === 'function', r.name);
  assert.equal(cal.at(-1).name, 'ambient');
  assert.equal(crun(cItem(), [cev('rsvp_changed')]).rule, 'ambient');   // a kind no rule reads still gets a verdict
});

test('calendar P0: it starts in 15 minutes, and says where', () => {
  const d = crun(cItem(), [cev('starts', { ts: cin(12), data: { start: cin(12), in_min: 12 } })]);
  assert.equal(d.rule, 'starts_in_15_min');
  assert.equal(d.tier, 'P0');
  assert.equal(d.reason, 'starts in 12 min');
  assert.equal(crun(cItem({ join: 'https://meet.google.com/x' }), [cev('starts', { ts: cin(3), data: { start: cin(3) } })]).reason, 'starts in 3 min · a video call');
  assert.equal(crun(cItem({ location: 'Room 2' }), [cev('starts', { ts: cin(0), data: { start: cin(0) } })]).reason, 'starts now · Room 2');
  // Not for one you declined, one that was cancelled, or an all-day entry —
  // `due()` will not emit the event, and the rule refuses it a second time.
  for (const data of [{ response: 'declined' }, { status: 'cancelled' }, { all_day: true }]) {
    assert.notEqual(crun(cItem(data), [cev('starts', { ts: cin(5), data: { start: cin(5) } })]).tier, 'P0');
  }
});

test('calendar P1: a new invitation nobody has answered', () => {
  const d = crun(cItem({ response: 'needsAction' }), [cev('invite', { data: { response: 'needsAction' } })]);
  assert.equal(d.rule, 'new_invitation');
  assert.equal(d.tier, 'P1');
  assert.match(d.reason, /ann@example\.com invited you — you have not answered/);
  // An invitation to your own event is not one: the source never emits it.
  assert.equal(crun(cItem({ mine: true, guests: 3 }), [cev('update')]).rule, 'day_ahead');
});

test('calendar P2: the day-ahead brief', () => {
  const d = crun(cItem(), [cev('update')]);
  assert.equal(d.rule, 'day_ahead');
  assert.equal(d.tier, 'P2');
  assert.equal(d.reason, 'on your calendar — ann@example.com');
  assert.equal(crun(cItem({ mine: true, organizer: null }), [cev('update')]).reason, 'on your calendar');
});

test('calendar P3: declined, cancelled, all-day, and your own event with no guests', () => {
  assert.equal(crun(cItem({ response: 'declined' }), [cev('update')]).rule, 'declined');
  assert.equal(crun(cItem({ status: 'cancelled' }), [cev('cancelled')]).rule, 'cancelled');
  assert.equal(crun(cItem({ all_day: true, mine: true, guests: 0 }), [cev('update')]).rule, 'all_day');
  assert.equal(crun(cItem({ mine: true, guests: 0 }), [cev('update')]).rule, 'own_event');
  // `guests` counts everyone but you, so one guest is a meeting, not a block.
  assert.equal(crun(cItem({ mine: true, guests: 1 }), [cev('update')]).rule, 'day_ahead');
  // Nothing fresh that a rule reads still gets a verdict: the catch-all.
  assert.equal(crun(cItem(), [cev('something_else')]).rule, 'ambient');
});

test('calendar: your own event with no guests is P3 in the brief and still rings at 15 min', () => {
  const block = cItem({ mine: true, guests: 0, organizer: null });
  // Not in the day-ahead brief: a focus block is not one of the day's meetings.
  assert.equal(crun(block, [cev('update')]).rule, 'own_event');
  // But the alarm still fires — Google cannot tell a focus block from a
  // dentist appointment, and missing the second is worse than a DM about the
  // first. Deliberate, not an oversight in the rule order.
  const d = crun(block, [cev('starts', { ts: cin(9), data: { start: cin(9) } })]);
  assert.equal(d.rule, 'starts_in_15_min');
  assert.equal(d.tier, 'P0');
});

// ---- M5: every match, not the first (plan §11.3) ---------------------------

test('the verdict is a set: the strongest first, every corroborating match behind it', () => {
  // A human replies to your comment *and* asks for your review, on a thread
  // you authored. Three rules fire; first-match-wins could only ever see one
  // of them, and an item with three is strictly more urgent than one with one.
  const h = [
    ev('comment', ME, '2026-09-01T01:00:00Z'),
    ev('comment', 'ann', '2026-09-01T02:00:00Z'),
    ev('review_request', 'ann', '2026-09-01T02:05:00Z', { data: {} }),
  ];
  const d = decide(rules, item({ my_role: 'authored' }), h.slice(1), { me: ME, history: h });
  // The strongest match keeps every meaning it had.
  assert.equal(d.rule, 'reply_to_my_comment');
  assert.equal(d.tier, 'P0');
  assert.match(d.reason, /ann commented after you/);
  assert.deepEqual(d.matches.map((m) => m.rule), ['reply_to_my_comment', 'review_requested', 'comment_on_my_thread']);
  assert.deepEqual(d.matches.map((m) => m.tier), ['P0', 'P0', 'P1']);
  // Each carries its own claim, which is what the ranker reads.
  assert.deepEqual(d.matches.map((m) => m.claim), [0.95, 0.8, 0.55]);
  // matches[0] is the verdict, not a copy of something beside it.
  assert.equal(d.matches[0].reason, d.reason);
});

test('the catch-all corroborates nothing: it is kept only when it is alone', () => {
  // `ambient` matches everything by contract. In a set it would sit on every
  // verdict in the store and mean nothing at all.
  const h = [ev('comment', ME, '2026-09-01T01:00:00Z'), ev('comment', 'ann', '2026-09-01T02:00:00Z')];
  const d = decide(rules, item(), h.slice(1), { me: ME, history: h });
  assert.equal(d.matches.some((m) => m.rule === 'ambient'), false);
  // Alone, it is the whole verdict and is still logged like any other.
  const q = decide(rules, item(), [ev('notification', null, '2026-09-01T00:00:00Z', { data: { reason: 'subscribed' } })], { me: ME, history: [] });
  assert.deepEqual(q.matches.map((m) => m.rule), ['ambient']);
  assert.equal(q.tier, 'P3');
});

test('a rule with no claim falls back to its tier, so an untuned source still ranks', async () => {
  const { claimOf, TIER_CLAIM, matchAll } = await import('../lib/rules.js');
  assert.equal(claimOf({ tier: 'P1' }), TIER_CLAIM.P1);
  assert.equal(claimOf({ tier: 'P0', claim: 0.3 }), 0.3);
  assert.equal(claimOf({ tier: 'P0', claim: 0 }), 0, 'a claim of zero is a claim, not a missing one');
  // And matchAll is decide() without the verdict wrapper — the backfill's door in.
  const only = matchAll([{ name: 'x', tier: 'P2', match: () => 'because' }], item(), [], { me: ME, history: [] });
  assert.deepEqual(only, [{ rule: 'x', tier: 'P2', reason: 'because', claim: TIER_CLAIM.P2 }]);
});

test('every rule in both sources declares a claim, and the catch-alls are marked', async () => {
  const calendar = (await import('../rules/calendar.js')).default;
  for (const r of [...rules, ...calendar]) {
    assert.equal(typeof r.claim, 'number', `${r.name} has no claim`);
    assert.ok(r.claim >= 0 && r.claim <= 1, `${r.name} claim out of range`);
  }
  assert.equal(rules.at(-1).fallback, true);
  assert.equal(calendar.at(-1).fallback, true);
  assert.equal(rules.filter((r) => r.fallback).length, 1, 'exactly one catch-all');
});
