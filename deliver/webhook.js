// webhook.js — the delivery client for `TRIAGE_SLACK=webhook`, and the
// thing that finally makes a P0 arrive. Since M0 every P0 the system ever
// decided has been logged `not delivered: slack not configured`, because
// delivery meant a Slack app and there was none. An incoming webhook needs
// no app to configure, no manifest, no app-level token, no socket and no
// scopes: one URL, and it posts (plan §9 item 2, §11.6).
//
// **It has the same surface `deliver/slack.js` already calls**, so nothing
// above it changes shape and `deliver/blocks.js` is not forked — an
// incoming webhook takes the very same `{text, blocks}` payload
// `chat.postMessage` does, so every message the tests already cover renders
// unchanged. What a webhook cannot do is the interesting half:
//
//   chat.postMessage   posts. The whole of what a webhook is.
//   chat.update        throws. A posted message cannot be redrawn — there
//                      is no `ts` to name and no scope to do it with. The
//                      callers that would have (coalescing, saying what
//                      you did) are answered in
//                      slack.js, per §11.6; this throw is the backstop for
//                      a caller that has not been.
//   views.publish      throws. No Home tab; a webhook has no app surface.
//
// Both throws say "not available on a webhook" rather than failing
// obscurely at Slack's end with a 400 and a one-word body.
//
// **The URL is the credential.** It carries no scopes, cannot be narrowed,
// and anyone holding it can post to that channel — so it never goes into
// the store, a log line, an error message or `/api/decisions`. `describe()`
// and the boot log get the host and nothing else, and a delivery row says
// `webhook` where a DM would have said its channel id.

/** `https://hooks.slack.com/services/T…/B…/x…` -> `hooks.slack.com`. Never
 *  the path: that is the secret half. */
export function webhookHost(url) {
  try { return new URL(url).host; } catch { return 'invalid url'; }
}

const notAvailable = (call, why) =>
  new Error(`${call} is not available on a webhook: ${why} (TRIAGE_SLACK=webhook — plan §11.6; TRIAGE_SLACK=app keeps the Bolt path)`);

/** How long a post may take before it is abandoned. `SlackDelivery.deliver`
 *  is awaited by the pipeline, which is awaited by the poll, so a webhook
 *  that accepts the connection and never answers would stall the runner —
 *  Node's fetch has no deadline of its own. Abandoned, never retried: an
 *  ambiguous POST may well have been accepted, and a duplicate alarm is
 *  worse than a late one. */
export const TIMEOUT_MS = 10_000;

/** Hosts allowed to be plain `http:`. A worktree proves delivery against a
 *  listener it starts on 127.0.0.1 (AGENTS.md), and that is the only reason
 *  http exists here; anything else must be https, because the URL is the
 *  credential and the payload is the contents of private work. Syntactic on
 *  purpose — no DNS lookup, so nothing here can be steered by a resolver. */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|0:0:0:0:0:0:0:1)$/i;

/** Slack's own failure reasons, which are safe to repeat. Anything else a
 *  remote end returns is untrusted text that would land in a log line. */
const SLACK_REASONS = new Set(['invalid_payload', 'user_not_found', 'channel_is_archived', 'action_prohibited',
  'posting_to_general_channel_denied', 'too_many_requests', 'no_service', 'no_team', 'team_disabled', 'invalid_token']);

/** A Slack-client stand-in that owns one incoming webhook URL.
 *
 *  `postMessage` returns the shape the caller expects — `{ ok, channel, ts }`
 *  — with `ts: null`, because a webhook's response is the literal body `ok`
 *  and carries no message id. That null is load-bearing rather than a
 *  placeholder: it is why `deliveries.message_ts` stays empty in this mode
 *  and why `store.lastSent()` (which requires one) finds nothing to update. */
export function webhookClient(url, { fetch = globalThis.fetch, channel = 'webhook', timeoutMs = TIMEOUT_MS } = {}) {
  if (!url) throw new Error('webhookClient: no URL');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`SLACK_WEBHOOK_URL is not a URL (host only, never the path, is ever logged)`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`SLACK_WEBHOOK_URL must be http(s), not ${parsed.protocol}`);
  // URL.hostname keeps the brackets on an IPv6 literal: `[::1]`, not `::1`.
  if (parsed.protocol === 'http:' && !LOOPBACK.test(parsed.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error(`SLACK_WEBHOOK_URL must be https for ${parsed.hostname} — plain http is only for a local listener on 127.0.0.1, because the URL is the credential and the payload is the contents of private work`);
  }

  return {
    host: parsed.host,
    chat: {
      /** The blocks, to the URL. `channel` is accepted and dropped: a
       *  webhook posts to the one channel it was created for and Slack
       *  ignores any override, so honouring it would be a lie. */
      async postMessage({ channel: _ignored, ...payload } = {}) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = (await res.text().catch(() => '')).trim();
        // Slack answers a good post with 200 and the body `ok`; a bad one
        // with 4xx and a one-word reason. The reason is worth repeating —
        // `channel_is_archived` is the difference between a bug and a
        // Slack-side fix — but **only from the known set**: the body is
        // whatever the far end chose to send, this message reaches the
        // journal, and a proxy or a misconfigured endpoint could put
        // anything in it, control characters and secrets included. An
        // unrecognised body is counted, not quoted.
        if (!res.ok) {
          const reason = SLACK_REASONS.has(body) ? body : `${body.length} bytes not recognised as a Slack reason`;
          throw new Error(`webhook ${parsed.host}: HTTP ${res.status} — ${reason}`);
        }
        return { ok: true, channel, ts: null, body: body === 'ok' ? 'ok' : null };
      },
      update() { throw notAvailable('chat.update', 'an incoming webhook can only post a new message, never redraw one'); },
    },
    views: {
      publish() { throw notAvailable('views.publish', 'an incoming webhook has no app surface, so there is no Home tab'); },
    },
  };
}
