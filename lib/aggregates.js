// aggregates.js — the queue as counts rather than rows (plan §13.6). The
// consumer is a program: the chief-of-staff seat, or a session asking
// "what is going on here" before it reads a single line. Fifty-four rows
// answer that badly and one call answers it well — counts and spreads by
// source, repo, rule, tier, kind and age band, how much of the list is one
// repository, and where the ranks sit. §11.4 item 6's saturation question is
// answered by *reporting* saturation, not by interleaving it away.
//
// Its own route rather than a `?view=` on /api/lists, because they answer
// different questions with different shapes: /api/lists is the page's read,
// cut to a limit and grouped for drawing, fetched every minute; this is one
// pass over the whole queue with no limit and no rows. One route that
// answers two shapes is a route nobody can describe in a sentence.
//
// Everything here is a query over data already in the store. Nothing is
// written, nothing is judged, and the rank it reports is the same read-time
// rank the page shows.
import { TIERS } from './store.js';

const HOUR = 3_600_000, DAY = 86_400_000;
/** Age bands on `last_activity`, oldest last. The labels are the API. */
export const AGE_BANDS = [['<1h', HOUR], ['<1d', DAY], ['<7d', 7 * DAY], ['<30d', 30 * DAY], ['30d+', Infinity]];
export const BUCKETS = 10;   // rank histogram: [0,.1) … [.9,1]

const count = (rows, key) => {
  const out = {};
  for (const r of rows) { const k = key(r); if (k == null) continue; out[k] = (out[k] || 0) + 1; }
  // Largest first, so the first key is the answer to "which one dominates".
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
};
const bandOf = (ms) => (ms == null ? null : AGE_BANDS.find(([, max]) => ms < max)[0]);

/** `state` is one item state, or `all`. `rank` is the ranker, so the ranks
 *  reported are the read-time ones the page orders by; without it they are
 *  the stored ones. */
export function aggregates(store, { user, state = 'open', rank = null, now = new Date() } = {}) {
  let rows = store.itemsForAggregate({ user, state: state === 'all' ? null : state });
  if (rank) rows = rank.order(rows, now);
  const t = now.getTime();
  const total = rows.length;
  const by = {
    source: count(rows, (r) => r.source),
    repo: count(rows, (r) => r.repo || r.source),
    kind: count(rows, (r) => r.kind),
    tier: Object.fromEntries(TIERS.map((x) => [x, 0])),
    // The strongest match per item, and every rule that fired at all — the
    // second is what persisting the whole verdict bought (§11.3).
    rule: count(rows, (r) => r.rule),
    matches: count(rows.flatMap((r) => (r.features?.matches || []).map((m) => ({ rule: m.rule }))), (m) => m.rule),
    age: Object.fromEntries(AGE_BANDS.map(([label]) => [label, 0])),
  };
  if (state === 'all') by.state = count(rows, (r) => r.state);
  for (const r of rows) {
    by.tier[r.tier || 'P3'] = (by.tier[r.tier || 'P3'] || 0) + 1;
    const last = r.last_activity ? Date.parse(r.last_activity) : NaN;
    const band = bandOf(Number.isFinite(last) ? Math.max(0, t - last) : null);
    if (band) by.age[band]++;
  }
  // How much of the list is one repository — the saturation number.
  const share = {};
  for (const field of ['repo', 'source', 'kind']) {
    const [top] = Object.entries(by[field]);
    share[field] = top ? { top: top[0], n: top[1], of: total, fraction: total ? round(top[1] / total) : 0 } : null;
  }
  // The ranks, as a distribution: a flat list and a spread list are both
  // "54 items" until something says where they sit.
  // Keyed on `rank_at`, not on the number: `order()` gives a row the ranker
  // has never seen a rank of 0 so it sorts, and 0 is not "unranked".
  const ranks = rows.filter((r) => r.rank_at != null && Number.isFinite(r.rank)).map((r) => r.rank).sort((a, b) => a - b);
  const buckets = Object.fromEntries(Array.from({ length: BUCKETS }, (_, i) => [(i / BUCKETS).toFixed(1), 0]));
  for (const x of ranks) buckets[(Math.min(BUCKETS - 1, Math.floor(Math.max(0, x) * BUCKETS)) / BUCKETS).toFixed(1)]++;
  const stat = {
    ranked: ranks.length, unranked: total - ranks.length,
    min: ranks.length ? round(ranks[0]) : null, max: ranks.length ? round(ranks.at(-1)) : null,
    mean: ranks.length ? round(ranks.reduce((a, b) => a + b, 0) / ranks.length) : null,
    median: ranks.length ? round(ranks.length % 2 ? ranks[(ranks.length - 1) / 2] : (ranks[ranks.length / 2 - 1] + ranks[ranks.length / 2]) / 2) : null,
    buckets,
  };
  return { state, now: now.toISOString(), total, by, share, rank: stat };
}

const round = (x) => Math.round(x * 10_000) / 10_000;
