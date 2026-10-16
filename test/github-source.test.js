import { test } from 'node:test';
import assert from 'node:assert/strict';
import github, { itemKey } from '../sources/github.js';
import { fakeApi, notification, pull, issue, comment, reviewComment, review } from './fake-github.js';

const ME = 'alice';

function routes() {
  return {
    '/notifications': [
      notification({ id: 1, repo: 'o/r', number: 1, title: 'A PR', reason: 'author', updated_at: '2026-09-02T00:00:00Z' }),
      notification({ id: 2, repo: 'o/r', type: 'Issue', number: 2, title: 'An issue', reason: 'mention', updated_at: '2026-09-02T01:00:00Z' }),
      { id: '3', unread: true, reason: 'subscribed', updated_at: '2026-09-02T02:00:00Z', subject: { title: 'v1.0', url: 'https://api.github.com/repos/o/r/releases/9', type: 'Release' }, repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' } },
    ],
    '/repos/o/r/pulls/1': pull({ repo: 'o/r', number: 1, title: 'A PR', author: ME, created_at: '2026-09-01T00:00:00Z' }),
    '/repos/o/r/issues/1/comments': [comment(11, 'ann', '2026-09-01T10:00:00Z', 'looks off'), comment(12, ME, '2026-09-01T11:00:00Z', 'fixed')],
    '/repos/o/r/pulls/1/comments': [reviewComment(21, 'ann', '2026-09-01T12:00:00Z', 'nit')],
    '/repos/o/r/pulls/1/reviews': [review(31, 'ann', '2026-09-01T12:00:01Z', 'COMMENTED', ''), review(32, 'bob', '2026-09-02T00:00:00Z', 'APPROVED', 'ship it')],
    '/repos/o/r/issues/2': issue({ repo: 'o/r', number: 2, title: 'An issue', author: 'ann', created_at: '2026-09-02T00:30:00Z' }),
    '/repos/o/r/issues/2/comments': [comment(13, 'ann', '2026-09-02T01:00:00Z', '@alice thoughts?', 'o/r', 2)],
  };
}

test('itemKey is repo#number for issues and PRs, and typed otherwise', () => {
  assert.equal(itemKey(notification({ id: 1, repo: 'o/r', number: 7, title: 't', updated_at: 'x' })), 'o/r#7');
  assert.equal(itemKey({ id: '3', subject: { type: 'Release', url: 'https://api.github.com/repos/o/r/releases/9' }, repository: { full_name: 'o/r' } }), 'o/r@release:9');
});

test('first poll reads every thread and emits its full history as events', async () => {
  const api = fakeApi(routes());
  const r = await github.poll({ api, cursor: null, me: ME, now: new Date('2026-09-02T03:00:00Z') });
  assert.equal(r.every, 60_000);
  assert.equal(r.batches.length, 3);
  const pr = r.batches[0];
  assert.equal(pr.item.key, 'o/r#1');
  assert.equal(pr.item.kind, 'pull');
  assert.equal(pr.item.my_role, 'authored');
  assert.equal(pr.item.url, 'https://github.com/o/r/pull/1');
  assert.deepEqual(pr.item.actors.sort(), ['alice', 'ann', 'bob']);
  const kinds = pr.events.map((e) => `${e.kind}:${e.actor ?? '-'}`);
  assert.deepEqual(kinds, ['notification:-', 'opened:alice', 'comment:ann', 'comment:alice', 'review_comment:ann', 'review:bob']);
  assert.equal(pr.events.find((e) => e.kind === 'review_comment').data.in_reply_to_id, null);
  assert.equal(pr.item.last_activity, '2026-09-02T00:00:00Z');
  const is = r.batches[1];
  assert.equal(is.item.kind, 'issue');
  assert.equal(is.item.my_role, 'mentioned');
  assert.equal(is.item.url, 'https://github.com/o/r/issues/2');
  assert.equal(is.events.at(-1).body, '@alice thoughts?');
  const rel = r.batches[2];
  assert.equal(rel.item.kind, 'release');
  assert.equal(rel.events.length, 1);
  assert.equal(r.cursor.threads['1'].updated_at, '2026-09-02T00:00:00Z');
  assert.ok(r.cursor.last_modified);
});

test('a second poll is a 304 and costs one call; an unchanged thread costs none', async () => {
  const api = fakeApi(routes());
  const first = await github.poll({ api, cursor: null, me: ME });
  api.calls.length = 0;
  const second = await github.poll({ api, cursor: first.cursor, me: ME });
  assert.equal(second.status, 'not modified');
  assert.equal(second.batches.length, 0);
  assert.equal(api.calls.length, 1);
  // The inbox moved but no thread did: every thread is skipped by updated_at.
  const rt = routes(); rt.lastModified = 'Tue, 02 Sep 2026 00:00:00 GMT';
  const api2 = fakeApi(rt);
  const third = await github.poll({ api: api2, cursor: first.cursor, me: ME });
  assert.equal(third.batches.length, 0);
  assert.equal(api2.calls.length, 1);
  assert.match(third.status, /3 unchanged/);
});

test('a moved thread fetches only what is newer than the cursor', async () => {
  const api = fakeApi(routes());
  const first = await github.poll({ api, cursor: null, me: ME });
  const rt = routes();
  rt.lastModified = 'Tue, 02 Sep 2026 05:00:00 GMT';
  rt['/notifications'][0].updated_at = '2026-09-02T05:00:00Z';
  rt['/repos/o/r/issues/1/comments?since=2026-09-02T00:00:00Z'] = [comment(14, 'ann', '2026-09-02T05:00:00Z', 'and another thing')];
  rt['/repos/o/r/pulls/1/comments?since=2026-09-02T00:00:00Z'] = [];
  rt['/repos/o/r/pulls/1/reviews'].push(review(33, 'ann', '2026-09-02T04:59:00Z', 'CHANGES_REQUESTED', 'no'));
  const api2 = fakeApi(rt);
  const r = await github.poll({ api: api2, cursor: first.cursor, me: ME });
  assert.equal(r.batches.length, 1);
  const kinds = r.batches[0].events.map((e) => `${e.kind}:${e.actor ?? '-'}`);
  assert.deepEqual(kinds, ['notification:-', 'comment:ann', 'review:ann']);
  assert.equal(r.batches[0].item.last_seen, '2026-09-02T05:00:00Z');
});

test('an inbox past one page is followed through rel=next', async () => {
  const rt = routes();
  const page2 = [notification({ id: 9, repo: 'o/r', number: 9, title: 'Late', reason: 'author', updated_at: '2026-09-02T03:00:00Z' })];
  rt['/repos/o/r/pulls/9'] = pull({ repo: 'o/r', number: 9, title: 'Late', author: ME, created_at: '2026-09-01T00:00:00Z' });
  rt['/repos/o/r/issues/9/comments'] = []; rt['/repos/o/r/pulls/9/comments'] = []; rt['/repos/o/r/pulls/9/reviews'] = [];
  rt.pages = { 'https://api.github.com/notifications?page=2': page2 };
  const r = await github.poll({ api: fakeApi(rt), cursor: null, me: ME });
  assert.equal(r.batches.length, 4);
  assert.equal(r.batches[3].item.key, 'o/r#9');
});

test('an inbox past the page cap is read partially and Last-Modified stays put', async () => {
  const rt = routes();
  rt.pages = {};
  for (let i = 2; i <= 22; i++) rt.pages[`https://api.github.com/notifications?page=${i}`] = [];
  rt.chain = true;
  const logs = [];
  const r = await github.poll({ api: fakeApi(rt), cursor: { last_modified: 'Sun, 31 Aug 2026 00:00:00 GMT', threads: {} }, me: ME, log: (m) => logs.push(m) });
  assert.equal(r.batches.length, 3);
  assert.equal(r.cursor.last_modified, 'Sun, 31 Aug 2026 00:00:00 GMT');
  assert.match(logs.at(-1), /Last-Modified not advanced/);
});

test('a review request for me is an event, and a merge is a state event', async () => {
  const rt = routes();
  rt['/notifications'] = [notification({ id: 5, repo: 'o/r', number: 5, title: 'Review me', reason: 'review_requested', updated_at: '2026-09-02T00:00:00Z' }),
    notification({ id: 6, repo: 'o/r', number: 6, title: 'Merged', reason: 'state_change', updated_at: '2026-09-02T00:00:00Z' })];
  rt['/repos/o/r/pulls/5'] = pull({ repo: 'o/r', number: 5, title: 'Review me', author: 'ann', created_at: '2026-09-01T00:00:00Z', requested_reviewers: [ME] });
  rt['/repos/o/r/pulls/6'] = pull({ repo: 'o/r', number: 6, title: 'Merged', author: ME, created_at: '2026-09-01T00:00:00Z', state: 'closed', merged_at: '2026-09-02T00:00:00Z', closed_at: '2026-09-02T00:00:00Z' });
  for (const n of [5, 6]) { rt[`/repos/o/r/issues/${n}/comments`] = []; rt[`/repos/o/r/pulls/${n}/comments`] = []; rt[`/repos/o/r/pulls/${n}/reviews`] = []; }
  const r = await github.poll({ api: fakeApi(rt), cursor: null, me: ME });
  const a = r.batches[0];
  assert.equal(a.item.my_role, 'review_requested');
  assert.ok(a.events.some((e) => e.kind === 'review_request' && e.actor === 'ann' && e.data.by_bot === false));
  const b = r.batches[1];
  assert.equal(b.item.data.state, 'merged');
  assert.ok(b.events.some((e) => e.kind === 'state' && e.data.state === 'merged'));
});

test('a thread that fails to fetch is logged and left for the next poll', async () => {
  const rt = routes();
  delete rt['/repos/o/r/issues/2'];
  const logs = [];
  const r = await github.poll({ api: fakeApi(rt), cursor: null, me: ME, log: (m) => logs.push(m) });
  assert.equal(r.batches.length, 2);
  assert.equal(r.cursor.threads['2'], undefined);
  assert.match(logs[0], /An issue: GitHub 404/);
});

// ---- Issues as state (plan §12.3 item 2) -----------------------------------
// The inbox carries no issues; the open set of each watched repository is
// read whole, once per cadence, and reconciled. Everything below runs the
// real source against the fake API, and the last two run it through the
// runner so `reconcile` is exercised end to end.
import { Store } from '../lib/store.js';
import { Runner } from '../lib/runner.js';
import { Ranker } from '../lib/rank.js';
import { createActor } from '../lib/actions.js';
import rules from '../rules/github.js';
import { openList } from './fake-github.js';

const T0 = new Date('2026-09-02T03:00:00Z');
const ISSUES = { repos: ['o/r', 'o/other'], everyMs: 5 * 60_000 };
function withIssues(rt = routes()) {
  rt['/repos/o/r/issues'] = openList(
    { repo: 'o/r', number: 2, title: 'An issue', author: 'ann', created_at: '2026-09-02T00:30:00Z', updated_at: '2026-09-02T01:00:00Z', comments: 1 },
    { repo: 'o/r', number: 40, title: 'Mine, assigned', author: 'ann', created_at: '2026-08-01T00:00:00Z', assignees: [ME], labels: ['bug'] },
    { repo: 'o/r', number: 41, title: 'Filed by an agent as me', author: ME, created_at: '2026-08-15T00:00:00Z' },
    { repo: 'o/r', number: 1, kind: 'pull', title: 'A PR', author: ME, created_at: '2026-09-01T00:00:00Z' },
  );
  rt['/repos/o/other/issues'] = openList({ repo: 'o/other', number: 7, title: 'Elsewhere', author: 'bob', created_at: '2026-07-01T00:00:00Z' });
  return rt;
}

test('the open set: each issue is an item in the state mode, pull requests are skipped, and the inbox thread behind a key is remembered', async () => {
  const api = fakeApi(withIssues());
  const r = await github.poll({ api, cursor: null, me: ME, now: T0, issues: ISSUES });
  const state = r.batches.filter((b) => b.item.data.mode === 'open' && !b.item.data.reason);   // the state half's; the inbox's carry a reason
  assert.deepEqual(state.map((b) => b.item.key), ['o/r#2', 'o/r#40', 'o/r#41', 'o/other#7'], 'four open issues; the pull request in the list is not one');
  const mine = state.find((b) => b.item.key === 'o/r#40');
  assert.equal(mine.item.kind, 'issue'); assert.equal(mine.item.my_role, 'assigned'); assert.equal(mine.item.url, 'https://github.com/o/r/issues/40');
  assert.deepEqual(mine.item.data.assignees, [ME]); assert.deepEqual(mine.item.data.labels, ['bug']); assert.equal(mine.item.data.state, 'open'); assert.equal(mine.item.data.author, 'ann');
  assert.deepEqual(mine.events.map((e) => e.kind), ['opened', 'open'], 'first sight: opened (the inbox\'s key), then the state tick');
  assert.equal(mine.events[0].key, 'github:opened:o/r#40'); assert.equal(mine.events[1].key, 'github:open:o/r#40:2026-08-01T00:00:00Z');
  assert.equal(state.find((b) => b.item.key === 'o/r#41').item.my_role, 'authored');
  // The inbox brought o/r#2 too: written in the state mode's shape, with what only the inbox knows kept.
  const fromInbox = r.batches.filter((b) => b.item.key === 'o/r#2');
  assert.equal(fromInbox.length, 2, 'once from each half');
  const inboxOne = fromInbox.find((b) => b.item.data.thread_id);
  assert.equal(inboxOne.item.data.mode, 'open', 'the inbox knows the open set governs it');
  assert.deepEqual(inboxOne.item.data.assignees, []);
  assert.equal(inboxOne.item.data.reason, 'mention');
  assert.deepEqual(r.cursor.issues, { read_at: T0.toISOString(), repos: ['o/r', 'o/other'], open: ['o/r#2', 'o/r#40', 'o/r#41', 'o/other#7'], complete: true, error: null });
  assert.equal(r.cursor.threads['2'].key, 'o/r#2');
  assert.match(r.status, /4 open issues in 2 of 2 repos$/);
  assert.deepEqual(github.describeCursor(r.cursor).issues, { repos: 2, open: 4, complete: true, read_at: T0.toISOString() });
  // A second read knows the thread: the state write carries thread_id so Done can still mark it read.
  const again = await github.poll({ api, cursor: r.cursor, me: ME, now: new Date(T0.getTime() + 6 * 60_000), issues: ISSUES });
  const two = again.batches.find((b) => b.item.key === 'o/r#2' && !b.item.data.reason);
  assert.equal(two.item.data.thread_id, '2');
  assert.equal(two.item.data.mode, 'open');
  assert.deepEqual(two.events.map((e) => e.kind), ['open'], 'not first sight any more');
});

test('the open set is read once per cadence, or when the list changes, and stays in the cursor through a 304', async () => {
  const api = fakeApi(withIssues());
  const first = await github.poll({ api, cursor: null, me: ME, now: T0, issues: ISSUES });
  api.calls.length = 0;
  const soon = await github.poll({ api, cursor: first.cursor, me: ME, now: new Date(T0.getTime() + 60_000), issues: ISSUES });
  assert.equal(api.calls.length, 1, 'the inbox\'s conditional call only');
  assert.deepEqual(soon.cursor.issues, first.cursor.issues, 'the set stands between reads');
  assert.match(soon.status, /not modified; open set of 2 repos not due/);
  const later = await github.poll({ api, cursor: first.cursor, me: ME, now: new Date(T0.getTime() + 5 * 60_000), issues: ISSUES });
  assert.ok(api.calls.some((u) => /\/repos\/o\/r\/issues\?/.test(u)), 'due: read again');
  assert.equal(later.cursor.issues.read_at, new Date(T0.getTime() + 5 * 60_000).toISOString());
  api.calls.length = 0;
  const changed = await github.poll({ api, cursor: first.cursor, me: ME, now: new Date(T0.getTime() + 60_000), issues: { repos: ['o/r'], everyMs: ISSUES.everyMs } });
  assert.ok(api.calls.some((u) => /\/repos\/o\/r\/issues\?/.test(u)), 'a different list is read now, not at the cadence');
  assert.deepEqual(changed.cursor.issues.repos, ['o/r']);
  // Off: the cursor drops the set, so nothing is reconciled against later.
  const off = await github.poll({ api, cursor: first.cursor, me: ME, now: T0 });
  assert.equal(off.cursor.issues, undefined);
  assert.equal(github.reconcile({ cursor: off.cursor, issues: ISSUES }), null, 'nothing read: nothing to say');
  assert.equal(github.reconcile({ cursor: first.cursor }), null, 'not configured: nothing to say');
});

test('a repository that cannot be read whole makes the set incomplete; what was read is still ingested', async () => {
  const rt = withIssues(); delete rt['/repos/o/other/issues'];
  const logs = [];
  const r = await github.poll({ api: fakeApi(rt), cursor: null, me: ME, now: T0, log: (m) => logs.push(m), issues: ISSUES });
  assert.equal(r.cursor.issues.complete, false);
  assert.match(r.cursor.issues.error, /o\/other: GitHub 404/);
  assert.deepEqual(r.cursor.issues.open, ['o/r#2', 'o/r#40', 'o/r#41']);
  assert.match(r.status, /3 open issues in 1 of 2 repos \(incomplete\)/);
  const set = github.reconcile({ cursor: r.cursor, issues: ISSUES });
  assert.equal(set.complete, false);
  assert.match(set.error, /o\/other/);
  // And the set answers for the state mode's issues in watched repositories, nothing else.
  assert.equal(set.governs({ kind: 'issue', repo: 'o/r', data: { mode: 'open' } }), true);
  assert.equal(set.governs({ kind: 'issue', repo: 'O/R', data: { mode: 'open' } }), true, 'repository names are case-insensitive');
  assert.equal(set.governs({ kind: 'pull', repo: 'o/r', data: { mode: 'open' } }), false);
  assert.equal(set.governs({ kind: 'issue', repo: 'o/r', data: { thread_id: '9' } }), false, 'the inbox\'s issue, never in the set');
  assert.equal(set.governs({ kind: 'issue', repo: 'x/unwatched', data: { mode: 'open' } }), false, 'a repository no longer on the list is left alone');
  const stale = github.reconcile({ cursor: r.cursor, issues: { repos: ['o/r'] } });
  assert.equal(stale.complete, false); assert.match(stale.error, /list changed/);
});

function boot(rt, issues = ISSUES) {
  const store = new Store();
  const rank = new Ranker({ shapes: { github: github.time }, now: () => T0 });
  const logs = [];
  const api = fakeApi(rt);
  const runner = new Runner(store, [github], { user: ME, rules: { github: rules }, rank, extras: { github: { api, issues } }, log: (m) => logs.push(m) });
  let now = T0;
  runner.now = () => now;
  return { store, runner, logs, api, tick: (min) => { now = new Date(now.getTime() + min * 60_000); } };
}

test('through the runner: the state rules tier the open set, and a closed issue is resolved by the source — a reopened one comes back, an inbox pull request is never touched', async () => {
  const rt = withIssues();
  const { store, runner, logs, tick } = boot(rt);
  let r = await runner.run('github');
  assert.equal(r.ok, true);
  assert.deepEqual(r.reconciled, { resolved: [], reopened: [], complete: true });
  const mine = store.itemByKey(ME, 'github', 'o/r#40'), agent = store.itemByKey(ME, 'github', 'o/r#41'), pr = store.itemByKey(ME, 'github', 'o/r#1');
  assert.equal(store.lastDecision(mine.id).rule, 'issue_assigned_to_me');
  assert.equal(store.lastDecision(agent.id).rule, 'my_open_issue', 'an agent-filed issue is no longer own_activity');
  assert.equal(pr.data.mode, undefined, 'the inbox\'s pull request is not in the state mode');
  assert.equal(store.itemByKey(ME, 'github', 'o/r#2').data.mode, 'open', 'the inbox\'s issue is, because the open set has it');
  // Nothing moved: the next read within the cadence changes nothing.
  tick(1); r = await runner.run('github');
  assert.deepEqual([r.items, r.events, r.decisions.length], [0, 0, 0]);
  // ann closes #40 on GitHub, and the inbox says so in the same poll the
  // open set drops it: the inbox's write must not take the mode off the
  // item, or reconcile — which runs after — would not speak for it.
  tick(5);
  rt['/repos/o/r/issues'] = rt['/repos/o/r/issues'].filter((i) => i.number !== 40);
  rt.lastModified = 'Tue, 02 Sep 2026 03:10:00 GMT';
  rt['/notifications'].push(notification({ id: 40, repo: 'o/r', type: 'Issue', number: 40, title: 'Mine, assigned', reason: 'assign', updated_at: '2026-09-02T03:09:00Z' }));
  rt['/repos/o/r/issues/40'] = { ...issue({ repo: 'o/r', number: 40, title: 'Mine, assigned', author: 'ann', created_at: '2026-08-01T00:00:00Z', assignees: [ME], state: 'closed', closed_at: '2026-09-02T03:09:00Z' }) };
  rt['/repos/o/r/issues/40/comments'] = [];
  r = await runner.run('github');
  assert.deepEqual(r.reconciled.resolved, ['o/r#40']);
  assert.equal(store.item(mine.id).state, 'done');
  assert.equal(store.item(mine.id).data.state, 'closed'); assert.equal(store.item(mine.id).data.mode, 'open', 'the inbox wrote it, and kept the mode');
  assert.equal(store.item(mine.id).data.thread_id, '40');
  const act = store.actionsFor(mine.id).at(-1);
  assert.equal(act.action, 'resolved'); assert.equal(act.by, 'source:github');
  assert.equal(store.item(pr.id).state, 'open', 'absent from a set it was never in is not gone');
  assert.equal(store.item(agent.id).state, 'open');
  assert.ok(logs.some((m) => /reconcile: 1 resolved/.test(m)));
  // Reopened on GitHub: back in the set, back in the list.
  tick(5);
  rt['/repos/o/r/issues'] = withIssues()['/repos/o/r/issues'];
  r = await runner.run('github');
  assert.deepEqual(r.reconciled.reopened, ['o/r#40']);
  assert.equal(store.item(mine.id).state, 'open');
  // your own Done stands while the issue is still open on GitHub.
  const act2 = createActor({ store, now: () => T0 });
  const done = await act2({ id: agent.id, action: 'done', by: 'web' });
  assert.match(done.external || done.note || JSON.stringify(done), /not marked read: no thread id/, 'no inbox thread behind it, and it says so');
  tick(5); r = await runner.run('github');
  assert.deepEqual(r.reconciled, { resolved: [], reopened: [], complete: true });
  assert.equal(store.item(agent.id).state, 'done');
  // A read that fails resolves nothing, and the list is not emptied.
  tick(5); delete rt['/repos/o/r/issues'];
  r = await runner.run('github');
  assert.equal(r.ok, true, 'the inbox still polled');
  assert.equal(r.reconciled.complete, false);
  assert.equal(store.item(mine.id).state, 'open');
  assert.ok(logs.some((m) => /reconcile skipped — incomplete read \(o\/r: GitHub 404/.test(m)));
});

test('the key is spelled the way GitHub spells the repository, whatever the .env typed', async () => {
  const rt = withIssues(); rt['/repos/O/R/issues'] = rt['/repos/o/r/issues'];   // GitHub answers either spelling; the fake does not
  const api = fakeApi(rt);
  const r = await github.poll({ api, cursor: null, me: 'ALICE', now: T0, issues: { repos: ['O/R'], everyMs: 0 } });
  const state = r.batches.filter((b) => b.item.data.mode === 'open' && !b.item.data.reason);
  assert.deepEqual(state.map((b) => b.item.key), ['o/r#2', 'o/r#40', 'o/r#41'], 'from repository_url, so the inbox\'s o/r#2 and this one are one row');
  assert.equal(state[0].item.repo, 'o/r');
  assert.equal(state.find((b) => b.item.key === 'o/r#41').item.my_role, 'authored', 'and the login compares in any case');
  assert.equal(state.find((b) => b.item.key === 'o/r#40').item.my_role, 'assigned');
  assert.ok(api.calls.filter((u) => /\/repos\/O\/R\/issues/.test(u)).length === 1, 'read once, as configured');
  const set = github.reconcile({ cursor: r.cursor, issues: { repos: ['O/R'] } });
  assert.equal(set.governs({ kind: 'issue', repo: 'o/r', data: { mode: 'open' } }), true);
});

test('through the runner: with no repositories the source is the inbox alone, and reconcile says nothing', async () => {
  const { store, runner, logs } = boot(routes(), { repos: [], everyMs: 0 });
  const r = await runner.run('github');
  assert.equal(r.ok, true);
  assert.equal(r.reconciled, undefined);
  assert.equal(store.items({ user: ME, source: 'github' }).length, 3);
  assert.ok(!logs.some((m) => /reconcile/.test(m)));
});
