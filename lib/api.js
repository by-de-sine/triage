// api.js — the HTTP surface (plan §6), bound to 127.0.0.1 and published by
// Caddy:
//
//   GET  /                       the list page (public/, no build)
//   GET  /api/items              ?tier=&state=&source=&since=&user=&order=&limit=
//   GET  /api/items/:id          one item with its events, decisions, actions, deliveries
//   POST /api/items/:id/act      {action: done|snooze|later|mute|open|answer|seen, until?, choice?, by?}
//   GET  /api/lists              ?group=&tier=&repo=&source=&owner=&q=&limit= — the one ordered list, plus snoozed and later
//   GET  /api/aggregates         ?state= — the queue as counts: by source, repo, rule, tier, kind, age; the rank spread
//   GET  /api/reports            the reports there are, and what each answers (plan §15)
//   GET  /api/reports/:name      ?since=&until=&bucket=hour|day|week&by=&source= — one report over a window
//   GET  /stats                  the reports page (public/stats.html, no build)
//   GET  /api/rank               the weights, the time shapes, the interrupt set, what is unranked
//   GET  /api/interrupts         the resolved layers; ?source=&rule=&project=|&item= answers one
//   POST /api/rank/backfill      ?all=&limit= — rank what the ranker has never seen (M5)
//   GET  /api/sources            registered sources, cursors, health
//   POST /api/sources/:name/run  poll now
//   GET  /api/decisions          ?tier=&rule=&by=&item=&since=&delivered=&limit=
//   GET  /healthz               ok, when it started, and what commit is running
//
// Writes come from curl, a Claude Code session, the Slack app (which does
// not pass through here) or the page. A browser sends Origin on every
// cross-site POST, so a foreign page on the LAN is turned away; curl sends
// none and is let in — the zone, not a token, is the boundary, as on nerve.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIERS, STATES } from './store.js';
import { lists, GROUP_BY, FILTERS } from './lists.js';
import { aggregates } from './aggregates.js';
import { report, describeReports } from './reports.js';
import { backfill } from './backfill.js';

const STARTED = new Date().toISOString();
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

export function createApp({ store, runner, deliver = null, act = null, rank = null, rules = {}, user, identity = {}, commit = null, tz = 'UTC', log = () => {} }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const q = url.searchParams;
    const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    const fail = (code, error) => send(code, { error });
    try {
      if (p === '/healthz') {
        const runs = store.runs();
        const failing = Object.values(runs).filter((r) => !r.ok).map((r) => r.source);
        // When each source last read successfully, for the page to print:
        // "failing" says a source is broken *now*, and only this says how
        // long it has been since anything was actually read.
        const read = Object.fromEntries(Object.values(runs).map((r) => [r.source, { ok: r.ok, ok_at: r.ok_at || null, error: r.ok ? null : r.error || null }]));
        return send(200, { ok: true, started: STARTED, commit, user, identity, sources: Object.keys(runs).length, failing, read, slack: deliver ? deliver.describe() : null, ...store.counts() });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return fail(403, 'cross-origin writes are refused');

      if (p === '/api/items' && req.method === 'GET') {
        const tier = q.get('tier'), state = q.get('state');
        if (tier && !TIERS.includes(tier)) return fail(400, `tier must be one of ${TIERS.join(', ')}`);
        if (state && !STATES.includes(state)) return fail(400, `state must be one of ${STATES.join(', ')}`);
        const order = q.get('order');
        if (order && !['rank', 'score'].includes(order)) return fail(400, 'order must be rank or score');
        // M5: the rank is the product, so it is the default order here; the
        // tier's own ordering is still one query string away.
        //
        // The read path re-times the rows it fetched, so the LIMIT cannot be
        // the SQL's: an item just below the cut can gain enough time to
        // belong on the page, and the page would never have seen it. Fetch
        // deeper, order, then cut — bounded, because this is still a read.
        const want = Math.min(Math.max(1, parseInt(q.get('limit') || '200', 10) | 0), 1000);
        const live = rank && order !== 'score';
        const items = store.items({ user: q.get('user') || user, tier: tier || undefined, state: state || undefined, source: q.get('source') || undefined, since: q.get('since') || undefined, order: order || 'rank', limit: live ? Math.min(want * 4, 1000) : want });
        return send(200, { items: live ? rank.order(items).slice(0, want) : items });
      }
      let m;
      if ((m = /^\/api\/items\/(\d+)$/.exec(p)) && req.method === 'GET') {
        const it = store.item(parseInt(m[1], 10));
        if (!it) return fail(404, `no item ${m[1]}`);
        return send(200, { item: it, events: store.events(it.id), decisions: store.decisionsFor(it.id), actions: store.actionsFor(it.id), deliveries: store.deliveriesFor(it.id) });
      }
      if ((m = /^\/api\/items\/(\d+)\/act$/.exec(p)) && req.method === 'POST') {
        if (!act) return fail(503, 'acting is not wired up');
        let body;
        try { body = await readBody(req); } catch (e) { return fail(e.status || 400, e.message); }
        if (!body || typeof body.action !== 'string') return fail(400, 'action (string) is required');
        try {
          const r = await act({ id: parseInt(m[1], 10), action: body.action, until: body.until, choice: body.choice, by: typeof body.by === 'string' && body.by ? body.by.slice(0, 40) : 'api' });
          return send(200, { ok: true, ...r });
        } catch (e) {
          if (e.status) return fail(e.status, e.message);
          throw e;
        }
      }
      if (p === '/api/lists' && req.method === 'GET') {
        const group = q.get('group');
        if (group && !GROUP_BY[group]) return fail(400, `group must be one of ${Object.keys(GROUP_BY).join(', ')}`);
        // The narrowing the page's tiles, tags and search box send. A tier
        // nobody has heard of is refused, as it is on /api/items.
        const filter = Object.fromEntries(FILTERS.map((k) => [k, (q.get(k) || '').trim()]).filter(([, v]) => v));
        if (filter.tier && !TIERS.includes(filter.tier)) return fail(400, `tier must be one of ${TIERS.join(', ')}`);
        const limit = q.get('limit') ?? '25';
        if (!/^[1-9]\d*$/.test(limit)) return fail(400, 'limit must be a positive integer');
        return send(200, lists(store, { user: q.get('user') || user, limit: Math.min(Number(limit), 500), group: group || null, filter, rank }));
      }
      // §13.6: the queue as counts, for a program that would otherwise
      // reconstruct them from fifty rows. Its own route, not a view on
      // /api/lists — see lib/aggregates.js for why.
      if (p === '/api/aggregates' && req.method === 'GET') {
        const state = q.get('state') || 'open';
        if (state !== 'all' && !STATES.includes(state)) return fail(400, `state must be all or one of ${STATES.join(', ')}`);
        return send(200, aggregates(store, { user: q.get('user') || user, state, rank }));
      }
      // Plan §15: the store over time. A registry of named reports, each one
      // read over a window and bucketed in the configured zone; the page at
      // /stats draws them. Its own routes beside /api/aggregates for the same
      // reason that one is beside /api/lists: now-as-counts and over-time are
      // different questions with different shapes.
      if (p === '/api/reports' && req.method === 'GET') return send(200, describeReports());
      if ((m = /^\/api\/reports\/([a-z]+)$/.exec(p)) && req.method === 'GET') {
        try {
          const opts = { user: q.get('user') || user, identity, since: q.get('since') || null, until: q.get('until') || null, bucket: q.get('bucket') || 'day', tz };
          if (q.get('by')) opts.by = q.get('by');
          if (q.get('source')) opts.source = q.get('source');
          return send(200, report(store, m[1], opts));
        } catch (e) {
          if (e.status) return fail(e.status, e.message);
          throw e;
        }
      }
      // M5: what the order is made of, and the one bootstrap that gives the
      // backlog a rank at all (plan §11.8). The POST is idempotent — it
      // walks only what has never been ranked unless `?all=1` says otherwise.
      if (p === '/api/rank' && req.method === 'GET') {
        return send(200, { ...(rank ? rank.describe() : { enabled: false }), interrupts: deliver ? deliver.interruptMap : null, unranked: store.countUnranked(q.get('user') || user) });
      }
      // Plan §14.6: the configuration explaining itself, which is the half
      // that decides whether anybody can actually use it. Bare, it is every
      // statement grouped by the layer it came from, in the order they are
      // applied, plus the effective global set. With `?source=&rule=` it is
      // the one-shot question — would *this* interrupt, and which statement
      // says so — which is what bin/replay.js does for rules, for delivery.
      if (p === '/api/interrupts' && req.method === 'GET') {
        if (!deliver) return fail(503, 'delivery is not wired up');
        const set = deliver.interruptSet;
        const resolved = typeof set?.describe === 'function' ? set.describe() : { set, layers: [], always: [] };
        const body = { ...resolved, projects: Object.keys(deliver.projects), mention: deliver.webhook ? deliver.mention : null };
        const [source, rule] = [q.get('source'), q.get('rule')];
        if (!source && !rule) return send(200, body);
        if (!source || !rule) return fail(400, 'ask with both source and rule, or with neither');
        // The project may be named outright, or taken from an item — `?item=12`
        // asks the source itself, which is the only thing that knows. One or
        // the other: answering with `project` and ignoring `item` would be a
        // quiet answer to a question nobody asked.
        if (q.get('item') && q.get('project') != null) return fail(400, 'ask with project or item, not both');
        const item = q.get('item') ? store.item(parseInt(q.get('item'), 10)) : null;
        if (q.get('item') && !item) return fail(404, 'no such item');
        const project = q.get('project') ?? (item ? deliver.projectOf(item, source) : null);
        const answer = typeof set?.allows === 'function' ? set.allows(source, rule, project) : { allow: deliver.interrupts(source, rule), by: 'TRIAGE_INTERRUPT' };
        return send(200, { ...body, asked: { source, rule, project: project || null, item: item?.key ?? null }, ...answer });
      }
      if (p === '/api/rank/backfill' && req.method === 'POST') {
        if (!rank) return fail(503, 'ranking is not wired up');
        return send(200, backfill(store, { user: q.get('user') || user, identity, rules, rank, all: q.get('all') === '1', limit: parseInt(q.get('limit') || '500', 10), log }));
      }
      if (p === '/api/sources' && req.method === 'GET') return send(200, { sources: runner.describe() });
      if ((m = /^\/api\/sources\/([a-z]+)\/run$/.exec(p)) && req.method === 'POST') {
        if (!runner.sources.has(m[1])) return fail(404, `no source ${m[1]}`);
        const r = await runner.run(m[1]);
        return send(r.ok ? 200 : 502, r);
      }

      if (p === '/api/decisions' && req.method === 'GET') {
        const tier = q.get('tier');
        if (tier && !TIERS.includes(tier)) return fail(400, `tier must be one of ${TIERS.join(', ')}`);
        const delivered = q.get('delivered');
        const by = q.get('by');
        if (by && !['rule', 'wake'].includes(by)) return fail(400, 'by must be rule or wake');
        const item = q.get('item');
        if (item != null && item !== '' && !/^\d+$/.test(item)) return fail(400, 'item must be a numeric id');
        return send(200, { decisions: store.decisions({ tier: tier || undefined, rule: q.get('rule') || undefined, by: by || undefined, item_id: item ? parseInt(item, 10) : undefined, since: q.get('since') || undefined, delivered: delivered == null ? undefined : delivered === '1' || delivered === 'true', limit: parseInt(q.get('limit') || '200', 10) }) });
      }
      if (p.startsWith('/api/')) return fail(404, `no route ${req.method} ${p}`);
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'method not allowed');

      // Static: the page is one HTML file, one stylesheet, one script, and
      // the fonts nerve vendored.
      const rel = p === '/' ? 'index.html' : p === '/stats' ? 'stats.html' : p.slice(1);
      const file = path.join(PUBLIC, path.normalize(rel));
      if (!file.startsWith(PUBLIC + path.sep)) return fail(403, 'no');
      try {
        await stat(file);
        return send(200, await readFile(file), MIME[path.extname(file)] || 'application/octet-stream');
      } catch { return send(404, 'not found', 'text/plain'); }
    } catch (e) {
      log(`${req.method} ${p}: ${e.stack || e}`);
      return fail(500, String(e.message || e));
    }
  };
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;             // curl, a session, a script
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  return host === req.headers.host || host === (req.headers['x-forwarded-host'] || '');
}

/** The JSON body, {} when empty, null when unparseable. Past `max` bytes
 *  the rest is drained and dropped, and the caller answers 413 — the
 *  connection stays open so that answer actually arrives. */
function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '', over = false;
    req.on('data', (c) => { if (over) return; data += c; if (data.length > max) { over = true; data = ''; } });
    req.on('end', () => {
      if (over) return reject(Object.assign(new Error(`body larger than ${max} bytes`), { status: 413 }));
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    req.on('error', reject);
  });
}
