// The scorer (M5, plan §11.4). Three structural terms, per-source time
// curves, absence that is not zero, and a stored base plus a read-time time
// term with hysteresis — the stability §11.4 says to decide before the first
// blend rather than after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { Ranker, SHAPES, parsePreferences, rerank, DEFAULT_WEIGHTS } from '../lib/rank.js';
import { backfill } from '../lib/backfill.js';
import { ingest } from '../lib/pipeline.js';
import githubRules from '../rules/thread.js';
import githubSource from '../sources/github.js';
import calendarSource from '../sources/calendar.js';
import calendarRules from '../rules/calendar.js';

const ME = 'alice';
const NOW = new Date('2026-09-10T12:00:00Z');
const at = (ms) => new Date(NOW.getTime() + ms);
const HOUR = 3_600_000, DAY = 86_400_000;
// The real declarations, out of the sources themselves — a copy of them here
// would pass while the thing that ships was wrong.
const SHAPE_OF = { github: githubSource.time, calendar: calendarSource.time };
const ranker = (over = {}) => new Ranker({ shapes: SHAPE_OF, now: () => NOW, ...over });
const thread = (over = {}) => ({ id: 1, source: 'github', kind: 'pull', repo: 'o/r', state: 'open', actors: ['ann'], last_activity: NOW.toISOString(), ...over });
const meeting = (over = {}) => ({ id: 2, source: 'calendar', kind: 'event', repo: null, state: 'open', actors: [], last_activity: NOW.toISOString(), data: { start: at(20 * 60_000).toISOString() }, ...over });
const M = (rule, tier, claim, reason = rule) => ({ rule, tier, reason, claim });

test('time is per source and per kind — one curve could not say what any of them mean', () => {
  const r = ranker();
  // A reply waiting on you is MORE urgent the longer it sits: the wait is
  // the cost. This is the case the old score() got backwards.
  const fresh = r.time(thread({ last_activity: NOW.toISOString() }));
  const week = r.time(thread({ last_activity: at(-7 * DAY).toISOString() }));
  const june = r.time(thread({ last_activity: at(-80 * DAY).toISOString() }));
  assert.equal(fresh.name, 'waiting');
  assert.ok(week.value > fresh.value, 'a week of waiting is worse than a minute of it');
  assert.ok(june.value > week.value && june.value < 1, 'saturating: bad, and not infinitely bad');
  // A reply that has only just landed is urgent, not timeless: 0.5 is the
  // middle of the scale and means "time says nothing", which is the zero
  // point `fading` and `spike` share (see SHAPES).
  assert.equal(fresh.value, 0.5);
  assert.ok(week.value > 0.5 && june.value > 0.9);
  assert.match(week.why, /waiting 7 d — the wait is the cost/);

  // A release is news and goes stale — the opposite slope, same source.
  const rel = r.time(thread({ kind: 'release', last_activity: at(-2 * DAY).toISOString() }));
  assert.equal(rel.name, 'fading');
  assert.equal(rel.value, 2 ** -4, 'two days is four half-lives');
  assert.ok(r.time(thread({ kind: 'release' })).value === 1);

  // A meeting spikes at T-15 and is worthless at T+1.
  assert.equal(r.time(meeting()).name, 'spike');
  assert.equal(r.time(meeting({ data: { start: at(10 * 60_000).toISOString() } })).value, 1, 'inside the quarter hour');
  assert.equal(r.time(meeting({ data: { start: at(-5 * 60_000).toISOString() } })).value, 1, 'under way');
  assert.equal(r.time(meeting({ data: { start: at(-2 * HOUR).toISOString() } })).value, 0, 'an hour past the start');
  assert.equal(r.time(meeting({ data: { start: at(30 * 60_000).toISOString() } })).value, 0.5, 'T-30');
  // An all-day entry has no minute to be late for: flat, and present.
  assert.equal(r.time(meeting({ data: { all_day: true } })).name, 'flat');
  // A source nobody has asked gets `waiting`, not a crash.
  assert.equal(r.time({ source: 'gmail', last_activity: NOW.toISOString() }).name, 'waiting');
  assert.equal(SHAPES.spike({ startMs: null }), null);
});

test('claim: the strongest sets the floor and the rest corroborate', () => {
  const r = ranker();
  const one = r.claim([M('reply_to_my_comment', 'P0', 0.95)]);
  const three = r.claim([M('reply_to_my_comment', 'P0', 0.95), M('review_requested', 'P0', 0.8), M('comment_on_my_thread', 'P1', 0.55)]);
  assert.equal(one.value, 0.95);
  assert.ok(three.value > one.value, 'three rules firing is more than one');
  assert.equal(three.value, Math.min(1, 0.95 + 0.25 * (0.8 + 0.55)));
  // The explanation names the strongest and says what else agreed with it.
  assert.match(three.why, /^reply_to_my_comment \(\+ review_requested, comment_on_my_thread\) — /);
  // Weightless corroboration is configurable, and zero means "top only".
  assert.equal(ranker({ corroborate: 0 }).claim([M('a', 'P0', 0.9), M('b', 'P1', 0.6)]).value, 0.9);
});

test('a missing feature stays missing — absent is not zero', () => {
  const r = ranker();
  // No rule verdict on record is the backlog's case, and the honest answer
  // is "nobody has computed this", not "this has no claim".
  const none = r.claim([]);
  assert.equal(none.value, null);
  assert.match(none.why, /no rule verdict on record/);

  // An item with no claim ranks on what IS known about it rather than being
  // dragged to the floor: the absent term leaves the denominator.
  const known = r.rank(thread({ last_activity: at(-3 * DAY).toISOString() }), { matches: [M('x', 'P2', 0.3)], now: NOW });
  const unknown = r.rank(thread({ last_activity: at(-3 * DAY).toISOString() }), { matches: [], now: NOW });
  const claimTerm = unknown.features.terms.find((t) => t.name === 'claim');
  assert.equal(claimTerm.absent, true);
  assert.equal(claimTerm.value, null);
  assert.equal(claimTerm.contribution, 0);
  // Time is 0.75 at three days of waiting; the weighted mean over the terms
  // that are present is exactly that, not that divided by a denominator the
  // absent term still occupied.
  assert.equal(unknown.rank, 0.75);
  assert.ok(unknown.rank > known.rank, 'a P2 whose claim IS known scores its claim, which is lower');

  // And a claim of zero is a real zero, which is a different thing.
  const zero = r.rank(thread(), { matches: [M('nothing', 'P3', 0)], now: NOW });
  assert.equal(zero.features.terms.find((t) => t.name === 'claim').absent, false);

  // M6's two terms are declared and absent, so the shape is proved before
  // anything computes them (plan §11.5).
  const names = known.features.terms.map((t) => t.name);
  assert.deepEqual(names, ['claim', 'prefer', 'time', 'relevance', 'effort']);
  for (const n of ['relevance', 'effort']) assert.equal(known.features.terms.find((t) => t.name === n).absent, true);
});

test('stated preference is structure a scorer with no model can read', () => {
  assert.deepEqual(parsePreferences('repo:Acme/widgets=0.8, source:calendar=0.3'), [
    { field: 'repo', value: 'acme/widgets', weight: 0.8 },
    { field: 'source', value: 'calendar', weight: 0.3 },
  ]);
  // A bare owner/name is a repo; a bare word is a source; junk is ignored.
  assert.deepEqual(parsePreferences('o/r=1\nnot a preference\nactor:carol=-0.5'), [
    { field: 'repo', value: 'o/r', weight: 1 },
    { field: 'actor', value: 'carol', weight: -0.5 },
  ]);
  const r = ranker({ prefer: 'repo:o/r=1, actor:ann=0.2' });
  // The strongest statement that names the item wins, so a repo you care
  // about is not diluted by a person you are neutral about.
  assert.match(r.preference(thread()).why, /you said repo o\/r matters/);
  assert.equal(r.preference(thread()).value, 1);
  assert.equal(r.preference(thread({ repo: 'x/y', actors: [] })).value, 0.5, 'named by nothing is the middle, not the floor');
  assert.equal(r.preference(thread({ repo: 'x/y', actors: ['ann'] })).value, 0.6);
  // With nothing stated the term is absent rather than a flat half.
  assert.equal(ranker().preference(thread()).value, null);
});

test('later sinks in the ranking too, or the verb means two different things', () => {
  const r = ranker();
  const open = r.rank(thread(), { matches: [M('reply_to_my_comment', 'P0', 0.95)], now: NOW, state: 'open' });
  const later = r.rank(thread(), { matches: [M('reply_to_my_comment', 'P0', 0.95)], now: NOW, state: 'later' });
  assert.ok(later.rank < open.rank / 1000, 'a P0 you tossed away sits beneath an open P3');
  const p3 = r.rank(thread(), { matches: [M('ambient', 'P3', 0.1)], now: NOW, state: 'open' });
  assert.ok(later.rank < p3.rank);
});

test('explainability: the top contributing term and its sentence are on the item', () => {
  const r = ranker({ prefer: 'repo:o/r=1' });
  const out = r.rank(thread({ last_activity: at(-6 * HOUR).toISOString() }), { matches: [M('reply_to_my_comment', 'P0', 0.95, 'ann commented after you did')], now: NOW });
  assert.equal(out.features.top, 'claim');
  assert.match(out.features.why, /reply_to_my_comment — ann commented after you did/);
  // Every term keeps its weight, its value and what it contributed — §11.7
  // item 1's answer to "why is this at position 12".
  for (const t of out.features.terms) assert.deepEqual(Object.keys(t), ['name', 'weight', 'value', 'absent', 'contribution', 'why']);
  assert.equal(out.features.matches.length, 1);
  // A meeting about to start is topped by time, not by claim — which is the
  // whole point of the term being per source.
  const soon = r.rank(meeting({ data: { start: at(5 * 60_000).toISOString() } }), { matches: [M('starts_in_15_min', 'P0', 1, 'starts in 5 min')], now: NOW });
  assert.match(soon.features.terms.find((t) => t.name === 'time').why, /starts in 5 min/);
});

test('stability: the base is stored, the time term is read-time, hysteresis holds the order', () => {
  const r = ranker({ hysteresis: 0.05 });
  const item = thread({ last_activity: at(-DAY).toISOString() });
  const written = r.rank(item, { matches: [M('reply_to_my_comment', 'P0', 0.95)], now: NOW });
  const stored = { ...item, rank: written.rank, rank_base: written.base, rank_at: NOW.toISOString(), features: written.features };

  // A minute later nothing has happened: the list does not move.
  const still = r.live(stored, at(60_000));
  assert.equal(still.rank, written.rank);
  assert.equal(still.moved, false);

  // A week later the wait itself has changed what this is worth, and it does.
  const week = r.live(stored, at(7 * DAY));
  assert.equal(week.moved, true);
  assert.ok(week.rank > written.rank, 'the wait is the cost, and it has grown');

  // An item the ranker has never written is left exactly as it is found —
  // that is the backfill's job, not the read path's.
  assert.deepEqual(r.live({ ...item, rank: 0.4, rank_at: null }), { rank: 0.4, moved: false, why: null, top: null });

  // order() is the one place anything sorts, so nothing can disagree about
  // what is first — and a stored rank that has drifted from the item's own
  // features is corrected as it is read, rather than ordering the page by a
  // number nobody can reproduce.
  const ambient = r.rank(item, { matches: [M('ambient', 'P3', 0.1)], now: NOW });
  const rows = [{ ...stored, id: 1 }, { ...stored, id: 2, rank: 0.9, rank_base: 0.9, features: ambient.features }];
  assert.deepEqual(r.order(rows, NOW).map((x) => x.id), [1, 2]);
  assert.equal(r.order(rows, NOW)[1].rank, ambient.rank);
});

test('the label on the line is the fresh top term, not the one stored at decision time', async () => {
  // Found on the live page, 2026-09-11: `why` is recomputed at read time and
  // `top` was read from the stored features, so a row showed the claim's
  // sentence tagged `top term: time` once the news had gone stale. Both
  // come from the same blend now, and they travel together to the page.
  const r = ranker();
  const item = thread({ last_activity: at(-HOUR).toISOString() });
  const news = [M('state_change_on_mine', 'P2', 0.25, 'your pull was merged')];
  const written = r.rank(item, { matches: news, now: NOW });
  assert.equal(written.features.top, 'time', 'an hour old, the news is what puts it where it is');
  const stored = { ...item, rank: written.rank, rank_base: written.base, rank_at: NOW.toISOString(), features: written.features };
  // A day later the time term has drained and the claim leads: sentence and
  // label agree, and neither is the stored one.
  const later = r.live(stored, at(DAY));
  assert.equal(later.moved, true);
  assert.equal(later.top, 'claim');
  assert.match(later.why, /^state_change_on_mine — your pull was merged/);
  // Inside hysteresis both are the stored pair, not one of each.
  const soon = r.live(stored, at(60_000));
  assert.equal(soon.moved, false);
  assert.deepEqual([soon.top, soon.why], [written.features.top, written.features.why]);
  // And order() carries both, so lib/lists.js reads the pair it was handed.
  const [row] = r.order([{ ...stored, id: 9 }], at(DAY));
  assert.equal(row.top, 'claim');
  assert.match(row.why, /state_change_on_mine/);
  const { brief } = await import('../lib/lists.js');
  assert.equal(brief(row).top, 'claim');
  assert.equal(brief({ ...stored, id: 9 }).top, 'time', 'a row nothing re-timed still says what it was stored as');
});

test('the weights are config, and a weight of zero takes a term out of the blend', () => {
  const only = new Ranker({ shapes: SHAPE_OF, weights: { time: 0, prefer: 0 }, now: () => NOW });
  const out = only.rank(thread({ last_activity: at(-30 * DAY).toISOString() }), { matches: [M('x', 'P1', 0.6)], now: NOW });
  assert.equal(out.rank, 0.6, 'claim alone, at its own value');
  assert.equal(only.describe().weights.claim, DEFAULT_WEIGHTS.claim);
});

// ---- the backfill (plan §11.8) ---------------------------------------------

test('the backfill re-runs the rules over stored history and persists what it finds', async () => {
  const store = new Store();
  const r = ranker();
  const { item } = store.upsertItem({ user: ME, source: 'github', key: 'o/r#1', kind: 'pull', title: 'old', url: 'u', repo: 'o/r', my_role: 'authored', last_activity: at(-60 * DAY).toISOString() });
  const [, reply] = store.addEvents(item.id, [
    { key: 'e1', ts: at(-61 * DAY).toISOString(), kind: 'comment', actor: ME, body: 'mine' },
    { key: 'e2', ts: at(-60 * DAY).toISOString(), kind: 'comment', actor: 'ann', body: 'after yours' },
  ]);
  // The verdict on record, exactly as the pipeline wrote it before M5: one
  // rule, and the events it was about.
  store.addDecision({ item_id: item.id, rule: 'reply_to_my_comment', tier: 'P0', reason: 'ann commented after you did', event_ids: [reply.id] }, at(-60 * DAY).toISOString());
  assert.equal(store.item(item.id).rank, null, 'nothing would ever have ranked this');
  assert.equal(store.countUnranked(ME), 1);

  const out = backfill(store, { user: ME, rules: { github: githubRules }, rank: r, now: NOW });
  assert.equal(out.ranked, 1);
  assert.equal(out.absent, 0);
  const after = store.item(item.id);
  assert.ok(after.rank > 0);
  assert.equal(after.features.from, 'backfill');
  // Widened, not re-decided: the rules ran against the events that verdict
  // was about, and returned the whole set this time.
  assert.deepEqual(after.features.matches.map((m) => m.rule), ['reply_to_my_comment', 'comment_on_my_thread']);
  assert.match(after.features.why, /reply_to_my_comment/);
  // It does not invent history: no decision row was added, and the one that
  // was there keeps its single rule.
  assert.equal(store.decisionsFor(item.id).length, 1);
  assert.equal(store.decisionsFor(item.id)[0].rule, 'reply_to_my_comment');
  assert.equal(store.countUnranked(ME), 0);
  // And it is idempotent: a second pass walks nothing.
  assert.equal(backfill(store, { user: ME, rules: { github: githubRules }, rank: r, now: NOW }).ranked, 0);
  assert.equal(backfill(store, { user: ME, rules: { github: githubRules }, rank: r, all: true, now: NOW }).ranked, 1, 'all:1 re-ranks after a weight change');
  store.close();
});

test('the backfill leaves a feature it cannot know absent, and says why', () => {
  const store = new Store();
  const r = ranker();
  // An item with no verdict on record: nothing said what it was about.
  const { item } = store.upsertItem({ user: ME, source: 'github', key: 'o/r#2', kind: 'pull', title: 'bare', url: 'u', repo: 'o/r', last_activity: at(-10 * DAY).toISOString() });
  // And one from a source with no rules registered at all.
  const { item: alien } = store.upsertItem({ user: ME, source: 'gmail', key: 'm1', kind: 'mail', title: 'later source', url: 'u', last_activity: at(-DAY).toISOString() });
  const [ev] = store.addEvents(alien.id, [{ key: 'g1', ts: at(-DAY).toISOString(), kind: 'mail', actor: 'ann' }]);
  store.addDecision({ item_id: alien.id, rule: 'ambient', tier: 'P3', reason: 'subscribed', event_ids: [ev.id] }, at(-DAY).toISOString());

  const out = backfill(store, { user: ME, rules: { github: githubRules }, rank: r, now: NOW });
  assert.equal(out.ranked, 2);
  assert.equal(out.absent, 2);

  for (const [id, why] of [[item.id, /no verdict on record/], [alien.id, /no rules registered for source gmail/]]) {
    const f = store.item(id).features;
    const claim = f.terms.find((t) => t.name === 'claim');
    assert.equal(claim.absent, true, 'absent, not defaulted to zero');
    assert.equal(claim.value, null);
    assert.match(f.absent_because, why);
    // It is still ranked — on the terms that ARE known about it.
    assert.ok(store.item(id).rank > 0);
  }
  store.close();
});

test('every writer of items.score writes the rank beside it (plan §11.8, trap 1)', async () => {
  const store = new Store();
  const r = ranker();
  const { createActor } = await import('../lib/actions.js');
  const act = createActor({ store, rank: r, now: () => NOW });
  const batches = [{
    item: { key: 'o/r#9', kind: 'pull', title: 'live', url: 'u', repo: 'o/r', my_role: 'authored', last_activity: NOW.toISOString() },
    events: [{ key: 'x1', ts: NOW.toISOString(), kind: 'comment', actor: 'ann', body: 'hi' }],
  }];
  // Writer one: a verdict.
  await ingest(store, { user: ME, source: 'github', batches }, { rules: githubRules, rank: r, now: NOW });
  const id = store.itemByKey(ME, 'github', 'o/r#9').id;
  const open = store.item(id);
  assert.ok(open.rank > 0 && open.rank_at, 'a verdict ranks the item');
  assert.deepEqual(open.features.matches.map((m) => m.rule), ['comment_on_my_thread']);
  // And the whole set is on the decision row, not just the strongest.
  assert.deepEqual(store.decisionsFor(id).at(-1).matches.map((m) => m.rule), ['comment_on_my_thread']);

  // Writer two: later. Sunk in both orderings, or the verb means two things.
  await act({ id, action: 'later' });
  assert.ok(store.item(id).rank < open.rank / 1000, 'later sinks the rank, not only the score');
  assert.ok(store.item(id).score < 1);

  // Writer three: open, the undo for either.
  await act({ id, action: 'open' });
  assert.ok(Math.abs(store.item(id).rank - open.rank) < 1e-9, 'reopening restores it');

  // Writer four: a snooze that wakes.
  const { wake } = await import('../lib/pipeline.js');
  await act({ id, action: 'snooze', until: '1h' });
  const later = new Date(NOW.getTime() + 2 * HOUR);
  await wake(store, { rank: r, now: later });
  const woke = store.item(id);
  assert.equal(woke.state, 'open');
  assert.ok(woke.rank > 0, 'waking re-ranks rather than leaving the sunk value behind');
  assert.equal(woke.rank_at, later.toISOString());
  store.close();
});

test('rerank with no ranker is a no-op, so replay and the tests behave as they did', () => {
  const store = new Store();
  const { item } = store.upsertItem({ user: ME, source: 'github', key: 'o/r#3', kind: 'pull', title: 't', url: 'u', repo: 'o/r' });
  assert.equal(rerank(store, null, item), null);
  assert.equal(store.item(item.id).rank, null);
  store.close();
});

test('the calendar ranks through the same scorer, with its own curve', async () => {
  const store = new Store();
  const r = ranker();
  const soon = { key: 'e-soon', kind: 'event', title: 'Design review', url: 'u', repo: null, last_activity: NOW.toISOString(), data: { start: at(12 * 60_000).toISOString(), guests: 2 } };
  const far = { key: 'e-far', kind: 'event', title: 'Next week', url: 'u', repo: null, last_activity: NOW.toISOString(), data: { start: at(6 * DAY).toISOString(), guests: 2 } };
  await ingest(store, { user: ME, source: 'calendar', batches: [
    { item: soon, events: [{ key: 's1', ts: NOW.toISOString(), kind: 'starts', actor: null, data: { start: soon.data.start } }] },
    { item: far, events: [{ key: 'f1', ts: NOW.toISOString(), kind: 'update', actor: null, data: {} }] },
  ] }, { rules: calendarRules, rank: r, now: NOW });
  const a = store.itemByKey(ME, 'calendar', 'e-soon'), b = store.itemByKey(ME, 'calendar', 'e-far');
  assert.ok(a.rank > b.rank, 'the one starting in twelve minutes is above the one next week');
  assert.match(a.features.why, /starts in 12 min/);
  store.close();
});

// ---- the review's findings, pinned ------------------------------------------

test('a wake carries the original evidence forward, so a second one does not rank on itself', async () => {
  const store = new Store();
  const r = ranker();
  const { createActor } = await import('../lib/actions.js');
  const { wake } = await import('../lib/pipeline.js');
  const act = createActor({ store, rank: r, now: () => NOW });
  const { item } = store.upsertItem({ user: ME, source: 'github', key: 'o/r#7', kind: 'pull', title: 'a reply', url: 'u', repo: 'o/r', last_activity: NOW.toISOString() });
  const matches = [M('reply_to_my_comment', 'P0', 0.95, 'ann commented after you did'), M('comment_on_my_thread', 'P1', 0.55)];
  store.setTier(item.id, 'P0', 1000);
  store.addDecision({ item_id: item.id, rule: 'reply_to_my_comment', tier: 'P0', reason: 'ann commented after you did', event_ids: [], matches }, NOW.toISOString());
  const ranked = r.rank(store.item(item.id), { matches, now: NOW }).rank;

  // Two snooze-and-wake cycles. The first wake's decision is what the second
  // one reads back, so if it carries no matches the item is re-ranked on the
  // synthetic `snooze_wake` rule — a different claim and a different curve.
  for (const n of [1, 2]) {
    await act({ id: item.id, action: 'snooze', until: '1h' });
    await wake(store, { rank: r, now: new Date(NOW.getTime() + n * 2 * HOUR) });
    const woke = store.item(item.id);
    assert.equal(woke.state, 'open', `cycle ${n}`);
    assert.deepEqual(woke.features.matches.map((m) => m.rule), ['reply_to_my_comment', 'comment_on_my_thread'], `cycle ${n} lost the evidence`);
    assert.ok(woke.rank > ranked * 0.9, `cycle ${n} re-ranked on the wake rule`);
  }
  assert.deepEqual(store.decisionsFor(item.id).at(-1).matches.map((m) => m.rule), ['reply_to_my_comment', 'comment_on_my_thread']);
  store.close();
});

test('the backfill asks the rules about the events the verdict was about, not about everything', () => {
  const store = new Store();
  const r = ranker();
  // June: you comment, ann replies. August: it merges. The verdict on record
  // is the merge. Handing the rules the whole history would make the June
  // reply "fresh" and put this on the `waiting` curve, claiming a person is
  // blocked on you when the thread is closed.
  const { item } = store.upsertItem({ user: ME, source: 'github', key: 'o/r#8', kind: 'pull', title: 'long gone', url: 'u', repo: 'o/r', my_role: 'authored', last_activity: at(-30 * DAY).toISOString() });
  const [, , merged] = store.addEvents(item.id, [
    { key: 'j1', ts: at(-80 * DAY).toISOString(), kind: 'comment', actor: ME, body: 'mine' },
    { key: 'j2', ts: at(-79 * DAY).toISOString(), kind: 'comment', actor: 'ann', body: 'after yours' },
    { key: 'a1', ts: at(-30 * DAY).toISOString(), kind: 'state', actor: ME, data: { state: 'merged' } },
  ]);
  store.addDecision({ item_id: item.id, rule: 'state_change_on_mine', tier: 'P2', reason: 'your pull was merged', event_ids: [merged.id] }, at(-30 * DAY).toISOString());

  backfill(store, { user: ME, rules: { github: githubRules }, rank: r, now: NOW });
  const f = store.item(item.id).features;
  assert.equal(f.matches.some((m) => m.rule === 'reply_to_my_comment'), false, 'the June reply is not fresh news in August');
  assert.deepEqual(f.matches.map((m) => m.rule), ['state_change_on_mine', 'own_activity']);
  // And so it is news, which fades, rather than a wait that grows.
  assert.equal(f.terms.find((t) => t.name === 'time').why.includes('goes stale fast'), true);
  store.close();
});

test('a cancelled or declined meeting gets no spike, however close its start', () => {
  const r = ranker();
  const soon = { start: at(5 * 60_000).toISOString() };
  const going = { ...meeting({ data: soon }), features: { matches: [M('starts_in_15_min', 'P0', 1)] } };
  const off = { ...meeting({ data: { ...soon, status: 'cancelled' } }), features: { matches: [M('cancelled', 'P3', 0.02)] } };
  const no = { ...meeting({ data: { ...soon, response: 'declined' } }), features: { matches: [M('declined', 'P3', 0.02)] } };
  assert.equal(r.time(going, NOW, going.features.matches).value, 1);
  assert.equal(r.time(off, NOW, off.features.matches).name, 'flat');
  assert.equal(r.time(no, NOW, no.features.matches).name, 'flat');
  assert.ok(r.rank(off, { now: NOW }).rank < r.rank(going, { now: NOW }).rank / 5);
});

test('a stated preference may name a whole account (plan §14.2)', () => {
  // One statement about every repo under an owner is what anybody with more
  // than three of them wants to write, and what a project's `weight` in the
  // preferences file needs. Exact matching is unchanged where there is no `*`.
  const r = ranker({ prefer: 'repo:Acme/*=0.8, repo:o/r=0.2' });
  assert.equal(r.preference({ repo: 'acme/widgets', source: 'github' }).value, 0.9);
  assert.match(r.preference({ repo: 'Acme/site', source: 'github' }).why, /you said repo acme\/\* matters/);
  assert.equal(r.preference({ repo: 'o/r', source: 'github' }).value, 0.6);
  assert.equal(r.preference({ repo: 'someone/else', source: 'github' }).value, 0.5);
  assert.equal(r.preference({ repo: null, source: 'github' }).value, 0.5, 'a glob never matches a missing value');
});
