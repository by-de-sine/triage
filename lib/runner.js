// runner.js — the loop that runs every source. The contract:
//
//   export default {
//     name: 'github',
//     every: 60_000,                 // default interval; poll() may return its own
//     describe: 'what it reads',
//     async poll(ctx) {},           // -> { batches: [{item, events}], cursor, every?, status? }
//     due(ctx) {},                  // optional -> { batches } — the clock's half
//     describeCursor(state) {},     // optional -> what /api/sources should show
//     reconcile(ctx) {},            // optional -> { keys, complete, governs? } | null: the current set, for a state-shaped source (plan §12.2);
//                                   //   `governs(item)` says which of the source's items the set speaks for (default: all); null means nothing to reconcile this run
//   }
//
// ctx = { api, cursor, me, now, log, ...extras } — the source owns its
// cursor: it gets the one it returned last time and hands back the next.
// The runner stores the cursor, feeds the batches through the pipeline,
// records the run (ok, error, ms) and schedules the next poll at whatever
// interval the source asked for. Sources never write.
//
// `due` is for what a poll cannot discover: something that becomes true
// because time passed, not because the far end changed — a meeting fifteen
// minutes away. It gets the source's own open items and `now`, returns
// batches like a poll, and runs **before** the poll in its own try, exactly
// as `wake` does for snoozes: the alarm for a meeting already in the store
// must not depend on the API answering. Its events are keyed, so running it
// every minute emits each one once. The runner names no source, here or
// anywhere: a source that has no `due` simply has no clock half.
import { ingest, wake, reconcile, moved } from './pipeline.js';

export class Runner {
  constructor(store, sources, { user, identity = {}, rules, deliver = null, rank = null, extras = {}, now = () => new Date(), log = () => {}, onRun = () => {} } = {}) {
    this.store = store;
    // Who "you" are on each source — the GitHub login on GitHub, the GitLab
    // username on GitLab — resolved once at boot by each source's `whoami`
    // (plan §16, G1). `user` is the one person the items belong to; `me`
    // is what a rule compares an actor to, and a source without an entry
    // here is handed the person.
    this.identity = identity;
    this.rank = rank;          // M5: the ranker, so every verdict lands with a rank on it
    this.sources = new Map(sources.map((s) => [s.name, s]));
    this.user = user;
    this.rules = rules;      // { [source name]: rules[] }
    this.deliver = deliver;
    this.extras = extras;    // { [source name]: ctx extras, e.g. { api } }
    this.now = now;   // the clock every run reads, so `due` is testable
    this.log = log;
    this.onRun = onRun;
    this.timers = new Map();
    this.inflight = new Map();
    this.every = new Map();
  }

  start() {
    let i = 0;
    for (const s of this.sources.values()) {
      this.every.set(s.name, s.every);
      const t = setTimeout(() => this.#tick(s.name), 1000 * i++);
      this.timers.set(s.name, t);
    }
  }
  stop() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }

  #tick(name) {
    this.run(name).catch((e) => this.log(`${name}: ${e && e.stack || e}`)).finally(() => {
      if (!this.timers.has(name)) return;
      this.timers.set(name, setTimeout(() => this.#tick(name), this.every.get(name)));
    });
  }

  /** Who you are on one source: its own identity, else the person. */
  me(name) { return this.identity[name] ?? this.user; }

  /** Run one source now; concurrent calls share the run. */
  run(name) {
    const s = this.sources.get(name);
    if (!s) return Promise.reject(new Error(`no source named ${name}`));
    if (this.inflight.has(name)) return this.inflight.get(name);
    const p = this.#runOnce(s).finally(() => this.inflight.delete(name));
    this.inflight.set(name, p);
    return p;
  }

  async #runOnce(s) {
    const t0 = Date.now();
    const now = this.now();
    // Snoozes wake on the clock, not on GitHub answering: their own try, first.
    let woke = [];
    try { woke = await wake(this.store, { deliver: this.deliver, rank: this.rank, now, log: (m) => this.log(`wake: ${m}`) }); }
    catch (e) { this.log(`wake: ${e && e.stack || e}`); }
    // The source's own clock half, for the same reason and in the same way.
    let due = null;
    try { due = await this.#due(s, now); }
    catch (e) { this.log(`${s.name}: due — ${e && e.stack || e}`); }
    let r;
    try {
      r = await s.poll({ ...(this.extras[s.name] || {}), cursor: this.store.cursor(s.name), me: this.me(s.name), now, log: (m) => this.log(`${s.name}: ${m}`) });
    } catch (e) {
      const error = String(e && e.message || e);
      this.store.recordRun(s.name, { ok: false, error, ms: Date.now() - t0 });
      this.log(`${s.name}: ${error}`);
      return { ok: false, error, woke, due };
    }
    let result;
    try {
      result = await ingest(this.store, { user: this.user, source: s.name, batches: r.batches || [] }, { rules: this.rules[s.name] || [], me: this.me(s.name), deliver: this.deliver, rank: this.rank, now, log: (m) => this.log(`${s.name}: ${m}`) });
      if (r.cursor !== undefined) this.store.setCursor(s.name, r.cursor);
      result.woke = woke;
    } catch (e) {
      const error = `ingest: ${String(e && e.message || e)}`;
      this.store.recordRun(s.name, { ok: false, error, ms: Date.now() - t0 });
      this.log(`${s.name}: ${error}`);
      return { ok: false, error };
    }
    // The state half (plan §12.2): after the poll has stored what is there,
    // the source says what the whole set *is*, and what has left it is
    // resolved. Its own try — a failure here is logged, not a failed poll.
    if (s.reconcile) {
      try {
        const set = await s.reconcile({ ...(this.extras[s.name] || {}), cursor: this.store.cursor(s.name), me: this.me(s.name), now, log: (m) => this.log(`${s.name}: ${m}`) });
        // null: the source has a state half but it is not configured (or has
        // not read yet) — nothing to say, so nothing is logged a minute.
        if (set) {
          result.reconciled = reconcile(this.store, { user: this.user, source: s.name, keys: set.keys || [], complete: !!set.complete, governs: typeof set.governs === 'function' ? set.governs : null }, { rank: this.rank, now, log: (m) => this.log(`${s.name}: ${m}`) });
          if (!set.complete) this.log(`${s.name}: reconcile skipped — incomplete read${set.error ? ` (${set.error})` : ''}`);
          // G5: what reconcile closed or reopened moved with nobody pressing,
          // so whatever shows it follows. reconcile stays synchronous and
          // knows nothing of what shows an item; this is where it is said.
          for (const key of [...result.reconciled.resolved, ...result.reconciled.reopened]) await moved(this.deliver, this.store.itemByKey(this.user, s.name, key), false, (m) => this.log(`${s.name}: ${m}`));
        }
      } catch (e) { this.log(`${s.name}: reconcile — ${e && e.stack || e}`); }
    }
    if (r.every) this.every.set(s.name, r.every);
    const ms = Date.now() - t0;
    this.store.recordRun(s.name, { ok: true, ms, at: now.toISOString() });
    const summary = { ok: true, ms, status: r.status || null, ...result, due };
    if (r.batches?.length || result.decisions.length || result.woke.length || due?.decisions.length) this.log(`${s.name}: ${r.status || ''} — ${result.items} items, ${result.events} new events, ${result.decisions.length + (due?.decisions.length || 0)} decisions, ${result.delivered + (due?.delivered || 0)} delivered, ${result.woke.length} woke (${ms} ms)`);
    this.onRun(s.name, summary);
    return summary;
  }

  /** The source's clock half, if it has one: its own open items and `now`
   *  in, batches out, through the same pipeline as a poll. */
  async #due(s, now) {
    if (!s.due) return null;
    const items = this.store.items({ user: this.user, source: s.name, state: 'open', limit: 1000 });
    const log = (m) => this.log(`${s.name}: ${m}`);
    const r = await s.due({ ...(this.extras[s.name] || {}), items, cursor: this.store.cursor(s.name), me: this.me(s.name), now, log });
    if (!r?.batches?.length) return null;
    return ingest(this.store, { user: this.user, source: s.name, batches: r.batches }, { rules: this.rules[s.name] || [], me: this.me(s.name), deliver: this.deliver, rank: this.rank, now, log });
  }

  describe() {
    const runs = this.store.runs();
    const cursors = this.store.cursors();
    // What a cursor looks like is the source's business, not the runner's:
    // a source that wants /api/sources to show something other than its raw
    // state says so with describeCursor.
    return [...this.sources.values()].map((s) => {
      const state = cursors[s.name]?.state ?? null;
      return { name: s.name, describe: s.describe || '', every: this.every.get(s.name) || s.every, ...(runs[s.name] || {}),
        cursor: state && s.describeCursor ? s.describeCursor(state) : state, cursor_ts: cursors[s.name]?.ts || null };
    });
  }
}
