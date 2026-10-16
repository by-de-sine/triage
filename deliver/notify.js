// notify.js — the webhook half of delivery (plan §16, G2): one client that
// POSTs JSON to one URL, the shape picked by `TRIAGE_NOTIFY` — `slack` (an
// incoming webhook), `discord` (a channel webhook), `generic` (any endpoint
// that takes JSON) — and the mention grammar each endpoint notifies on.
// The windows, the guards and the answer on every decision row are
// `deliver/slack.js`, which is the same for the app and for every webhook;
// the messages themselves are `deliver/messages.js`.
//
// A webhook can post and cannot redraw what it posted, so:
//   - the *first* alarm for an item is never held — it goes the moment the
//     verdict lands, and that send opens the coalesce window;
//   - anything further on the same item inside the window is **held**
//     rather than dropped, and goes out once, as one follow-up, when the
//     window ends — holding keeps the newer information, dropping loses it;
//   - a message stands as sent; acting on an item drops what is held for
//     it and rewrites nothing.
//
// **The URL is the credential.** It carries no scopes, cannot be narrowed,
// and anyone holding it can post to that channel — so it never goes into
// the store, a log line, an error message or the API; `describe()` and the
// boot log get the host and nothing else.

import { isLoopback } from '../lib/util.js';

export const MODES = ['off', 'slack', 'discord', 'generic'];

/** How long a post may take before it is abandoned. `deliver` is awaited
 *  by the pipeline, which is awaited by the poll, so a webhook that accepts
 *  the connection and never answers would stall the runner. Abandoned,
 *  never retried: an ambiguous POST may well have been accepted, and a
 *  duplicate alarm is worse than a late one. */
export const TIMEOUT_MS = 10_000;

/** Which shape a URL implies when `TRIAGE_NOTIFY` is unset: Slack's and
 *  Discord's hosts are known; anything else takes the generic JSON. */
export function inferMode(url) {
  if (!url) return 'off';
  if (/(^|\.)discord(app)?\.com$/i.test(hostOf(url))) return 'discord';
  if (/(^|\.)slack\.com$/i.test(hostOf(url))) return 'slack';
  return 'generic';
}
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

/** `https://hooks.slack.com/services/T…/B…/x…` -> `hooks.slack.com`. Never
 *  the path: that is the secret half. */
export function webhookHost(url) { try { return new URL(url).host; } catch { return 'invalid url'; } }

/** Who an interrupt names, so the far end *notifies* rather than badges
 *  (plan §14.1). Slack: a user id (`U…`/`W…`), a user group (`S…`), `!here`,
 *  `!channel`, or those in Slack's `<…>` markup. Discord: a user id (`<@123>`
 *  or bare digits), a role (`<@&123>`), `@here`, `@everyone`. Generic: any
 *  text, passed through. Anything else is refused at boot — a bare name
 *  would render as a word and notify nobody, which is the bug §14.1 was —
 *  and `off` means nobody, on purpose. */
export function parseMention(mode, v) {
  const m = String(v ?? '').trim();
  if (!m || m.toLowerCase() === 'off') return null;
  if (mode === 'discord') {
    if (/^<@&?\d+>$/.test(m)) return m;
    if (/^\d+$/.test(m)) return `<@${m}>`;
    if (/^@?(here|everyone)$/i.test(m)) return `@${m.replace(/^@/, '').toLowerCase()}`;
    throw new Error(`TRIAGE_MENTION: "${m}" is not something Discord notifies on — a user id, <@id>, <@&role>, @here, @everyone, or off`);
  }
  if (mode === 'generic') return m;
  // Slack, and the default: the grammar `TRIAGE_MENTION` has always had.
  if (/^<@[UW][A-Z0-9]+>$/i.test(m)) return m.toUpperCase();
  if (/^<!subteam\^S[A-Z0-9]+>$/i.test(m)) return m;
  if (/^<!(here|channel)>$/i.test(m)) return m.toLowerCase();
  if (/^!(here|channel)$/i.test(m)) return `<${m.toLowerCase()}>`;
  if (/^[UW][A-Z0-9]+$/i.test(m)) return `<@${m.toUpperCase()}>`;
  if (/^S[A-Z0-9]+$/i.test(m)) return `<!subteam^${m.toUpperCase()}>`;
  throw new Error(`TRIAGE_MENTION: "${m}" is not something Slack notifies on — a user id (U…/W…), a user group (S…), !here, !channel, or off`);
}

// `isLoopback` lives in lib/util.js (the calendar's feed asks it too) and is
// re-exported here, where the webhook's callers have always found it.
export { isLoopback };

/** Failure reasons Slack and Discord send that are safe to repeat; any
 *  other body is untrusted text that would land in a log line, and is
 *  counted, not quoted. */
const KNOWN_REASONS = new Set(['invalid_payload', 'user_not_found', 'channel_is_archived', 'action_prohibited', 'posting_to_general_channel_denied', 'too_many_requests', 'no_service', 'no_team', 'team_disabled', 'invalid_token', 'channel_not_found']);

/** One webhook URL, and one `post(payload)`. Answers `{ ok, id: null }`:
 *  no endpoint here returns a message id, which is what keeps
 *  `deliveries.message_ts` empty in this mode and why nothing can be
 *  updated later. A redirect is an error, never followed: fetch would
 *  carry the body — private work — to wherever a 307 pointed, http
 *  included. `confirm` asks the endpoint to answer only once the message
 *  is saved (Discord's `wait=true`; by default it answers before it is,
 *  and a lost message would read as sent). */
export function webhookClient(url, { fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, name = 'TRIAGE_WEBHOOK_URL', confirm = false } = {}) {
  if (!url) throw new Error('webhookClient: no URL');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`${name} is not a URL (host only, never the path, is ever logged)`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${name} must be http(s), not ${parsed.protocol}`);
  if (parsed.protocol === 'http:' && !isLoopback(url)) {
    throw new Error(`${name} must be https for ${parsed.hostname} — plain http is only for a local listener on 127.0.0.1, because the URL is the credential and the payload is the contents of private work`);
  }
  const target = new URL(url);
  if (confirm) target.searchParams.set('wait', 'true');
  return {
    host: parsed.host,
    async post(payload) {
      const res = await fetch(target.toString(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      const body = (await res.text().catch(() => '')).trim();
      if (!res.ok) {
        const reason = KNOWN_REASONS.has(body) ? body : `${body.length} bytes not recognised as a known reason`;
        throw new Error(`webhook ${parsed.host}: HTTP ${res.status} — ${reason}`);
      }
      return { ok: true, id: null };
    },
  };
}
