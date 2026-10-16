// The CRM as a source (plan §12.3 item 3): Twenty's open tasks are state,
// reconciled against a complete read; a task or note changed by somebody who
// is not Alice is an event, which interrupts when it lands on a task of his;
// and a CRM that has not been read for the stale window is an interrupt of
// its own.
//
// Everything runs against test/fake-twenty.js — the real TwentyApi over a
// fake fetch that pages for real — and the real SlackDelivery with Slack
// off, so "would this have interrupted" is answered by the decision row's
// note exactly as /api/decisions answers it on a worktree. No network, no
// key, no Twenty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { Runner } from '../lib/runner.js';
import { Ranker } from '../lib/rank.js';
import { SlackDelivery } from '../deliver/slack.js';
import { resolve } from '../deliver/interrupts.js';
import { loadConfig, parseCrmProjects } from '../lib/config.js';
import crm, { fingerprint, changedFields, isOther, resolveSelf, who, isDue, HEALTH_KEY, TASK_FIELDS } from '../sources/crm.js';
import rules, { didWhat } from '../rules/crm.js';
import { fakeTwenty, world, task, note, edit, BY, ALICE, BOB } from './fake-twenty.js';

const ME = 'alice';
const T0 = Date.parse('2026-10-03T12:00:00.000Z');
const at = (min) => new Date(T0 + min * 60_000);
const iso = (min) => at(min).toISOString();
const SELF = ['alice@example.test'];
const AGENTS = ['Agent key'];

function boot({ prefs = null, env = null, staleMin = 30, api: given = null } = {}) {
  const w = world();
  w.tasks.push(
    task({ id: 'bob', title: 'DEV 6 · ActiveStorage loose ends', body: 'Investigate, then close.', assigneeId: BOB, at: iso(-600) }),
    task({ id: 'mine', title: 'Send the invoice', body: 'From the worklog.', assigneeId: ALICE, dueAt: iso(-60), at: iso(-1440), by: BY.aliceUi }),
    task({ id: 'open', title: 'Privacy notice', body: 'Offered to help draft.', at: iso(-3000), person: 'p1', company: null }),
    task({ id: 'done', title: 'Drop /contact/new', status: 'DONE', at: iso(-5000) }),
  );
  w.notes.push(note({ id: 'spec', title: 'SEO release spec', body: 'Part 1.', at: iso(-4000) }));
  const api = given || fakeTwenty(w);
  if (given) given.world = w;
  const store = new Store();
  const rank = new Ranker({ shapes: { crm: crm.time }, now: () => at(0) });
  const deliver = new SlackDelivery(store, { mode: 'off', interrupts: resolve({ prefs, env }), projects: { crm: crm.project }, rank });
  const logs = [];
  const health = { startedAt: iso(0), error: null };
  const extras = { api, url: api.url, self: SELF, agents: AGENTS, projects: parseCrmProjects('Acme Corp=acme'), staleMs: staleMin * 60_000, health };
  const runner = new Runner(store, [crm], { user: ME, rules: { crm: rules }, rank, deliver, extras: { crm: extras }, log: (m) => logs.push(m) });
  let clock = 0;
  runner.now = () => at(clock);
  const tick = async (min) => { clock = min; return runner.run('crm'); };
  const item = (id, kind = 'task') => store.items({ user: ME, source: 'crm', limit: 1000 }).find((i) => i.key === `crm:${kind}:${id}`);
  const decisions = () => store.decisions({ limit: 1000 });
  return { w, api, store, runner, tick, item, decisions, logs, health };
}

// ---- who is somebody else ------------------------------------------------

test('who is somebody else: Alice in the UI and Alice through MCP are not; Bob, and a key nobody named, are', () => {
  const self = new Set([ALICE]);
  assert.equal(isOther(BY.aliceUi, { self, agents: AGENTS }), false, 'Alice by hand');
  assert.equal(isOther(BY.aliceMcp, { self, agents: AGENTS }), false, "Alice's agents act as Agent key");
  assert.equal(isOther({ ...BY.aliceMcp, name: 'agent KEY ' }, { self, agents: AGENTS }), false, 'a typed name is compared without case');
  assert.equal(isOther(BY.bobUi, { self, agents: AGENTS }), true, 'Bob by hand');
  assert.equal(isOther(BY.unknownKey, { self, agents: AGENTS }), true, 'a key nobody has named is somebody else — the safe direction to be wrong in');
  assert.equal(isOther({ source: 'API', workspaceMemberId: null, name: 'Other key' }, { self, agents: AGENTS }), true, 'a second MCP identity is somebody else until Alice names it');
  assert.equal(isOther(null, { self, agents: AGENTS }), true, 'no actor at all is not proof it was Alice');
  assert.equal(who(BY.bobUi), 'Bob Example');
  assert.equal(who(BY.unknownKey), 'Zapier (api)');
});

test('TRIAGE_CRM_ME resolves by id, email or name, and an entry that matches nobody is an error, not a smaller set', () => {
  const members = world().members;
  assert.deepEqual([...resolveSelf(['alice@example.test'], members)], [ALICE]);
  assert.deepEqual([...resolveSelf(['Alice Example'], members)], [ALICE]);
  assert.deepEqual([...resolveSelf([ALICE], [])], [ALICE], 'an id is trusted even if the member list is short');
  assert.throws(() => resolveSelf(['alice@elsewhere.test'], members), /is no workspace member/);
});

test('the fingerprint is per field, so an edit can say what it changed; identity is not in it', () => {
  const a = fingerprint({ t: 'x', b: 'body', s: 'TODO', a: '', d: '' });
  const b = fingerprint({ t: 'x', b: 'body, reworded', s: 'TODO', a: '', d: '' });
  const c = fingerprint({ t: 'x', b: 'body', s: 'TODO', a: '', d: '' });
  assert.notEqual(a.hash, b.hash);
  assert.equal(a.hash, c.hash);
  assert.deepEqual(changedFields(a.parts, b.parts, TASK_FIELDS), ['body']);
  assert.deepEqual(changedFields(null, b.parts, TASK_FIELDS), []);
  assert.equal(didWhat({ kind: 'changed', data: { object: 'task', changed: ['status'], status: 'DONE' } }), 'marked it Done');
  assert.equal(didWhat({ kind: 'changed', data: { object: 'task', changed: ['title', 'body'] } }), 'changed the title and body');
  assert.equal(didWhat({ kind: 'created', data: { object: 'note' } }), 'added a note');
});

// ---- the flow ------------------------------------------------------------

test('the first read is a baseline: every open task is an item, nothing interrupts, done tasks and Alice\'s notes are not items', async () => {
  const { tick, item, decisions, store } = boot();
  const r = await tick(0);
  assert.equal(r.ok, true);
  assert.ok(item('bob') && item('mine') && item('open'));
  assert.equal(item('done'), undefined, 'a done task is history, not an item');
  assert.equal(item('spec', 'note'), undefined, "Alice's own notes are his notes, not his queue");
  assert.ok(decisions().every((d) => !/changed_by_other/.test(d.rule)), 'nothing changed while triage was watching');
  assert.equal(store.lastDecision(item('mine').id).rule, 'task_due', 'his task, an hour overdue');
  assert.equal(store.lastDecision(item('bob').id).reason, "open — Bob Example's");
  // The project seam: the company is the project, by the name configured —
  // through a person target when the task names no company.
  assert.equal(crm.project(item('bob')), 'acme');
  assert.equal(crm.project(item('open')), 'acme');
  assert.equal(item('bob').repo, 'acme');
  assert.equal(store.items({ user: ME, source: 'crm' }).length, 3);
});

test('Bob rewording a task of Alice\'s interrupts, and says what he changed; the same fingerprint never alerts twice', async () => {
  const { w, tick, item, decisions } = boot();
  await tick(0);
  const t = w.tasks.find((x) => x.id === 'mine');
  edit(t, { body: 'Hours are in; the rate changed in September — check before sending.' }, BY.bobUi, at(1));
  const r = await tick(1);
  const d = r.decisions.find((x) => x.item === 'crm:task:mine');
  assert.equal(d.rule, 'changed_on_my_task');
  assert.equal(d.tier, 'P0');
  assert.equal(d.reason, 'Bob Example changed the body — your task');
  assert.match(d.note, /slack is off/, 'it was allowed to interrupt — Slack is off in tests, which is the only reason it was not sent');
  assert.doesNotMatch(d.note, /does not interrupt/);
  assert.equal(item('mine').tier, 'P0');
  assert.equal(item('mine').my_role, 'assigned');
  // The next read sees the same record: nothing is fresh, nothing decides.
  const again = await tick(2);
  assert.equal(again.decisions.length, 0);
  // A revert to a fingerprint already emitted is not news either.
  edit(t, { body: 'From the worklog.' }, BY.bobUi, at(3));
  const back = await tick(3);
  assert.equal(back.decisions.filter((x) => x.item === 'crm:task:mine').length, 0);
  assert.equal(decisions().filter((x) => x.rule === 'changed_on_my_task').length, 1);
});

test('whose record it lands on decides the tier: handed to you P0, on yours P0, on one you wrote P1, anybody else\'s P2 — and only the first two interrupt', async () => {
  const { w, tick, item } = boot();
  // Bob's own task, written by Bob: the 2026-10-15 afternoon, in one row.
  w.tasks.push(task({ id: 'his', title: 'EMAIL · Audit the account', body: 'Lists, segments, automations.', assigneeId: BOB, by: BY.bobUi, at: iso(-100) }));
  await tick(0);
  edit(w.tasks.find((x) => x.id === 'his'), { body: 'Audit done; findings in the note.', status: 'DONE' }, BY.bobAgent, at(1));
  edit(w.tasks.find((x) => x.id === 'bob'), { body: 'Investigated: #93 is the scanner.' }, BY.bobUi, at(1));
  edit(w.tasks.find((x) => x.id === 'open'), { assigneeId: ALICE }, BY.bobUi, at(1));
  w.tasks.push(task({ id: 'given', title: 'Review the pricing', body: 'Before Friday.', assigneeId: ALICE, by: BY.bobUi, at: iso(1) }));
  w.notes.push(note({ id: 'findings', title: 'Email audit findings', body: 'Campaign Monitor.', by: BY.bobAgent, at: iso(1) }));
  const r = await tick(1);
  const by = Object.fromEntries(r.decisions.map((d) => [d.item, d]));
  const expect = {
    'crm:task:given': ['handed_to_me', 'P0', 'Bob Example gave you a task', true],
    'crm:task:open': ['handed_to_me', 'P0', 'Bob Example assigned it to you', true],
    'crm:task:bob': ['changed_what_i_wrote', 'P1', 'Bob Example changed the body — a task you wrote', false],
    'crm:task:his': ['changed_by_other', 'P2', 'Other key (api) changed the body and status (now Done)', false],
    'crm:note:findings': ['changed_by_other', 'P2', 'Other key (api) added a note', false],
  };
  for (const [key, [rule, tier, reason, buzz]] of Object.entries(expect)) {
    const d = by[key];
    assert.ok(d, `${key} decided`);
    assert.deepEqual([d.rule, d.tier, d.reason], [rule, tier, reason], key);
    if (buzz) assert.doesNotMatch(d.note, /does not interrupt/, `${key} interrupts`);
    else assert.match(d.note, /does not interrupt/, `${key} is the list, not Slack`);
  }
  assert.equal(item('bob').my_role, 'authored', 'Alice\'s agent wrote it and handed it to Bob');
  assert.equal(item('his').my_role, 'subscribed');
  // Somebody who wants every edit again says so, and gets the 2026-10-02 behaviour.
  const loud = boot({ env: '+crm:changed_by_other,+crm:changed_what_i_wrote' });
  loud.w.tasks.push(task({ id: 'his', title: 'EMAIL · Audit the account', body: 'x', assigneeId: BOB, by: BY.bobUi, at: iso(-100) }));
  await loud.tick(0);
  edit(loud.w.tasks.find((x) => x.id === 'his'), { body: 'y' }, BY.bobAgent, at(1));
  edit(loud.w.tasks.find((x) => x.id === 'bob'), { body: 'y' }, BY.bobUi, at(1));
  for (const d of (await loud.tick(1)).decisions) assert.doesNotMatch(d.note, /does not interrupt/, d.item);
});

test('Alice editing through MCP or in the UI never interrupts; it re-ranks quietly', async () => {
  const { w, tick } = boot();
  await tick(0);
  edit(w.tasks.find((x) => x.id === 'mine'), { body: 'Draft only.' }, BY.aliceMcp, at(1));
  edit(w.tasks.find((x) => x.id === 'open'), { title: 'Privacy notice (Joe)' }, BY.aliceUi, at(1));
  const r = await tick(1);
  assert.equal(r.decisions.length, 2);
  for (const d of r.decisions) {
    assert.notEqual(d.rule, 'changed_by_other');
    assert.match(d.note, /does not interrupt/);
  }
});

test('a key nobody named adding a note makes the note an item, and interrupts', async () => {
  const { w, tick, item } = boot();
  await tick(0);
  w.notes.push(note({ id: 'answer', title: 'Answer on #16', body: 'The 404 is an old URL.', by: BY.unknownKey, at: iso(1) }));
  const r = await tick(1);
  const d = r.decisions.find((x) => x.item === 'crm:note:answer');
  assert.equal(d.rule, 'changed_by_other');
  assert.equal(d.reason, 'Zapier (api) added a note');
  assert.equal(item('answer', 'note').repo, 'acme');
  // Alice answering on that note stays part of its story, and does not buzz.
  edit(w.notes.find((n) => n.id === 'answer'), { body: 'The 404 is an old URL. — thanks, closing.' }, BY.aliceMcp, at(2));
  const r2 = await tick(2);
  assert.equal(r2.decisions.find((x) => x.item === 'crm:note:answer').rule, 'ambient');
});

test('a status change says so; Bob marking a task Done is news, then reconcile resolves it as the source', async () => {
  const { w, tick, item, store } = boot();
  await tick(0);
  const t = w.tasks.find((x) => x.id === 'bob');
  edit(t, { status: 'IN_PROGRESS' }, BY.bobUi, at(1));
  let r = await tick(1);
  assert.equal(r.decisions[0].reason, 'Bob Example marked it In progress — a task you wrote');
  edit(t, { status: 'DONE' }, BY.bobUi, at(2));
  r = await tick(2);
  assert.equal(r.decisions[0].rule, 'changed_what_i_wrote', 'Alice\'s agent wrote it; Bob is reporting back');
  assert.equal(r.decisions[0].reason, 'Bob Example marked it Done — a task you wrote');
  assert.deepEqual(r.reconciled.resolved, ['crm:task:bob']);
  const it = item('bob');
  assert.equal(it.state, 'done');
  assert.equal(store.actionsFor(it.id).at(-1).by, 'source:crm', 'the source closed it, not Alice');
});

test('a deleted task leaves the set and is resolved by the source; a complete read is what lets it', async () => {
  const { w, tick, item, store } = boot();
  await tick(0);
  w.tasks = w.tasks.filter((x) => x.id !== 'open');
  const r = await tick(1);
  assert.deepEqual(r.reconciled.resolved, ['crm:task:open']);
  assert.equal(store.actionsFor(item('open').id).at(-1).by, 'source:crm');
});

test('an incomplete read — the page cap reached — resolves nothing and forgets nothing', async () => {
  const api = fakeTwenty(undefined, { pageSize: 1, maxPages: 2 });
  const { w, tick, item, logs } = boot({ api });
  w.tasks.push(task({ id: 'fourth', title: 'One more', at: iso(-10) }));
  // Four open tasks at one per page and two pages: two are never seen.
  const r = await tick(0);
  assert.equal(r.reconciled.complete, false);
  assert.deepEqual(r.reconciled.resolved, []);
  assert.ok(logs.some((l) => /reconcile skipped — incomplete read/.test(l)));
  // Now a task really goes; still incomplete, still nothing resolved.
  w.tasks = w.tasks.filter((x) => x.id !== 'bob');
  const r2 = await tick(1);
  assert.deepEqual(r2.reconciled.resolved, []);
  assert.equal(item('bob').state, 'open');
});

test('bodies are fetched only for records that moved', async () => {
  const { w, api, tick } = boot();
  await tick(0);
  const first = api.calls.length;
  await tick(1);
  const quiet = api.calls.slice(first);
  assert.deepEqual(quiet.sort(), ['companies', 'notes', 'people', 'tasks', 'workspaceMembers'].sort(), 'a quiet minute asks for no bodies at all');
  edit(w.tasks.find((x) => x.id === 'bob'), { body: 'x' }, BY.bobUi, at(2));
  const before = api.calls.length;
  await tick(2);
  assert.equal(api.calls.slice(before).filter((c) => c === 'tasks').length, 2, 'the lean read, then one body');
});

// ---- the read itself is watched ------------------------------------------

test('a CRM that cannot be read is a P0 after the stale window — once per outage — and a good read resolves it', async () => {
  const { api, tick, item, decisions, store } = boot({ staleMin: 30 });
  await tick(0);
  api.fail = 'auth';
  let r = await tick(10);
  assert.equal(r.ok, false);
  assert.match(r.error, /key was refused/);
  assert.equal(item(null, 'health'), undefined);
  r = await tick(29);
  assert.equal(store.items({ user: ME, source: 'crm' }).find((i) => i.key === HEALTH_KEY), undefined, 'inside the window, silence is allowed');
  r = await tick(31);
  const health = () => store.items({ user: ME, source: 'crm', limit: 1000 }).find((i) => i.key === HEALTH_KEY);
  const alarm = r.due.decisions[0];
  assert.equal(alarm.rule, 'crm_unread');
  assert.equal(alarm.tier, 'P0');
  assert.match(alarm.reason, /not been read for 31 min — twenty 401: the key was refused/);
  assert.doesNotMatch(alarm.note, /does not interrupt/, 'it is in the default interrupt set');
  // Still down a minute later: the same outage, not a second alarm.
  r = await tick(40);
  assert.equal(r.due?.decisions.length ?? 0, 0);
  assert.equal(decisions().filter((d) => d.rule === 'crm_unread').length, 1);
  // The CRM comes back: a complete read resolves the alarm, as the source.
  api.fail = null;
  r = await tick(41);
  assert.equal(r.ok, true);
  assert.ok(r.reconciled.resolved.includes(HEALTH_KEY));
  assert.equal(health().state, 'done');
  // A second outage is a second event, and reopens it.
  api.fail = 'schema';
  await tick(50);
  r = await tick(72);
  assert.equal(r.due.decisions[0].rule, 'crm_unread');
  assert.match(r.due.decisions[0].reason, /Cannot query field/);
  assert.equal(health().state, 'open');
});

test('a CRM that has never been read is timed from boot, and a network failure says so', async () => {
  const { api, tick, health } = boot({ staleMin: 5 });
  api.fail = 'down';
  await tick(1);
  assert.match(health.error, /not answering/);
  const r = await tick(6);
  assert.equal(r.due.decisions[0].rule, 'crm_unread');
});

test('a stale window of 0 turns the alarm off', () => {
  assert.equal(crm.due({ cursor: null, health: { startedAt: iso(-999) }, staleMs: 0, now: at(0) }), null);
});

// ---- the project seam and the layers -------------------------------------

test('per project, the interrupt is Alice\'s to silence: -crm:changed_on_my_task@acme quiets it for that company only', async () => {
  const { w, tick } = boot({ prefs: { projects: { acme: { interrupts: '-crm:changed_on_my_task' } } } });
  await tick(0);
  edit(w.tasks.find((x) => x.id === 'mine'), { body: 'y' }, BY.bobUi, at(1));
  const r = await tick(1);
  assert.equal(r.decisions[0].rule, 'changed_on_my_task');
  assert.match(r.decisions[0].note, /does not interrupt \(TRIAGE_PREFS projects\."acme"/);
});

test('isDue: a due moment is due all of its local day', () => {
  const now = new Date(2026, 9, 3, 9, 0);
  assert.equal(isDue(new Date(2026, 9, 3, 18, 0).toISOString(), now), true);
  assert.equal(isDue(new Date(2026, 9, 4, 9, 0).toISOString(), now), false);
  assert.equal(isDue(null, now), false);
});

// ---- config ----------------------------------------------------------------

test('config: unset is on only with a URL, a key and who Alice is; a typo is refused; the agents default to none', () => {
  const base = { TRIAGE_ENV: '/nonexistent/.env', TRIAGE_PREFS: '/nonexistent/prefs.json' };
  let c = loadConfig(base).crm;
  assert.equal(c.mode, null);
  assert.deepEqual(c.agents, [], 'no default: a key not named here is somebody else');
  assert.equal(c.staleMs, 30 * 60_000);
  c = loadConfig({ ...base, TWENTY_URL: 'https://crm.example.test/', TWENTY_API_KEY: 'k', TRIAGE_CRM_ME: `${ALICE}, alice@example.test`, TRIAGE_CRM_AGENTS: 'Agent key, Other key', TRIAGE_CRM_STALE_MIN: '15', TRIAGE_CRM_PROJECTS: 'Acme Corp=acme' }).crm;
  assert.equal(c.url, 'https://crm.example.test');
  assert.deepEqual(c.self, [ALICE, 'alice@example.test']);
  assert.deepEqual(c.agents, ['Agent key', 'Other key']);
  assert.equal(c.staleMs, 15 * 60_000);
  assert.deepEqual(c.projects, { 'Acme Corp': 'acme' });
  assert.deepEqual(loadConfig({ ...base, TRIAGE_CRM_AGENTS: '' }).crm.agents, [], 'an empty list says Alice has no agents');
  assert.throws(() => loadConfig({ ...base, TRIAGE_CRM: 'onn' }), /TRIAGE_CRM must be/);
  assert.throws(() => loadConfig({ ...base, TRIAGE_CRM_STALE_MIN: 'soon' }), /TRIAGE_CRM_STALE_MIN/);
  assert.throws(() => parseCrmProjects('Acme Corp'), /is not Company Name=project/);
});

test('a next page with no new cursor is a failed read, not a re-read from the top', async () => {
  const api = fakeTwenty();
  api.fetch = async () => ({ status: 200, text: async () => JSON.stringify({ data: { tasks: { pageInfo: { hasNextPage: true, endCursor: null }, edges: [] } } }) });
  await assert.rejects(api.tasks(), /gave no new cursor/);
});
