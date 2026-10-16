// google-api.js — fetch against Google's Calendar API with an OAuth refresh
// token, beside github-api.js and the same shape: stdlib `fetch`, no SDK.
// The `googleapis` package is 100 MB of generated clients for one endpoint
// (`events.list`) and one grant type (refresh_token), and the OAuth dance
// here is a form POST — nothing about it needs a library (plan §5; the
// decision is recorded in the M3 note in docs/plan.md).
//
// Credentials are two files beside the .env (~/.config/triage/ by default),
// both created by hand once and neither ever in the repo:
//
//   google-oauth.json   the OAuth *desktop client* downloaded from the Cloud
//                       console — {"installed": {client_id, client_secret, …}}
//   google-token.json   {refresh_token, scope, obtained} — written once by
//                       bin/google-consent.js after the browser step
//
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN in the env
// override both, so a worktree can be pointed somewhere else without files.
// The scope is read-only on purpose: triage never writes to your calendar,
// so Done on a calendar item is local and says so (lib/actions.js).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HOME } from './util.js';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
export const CONFIG_DIR = path.join(HOME, '.config', 'triage');

/** A Google API error that kept its HTTP status and reason. 410 (the sync
 *  token has aged out) and 401 (the access token has) are both normal and
 *  are handled rather than logged as faults. */
export class GoogleError extends Error {
  constructor(message, { status, reason = null, url = null } = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.url = url;
  }
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/** The client id, secret and refresh token, from the environment first and
 *  the two files after. Returns null when the refresh token is missing —
 *  which is the normal state until the consent flow has been run once, and
 *  is why the source registers as `off` rather than failing every poll. */
export function readCredentials({ clientId = null, clientSecret = null, refreshToken = null, clientFile = path.join(CONFIG_DIR, 'google-oauth.json'), tokenFile = path.join(CONFIG_DIR, 'google-token.json') } = {}) {
  let id = clientId, secret = clientSecret, refresh = refreshToken;
  // The client id and its secret are one credential and come from one place.
  // Reading the file to fill in a missing secret beside an id from the
  // environment would pair halves of two different clients, and Google's
  // answer to that is `invalid_client`, which reads like the file is wrong.
  if (!id) {
    const c = readJson(clientFile);
    const inst = c?.installed || c?.web || c;
    if (inst?.client_id) { id = inst.client_id; secret = inst.client_secret || null; }
  }
  if (!refresh) refresh = readJson(tokenFile)?.refresh_token || null;
  if (!id || !refresh) return null;
  return { clientId: id, clientSecret: secret, refreshToken: refresh };
}

export class GoogleApi {
  constructor({ clientId, clientSecret = null, refreshToken, fetch: f = globalThis.fetch, timeoutMs = 30_000, userAgent = 'triage', now = () => Date.now() } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.fetch = f;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this.now = now;
    this.access = null;     // { token, expires } — held in memory only
    this.refreshing = null; // concurrent callers share one refresh
  }

  get authorized() { return !!(this.clientId && this.refreshToken); }

  /** A live access token, refreshed a minute before it lapses. Google's
   *  refresh tokens do not expire on a published app; on one still in
   *  *Testing* they last seven days, which is why the queue row says to
   *  publish it. */
  token({ force = false } = {}) {
    if (!force && this.access && this.access.expires > this.now() + 60_000) return Promise.resolve(this.access.token);
    if (this.refreshing) return this.refreshing;
    const body = new URLSearchParams({ client_id: this.clientId, refresh_token: this.refreshToken, grant_type: 'refresh_token' });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    this.refreshing = (async () => {
      const res = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': this.userAgent }, body: body.toString(), signal: AbortSignal.timeout(this.timeoutMs) });
      const text = await res.text();
      let out = null; try { out = JSON.parse(text); } catch { /* an HTML error page */ }
      if (!res.ok || !out?.access_token) {
        // `invalid_grant` is the one worth naming: the consent was revoked,
        // the token aged out in Testing, or the client was deleted.
        const why = out?.error === 'invalid_grant'
          ? 'invalid_grant — the refresh token is dead: re-run bin/google-consent.js (and publish the OAuth app, or a Testing one expires weekly)'
          : `${out?.error || res.status}${out?.error_description ? ': ' + out.error_description : ''}`;
        throw new GoogleError(`google: token refresh failed — ${why}`, { status: res.status, reason: out?.error || null, url: TOKEN_URL });
      }
      this.access = { token: out.access_token, expires: this.now() + (out.expires_in || 3600) * 1000 };
      return out.access_token;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** GET one path (relative to the Calendar API) or absolute URL. A 401 is
   *  retried once with a forced refresh — an access token can lapse between
   *  the check and the call. */
  async get(url, { params = {}, retry = true } = {}) {
    const u = new URL(url.startsWith('http') ? url : CALENDAR_API + url);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
    const token = await this.token();
    const res = await this.fetch(u.toString(), { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': this.userAgent }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 401 && retry) { this.access = null; await this.token({ force: true }); return this.get(url, { params, retry: false }); }
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (res.status >= 400) {
      const err = body?.error;
      const reason = err?.errors?.[0]?.reason || err?.status || null;
      throw new GoogleError(`Google ${res.status} on GET ${u.pathname}: ${err?.message || body || res.statusText}`, { status: res.status, reason, url: u.toString() });
    }
    return body;
  }

  /** Every page of a list endpoint. Returns the items plus the response's
   *  own bookkeeping — `nextSyncToken` is on the *last* page only, and a
   *  walk cut short by `pages` must not pretend it saw one. */
  async list(url, { params = {}, pages = 20 } = {}) {
    const items = [];
    let pageToken = null, syncToken = null, complete = false, calls = 0;
    for (let i = 0; i < pages; i++) {
      const body = await this.get(url, { params: { ...params, pageToken } });
      calls++;
      if (Array.isArray(body?.items)) items.push(...body.items);
      pageToken = body?.nextPageToken || null;
      syncToken = body?.nextSyncToken || null;
      if (!pageToken) { complete = true; break; }
    }
    return { items, syncToken: complete ? syncToken : null, complete, calls };
  }
}
