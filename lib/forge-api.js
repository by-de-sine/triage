// forge-api.js — `fetch` against a forge's REST API with a token, a
// deadline, conditional requests and paging. One base, two thin clients:
// GitHub (`Authorization: Bearer`, the notifications and `X-Poll-Interval`
// conventions, a token per repository owner) and GitLab (`PRIVATE-TOKEN`,
// a project addressed by its URL-encoded path). Either may point at a
// self-hosted instance through `base`. Nothing above this file knows which
// forge it is talking to: a source gets `api` and calls `get`, `request`,
// `list` and `listPages`.
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { nextLink, readTokenFile, sh, TOKENS_DIR } from './util.js';

/** How many same-origin redirects a request follows before it gives up. */
const MAX_REDIRECTS = 3;

export class RestApi {
  constructor({ base, token = null, headers = {}, fetch: f = globalThis.fetch, userAgent = 'triage', timeoutMs = 30_000 } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.token = token || null;
    this.headers = headers;
    this.fetch = f;
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.rate = { remaining: null, reset: null };
    this.name = 'forge';
  }
  /** The auth header(s) for one request. A subclass may pick a token by URL. */
  async authHeaders() { return {}; }
  url(u) { return u.startsWith('http') ? u : this.base + u; }
  /** Whether a URL is on this API's origin. A `Link` header's next page and
   *  a notification's `subject.url` are followed as given, so the token
   *  goes only where the base does: another host gets the request bare. */
  sameOrigin(u) { try { return new URL(u).origin === new URL(this.base).origin; } catch { return false; } }
  get(url, opts = {}) { return this.request('GET', url, opts); }

  /** Any method. Returns `{status, headers, body}`; `body` is parsed JSON
   *  (or text), null on 304 / no content. Throws on network failure, 5xx
   *  and 4xx (with `status` and `url` on the error). A stalled request
   *  must end, or one bad connection wedges every poll. */
  async request(method, url, { headers = {}, ifModifiedSince, ifNoneMatch, body: payload } = {}) {
    let u = this.url(url);
    let res;
    // Redirects are followed by hand, and only on this API's origin: fetch
    // would follow one anywhere and keep a custom header like PRIVATE-TOKEN
    // on it, so a redirect off the origin would carry the token away. A
    // renamed repository is the one redirect a forge issues, and it stays
    // on the origin.
    for (let hop = 0; ; hop++) {
      const h = { accept: 'application/json', 'user-agent': this.userAgent, ...this.headers, ...(this.sameOrigin(u) ? await this.authHeaders(u) : {}), ...headers };
      if (ifModifiedSince) h['if-modified-since'] = ifModifiedSince;
      if (ifNoneMatch) h['if-none-match'] = ifNoneMatch;
      if (payload !== undefined) h['content-type'] = 'application/json';
      res = await this.fetch(u, { method, headers: h, body: payload === undefined ? undefined : JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const to = res.headers.get('location');
      let next = null;
      try { next = to ? new URL(to, u).toString() : null; } catch { next = null; }
      if (!next || !this.sameOrigin(next)) throw new Error(`${this.name} ${res.status} on ${method} ${u}: redirected off ${new URL(this.base).origin}, not followed`);
      if (hop >= MAX_REDIRECTS) throw new Error(`${this.name}: more than ${MAX_REDIRECTS} redirects on ${method} ${u}`);
      u = next;
    }
    const rem = res.headers.get('x-ratelimit-remaining') ?? res.headers.get('ratelimit-remaining');
    if (rem != null) this.rate = { remaining: parseInt(rem, 10), reset: parseInt(res.headers.get('x-ratelimit-reset') || res.headers.get('ratelimit-reset') || '0', 10) };
    if (res.status === 304) return { status: 304, headers: res.headers, body: null };
    if (res.status >= 500) throw new Error(`${this.name} ${res.status} on ${method} ${u}`);
    let body = null;
    if (res.status !== 204 && res.status !== 205) { const text = await res.text(); try { body = JSON.parse(text); } catch { body = text; } }
    if (res.status >= 400) {
      const msg = typeof body === 'object' && body ? body.message || body.error || JSON.stringify(body) : body;
      const e = new Error(`${this.name} ${res.status} on ${method} ${u}: ${msg}`); e.status = res.status; e.url = u; throw e;
    }
    return { status: res.status, headers: res.headers, body };
  }

  /** GET every page of a list endpoint, up to `pages` pages. `whole` says
   *  whether the walk ended because the list did rather than at the cap —
   *  the difference between a complete read and one that must not resolve
   *  anything (plan §12.2). */
  async listPages(url, { pages = 5, params = {}, perPage = 100 } = {}) {
    const u = new URL(this.url(url));
    u.searchParams.set('per_page', String(perPage));
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
    let next = u.toString();
    const out = [];
    for (let i = 0; i < pages && next; i++) {
      const r = await this.get(next);
      if (Array.isArray(r.body)) out.push(...r.body);
      next = nextLink(r.headers.get('link'));
    }
    return { list: out, whole: !next };
  }
  async list(url, opts = {}) { return (await this.listPages(url, opts)).list; }
}

/** How long a token read from an owner's gh config directory is trusted
 *  before `gh` is asked again: the file rotates rarely, and a subprocess
 *  per request would be absurd. */
const OWNER_TOKEN_TTL_MS = 10 * 60_000;

export class GitHubApi extends RestApi {
  /** `tokensDir`: one entry per repository owner, for owners the default
   *  token cannot read. `<tokensDir>/<owner>` is either a file whose first
   *  non-comment line is the token, or a directory holding a `gh` config
   *  (`hosts.yml`), in which case `gh auth token` is asked with
   *  `GH_CONFIG_DIR` pointed there. Absent is the normal case. */
  constructor({ base = 'https://api.github.com', tokensDir = TOKENS_DIR, gh = ghAuthToken, ...rest } = {}) {
    super({ base, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, ...rest });
    this.name = 'GitHub';
    this.tokensDir = tokensDir;
    this.gh = gh;
    this.ownerTokens = new Map();   // owner -> { token, at }
  }
  /** The web URL that pairs with this API base: api.github.com -> github.com,
   *  a GitHub Enterprise `https://host/api/v3` -> `https://host`. */
  get webBase() {
    if (this.base === 'https://api.github.com') return 'https://github.com';
    return this.base.replace(/\/api\/v3$/, '');
  }
  /** The repository owner a URL is about, or null. */
  ownerOf(url) {
    const u = String(url);
    if (!u.startsWith(`${this.base}/repos/`)) return null;
    return u.slice(this.base.length + '/repos/'.length).split('/')[0] || null;
  }
  /** The token for one URL: the owner's own when `tokensDir` has one, else
   *  the default. */
  async tokenFor(url) {
    const owner = this.ownerOf(url);
    if (!owner || !this.tokensDir) return this.token;
    const entry = path.join(this.tokensDir, owner);
    let isDir = false;
    try { isDir = statSync(entry).isDirectory(); } catch { return this.token; }
    if (!isDir) return readTokenFile(entry) || this.token;
    const cached = this.ownerTokens.get(owner);
    if (cached && Date.now() - cached.at < OWNER_TOKEN_TTL_MS) return cached.token || this.token;
    const token = existsSync(path.join(entry, 'hosts.yml')) ? await this.gh(entry) : null;
    this.ownerTokens.set(owner, { token, at: Date.now() });
    return token || this.token;
  }
  async authHeaders(url) {
    const tok = await this.tokenFor(url);
    return tok ? { authorization: `Bearer ${tok}` } : {};
  }
}

export class GitLabApi extends RestApi {
  constructor({ base = 'https://gitlab.com', ...rest } = {}) {
    super({ base: `${String(base).replace(/\/+$/, '')}/api/v4`, ...rest });
    this.name = 'GitLab';
    this.webBase = String(base).replace(/\/+$/, '');
  }
  async authHeaders() { return this.token ? { 'PRIVATE-TOKEN': this.token } : {}; }
  /** GitLab takes a project by its URL-encoded path as well as by id. */
  project(p) { return `/projects/${encodeURIComponent(p)}`; }
}

/** What `gh auth token` holds in one config directory, with the
 *  environment's own token cleared so the answer is that directory's and
 *  not the caller's. Null when gh is absent, logged out, or says nothing. */
export async function ghAuthToken(configDir) {
  const r = await sh('gh', ['auth', 'token', '-h', 'github.com'], { env: { GH_CONFIG_DIR: configDir, GH_TOKEN: '', GITHUB_TOKEN: '' } });
  return r.ok && /^\S+$/.test(r.stdout) ? r.stdout : null;
}

/** The GitHub token: the environment, else what `gh auth token` holds. */
export async function githubToken(env = process.env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const r = await sh('gh', ['auth', 'token']);
  return r.ok && /^\S+$/.test(r.stdout) ? r.stdout : null;
}

/** The GitLab token: the environment, else what `glab auth token` holds. A
 *  box without `glab`, or an older `glab` with no such command, reads as
 *  "no token" rather than as an error. */
export async function gitlabToken(env = process.env) {
  if (env.GITLAB_TOKEN) return env.GITLAB_TOKEN;
  const r = await sh('glab', ['auth', 'token']);
  return r.ok && /^\S+$/.test(r.stdout) ? r.stdout : null;
}
