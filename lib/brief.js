// brief.js — the few things that need you, and the rest as counts (plan §17).
//
// The list (lib/lists.js) is everything open, in rank order, and it is the
// right thing to *search*. It is the wrong thing to *read*: it asks its
// reader to sort every row — Done, Snooze, Later, Mute — before it gets
// shorter, and a reader who does not sort is handed a longer list every
// day. Two months of one real queue said how that goes: 685 rows open, two
// actions taken, and the top of the list three weeks stale.
//
// So this is the same store read the other way round — nothing is asked of
// the reader first:
//
//   needs     the items that need you and began to this week, in rank
//             order, capped. The whole of what a brief says out loud.
//   aging     the ones that have waited longer, each surfaced once as it
//             crosses a line — a week, two, a month, two, three — and not
//             again until the next. A thing you have not got to is said
//             again, on a schedule that gets slower, never daily.
//   waiting   every other item that needs you, as a count and its oldest.
//   yours     what is yours with no clock on it, as a count and its oldest.
//   folded    everything else — news, bots, other people's — as counts by
//             the rule that put it there.
//   sources   the ones that have stopped being read. A source that is
//             silent because it is broken looks, in every other view,
//             exactly like one that is silent because nothing happened.
//
// **Which lane an item is in is read off what the rules and the source
// already said, and nothing else**: its tier (docs/ranking.md: P0 someone
// is waiting or something is about to start, P1 yours and moving, P2 worth
// knowing today, P3 ambient) and the time curve its source picked for it.
// `fading` is news — nobody is waiting, whatever tier the rule that saw it
// carries — and a `spike` that has passed is a meeting that happened. No
// source is named here, nothing is written, and no item is judged: it is a
// read, like the lists and the aggregates, and it changes no state.
import { brief as line } from './lists.js';

const DAY = 86_400_000;
/** How long a thing that needs you is said every day: a week. */
export const FRESH_DAYS = 7;
/** The lines an older one is said again at, in days waited. */
export const MARKS = [7, 14, 30, 60, 90];
export const DEFAULT_LIMIT = 5;
export const DEFAULT_AGING = 3;
/** How many rows each folded-away lane carries for a page to unfold. */
const LANE_ROWS = 100;
/** How many rule groups are named before the tail is "other". */
const FOLDS = 6;
/** How long a source may fail before the brief says so: long enough that
 *  one bad poll is not news. */
export const STALE_MS = 30 * 60_000;

const NEEDS = new Set(['P0', 'P1']);

/** `bot_only` → `bot only`: a rule's name is its label, because the rule is
 *  what put the item there and nothing downstream may rename it. */
export const label = (rule) => String(rule || 'unruled').replace(/_/g, ' ');

/** Which lane one open item is in, and how long it has waited. */
export function laneOf(item, { rank = null, now = new Date() } = {}) {
  const matches = item.features?.matches || [];
  const t = rank ? rank.time(item, now, matches) : { name: 'waiting', value: null };
  const last = Date.parse(item.last_activity);
  const days = Number.isFinite(last) ? Math.max(0, (now.getTime() - last) / DAY) : null;
  const tier = item.tier || 'P3';
  const news = t.name === 'fading';
  const over = t.name === 'spike' && t.value === 0;
  // A meeting has no "waited": its clock runs the other way.
  const waited = t.name === 'spike' ? null : days;
  if (NEEDS.has(tier) && !news && !over) return { lane: 'needs', days: waited, shape: t.name };
  if (tier === 'P2' && t.name === 'waiting') return { lane: 'yours', days: waited, shape: t.name };
  return { lane: 'folded', days: waited, shape: t.name };
}

/** The mark an item crossed in the last day, or null. Read from the clock
 *  alone, so nothing has to remember what was said yesterday: on the day
 *  an item turns fourteen days old it is on the brief, and on the
 *  fifteenth it is not. */
export const crossed = (days) => (days == null ? null : MARKS.find((m) => days >= m && days < m + 1) ?? null);

const row = (i, extra = {}) => ({ ...line(i), days: i.days == null ? null : Math.floor(i.days), ...extra });
const oldest = (rows) => rows.reduce((a, r) => (r.days != null && (a == null || r.days > a.days) ? r : a), null);
const tally = (rows) => { const o = oldest(rows); return { n: rows.length, oldest_days: o ? Math.floor(o.days) : null, oldest: o ? row(o) : null, items: rows.slice(0, LANE_ROWS).map((r) => row(r)) }; };

/** The brief, as data. `sources` is the names of the registered sources —
 *  only those are reported when they stop reading; null reports every
 *  source the store has a run for. */
export function buildBrief(store, { user, rank = null, now = new Date(), limit = DEFAULT_LIMIT, aging = DEFAULT_AGING, sources = null } = {}) {
  let rows = store.itemsForAggregate({ user, state: 'open' });
  rows = rank ? rank.order(rows, now) : rows.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  const lanes = { needs: [], yours: [], folded: [] };
  for (const r of rows) { const l = laneOf(r, { rank, now }); lanes[l.lane].push({ ...r, days: l.days, shape: l.shape }); }

  // This week's, in rank order: the list. A meeting is always this week's.
  const fresh = lanes.needs.filter((r) => r.days == null || r.days < FRESH_DAYS);
  const old = lanes.needs.filter((r) => r.days != null && r.days >= FRESH_DAYS);
  const marked = old.filter((r) => crossed(r.days) != null);
  const said = new Set(marked.slice(0, aging).map((r) => r.id));
  const rest = old.filter((r) => !said.has(r.id));

  const groups = new Map();
  for (const r of lanes.folded) {
    const rule = r.features?.matches?.[0]?.rule || r.rule || null;
    const g = groups.get(rule) || { rule, label: label(rule), n: 0, tier: r.tier || 'P3', sources: new Set() };
    g.n++; g.sources.add(r.source);
    groups.set(rule, g);
  }
  const byCount = [...groups.values()].sort((a, b) => b.n - a.n || (a.label < b.label ? -1 : 1)).map((g) => ({ ...g, sources: [...g.sources].sort() }));
  const tail = byCount.slice(FOLDS);
  const folded = tail.length > 1 ? [...byCount.slice(0, FOLDS), { rule: null, label: 'other', n: tail.reduce((a, g) => a + g.n, 0), tier: null, sources: [...new Set(tail.flatMap((g) => g.sources))].sort(), rules: tail.map((g) => g.rule) }] : byCount;

  const stopped = unread(store, { sources, now });
  const needs = fresh.slice(0, limit).map((r) => row(r, { new: r.days != null && r.days < 1 }));
  const agingRows = marked.slice(0, aging).map((r) => row(r, { mark: crossed(r.days) }));
  return {
    now: now.toISOString(),
    counts: { open: rows.length, needs: lanes.needs.length, fresh: fresh.length, waiting: rest.length, yours: lanes.yours.length, folded: lanes.folded.length },
    needs,
    more: Math.max(0, fresh.length - needs.length),
    aging: agingRows,
    waiting: tally(rest),
    yours: tally(lanes.yours),
    folded,
    sources: stopped,
    // Nothing to say out loud: no item to name and every source reading.
    // A count of what is still waiting is not, by itself, worth a message —
    // it is the same count as yesterday's.
    quiet: !needs.length && !agingRows.length && !stopped.length,
  };
}

/** The sources whose last read failed and that have not read successfully
 *  for a while — or ever. */
export function unread(store, { sources = null, now = new Date(), staleMs = STALE_MS } = {}) {
  const runs = store.runs();
  const names = sources || Object.keys(runs);
  const out = [];
  for (const name of names) {
    const r = runs[name];
    if (!r || r.ok) continue;
    const okAt = r.ok_at ? Date.parse(r.ok_at) : null;
    if (okAt != null && now.getTime() - okAt < staleMs) continue;
    out.push({ name, since: r.ok_at || null, error: r.error || null });
  }
  return out;
}
