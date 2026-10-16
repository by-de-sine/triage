import { test } from 'node:test';
import assert from 'node:assert/strict';
import gitlab, { systemNote, keyOf } from '../sources/gitlab.js';
import { fakeApi, mr, issue, todo, note, discussion, demoGitlab } from './fake-gitlab.js';
import { Store } from '../lib/store.js';
import { Runner } from '../lib/runner.js';
import rules from '../rules/thread.js';

const ME = 'alice';
const NOW = new Date('2026-09-02T00:00:00Z');
const P = 'acme/platform';

function world() {
  const m7 = mr({ path: P, iid: 7, title: 'Worker', author: 'bob', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T03:00:00Z', reviewers: [ME] });
  const m9 = mr({ path: P, iid: 9, title: 'Cache', author: ME, created_at: '2026-08-30T00:00:00Z', updated_at: '2026-09-01T04:00:00Z' });
  return {
    m7, m9,
    routes: {
      '/todos': [todo({ id: 501, path: P, target: m7, action: 'review_requested', author: 'bob', created_at: '2026-09-01T03:00:00Z' })],
      '/merge_requests': (u) => (u.searchParams.get('author_username') === ME ? [m9] : u.searchParams.get('reviewer_username') === ME ? [m7] : []),
      '/issues': () => [],
      [`/projects/${P}/merge_requests/7/discussions`]: [discussion(note(801, 'bob', '2026-09-01T03:00:00Z', 'requested review from @alice', { system: true }))],
      [`/projects/${P}/merge_requests/9/discussions`]: [
        discussion(note(811, ME, '2026-08-31T00:00:00Z', 'TTL?', { diff: true }), note(812, 'carol', '2026-09-01T04:00:00Z', '60s', { diff: true })),
        discussion(note(813, 'carol', '2026-09-01T03:30:00Z', 'approved this merge request', { system: true })),
        discussion(note(814, 'carol', '2026-09-01T03:31:00Z', 'assigned to @alice', { system: true })),
      ],
    },
  };
}

test('todos are the inbox, my threads fill in the rest, discussions become the normalised events', async () => {
  const w = world();
  const api = fakeApi(w.routes);
  const r = await gitlab.poll({ api, cursor: null, me: ME, now: NOW });
  assert.equal(r.batches.length, 2);
  const seven = r.batches.find((b) => b.item.key === `${P}!7`);
  assert.equal(seven.item.kind, 'pull');
  assert.equal(seven.item.my_role, 'review_requested');
  assert.equal(seven.item.data.thread_id, 501);
  assert.deepEqual(seven.events.map((e) => e.kind), ['notification', 'review_request', 'opened', 'review_request']);
  assert.equal(seven.events[0].data.reason, 'review_requested');
  const nine = r.batches.find((b) => b.item.key === `${P}!9`);
  assert.equal(nine.item.my_role, 'authored');
  assert.deepEqual(nine.events.map((e) => e.kind), ['opened', 'review_comment', 'review_comment', 'review']);
  const reply = nine.events.find((e) => e.key === 'gitlab:note:812');
  assert.equal(reply.data.in_reply_to_id, 811, 'a reply names the root of its discussion');
  assert.equal(nine.events.find((e) => e.kind === 'review').data.state, 'approved');
  assert.ok(!nine.events.some((e) => e.key === 'gitlab:sys:814'), 'an assignment system note is not an observation');
  assert.equal(nine.item.last_activity, '2026-09-01T04:00:00Z');
  assert.equal(Object.keys(r.cursor.todos).length, 1);
  assert.deepEqual(gitlab.describeCursor(r.cursor), { since: NOW.toISOString(), todos: 1, threads: 2 });
  const again = await gitlab.poll({ api, cursor: r.cursor, me: ME, now: new Date(NOW.getTime() + 60_000) });
  assert.equal(again.batches.length, 0, 'nothing moved: a pending todo already seen is not re-read');
  const disc = api.calls.filter((c) => c.includes('/discussions')).length;
  assert.equal(disc, 2);
});

test('a merge request of yours that was merged is read, and the rules call it news', async () => {
  const w = world();
  const merged = mr({ path: P, iid: 12, title: 'Shipped', author: ME, created_at: '2026-08-20T00:00:00Z', updated_at: '2026-09-01T05:00:00Z', state: 'merged', merged_at: '2026-09-01T05:00:00Z' });
  merged.merged_by = { username: 'carol' };
  w.routes['/merge_requests'] = (u) => (u.searchParams.get('author_username') === ME ? [w.m9, merged] : u.searchParams.get('reviewer_username') === ME ? [w.m7] : []);
  w.routes[`/projects/${P}/merge_requests/12/discussions`] = [];
  const api = fakeApi(w.routes);
  const r = await gitlab.poll({ api, cursor: null, me: ME, now: NOW });
  assert.ok(api.calls.some((c) => c.includes('/merge_requests?') && !c.includes('state=')), 'my threads are read whatever their state');
  const b = r.batches.find((x) => x.item.key === `${P}!12`);
  assert.equal(b.item.data.state, 'merged');
  assert.deepEqual(b.events.map((e) => e.kind), ['opened', 'state']);
  assert.equal(b.events[1].actor, 'carol');
  const store = new Store();
  const runner = new Runner(store, [gitlab], { user: ME, rules: { gitlab: rules }, identity: { gitlab: ME }, extras: { gitlab: { api } }, now: () => NOW });
  const run = await runner.run('gitlab');
  assert.equal(run.decisions.find((d) => d.item === `${P}!12`).rule, 'state_change_on_mine');
  store.close();
});

test('system notes: the ones that are observations, and only for you', () => {
  assert.deepEqual(systemNote('approved this merge request', ME), { kind: 'review', data: { state: 'approved' } });
  assert.deepEqual(systemNote('merged', ME), { kind: 'state', data: { state: 'merged' } });
  assert.equal(systemNote('requested review from @bob', ME), null);
  assert.equal(systemNote('requested review from @alice and @bob', ME).kind, 'review_request');
  assert.equal(systemNote('added 3 commits', ME), null);
  assert.equal(keyOf(P, 3, 'issue'), `${P}#3`);
});

test('the rules see a GitLab reply exactly as a GitHub one; Done marks the todo', async () => {
  const w = world();
  const api = fakeApi(w.routes);
  const store = new Store();
  const runner = new Runner(store, [gitlab], { user: ME, rules: { gitlab: rules }, identity: { gitlab: ME }, extras: { gitlab: { api } }, now: () => NOW });
  const r = await runner.run('gitlab');
  const by = Object.fromEntries(r.decisions.map((d) => [d.item, d.rule]));
  assert.equal(by[`${P}!9`], 'reply_to_my_review_comment');
  assert.equal(by[`${P}!7`], 'review_requested');
  assert.equal(await gitlab.mark(store.itemByKey(ME, 'gitlab', `${P}!7`), { api }), 'todo marked done');
  assert.deepEqual(api.routes.done, ['501']);
  assert.match(await gitlab.mark(store.itemByKey(ME, 'gitlab', `${P}!9`), { api }), /no todo/);
  store.close();
});

test('open issues as state, reconciled through the runner', async () => {
  const w = world();
  const list = [issue({ path: P, iid: 31, title: 'Slow export', author: 'bob', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', assignees: [ME] })];
  w.routes[`/projects/${P}/issues`] = () => list;
  const api = fakeApi(w.routes);
  const store = new Store();
  let now = NOW;
  const runner = new Runner(store, [gitlab], { user: ME, rules: { gitlab: rules }, identity: { gitlab: ME }, extras: { gitlab: { api, issues: { projects: [P], everyMs: 0 } } }, now: () => now });
  const r = await runner.run('gitlab');
  const it = store.itemByKey(ME, 'gitlab', `${P}#31`);
  assert.equal(it.data.mode, 'open');
  assert.equal(r.decisions.find((d) => d.item === `${P}#31`).rule, 'issue_assigned_to_me');
  list.length = 0;
  now = new Date(NOW.getTime() + 60_000);
  assert.deepEqual((await runner.run('gitlab')).reconciled.resolved, [`${P}#31`]);
  assert.equal(store.itemByKey(ME, 'gitlab', `${P}!7`).state, 'open', 'merge requests are not governed by the issue set');
  store.close();
});

test('the demo GitLab ranks into P0s the way the demo GitHub does', async () => {
  const api = demoGitlab({ now: () => NOW });
  const r = await gitlab.poll({ api, cursor: null, me: ME, now: NOW });
  assert.deepEqual(r.batches.map((b) => b.item.key).sort(), [`${P}!7`, `${P}!9`]);
});
