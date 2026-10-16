// A TwentyApi over a fake `fetch`, the shape test/fake-ha.js set: the real
// client, routes to fixtures, counts calls, and can be told to fail.
//
// Twenty is modelled as its records — `api.world` is the CRM, mutate it
// between polls and the source sees exactly what a person in the UI (or an
// agent on a key) would have done. The fake answers the handful of GraphQL
// shapes lib/twenty-api.js sends, and pages for real, so the page cap and
// the completeness flag are exercised rather than assumed.
import { TwentyApi } from '../lib/twenty-api.js';

export const ALICE = 'f6aef54e-8ab4-4f8e-867e-76ffcffe327f';
export const BOB = '64e59071-6277-4296-8b63-bd9ffa03c203';
export const COMPANY = 'b41191e2-a5b6-4c2f-a876-dd25e4489fb2';

/** The actors the source has to tell apart, as Twenty records them. */
export const BY = {
  aliceUi: { source: 'MANUAL', workspaceMemberId: ALICE, name: 'Alice Example' },
  aliceMcp: { source: 'API', workspaceMemberId: null, name: 'Agent key' },
  bobUi: { source: 'MANUAL', workspaceMemberId: BOB, name: 'Bob Example' },
  bobAgent: { source: 'API', workspaceMemberId: null, name: 'Other key' },
  unknownKey: { source: 'API', workspaceMemberId: null, name: 'Zapier' },
};

let seq = 0;
const stamp = (t) => new Date(t).toISOString();

export function task({ id = `t${++seq}`, title, body = '', status = 'TODO', dueAt = null, assigneeId = null, by = BY.aliceMcp, at = '2026-10-01T00:00:00.000Z', createdAt = at, company = COMPANY, person = null }) {
  return { id, title, body, status, dueAt, assigneeId, createdAt, updatedAt: at, createdBy: by, updatedBy: by, targets: { company, person } };
}
export function note({ id = `n${++seq}`, title, body = '', by = BY.aliceMcp, at = '2026-10-01T00:00:00.000Z', createdAt = at, company = COMPANY }) {
  return { id, title, body, createdAt, updatedAt: at, createdBy: by, updatedBy: by, targets: { company, person: null } };
}

/** Change a record the way a person would: new fields, a new `updatedAt`,
 *  and whoever did it on `updatedBy`. */
export function edit(rec, fields, by, at) {
  Object.assign(rec, fields, { updatedAt: stamp(at), updatedBy: by });
  return rec;
}

export function world() {
  return {
    members: [
      { id: ALICE, userEmail: 'alice@example.test', name: { firstName: 'Alice', lastName: 'Example' } },
      { id: BOB, userEmail: 'bob@example.test', name: { firstName: 'Bob', lastName: 'Example' } },
    ],
    companies: [{ id: COMPANY, name: 'Acme Corp' }],
    people: [{ id: 'p1', companyId: COMPANY }],
    tasks: [],
    notes: [],
  };
}

/** `fail`: `'auth'` (401), `'down'` (the network throws), `'schema'` (a
 *  GraphQL error, which is what a renamed field looks like). A small
 *  `maxPages` with more rows than fit is the incomplete read. */
export function fakeTwenty(w = world(), { url = 'https://crm.test', key = 'k', fail = null, pageSize = 100, maxPages = 50 } = {}) {
  const calls = [];
  const api = new TwentyApi({ url, key, pageSize, maxPages, fetch: (u, init) => call(u, init) });
  api.calls = calls;
  api.world = w;
  api.fail = fail;

  const node = (field, r, bodies) => {
    if (bodies) return { id: r.id, bodyV2: { markdown: r.body } };
    if (field === 'tasks' || field === 'notes') {
      const edges = [];
      if (r.targets.company) edges.push({ node: { targetCompanyId: r.targets.company, targetPersonId: null } });
      if (r.targets.person) edges.push({ node: { targetCompanyId: null, targetPersonId: r.targets.person } });
      const { body, targets, ...rest } = r;
      return { ...rest, [field === 'tasks' ? 'taskTargets' : 'noteTargets']: { edges } };
    }
    return r;
  };

  async function call(u, { headers = {}, body } = {}) {
    const { query, variables = {} } = JSON.parse(body || '{}');
    const field = /\{\s*(\w+)\(first:/.exec(query)?.[1];
    calls.push(field);
    if (api.fail === 'down') throw new TypeError('fetch failed');
    if (headers.authorization !== `Bearer ${key}` || api.fail === 'auth') return json(401, { message: 'Unauthorized' });
    if (api.fail === 'schema') return json(200, { data: null, errors: [{ message: `Cannot query field "bodyV2" on type "Task".` }] });
    let rows = [...(api.world[field === 'workspaceMembers' ? 'members' : field] || [])];
    const bodies = /bodyV2/.test(query);
    if (variables.ids) rows = rows.filter((r) => variables.ids.includes(r.id));
    else if (field === 'tasks') rows = rows.filter((r) => r.status !== 'DONE' || (variables.since && r.updatedAt >= variables.since));
    const start = variables.after ? Number(variables.after) : 0;
    const page = rows.slice(start, start + pageSize);
    const next = start + pageSize < rows.length;
    return json(200, { data: { [field]: { pageInfo: { hasNextPage: next, endCursor: next ? String(start + pageSize) : null }, edges: page.map((r) => ({ node: node(field, r, bodies) })) } } });
  }
  return api;
}

const json = (status, body) => ({ status, ok: status < 400, statusText: String(status), headers: new Headers(), text: async () => JSON.stringify(body) });

/** What `TRIAGE_CRM=fake` runs a worktree against: a handful of tasks and a
 *  note, every title saying `(fake)`, and **a scripted afternoon** — after
 *  the first (baseline) read, Bob hands Alice a task (the P0 that
 *  interrupts), rewords the body of one Alice handed him (P1, reporting
 *  back), and an unnamed API key adds a note (P2), so every step can be
 *  seen deciding in `/api/decisions` with no CRM at all. Alice's own edit
 *  through `Agent key` happens on the same read and must not interrupt. */
export function demoTwenty({ now = () => new Date() } = {}) {
  const t0 = now().getTime();
  const at = (min) => stamp(t0 + min * 60_000);
  const w = world();
  const bobTask = task({ id: 'demo-bob', title: '(fake) DEV 6 · ActiveStorage loose ends', body: 'Investigate, then close.', assigneeId: BOB, at: at(-600) });
  const mine = task({ id: 'demo-mine', title: '(fake) Send the September invoice', body: 'Hours from the worklog.', assigneeId: ALICE, dueAt: at(-60), at: at(-1440) });
  w.tasks.push(bobTask, mine,
    task({ id: 'demo-open', title: '(fake) Privacy notice — the client\'s call', body: 'Offered to help draft.', at: at(-3000) }),
    task({ id: 'demo-done', title: '(fake) Drop /contact/new from the sitemap', status: 'DONE', at: at(-5000) }));
  w.notes.push(note({ id: 'demo-note', title: '(fake) SEO release spec', body: 'Part 1.', at: at(-4000) }));
  const api = fakeTwenty(w, { url: 'https://crm.example.test' });
  let reads = 0;
  // `members` is the first thing a read asks for, so the change lands before
  // the tasks and notes of that same read are taken.
  const members = api.members.bind(api);
  api.members = async () => {
    if (++reads === 2) {
      edit(bobTask, { body: 'Investigated: #93 is the scanner, closing it. #16 needs you — see the note.' }, BY.bobUi, now());
      edit(mine, { body: 'Hours from the worklog; draft only.' }, BY.aliceMcp, now());
      w.notes.push(note({ id: 'demo-note-2', title: '(fake) Answer on #16', body: 'The 404 is an old representation URL.', by: BY.unknownKey, at: now() }));
      w.tasks.push(task({ id: 'demo-handed', title: '(fake) Review the pricing before Friday', body: 'Does the total feel right?', assigneeId: ALICE, by: BY.bobUi, at: now() }));
    }
    return members();
  };
  return api;
}
