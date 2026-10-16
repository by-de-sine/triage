// ha-api.js — fetch against Home Assistant's REST API with a long-lived
// access token, beside github-api.js and google-api.js and the same shape:
// stdlib `fetch`, no SDK, no dependency. Two calls, both service calls:
//
//   todo.get_items     the whole of one list, as a service *response*
//                      (`?return_response=true`), which is the only way to
//                      read a to-do list — the entity's state is a count,
//                      not its items.
//   todo.update_item   `status: completed` on one item. The one write.
//
// **REST and not the WebSocket API**, though both can carry a service call
// with a response. The WebSocket is a stateful connection with an auth
// handshake, per-message ids, a reconnect loop and a queue of in-flight
// calls to own — machinery this source would use twice a minute, for reads
// that are idempotent and tiny. A source that is down for a minute is one
// failed poll and nothing else, so nothing here earns a persistent socket;
// what it earns is a request that either answers or does not. If a future
// source wants to *watch* state change (`subscribe_events`), that is the
// argument for the socket, and it can be made then.
//
// The credential is one long-lived access token, minted from the HA profile
// page and put in the `.env` as `HA_TOKEN` with `HA_URL` beside it. It is a
// bearer token with the rights of the user who made it, so it can do far
// more than read two lists — Home Assistant has no narrower grant — which is
// exactly why the only write in this tree is `complete()` below.
export class HaError extends Error {
  constructor(message, { status = null, url = null, cause = null } = {}) {
    super(message);
    this.status = status;
    this.url = url;
    if (cause) this.cause = cause;
  }
}

export const STATUSES = ['needs_action', 'completed'];

export class HaApi {
  constructor({ url, token, fetch: f = globalThis.fetch, timeoutMs = 15_000, userAgent = 'triage' } = {}) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.token = token || null;
    this.fetch = f;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
  }

  get host() { try { return new URL(this.url).host; } catch { return this.url; } }
  get authorized() { return !!(this.url && this.token); }

  /** `POST /api/services/<domain>/<service>`, with the service's own
   *  response when it has one. A service that returns a response must be
   *  asked for it explicitly — without `?return_response=true` Home
   *  Assistant answers 400 for a `SupportsResponse.ONLY` service rather
   *  than silently returning nothing, which is the failure mode worth
   *  having. */
  async call(domain, service, data = {}, { response = false } = {}) {
    const url = `${this.url}/api/services/${domain}/${service}${response ? '?return_response=true' : ''}`;
    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': this.userAgent },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // The likeliest cause by a distance is that this box cannot reach that
      // one, so say which box and which address rather than `fetch failed`.
      throw new HaError(`home assistant: ${this.host} is not answering — ${e.message}`, { url, cause: e });
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (res.status >= 400) {
      const why = res.status === 401
        ? 'the token was refused — HA_TOKEN must be a long-lived access token (Profile → Security → Long-lived access tokens)'
        : body?.message || (typeof body === 'string' ? body.slice(0, 200) : null) || res.statusText;
      throw new HaError(`home assistant ${res.status} on ${domain}.${service}: ${why}`, { status: res.status, url });
    }
    return body;
  }

  /** Every item on one list, whatever its status. The status filter is
   *  passed rather than left out: the service's *documented* default is
   *  `needs_action`, and while today's implementation returns everything
   *  when the field is absent, a read that means "the whole list" should
   *  say so rather than rest on which of the two is true this release. */
  async items(entityId) {
    const body = await this.call('todo', 'get_items', { entity_id: entityId, status: [...STATUSES] }, { response: true });
    const r = body?.service_response?.[entityId];
    if (!r || !Array.isArray(r.items)) throw new HaError(`home assistant: ${entityId} returned no items — is it a to-do list entity?`, { url: this.url });
    return r.items;
  }

  /** The one write: tick an item off, by uid, on its own list. */
  async complete(entityId, uid) {
    await this.call('todo', 'update_item', { entity_id: entityId, item: uid, status: 'completed' });
    return true;
  }
}
