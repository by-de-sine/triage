// The the host ledger as a source (plan §12.3, source 1), and the first
// state-shaped one: rows that wait on a human become items, the ask on a
// row becomes the choices on the line, and a row that is deleted is resolved
// by `reconcile` (plan §12.2) rather than sitting open for ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { Runner } from '../lib/runner.js';
import { Ranker } from '../lib/rank.js';
import { lists } from '../lib/lists.js';
import { createActor } from '../lib/actions.js';
import ledger, { cells, parseAsk, parseRow, parseHandoff } from '../sources/ledger.js';
import rules from '../rules/ledger.js';

const ME = 'alice';
const NOW = new Date('2026-09-12T12:00:00Z');
const QUEUE = `# Open Loops

**The queue.** One line per open item.

## Open

| Nudge | Owner | Item | Context |
|---|---|---|---|
| 2026-09-30 | \`agent\` | Slack delivery is proven; the P0 interrupt is untested | kept as the inventory row for \`SLACK_WEBHOOK_URL\` |
| 2026-08-31 | \`human-sudo\` | Make the Caddy preview config survive a restart | one line: \`TRIAGE_SLACK=webhook|app|off\` is not it, but pipes in backticks are |
| 2026-09-20 | \`human-decision\` | The company GitHub org cannot be named Acme [confirm: rename the user · new org · leave it] | \`Acme\` is a user account |
| 2026-09-20 | \`human-laptop\` | **The PAT was reissued** [ack] | nothing to do but know |
| 2026-12-31 | \`human-laptop\` | ~~triage delivers nothing to Slack until the app exists~~ (kept for history) | superseded |
`;

function fixture(queue = QUEUE) {
  const dir = mkdtempSync(path.join(tmpdir(), 'triage-ledger-'));
  const file = path.join(dir, 'OPEN_LOOPS.md');
  const statusDir = path.join(dir, 'status');
  mkdirSync(statusDir);
  writeFileSync(file, queue);
  writeFileSync(path.join(statusDir, 'triage--ship.md'), '# triage/ship\nstate: review\nnext: merge #14, then run the deploy script\nupdated: 2026-09-12\n\nprose\n');
  writeFileSync(path.join(statusDir, 'acme--main.md'), '# acme/main\nstate: done\nnext: nothing\nupdated: 2026-09-01\n');
  return { dir, file, statusDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function boot(f) {
  const store = new Store();
  const rank = new Ranker({ shapes: { ledger: ledger.time }, now: () => NOW });
  const logs = [];
  const runner = new Runner(store, [ledger], { user: ME, rules: { ledger: rules }, rank, extras: { ledger: { file: f.file, statusDir: f.statusDir } }, log: (m) => logs.push(m) });
  runner.now = () => NOW;
  return { store, rank, runner, logs };
}

test('cells split on pipes outside backticks, and the ask tag parses', () => {
  assert.deepEqual(cells('| a | `x|y` | c |'), ['a', '`x|y`', 'c']);
  assert.deepEqual(parseAsk('Do it [action]'), { ask: 'action', choices: null, text: 'Do it' });
  assert.deepEqual(parseAsk('Seen? [ack]').ask, 'ack');
  assert.deepEqual(parseAsk('Rename? [confirm]').choices, [{ key: 'A', label: 'yes' }, { key: 'B', label: 'no' }]);
  assert.deepEqual(parseAsk('Which? [confirm: red · green / blue]').choices.map((c) => `${c.key}) ${c.label}`), ['A) red', 'B) green', 'C) blue']);
  assert.equal(parseAsk('No tag here').ask, null);
});

test('a row becomes a todo keyed on its item text, so a nudge bump keeps identity and a reword does not', () => {
  const a = parseRow('| 2026-09-20 | `human-decision` | Rename the org [confirm] | why |', 3);
  const b = parseRow('| 2026-10-01 | `human-decision` | Rename the org [confirm] | why, again |', 3);
  const c = parseRow('| 2026-10-01 | `human-decision` | Rename the **org**, please | why |', 3);
  assert.equal(a.key, b.key, 'same item, bumped nudge and reworded context');
  assert.notEqual(a.hash, b.hash, 'but the row changed, so it re-tiers');
  assert.notEqual(a.key, c.key, 'a reworded item is a new item');
  assert.equal(a.owner, 'human-decision'); assert.equal(a.ask, 'confirm'); assert.equal(a.nudge, '2026-09-20');
  assert.equal(parseRow('| Nudge | Owner | Item | Context |'), null);
  assert.equal(parseRow('|---|---|---|---|'), null);
  assert.equal(parseRow('| :--- | ---: | :---: | --- |'), null, 'alignment colons are still a separator');
  assert.notEqual(parseRow('| x | `agent` | Ship v2.0 | y |').key, parseRow('| x | `agent` | Ship v2 0 | y |').key, 'punctuation is identity');
  assert.notEqual(parseRow('| x | `agent` | Ship it | y |').key, parseRow('| x | `agent` | ship it | y |').key, 'so is case');
  assert.equal(parseRow('| x | `agent` | **Ship**  it | y |').key, parseRow('| x | `agent` | Ship it | y |').key, 'emphasis and spacing are not');
  assert.equal(parseRow('prose, not a row'), null);
  assert.equal(parseRow('| 2026-09-20 | `agent` | An agent row | x |').ask, null, 'an agent row asks nothing of you');
  assert.equal(parseRow('| 2026-09-20 | `human-laptop` | Untagged | x |').ask, 'action', 'untagged and yours means an action');
  assert.equal(parseRow('| 2026-09-20 | `human-laptop` | ~~Struck~~ | x |').struck, true);
  const h = parseHandoff('triage--ship.md', 'state: review\nnext: merge it\nupdated: 2026-09-12\n');
  assert.equal(h.key, 'handoff:triage--ship'); assert.match(h.title, /^review triage\/ship: merge it/); assert.equal(h.owner, 'human-decision');
  assert.equal(parseHandoff('x.md', 'state: done\nnext: n\n'), null);
  assert.equal(parseHandoff('y.md', 'state: blocked\nblocked-on: human-sudo\nnext: n\n').owner, 'human-sudo');
});

test('the rules: quick answers first, then what is past its nudge, then actions; an agent\'s row sinks', async () => {
  const f = fixture();
  try {
    const { store, rank, runner } = boot(f);
    const r = await runner.run('ledger');
    assert.equal(r.ok, true);
    assert.equal(r.items, 6, 'five rows and one handoff in review; the done handoff is not an item');
    const by = Object.fromEntries(r.decisions.map((d) => [d.item, d]));
    const key = (t) => Object.keys(by).find((k) => store.itemByKey(ME, 'ledger', k).title.startsWith(t));
    assert.equal(by[key('The company GitHub org')].rule, 'quick_answer');
    assert.match(by[key('The company GitHub org')].reason, /A\) rename the user · B\) new org · C\) leave it/);
    assert.equal(by[key('The PAT was reissued')].rule, 'quick_answer');
    assert.equal(by[key('Make the Caddy')].rule, 'past_its_nudge');
    assert.match(by[key('Make the Caddy')].reason, /12 d past its nudge/);
    assert.equal(by[key('review triage/ship')].rule, 'waiting_on_you');
    assert.equal(by[key('Slack delivery')].rule, 'agents_own');
    assert.equal(by[key('triage delivers nothing')].rule, 'kept_for_history');
    // Nothing interrupts: the ledger has no rules in the set, and every row
    // says so on its own decision.
    assert.ok(r.decisions.every((d) => !d.delivered && /does not interrupt/.test(d.note)));
    // In the list, quick answers lead and the agent's row is last; grouped by
    // owner, the groups are what it takes.
    const L = lists(store, { user: ME, rank, now: NOW });
    const titles = L.groups[0].items.map((i) => i.title.slice(0, 18));
    // Twelve days past its nudge, the Caddy row has been waiting longest and
    // leads; the two quick answers are next; the fresh action (the handoff)
    // is behind all three, and the agent's rows and history are last.
    assert.deepEqual(titles.slice(0, 3).sort(), ['Make the Caddy pre', 'The PAT was reissu', 'The company GitHub']);
    assert.equal(titles[3], 'review triage/ship');
    assert.deepEqual(titles.slice(-2), ['Slack delivery is ', 'triage delivers no']);
    const row = L.groups[0].items.find((i) => i.title.startsWith('The company'));
    assert.equal(row.owner, 'human-decision'); assert.equal(row.ask, 'confirm'); assert.equal(row.url, null);
    assert.deepEqual(row.choices.map((c) => c.key), ['A', 'B', 'C']);
    const G = lists(store, { user: ME, rank, now: NOW, group: 'owner' });
    assert.deepEqual(G.groups.filter((g) => g.group_of).map((g) => g.label).sort(), ['agent', 'human-decision', 'human-laptop', 'human-sudo']);
    // A second run emits nothing: the events are keyed on the row's hash.
    const again = await runner.run('ledger');
    assert.deepEqual([again.events, again.decisions.length], [0, 0]);
    assert.equal(store.item(store.itemByKey(ME, 'ledger', key('Make the Caddy')).id).last_activity, '2026-08-31T00:00:00.000Z', 'past its nudge, a row has been waiting since the nudge');
    assert.equal(store.item(store.itemByKey(ME, 'ledger', key('The PAT was reissued')).id).last_activity, NOW.toISOString(), 'not yet due, it waits from when it was first seen');
    assert.deepEqual(runner.describe().find((s) => s.name === 'ledger').cursor, { rows: 6, handoffs: 1, read_at: NOW.toISOString() });
  } finally { f.cleanup(); }
});

test('reconcile: a deleted row is resolved by the source, not by the owner; back in the set, it reopens; an unreadable ledger resolves nothing', async () => {
  const f = fixture();
  try {
    const { store, runner, logs } = boot(f);
    await runner.run('ledger');
    const caddy = store.itemByKey(ME, 'ledger', parseRow('| x | `human-sudo` | Make the Caddy preview config survive a restart | y |').key);
    assert.equal(caddy.state, 'open');
    // the owner deletes the row.
    writeFileSync(f.file, QUEUE.split('\n').filter((l) => !l.includes('Make the Caddy')).join('\n'));
    let r = await runner.run('ledger');
    assert.deepEqual(r.reconciled.resolved, [caddy.key]);
    assert.equal(store.item(caddy.id).state, 'done');
    const act = store.actionsFor(caddy.id).at(-1);
    assert.equal(act.action, 'resolved'); assert.equal(act.by, 'source:ledger');
    assert.ok(logs.some((m) => /reconcile: 1 resolved/.test(m)));
    // The row comes back (someone re-added it): the source's own resolution is undone.
    writeFileSync(f.file, QUEUE);
    r = await runner.run('ledger');
    assert.deepEqual(r.reconciled.reopened, [caddy.key]);
    assert.equal(store.item(caddy.id).state, 'open');
    assert.equal(store.actionsFor(caddy.id).at(-1).action, 'reopen');
    // your own Done is not undone by the row still being there.
    const doIt = createActor({ store, now: () => NOW });
    await doIt({ id: caddy.id, action: 'done', by: 'web' });
    r = await runner.run('ledger');
    assert.deepEqual(r.reconciled, { resolved: [], reopened: [], complete: true });
    assert.equal(store.item(caddy.id).state, 'done');
    // The file vanishes: the poll fails and nothing is resolved.
    unlinkSync(f.file);
    r = await runner.run('ledger');
    assert.equal(r.ok, false);
    assert.equal(store.items({ user: ME, source: 'ledger', state: 'open' }).length, 5, 'a failed read resolves nothing');
    const set = await ledger.reconcile({ file: f.file, statusDir: f.statusDir });
    assert.equal(set.complete, false);
  } finally { f.cleanup(); }
});

test('reconcile: a handoff that cannot be read makes the set incomplete, and nothing is resolved', async () => {
  const f = fixture();
  try {
    const { store, runner, logs } = boot(f);
    await runner.run('ledger');
    const before = store.items({ user: ME, source: 'ledger', state: 'open' }).length;
    chmodSync(path.join(f.statusDir, 'triage--ship.md'), 0o000);
    const set = await ledger.reconcile({ file: f.file, statusDir: f.statusDir });
    assert.equal(set.complete, false);
    assert.match(set.error, /triage--ship\.md/);
    const r = await runner.run('ledger');
    assert.equal(r.ok, true, 'the poll still ran on what it could read');
    assert.equal(r.reconciled.complete, false);
    assert.equal(store.items({ user: ME, source: 'ledger', state: 'open' }).length, before, 'the unreadable handoff was not resolved away');
    assert.ok(logs.some((m) => /reconcile skipped — incomplete read/.test(m)));
    chmodSync(path.join(f.statusDir, 'triage--ship.md'), 0o644);
    assert.equal((await ledger.reconcile({ file: f.file, statusDir: f.statusDir })).complete, true);
    // And a ledger with no status directory at all is complete: no handoffs is not a failed read.
    rmSync(f.statusDir, { recursive: true, force: true });
    assert.equal((await ledger.reconcile({ file: f.file, statusDir: f.statusDir })).complete, true);
  } finally { f.cleanup(); }
});

test('reconcile walks every item of the source, not a page of them', async () => {
  const { reconcile } = await import('../lib/pipeline.js');
  const store = new Store();
  for (let i = 0; i < 1203; i++) store.upsertItem({ user: ME, source: 'ledger', key: `row:${i}`, kind: 'todo', title: `row ${i}`, url: null, repo: null });
  // Everything but the last row is still in the set.
  const keys = Array.from({ length: 1202 }, (_, i) => `row:${i}`);
  const out = reconcile(store, { user: ME, source: 'ledger', keys, complete: true }, { now: NOW });
  assert.deepEqual(out.resolved, ['row:1202']);
  assert.equal(store.items({ user: ME, source: 'ledger', state: 'done', limit: 1000 }).length, 1);
  store.close();
});

test('answer: a choice from the row\'s own list closes the item and is on the action row for whoever asked', async () => {
  const f = fixture();
  try {
    const { store, runner } = boot(f);
    await runner.run('ledger');
    const org = store.items({ user: ME, source: 'ledger' }).find((i) => i.title.startsWith('The company GitHub'));
    const act = createActor({ store, marks: { ledger: async () => 'nothing changed in the ledger' }, now: () => NOW });
    await assert.rejects(act({ id: org.id, action: 'answer', choice: 'Z' }), /choice must be one of A\) rename the user/);
    const r = await act({ id: org.id, action: 'answer', choice: 'b', by: 'web' });
    assert.equal(r.choice, 'B'); assert.equal(r.label, 'new org'); assert.equal(r.item.state, 'done');
    const row = store.actionsFor(org.id).at(-1);
    assert.equal(row.action, 'answer'); assert.deepEqual(row.data, { marked: 'nothing changed in the ledger', choice: 'B', label: 'new org' });
    // One answer: a second is refused until the item is reopened.
    await assert.rejects(act({ id: org.id, action: 'answer', choice: 'A' }), /already answered or done/);
    await act({ id: org.id, action: 'open' });
    assert.equal((await act({ id: org.id, action: 'answer', choice: 'A' })).choice, 'A');
    // A label works too; an item with no choices cannot be answered.
    const pat = store.items({ user: ME, source: 'ledger' }).find((i) => i.title.startsWith('The PAT'));
    await assert.rejects(act({ id: pat.id, action: 'answer', choice: 'A' }), /no choices to answer/);
  } finally { f.cleanup(); }
});
