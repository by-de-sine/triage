// store.js — the one thing triage writes: its own SQLite file.
//
// Four tables carry the design (plan §2): `items` are the units of attention,
// one per GitHub thread (later: calendar event, mail thread); `events` is
// what happened on each, append-only and keyed so a poll can never insert
// the same thing twice; `decisions` is every rule verdict, including the
// P1–P3 ones nothing is sent for — that log is the dataset the tiers get
// tuned against; `actions` is what the human did (done, snooze, later, mute
// — from the Slack buttons, /api/items/:id/act or the page — plus what the
// system did on its behalf: `wake` when a snooze ends, `reopen` when a done
// or Later item draws a new P0).
//
// Three supporting tables: `cursors` (each source's own poll state, so a
// restart resumes rather than re-reads), `deliveries` (which Slack message
// carries which item, for coalescing), and `source_runs` (health).
//
// Migrations are idempotent SQL run at boot: CREATE IF NOT EXISTS, a column
// list checked against PRAGMA table_info for later additions, and — the
// mirror of it, since plan §13 — a list of what has been removed, dropped
// when PRAGMA table_info says it is still there. A store that has been
// through it boots unchanged; one that has not is converted once.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const TIERS = ['P0', 'P1', 'P2', 'P3'];
export const STATES = ['open', 'snoozed', 'later', 'done', 'muted'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY,
  user          TEXT NOT NULL,
  source        TEXT NOT NULL,
  key           TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  url           TEXT,
  repo          TEXT,
  actors        TEXT NOT NULL DEFAULT '[]',
  my_role       TEXT,
  last_activity TEXT,
  last_seen     TEXT,
  tier          TEXT,
  score         REAL NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'open',
  state_until   TEXT,
  data          TEXT NOT NULL DEFAULT '{}',
  created       TEXT NOT NULL,
  updated       TEXT NOT NULL,
  UNIQUE (user, source, key)
);
CREATE INDEX IF NOT EXISTS items_tier ON items (user, state, tier, score);
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY,
  item_id   INTEGER NOT NULL REFERENCES items (id),
  key       TEXT NOT NULL UNIQUE,
  ts        TEXT NOT NULL,
  seen      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  actor     TEXT,
  body      TEXT,
  url       TEXT,
  data      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_item ON events (item_id, ts);
CREATE TABLE IF NOT EXISTS decisions (
  id        INTEGER PRIMARY KEY,
  item_id   INTEGER NOT NULL REFERENCES items (id),
  ts        TEXT NOT NULL,
  by        TEXT NOT NULL DEFAULT 'rule',
  rule      TEXT NOT NULL,
  tier      TEXT NOT NULL,
  reason    TEXT NOT NULL,
  event_ids TEXT NOT NULL DEFAULT '[]',
  delivered INTEGER NOT NULL DEFAULT 0,
  note      TEXT
);
CREATE INDEX IF NOT EXISTS decisions_item ON decisions (item_id, id);
CREATE INDEX IF NOT EXISTS decisions_ts ON decisions (ts);
CREATE TABLE IF NOT EXISTS actions (
  id      INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items (id),
  ts      TEXT NOT NULL,
  action  TEXT NOT NULL,
  until   TEXT,
  by      TEXT,
  data    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS actions_item ON actions (item_id, id);
CREATE TABLE IF NOT EXISTS cursors (
  source  TEXT PRIMARY KEY,
  ts      TEXT NOT NULL,
  state   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items (id),
  ts         TEXT NOT NULL,
  -- where it went: a DM's channel id under TRIAGE_SLACK=app, the literal
  -- 'webhook' under TRIAGE_SLACK=webhook. Never the webhook URL — that is
  -- the credential, and this row is read back by /api/decisions.
  channel    TEXT NOT NULL,
  -- Slack's message id, which is what a later chat.update names. NULL under
  -- TRIAGE_SLACK=webhook: an incoming webhook answers with the body 'ok' and
  -- no id, and there is nothing to update later anyway (plan §11.6). A row
  -- still gets written, status 'sent' — the item's delivery history is how
  -- coalescing knows a window is open, in either mode.
  message_ts TEXT,
  status     TEXT NOT NULL,
  decision_id INTEGER,
  error      TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_item ON deliveries (item_id, id);
CREATE TABLE IF NOT EXISTS source_runs (
  source   TEXT PRIMARY KEY,
  ok       INTEGER NOT NULL,
  at       TEXT NOT NULL,
  ok_at    TEXT,
  error    TEXT,
  ms       INTEGER,
  runs     INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
);
`;

// Columns added after the first release go here as [table, column, ddl];
// each is applied once, when PRAGMA table_info says it is missing.
const LATER_COLUMNS = [
  // M5: the whole verdict, not just the strongest match (plan §11.3). `rule`,
  // `tier` and `reason` still mean *the strongest match*, so the lists, the
  // batches, the wake path, delivery and bin/replay.js all keep working;
  // this carries the ordered set beside them in the `event_ids` idiom. Empty
  // on every row written before M5, which reads back as the one match that
  // row already names — history is not rewritten and is not lost either.
  ['decisions', 'matches', "TEXT NOT NULL DEFAULT '[]'"],
  // M5: the rank, which is the product (plan §11.1). It is a *second* column
  // rather than a new meaning for `score`, because `score` has four writers
  // and one of its jobs — sinking a Later item beneath everything — is the
  // interrupt path's, not the list's (§11.8, trap 1). `rank_base` is the part
  // that only changes on a material change; the time term is added at read
  // time (§11.4, stability). `features` is every contributing term with its
  // weight and its `why`, which is what makes a blend explainable at all
  // (§11.7 item 2) — and what lets a term be *absent* rather than zero.
  ['items', 'rank', 'REAL'],
  ['items', 'rank_base', 'REAL'],
  ['items', 'rank_at', 'TEXT'],
  ['items', 'features', 'TEXT'],
];

// What has been taken out of the store, in the order it has to go — plan
// §13's removal, and (2026-09-12, §11.3) the P1 batch and the P2 digest,
// whose two cursors are the only thing they left behind. The LLM's verdicts
// were logged-only by construction — never set a tier, never delivered,
// never an item's reason — and `acted` was the one thing that said so.
// Once that column is gone nothing distinguishes them from a rule's
// verdict, so the rows are deleted **first**, and only then the column;
// `lastDecision` is unconditional because of that order, not in spite of
// it. `decisions` is the rules' log and
// these rows were never that: not relabelled, not archived.
//
// `ALTER TABLE … DROP COLUMN` has been in SQLite since 3.35, well below
// what Node 24 bundles. This is not a versioned migration framework with a
// rollback — the file wants a restore path, not history (docs/architecture.md
// §Store), and the deploy that carries a drop takes a snapshot first.
const REMOVED_ROWS = [
  "DELETE FROM decisions WHERE by = 'llm'",
  "DELETE FROM cursors WHERE source = 'llm:batch'",
  "DELETE FROM cursors WHERE source IN ('slack:p1', 'slack:p2')",
];
const REMOVED_COLUMNS = [
  ['decisions', 'acted'],
  ['items', 'summary'],
  ['items', 'summary_at'],
];
const REMOVED_TABLES = ['llm_jobs', 'llm_calls'];

const j = (v) => JSON.stringify(v ?? null);
const pj = (s, fb) => { try { return s == null ? fb : JSON.parse(s); } catch { return fb; } };

export class Store {
  constructor(file = ':memory:') {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    const db = this.db;
    this.q = {
      itemByKey: db.prepare('SELECT * FROM items WHERE user = ? AND source = ? AND key = ?'),
      itemById: db.prepare('SELECT * FROM items WHERE id = ?'),
      insertItem: db.prepare(`INSERT INTO items (user, source, key, kind, title, url, repo, actors, my_role, last_activity, last_seen, data, created, updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      updateItem: db.prepare(`UPDATE items SET kind = ?, title = ?, url = ?, repo = ?, actors = ?, my_role = ?, last_activity = ?, last_seen = ?, data = ?, updated = ? WHERE id = ?`),
      setTier: db.prepare('UPDATE items SET tier = ?, score = ?, updated = ? WHERE id = ?'),
      setRank: db.prepare('UPDATE items SET rank = ?, rank_base = ?, rank_at = ?, features = ?, updated = ? WHERE id = ?'),
      unranked: db.prepare('SELECT * FROM items WHERE user = ? AND (? = 0 OR rank_at IS NULL) ORDER BY id LIMIT ?'),
      countUnranked: db.prepare('SELECT COUNT(*) AS n FROM items WHERE user = ? AND rank_at IS NULL'),
      setState: db.prepare('UPDATE items SET state = ?, state_until = ?, updated = ? WHERE id = ?'),
      setScore: db.prepare('UPDATE items SET score = ?, updated = ? WHERE id = ?'),
      snoozedDue: db.prepare("SELECT * FROM items WHERE state = 'snoozed' AND state_until IS NOT NULL AND state_until <= ? ORDER BY state_until"),
      countByTier: db.prepare("SELECT tier, COUNT(*) AS n FROM items WHERE user = ? AND state = 'open' GROUP BY tier"),
      insertEvent: db.prepare('INSERT OR IGNORE INTO events (item_id, key, ts, seen, kind, actor, body, url, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      eventsFor: db.prepare('SELECT * FROM events WHERE item_id = ? ORDER BY ts, id'),
      insertDecision: db.prepare('INSERT INTO decisions (item_id, ts, by, rule, tier, reason, event_ids, delivered, note, matches) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      markDelivered: db.prepare('UPDATE decisions SET delivered = ?, note = ? WHERE id = ?'),
      decisionsFor: db.prepare('SELECT * FROM decisions WHERE item_id = ? ORDER BY id'),
      lastDecision: db.prepare('SELECT * FROM decisions WHERE item_id = ? ORDER BY id DESC LIMIT 1'),
      insertAction: db.prepare('INSERT INTO actions (item_id, ts, action, until, by, data) VALUES (?, ?, ?, ?, ?, ?)'),
      actionsFor: db.prepare('SELECT * FROM actions WHERE item_id = ? ORDER BY id'),
      getCursor: db.prepare('SELECT ts, state FROM cursors WHERE source = ?'),
      putCursor: db.prepare('INSERT INTO cursors (source, ts, state) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET ts = excluded.ts, state = excluded.state'),
      allCursors: db.prepare('SELECT source, ts, state FROM cursors'),
      insertDelivery: db.prepare('INSERT INTO deliveries (item_id, ts, channel, message_ts, status, decision_id, error) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      updateDelivery: db.prepare('UPDATE deliveries SET ts = ?, channel = COALESCE(?, channel), message_ts = ?, status = ?, decision_id = ?, error = ? WHERE id = ?'),
      lastDelivery: db.prepare('SELECT * FROM deliveries WHERE item_id = ? ORDER BY id DESC LIMIT 1'),
      lastSent: db.prepare("SELECT * FROM deliveries WHERE item_id = ? AND status = 'sent' AND message_ts IS NOT NULL ORDER BY id DESC LIMIT 1"),
      lastPosted: db.prepare("SELECT * FROM deliveries WHERE item_id = ? AND status = 'sent' AND (? IS NULL OR channel = ?) ORDER BY id DESC LIMIT 1"),
      deliveriesFor: db.prepare('SELECT * FROM deliveries WHERE item_id = ? ORDER BY id'),
      heldDeliveries: db.prepare("SELECT * FROM deliveries WHERE status = 'held' ORDER BY id"),
      getRun: db.prepare('SELECT * FROM source_runs WHERE source = ?'),
      allRuns: db.prepare('SELECT * FROM source_runs ORDER BY source'),
      putRun: db.prepare(`INSERT INTO source_runs (source, ok, at, ok_at, error, ms, runs, failures) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(source) DO UPDATE SET ok = excluded.ok, at = excluded.at, ok_at = COALESCE(excluded.ok_at, source_runs.ok_at),
          error = excluded.error, ms = excluded.ms, runs = source_runs.runs + 1, failures = source_runs.failures + excluded.failures`),
      countItems: db.prepare('SELECT COUNT(*) AS n FROM items'),
      countDecisions: db.prepare('SELECT COUNT(*) AS n FROM decisions'),
    };
  }

  migrate() {
    this.db.exec(SCHEMA);
    const has = (table, column) => this.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    for (const [table, column, ddl] of LATER_COLUMNS) {
      if (!has(table, column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
    // The drop half (plan §13.7): rows, then columns, then tables. Every
    // step is a no-op on a store that has already been through it.
    for (const sql of REMOVED_ROWS) this.db.exec(sql);
    for (const [table, column] of REMOVED_COLUMNS) {
      if (has(table, column)) this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    for (const table of REMOVED_TABLES) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
  }

  close() { this.db.close(); }

  // --- items --------------------------------------------------------------
  #row(r) {
    return r ? { ...r, actors: pj(r.actors, []), data: pj(r.data, {}), features: pj(r.features, null) } : null;
  }
  item(id) { return this.#row(this.q.itemById.get(id)); }
  itemByKey(user, source, key) { return this.#row(this.q.itemByKey.get(user, source, key)); }

  /** Insert or refresh the descriptive fields of an item. Tier, score and
   *  state are never touched here — rules and the human own those. */
  upsertItem(it, now = new Date().toISOString()) {
    const prev = this.q.itemByKey.get(it.user, it.source, it.key);
    const actors = j(it.actors || []);
    const data = j(it.data || {});
    if (!prev) {
      const r = this.q.insertItem.run(it.user, it.source, it.key, it.kind, it.title, it.url || null, it.repo || null, actors, it.my_role || null, it.last_activity || null, it.last_seen || null, data, now, now);
      return { item: this.item(Number(r.lastInsertRowid)), created: true };
    }
    this.q.updateItem.run(it.kind ?? prev.kind, it.title ?? prev.title, it.url ?? prev.url, it.repo ?? prev.repo, actors, it.my_role ?? prev.my_role, it.last_activity ?? prev.last_activity, it.last_seen ?? prev.last_seen, data, now, prev.id);
    return { item: this.item(prev.id), created: false };
  }
  setTier(id, tier, score, now = new Date().toISOString()) { this.q.setTier.run(tier, score, now, id); }
  setState(id, state, until = null, now = new Date().toISOString()) {
    if (!STATES.includes(state)) throw new Error(`no such state ${state}`);
    this.q.setState.run(state, until, now, id);
  }
  setScore(id, score, now = new Date().toISOString()) { this.q.setScore.run(score, now, id); }
  /** The rank and what it was made of (M5). `rank` is the whole blend as of
   *  `now`, so SQL has something to order by and a LIMIT is right before the
   *  read path re-times the rows it fetched. `base` is the same blend
   *  *without* the term that goes stale — nothing orders by it, and it is
   *  recorded because `rank` minus `base` is how much of an item's position
   *  is the clock rather than the claim, which is the first question anyone
   *  asks of a list that has moved. `features` is the explanation. */
  setRank(id, { rank, base, features }, now = new Date().toISOString()) {
    this.q.setRank.run(rank, base, now, j(features ?? null), now, id);
  }
  /** Items the ranker has never seen — what the backfill walks (plan §11.8).
   *  `all` takes every item instead, for a re-rank after a weight change. */
  unranked({ user, all = false, limit = 500 } = {}) {
    return this.q.unranked.all(user, all ? 0 : 1, Math.min(Math.max(1, limit | 0), 5000)).map((r) => this.#row(r));
  }
  countUnranked(user) { return this.q.countUnranked.get(user).n; }
  /** Snoozed items whose wake time has passed. */
  snoozedDue(nowIso = new Date().toISOString()) { return this.q.snoozedDue.all(nowIso).map((r) => this.#row(r)); }
  /** The one narrowing every list read shares (`lib/lists.js`): a tier, a
   *  repo, a source, an owner, and `q` — a word from the title, key or repo. The page's
   *  tiles, tags and search box all end here, so what the rows show and what
   *  "and N more" counts are cut by the same clause. */
  static filter({ state = null, tier = null, repo = null, source = null, owner = null, q = null } = {}, col = (c) => c) {
    const where = [], args = [];
    if (state) { where.push(`${col('state')} = ?`); args.push(state); }
    if (tier) { where.push(`${col('tier')} = ?`); args.push(tier); }
    if (repo) { where.push(`${col('repo')} = ?`); args.push(repo); }
    if (source) { where.push(`${col('source')} = ?`); args.push(source); }
    // `owner` is a ledger row's owner kind (plan §12.3) — the tag on its line.
    if (owner) { where.push(`json_extract(${col('data')}, '$.owner') = ?`); args.push(owner); }
    if (q) { const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`; where.push(`(${col('title')} LIKE ? ESCAPE '\\' OR ${col('key')} LIKE ? ESCAPE '\\' OR ${col('repo')} LIKE ? ESCAPE '\\')`); args.push(like, like, like); }
    return { where, args };
  }
  countItems({ user, state, tier = null, repo = null, source = null, owner = null, q = null }) {
    const f = Store.filter({ state, tier, repo, source, owner, q });
    return this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE user = ?${f.where.map((w) => ` AND ${w}`).join('')}`).get(user, ...f.args).n;
  }
  /** How many items there are per group, for the whole queue rather than the
   *  page of it a reader fetched — so a sub-group can say "and 975 more"
   *  and mean it. The field list is closed: these are the four `lib/lists.js`
   *  groups by, and they go into the SQL. */
  countItemsBy({ user, state, by, tier = null, repo = null, source = null, owner = null, q = null }) {
    // `owner` is who an item waits on: a ledger row's owner kind, else the
    // repo, else the source — the grouping that answers "what does this
    // take?" (plan §12.3).
    const EXPR = { source: 'source', repo: "COALESCE(repo, source)", tier: "COALESCE(tier, 'P3')", kind: 'kind', owner: "COALESCE(json_extract(data, '$.owner'), repo, source)" };
    const expr = EXPR[by];
    if (!expr) throw new Error(`cannot group items by ${by}`);
    const out = new Map();
    const f = Store.filter({ state, tier, repo, source, owner, q });
    for (const r of this.db.prepare(`SELECT ${expr} AS k, COUNT(*) AS n FROM items WHERE user = ?${f.where.map((w) => ` AND ${w}`).join('')} GROUP BY 1`).all(user, ...f.args)) out.set(String(r.k ?? '—'), r.n);
    return out;
  }
  /** Open items per tier, for the lists' footer line. */
  openByTier(user) { const out = { P0: 0, P1: 0, P2: 0, P3: 0 }; for (const r of this.q.countByTier.all(user)) if (r.tier) out[r.tier] = r.n; return out; }

  /** Items with the reason they were last tiered, in list order. The lists
   *  (/triage, the Home tab, the page) all read this so they cannot drift. */
  itemsWithReason({ user, state, tier, repo, source, owner, q, order = 'score', limit = 50 } = {}) {
    const f = Store.filter({ state, tier, repo, source, owner, q }, (c) => `i.${c}`);
    const where = ['i.user = ?', ...f.where], args = [user, ...f.args];
    // `rank` is M5's order and `score` is the tier's; a reader that is about
    // to re-time the rows in JS must prefetch by rank, or a high-ranking item
    // can fall below the cut before anything has looked at it. NULLs last, so
    // an item the backfill has not reached yet does not head the list.
    const by = order === 'until' ? 'i.state_until ASC, i.score DESC'
      : order === 'rank' ? 'i.rank IS NULL, i.rank DESC, i.last_activity DESC'
      : 'i.score DESC, i.last_activity DESC';
    // The reason is the item's latest verdict: a rule's, or the wake that
    // carried one forward.
    const sql = `SELECT i.*, d.reason, d.rule, d.by AS decided_by, d.ts AS decided FROM items i
      LEFT JOIN decisions d ON d.id = (SELECT MAX(id) FROM decisions WHERE item_id = i.id)
      WHERE ${where.join(' AND ')} ORDER BY ${by} LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(Math.max(1, limit | 0), 500)).map((r) => this.#row(r));
  }

  /** Every item of one user, or of one of their states, with its latest
   *  verdict — the aggregate's read (plan §13.6). No limit and no order: it
   *  is one pass over one person's queue, and the caller counts. */
  itemsForAggregate({ user, state = null } = {}) {
    const sql = `SELECT i.*, d.reason, d.rule, d.by AS decided_by, d.ts AS decided FROM items i
      LEFT JOIN decisions d ON d.id = (SELECT MAX(id) FROM decisions WHERE item_id = i.id)
      WHERE i.user = ? AND (? IS NULL OR i.state = ?)`;
    return this.db.prepare(sql).all(user, state, state).map((r) => this.#row(r));
  }

  /** The store over a window, for the reports (plan §15): every event,
   *  verdict and action whose time falls in [since, until], and every item
   *  of the user's — the latter whole, because a report replays state from
   *  the actions and needs the items that predate the window as much as
   *  the ones inside it. Events are read by `ts`, the far end's time, not
   *  by `seen` (§15.2). Bounded by the window, not by a limit: a report
   *  over a partial read would be wrong rather than slow. Nothing here
   *  writes or orders; the report buckets. */
  history({ user, since, until }) {
    const items = this.db.prepare('SELECT * FROM items WHERE user = ? ORDER BY id').all(user).map((r) => this.#row(r));
    const ids = items.map((i) => i.id);
    if (!ids.length) return { items, events: [], decisions: [], actions: [] };
    // One user's rows, by joining through items rather than by an IN list
    // that could outgrow SQLite's parameter limit.
    const events = this.db.prepare(`SELECT e.id, e.item_id, e.ts, e.seen, e.kind, e.actor FROM events e JOIN items i ON i.id = e.item_id
      WHERE i.user = ? AND e.ts >= ? AND e.ts <= ? ORDER BY e.ts, e.id`).all(user, since, until);
    const decisions = this.db.prepare(`SELECT d.id, d.item_id, d.ts, d.by, d.rule, d.tier, d.delivered FROM decisions d JOIN items i ON i.id = d.item_id
      WHERE i.user = ? AND d.ts >= ? AND d.ts <= ? ORDER BY d.ts, d.id`).all(user, since, until).map((d) => ({ ...d, delivered: !!d.delivered }));
    // Actions whole, not windowed: the state at the window's start is the
    // sum of everything before it, and there are few of them.
    const actions = this.db.prepare(`SELECT a.id, a.item_id, a.ts, a.action, a.by, a.until FROM actions a JOIN items i ON i.id = a.item_id
      WHERE i.user = ? ORDER BY a.ts, a.id`).all(user);
    // The latest verdict before the window, per item — what an action early
    // in the window is measured from. Apart from the windowed rows, so a
    // count over the window stays a count over the window.
    const prior = this.db.prepare(`SELECT d.id, d.item_id, d.ts, d.by, d.rule, d.tier, d.delivered FROM decisions d JOIN items i ON i.id = d.item_id
      WHERE i.user = ? AND d.ts < ? AND d.id = (SELECT MAX(id) FROM decisions WHERE item_id = d.item_id AND ts < ?) ORDER BY d.item_id`).all(user, since, since).map((d) => ({ ...d, delivered: !!d.delivered }));
    return { items, events, decisions, actions, prior };
  }

  /** Every item of one source, no limit and no order — what reconcile walks
   *  (plan §12.2), because an item past a page boundary that had left the
   *  set would otherwise never be resolved. */
  sourceItems({ user, source }) {
    return this.db.prepare('SELECT * FROM items WHERE user = ? AND source = ? ORDER BY id').all(user, source).map((r) => this.#row(r));
  }

  /** `order` is `rank` (M5's, the product) or `score` (the tier's, which the
   *  interrupt path reads). Rank first with NULLs last, so an item the
   *  backfill has not reached does not head the list. */
  items({ user, tier, state, source, since, order = 'rank', limit = 200 } = {}) {
    const where = [], args = [];
    if (user) { where.push('user = ?'); args.push(user); }
    if (tier) { where.push('tier = ?'); args.push(tier); }
    if (state) { where.push('state = ?'); args.push(state); }
    if (source) { where.push('source = ?'); args.push(source); }
    if (since) { where.push('updated >= ?'); args.push(since); }
    const by = order === 'score' ? 'score DESC, last_activity DESC' : 'rank IS NULL, rank DESC, score DESC, last_activity DESC';
    const sql = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${by} LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(Math.max(1, limit | 0), 1000)).map((r) => this.#row(r));
  }

  // --- events -------------------------------------------------------------
  /** Append events; returns only the ones that were new. `key` is the
   *  idempotency handle (e.g. github:comment:<id>), so a re-poll after a
   *  restart inserts nothing and emits nothing. */
  addEvents(itemId, events, seen = new Date().toISOString()) {
    const fresh = [];
    for (const e of events) {
      const r = this.q.insertEvent.run(itemId, e.key, e.ts, seen, e.kind, e.actor || null, e.body || null, e.url || null, j(e.data || {}));
      if (r.changes) fresh.push({ id: Number(r.lastInsertRowid), item_id: itemId, seen, ...e, data: e.data || {} });
    }
    return fresh;
  }
  events(itemId) { return this.q.eventsFor.all(itemId).map((r) => ({ ...r, data: pj(r.data, {}) })); }

  // --- decisions ----------------------------------------------------------
  addDecision(d, now = new Date().toISOString()) {
    if (!TIERS.includes(d.tier)) throw new Error(`no such tier ${d.tier}`);
    const r = this.q.insertDecision.run(d.item_id, now, d.by || 'rule', d.rule, d.tier, d.reason, j(d.event_ids || []), d.delivered ? 1 : 0, d.note || null, j(d.matches || []));
    return Number(r.lastInsertRowid);
  }
  markDelivered(id, delivered, note = null) { this.q.markDelivered.run(delivered ? 1 : 0, note, id); }
  decisionsFor(itemId) { return this.q.decisionsFor.all(itemId).map(this.#decision); }
  /** The verdict the item's tier came from: its newest decision row. */
  lastDecision(itemId) { const r = this.q.lastDecision.get(itemId); return r ? this.#decision(r) : null; }
  /** A decision row. `matches` is the whole ordered set (M5); a row written
   *  before M5 has none stored, and reads back as the single match its own
   *  `rule`, `tier` and `reason` already name — so every reader sees a set,
   *  and the 98 rows on record are a set of one rather than a gap. */
  #decision(r) {
    const matches = pj(r.matches, []);
    return { ...r, event_ids: pj(r.event_ids, []), delivered: !!r.delivered,
      matches: matches.length ? matches : [{ rule: r.rule, tier: r.tier, reason: r.reason }] };
  }
  decisions({ tier, rule, by, item_id, since, delivered, limit = 200 } = {}) {
    const where = [], args = [];
    if (tier) { where.push('d.tier = ?'); args.push(tier); }
    if (rule) { where.push('d.rule = ?'); args.push(rule); }
    if (by) { where.push('d.by = ?'); args.push(by); }
    if (item_id) { where.push('d.item_id = ?'); args.push(item_id); }
    if (since) { where.push('d.ts >= ?'); args.push(since); }
    if (delivered !== undefined) { where.push('d.delivered = ?'); args.push(delivered ? 1 : 0); }
    const sql = `SELECT d.*, i.title, i.repo, i.url, i.source, i.key FROM decisions d JOIN items i ON i.id = d.item_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(Math.max(1, limit | 0), 1000)).map(this.#decision);
  }

  // --- actions ------------------------------------------------------------
  addAction(a, now = new Date().toISOString()) {
    const r = this.q.insertAction.run(a.item_id, now, a.action, a.until || null, a.by || null, j(a.data || {}));
    return Number(r.lastInsertRowid);
  }
  actionsFor(itemId) { return this.q.actionsFor.all(itemId).map((r) => ({ ...r, data: pj(r.data, {}) })); }

  // --- cursors ------------------------------------------------------------
  cursor(source) { const r = this.q.getCursor.get(source); return r ? pj(r.state, null) : null; }
  setCursor(source, state, now = new Date().toISOString()) { this.q.putCursor.run(source, now, j(state)); }
  cursors() { const out = {}; for (const r of this.q.allCursors.all()) out[r.source] = { ts: r.ts, state: pj(r.state, null) }; return out; }

  // --- deliveries ---------------------------------------------------------
  addDelivery(d, now = new Date().toISOString()) {
    const r = this.q.insertDelivery.run(d.item_id, now, d.channel, d.message_ts || null, d.status, d.decision_id || null, d.error || null);
    return Number(r.lastInsertRowid);
  }
  updateDelivery(id, d, now = new Date().toISOString()) { this.q.updateDelivery.run(now, d.channel || null, d.message_ts || null, d.status, d.decision_id || null, d.error || null, id); }
  lastDelivery(itemId) { return this.q.lastDelivery.get(itemId) || null; }
  /** The DM that carries this item, if one was sent — what a button press or
   *  a coalesced P0 updates. Rows written by the retired batch and digest
   *  (status `batched`, no longer written) are not it. */
  lastSent(itemId) { return this.q.lastSent.get(itemId) || null; }
  /** The last message actually posted for this item, updatable or not —
   *  `lastSent` without the `message_ts` requirement. It answers "is a
   *  coalesce window open?", which is a question about *when something went
   *  out*, not about whether it can be redrawn; a webhook's rows carry no
   *  `message_ts` and would be invisible to `lastSent` (plan §11.6).
   *
   *  `channel` narrows it to one destination, which the webhook path wants:
   *  a box switched from `TRIAGE_SLACK=app` to `webhook` still has recent
   *  DM rows, and they are not a window this channel opened. */
  lastPosted(itemId, channel = null) { return this.q.lastPosted.get(itemId, channel, channel) || null; }
  deliveriesFor(itemId) { return this.q.deliveriesFor.all(itemId); }
  heldDeliveries() { return this.q.heldDeliveries.all(); }

  // --- source health ------------------------------------------------------
  recordRun(source, { ok, error = null, ms = null, at = new Date().toISOString() }) {
    this.q.putRun.run(source, ok ? 1 : 0, at, ok ? at : null, error, ms, ok ? 0 : 1);
  }
  runs() { const out = {}; for (const r of this.q.allRuns.all()) out[r.source] = { ...r, ok: !!r.ok }; return out; }

  counts() { return { items: this.q.countItems.get().n, decisions: this.q.countDecisions.get().n }; }
  /** Whom this store already files items under, or null when it is empty —
   *  the stable answer to "whose queue is this", whatever forge boots first. */
  firstUser() { return this.db.prepare('SELECT user FROM items ORDER BY id LIMIT 1').get()?.user ?? null; }
}
