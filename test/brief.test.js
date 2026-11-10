// The brief (plan §17): the few that need you, the rest as counts — and the
// one message a day that says them. The numbers these tests are shaped by
// are one real queue's after two months: 685 rows open, two actions taken,
// and a list that asked to be sorted before it would get shorter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { Ranker, rerank } from '../lib/rank.js';
import { buildBrief, laneOf, crossed, label, unread, MARKS, FRESH_DAYS } from '../lib/brief.js';
import { slackBrief, discordBrief, genericBrief, headline } from '../deliver/brief.js';
import { SlackDelivery, BRIEF_CURSOR, localDay } from '../deliver/slack.js';
import { createApp } from '../lib/api.js';

const ME = 'alice';
const NOW = new Date('2026-11-10T16:00:00Z');   // 08:00 in TZ
// A zone eight hours behind UTC the whole year. A named place would do the
// same job until its government changed its mind about daylight time, and
// the tests would then depend on which tzdata the machine carries.
const TZ = 'Etc/GMT+8';
const DAY = 86_400_000;
// Three sources that pick three curves, the way the real ones do: a thread
// waits unless what fired was news; a note is news; a meeting is a spike.
const NEWS = new Set(['state_change_on_mine', 'bot_only', 'ambient']);
const shapes = {
  forge: (item, { rules = [] } = {}) => (rules.length && rules.every((r) => NEWS.has(r)) ? 'fading' : 'waiting'),
  notes: () => 'fading',
  cal: () => 'spike',
  queue: () => 'waiting',
};
const ranker = () => new Ranker({ shapes, now: () => NOW });

function seed(store, key, { tier, rule, claim = 0.5, source = 'forge', kind = 'pull', ageDays = 1, repo = 'o/r', title = key, url = `https://x/${key}`, data = {}, state = 'open' }) {
  const { item } = store.upsertItem({ user: ME, source, key, kind, title, url, repo, last_activity: new Date(NOW.getTime() - ageDays * DAY).toISOString(), data });
  store.setTier(item.id, tier, 1);
  const matches = [{ rule, tier, reason: `${rule} fired`, claim }];
  store.addDecision({ item_id: item.id, rule, tier, reason: `${rule} fired`, event_ids: [], matches }, NOW.toISOString());
  rerank(store, ranker(), store.item(item.id), { matches, now: NOW });
  if (state !== 'open') store.setState(item.id, state);
  return store.item(item.id);
}
const brief = (store, over = {}) => buildBrief(store, { user: ME, rank: ranker(), now: NOW, ...over });
const keys = (rows) => rows.map((r) => r.key);

test('the lanes: what needs you is read off the tier and the curve the source picked, and nothing else', () => {
  const store = new Store();
  seed(store, 'reply', { tier: 'P0', rule: 'reply_to_my_comment', claim: 0.95 });
  seed(store, 'review', { tier: 'P1', rule: 'review_on_my_pr', claim: 0.6 });
  // A P0 on something that is news is still news: nobody is waiting on a note.
  seed(store, 'note', { tier: 'P0', rule: 'changed_by_other', claim: 0.9, source: 'notes', kind: 'note' });
  seed(store, 'undated', { tier: 'P2', rule: 'waiting_on_you', source: 'queue', kind: 'todo' });
  seed(store, 'merged', { tier: 'P2', rule: 'state_change_on_mine', claim: 0.25 });
  seed(store, 'bot', { tier: 'P3', rule: 'bot_only', claim: 0.05 });
  seed(store, 'snoozed', { tier: 'P0', rule: 'reply_to_my_comment', claim: 0.95, state: 'snoozed' });
  const b = brief(store);
  assert.deepEqual(keys(b.needs).sort(), ['reply', 'review']);
  assert.deepEqual(keys(b.yours.items), ['undated']);
  assert.deepEqual(b.folded.map((g) => [g.n, g.label]).sort(), [[1, 'bot only'], [1, 'changed by other'], [1, 'state change on mine']]);
  assert.deepEqual(b.counts, { open: 6, needs: 2, fresh: 2, waiting: 0, yours: 1, folded: 3 }, 'a snoozed item is out of every lane: you sent it away');
  assert.equal(b.quiet, false);
  // The lane is the rank's own reading, per item.
  assert.equal(laneOf(store.itemByKey(ME, 'notes', 'note'), { rank: ranker(), now: NOW }).lane, 'folded');
  assert.equal(label('state_change_on_mine'), 'state change on mine');
  store.close();
});

test('a meeting needs you until it has happened, and has no "waited"', () => {
  const store = new Store();
  seed(store, 'soon', { tier: 'P0', rule: 'starts_in_15_min', source: 'cal', kind: 'event', data: { start: new Date(NOW.getTime() + 10 * 60_000).toISOString() } });
  seed(store, 'over', { tier: 'P0', rule: 'starts_in_15_min', source: 'cal', kind: 'event', data: { start: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() } });
  const b = brief(store);
  assert.deepEqual(keys(b.needs), ['soon']);
  assert.equal(b.needs[0].days, null);
  assert.equal(b.counts.folded, 1, 'the one that happened is folded, whatever its tier');
  store.close();
});

test('this week\'s are said, capped and in rank order; older ones are a count — and one that crosses a line is said once', () => {
  const store = new Store();
  for (let n = 0; n < 7; n++) seed(store, `fresh${n}`, { tier: 'P1', rule: 'review_on_my_pr', claim: 0.6, ageDays: n * 0.9 });
  seed(store, 'day14', { tier: 'P0', rule: 'reply_to_my_comment', claim: 0.95, ageDays: 14.4 });
  seed(store, 'day15', { tier: 'P0', rule: 'reply_to_my_comment', claim: 0.95, ageDays: 15.4 });
  seed(store, 'day67', { tier: 'P1', rule: 'past_its_nudge', source: 'queue', kind: 'todo', ageDays: 67.2, title: 'The oldest thing' });
  const b = brief(store);
  assert.equal(b.needs.length, 5, 'five by default');
  assert.equal(b.more, 2);
  assert.ok(b.needs.every((r) => r.days < FRESH_DAYS));
  assert.deepEqual(b.needs.map((r) => r.new), b.needs.map((r) => r.days < 1), 'the ones from today are marked new');
  assert.deepEqual(b.aging.map((r) => [r.key, r.mark]), [['day14', 14]], 'fourteen days today; fifteen is not a line');
  assert.deepEqual(keys(b.waiting.items).sort(), ['day15', 'day67']);
  assert.deepEqual([b.waiting.n, b.waiting.oldest_days, b.waiting.oldest.title], [2, 67, 'The oldest thing']);
  assert.deepEqual(b.counts, { open: 10, needs: 10, fresh: 7, waiting: 2, yours: 0, folded: 0 });
  assert.equal(brief(store, { limit: 50 }).more, 0);
  // The lines, exactly: the day an item turns that old, and not the next.
  assert.deepEqual(MARKS.map((m) => crossed(m + 0.5)), MARKS);
  assert.deepEqual([crossed(6.9), crossed(8), crossed(13.99), crossed(91), crossed(null)], [null, null, null, null, null]);
  // More crossed than the brief says at once: the rest are in the count,
  // not dropped.
  seed(store, 'day30', { tier: 'P1', rule: 'review_on_my_pr', ageDays: 30.1 });
  seed(store, 'day60', { tier: 'P1', rule: 'review_on_my_pr', ageDays: 60.1 });
  const c = brief(store, { aging: 2 });
  assert.equal(c.aging.length, 2);
  assert.equal(c.aging.length + c.waiting.n + c.counts.fresh, c.counts.needs, 'every item that needs you is in exactly one place');
  store.close();
});

test('the rest is folded by the rule that put it there, largest first, the tail as "other"', () => {
  const store = new Store();
  const rules = ['bot_only', 'ambient', 'own_activity', 'release', 'task_open', 'agents_own', 'kept_for_history', 'declined'];
  rules.forEach((rule, n) => { for (let k = 0; k <= rules.length - n; k++) seed(store, `${rule}${k}`, { tier: 'P3', rule, claim: 0.05, source: n % 2 ? 'queue' : 'forge', kind: 'todo', ageDays: 3 }); });
  // P3 is ambient whatever curve it is on: "waiting" there is nobody waiting.
  const b = brief(store);
  assert.equal(b.counts.needs + b.counts.yours, 0);
  assert.deepEqual(b.folded.map((g) => g.label), ['bot only', 'ambient', 'own activity', 'release', 'task open', 'agents own', 'other']);
  assert.deepEqual(b.folded.map((g) => g.n), [9, 8, 7, 6, 5, 4, 5]);
  assert.deepEqual(b.folded.at(-1).rules, ['kept_for_history', 'declined']);
  assert.deepEqual(b.folded[0].sources, ['forge']);
  assert.equal(b.folded.reduce((a, g) => a + g.n, 0), b.counts.folded);
  assert.equal(b.quiet, true, 'a pile of ambient rows is nothing to say out loud');
  store.close();
});

test('a source that has stopped reading is said — a registered one, failing for a while', () => {
  const store = new Store();
  const ago = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();
  store.recordRun('forge', { ok: true, at: ago(3 * 1440) });
  store.recordRun('forge', { ok: false, error: 'fetch failed', at: ago(1) });
  store.recordRun('queue', { ok: true, at: ago(1) });
  store.recordRun('blip', { ok: true, at: ago(5) });
  store.recordRun('blip', { ok: false, error: 'timeout', at: ago(1) });
  store.recordRun('never', { ok: false, error: 'cannot resolve who you are: fetch failed', at: ago(1) });
  store.recordRun('retired', { ok: false, error: 'gone', at: ago(9000) });
  assert.deepEqual(unread(store, { sources: ['forge', 'queue', 'blip', 'never'], now: NOW }).map((s) => [s.name, s.error, !!s.since]),
    [['forge', 'fetch failed', true], ['never', 'cannot resolve who you are: fetch failed', false]],
    'one bad poll is not news, and a source nobody registered is nobody\'s problem');
  const b = brief(store, { sources: ['forge', 'queue', 'blip', 'never'] });
  assert.equal(b.sources.length, 2);
  assert.equal(b.quiet, false, 'nothing to name, and still worth a message: something is not being read');
  assert.equal(unread(store, { now: NOW }).length, 3, 'with no list of the registered, every run on record is asked');
  store.close();
});

// ---- the message --------------------------------------------------------

function world() {
  const store = new Store();
  seed(store, 'o/r#7', { tier: 'P0', rule: 'reply_to_my_comment', claim: 0.95, ageDays: 0.2, title: 'Stream the <export>' });
  seed(store, 'row:1', { tier: 'P1', rule: 'quick_answer', claim: 0.8, source: 'queue', kind: 'todo', ageDays: 2, title: 'Turn the feed on?', url: null, repo: null, data: { owner: 'human-decision' } });
  seed(store, 'o/r#2', { tier: 'P0', rule: 'review_requested', claim: 0.8, ageDays: 30.3, title: 'An old review' });
  seed(store, 'o/r#3', { tier: 'P1', rule: 'review_on_my_pr', ageDays: 45, title: 'Older still' });
  seed(store, 'row:2', { tier: 'P2', rule: 'waiting_on_you', source: 'queue', kind: 'todo', ageDays: 9, url: null, repo: null });
  for (let n = 0; n < 4; n++) seed(store, `bot${n}`, { tier: 'P3', rule: 'bot_only', claim: 0.05 });
  store.recordRun('forge', { ok: true, at: new Date(NOW.getTime() - 3 * DAY).toISOString() });
  store.recordRun('forge', { ok: false, error: 'fetch failed', at: NOW.toISOString() });
  return store;
}

test('the Slack message: a headline, the few by name with why and how long, the rest as counts — and it names you', () => {
  const store = world();
  const b = brief(store, { sources: ['forge'] });
  assert.equal(headline(b), '2 need you this week · 1 slipping · 1 still waiting · 1 yours, undated');
  const m = slackBrief(b, { mention: '<@U1>', tz: TZ, pageUrl: 'https://triage.example' });
  assert.equal(m.text, '<@U1> Triage — 2 need you this week · 1 slipping · 1 still waiting · 1 yours, undated');
  assert.deepEqual(m.blocks.map((x) => x.type), ['section', 'section', 'context']);
  assert.equal(m.blocks[0].text.text, '<@U1> *Triage · Tue 10 Nov* — 2 need you this week · 1 slipping · 1 still waiting · 1 yours, undated');
  const body = m.blocks[1].text.text.split('\n');
  assert.deepEqual(body, [
    '*Needs you*',
    '• <https://x/o/r#7|Stream the &lt;export&gt;> — reply_to_my_comment fired _o/r · today · new_',
    '• *Turn the feed on?* — quick_answer fired _human-decision · 2 d_',
    '*Slipping*',
    '• ⏳ 30 d waiting — <https://x/o/r#2|An old review> — review_requested fired _o/r · 30 d_',
  ], 'a row with no page of its own is its title; markup in a title is escaped');
  assert.deepEqual(m.blocks[2].elements[0].text.split('\n'), [
    '*Still waiting on you:* 1 — the oldest 45 d, Older still',
    '*Yours, no date:* 1 — the oldest 9 d',
    '*Folded away:* 4 bot only',
    '⚠️ *forge* has not been read since 7 Nov 08:00 — fetch failed',
    '<https://triage.example|Open the brief>',
  ]);
  // Without a mention or a page: the same message, naming nobody, linking nowhere.
  const bare = slackBrief(b, { tz: 'UTC' });
  assert.ok(!JSON.stringify(bare).includes('<@'));
  assert.ok(!JSON.stringify(bare).includes('Open the brief'));
  store.close();
});

test('the other shapes: Discord\'s markdown may notify only who is configured; a generic endpoint gets the text and the whole structure', () => {
  const store = world();
  const b = brief(store, { sources: ['forge'] });
  const d = discordBrief(b, { mention: '<@42>', tz: 'UTC', allowed: { parse: [], users: ['42'] } });
  assert.match(d.content, /^<@42> \*\*Triage · Tue 10 Nov\*\* — 2 need you this week/);
  assert.match(d.content, /• \[Stream the <export>\]\(<https:\/\/x\/o\/r#7>\) — reply\\_to\\_my\\_comment fired/);
  assert.deepEqual(d.allowed_mentions, { parse: [], users: ['42'] });
  assert.ok(d.content.length <= 2000);
  const g = genericBrief(b, { mention: 'kev', tz: 'UTC' });
  assert.match(g.text, /^kev Triage · Tue 10 Nov — 2 need you this week/);
  assert.equal(g.brief.counts.needs, 4);
  assert.equal(g.mention, 'kev');
  store.close();
});

test('a long brief still posts: every block is under Slack\'s limit, whatever the titles are', () => {
  const store = new Store();
  for (let n = 0; n < 60; n++) seed(store, `long${n}`, { tier: 'P0', rule: 'reply_to_my_comment', title: 'x'.repeat(400), ageDays: 0.1 });
  const m = slackBrief(brief(store, { limit: 50 }), { mention: '<@U1>' });
  assert.ok(m.blocks.every((x) => (x.text?.text || x.elements[0].text).length <= 3000));
  store.close();
});

// ---- when it goes -------------------------------------------------------

function hook(over = {}) {
  const store = world();
  const posts = [];
  let t = NOW.getTime(), fail = 0;
  const clock = { now: () => new Date(t), tick: (ms) => { t += ms; }, set: (iso) => { t = Date.parse(iso); } };
  const client = { host: 'hooks.example', post: async (m) => { if (fail > 0) { fail--; throw new Error('webhook hooks.example: HTTP 500 — 0 bytes not recognised as a known reason'); } posts.push(m); return { ok: true, id: null }; } };
  const logs = [];
  const d = new SlackDelivery(store, { mode: 'webhook', notify: 'slack', webhookUrl: 'https://hooks.example/x', client, user: ME, rank: ranker(), tz: TZ, quiet: '23:00-07:00', briefAt: 8 * 60, mention: '<@U1>', sources: ['forge'], now: clock.now, log: (m) => logs.push(m), ...over });
  return { store, d, posts, clock, logs, failNext: (n) => { fail = n; } };
}

test('the brief goes once a local day, at its hour or after, never in the quiet window', async () => {
  const { store, d, posts, clock } = hook();
  clock.set('2026-11-10T15:59:00Z');   // 07:59 there
  assert.equal(await d.brief(), null, 'not yet eight');
  clock.set('2026-11-10T16:00:00Z');
  const r = await d.brief();
  assert.equal(r.sent, true);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /^<@U1> Triage — 2 need you this week/);
  assert.deepEqual(r.items.length, 3, 'the two it named and the one that crossed a line');
  // Every minute after, the same day: nothing.
  for (let n = 0; n < 5; n++) { clock.tick(60_000); await d.tick(); }
  assert.equal(posts.length, 1);
  // A box that was down at eight sends it when it is back — unless that is
  // the middle of the night, when it waits for morning.
  clock.set('2026-11-12T07:30:00Z');   // 23:30 on the 11th there: quiet
  assert.equal(await d.brief(), null);
  clock.set('2026-11-12T19:00:00Z');   // 11:00 on the 12th
  assert.equal((await d.brief()).sent, true);
  assert.equal(posts.length, 2);
  const state = store.cursor(BRIEF_CURSOR);
  assert.deepEqual(state.history.map((h) => [h.day, h.sent]), [['2026-11-10', true], ['2026-11-12', true]]);
  assert.equal(localDay(new Date('2026-11-12T07:30:00Z'), TZ), '2026-11-11');
  assert.deepEqual(d.describe().brief, { at: '08:00', last: { day: '2026-11-12', at: '2026-11-12T19:00:00.000Z', sent: true, note: state.history[1].note, items: state.history[1].items.length } });
  store.close();
});

test('a day with nothing to say sends nothing, and is not asked again that day', async () => {
  const store = new Store();
  for (let n = 0; n < 4; n++) seed(store, `bot${n}`, { tier: 'P3', rule: 'bot_only', claim: 0.05 });
  seed(store, 'old', { tier: 'P0', rule: 'reply_to_my_comment', ageDays: 20 });   // waiting, and between lines
  const posts = [], logs = [];
  let t = NOW.getTime();
  const d = new SlackDelivery(store, { mode: 'webhook', webhookUrl: 'https://hooks.example/x', client: { post: async (m) => { posts.push(m); return { ok: true }; } }, user: ME, rank: ranker(), tz: TZ, briefAt: 480, now: () => new Date(t), log: (m) => logs.push(m) });
  const r = await d.brief();
  assert.deepEqual([r.sent, r.quiet], [false, true]);
  assert.match(r.note, /nothing to say/);
  t += 60_000; assert.equal(await d.brief(), null);
  assert.equal(posts.length, 0);
  assert.equal(logs.filter((m) => /^brief:/.test(m)).length, 1, 'said once in the log, not every minute');
  // …and the day it crosses a line, it is said.
  t = NOW.getTime() + DAY * 10.2;   // thirty days old now
  assert.equal((await d.brief()).sent, true);
  assert.match(posts[0].blocks[1].text.text, /⏳ 30 d waiting/);
  store.close();
});

test('a post that fails is tried again on the next ticks, three times in all, then left for tomorrow', async () => {
  const { store, d, posts, clock, failNext } = hook();
  failNext(1);
  let r = await d.brief();
  assert.equal(r.sent, false); assert.match(r.note, /^not sent: webhook hooks\.example: HTTP 500/);
  clock.tick(60_000); r = await d.brief();
  assert.equal(r.sent, true, 'the second try');
  assert.equal(posts.length, 1);
  assert.deepEqual(store.cursor(BRIEF_CURSOR).history.map((h) => h.sent), [true], 'one entry a day: the try that worked replaces the one that did not');
  clock.tick(DAY); failNext(5);
  for (let n = 0; n < 6; n++) { await d.brief(); clock.tick(60_000); }
  assert.equal(store.cursor(BRIEF_CURSOR).tries, 3);
  assert.deepEqual(store.cursor(BRIEF_CURSOR).history.map((h) => h.sent), [true, false]);
  assert.equal(posts.length, 1);
  store.close();
});

test('off, unconfigured and forced: no hour means no brief; no delivery means none; the API\'s send goes now', async () => {
  const off = hook({ briefAt: null });
  assert.equal(await off.d.brief(), null);
  assert.equal(off.d.describe().brief.at, null);
  // Forced: now, whatever the hour or the day — and again, if asked again.
  off.clock.set('2026-11-10T08:00:00Z');   // midnight there, inside quiet
  assert.equal((await off.d.brief({ force: true })).sent, true);
  assert.equal((await off.d.brief({ force: true })).sent, true);
  assert.equal(off.posts.length, 2);
  off.store.close();
  const none = new SlackDelivery(new Store(), { mode: 'off', briefAt: 480 });
  assert.equal(await none.brief(), null);
  assert.deepEqual(await none.brief({ force: true }), { sent: false, note: 'not sent: delivery is not configured' });
  // Constructed the way everything before the brief constructs it: no hour.
  assert.equal(new SlackDelivery(new Store(), { userId: 'U1', client: {} }).briefAt, null);
});

test('under the app the brief is a DM, and names nobody — a DM notifies on its own', async () => {
  const store = world();
  const calls = [];
  const client = { chat: { postMessage: async (m) => { calls.push(m); return { ok: true, channel: 'D1', ts: '1.0' }; } } };
  const d = new SlackDelivery(store, { mode: 'app', userId: 'U1', botToken: 'x', client, user: ME, rank: ranker(), tz: 'UTC', quiet: '', briefAt: 0, mention: '<@U1>', now: () => NOW });
  assert.equal((await d.brief()).sent, true);
  assert.equal(calls[0].channel, 'U1');
  assert.equal(calls[0].unfurl_links, false);
  assert.ok(!calls[0].text.includes('<@U1>'));
  store.close();
});

// ---- the API ------------------------------------------------------------

async function call(app, method, url, body) {
  return new Promise((resolve) => {
    const req = { method, url, headers: { host: 'x' }, on: (ev, f) => { if (ev === 'data' && body) f(JSON.stringify(body)); if (ev === 'end') setImmediate(f); } };
    const res = { writeHead(code) { this.code = code; }, end(text) { resolve({ code: this.code, body: JSON.parse(text) }); } };
    app(req, res);
  });
}

test('GET /api/brief is the same read; a folded rule is a filter the lists take; POST /api/brief/send sends it now', async () => {
  const { store, d, posts } = hook();
  const runner = { sources: new Map([['forge', {}]]), describe: () => [] };
  const app = createApp({ store, runner, deliver: d, rank: ranker(), user: ME, now: () => NOW });
  const r = await call(app, 'GET', '/api/brief');
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.counts, { open: 9, needs: 4, fresh: 2, waiting: 1, yours: 1, folded: 4 });
  assert.equal(r.body.sources[0].name, 'forge');
  assert.equal((await call(app, 'GET', '/api/brief?limit=1')).body.needs.length, 1);
  assert.equal((await call(app, 'GET', '/api/brief?limit=0')).code, 400);
  // What the brief folded is one question to the list.
  const l = await call(app, 'GET', '/api/lists?rule=bot_only');
  assert.deepEqual(l.body.filter, { rule: 'bot_only' });
  assert.equal(l.body.groups[0].items.length + l.body.groups[0].more, 4);
  assert.ok(l.body.groups[0].items.every((i) => i.matches[0] === 'bot_only'));
  const s = await call(app, 'POST', '/api/brief/send');
  assert.equal(s.code, 200); assert.equal(s.body.sent, true);
  assert.equal(posts.length, 1);
  const none = createApp({ store, runner, deliver: null, rank: ranker(), user: ME });
  assert.equal((await call(none, 'POST', '/api/brief/send')).code, 503);
  store.close();
});
