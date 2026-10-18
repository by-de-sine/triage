// twenty-api.js — Twenty's GraphQL API with an API key, beside github-api.js
// and ha-api.js and the same shape: stdlib `fetch`, no SDK, no dependency.
// Read-only by construction: there is no mutation anywhere in this file, and
// the key it is handed is bound to the *Read-only (API)* role (plan §12.7),
// which would refuse one anyway.
//
// **GraphQL and not REST**, though both answer with the same key. GraphQL
// names every field it wants, so a renamed or removed field is an *error*
// rather than a record that quietly lost its status — and a quiet loss is
// exactly the failure this source exists to rule out. It also lets one read
// leave out the bodies, which are nine tenths of the bytes (below).
//
// **Not `/mcp`.** That endpoint is the agents' interface and speaks OAuth;
// an unattended reader holds its own key instead.
//
// Every list read is paged and says whether it saw the whole set: a page
// cap reached is `complete: false`, never a short list passed off as all of
// it — the reconcile contract (plan §12.2) rests on that flag.
export class TwentyError extends Error {
  constructor(message, { status = null, cause = null } = {}) {
    super(message);
    this.status = status;
    if (cause) this.cause = cause;
  }
}

const ACTOR = 'source workspaceMemberId name';
const TARGETS = 'edges { node { targetCompanyId targetPersonId } }';
const TASK = `id title status dueAt assigneeId createdAt updatedAt createdBy { ${ACTOR} } updatedBy { ${ACTOR} } taskTargets { ${TARGETS} }`;
const NOTE = `id title createdAt updatedAt createdBy { ${ACTOR} } updatedBy { ${ACTOR} } noteTargets { ${TARGETS} }`;
const ORDER = 'orderBy: [{ createdAt: AscNullsFirst }, { id: AscNullsFirst }]';

export class TwentyApi {
  constructor({ url, key, accessClientId = null, accessClientSecret = null, fetch: f = globalThis.fetch, timeoutMs = 15_000, pageSize = 100, maxPages = 50, userAgent = 'triage' } = {}) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.key = key || null;
    this.accessClientId = accessClientId;
    this.accessClientSecret = accessClientSecret;
    this.fetch = f;
    this.timeoutMs = timeoutMs;
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    this.userAgent = userAgent;
  }

  get host() { try { return new URL(this.url).host; } catch { return this.url; } }

  /** Where a record opens in Twenty's own UI. */
  link(object, id) { return id ? `${this.url}/object/${object}/${id}` : this.url; }

  /** One query. Any `errors` is a failure, even beside partial `data`: a
   *  half-answered query is how a schema change looks, and reading half of
   *  it as the whole would resolve the other half away. */
  async gql(query, variables = {}) {
    let res;
    try {
      const headers = { authorization: `Bearer ${this.key}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': this.userAgent };
      if (this.accessClientId && this.accessClientSecret) {
        headers['CF-Access-Client-Id'] = this.accessClientId;
        headers['CF-Access-Client-Secret'] = this.accessClientSecret;
      }
      res = await this.fetch(`${this.url}/graphql`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new TwentyError(`twenty: ${this.host} is not answering — ${e.message}`, { cause: e });
    }
    if (res.status >= 300 && res.status < 400) throw new TwentyError(`twenty ${res.status}: redirected instead of answering GraphQL — check the Cloudflare Access policy for ${this.host}`, { status: res.status });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (res.status >= 400 || !body) {
      const why = res.status === 401 || res.status === 403
        ? 'request refused — check the Twenty API key and Cloudflare Access policy'
        : body?.errors?.[0]?.message || body?.message || text.slice(0, 200) || res.statusText;
      throw new TwentyError(`twenty ${res.status}: ${why}`, { status: res.status });
    }
    if (body.errors?.length) throw new TwentyError(`twenty: ${body.errors.map((e) => e.message).join('; ').slice(0, 300)}`, { status: res.status });
    return body.data;
  }

  /** Every page of one connection. `complete` is false when the page cap
   *  stopped the walk, and only then. */
  async all(field, select, { filter = null, args = '', variables = {} } = {}) {
    const rows = [];
    let after = null;
    const decl = ['$after: String', args].filter(Boolean).join(', ');
    const q = `query(${decl}) { ${field}(first: ${this.pageSize}, after: $after${filter ? `, filter: ${filter}` : ''}, ${ORDER}) { pageInfo { hasNextPage endCursor } edges { node { ${select} } } } }`;
    for (let page = 0; page < this.maxPages; page++) {
      const data = await this.gql(q, { ...variables, after });
      const conn = data?.[field];
      if (!conn || !Array.isArray(conn.edges)) throw new TwentyError(`twenty: ${field} came back without edges`);
      for (const e of conn.edges) rows.push(e.node);
      if (!conn.pageInfo?.hasNextPage) return { rows, complete: true };
      // A next page with no cursor, or the same one again, would re-read
      // from the top and count rows twice: that is a broken read, not a
      // short one.
      const next = conn.pageInfo.endCursor;
      if (!next || next === after) throw new TwentyError(`twenty: ${field} says there is another page but gave no new cursor`);
      after = next;
    }
    return { rows, complete: false };
  }

  members() { return this.all('workspaceMembers', 'id userEmail name { firstName lastName }'); }
  companies() { return this.all('companies', 'id name'); }
  people() { return this.all('people', 'id companyId'); }

  /** Every open task, and any task touched since `since` whatever its status
   *  — the second half is how a task somebody else marked Done is seen
   *  doing it, rather than simply vanishing. No bodies: see `bodies`. */
  tasks({ since = null } = {}) {
    const open = '{ status: { neq: DONE } }, { status: { is: NULL } }';
    return since
      ? this.all('tasks', TASK, { filter: `{ or: [${open}, { updatedAt: { gte: $since } }] }`, args: '$since: DateTime', variables: { since } })
      : this.all('tasks', TASK, { filter: `{ or: [${open}] }` });
  }

  notes() { return this.all('notes', NOTE); }

  /** The markdown bodies of the named records, by id. Asked only for what
   *  changed since the last read — a body is most of a record's bytes, and
   *  an unchanged `updatedAt` is an unchanged body. */
  async bodies(field, ids = []) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += this.pageSize) {
      const chunk = ids.slice(i, i + this.pageSize);
      const { rows } = await this.all(field, 'id bodyV2 { markdown }', { filter: '{ id: { in: $ids } }', args: '$ids: [UUID!]', variables: { ids: chunk } });
      for (const r of rows) out.set(r.id, r.bodyV2?.markdown ?? '');
    }
    return out;
  }
}
