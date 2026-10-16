import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Store } from '../lib/store.js';
import { Runner } from '../lib/runner.js';
import { createApp } from '../lib/api.js';
import { SlackDelivery } from '../deliver/slack.js';
import github from '../sources/github.js';
import rules from '../rules/thread.js';
import { fakeApi, notification, pull, comment } from './fake-github.js';
import { createActor } from '../lib/actions.js';
import { Ranker } from '../lib/rank.js';

const ME = 'alice';
async function boot() {
  const store = new Store();
  const api = fakeApi({
    '/notifications': [notification({ id: 1, repo: 'o/r', number: 1, title: 'A PR', reason: 'comment', updated_at: '2026-09-02T02:00:00Z' })],
    '/repos/o/r/pulls/1': pull({ repo: 'o/r', number: 1, title: 'A PR', author: 'ann', created_at: '2026-09-01T00:00:00Z' }),
    '/repos/o/r/issues/1/comments': [comment(11, ME, '2026-09-02T01:00:00Z', 'ok'), comment(12, 'ann', '2026-09-02T02:00:00Z', 'thanks, one more thing')],
    '/repos/o/r/pulls/1/comments': [], '/repos/o/r/pulls/1/reviews': [],
  });
  const deliver = new SlackDelivery(store, {});
  const patches = [];
  const act = createActor({ store, marks: { github: (item) => github.mark(item, { api: { request: async (m, u) => { patches.push(`${m} ${u}`); return { status: 205 }; } } }) }, deliver });
  const rank = new Ranker({ shapes: { github: github.time } });
  const runner = new Runner(store, [github], { user: ME, rules: { github: rules }, deliver, rank, extras: { github: { api } } });
  const server = http.createServer(createApp({ store, runner, deliver, act, rank, rules: { github: rules }, user: ME, tz: 'America/Vancouver' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  const post = async (p, body, headers = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body == null ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { store, server, get, post, patches, base };
}

test('healthz reports the commit the deploy told it, and null when there is none', async () => {
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const store = new Store();
  const server = http.createServer(createApp({ store, runner: new Runner(store, [], { user: ME }), user: ME, commit: sha }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/healthz`)).json();
    assert.equal(body.commit, sha);
    assert.equal(body.ok, true);
  } finally { server.close(); store.close(); }
});

test('the API answers healthz, runs a source, lists items and decisions', async () => {
  const { server, get, post, patches, base } = await boot();
  try {
    let r = await get('/healthz');
    assert.equal(r.body.ok, true);
    assert.equal(r.body.slack.enabled, false);
    // Nothing told this process what it is running, so it says so rather than
    // guessing from the checkout on disk.
    assert.equal(r.body.commit, null);
    assert.deepEqual(r.body.read, {}, 'nothing has run, so nothing has been read');
    r = await get('/api/sources');
    assert.equal(r.body.sources[0].name, 'github');
    assert.equal(r.body.sources[0].cursor, null);
    r = await post('/api/sources/github/run');
    assert.equal(r.status, 200);
    assert.equal(r.body.decisions.length, 1);
    assert.equal(r.body.decisions[0].tier, 'P0');
    assert.equal(r.body.decisions[0].delivered, false);
    r = await get('/api/sources');
    assert.equal(r.body.sources[0].runs, 1);
    assert.equal(r.body.sources[0].cursor.threads, 1);
    r = await get('/healthz');
    // When each source last read successfully, for the page to print.
    assert.equal(r.body.read.github.ok, true);
    assert.ok(r.body.read.github.ok_at);
    r = await get('/api/items?tier=P0');
    assert.equal(r.body.items.length, 1);
    assert.equal(r.body.items[0].my_role, 'commented');
    const id = r.body.items[0].id;
    r = await get(`/api/items/${id}`);
    assert.equal(r.body.events.length, 4);
    assert.equal(r.body.decisions[0].rule, 'reply_to_my_comment');
    r = await get('/api/decisions?tier=P0&delivered=0');
    assert.equal(r.body.decisions.length, 1);
    assert.equal(r.body.decisions[0].title, 'A PR');
    assert.match(r.body.decisions[0].note, /not configured/);
    assert.equal((await get('/api/items?tier=P9')).status, 400);
    assert.equal((await get('/api/decisions?item=abc')).status, 400);
    assert.equal((await get(`/api/decisions?item=${id}`)).body.decisions.length, 1);
    assert.equal((await get('/api/items/999')).status, 404);
    assert.equal((await post('/api/sources/nope/run')).status, 404);
    // Acting: the same path the buttons take.
    assert.equal((await post(`/api/items/${id}/act`)).status, 400);
    assert.equal((await post(`/api/items/${id}/act`, { action: 'snooze' })).status, 400);
    assert.equal((await post('/api/items/999/act', { action: 'done' })).status, 404);
    assert.equal((await post(`/api/items/${id}/act`, { action: 'done' }, { origin: 'http://evil.example' })).status, 403);
    r = await post(`/api/items/${id}/act`, { action: 'snooze', until: '1h', by: 'web' });
    assert.equal(r.status, 200); assert.equal(r.body.item.state, 'snoozed'); assert.ok(r.body.until);
    r = await get('/api/lists');
    assert.deepEqual(r.body.groups.map((g) => [g.key, g.items.length]), [['queue', 0], ['snoozed', 1], ['later', 0]]);
    assert.equal(r.body.groups[1].items[0].reason, 'ann commented after you did');
    r = await post(`/api/items/${id}/act`, { action: 'done' }, { origin: `http://127.0.0.1:${new URL(base).port}` });
    assert.equal(r.status, 200); assert.equal(r.body.marked, 'marked read');
    assert.deepEqual(patches, ['PATCH /notifications/threads/1']);
    assert.equal((await get(`/api/items/${id}`)).body.actions.length, 2);
    const big = await fetch(base + `/api/items/${id}/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'later', pad: 'x'.repeat(70_000) }) });
    assert.equal(big.status, 413);
    // Plan §15: the reports, over a window, in the zone the app was given.
    r = await get('/api/reports');
    assert.deepEqual(Object.keys(r.body.reports), ['flow', 'when', 'where', 'response']);
    // A window pinned at its start and open at its end — it holds the fake
    // thread's September events and the Done just pressed, whatever today is.
    r = await get('/api/reports/flow?since=2026-09-01T00:00:00Z');
    assert.equal(r.status, 200);
    assert.equal(r.body.tz, 'America/Vancouver');
    assert.equal(r.body.bucket, 'day');
    assert.equal(r.body.totals.closed.you, 1, 'the Done above');
    assert.equal(r.body.totals.closed.elsewhere, 0);
    r = await get('/api/reports/where?by=actor&bucket=week&since=2026-09-01T00:00:00Z');
    assert.deepEqual(r.body.rows.map((x) => x.key), ['ann', 'alice']);
    assert.equal((await get('/api/reports/nope')).status, 404);
    assert.equal((await get('/api/reports/flow?bucket=year')).status, 400);
    assert.equal((await get('/api/reports/where?by=colour')).status, 400);
    assert.equal((await get('/api/reports/flow?since=then')).status, 400);
    const stats = await fetch(base + '/stats');
    assert.equal(stats.status, 200); assert.match(stats.headers.get('content-type'), /text\/html/);
    // The page and its files.
    const page = await fetch(base + '/');
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(base + '/../package.json')).status, 404);
    assert.equal((await fetch(base + '/nope.css')).status, 404);
    // Running again is a 304: no new events, no new decisions.
    r = await post('/api/sources/github/run');
    assert.equal(r.body.decisions.length, 0);
    assert.equal(r.body.status, 'not modified');
  } finally { server.close(); }
});

test('the API carries a second source: its cursor, its health, its own run', async () => {
  const store = new Store();
  const { default: calendar } = await import('../sources/calendar.js');
  const { default: calRules } = await import('../rules/calendar.js');
  const { demoCalendar } = await import('./fake-calendar.js');
  const deliver = new SlackDelivery(store, {});
  const act = createActor({ store, marks: { calendar: async () => 'nothing marked on Google — triage only reads your calendar' }, deliver });
  const gapi = demoCalendar();
  const runner = new Runner(store, [github, calendar], { user: ME, rules: { github: rules, calendar: calRules }, deliver, extras: { calendar: { api: gapi } } });
  const server = http.createServer(createApp({ store, runner, deliver, act, user: ME }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) })).json();
  try {
    let s = await get('/api/sources');
    assert.deepEqual(s.sources.map((x) => x.name), ['github', 'calendar']);
    const r = await post('/api/sources/calendar/run');
    assert.equal(r.ok, true);
    assert.equal(r.items, 6);
    // The rules ran; every tier is represented and every verdict is logged.
    const tiers = r.decisions.map((d) => d.tier).sort();
    assert.deepEqual(tiers, ['P1', 'P2', 'P2', 'P3', 'P3', 'P3']);
    s = await get('/api/sources');
    const cal = s.sources.find((x) => x.name === 'calendar');
    assert.equal(cal.ok, true);
    assert.equal(cal.runs, 1);
    // Health beside GitHub's, and a cursor that says it holds a token
    // without printing one.
    assert.deepEqual(cal.cursor, { sync_token: 'held', synced_at: cal.ok_at, upcoming: 1 });
    // The clock's half runs on the *next* pass, once the items exist: the
    // demo calendar has one starting in twelve minutes.
    const again = await post('/api/sources/calendar/run');
    assert.equal(again.due.decisions[0].rule, 'starts_in_15_min');
    assert.equal(again.due.decisions[0].tier, 'P0');
    const p0 = (await get('/api/decisions?tier=P0')).decisions;
    assert.equal(p0.length, 1);
    assert.equal(p0[0].source, 'calendar');
    assert.equal(p0[0].repo, null);
    // A calendar row on the list page carries what a meeting's row needs.
    const rows = (await get('/api/lists')).groups.flatMap((g) => g.items);
    const soon = rows.find((i) => i.key === 'demo-soon');
    assert.equal(soon.kind, 'event');
    assert.equal(soon.repo, null);
    assert.ok(soon.start && soon.join);
    // Done is local: nothing is written to Google, and it says so.
    const done = await post(`/api/items/${soon.id}/act`, { action: 'done' });
    assert.equal(done.marked, 'nothing marked on Google — triage only reads your calendar');
    assert.equal(done.item.state, 'done');
  } finally { server.close(); store.close(); }
});


test('/api/rank says what the order is made of, and the backfill is one bounded pass', async () => {
  const { store, server, get, post } = await boot();
  try {
    let r = await get('/api/rank');
    assert.equal(r.status, 200);
    assert.equal(r.body.weights.claim, 1);
    assert.deepEqual(r.body.terms, ['claim', 'time', 'prefer']);
    assert.deepEqual(r.body.absent, ['relevance', 'effort'], 'M6 emits these; saying so is the point');
    assert.deepEqual(r.body.interrupts.calendar, ['starts_in_15_min', 'new_invitation']);
    assert.equal(r.body.unranked, 0, 'nothing has been polled yet');

    // An item that predates the ranker: exactly the backlog's shape.
    const { item } = store.upsertItem({ user: ME, source: 'github', key: 'o/r#99', kind: 'pull', title: 'from June', url: 'u', repo: 'o/r', my_role: 'authored', last_activity: '2026-06-23T00:00:00Z' });
    const [merged] = store.addEvents(item.id, [{ key: 'z1', ts: '2026-06-23T00:00:00Z', kind: 'state', actor: 'ann', data: { state: 'merged' } }]);
    store.addDecision({ item_id: item.id, rule: 'state_change_on_mine', tier: 'P2', reason: 'your pull was merged', event_ids: [merged.id] }, '2026-06-23T00:00:00Z');
    assert.equal((await get('/api/rank')).body.unranked, 1);

    r = await post('/api/rank/backfill');
    assert.equal(r.status, 200);
    assert.equal(r.body.ranked, 1);
    assert.deepEqual(r.body.items[0].rules, ['state_change_on_mine']);
    assert.ok(store.item(item.id).rank > 0);
    assert.equal((await get('/api/rank')).body.unranked, 0);
    // Idempotent, and no decision row was invented for it.
    assert.equal((await post('/api/rank/backfill')).body.ranked, 0);
    assert.equal(store.decisionsFor(item.id).length, 1, 'the backfill adds no decision rows');

    // The queue as counts (§13.6), and a state nobody has heard of is refused.
    r = await get('/api/aggregates');
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'open');
    assert.equal(r.body.total, 1);
    assert.deepEqual(r.body.by.rule, { state_change_on_mine: 1 });
    assert.equal(r.body.share.repo.top, 'o/r');
    assert.equal(r.body.rank.ranked, 1);
    assert.equal((await get('/api/aggregates?state=nope')).status, 400);
    assert.equal((await get('/api/aggregates?state=all')).body.by.state.open, 1);

    // The list groups, and a group nobody has heard of is refused.
    assert.equal((await get('/api/lists?group=nonsense')).status, 400);
    r = await get('/api/lists?group=repo');
    assert.equal(r.body.group, 'repo');
    assert.ok(r.body.groups[0].key.startsWith('queue:'));
    // The list narrows by what the page's tiles, tags and search box send,
    // says what it was narrowed by, and refuses a tier nobody has heard of.
    r = await get('/api/lists?repo=o/r&q=june');
    assert.deepEqual(r.body.filter, { repo: 'o/r', q: 'june' });
    assert.deepEqual(r.body.groups[0].items.map((i) => i.title), ['from June']);
    assert.equal((await get('/api/lists?q=nothing+says+this')).body.groups[0].items.length, 0);
    assert.equal((await get('/api/lists?tier=P9')).status, 400);
    assert.equal((await get('/api/lists?limit=10x')).status, 400);
    assert.equal((await get('/api/lists?limit=-1')).status, 400);
    assert.equal((await get('/api/lists?limit=1')).status, 200);
  } finally { server.close(); }
});

// Plan §14.6: the configuration explaining itself. "Why didn't that buzz me"
// has to have an answer naming the statement that decided it, or the grammar
// does not matter.
test('GET /api/interrupts shows the layers, and answers one question at a time', async () => {
  const { resolve } = await import('../deliver/interrupts.js');
  const store = new Store();
  const { item } = store.upsertItem({ user: ME, source: 'github', key: 'noisy/repo#1', kind: 'pull', title: 'x', url: 'u', repo: 'noisy/repo', last_activity: '2026-09-13T12:00:00Z' });
  const deliver = new SlackDelivery(store, {
    projects: { github: (i) => i.repo || null },
    interrupts: resolve({ prefs: { projects: { 'noisy/repo': { interrupts: 'off' } } }, env: '+github:new_issue' }),
  });
  const server = http.createServer(createApp({ store, runner: new Runner(store, [], { user: ME }), deliver, user: ME }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`); return { status: r.status, body: await r.json() }; };
  try {
    let r = await get('/api/interrupts');
    assert.deepEqual(r.body.layers.map((l) => l.layer), ['default', 'prefs-project', 'env']);
    assert.ok(r.body.set.github.includes('new_issue'), 'the effective set folds the env delta in');
    assert.deepEqual(r.body.projects, ['github'], 'which sources declared a project seam');

    r = await get('/api/interrupts?source=github&rule=reply_to_my_comment');
    assert.equal(r.body.allow, true);
    assert.match(r.body.by, /the default set/);

    // Scoped by name, and scoped by asking the source about a real item —
    // the only thing that knows what project an item belongs to.
    r = await get('/api/interrupts?source=github&rule=reply_to_my_comment&project=noisy/repo');
    assert.equal(r.body.allow, false);
    assert.match(r.body.by, /projects\."noisy\/repo"/);
    r = await get(`/api/interrupts?source=github&rule=reply_to_my_comment&item=${item.id}`);
    assert.equal(r.body.allow, false);
    assert.deepEqual(r.body.asked, { source: 'github', rule: 'reply_to_my_comment', project: 'noisy/repo', item: 'noisy/repo#1' });

    assert.equal((await get('/api/interrupts?source=github')).status, 400);
    assert.equal((await get('/api/interrupts?source=github&rule=x&item=9999')).status, 404);
  } finally { server.close(); store.close(); }
});

test('/api/interrupts refuses project and item together rather than picking one', async () => {
  const store = new Store();
  const { item } = store.upsertItem({ user: ME, source: 'github', key: 'o/r#9', kind: 'pull', title: 'x', url: 'u', repo: 'o/r', last_activity: '2026-09-13T12:00:00Z' });
  const deliver = new SlackDelivery(store, { projects: { github: (i) => i.repo || null } });
  const server = http.createServer(createApp({ store, runner: new Runner(store, [], { user: ME }), deliver, user: ME }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`); return { status: r.status, body: await r.json() }; };
  try {
    const r = await get(`/api/interrupts?source=github&rule=direct_mention&item=${item.id}&project=other/repo`);
    assert.equal(r.status, 400, 'answering on project and ignoring item is a quiet answer to a question nobody asked');
    assert.match(r.body.error, /not both/);
  } finally { server.close(); store.close(); }
});
