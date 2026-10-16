// A GitHubApi stand-in: routes to fixtures, counts calls, answers 304 when
// asked with the Last-Modified it last sent.
import { GitHubApi } from '../lib/forge-api.js';

export function fakeApi(routes, { pollInterval = 60, lastModified = 'Mon, 01 Sep 2026 00:00:00 GMT' } = {}) {
  const calls = [];
  const fetch = async (url, { headers }) => {
    calls.push(url);
    const u = new URL(url);
    const path = u.pathname + (u.search ? '?' + [...u.searchParams].filter(([k]) => k !== 'per_page').map(([k, v]) => `${k}=${v}`).join('&') : '');
    const hdr = new Headers({ 'x-ratelimit-remaining': '4000', 'x-poll-interval': String(pollInterval) });
    if (u.pathname === '/notifications') {
      if (routes.pages?.[url]) {
        // routes.chain: every page links to the next, so a cap is what ends the walk.
        const n = parseInt(u.searchParams.get('page'), 10);
        if (routes.chain) hdr.set('link', `<https://api.github.com/notifications?page=${n + 1}>; rel="next"`);
        return { status: 200, headers: hdr, text: async () => JSON.stringify(routes.pages[url]) };
      }
      hdr.set('last-modified', routes.lastModified || lastModified);
      if (routes.pages) hdr.set('link', '<https://api.github.com/notifications?page=2>; rel="next"');
      if (headers['if-modified-since'] && headers['if-modified-since'] === (routes.lastModified || lastModified)) return { status: 304, headers: hdr, text: async () => '' };
      return { status: 200, headers: hdr, text: async () => JSON.stringify(routes['/notifications']) };
    }
    const hit = routes[path] ?? routes[u.pathname];
    if (hit === undefined) return { status: 404, headers: hdr, text: async () => JSON.stringify({ message: `no fixture for ${path}` }) };
    return { status: 200, headers: hdr, text: async () => JSON.stringify(typeof hit === 'function' ? hit(u) : hit) };
  };
  const api = new GitHubApi({ token: 't', tokensDir: '/nonexistent', fetch });
  api.calls = calls;
  return api;
}

export const user = (login) => ({ login, type: /\[bot\]$/.test(login) ? 'Bot' : 'User' });

export function notification({ id, repo, type = 'PullRequest', number, title, reason = 'author', updated_at }) {
  const kind = type === 'PullRequest' ? 'pulls' : 'issues';
  return { id: String(id), unread: true, reason, updated_at, last_read_at: null,
    subject: { title, url: `https://api.github.com/repos/${repo}/${kind}/${number}`, latest_comment_url: null, type },
    repository: { full_name: repo, html_url: `https://github.com/${repo}` } };
}

export function pull({ repo, number, title, author, created_at, state = 'open', merged_at = null, closed_at = null, requested_reviewers = [] }) {
  return { number, title, body: 'the description', user: user(author), state, merged: !!merged_at, merged_at, closed_at, created_at, draft: false,
    html_url: `https://github.com/${repo}/pull/${number}`, requested_reviewers: requested_reviewers.map(user) };
}
export const issue = (o) => ({ ...pull(o), html_url: `https://github.com/${o.repo}/issues/${o.number}`, merged: undefined, merged_at: undefined,
  repository_url: `https://api.github.com/repos/${o.repo}`, updated_at: o.updated_at || o.created_at, assignees: (o.assignees || []).map(user), labels: (o.labels || []).map((name) => ({ name })), comments: o.comments ?? 0 });
/** What `GET /repos/:repo/issues?state=open` lists: issues, and pull requests wearing a `pull_request` key. */
export const openList = (...entries) => entries.map((e) => (e.kind === 'pull' ? { ...issue(e), pull_request: { url: 'x' } } : issue(e)));
export const comment = (id, by, created_at, body, repo = 'o/r', number = 1) => ({ id, user: user(by), created_at, updated_at: created_at, body, html_url: `https://github.com/${repo}/pull/${number}#issuecomment-${id}` });
export const reviewComment = (id, by, created_at, body, in_reply_to_id = null) => ({ id, user: user(by), created_at, updated_at: created_at, body, in_reply_to_id, path: 'a.js', html_url: `https://github.com/o/r/pull/1#discussion_r${id}` });
export const review = (id, by, submitted_at, state, body = '') => ({ id, user: user(by), submitted_at, state, body, html_url: `https://github.com/o/r/pull/1#pullrequestreview-${id}` });
