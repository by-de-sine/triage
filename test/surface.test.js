// G5 (plan §16.5): the Slack app's message is where an item lives. It follows
// the item when nobody pressed anything, a later interrupt is folded into it,
// and the Home tab is kept current. Against a faked web-api client — the real
// wiring is exercised against a development app (CONTRIBUTING.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { ingest, wake } from '../lib/pipeline.js';
import { Runner } from '../lib/runner.js';
import { createActor } from '../lib/actions.js';
import { SlackDelivery } from '../deliver/slack.js';
import rules from '../rules/thread.js';

const ME = 'alice', U = 'U1';
const settle = () => new Promise((r) => setTimeout(r, 15));

function fakeApp() {
  const handlers = { action: [], command: [], event: [] };
  return {
    action: (c, fn) => handlers.action.push([c, fn]),
    command: (c, fn) => handlers.command.push([c, fn]),
    event: (c, fn) => handlers.event.push([c, fn]),
    async fire(kind, id, args) {
      const h = handlers[kind].find(([c]) => (c instanceof RegExp ? c.test(id) : c === id));
      if (!h) throw new Error(`no ${kind} handler for ${id}`);
      return h[1](args);
    },
  };
}
/** The web-api methods the app path calls. `threadFails` answers a reply as
 *  Slack does when the DM it names is gone. */
function fakeClient({ threadFails = false } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    chat: {
      postMessage: async (m) => {
        calls.push(['post', m]);
        if (m.thread_ts && threadFails) throw Object.assign(new Error('An API error occurred: thread_not_found'), { data: { error: 'thread_not_found' } });
        return { ok: true, channel: 'D1', ts: `${++n}.0` };
      },
      update: async (m) => { calls.push(['update', m]); return { ok: true }; },
    },
    views: { publish: async (v) => { calls.push(['home', v]); return { ok: true }; } },
  };
}
function setup({ client = {}, ...over } = {}) {
  const store = new Store();
  const c = fakeClient(client);
  let t = Date.parse('2026-09-08T12:05:00Z');
  const clock = { now: () => new Date(t), tick: (ms) => { t += ms; } };
  const d = new SlackDelivery(store, { userId: U, user: ME, client: c, tz: 'UTC', quiet: '', homeDelayMs: 1, now: clock.now, ...over });
  const act = createActor({ store, deliver: d, now: clock.now });
  d.act = act;
  const app = fakeApp();
  d.registerHandlers(app);
  return { store, client: c, clock, d, act, app };
}
const batch = (key, events, over = {}) => ({ item: { key, kind: 'pull', title: `PR ${key}`, url: `https://github.com/${key.replace('#', '/pull/')}`, repo: key.split('#')[0], actors: [], my_role: 'authored', last_activity: events.at(-1).ts, last_seen: events.at(-1).ts, ...over }, events });
const ev = (key, actor, ts, body) => ({ key, kind: 'comment', actor, ts, body, data: {} });
const iso = (s) => new Date(s.clock.now()).toISOString();
/** One poll's worth of a comment, through the real pipeline and rules. */
async function poll(s, { key = 'o/r#1', id = 'c1', body = 'hey @alice, a look?', actor = 'ann' } = {}) {
  await ingest(s.store, { user: ME, source: 'github', batches: [batch(key, [ev(id, actor, iso(s), body)])] }, { rules, deliver: s.d, now: s.clock.now() });
  return s.store.itemByKey(ME, 'github', key);
}
const press = (s, id, value, over = {}) => ({ ack: async () => {}, client: s.client, respond: async () => {}, body: { user: { id: U }, container: { type: 'message' }, channel: { id: 'D1' }, message: { ts: '1.0' }, ...over }, action: { type: 'button', action_id: id, value: String(value) } });
const slackCalls = (s) => s.client.calls.filter(([k]) => k !== 'home');
const homes = (s) => s.client.calls.filter(([k]) => k === 'home');
const lastLine = (m) => m.blocks.at(-1).elements[0].text;
const contextText = (m) => m.blocks.filter((b) => b.type === 'context').map((b) => b.elements[0].text).join('\n');

test('every button goes through act(), as slack, and the DM it was pressed on says what was done', async () => {
  const cases = [
    ['act:done', 'done', /✓ done · nothing marked outside triage/],
    ['act:snooze:1h', 'snoozed', /⏰ snoozed until <!date\^\d+\^[^|]+\|2026-09-08T13:05:00.000Z>/],
    ['act:snooze:1d', 'snoozed', /⏰ snoozed until <!date\^\d+\^[^|]+\|2026-09-09T12:05:00.000Z>/],
    ['act:later', 'later', /↓ later/],
    ['act:mute', 'muted', /🔇 muted/],
  ];
  for (const [id, state, line] of cases) {
    const s = setup();
    const item = await poll(s);
    assert.equal(slackCalls(s).length, 1, 'the interrupt is one DM');
    await s.app.fire('action', id, press(s, id, item.id));
    assert.equal(s.store.item(item.id).state, state, id);
    const a = s.store.actionsFor(item.id).at(-1);
    assert.deepEqual([a.action, a.by], [state === 'snoozed' ? 'snooze' : state === 'muted' ? 'mute' : state, 'slack'], id);
    const [kind, m] = slackCalls(s).at(-1);
    assert.equal(kind, 'update', id);
    assert.deepEqual([m.channel, m.ts], ['D1', '1.0'], id);
    assert.equal(m.blocks.some((b) => b.type === 'actions'), false, `${id}: nothing left to press`);
    assert.match(lastLine(m), line, id);
    assert.equal(slackCalls(s).length, 2, `${id}: one redraw, not two`);
  }
});

test('a menu choice on the Home tab goes through act() and republishes the tab', async () => {
  const s = setup();
  const item = await poll(s);
  await settle();
  const before = homes(s).length;
  await s.app.fire('action', 'act:menu', { ack: async () => {}, client: s.client, respond: async () => {}, body: { user: { id: U }, container: { type: 'view' }, view: { type: 'home' } }, action: { type: 'overflow', action_id: 'act:menu', selected_option: { value: `later:${item.id}` } } });
  assert.equal(s.store.item(item.id).state, 'later');
  assert.equal(s.store.actionsFor(item.id).at(-1).by, 'slack');
  assert.ok(homes(s).length > before, 'the tab is redrawn after the choice');
  assert.match(lastLine(slackCalls(s).at(-1)[1]), /↓ later/, 'and the DM follows too');
});

test('resolved by its source: the DM says so and loses its buttons; back in the set, they return', async () => {
  const s = setup();
  const item = await poll(s);
  const src = { name: 'github', every: 60_000, keys: ['o/r#1'], async poll() { return { batches: [] }; }, async reconcile() { return { keys: this.keys, complete: true }; } };
  const runner = new Runner(s.store, [src], { user: ME, rules: { github: rules }, deliver: s.d, now: s.clock.now });
  s.clock.tick(60_000);
  await runner.run('github');
  assert.equal(slackCalls(s).length, 1, 'nothing moved, nothing redrawn');
  src.keys = [];
  s.clock.tick(60_000);
  await runner.run('github');
  assert.equal(s.store.item(item.id).state, 'done');
  let [kind, m] = slackCalls(s).at(-1);
  assert.equal(kind, 'update'); assert.equal(m.ts, '1.0');
  assert.match(lastLine(m), /✓ resolved at its source — gone from github/);
  assert.equal(m.blocks.some((b) => b.type === 'actions'), false);
  src.keys = ['o/r#1'];
  s.clock.tick(60_000);
  await runner.run('github');
  [kind, m] = slackCalls(s).at(-1);
  assert.equal(s.store.item(item.id).state, 'open');
  assert.equal(m.blocks.at(-1).type, 'actions', 'open again: the buttons are back');
  assert.match(contextText(m), /↺ reopened — back in github/);
});

test('resolved while a follow-up is held: the follow-up is dropped, not sent', async () => {
  const s = setup({ quiet: '12:00-13:00' });
  const item = await poll(s);
  assert.equal(s.store.heldDeliveries().length, 1);
  s.store.setState(item.id, 'done');
  await s.d.moved({ item });
  assert.equal(s.store.heldDeliveries().length, 0);
  assert.equal(s.store.lastDelivery(item.id).status, 'dropped');
  s.clock.tick(3_600_000);
  assert.equal(await s.d.flush(), 0);
});

test('a snooze that wakes as less than a P0 redraws the DM: buttons back, the snooze ended, and what landed meanwhile', async () => {
  const s = setup();
  const item = await poll(s);
  await s.app.fire('action', 'act:snooze:1h', press(s, 'act:snooze:1h', item.id));
  // While it sleeps, a comment that does not interrupt lands and re-tiers it.
  s.clock.tick(20 * 60_000);
  await poll(s, { id: 'c2', body: 'also, the tests', actor: 'bob' });
  assert.equal(s.store.item(item.id).state, 'snoozed', 'new activity does not wake a snooze');
  assert.notEqual(s.store.item(item.id).tier, 'P0');
  let m = slackCalls(s).at(-1)[1];
  assert.match(lastLine(m), /⏰ snoozed until/, 'still snoozed, still says so');
  s.clock.tick(45 * 60_000);
  const woke = await wake(s.store, { deliver: s.d, now: s.clock.now() });
  assert.equal(woke.length, 1);
  assert.match(woke[0].note, /back in the list/);
  m = slackCalls(s).at(-1)[1];
  assert.equal(m.ts, '1.0');
  assert.equal(m.blocks.at(-1).type, 'actions');
  assert.match(contextText(m), /⏰ snooze ended/);
  assert.match(contextText(m), /since: `P1` bob commented/);
  assert.match(m.blocks[0].text.text, /ann mentioned you/, 'the DM keeps its own words');
});

test('a snooze that wakes as a P0 is folded into the DM: a reply that notifies, and the DM redrawn', async () => {
  const s = setup();
  const item = await poll(s);
  await s.app.fire('action', 'act:snooze:1h', press(s, 'act:snooze:1h', item.id));
  s.clock.tick(61 * 60_000);
  const [woke] = await wake(s.store, { deliver: s.d, now: s.clock.now() });
  assert.equal(woke.delivered, true);
  assert.equal(woke.note, 'followed up in D1 1.0 (reply 2.0)');
  const calls = slackCalls(s);
  const reply = calls.find(([k, m]) => k === 'post' && m.thread_ts)[1];
  assert.deepEqual([reply.channel, reply.thread_ts, reply.reply_broadcast], ['D1', '1.0', true]);
  assert.equal(calls.filter(([k, m]) => k === 'post' && !m.thread_ts).length, 1, 'never a second DM');
  const m = calls.at(-1)[1];
  assert.deepEqual([calls.at(-1)[0], m.ts], ['update', '1.0']);
  assert.equal(m.blocks.at(-1).type, 'actions');
  assert.match(contextText(m), /⏰ snooze ended/);
  // The reply is a row of its own, and never the item's message.
  assert.equal(s.store.lastSent(item.id).message_ts, '1.0');
  assert.equal(s.store.deliveriesFor(item.id).find((r) => r.message_ts === '2.0').thread_ts, '1.0');
});

test('new activity reopens a done item: the DM follows, with buttons and what reopened it', async () => {
  const s = setup();
  const item = await poll(s);
  await s.app.fire('action', 'act:done', press(s, 'act:done', item.id));
  s.clock.tick(30 * 60_000);
  await poll(s, { id: 'c2', body: 'one more thing', actor: 'bob' });
  assert.equal(s.store.item(item.id).state, 'open');
  const m = slackCalls(s).at(-1)[1];
  assert.equal(m.ts, '1.0');
  assert.equal(m.blocks.at(-1).type, 'actions');
  assert.match(contextText(m), /↺ reopened by new activity/);
  assert.match(contextText(m), /since: `P1`/);
});

test('a newer verdict that does not interrupt is a since: line, not new words, and not a message', async () => {
  const s = setup();
  const item = await poll(s);
  s.clock.tick(30 * 60_000);
  await poll(s, { id: 'c2', body: 'nit: a typo', actor: 'bob' });
  const calls = slackCalls(s);
  assert.equal(calls.filter(([k]) => k === 'post').length, 1);
  const m = calls.at(-1)[1];
  assert.equal(calls.at(-1)[0], 'update');
  assert.match(m.blocks[0].text.text, /ann mentioned you/);
  assert.match(contextText(m), /since: `P1` bob commented/);
  assert.equal(m.blocks.at(-1).type, 'actions');
  assert.equal(s.store.lastSent(item.id).message_ts, '1.0');
});

test('a P0 held by the quiet window is folded into the DM when it ends', async () => {
  const s = setup({ quiet: '12:30-13:00' });
  const item = await poll(s);                                   // 12:05, sent
  s.clock.tick(30 * 60_000);                                    // 12:35, quiet
  await poll(s, { id: 'c2', body: '@alice ping again' });
  assert.equal(s.store.heldDeliveries().length, 1);
  assert.equal(slackCalls(s).filter(([k]) => k === 'post').length, 1, 'held, not sent');
  s.clock.tick(30 * 60_000);                                    // 13:05
  assert.equal(await s.d.flush(), 1);
  const reply = slackCalls(s).find(([k, m]) => k === 'post' && m.thread_ts)[1];
  assert.equal(reply.thread_ts, '1.0');
  assert.match(reply.text, /ping again/);
  assert.equal(s.store.heldDeliveries().length, 0);
  assert.equal(s.store.lastSent(item.id).message_ts, '1.0', 'the held row became the reply, and is not the item\'s message');
  assert.match(s.store.decisions({ item_id: item.id })[0].note, /followed up in D1 1.0 \(reply 2.0\) \(after quiet window\)/);
});

test('a follow-up on a DM that is gone posts fresh, and that is the item\'s message from then on', async () => {
  const s = setup({ client: { threadFails: true } });
  const item = await poll(s);
  s.clock.tick(30 * 60_000);
  const r = await poll(s, { id: 'c2', body: '@alice are you there' });
  assert.ok(r);
  const posts = slackCalls(s).filter(([k]) => k === 'post');
  assert.equal(posts.length, 3, 'the DM, the reply that failed, and a fresh DM');
  assert.equal(posts[2][1].thread_ts, undefined);
  assert.equal(s.store.lastSent(item.id).message_ts, '2.0');
  assert.match(s.store.decisions({ item_id: item.id })[0].note, /^sent D1 2.0/);
});

test('the Home tab is republished when the lists change — once per burst, not once per item', async () => {
  const s = setup();
  await poll(s, { key: 'o/r#1' });
  await poll(s, { key: 'o/r#2', id: 'c2' });
  await poll(s, { key: 'o/r#3', id: 'c3', body: 'no mention here', actor: 'bob' });
  assert.equal(homes(s).length, 0, 'debounced');
  assert.equal(s.d.homePending, true);
  await settle();
  assert.equal(homes(s).length, 1);
  const view = homes(s)[0][1];
  assert.equal(view.user_id, U);
  assert.equal(view.view.type, 'home');
  assert.ok(JSON.stringify(view.view.blocks).includes('PR o/r#3'), 'an item that never interrupted is on it too');
  // A press changes the lists too.
  await s.act({ id: s.store.itemByKey(ME, 'github', 'o/r#1').id, action: 'mute', by: 'api' });
  await settle();
  assert.equal(homes(s).length, 2);
});

test('the Home tab is redrawn on the tick once a quarter of an hour has passed, for the time terms', async () => {
  const s = setup();
  assert.equal((await s.d.tick()).home, true, 'never drawn: drawn now');
  assert.equal((await s.d.tick()).home, false);
  s.clock.tick(15 * 60_000);
  assert.equal((await s.d.tick()).home, true);
  assert.equal(homes(s).length, 2);
});

test('the Home tab is never drawn for the webhook, or without the app\'s handlers', async () => {
  const store = new Store();
  const posts = [];
  const w = new SlackDelivery(store, { webhookUrl: 'http://127.0.0.1:1/hook', client: { post: async (m) => { posts.push(m); return { ok: true }; } }, quiet: '', homeDelayMs: 1 });
  assert.equal(w.home, false);
  assert.equal(await w.refreshHome(), false);
  const bare = new SlackDelivery(store, { userId: U, client: fakeClient(), quiet: '' });
  assert.equal(bare.home, false, 'no handlers registered: nothing answers the tab');
  assert.equal(await bare.moved({ item: { id: 999 } }), false, 'an item with no DM is nothing to redraw');
});

test('a development app\'s /triage-dev answers as /triage does; a meeting\'s Join is acknowledged', async () => {
  const s = setup();
  await poll(s);
  let answer = null;
  await s.app.fire('command', '/triage-dev', { ack: async (a) => { answer = a; }, command: { user_id: U, text: '' } });
  assert.equal(answer.response_type, 'ephemeral');
  assert.match(answer.text, /^the list: 1/);
  let acked = false;
  await s.app.fire('action', 'link:join', { ack: async () => { acked = true; } });
  assert.equal(acked, true);
});

test('a redraw that would draw the same thing is not sent; one after a coalesced update is', async () => {
  const s = setup();
  const item = await poll(s);
  await s.app.fire('action', 'act:later', press(s, 'act:later', item.id));
  const n = slackCalls(s).length;
  s.clock.tick(60_000);
  await poll(s, { id: 'c2', body: 'more', actor: 'bob' });       // a verdict on a Later item: nothing it shows changes
  assert.equal(s.store.item(item.id).state, 'later');
  assert.equal(slackCalls(s).length, n, 'unchanged, so not sent');
  await s.act({ id: item.id, action: 'open', by: 'api' });
  const drawn = slackCalls(s).at(-1)[1];
  assert.equal(drawn.blocks.at(-1).type, 'actions');
  await poll(s, { id: 'c3', body: '@alice now?' });                // inside the window: the silent update
  assert.match(slackCalls(s).at(-1)[1].blocks[1].text.text, /now\?/);
  // A redraw after it is sent, not skipped against what this process drew
  // there before the silent update replaced it.
  const before = slackCalls(s).length;
  assert.equal(await s.d.redraw(item), true);
  assert.equal(slackCalls(s).length, before + 1);
  assert.equal(await s.d.redraw(item), false, 'and the same again is not');
});
