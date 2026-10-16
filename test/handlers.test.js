import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { createActor } from '../lib/actions.js';
import githubSource from '../sources/github.js';
import { SlackDelivery } from '../deliver/slack.js';
import { registerHandlers } from '../deliver/handlers.js';
import { parseAction, p0Message, listBlocks, when } from '../deliver/blocks.js';
import { lists } from '../lib/lists.js';
import { score } from '../lib/rules.js';

const ME = 'alice', U = 'U1';
const NOW = new Date('2026-09-08T12:05:00Z');

/** A Bolt stand-in: records handlers, lets a test fire them. */
function fakeApp() {
  const handlers = { action: [], command: [], event: [] };
  const app = {
    action: (c, fn) => handlers.action.push([c, fn]),
    command: (c, fn) => handlers.command.push([c, fn]),
    event: (c, fn) => handlers.event.push([c, fn]),
    async fire(kind, id, args) {
      const h = handlers[kind].find(([c]) => (c instanceof RegExp ? c.test(id) : c === id));
      if (!h) throw new Error(`no ${kind} handler for ${id}`);
      return h[1](args);
    },
  };
  return app;
}
function fakeClient() {
  const calls = [];
  let n = 0;
  return { calls, chat: { postMessage: async (m) => { calls.push(['post', m]); return { ok: true, channel: 'D1', ts: `${++n}.0` }; }, update: async (m) => { calls.push(['update', m]); return { ok: true }; } }, views: { publish: async (v) => { calls.push(['home', v]); return { ok: true }; } } };
}
function seed(store, key, tier, over = {}) {
  const { item } = store.upsertItem({ user: ME, source: 'github', key, kind: 'pull', title: `PR ${key}`, url: `https://github.com/${key.replace('#', '/pull/')}`, repo: key.split('#')[0], last_activity: '2026-09-08T11:00:00Z', data: { thread_id: key }, ...over });
  store.setTier(item.id, tier, score(tier, '2026-09-08T11:00:00Z', NOW.getTime()));
  store.addEvents(item.id, [{ key: `c:${key}`, ts: '2026-09-08T11:00:00Z', kind: 'comment', actor: 'ann', body: 'ping', url: `https://github.com/${key}#c` }]);
  store.addDecision({ item_id: item.id, rule: tier === 'P0' ? 'direct_mention' : 'comment_on_my_thread', tier, reason: tier === 'P0' ? 'ann mentioned you' : 'ann commented on your pull', event_ids: [1] });
  return store.item(item.id);
}
function setup() {
  const store = new Store();
  const client = fakeClient();
  const github = { calls: [], request: async (m, u) => { github.calls.push(u); return { status: 205 }; } };
  const d = new SlackDelivery(store, { userId: U, user: ME, client, tz: 'UTC', now: () => NOW });
  const act = createActor({ store, marks: { github: (item) => githubSource.mark(item, { api: github }) }, deliver: d, now: () => NOW });
  d.act = act;
  const app = fakeApp();
  d.registerHandlers(app);
  return { store, client, github, d, act, app };
}
const press = (id, value, over = {}, client = null) => ({ ack: async () => {}, client, body: { user: { id: U }, container: { type: 'message' }, channel: { id: 'D1' }, message: { ts: '1.0' }, ...over }, action: { type: 'button', action_id: id, value: String(value) } });

test('the P0 DM carries Open and the five actions; a press reads back', () => {
  const store = new Store();
  const item = seed(store, 'o/r#1', 'P0');
  const m = p0Message({ item, decision: { reason: 'ann mentioned you' }, event: { body: 'ping', url: 'https://github.com/o/r#c' } });
  const els = m.blocks[2].elements;
  assert.deepEqual(els.map((e) => e.action_id), ['open', 'act:done', 'act:snooze:1h', 'act:snooze:1d', 'act:later', 'act:mute']);
  assert.equal(els[0].url, 'https://github.com/o/r#c');
  assert.equal(els[1].value, String(item.id));
  assert.deepEqual(parseAction({ type: 'button', action_id: 'act:snooze:1d', value: '7' }), { name: 'snooze', until: '1d', id: 7 });
  assert.deepEqual(parseAction({ type: 'button', action_id: 'act:done', value: '7' }), { name: 'done', until: null, id: 7 });
  assert.deepEqual(parseAction({ type: 'overflow', selected_option: { value: 'later:9' } }), { name: 'later', until: null, id: 9 });
  assert.equal(parseAction({ type: 'button', action_id: 'act:nuke', value: '7' }), null);
  const acted = p0Message({ item, decision: { reason: 'ann mentioned you' }, event: { body: 'ping', url: 'u' }, acted: { action: 'done', marked: 'marked read', at: NOW.toISOString() } });
  assert.equal(acted.blocks[2].type, 'context');
  assert.match(acted.blocks[2].elements[0].text, /<u\|Open> · ✓ done · thread marked read on GitHub/);
  assert.match(when('2026-09-08T13:00:00Z'), /^<!date\^1788872400\^\{date_short_pretty\} at \{time\}\|2026-09-08T13:00:00Z>$/);
});

test('Done on a DM acts, marks the thread read, and rewrites the message in place', async () => {
  const { store, client, github, d, app } = setup();
  const item = seed(store, 'o/r#1', 'P0');
  await d.deliver({ item, decision: { id: 1, reason: 'ann mentioned you' }, event: store.events(item.id)[0] });
  assert.equal(client.calls.length, 1);
  await app.fire('action', 'act:done', press('act:done', item.id, {}, client));
  assert.equal(store.item(item.id).state, 'done');
  assert.deepEqual(github.calls, ['/notifications/threads/o/r#1']);
  assert.equal(client.calls.length, 2, 'one update, not two');
  const [kind, m] = client.calls[1];
  assert.equal(kind, 'update'); assert.equal(m.channel, 'D1'); assert.equal(m.ts, '1.0');
  assert.equal(m.blocks.at(-1).type, 'context');
  assert.match(m.blocks.at(-1).elements[0].text, /✓ done · thread marked read on GitHub/);
  assert.equal(store.actionsFor(item.id)[0].by, 'slack');
  // Snooze 1d from an older DM for the same item updates that message too.
  const item2 = seed(store, 'o/r#2', 'P0');
  await app.fire('action', 'act:snooze:1d', press('act:snooze:1d', item2.id, { message: { ts: '9.9' } }, client));
  assert.equal(store.item(item2.id).state, 'snoozed');
  assert.equal(store.item(item2.id).state_until, '2026-09-09T12:05:00.000Z');
  assert.equal(client.calls.at(-1)[1].ts, '9.9');
  assert.match(client.calls.at(-1)[1].blocks.at(-1).elements[0].text, /⏰ snoozed until <!date/);
});

test('a press by someone else is ignored; Open is acknowledged', async () => {
  const { store, app, client } = setup();
  const item = seed(store, 'o/r#1', 'P0');
  await app.fire('action', 'act:mute', press('act:mute', item.id, { user: { id: 'U9' } }, client));
  assert.equal(store.item(item.id).state, 'open');
  assert.equal(client.calls.length, 0);
  let acked = false;
  await app.fire('action', 'open', { ack: async () => { acked = true; } });
  assert.equal(acked, true);
});

test('/triage is one ordered list, then snoozed and later; a word narrows it', async () => {
  const { store, app, act } = setup();
  const p1 = seed(store, 'o/r#1', 'P1');
  const p0 = seed(store, 'o/r#2', 'P0');
  const sn = seed(store, 'x/y#3', 'P0');
  const lt = seed(store, 'x/y#4', 'P1');
  seed(store, 'x/y#5', 'P2');
  await act({ id: sn.id, action: 'snooze', until: '1h' });
  await act({ id: lt.id, action: 'later' });
  const L = lists(store, { user: ME });
  // M5: one queue holding every open item — the P2 that four hard-coded
  // tier queries used to hide included (plan §11.3).
  assert.deepEqual(L.groups.map((g) => g.key), ['queue', 'snoozed', 'later']);
  assert.deepEqual(L.groups[0].items.map((i) => i.key).sort(), ['o/r#1', 'o/r#2', 'x/y#5']);
  assert.deepEqual(L.groups.slice(1).map((g) => g.items.map((i) => i.key)), [['x/y#3'], ['x/y#4']]);
  assert.deepEqual(L.counts, { P0: 1, P1: 1, P2: 1, P3: 0 });
  let answer;
  await app.fire('command', '/triage', { ack: async (a) => { answer = a; }, command: { user_id: U, text: '' } });
  assert.equal(answer.response_type, 'ephemeral');
  const texts = answer.blocks.map((b) => b.text?.text || b.elements?.[0]?.text);
  assert.match(texts[0], /the list/);
  assert.match(texts.slice(1, 4).join('\n'), /PR o\/r#2.*ann mentioned you/s);
  assert.match(texts.join('\n'), /snoozed/); assert.match(texts.join('\n'), /wakes <!date/);
  assert.match(texts.join('\n'), /x\/y#4/);
  assert.match(texts.at(-1), /open: 1 P0 · 1 P1 · 1 P2/);
  assert.equal(answer.blocks.filter((b) => b.accessory).length, 0, 'read-only');
  await app.fire('command', '/triage', { ack: async (a) => { answer = a; }, command: { user_id: U, text: 'snoozed' } });
  assert.equal(answer.blocks.length, 3);
  // `now` and `soon` were the P0 and P1 groups; they still mean "the top".
  await app.fire('command', '/triage', { ack: async (a) => { answer = a; }, command: { user_id: U, text: 'now' } });
  assert.match(answer.blocks[0].text.text, /the list/);
  await app.fire('command', '/triage', { ack: async (a) => { answer = a; }, command: { user_id: 'U9', text: '' } });
  assert.match(answer.text, /alice's queue/);
  assert.equal(p0.id > 0 && p1.id > 0, true);
});

test('the Home tab shows the same lists with a menu per line, and a choice republishes it', async () => {
  const { store, app, client } = setup();
  const item = seed(store, 'o/r#1', 'P0');
  await app.fire('event', 'app_home_opened', { event: { user: U, tab: 'home' }, client });
  let [kind, v] = client.calls.at(-1);
  assert.equal(kind, 'home'); assert.equal(v.user_id, U); assert.equal(v.view.type, 'home');
  const line = v.view.blocks.find((b) => b.accessory);
  assert.equal(line.accessory.type, 'overflow');
  assert.deepEqual(line.accessory.options.map((o) => o.value), [`done:${item.id}`, `snooze:1h:${item.id}`, `snooze:1d:${item.id}`, `later:${item.id}`, `mute:${item.id}`]);
  await app.fire('action', 'act:menu', { ack: async () => {}, client, body: { user: { id: U }, container: { type: 'view' }, view: { type: 'home' } }, action: { type: 'overflow', action_id: 'act:menu', selected_option: { value: `later:${item.id}` } } });
  assert.equal(store.item(item.id).state, 'later');
  [kind, v] = client.calls.at(-1);
  assert.equal(kind, 'home');
  assert.match(v.view.blocks.find((b) => b.accessory).text.text, /o\/r#1/);
  assert.match(v.view.blocks[v.view.blocks.findIndex((b) => b.accessory) - 1].text.text, /later/);
  await app.fire('event', 'app_home_opened', { event: { user: 'U9', tab: 'home' }, client });
  assert.match(client.calls.at(-1)[1].view.blocks[0].text.text, /alice's queue/);
  await app.fire('event', 'app_home_opened', { event: { user: U, tab: 'messages' }, client });
  assert.equal(client.calls.at(-1)[1].user_id, 'U9', 'the messages tab publishes nothing');
});

test('listBlocks caps at 100 blocks and says how many more', () => {
  const store = new Store();
  for (let i = 1; i <= 30; i++) seed(store, `o/r#${i}`, 'P0');
  const L = lists(store, { user: ME, limit: 25 });
  assert.equal(L.groups[0].items.length, 25); assert.equal(L.groups[0].more, 5);
  const b = listBlocks(L, { menus: true, title: 't' });
  assert.ok(b.blocks.length <= 100);
  assert.ok(b.blocks.some((x) => x.type === 'context' && /and 5 more/.test(x.elements[0].text)));
});

test('the rewritten DM keeps the words it was sent with, not a newer verdict\'s', async () => {
  const { store, client, d, app } = setup();
  const item = seed(store, 'o/r#1', 'P0');
  const p0 = store.decisionsFor(item.id)[0];
  await d.deliver({ item, decision: p0, event: store.events(item.id)[0] });
  const [ev2] = store.addEvents(item.id, [{ key: 'c2', ts: '2026-09-08T12:00:00Z', kind: 'comment', actor: 'bob', body: 'unrelated', url: 'u2' }]);
  store.addDecision({ item_id: item.id, rule: 'comment_on_my_thread', tier: 'P1', reason: 'bob commented on your pull', event_ids: [ev2.id] });
  await app.fire('action', 'act:done', press('act:done', item.id, {}, client));
  const m = client.calls.at(-1)[1];
  assert.match(m.blocks[0].text.text, /ann mentioned you/);
  assert.equal(m.blocks[1].text.text, '> ping');
});

test('/triage never exceeds 50 blocks; the Home tab never 100', async () => {
  const { store, app, client } = setup();
  for (let i = 1; i <= 60; i++) seed(store, `o/r#${i}`, 'P0');
  let answer;
  await app.fire('command', '/triage', { ack: async (a) => { answer = a; }, command: { user_id: U, text: '' } });
  assert.ok(answer.blocks.length <= 50, `${answer.blocks.length} blocks is more than one message holds`);
  // One list, so what is cut is the tail of the list itself — and the reader
  // is told, rather than the tail simply going missing.
  assert.match(JSON.stringify(answer.blocks), /and 30 more/);
  // **And the budget is per group, not one limit applied to each.** With a
  // single limit the queue takes the whole 50-block message and `listBlocks`
  // truncates snoozed and later off the end, though both are part of the
  // default view. They are still here.
  const labels = answer.blocks.map((b) => b.text?.text || '').filter((t) => t.startsWith('*'));
  assert.deepEqual(labels, ['*the list*', '*snoozed* · nothing', '*later* · nothing']);
  assert.match(answer.blocks.at(-1).elements[0].text, /^open: 60 P0/);
  await app.fire('event', 'app_home_opened', { event: { user: U, tab: 'home' }, client });
  assert.ok(client.calls.at(-1)[1].view.blocks.length <= 100);
});

test('a press that fails tells the user, ephemerally', async () => {
  const { app, client } = setup();
  const said = [];
  const respond = async (m) => said.push(m.text);
  await app.fire('action', 'act:done', { ...press('act:done', 999, {}, client), respond });
  assert.match(said[0], /done failed: no item 999/);
  await app.fire('action', 'act:nuke', { ...press('act:nuke', 1, {}, client), respond });
  assert.match(said[1], /could not read/);
});
