// A GitHubApi stand-in: routes to fixtures, counts calls, answers 304 when
// asked with the Last-Modified it last sent, records a thread marked read.
// Also the canned inbox the demo runs against.
import { GitHubApi } from '../lib/forge-api.js';

export function fakeApi(routes, { pollInterval = 60, lastModified = 'Mon, 01 Sep 2026 00:00:00 GMT' } = {}) {
  const calls = [];
  const fetch = async (url, { headers, method = 'GET' }) => {
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
    if (method === 'PATCH' && /^\/notifications\/threads\/[^/]+$/.test(u.pathname)) { routes.marked = (routes.marked || []).concat(u.pathname.split('/').pop()); return { status: 205, headers: hdr, text: async () => '' }; }
    const hit = routes[path] ?? routes[u.pathname];
    if (hit === undefined) return { status: 404, headers: hdr, text: async () => JSON.stringify({ message: `no fixture for ${path}` }) };
    return { status: 200, headers: hdr, text: async () => JSON.stringify(typeof hit === 'function' ? hit(u) : hit) };
  };
  const api = new GitHubApi({ token: 't', tokensDir: '/nonexistent', fetch });
  api.calls = calls;
  api.routes = routes;
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

/** An inbox shaped like a working day, relative to `now`, for
 *  `TRIAGE_GITHUB=fake` and the demo: one of each thing the thread rules
 *  separate — a reply on your pull request, a mention, a review request, a
 *  merge, a bot's bump — and an open set of three issues. You are `alice`. */
export function demoGithub({ now = () => new Date() } = {}) {
  const t = now().getTime();
  const at = (min) => new Date(t - min * 60_000).toISOString();
  const R = 'acme/widgets', S = 'acme/site';
  const none = (repo, n) => ({ [`/repos/${repo}/issues/${n}/comments`]: [], [`/repos/${repo}/pulls/${n}/comments`]: [], [`/repos/${repo}/pulls/${n}/reviews`]: [] });
  const routes = {
    '/user': { login: 'alice' },
    '/notifications': [
      notification({ id: 101, repo: R, number: 41, title: 'Stream the export instead of buffering it', reason: 'author', updated_at: at(9) }),
      notification({ id: 102, repo: R, type: 'Issue', number: 57, title: 'Login page flashes white on dark mode', reason: 'mention', updated_at: at(35) }),
      notification({ id: 103, repo: R, number: 38, title: 'Retry uploads on 502', reason: 'review_requested', updated_at: at(70) }),
      notification({ id: 104, repo: S, number: 12, title: 'Bump marketing copy', reason: 'author', updated_at: at(180) }),
      notification({ id: 105, repo: S, number: 13, title: 'chore(deps): bump esbuild', reason: 'subscribed', updated_at: at(300) }),
    ],
    [`/repos/${R}/pulls/41`]: pull({ repo: R, number: 41, title: 'Stream the export instead of buffering it', author: 'alice', created_at: at(600) }),
    [`/repos/${R}/issues/41/comments`]: [],
    [`/repos/${R}/pulls/41/comments`]: [reviewComment(9001, 'alice', at(120), 'I think we can drop the buffer here'), reviewComment(9002, 'bob', at(9), 'Agreed — but the 502 path still buffers, see line 40', 9001)].map((c) => ({ ...c, html_url: `https://github.com/${R}/pull/41#discussion_r${c.id}` })),
    [`/repos/${R}/pulls/41/reviews`]: [{ ...review(7001, 'bob', at(9), 'COMMENTED', 'a few notes inline'), html_url: `https://github.com/${R}/pull/41#pullrequestreview-7001` }],
    [`/repos/${R}/issues/57`]: issue({ repo: R, number: 57, title: 'Login page flashes white on dark mode', author: 'carol', created_at: at(400), updated_at: at(35) }),
    [`/repos/${R}/issues/57/comments`]: [{ ...comment(9101, 'carol', at(35), '@alice this looks like the theme script runs after first paint — your area?', R, 57), html_url: `https://github.com/${R}/issues/57#issuecomment-9101` }],
    [`/repos/${R}/pulls/38`]: pull({ repo: R, number: 38, title: 'Retry uploads on 502', author: 'carol', created_at: at(500), requested_reviewers: ['alice'] }),
    ...none(R, 38),
    [`/repos/${S}/pulls/12`]: pull({ repo: S, number: 12, title: 'Bump marketing copy', author: 'alice', created_at: at(900), state: 'closed', merged_at: at(180), closed_at: at(180) }),
    ...none(S, 12),
    [`/repos/${S}/pulls/13`]: pull({ repo: S, number: 13, title: 'chore(deps): bump esbuild', author: 'dependabot[bot]', created_at: at(300) }),
    ...none(S, 13),
    [`/repos/${S}/issues/13/comments`]: [comment(9201, 'dependabot[bot]', at(300), 'Bumps esbuild from 0.24 to 0.25.', S, 13)],
    [`/repos/${R}/issues?state=open&sort=updated&direction=asc`]: openList(
      { repo: R, number: 52, title: 'Export CSV with a BOM for Excel', author: 'alice', created_at: at(3000), updated_at: at(2000) },
      { repo: R, number: 55, title: 'Rate limit the webhook endpoint', author: 'carol', created_at: at(1500), updated_at: at(800), assignees: ['alice'] },
      { repo: R, number: 57, title: 'Login page flashes white on dark mode', author: 'carol', created_at: at(400), updated_at: at(35) },
    ),
  };
  const api = fakeApi(routes);
  api.demo = { repos: [R] };
  return api;
}
