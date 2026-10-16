import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { SlackDelivery, parseQuiet, inQuiet } from '../deliver/slack.js';

function fakeClient() {
  const calls = [];
  let n = 0;
  return { calls, chat: { postMessage: async (m) => { calls.push(['post', m]); return { ok: true, channel: 'D1', ts: `${++n}.0` }; }, update: async (m) => { calls.push(['update', m]); return { ok: true }; } } };
}
const setup = (over = {}) => {
  const store = new Store();
  const { item } = store.upsertItem({ user: 'alice', source: 'github', key: 'o/r#1', kind: 'pull', title: 'Fix <it>', url: 'https://github.com/o/r/pull/1', repo: 'o/r', last_activity: '2026-09-08T12:00:00Z' });
  const client = fakeClient();
  let t = Date.parse('2026-09-08T12:05:00Z');
  const clock = { now: () => new Date(t), tick: (ms) => { t += ms; } };
  const d = new SlackDelivery(store, { userId: 'U1', client, tz: 'UTC', now: clock.now, ...over });
  return { store, item, client, d, clock };
};
const ev = (over = {}) => ({ id: 1, ts: '2026-09-08T12:00:00Z', actor: 'ann', body: 'can this be split?\n\nmore', url: 'https://github.com/o/r/pull/1#issuecomment-1', ...over });
const dec = (id = 1) => ({ id, rule: 'reply_to_my_comment', tier: 'P0', reason: 'ann commented after you did' });

test('quiet windows parse and wrap midnight', () => {
  assert.deepEqual(parseQuiet('23:00-07:00'), { start: 1380, end: 420 });
  assert.equal(parseQuiet('nope'), null);
  assert.equal(parseQuiet(''), null);
  const q = parseQuiet('23:00-07:00');
  assert.equal(inQuiet(q, new Date('2026-09-08T23:30:00Z'), 'UTC'), true);
  assert.equal(inQuiet(q, new Date('2026-09-08T03:00:00Z'), 'UTC'), true);
  assert.equal(inQuiet(q, new Date('2026-09-08T12:00:00Z'), 'UTC'), false);
  assert.equal(inQuiet(parseQuiet('12:00-13:00'), new Date('2026-09-08T12:30:00Z'), 'UTC'), true);
  assert.equal(inQuiet(parseQuiet('12:00-13:00'), new Date('2026-09-08T12:30:00Z'), 'Pacific/Auckland'), false);
});

test('not configured: nothing is sent, and the note says so', async () => {
  const store = new Store();
  const d = new SlackDelivery(store, {});
  assert.equal(d.enabled, false);
  const r = await d.deliver({ item: { id: 1 }, decision: dec(), event: ev() });
  assert.equal(r.delivered, false);
  assert.match(r.note, /not configured/);
});

test('a P0 is one DM with title, repo, actor, one line and an Open button', async () => {
  const { item, client, d, store } = setup();
  const r = await d.deliver({ item, decision: dec(), event: ev() });
  assert.equal(r.delivered, true);
  assert.equal(r.note, 'sent D1 1.0');
  const [kind, m] = client.calls[0];
  assert.equal(kind, 'post');
  assert.equal(m.channel, 'U1');
  assert.match(m.text, /Fix <it> — o\/r — ann commented after you did: can this be split\? more/);
  assert.match(m.blocks[0].text.text, /<https:\/\/github.com\/o\/r\/pull\/1\|Fix &lt;it&gt;>/);
  assert.match(m.blocks[0].text.text, /o\/r · ann commented after you did/);
  assert.equal(m.blocks[1].text.text, '> can this be split? more');
  assert.equal(m.blocks[2].elements[0].url, 'https://github.com/o/r/pull/1#issuecomment-1');
  assert.equal(store.lastDelivery(item.id).message_ts, '1.0');
});

test('a second P0 on the same item inside ten minutes updates the message; after, a new one', async () => {
  const { item, client, d, clock } = setup();
  await d.deliver({ item, decision: dec(1), event: ev() });
  clock.tick(5 * 60_000);
  const r = await d.deliver({ item, decision: dec(2), event: ev({ id: 2, ts: '2026-09-08T12:09:00Z', body: 'and another' }) });
  assert.equal(r.delivered, true);
  assert.match(r.note, /coalesced/);
  assert.equal(client.calls[1][0], 'update');
  assert.equal(client.calls[1][1].ts, '1.0');
  assert.match(client.calls[1][1].blocks[1].text.text, /and another/);
  clock.tick(11 * 60_000);
  const r2 = await d.deliver({ item, decision: dec(3), event: ev({ id: 3, ts: '2026-09-08T12:20:00Z' }) });
  assert.equal(client.calls[2][0], 'post');
  assert.equal(r2.note, 'sent D1 2.0');
});

test('inside the quiet window a P0 is held, then flushed once when it ends', async () => {
  const { item, client, d, clock, store } = setup({ quiet: '12:00-13:00' });
  const decisionId = store.addDecision({ item_id: item.id, rule: 'direct_mention', tier: 'P0', reason: 'ann mentioned you', event_ids: [] });
  const r = await d.deliver({ item, decision: { id: decisionId, tier: 'P0', reason: 'ann mentioned you' }, event: ev() });
  assert.equal(r.delivered, false);
  assert.equal(r.note, 'held: quiet window until 13:00');
  assert.equal(client.calls.length, 0);
  assert.equal(store.heldDeliveries().length, 1);
  // A second P0 while held stays one held row.
  await d.deliver({ item, decision: { id: decisionId, tier: 'P0', reason: 'again' }, event: ev({ ts: '2026-09-08T12:30:00Z' }) });
  assert.equal(store.heldDeliveries().length, 1);
  assert.equal(await d.flush(), 0);
  clock.tick(60 * 60_000);
  assert.equal(await d.flush(), 1);
  assert.equal(client.calls.length, 1);
  assert.equal(store.heldDeliveries().length, 0);
  assert.equal(store.decisionsFor(item.id)[0].delivered, true);
  assert.match(store.decisionsFor(item.id)[0].note, /after quiet window/);
});

test('an old event is tiered but not sent', async () => {
  const { item, client, d } = setup();
  const r = await d.deliver({ item, decision: dec(), event: ev({ ts: '2026-09-01T12:00:00Z' }) });
  assert.equal(r.delivered, false);
  assert.match(r.note, /168 h old/);
  assert.equal(client.calls.length, 0);
});

test('quiet windows reject impossible times', () => {
  assert.equal(parseQuiet('25:00-07:00'), null);
  assert.equal(parseQuiet('23:60-07:00'), null);
  assert.equal(parseQuiet('23:00-24:00'), null);
  assert.deepEqual(parseQuiet('00:00-23:59'), { start: 0, end: 1439 });
});

test('a held P0, once flushed, coalesces on the DM channel Slack answered with', async () => {
  const { item, client, d, clock, store } = setup({ quiet: '12:00-13:00' });
  const id = store.addDecision({ item_id: item.id, rule: 'direct_mention', tier: 'P0', reason: 'ann mentioned you', event_ids: [] });
  await d.deliver({ item, decision: { id, tier: 'P0', reason: 'ann mentioned you' }, event: ev() });
  clock.tick(60 * 60_000);
  assert.equal(await d.flush(), 1);
  assert.equal(store.lastDelivery(item.id).channel, 'D1');
  clock.tick(60_000);
  const r = await d.deliver({ item, decision: dec(2), event: ev({ id: 2, ts: '2026-09-08T13:01:00Z' }) });
  assert.match(r.note, /coalesced/);
  assert.equal(client.calls[1][0], 'update');
  assert.equal(client.calls[1][1].channel, 'D1');
});

// ---- M1: reflect ------------------------------------------------------------
import { createActor } from '../lib/actions.js';

test('the timer is the flush and nothing else — no batch, no digest (plan §11.3, 2026-09-12)', async () => {
  const { d, client, store } = setup();
  const { item } = store.upsertItem({ user: 'alice', source: 'github', key: 'o/r#10', kind: 'pull', title: 'PR', url: 'u', repo: 'o/r', last_activity: '2026-09-08T11:30:00Z' });
  store.setTier(item.id, 'P1', 1);
  store.addDecision({ item_id: item.id, rule: 'comment_on_my_thread', tier: 'P1', reason: 'moved', event_ids: [] });
  assert.deepEqual(await d.tick(), { flushed: 0 });
  assert.equal(client.calls.length, 0, 'a P1 verdict is placed in the list; nothing sends it later');
  assert.equal(typeof d.batch, 'undefined');
  assert.equal(typeof d.digest, 'undefined');
  assert.equal('p1' in d.describe(), false);
  assert.equal('p2' in d.describe(), false);
});

test('an action rewrites the DM that carried the item and drops a held one', async () => {
  const { item, client, d, store } = setup();
  await d.deliver({ item, decision: dec(), event: ev() });
  store.addDecision({ item_id: item.id, rule: 'reply_to_my_comment', tier: 'P0', reason: 'ann commented after you did', event_ids: [] });
  const act = createActor({ store, deliver: d, now: d.now });
  const r = await act({ id: item.id, action: 'later' });
  assert.equal(r.item.state, 'later');
  assert.equal(client.calls[1][0], 'update'); assert.equal(client.calls[1][1].ts, '1.0');
  assert.match(client.calls[1][1].blocks.at(-1).elements[0].text, /↓ later/);
  assert.match(client.calls[1][1].blocks[0].text.text, /Fix &lt;it&gt;/);
  // Held inside quiet, then acted on: nothing is sent when quiet ends.
  const q = setup({ quiet: '12:00-13:00' });
  const id = q.store.addDecision({ item_id: q.item.id, rule: 'direct_mention', tier: 'P0', reason: 'ann mentioned you', event_ids: [] });
  await q.d.deliver({ item: q.item, decision: { id, tier: 'P0', reason: 'ann mentioned you' }, event: ev() });
  assert.equal(q.store.heldDeliveries().length, 1);
  await createActor({ store: q.store, deliver: q.d, now: q.d.now })({ id: q.item.id, action: 'done' });
  assert.equal(q.store.heldDeliveries().length, 0);
  assert.equal(q.store.lastDelivery(q.item.id).status, 'dropped');
  q.clock.tick(3_600_000);
  assert.equal(await q.d.flush(), 0);
  assert.equal(q.client.calls.length, 0);
});

test('reopening puts the buttons back on the DM', async () => {
  const { item, client, d, store } = setup();
  await d.deliver({ item, decision: dec(), event: ev() });
  const act = createActor({ store, deliver: d, now: d.now });
  await act({ id: item.id, action: 'later' });
  assert.equal(client.calls.at(-1)[1].blocks.at(-1).type, 'context');
  await act({ id: item.id, action: 'open' });
  const last = client.calls.at(-1)[1];
  assert.equal(last.ts, '1.0');
  assert.equal(last.blocks.at(-1).type, 'actions');
  assert.equal(last.blocks.at(-1).elements.length, 6);
});

// --- a meeting, not a thread (M3) -----------------------------------------
// item.kind decides the shape. Delivery is told nothing about the source,
// and the calendar's P0 is built by the same p0Message the GitHub one is.
test('the P0 DM for an event: title, when, where, who, and a Join button', async () => {
  const { p0Message, guestLine, itemLine, when } = await import('../deliver/blocks.js');
  const start = '2026-09-08T12:20:00Z';
  const item = { id: 7, source: 'calendar', kind: 'event', title: 'Design review', url: 'https://calendar.google.com/event?eid=e1', repo: null,
    data: { start, location: 'Room 2', join: 'https://meet.google.com/abc-defg-hij', organizer: 'ann@example.com', guests: 3,
      attendees: [{ name: 'alice@example.com', self: true }, { name: 'Ann Lee', self: false }, { name: 'bob@example.com', self: false }] } };
  const m = p0Message({ item, decision: { reason: 'starts in 15 min · a video call' }, event: null });
  assert.match(m.text, /^Design review — starts in 15 min · a video call — /);
  assert.match(m.text, /Room 2/);
  assert.match(m.text, /with Ann Lee, bob/);
  // The context line renders the start in the reader's zone, not the box's.
  const ctx = m.blocks.find((b) => b.type === 'context').elements[0].text;
  assert.equal(ctx, `${when(start)} · Room 2 · with Ann Lee, bob`);
  // Join first, then the same six buttons every P0 carries.
  const acts = m.blocks.find((b) => b.type === 'actions');
  assert.deepEqual(acts.elements.map((e) => e.text.text), ['Join', 'Open', 'Done', 'Snooze 1h', 'Snooze 1d', 'Later', 'Mute thread']);
  assert.equal(acts.elements[0].url, 'https://meet.google.com/abc-defg-hij');
  assert.equal(acts.elements[1].url, item.url);
  assert.equal(acts.block_id, 'act-7');
  // No repo anywhere: an event does not have one and does not pretend to.
  assert.doesNotMatch(JSON.stringify(m), /"repo"|null · /);
  // Acted, the buttons give way to the line saying what you did — and Join
  // is still the way in, because the meeting is still happening.
  const acted = p0Message({ item, decision: { reason: 'starts in 15 min' }, event: null, acted: { action: 'done', marked: 'nothing marked on Google — triage only reads your calendar', at: start } });
  assert.equal(acted.blocks.find((b) => b.type === 'actions'), undefined);
  assert.match(acted.blocks.at(-1).elements[0].text, /\|Join> · ✓ done · nothing marked on Google/);
  // No guests, no link: the shape holds, it just says less.
  const bare = p0Message({ item: { id: 8, kind: 'event', title: 'Focus', url: 'u', data: { start } }, decision: { reason: 'starts in 5 min' }, event: null });
  assert.equal(bare.blocks.find((b) => b.type === 'context').elements[0].text, when(start));
  assert.deepEqual(bare.blocks.find((b) => b.type === 'actions').elements.map((e) => e.text.text), ['Open', 'Done', 'Snooze 1h', 'Snooze 1d', 'Later', 'Mute thread']);
  assert.equal(guestLine({}), null);
  assert.equal(guestLine({ attendees: [{ name: 'a@x', self: true }, { name: 'b@x' }, { name: 'c@x' }, { name: 'd@x' }, { name: 'e@x' }] }), 'b, c, d and 1 more');
  // A list line shows the start where a thread would show its repo.
  assert.match(itemLine({ id: 7, kind: 'event', tier: 'P0', title: 'Design review', url: 'u', start, reason: 'starts in 15 min' }), new RegExp(`\`P0\` <u\\|Design review> · ${when(start).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — starts in 15 min`));
  assert.match(itemLine({ id: 8, kind: 'event', tier: 'P2', title: 'No date', url: 'u', reason: 'on your calendar' }), /· calendar —/);
});

// ---- webhook mode (plan §11.6) ---------------------------------------------
// A webhook can post and cannot redraw. The first alarm is unchanged; what
// changes is what happens to the repeats, and to the two calls that used to
// rewrite a message already out.
import { fakeWebhook } from './fake-webhook.js';
import { webhookClient } from '../deliver/webhook.js';

const hookSetup = (over = {}) => {
  const store = new Store();
  const { item } = store.upsertItem({ user: 'alice', source: 'github', key: 'o/r#1', kind: 'pull', title: 'Fix it', url: 'https://github.com/o/r/pull/1', repo: 'o/r', last_activity: '2026-09-08T12:00:00Z' });
  const hook = fakeWebhook();
  let t = Date.parse('2026-09-08T12:05:00Z');
  const clock = { now: () => new Date(t), tick: (ms) => { t += ms; } };
  const d = new SlackDelivery(store, { mode: 'webhook', webhookUrl: hook.url, client: webhookClient(hook.url, { fetch: hook.fetch }), tz: 'UTC', now: clock.now, ...over });
  return { store, item, hook, d, clock };
};
/** A decision that is really in the store, which is what `flush` re-reads. */
const realDec = (store, item, reason, tier = 'P0') => {
  const id = store.addDecision({ item_id: item.id, rule: 'reply_to_my_comment', tier, reason, event_ids: [] });
  return { id, rule: 'reply_to_my_comment', tier, reason };
};

test('webhook: enabled by the URL alone — no user id, no token, no socket', () => {
  const { d } = hookSetup();
  assert.equal(d.enabled, true);
  assert.equal(d.mode, 'webhook');
  assert.equal(d.userId, null);
  assert.equal(d.describe().webhook, 'hooks.slack.com');
  assert.equal(d.describe().channel, 'webhook');
  // The URL is the credential and never appears in what /api/health shows.
  assert.equal(JSON.stringify(d.describe()).includes('B0FAKE'), false);
});

test('webhook: TRIAGE_SLACK=off refuses to deliver, and says which it is', async () => {
  const store = new Store();
  const d = new SlackDelivery(store, { mode: 'off', webhookUrl: 'https://hooks.slack.com/services/T/B/x' });
  assert.equal(d.enabled, false);
  const r = await d.deliver({ item: { id: 1 }, decision: dec(), event: ev() });
  assert.match(r.note, /slack is off \(TRIAGE_SLACK=off\)/);
  const d2 = new SlackDelivery(store, { mode: 'webhook' });
  assert.equal(d2.enabled, false);
  assert.match((await d2.deliver({ item: { id: 1 }, decision: dec(), event: ev() })).note, /no SLACK_WEBHOOK_URL/);
});

test('webhook: the first alarm for an item is never held — it goes at once', async () => {
  const { item, hook, d, store } = hookSetup();
  const r = await d.deliver({ item, decision: dec(), event: ev() });
  assert.equal(r.delivered, true);
  // No message id came back, so the note says where and stops there.
  assert.equal(r.note, 'sent webhook');
  assert.equal(hook.posts.length, 1);
  assert.match(hook.posts[0].text, /Fix it — o\/r — ann commented after you did/);
  const row = store.lastDelivery(item.id);
  assert.equal(row.status, 'sent');
  assert.equal(row.channel, 'webhook');
  assert.equal(row.message_ts, null);      // nothing to update later
  assert.equal(store.lastSent(item.id), null);
  assert.equal(store.lastPosted(item.id).id, row.id);
});

test('webhook: a repeat inside the window is held, not folded and not dropped', async () => {
  const { item, hook, d, clock, store } = hookSetup();
  await d.deliver({ item, decision: dec(1), event: ev() });
  clock.tick(5 * 60_000);
  const r = await d.deliver({ item, decision: realDec(store, item, 'and another'), event: ev({ id: 2, body: 'and another' }) });
  assert.equal(r.delivered, false);
  assert.match(r.note, /^held: coalescing until 12:15/);
  assert.match(r.note, /one follow-up when the window ends/);
  assert.equal(hook.posts.length, 1);                 // nothing a second time yet
  assert.equal(store.heldDeliveries().length, 1);
  // Not yet: the window is still open.
  assert.equal(await d.flush(), 0);
  assert.equal(hook.posts.length, 1);
  // At its end, once, carrying what the repeat said.
  clock.tick(6 * 60_000);
  assert.equal(await d.flush(), 1);
  assert.equal(hook.posts.length, 2);
  assert.match(hook.posts[1].text, /and another/);
  assert.equal(store.heldDeliveries().length, 0);
  const noted = store.decisionsFor(item.id).at(-1);
  assert.equal(noted.delivered, true);
  assert.match(noted.note, /coalesced follow-up/);
});

test('webhook: several repeats in one window are one follow-up, saying the newest thing', async () => {
  const { item, hook, d, clock, store } = hookSetup();
  await d.deliver({ item, decision: dec(1), event: ev() });
  clock.tick(60_000);
  await d.deliver({ item, decision: realDec(store, item, 'bea replied'), event: ev({ id: 2, actor: 'bea', body: 'bea replied' }) });
  clock.tick(60_000);
  await d.deliver({ item, decision: realDec(store, item, 'cal is blocked on you'), event: ev({ id: 3, actor: 'cal', body: 'cal is blocked on you' }) });
  // One row, not three: holding folds in the store rather than in Slack.
  assert.equal(store.heldDeliveries().length, 1);
  assert.equal(hook.posts.length, 1);
  clock.tick(10 * 60_000);
  assert.equal(await d.flush(), 1);
  assert.equal(hook.posts.length, 2);
  // The newest wins; the older repeat is not sent separately and not lost —
  // it is superseded by the thing that happened after it.
  assert.match(hook.posts[1].text, /cal is blocked on you/);
});

test('webhook: after the window closes, the next alarm posts again rather than holding', async () => {
  const { item, hook, d, clock, store } = hookSetup();
  await d.deliver({ item, decision: dec(1), event: ev() });
  clock.tick(11 * 60_000);
  const r = await d.deliver({ item, decision: realDec(store, item, 'later still'), event: ev({ id: 2, ts: '2026-09-08T12:16:00Z', body: 'later still' }) });
  assert.equal(r.delivered, true);
  assert.equal(r.note, 'sent webhook');
  assert.equal(hook.posts.length, 2);
  assert.equal(store.heldDeliveries().length, 0);
});

test('webhook: the quiet window is unchanged, and holds before coalescing does', async () => {
  const { item, hook, d, clock, store } = hookSetup({ quiet: '12:00-13:00' });
  const first = realDec(store, item, 'ann mentioned you');
  const r = await d.deliver({ item, decision: first, event: ev() });
  assert.equal(r.delivered, false);
  assert.equal(r.note, 'held: quiet window until 13:00');
  assert.equal(hook.posts.length, 0);
  clock.tick(60 * 60_000);
  assert.equal(await d.flush(), 1);
  assert.equal(hook.posts.length, 1);
  assert.match(store.decisionsFor(item.id)[0].note, /after quiet window/);
});

test('webhook: the age guard is unchanged', async () => {
  const { item, hook, d } = hookSetup();
  const r = await d.deliver({ item, decision: dec(), event: ev({ ts: '2026-09-01T12:00:00Z' }) });
  assert.equal(r.delivered, false);
  assert.match(r.note, /168 h old/);
  assert.equal(hook.posts.length, 0);
  // And a snooze that wakes is still exempt: you asked for it.
  const r2 = await d.deliver({ item, decision: dec(), event: ev({ ts: '2026-09-01T12:00:00Z' }), ignoreAge: true });
  assert.equal(r2.delivered, true);
  assert.equal(hook.posts.length, 1);
});

test('webhook: reflect is a no-op, but a held follow-up is still dropped', async () => {
  const { item, hook, d, clock, store } = hookSetup();
  await d.deliver({ item, decision: dec(1), event: ev() });
  clock.tick(60_000);
  await d.deliver({ item, decision: realDec(store, item, 'and another'), event: ev({ id: 2 }) });
  assert.equal(store.heldDeliveries().length, 1);

  const act = createActor({ store, deliver: d, now: d.now });
  await act({ id: item.id, action: 'done', by: 'page' });
  // The message that went out stands as sent — it cannot say what you did.
  assert.equal(hook.posts.length, 1);
  // But you have dealt with the item, so the follow-up must not arrive.
  assert.equal(store.heldDeliveries().length, 0);
  assert.equal(store.deliveriesFor(item.id).at(-1).status, 'dropped');
  clock.tick(20 * 60_000);
  assert.equal(await d.flush(), 0);
  assert.equal(hook.posts.length, 1);
});

test('webhook: a decision says what delivery did, never "slack not configured"', async () => {
  const { item, d, store } = hookSetup();
  const decision = realDec(store, item, 'ann commented after you did');
  const r = await d.deliver({ item, decision, event: ev() });
  store.markDelivered(decision.id, r.delivered, r.note);
  const row = store.decisionsFor(item.id).at(-1);
  assert.equal(row.delivered, true);
  assert.equal(row.note, 'sent webhook');
  assert.equal(/slack not configured/.test(row.note), false);
});

test('webhook: a note never says "null" where a message id would be', async () => {
  // A webhook answers with no message id, so `sent webhook null` would be
  // the only thing anyone read in /api/decisions. Found by review on #9.
  const { item, d, store, clock } = hookSetup({ quiet: '12:00-13:00' });
  const decision = realDec(store, item, 'ann commented after you did');
  const r = await d.deliver({ item, decision, event: ev() });
  assert.equal(r.note, 'held: quiet window until 13:00');
  clock.tick(60 * 60_000);
  assert.equal(await d.flush(), 1);
  const note = store.decisionsFor(item.id).at(-1).note;
  assert.equal(note, 'sent webhook (after quiet window)');
  assert.equal(note.includes('null'), false);
});

test('webhook: a DM sent under app mode does not open a webhook coalesce window', async () => {
  // Switching TRIAGE_SLACK=app -> webhook leaves recent `sent` rows on the
  // DM channel. They are not a window this channel opened, and the first
  // webhook alarm for the item must not be held against one. Review on #9.
  const { item, hook, d, store } = hookSetup();
  store.addDelivery({ item_id: item.id, channel: 'D1', message_ts: '1.0', status: 'sent', decision_id: null }, '2026-09-08T12:04:30Z');

  const r = await d.deliver({ item, decision: dec(), event: ev() });
  assert.equal(r.delivered, true, 'the first webhook alarm was held against a DM');
  assert.equal(r.note, 'sent webhook');
  assert.equal(hook.posts.length, 1);
  // The DM row is still the item's most recent delivery overall; it is just
  // not this channel's.
  assert.equal(store.lastPosted(item.id).channel, 'webhook');
  assert.equal(store.lastPosted(item.id, 'D1').channel, 'D1');
});

// ---- the dead buttons (webhook mode) ---------------------------------------
// An incoming webhook delivers no interaction callbacks, and `webhook` mode
// registers no handlers — so Done · Snooze 1h · Snooze 1d · Later · Mute
// rendered on every P0 and did nothing at all when pressed. They go in this
// mode only; Open and Join are URL buttons rather than interaction and
// survive as the link line an acted message already used (plan §11.6).

import { when as whenIso } from '../deliver/blocks.js';

/** Every action_id anywhere in a message: the press a webhook cannot deliver. */
const actionIds = (msg) => JSON.stringify(msg).match(/"action_id":"[^"]*"/g) || [];

test('webhook: no act button reaches the channel — nothing would deliver the press', async () => {
  const { item, hook, d } = hookSetup();
  await d.deliver({ item, decision: dec(), event: ev() });
  const posted = hook.posts[0];
  // The row of buttons is gone, and with it every act: id.
  assert.equal(posted.blocks.find((b) => b.type === 'actions'), undefined);
  assert.deepEqual(actionIds(posted).filter((a) => a.includes('act:')), []);
  assert.equal(JSON.stringify(posted).includes('act:'), false);
  // Open survives, as the same context line an acted message carries.
  const ctx = posted.blocks.at(-1);
  assert.equal(ctx.type, 'context');
  assert.equal(ctx.elements[0].text, '<https://github.com/o/r/pull/1#issuecomment-1|Open>');
  // And the text, the title and the quoted line are untouched.
  assert.match(posted.text, /Fix it — o\/r — ann commented after you did/);
  assert.equal(posted.blocks[1].text.text, '> can this be split? more');
});

test('webhook: a meeting keeps Join and Open — the two the button row led with', async () => {
  const { store, hook, d } = hookSetup();
  const start = '2026-09-08T12:20:00Z';
  const { item } = store.upsertItem({ user: 'alice', source: 'calendar', key: 'e1', kind: 'event', title: 'Design review', url: 'https://calendar.google.com/event?eid=e1', repo: null, last_activity: '2026-09-08T12:04:00Z',
    data: { start, location: 'Room 2', join: 'https://meet.google.com/abc-defg-hij', attendees: [{ name: 'alice@example.com', self: true }, { name: 'Ann Lee' }] } });
  await d.deliver({ item, decision: { id: 2, rule: 'starts_in_15_min', tier: 'P0', reason: 'starts in 15 min' }, event: null });
  const posted = hook.posts.at(-1);
  assert.equal(posted.blocks.find((b) => b.type === 'actions'), undefined);
  assert.equal(JSON.stringify(posted).includes('act:'), false);
  // Both links, Join first — a meeting alarm you cannot join is worse than
  // useless, and Open is the only way to the calendar entry.
  assert.equal(posted.blocks.at(-1).elements[0].text, '<https://meet.google.com/abc-defg-hij|Join> · <https://calendar.google.com/event?eid=e1|Open>');
  // The when/where/who line is still there, and is not the link line.
  assert.equal(posted.blocks[1].elements[0].text, `${whenIso(start)} · Room 2 · with Ann Lee`);
  // An event with no Join still says Open.
  const { item: bare } = store.upsertItem({ user: 'alice', source: 'calendar', key: 'e2', kind: 'event', title: 'Focus', url: 'https://calendar.google.com/event?eid=e2', repo: null, last_activity: '2026-09-08T12:04:00Z', data: { start } });
  await d.deliver({ item: bare, decision: { id: 3, rule: 'starts_in_15_min', tier: 'P0', reason: 'starts in 5 min' }, event: null });
  assert.equal(hook.posts.at(-1).blocks.at(-1).elements[0].text, '<https://calendar.google.com/event?eid=e2|Open>');
});

// The flag defaults to true and only `webhook` passes false, so `app` must be
// untouched. These two are what the app posted at 1f69913 (PR #9), captured
// before the change and compared byte for byte — a regression here is a
// regression in the path the owner decided to keep (plan §11.6). The one change
// since: the summary line went with the LLM (plan §13), so the thread's
// first section is the title, the repo and the reason, and nothing under it.
const APP_THREAD = '{"text":"Fix <it> — o/r — ann commented after you did: can this be split? more","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"*<https://github.com/o/r/pull/1|Fix &lt;it&gt;>*\\no/r · ann commented after you did"}},{"type":"section","text":{"type":"mrkdwn","text":"> can this be split? more"}},{"type":"actions","block_id":"act-7","elements":[{"type":"button","text":{"type":"plain_text","text":"Open","emoji":true},"url":"https://github.com/o/r/pull/1#issuecomment-1","action_id":"open"},{"type":"button","text":{"type":"plain_text","text":"Done","emoji":true},"action_id":"act:done","value":"7","style":"primary"},{"type":"button","text":{"type":"plain_text","text":"Snooze 1h","emoji":true},"action_id":"act:snooze:1h","value":"7"},{"type":"button","text":{"type":"plain_text","text":"Snooze 1d","emoji":true},"action_id":"act:snooze:1d","value":"7"},{"type":"button","text":{"type":"plain_text","text":"Later","emoji":true},"action_id":"act:later","value":"7"},{"type":"button","text":{"type":"plain_text","text":"Mute thread","emoji":true},"action_id":"act:mute","value":"7"}]}]}';
const APP_EVENT = '{"text":"Design review — starts in 15 min — 2026-09-08T12:20:00Z · Room 2 · with Ann Lee","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"*<https://calendar.google.com/event?eid=e1|Design review>*\\nstarts in 15 min"}},{"type":"context","elements":[{"type":"mrkdwn","text":"<!date^1788870000^{date_short_pretty} at {time}|2026-09-08T12:20:00Z> · Room 2 · with Ann Lee"}]},{"type":"actions","block_id":"act-9","elements":[{"type":"button","text":{"type":"plain_text","text":"Join","emoji":true},"url":"https://meet.google.com/abc-defg-hij","action_id":"link:join"},{"type":"button","text":{"type":"plain_text","text":"Open","emoji":true},"url":"https://calendar.google.com/event?eid=e1","action_id":"open"},{"type":"button","text":{"type":"plain_text","text":"Done","emoji":true},"action_id":"act:done","value":"9","style":"primary"},{"type":"button","text":{"type":"plain_text","text":"Snooze 1h","emoji":true},"action_id":"act:snooze:1h","value":"9"},{"type":"button","text":{"type":"plain_text","text":"Snooze 1d","emoji":true},"action_id":"act:snooze:1d","value":"9"},{"type":"button","text":{"type":"plain_text","text":"Later","emoji":true},"action_id":"act:later","value":"9"},{"type":"button","text":{"type":"plain_text","text":"Mute thread","emoji":true},"action_id":"act:mute","value":"9"}]}]}';

test('app mode is byte-identical: the six buttons are exactly what they were', async () => {
  const { p0Message } = await import('../deliver/blocks.js');
  const item = { id: 7, source: 'github', kind: 'pull', title: 'Fix <it>', url: 'https://github.com/o/r/pull/1', repo: 'o/r' };
  const event = { id: 1, ts: '2026-09-08T12:00:00Z', actor: 'ann', body: 'can this be split?\n\nmore', url: 'https://github.com/o/r/pull/1#issuecomment-1' };
  const decision = { id: 1, rule: 'reply_to_my_comment', tier: 'P0', reason: 'ann commented after you did' };
  const evItem = { id: 9, source: 'calendar', kind: 'event', title: 'Design review', url: 'https://calendar.google.com/event?eid=e1', repo: null,
    data: { start: '2026-09-08T12:20:00Z', location: 'Room 2', join: 'https://meet.google.com/abc-defg-hij', attendees: [{ name: 'alice@example.com', self: true }, { name: 'Ann Lee' }] } };
  assert.equal(JSON.stringify(p0Message({ item, decision, event })), APP_THREAD);
  assert.equal(JSON.stringify(p0Message({ item: evItem, decision: { reason: 'starts in 15 min' }, event: null })), APP_EVENT);
  // The default is what app mode relies on: no caller has to remember to ask.
  assert.equal(JSON.stringify(p0Message({ item, decision, event, interactive: true })), APP_THREAD);
  // And delivery in app mode passes it through unchanged.
  const { d } = setup();
  assert.equal(JSON.stringify(d.message({ item, decision, event })), APP_THREAD);
});

// ---------------------------------------------------------------------------
// The mention (plan §14.1). The first real P0 this system ever sent was
// delivered — `sent webhook`, delivered=1, a deliveries row — and reached
// nobody, because an incoming webhook posts an ordinary channel message and
// Slack's default preference is direct messages, mentions and keywords. The
// DM path it replaced was a notification by construction. "Delivered" and
// "arrived" are different claims and `deliveries` can only record the first.

test('webhook: the interrupt names you, so Slack notifies rather than badges', async () => {
  const { item, client, d } = setup({ mode: 'webhook', webhookUrl: 'https://hooks.slack.com/services/T/B/x', mention: '<@U1>' });
  await d.deliver({ item, decision: { id: 1, rule: 'reply_to_my_comment', tier: 'P0', reason: 'ann commented after you did' }, event: ev() });
  const [, msg] = client.calls[0];
  // Both halves matter: `text` is what a push notification shows, and the
  // block is what Slack parses to decide it is a mention at all.
  assert.ok(msg.text.startsWith('<@U1> '), `text carries the mention: ${msg.text}`);
  assert.ok(msg.blocks[0].text.text.startsWith('<@U1> *<https://github.com/o/r/pull/1|'), msg.blocks[0].text.text);
  assert.ok(msg.text.includes('ann commented after you did'), 'and still says what happened');
});

test('webhook: a meeting names you too, and app mode never does', async () => {
  const { p0Message } = await import('../deliver/blocks.js');
  const evItem = { id: 9, source: 'calendar', kind: 'event', title: 'Design review', url: 'u', repo: null, data: { start: '2026-09-08T12:20:00Z' } };
  const m = p0Message({ item: evItem, decision: { reason: 'starts in 15 min' }, event: null, interactive: false, mention: '<@U1>' });
  assert.ok(m.text.startsWith('<@U1> Design review'));
  assert.ok(m.blocks[0].text.text.startsWith('<@U1> *'));
  // App mode is a DM, which notifies on its own; a mention there is noise.
  const { d } = setup({ mention: '<@U1>' });
  const item = { id: 7, source: 'github', kind: 'pull', title: 'Fix', url: 'u', repo: 'o/r' };
  assert.ok(!d.message({ item, decision: { reason: 'r' }, event: null }).text.includes('<@U1>'));
  // An acted redraw never mentions: it says what you already did.
  assert.ok(!p0Message({ item, decision: { reason: 'r' }, event: null, mention: '<@U1>', acted: { action: 'done' } }).text.includes('<@U1>'));
});

test('webhook: no mention configured means the message is exactly what it was', async () => {
  const { item, client, d } = setup({ mode: 'webhook', webhookUrl: 'https://hooks.slack.com/services/T/B/x' });
  await d.deliver({ item, decision: { id: 1, rule: 'reply_to_my_comment', tier: 'P0', reason: 'ann commented after you did' }, event: ev() });
  const [, msg] = client.calls[0];
  assert.ok(!msg.text.includes('<@'), msg.text);
  assert.equal(d.describe().mention, null);
});
