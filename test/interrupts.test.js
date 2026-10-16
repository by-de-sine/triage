// The interrupt set (M5, plan §11.6 and §11.9's last open call, decided by
// the owner on 2026-09-10): which rules, per source, may fire Slack. Under a
// ranking the tier no longer picks a channel, so the thing that decides
// whether something buzzes has to be the observation itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { SlackDelivery } from '../deliver/slack.js';
import { INTERRUPTS, parseInterrupts, interrupts } from '../deliver/interrupts.js';
import { ingest } from '../lib/pipeline.js';
import githubRules from '../rules/thread.js';
import calendarRules from '../rules/calendar.js';

const ME = 'alice';
const NOW = new Date('2026-09-10T12:00:00Z');

test("the set is the owner's answer: today's P0s plus new_invitation", () => {
  assert.deepEqual(INTERRUPTS, {
    github: ['reply_to_my_review_comment', 'reply_to_my_comment', 'direct_mention', 'review_requested', 'new_pull_request'],
    gitlab: ['reply_to_my_review_comment', 'reply_to_my_comment', 'direct_mention', 'review_requested', 'new_pull_request'],
    calendar: ['starts_in_15_min', 'new_invitation'],
    crm: ['handed_to_me', 'changed_on_my_task', 'crm_unread'],
  });
  // The CRM's: somebody waiting on the owner, and the read itself — not every
  // edit somebody else makes, and none of its ranking rules (rules/crm.js).
  assert.equal(interrupts(INTERRUPTS, 'crm', 'handed_to_me'), true);
  assert.equal(interrupts(INTERRUPTS, 'crm', 'changed_on_my_task'), true);
  assert.equal(interrupts(INTERRUPTS, 'crm', 'changed_what_i_wrote'), false);
  assert.equal(interrupts(INTERRUPTS, 'crm', 'changed_by_other'), false, 'a colleague working through their own tasks is the list, not Slack');
  assert.equal(interrupts(INTERRUPTS, 'crm', 'task_mine'), false);
  assert.equal(interrupts(INTERRUPTS, 'github', 'new_pull_request'), true);
  assert.equal(interrupts(INTERRUPTS, 'github', 'new_issue'), false);
  // A P1 rule is in the set and a P2 rule is not, which is the point: the
  // interrupt test is the rule, not the tier.
  assert.equal(calendarRules.find((r) => r.name === 'new_invitation').tier, 'P1');
  assert.equal(interrupts(INTERRUPTS, 'calendar', 'new_invitation'), true);
  assert.equal(interrupts(INTERRUPTS, 'calendar', 'day_ahead'), false);
  assert.equal(interrupts(INTERRUPTS, 'github', 'state_change_on_mine'), false, '34 of the 98 decisions on record');
  // A source nobody has thought about does not get to buzz.
  assert.equal(interrupts(INTERRUPTS, 'gmail', 'anything'), false);
});

test('the set is config: TRIAGE_INTERRUPT narrows it, off silences it', () => {
  assert.deepEqual(parseInterrupts(''), INTERRUPTS);
  assert.deepEqual(parseInterrupts('off'), {});
  assert.deepEqual(parseInterrupts('github:direct_mention, calendar:starts_in_15_min'), { github: ['direct_mention'], calendar: ['starts_in_15_min'] });
  // A source named with no rules interrupts on none of its own, which is how
  // a new and noisy source is muted without touching the others.
  assert.deepEqual(parseInterrupts('github'), { github: [] });
  assert.equal(interrupts(parseInterrupts('github'), 'github', 'direct_mention'), false);
});

test('a snooze wake keeps its own gate', () => {
  // You asked to be interrupted then; a wake that stayed silent because the
  // original rule was off the list would be the button not working.
  assert.equal(interrupts({}, 'github', 'snooze_wake'), true);
  // Nothing else bypasses the list: the LLM's `llm` row used to, and it is
  // gone with the model (plan §13.7).
  assert.equal(interrupts({}, 'github', 'llm'), false);
});

const fakeClient = () => { const calls = []; let n = 0; return { calls, chat: { postMessage: async (m) => { calls.push(m); return { ok: true, channel: 'D1', ts: `${++n}.0` }; }, update: async () => ({ ok: true }) } }; };

test('delivery refuses a rule that is not on the list, and says which rule', async () => {
  const store = new Store();
  const client = fakeClient();
  const d = new SlackDelivery(store, { userId: 'U1', client, tz: 'UTC', now: () => NOW });
  const { item } = store.upsertItem({ user: ME, source: 'github', key: 'o/r#1', kind: 'pull', title: 'merged', url: 'u', repo: 'o/r', last_activity: NOW.toISOString() });
  const no = await d.deliver({ item, decision: { id: 1, rule: 'state_change_on_mine', tier: 'P2', reason: 'your pull was merged' }, event: null });
  assert.equal(no.delivered, false);
  assert.match(no.note, /^not delivered: state_change_on_mine does not interrupt \(TRIAGE_INTERRUPT\)$/);
  assert.equal(client.calls.length, 0);
  const yes = await d.deliver({ item, decision: { id: 2, rule: 'direct_mention', tier: 'P0', reason: 'ann mentioned you' }, event: null });
  assert.equal(yes.delivered, true);
  store.close();
});

test('the pipeline interrupts on the rule, so a P1 invitation buzzes and a P2 does not', async () => {
  const store = new Store();
  const client = fakeClient();
  const d = new SlackDelivery(store, { userId: 'U1', client, tz: 'UTC', now: () => NOW, maxAgeMs: 0 });
  const start = new Date(NOW.getTime() + 8 * 3_600_000).toISOString();
  const batches = [
    { item: { key: 'inv', kind: 'event', title: 'Roadmap sync', url: 'u', repo: null, last_activity: NOW.toISOString(), data: { start, organizer: 'ann@example.com', guests: 2 } },
      events: [{ key: 'i1', ts: NOW.toISOString(), kind: 'invite', actor: 'ann@example.com', data: {} }] },
    { item: { key: 'brief', kind: 'event', title: 'Standup', url: 'u', repo: null, last_activity: NOW.toISOString(), data: { start, organizer: 'bob@example.com', guests: 4, response: 'accepted' } },
      events: [{ key: 'b1', ts: NOW.toISOString(), kind: 'update', actor: null, data: {} }] },
  ];
  const out = await ingest(store, { user: ME, source: 'calendar', batches }, { rules: calendarRules, deliver: d, now: NOW });
  const [inv, brief] = out.decisions;
  assert.equal(inv.rule, 'new_invitation');
  assert.equal(inv.tier, 'P1', 'a P1 — and it still interrupts, because the rule is on the list');
  assert.equal(inv.delivered, true);
  assert.match(inv.note, /^sent D1/);
  assert.equal(brief.rule, 'day_ahead');
  assert.equal(brief.delivered, false);
  // Placed, and the row says so: there is no digest for it to wait on, so
  // nothing is ever pending (plan §11.3, 2026-09-12).
  assert.equal(brief.note, 'not delivered: day_ahead does not interrupt (TRIAGE_INTERRUPT); it is in the list');
  assert.equal(client.calls.length, 1);
  assert.ok(store.decisions().every((d) => d.note !== null), 'every verdict is answered on the spot');
  store.close();
});

test('a P0 rule that is not on the list is placed, not sent', async () => {
  const store = new Store();
  const client = fakeClient();
  // the owner's narrower option, as config: only a direct mention buzzes.
  const d = new SlackDelivery(store, { userId: 'U1', client, tz: 'UTC', now: () => NOW, interrupts: parseInterrupts('github:direct_mention') });
  const batches = [{
    item: { key: 'o/r#1', kind: 'pull', title: 'a reply', url: 'u', repo: 'o/r', my_role: 'commented', last_activity: NOW.toISOString() },
    events: [
      { key: 'm1', ts: new Date(NOW.getTime() - 60_000).toISOString(), kind: 'comment', actor: ME, body: 'mine' },
      { key: 'a1', ts: NOW.toISOString(), kind: 'comment', actor: 'ann', body: 'after yours' },
    ],
  }];
  const out = await ingest(store, { user: ME, source: 'github', batches }, { rules: githubRules, deliver: d, now: NOW });
  assert.equal(out.decisions[0].tier, 'P0');
  assert.equal(out.decisions[0].delivered, false);
  assert.match(out.decisions[0].note, /reply_to_my_comment does not interrupt/);
  assert.equal(client.calls.length, 0);
  // It is a P0 on the item all the same: the tier survives as a category and
  // the item is at the top of the list (plan §11.8).
  assert.equal(store.itemByKey(ME, 'github', 'o/r#1').tier, 'P0');
  store.close();
});

test('describe() says what may interrupt, so the page and healthz can show it', () => {
  const store = new Store();
  const d = new SlackDelivery(store, { userId: 'U1', client: fakeClient() });
  assert.deepEqual(d.describe().interrupts, INTERRUPTS);
  store.close();
});

// ---------------------------------------------------------------------------
// The four layers (plan §14). What interrupts you is personal, and the thing
// the owner wanted to say the first time this system sent a real interrupt was
// neither global nor a rule name: *a human replying to me in
// acme is an interrupt*.

import { resolve, parseStatements, Interrupts, allows } from '../deliver/interrupts.js';

const SITE = 'acme/site';

test('out of the box: no file, no env, exactly the built-in set', () => {
  const r = resolve({});
  assert.deepEqual(r.set, INTERRUPTS);
  assert.equal(r.allows('github', 'reply_to_my_comment', SITE).allow, true);
  assert.equal(r.allows('github', 'state_change_on_mine', SITE).allow, false);
  // Somebody who has configured nothing pays nothing for the machinery, and
  // gets an answer that names where it came from.
  assert.match(r.allows('github', 'reply_to_my_comment').by, /the default set/);
  assert.equal(r.allows('github', 'state_change_on_mine').by, 'nothing on the interrupt list names it');
});

test('TRIAGE_INTERRUPT keeps its old meaning: an unsigned list replaces', () => {
  // This is load-bearing. The var is set on boxes; layering must not change
  // what any of them already say.
  const r = resolve({ env: 'github:direct_mention' });
  assert.equal(r.allows('github', 'direct_mention').allow, true);
  assert.equal(r.allows('github', 'reply_to_my_comment').allow, false);
  assert.equal(r.allows('calendar', 'starts_in_15_min').allow, false, 'a replacement replaces the whole set');
  assert.equal(resolve({ env: 'off' }).allows('github', 'direct_mention').allow, false);
  // A source named with no rules mutes that source — the pre-§14 spelling.
  assert.equal(resolve({ env: 'github' }).allows('github', 'direct_mention').allow, false);
});

test('a sign makes it a delta: you never restate the defaults to change one thing', () => {
  const r = resolve({ env: '+github:new_issue' });
  assert.equal(r.allows('github', 'new_issue').allow, true);
  assert.equal(r.allows('github', 'reply_to_my_comment').allow, true, 'the defaults are still underneath');
  assert.equal(r.allows('calendar', 'starts_in_15_min').allow, true);
  const off = resolve({ env: '-calendar:*' });
  assert.equal(off.allows('calendar', 'starts_in_15_min').allow, false);
  assert.equal(off.allows('github', 'reply_to_my_comment').allow, true);
});

test('layer 3: a project arms a rule nowhere else', () => {
  // The sentence that started this: in acme, a new issue is
  // an interrupt. Anywhere else it is not.
  const r = resolve({ prefs: { projects: { 'acme/*': { interrupts: { github: ['+new_issue'] } } } } });
  assert.equal(r.allows('github', 'new_issue', SITE).allow, true);
  assert.equal(r.allows('github', 'new_issue', 'someone/else').allow, false);
  assert.equal(r.allows('github', 'new_issue', null).allow, false, 'an item with no project matches no scoped statement');
  assert.match(r.allows('github', 'new_issue', SITE).by, /projects."acme\/\*"/);
  // And the effective *global* set is untouched by a scoped statement.
  assert.deepEqual(r.set, INTERRUPTS);
});

test('a project can be silenced whole, default P0s included', () => {
  const r = resolve({ prefs: { projects: { 'alice/scratch': { interrupts: 'off' } } } });
  assert.equal(r.allows('github', 'reply_to_my_comment', 'alice/scratch').allow, false);
  assert.equal(r.allows('github', 'reply_to_my_comment', 'alice/real').allow, true);
  // …and armed whole, for the repo that is on fire.
  const on = resolve({ prefs: { projects: { 'o/onfire': { interrupts: 'all' } } } });
  assert.equal(on.allows('github', 'bot_only', 'o/onfire').allow, true);
  assert.equal(on.allows('github', 'bot_only', 'o/quiet').allow, false);
});

test('the resolution rule, stated once: highest layer wins, then most specific', () => {
  // The env beats the file even when the file is more specific, because
  // typing it is what "silence this now" means.
  const r = resolve({ prefs: { projects: { [SITE]: { interrupts: { github: ['+new_issue'] } } } }, env: '-github:*' });
  assert.equal(r.allows('github', 'new_issue', SITE).allow, false);
  assert.equal(r.allows('github', 'new_issue', SITE).by, 'TRIAGE_INTERRUPT: -github:*');
  // Within one layer, the more specific scope wins: everything off in this
  // repo, even though new_issue is armed everywhere.
  const same = resolve({ env: '+github:new_issue, -github:*@alice/scratch' });
  assert.equal(same.allows('github', 'new_issue', 'alice/elsewhere').allow, true);
  assert.equal(same.allows('github', 'new_issue', 'alice/scratch').allow, false);
});

test("a source's own list in the file replaces only that source", () => {
  const r = resolve({ prefs: { interrupts: { github: ['direct_mention'] } } });
  assert.equal(r.allows('github', 'direct_mention').allow, true);
  assert.equal(r.allows('github', 'reply_to_my_comment').allow, false);
  assert.equal(r.allows('calendar', 'starts_in_15_min').allow, true, 'the calendar was not mentioned and must not be swept');
  assert.deepEqual(r.set, { github: ['direct_mention'], gitlab: ['reply_to_my_review_comment', 'reply_to_my_comment', 'direct_mention', 'review_requested', 'new_pull_request'], calendar: ['starts_in_15_min', 'new_invitation'], crm: ['handed_to_me', 'changed_on_my_task', 'crm_unread'] });
});

test('a wake still bypasses every layer, however hard they say no', () => {
  const r = resolve({ prefs: { projects: { 'alice/scratch': { interrupts: 'off' } } }, env: 'off' });
  assert.equal(r.allows('github', 'snooze_wake', 'alice/scratch').allow, true);
  assert.match(r.allows('github', 'snooze_wake').by, /you asked to be interrupted then/);
});

test('describe() is the configuration explaining itself (plan §14.6)', () => {
  const r = resolve({ prefs: { projects: { [SITE]: { interrupts: { github: ['+new_issue'] } } } }, env: '-calendar:*' });
  const d = r.describe();
  assert.deepEqual(d.layers.map((l) => l.layer), ['default', 'prefs-project', 'env']);
  assert.equal(d.layers.at(-1).statements[0].text, '-calendar:*');
  assert.deepEqual(d.always, ['snooze_wake']);
  assert.ok(d.set.github.includes('reply_to_my_comment'));
});

test('the legacy plain map still answers, so nothing that passes one breaks', () => {
  assert.equal(interrupts(INTERRUPTS, 'github', 'direct_mention', 'any/repo'), true);
  assert.deepEqual(allows(INTERRUPTS, 'github', 'bot_only'), { allow: false, by: 'TRIAGE_INTERRUPT' });
  assert.equal(new Interrupts([]).allows('github', 'anything').allow, false);
  assert.deepEqual(parseStatements(''), []);
});

// --- the seam: delivery asks the source what a project is ------------------

test('the project comes from the source, and nothing in deliver/ knows what one is', async () => {
  const store = new Store();
  const client = fakeClient();
  const d = new SlackDelivery(store, {
    userId: 'U1', client, tz: 'UTC', now: () => NOW, maxAgeMs: 0,
    projects: { github: (item) => item.repo || null },
    interrupts: resolve({ prefs: { projects: { 'alice/scratch': { interrupts: 'off' } } } }),
  });
  const mk = (repo) => store.upsertItem({ user: ME, source: 'github', key: `${repo}#1`, kind: 'pull', title: 'a reply', url: 'u', repo, last_activity: NOW.toISOString() }).item;
  const decision = { id: 1, rule: 'reply_to_my_comment', tier: 'P0', reason: 'ann replied' };

  const quiet = await d.deliver({ item: mk('alice/scratch'), decision, event: null });
  assert.equal(quiet.delivered, false);
  assert.match(quiet.note, /reply_to_my_comment does not interrupt \(TRIAGE_PREFS projects\."alice\/scratch": -\*:\*@alice\/scratch\)/,
    'the note names the statement that decided it, not just the env var');
  assert.equal(client.calls.length, 0);

  const loud = await d.deliver({ item: mk('alice/real'), decision: { ...decision, id: 2 }, event: null });
  assert.equal(loud.delivered, true);
  assert.equal(d.projectOf(mk('alice/real'), 'github'), 'alice/real');
  // A source that declares no project is not a special case: it simply has
  // no scope, and the unscoped layers still apply.
  assert.equal(d.projectOf({ source: 'ledger' }, 'ledger'), null);
  assert.equal(d.interrupts('ledger', 'waiting_on_you', { source: 'ledger' }), false);
  store.close();
});

test('the pipeline scopes by project too, so the list says which repo decided it', async () => {
  const store = new Store();
  const client = fakeClient();
  const d = new SlackDelivery(store, {
    userId: 'U1', client, tz: 'UTC', now: () => NOW, maxAgeMs: 0,
    projects: { github: (item) => item.repo || null },
    interrupts: resolve({ prefs: { projects: { 'noisy/repo': { interrupts: 'off' } } } }),
  });
  const thread = (repo) => ({
    item: { key: `${repo}#1`, kind: 'pull', title: 'a reply', url: 'u', repo, my_role: 'commented', last_activity: NOW.toISOString() },
    events: [
      { key: `${repo}-m1`, ts: new Date(NOW.getTime() - 60_000).toISOString(), kind: 'comment', actor: ME, body: 'mine' },
      { key: `${repo}-a1`, ts: NOW.toISOString(), kind: 'comment', actor: 'ann', body: 'after yours' },
    ],
  });
  const out = await ingest(store, { user: ME, source: 'github', batches: [thread('noisy/repo'), thread('good/repo')] }, { rules: githubRules, deliver: d, now: NOW });
  const [noisy, good] = out.decisions;
  assert.equal(noisy.tier, 'P0');
  assert.equal(noisy.delivered, false);
  assert.match(noisy.note, /does not interrupt \(TRIAGE_PREFS projects\."noisy\/repo".*\); it is in the list/);
  assert.equal(good.delivered, true);
  assert.equal(client.calls.length, 1);
  store.close();
});

test('a statement nobody can parse is refused, not skipped', () => {
  // The failure this prevents: `TRIAGE_INTERRUPT=github new_issue` — a space
  // where the colon goes — booting with a quietly different set, which you
  // find out about by not being interrupted. Same rule as TRIAGE_SLACK=appp.
  assert.throws(() => resolve({ env: 'github new_issue' }), /is not \[\+\|-\]source:rule\[@project\]/);
  assert.throws(() => resolve({ env: '+github:new_issue, @bad' }), /TRIAGE_INTERRUPT/);
  assert.throws(() => resolve({ prefs: { interrupts: { github: ['not a rule'] } } }), /TRIAGE_PREFS/);
  // What must keep working: nothing at all, the two shorthands, a bare
  // source, a scope, and every signed form.
  for (const spec of ['', 'off', 'all', 'github', 'github:direct_mention', '+github:new_issue@o/*', '-*:*', '+calendar:starts_in_15_min']) {
    assert.doesNotThrow(() => resolve({ env: spec }), spec);
  }
});

test('the effective set does not hide a rule armed across every source', () => {
  // `allows()` applies `+*:new_issue` to github, so the map the boot log and
  // /healthz print has to say so too, or the two disagree about the truth.
  const r = resolve({ env: '+*:new_issue' });
  assert.equal(r.allows('github', 'new_issue').allow, true);
  assert.equal(r.allows('calendar', 'new_issue').allow, true);
  assert.ok(r.set.github.includes('new_issue'), JSON.stringify(r.set));
  assert.ok(r.set.calendar.includes('new_issue'), JSON.stringify(r.set));
  // And a source armed wholesale still reads as `*` rather than a made-up list.
  assert.deepEqual(resolve({ prefs: { interrupts: { github: 'all' } } }).set.github, ['*']);
  // Folding it into the named sources is only most of the truth: a source no
  // statement mentions — the ledger, and anything added tomorrow — is armed
  // by it too, and this map has no register of sources to enumerate. So the
  // wildcard gets a row of its own rather than being quietly dropped.
  assert.deepEqual(r.set['*'], ['new_issue']);
  assert.equal(r.allows('gmail', 'new_issue').allow, true, 'including a source nothing else names');
  // Nothing configured, nothing invented: the default set has no wildcards.
  assert.equal(resolve({}).set['*'], undefined);
  assert.deepEqual(resolve({}).set, INTERRUPTS);
});
