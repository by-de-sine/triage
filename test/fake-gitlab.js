// A GitLabApi stand-in: routes to fixtures by path (a fixture may be a
// function of the URL, so a query string can pick the answer), counts
// calls, records mark_as_done. Also the canned GitLab the demo runs against.
import { GitLabApi } from '../lib/forge-api.js';

export function fakeApi(routes) {
  const calls = [];
  const fetch = async (url, { method = 'GET' } = {}) => {
    calls.push(`${method} ${url}`);
    const u = new URL(url);
    const hdr = new Headers({ 'ratelimit-remaining': '1900' });
    const path = decodeURIComponent(u.pathname.replace(/^\/api\/v4/, ''));
    if (method === 'POST' && /^\/todos\/\d+\/mark_as_done$/.test(path)) { routes.done = (routes.done || []).concat(path.split('/')[2]); return { status: 201, headers: hdr, text: async () => '{}' }; }
    const hit = routes[path];
    if (hit === undefined) return { status: 404, headers: hdr, text: async () => JSON.stringify({ message: `404 no fixture for ${path}` }) };
    return { status: 200, headers: hdr, text: async () => JSON.stringify(typeof hit === 'function' ? hit(u) : hit) };
  };
  const api = new GitLabApi({ token: 't', fetch });
  api.calls = calls;
  api.routes = routes;
  return api;
}

export const user = (username) => ({ username, name: username });
export const project = (path, id = 7) => ({ id, path_with_namespace: path, web_url: `https://gitlab.com/${path}` });

export function mr({ path, iid, title, author, created_at, updated_at = created_at, state = 'opened', merged_at = null, assignees = [], reviewers = [], description = 'the description' }) {
  return { iid, id: iid * 10, title, description, author: user(author), state, merged_at, closed_at: null, created_at, updated_at, draft: false, source_branch: 'x', target_branch: 'main', merge_status: 'can_be_merged',
    web_url: `https://gitlab.com/${path}/-/merge_requests/${iid}`, references: { full: `${path}!${iid}` }, assignees: assignees.map(user), reviewers: reviewers.map(user), labels: [] };
}
export function issue({ path, iid, title, author, created_at, updated_at = created_at, state = 'opened', assignees = [], labels = [], description = '' }) {
  return { iid, id: iid * 10, title, description, author: user(author), state, created_at, updated_at, closed_at: null,
    web_url: `https://gitlab.com/${path}/-/issues/${iid}`, references: { full: `${path}#${iid}` }, assignees: assignees.map(user), labels, user_notes_count: 0 };
}
export function todo({ id, path, target, action = 'mentioned', author = 'bob', created_at, body = '' }) {
  const type = target.source_branch !== undefined ? 'MergeRequest' : 'Issue';
  return { id, project: project(path), author: user(author), action_name: action, target_type: type, target, target_url: target.web_url, body, state: 'pending', created_at, updated_at: created_at };
}
export const note = (id, by, created_at, body, { system = false, diff = false } = {}) => ({ id, body, author: user(by), created_at, updated_at: created_at, system, type: diff ? 'DiffNote' : null, position: diff ? { new_path: 'a.js' } : null });
export const discussion = (...notes) => ({ id: `d${notes[0]?.id}`, notes });

/** A GitLab shaped like a working day, for `TRIAGE_DEMO=1`. You are `alice`. */
export function demoGitlab({ now = () => new Date() } = {}) {
  const t = now().getTime();
  const at = (min) => new Date(t - min * 60_000).toISOString();
  const P = 'acme/platform';
  const mr7 = mr({ path: P, iid: 7, title: 'Move the queue to a worker', author: 'bob', created_at: at(700), updated_at: at(20), reviewers: ['alice'] });
  const mr9 = mr({ path: P, iid: 9, title: 'Cache the tenant lookup', author: 'alice', created_at: at(2000), updated_at: at(50) });
  const routes = {
    '/user': { username: 'alice' },
    '/todos': [todo({ id: 501, path: P, target: mr7, action: 'review_requested', author: 'bob', created_at: at(20) })],
    '/merge_requests': (u) => (u.searchParams.get('author_username') === 'alice' ? [mr9] : u.searchParams.get('reviewer_username') === 'alice' ? [mr7] : []),
    '/issues': () => [],
    [`/projects/${P}/merge_requests/7/discussions`]: [discussion(note(801, 'bob', at(21), 'requested review from @alice', { system: true }))],
    [`/projects/${P}/merge_requests/9/discussions`]: [
      discussion(note(811, 'alice', at(300), 'Is the 5 min TTL too long?', { diff: true }), note(812, 'carol', at(50), 'I would go with 60s — tenants move between regions', { diff: true })),
      discussion(note(813, 'carol', at(55), 'approved this merge request', { system: true })),
    ],
    [`/projects/${P}/issues`]: () => [issue({ path: P, iid: 31, title: 'Tenant export times out past 10k rows', author: 'bob', created_at: at(4000), updated_at: at(600), assignees: ['alice'] })],
  };
  const api = fakeApi(routes);
  api.demo = { projects: [P] };
  return api;
}
