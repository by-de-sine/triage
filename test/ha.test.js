// Home Assistant's to-do lists as a source (plan §12.8), and the second
// state-shaped one: every item still needing action becomes an item here,
// a date is what makes it P1, an item ticked off on the wall tablet is
// resolved by `reconcile` (plan §12.2) rather than sitting open for ever,
// and Done here ticks it off there — the one write in the source.
//
// Everything runs against test/fake-ha.js, which is Home Assistant's REST
// service-call API over a list of items it actually mutates. No network, no
// token, no Home Assistant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { Runner } from '../lib/runner.js';
import { Ranker } from '../lib/rank.js';
import { lists } from '../lib/lists.js';
import { createActor } from '../lib/actions.js';
import { loadConfig, parseHaLists } from '../lib/config.js';
import ha, { dueAt, isDue, isInbox, listName, markDone, normalise } from '../sources/ha.js';
import rules from '../rules/ha.js';
import { fakeHa, todo } from './fake-ha.js';

const ME = 'alice';
const NOW = new Date('2026-09-20T12:00:00.000Z');
const LISTS = ['todo.alice_inbox', 'todo.household'];
const DASH = 'http://ha.test:8123/todo';
/** A date-only `due`, as Home Assistant writes one: the *local* day, `n`
 *  days from NOW. Derived rather than written down, so the suite means the
 *  same thing in Vancouver and in CI's UTC — and moved by the *calendar*,
 *  because a local day is 23 or 25 hours twice a year. */
const day = (n) => { const d = new Date(NOW); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };

function world() {
  return {
    'todo.alice_inbox': [
      todo({ uid: 'i1', summary: 'Renew the passport', due: day(-2) }),
      todo({ uid: 'i2', summary: 'Decide on the bike rack', description: 'roof or hitch' }),
    ],
    'todo.household': [
      todo({ uid: 'h1', summary: 'Put the bins out', due: day(0) }),
      todo({ uid: 'h2', summary: 'Rake the leaves' }),
      todo({ uid: 'h3', summary: 'Book the car service', due: day(5) }),
      todo({ uid: 'h4', summary: 'Flip the laundry', status: 'completed' }),
    ],
  };
}

function boot({ fail = null } = {}) {
  const api = fakeHa(world(), { fail });
  const store = new Store();
  const rank = new Ranker({ shapes: { ha: ha.time }, now: () => NOW });
  const logs = [];
  const runner = new Runner(store, [ha], { user: ME, rules: { ha: rules }, rank, extras: { ha: { api, lists: LISTS, dashboard: DASH } }, log: (m) => logs.push(m) });
  runner.now = () => NOW;
  return { api, store, rank, runner, logs };
}

test('a to-do item becomes an item keyed on its uid, so renaming it keeps identity and re-tiers it', () => {
  const a = normalise('todo.household', { uid: 'h1', summary: 'Put the bins out', status: 'needs_action' });
  const b = normalise('todo.household', { uid: 'h1', summary: 'Put the bins out on Tuesday', status: 'needs_action' });
  assert.equal(a.key, 'ha:todo.household:h1');
  assert.equal(a.key, b.key, 'the uid is identity: a rename is the same item');
  assert.notEqual(a.hash, b.hash, 'but the text changed, so it re-tiers');
  assert.notEqual(a.hash, normalise('todo.household', { uid: 'h1', summary: 'Put the bins out', status: 'completed' }).hash);
  assert.equal(normalise('todo.household', { summary: 'no uid' }), null, 'an item with no uid cannot be keyed or ticked off');
  assert.equal(normalise('todo.household', { uid: 'h9', summary: '' }).summary, '(no title)');
  assert.equal(normalise('todo.household', { uid: 'h9', summary: 'x' }).due, null, 'Home Assistant omits a field rather than nulling it');

  assert.equal(isInbox('todo.alice_inbox'), true);
  assert.equal(isInbox('todo.ann_inbox'), true, 'a second person needs no code');
  assert.equal(isInbox('todo.household'), false);
  assert.equal(listName('todo.shopping_list'), 'shopping list');

  // A date with no time is due at the end of that day, locally.
  assert.equal(dueAt(day(0)), new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 23, 59, 59, 999).getTime());
  assert.equal(dueAt('2026-09-20T09:00:00-07:00'), Date.parse('2026-09-20T09:00:00-07:00'));
  assert.equal(dueAt(null), null); assert.equal(dueAt('not a date'), null);
  assert.equal(isDue(day(0), NOW), true, 'due today counts all day');
  assert.equal(isDue(day(-1), NOW), true);
  assert.equal(isDue(day(1), NOW), false);
  assert.equal(isDue(null, NOW), false);
});

test('the rules: a date leads, then your own inbox, then the house; a completed item is not an item', async () => {
  const { api, store, rank, runner } = boot();
  const r = await runner.run('ha');
  assert.equal(r.ok, true);
  assert.equal(r.items, 5, 'five still to do; the one already ticked off is not an item');
  assert.equal(r.status, '2/2 lists — 5 to do, 1 done');
  assert.ok(!store.itemByKey(ME, 'ha', 'ha:todo.household:h4'), 'the completed item was never ingested');

  const by = Object.fromEntries(r.decisions.map((d) => [d.item, d]));
  assert.equal(by['ha:todo.alice_inbox:i1'].rule, 'due_today');
  assert.match(by['ha:todo.alice_inbox:i1'].reason, /2 d overdue — alice inbox/);
  assert.equal(by['ha:todo.household:h1'].rule, 'due_today');
  assert.match(by['ha:todo.household:h1'].reason, /due today — household/);
  assert.equal(by['ha:todo.alice_inbox:i2'].rule, 'inbox_item');
  assert.equal(by['ha:todo.household:h2'].rule, 'household_item');
  assert.match(by['ha:todo.household:h2'].reason, /on the household list/);
  assert.equal(by['ha:todo.household:h3'].rule, 'household_item', 'due in five days is not due');
  // Nothing here interrupts: none of these rules is in the set, and every
  // item says so on its own decision.
  assert.ok(r.decisions.every((d) => !d.delivered && /does not interrupt/.test(d.note)));

  const it = store.itemByKey(ME, 'ha', 'ha:todo.alice_inbox:i2');
  assert.equal(it.kind, 'todo'); assert.equal(it.url, DASH); assert.equal(it.repo, null);
  assert.equal(it.my_role, 'owner');
  assert.deepEqual(it.data, { list: 'todo.alice_inbox', due: null, description: 'roof or hitch' });
  assert.equal(store.itemByKey(ME, 'ha', 'ha:todo.household:h2').my_role, 'subscribed');
  // Past its date, an item has been waiting *since the date*.
  assert.equal(Date.parse(store.itemByKey(ME, 'ha', 'ha:todo.alice_inbox:i1').last_activity), dueAt(day(-2)));
  assert.equal(store.itemByKey(ME, 'ha', 'ha:todo.household:h2').last_activity, NOW.toISOString(), 'undated, it waits from when it was first seen');

  const L = lists(store, { user: ME, rank, now: NOW });
  const titles = L.groups[0].items.map((i) => i.title);
  assert.equal(titles[0], 'Renew the passport', 'two days overdue and in your own inbox');
  assert.deepEqual(titles.slice(-2).sort(), ['Book the car service', 'Rake the leaves'], 'undated chores last');
  assert.deepEqual(ha.project(store.itemByKey(ME, 'ha', 'ha:todo.household:h2')), 'todo.household');
  assert.equal(ha.time(store.itemByKey(ME, 'ha', 'ha:todo.household:h2')), 'flat', 'a shared chore with no date does not get more urgent by sitting');
  assert.equal(ha.time(store.itemByKey(ME, 'ha', 'ha:todo.household:h3')), 'waiting', 'a date is a clock');
  assert.equal(ha.time(store.itemByKey(ME, 'ha', 'ha:todo.alice_inbox:i2')), 'waiting', 'so is your own inbox');

  // A second run emits nothing: the events are keyed on summary + due + status.
  const again = await runner.run('ha');
  assert.deepEqual([again.events, again.decisions.length], [0, 0]);
  // Somebody reworded one on the tablet: news about the same item.
  api.lists['todo.household'][1].summary = 'Rake the leaves and bag them';
  const edited = await runner.run('ha');
  assert.equal(edited.events, 1);
  assert.equal(store.events(store.itemByKey(ME, 'ha', 'ha:todo.household:h2').id).at(-1).kind, 'changed');
  assert.equal(store.events(store.itemByKey(ME, 'ha', 'ha:todo.household:h2').id).at(0).kind, 'added');
  assert.deepEqual(runner.describe().find((s) => s.name === 'ha').cursor,
    { lists: LISTS, to_do: 5, done: 1, complete: true, read_at: NOW.toISOString() });
  store.close();
});

test('reconcile: an item ticked off in Home Assistant is resolved by the source, not by the owner; back on the list, it reopens', async () => {
  const { api, store, runner, logs } = boot();
  await runner.run('ha');
  const bins = store.itemByKey(ME, 'ha', 'ha:todo.household:h1');
  assert.equal(bins.state, 'open');

  // Somebody ticks it off on the kitchen tablet.
  api.lists['todo.household'][0].status = 'completed';
  let r = await runner.run('ha');
  assert.deepEqual(r.reconciled.resolved, [bins.key]);
  assert.equal(store.item(bins.id).state, 'done');
  const row = store.actionsFor(bins.id).at(-1);
  assert.equal(row.action, 'resolved'); assert.equal(row.by, 'source:ha');
  assert.ok(logs.some((m) => /reconcile: 1 resolved/.test(m)));

  // Un-ticked, or deleted and re-added: the source's own resolution is undone.
  api.lists['todo.household'][0].status = 'needs_action';
  r = await runner.run('ha');
  assert.deepEqual(r.reconciled.reopened, [bins.key]);
  assert.equal(store.item(bins.id).state, 'open');

  // Deleted outright is the same absence, and resolves the same way.
  api.lists['todo.household'].splice(1, 1);   // 'Rake the leaves'
  r = await runner.run('ha');
  assert.deepEqual(r.reconciled.resolved, ['ha:todo.household:h2']);

  // your own Done is not undone by the item still being on the list.
  const doIt = createActor({ store, now: () => NOW });
  await doIt({ id: bins.id, action: 'done', by: 'web' });
  r = await runner.run('ha');
  assert.deepEqual(r.reconciled, { resolved: [], reopened: [], complete: true });
  assert.equal(store.item(bins.id).state, 'done');
  store.close();
});

test('reconcile: a list that could not be read makes the set incomplete, and nothing is resolved', async () => {
  const { api, store, runner, logs } = boot();
  await runner.run('ha');
  const open = store.items({ user: ME, source: 'ha', state: 'open' }).length;
  assert.equal(open, 5);

  // One of the two lists stops answering. What was read is still stored;
  // the four items on the other list are not resolved away.
  api.fail = { list: 'todo.household' };
  const r = await runner.run('ha');
  assert.equal(r.ok, true, 'the poll still ran on what it could read');
  assert.equal(r.reconciled.complete, false);
  assert.equal(store.items({ user: ME, source: 'ha', state: 'open' }).length, open, 'an unreadable list resolves nothing');
  assert.ok(logs.some((m) => /the read was incomplete/.test(m)));
  assert.ok(logs.some((m) => /reconcile skipped — incomplete read/.test(m)));

  // Both lists gone is a failed poll, not an empty one: one network hiccup
  // must not close every chore in the house.
  api.fail = 'auth';
  const dead = await runner.run('ha');
  assert.equal(dead.ok, false);
  assert.match(dead.error, /token was refused/);
  assert.equal(store.items({ user: ME, source: 'ha', state: 'open' }).length, open);

  // And a set read for one list of lists does not speak for another.
  const set = ha.reconcile({ cursor: store.cursor('ha'), lists: ['todo.alice_inbox'] });
  assert.equal(set.complete, false);
  assert.match(set.error, /HA_LISTS changed/);
  assert.equal(set.governs({ data: { list: 'todo.alice_inbox' } }), true);
  assert.equal(set.governs({ data: { list: 'todo.household' } }), false, 'a list nobody read is not spoken for');
  assert.equal(ha.reconcile({ cursor: null, lists: LISTS }), null, 'nothing read yet is nothing to say');
  assert.equal(ha.reconcile({ cursor: store.cursor('ha'), lists: [] }), null, 'and no lists is not an empty house');
  await assert.rejects(ha.poll({ api, lists: [], cursor: null }), /names no list/);
  store.close();
});

test('reconcile: taking a list out of HA_LISTS does not resolve everything that was ever on it', async () => {
  const { api, store, runner } = boot();
  await runner.run('ha');
  const chore = store.itemByKey(ME, 'ha', 'ha:todo.household:h2');
  assert.equal(chore.state, 'open');

  // HA_LISTS now names one list. The poll reads it, writes the cursor and
  // reconciles — and the equality check cannot help here, because the poll
  // wrote the narrowed set the check compares against. `governs` is what
  // stops four chores nobody looked at being closed as "gone from ha".
  const narrowed = new Runner(store, [ha], { user: ME, rules: { ha: rules }, extras: { ha: { api, lists: ['todo.alice_inbox'], dashboard: DASH } }, log: () => {} });
  narrowed.now = () => NOW;
  const r = await narrowed.run('ha');
  assert.equal(r.ok, true);
  assert.deepEqual(r.reconciled, { resolved: [], reopened: [], complete: true });
  assert.equal(store.item(chore.id).state, 'open', 'still on the fridge; triage merely stopped looking');
  store.close();
});

test('Done ticks the item off in Home Assistant, and a refusal is kept on the action row', async () => {
  const { api, store, runner } = boot();
  await runner.run('ha');
  const bike = store.itemByKey(ME, 'ha', 'ha:todo.alice_inbox:i2');
  const act = createActor({ store, marks: { ha: markDone(api) }, now: () => NOW });

  const r = await act({ id: bike.id, action: 'done', by: 'web' });
  assert.equal(r.marked, 'ticked off in alice inbox');
  assert.equal(api.lists['todo.alice_inbox'][1].status, 'completed', 'the one write this source makes');
  assert.ok(api.calls.some((c) => c.startsWith('POST /api/services/todo/update_item')));
  // And the next poll agrees rather than fighting: it is gone from the set,
  // and an item the owner closed himself is not reopened.
  const after = await runner.run('ha');
  assert.deepEqual(after.reconciled.resolved, [], 'already done; nothing to resolve');
  assert.equal(store.item(bike.id).state, 'done');

  // Home Assistant refusing the write does not undo the local state.
  const passport = store.itemByKey(ME, 'ha', 'ha:todo.alice_inbox:i1');
  api.fail = 'write';
  const bad = await act({ id: passport.id, action: 'done', by: 'web' });
  assert.match(bad.marked, /^not ticked off: home assistant 500/);
  assert.equal(store.item(passport.id).state, 'done', 'your queue is yours');
  assert.equal(store.actionsFor(passport.id).at(-1).data.marked, bad.marked);

  // An item with nothing to write against says so rather than throwing.
  assert.match(await markDone(api)({ key: 'ha:todo.household:x', data: {} }), /does not name a list and a uid/);
  store.close();
});

test('config: unset means on when the credentials are there, a typo is refused, and the lists are entity ids', () => {
  const base = { TRIAGE_ENV: '/nonexistent/.env', TRIAGE_PREFS: '/nonexistent/preferences.json' };
  const cfg = (extra) => loadConfig({ ...base, ...extra }).ha;

  assert.deepEqual(cfg({}).mode, null);
  assert.deepEqual(cfg({}).lists, [], 'no default list: HA_LISTS names them');
  assert.deepEqual(cfg({ HA_LISTS: 'todo.alice_inbox, todo.household' }).lists, ['todo.alice_inbox', 'todo.household']);
  assert.equal(cfg({}).url, null);
  assert.equal(cfg({ HA_URL: 'http://ha.test:8123/' }).url, 'http://ha.test:8123', 'a trailing slash is not part of the URL');
  assert.equal(cfg({ HA_URL: 'http://ha.test:8123' }).dashboard, 'http://ha.test:8123/todo');
  assert.equal(cfg({ HA_URL: 'http://ha.test:8123', TRIAGE_HA_DASHBOARD: 'https://ha.example/x' }).dashboard, 'https://ha.example/x');
  assert.equal(cfg({ TRIAGE_HA: 'fake' }).mode, 'fake');
  assert.equal(cfg({ TRIAGE_HA: 'OFF' }).mode, 'off');
  // A typo must not read as the default, exactly as TRIAGE_CALENDAR refuses one.
  assert.throws(() => cfg({ TRIAGE_HA: 'onn' }), /TRIAGE_HA must be off, on, fake/);
  assert.deepEqual(cfg({ HA_LISTS: 'todo.a, todo.b todo.a' }).lists, ['todo.a', 'todo.b']);
  assert.deepEqual(parseHaLists('TODO.Household'), ['todo.household']);
  assert.throws(() => cfg({ HA_LISTS: 'household' }), /not a to-do entity id/);
});
