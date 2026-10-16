// github-api.js — fetch against api.github.com with the right token and
// conditional requests. The token is chosen per resource owner:
// <tokensDir>/<owner> (TRIAGE_TOKENS_DIR, ~/.config/triage/tokens by default)
// when that file exists, else the default — GITHUB_TOKEN, or what `gh auth
// token` holds.
import path from 'node:path';
import { readTokenFile, TOKENS_DIR, sh } from './util.js';

export const API = 'https://api.github.com';

/** Resolve the default token: env first, then gh. Returns null if neither. */
export async function defaultToken(env = process.env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const r = await sh('gh', ['auth', 'token']);
  return r.ok && r.stdout ? r.stdout : null;
}

export class GitHubApi {
  constructor({ token, tokensDir = TOKENS_DIR, fetch: f = globalThis.fetch, userAgent = 'triage', timeoutMs = 30_000 } = {}) {
    this.token = token || null;
    this.timeoutMs = timeoutMs;
    this.tokensDir = tokensDir;
    this.fetch = f;
    this.userAgent = userAgent;
    this.rate = { remaining: null, reset: null };
  }

  tokenFor(url) {
    const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\//.exec(url);
    if (m) {
      const own = readTokenFile(path.join(this.tokensDir, m[1]));
      if (own) return own;
    }
    return this.token;
  }

  /** GET one URL. Returns {status, headers, body} where body is parsed JSON
   *  (or null on 304 / no content). Throws on network failure or 5xx. */
  get(url, opts = {}) { return this.request('GET', url, opts); }

  /** Any method. The one write triage makes is PATCH /notifications/threads/:id
   *  (Done marks the thread read); it answers 205 with no body. */
  async request(method, url, { headers = {}, ifModifiedSince, body: payload } = {}) {
    if (url.startsWith('/')) url = API + url;
    const tok = this.tokenFor(url);
    const h = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': this.userAgent, ...headers };
    if (tok) h.authorization = `Bearer ${tok}`;
    if (ifModifiedSince) h['if-modified-since'] = ifModifiedSince;
    if (payload !== undefined) h['content-type'] = 'application/json';
    // A stalled request must end, or one bad connection wedges every poll.
    const res = await this.fetch(url, { method, headers: h, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(this.timeoutMs) });
    const rem = res.headers.get('x-ratelimit-remaining');
    if (rem != null) this.rate = { remaining: parseInt(rem, 10), reset: parseInt(res.headers.get('x-ratelimit-reset') || '0', 10) };
    if (res.status === 304) return { status: 304, headers: res.headers, body: null };
    if (res.status >= 500) throw new Error(`GitHub ${res.status} on ${method} ${url}`);
    let body = null;
    if (res.status !== 204 && res.status !== 205) { const text = await res.text(); try { body = JSON.parse(text); } catch { body = text; } }
    if (res.status >= 400) { const e = new Error(`GitHub ${res.status} on ${method} ${url}: ${typeof body === 'object' && body ? body.message : body}`); e.status = res.status; e.url = url; throw e; }
    return { status: res.status, headers: res.headers, body };
  }

  /** GET every page of a list endpoint, up to `pages` pages. */
  async list(url, { pages = 5, params = {} } = {}) {
    const u = new URL(url.startsWith('/') ? API + url : url);
    u.searchParams.set('per_page', '100');
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
    let next = u.toString();
    const out = [];
    for (let i = 0; i < pages && next; i++) {
      const r = await this.get(next);
      if (Array.isArray(r.body)) out.push(...r.body);
      const link = r.headers.get('link') || '';
      const m = /<([^>]+)>;\s*rel="next"/.exec(link);
      next = m ? m[1] : null;
    }
    return out;
  }
}
