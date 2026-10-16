// rank.js — M5, "rank it". The score is the product now, and the tier is one
// of its inputs (plan §11.1). This is the only thing that computes it.
//
// Three terms, all structural — no model is called here, or anywhere in
// triage since plan §13; the order is a function of data triage holds:
//
//   claim   what hold this has on you, from the rules that fired. The
//           strongest sets the floor and the rest corroborate, which is the
//           whole reason `decide()` stopped returning only the first match.
//   time    per source *and* per kind, because one curve cannot say what any
//           of them mean. A reply waiting on you is **more** urgent the
//           longer it sits — the wait is the cost. News collapses in hours.
//           A meeting spikes at T-15 and is worthless at T+1. The source
//           declares which shape; this applies it.
//   prefer  what you have said matters, structurally: repos, sources and
//           people, with weights, in config (§11.4 item 5).
//
// **Absence is not zero, and that is load-bearing** (plan §11.8). For the
// next fortnight the common case is a term nobody has computed: the backlog
// predates every feature the ranker wants, and `relevance` and `effort` are
// declared and never computed. A term that is absent is dropped from the
// weighted mean's *denominator*, so it neither drags an item down nor
// silently counts as "no claim". A term that is present and zero is a real
// zero and is treated as one.
//
// **Stability** (§11.4's last paragraph, decided before the first blend).
// The base — claim and preference — changes only on a material change, and
// both it and the verdict set it is derived from are **stored** on the item,
// so SQL has something to order by and a LIMIT is roughly right. The time
// term is cheap and is recomputed at **read** time, because a rank written
// at decision time is stale within the hour of any time curve. Hysteresis
// keeps the list from rearranging under your hand: a recomputed rank that
// has not moved further than `hysteresis` from the stored one is read as the
// stored one, so nothing shuffles without something actually happening.
// (`live()` recomputes the base from the stored match set rather than
// trusting the stored number — same inputs, same answer, and a stored rank
// that has drifted from the item's own features is corrected as it is read
// instead of ordering the page by a number nobody can reproduce.)
//
// **Explainability is a requirement, not polish** (§11.7 item 2). Every term
// keeps its weight, its value, what it contributed and a sentence saying
// why, on the item, in `features`. A tier is explainable in four words; a
// blend is not, unless the top contributing term is on the line.
import { claimOf } from './rules.js';

const HOUR = 3_600_000, DAY = 86_400_000;
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** The shapes time can take. A source names one per item; the ranker
 *  applies it. They all answer the same question — how much does *when* add
 *  to this, right now — on one 0..1 scale, so the blend can mix sources that
 *  disagree about what time means.
 *
 *  **0.5 is the middle of that scale and means "time says nothing here".**
 *  Above it time is making this more urgent, below it time has drained it.
 *  Getting this wrong is subtle and was caught by ranking the real backlog:
 *  a `waiting` curve that started at *zero* said a reply that arrived a
 *  minute ago was timeless, while `fading` said news from two hours ago was
 *  maximally so — which put a merged pull request within a whisker of a
 *  human waiting on an answer. Two curves that mean opposite things about
 *  "now" have to share a zero point or they cannot be blended at all. */
export const SHAPES = {
  /** Someone is waiting: urgent when it lands, and worse the longer it
   *  sits, because the wait is the cost. Saturating, so a thread from June
   *  is bad and not infinitely bad. */
  waiting: ({ ageMs, halfMs = 3 * DAY }) => (ageMs == null ? null : clamp01(0.5 + 0.5 * (ageMs / (ageMs + halfMs)))),
  /** News: worth most when it lands and collapsing after. Half-life. */
  fading: ({ ageMs, halfMs = 12 * HOUR }) => (ageMs == null ? null : clamp01(2 ** (-ageMs / halfMs))),
  /** A meeting: climbing as it approaches, flat through the quarter hour
   *  before it, and worthless once it has been running an hour. */
  spike: ({ startMs, soonMs = 900_000, graceMs = HOUR }) => {
    if (startMs == null) return null;
    if (startMs < -graceMs) return 0;            // it has been running an hour
    if (startMs <= soonMs) return 1;             // inside the quarter hour, or under way
    return clamp01(soonMs / startMs);            // T-30 → 0.5, T-2h → 0.125
  },
  /** Time says nothing about this one. Present, and deliberately flat —
   *  an all-day entry has no minute to be late for. */
  flat: () => 0.5,
};

/** A source that has not declared a shape gets this one: most things that
 *  reach a queue are things somebody is waiting on. */
export const DEFAULT_SHAPE = 'waiting';

export const DEFAULT_WEIGHTS = { claim: 1, time: 0.6, prefer: 0.4, relevance: 0, effort: 0 };
export const DEFAULT_CORROBORATE = 0.25;
export const DEFAULT_HYSTERESIS = 0.02;

/** `repo:owner/name=0.8, source:calendar=0.3, actor:carol=0.5` — what you
 *  have said matters, as structure a deterministic scorer can read. Keys are
 *  `repo`, `source`, `actor` and `kind`; a bare `owner/name` is a repo. */
export function parsePreferences(spec) {
  const out = [];
  for (const part of String(spec || '').split(/[,\n]/)) {
    const t = part.trim();
    if (!t) continue;
    // Exponent notation is accepted so a weight never silently fails to
    // parse — a project's `weight` in TRIAGE_PREFS arrives through here.
    const m = /^(?:(repo|source|actor|kind):)?(.+?)\s*=\s*(-?\d*\.?\d+(?:[eE][-+]?\d+)?)$/.exec(t);
    if (!m) continue;
    const weight = Number(m[3]);
    if (!Number.isFinite(weight)) continue;
    out.push({ field: m[1] || (m[2].includes('/') ? 'repo' : 'source'), value: m[2].trim().toLowerCase(), weight: clamp01(Math.abs(weight)) * Math.sign(weight) });
  }
  return out;
}

/** A stated preference may glob — `repo:acme/*=0.4` is one statement
 *  about a whole account, which is what a project's `weight` in TRIAGE_PREFS
 *  needs (plan §14.2) and what
 *  anybody with more than three repositories wants to write. Exact when
 *  there is no `*`, so nothing that worked before changes. */
function statedMatch(pattern, value) {
  const v = String(value ?? '').toLowerCase();
  if (!v) return false;
  if (!pattern.includes('*')) return v === pattern;
  return new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(v);
}

/** One term of the blend. `value: null` means **absent** — nobody has
 *  computed this, which is not the same as computing it and getting zero. */
const term = (name, weight, value, why) => ({ name, weight, value, absent: value == null, contribution: value == null ? 0 : weight * value, why });

export class Ranker {
  /** `shapes` is a map of source name -> (item) -> shape name, built at boot
   *  from the registered sources — the same shape as M3's per-source map
   *  for what Done does outside triage. Nothing here
   *  knows what a GitHub thread or a calendar event is. */
  constructor({ shapes = {}, weights = {}, prefer = [], corroborate = DEFAULT_CORROBORATE, hysteresis = DEFAULT_HYSTERESIS, now = () => new Date() } = {}) {
    this.shapes = shapes;
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    this.prefer = Array.isArray(prefer) ? prefer : parsePreferences(prefer);
    this.corroborate = corroborate;
    this.hysteresis = hysteresis;
    this.now = now;
  }

  describe() {
    return { weights: this.weights, corroborate: this.corroborate, hysteresis: this.hysteresis,
      shapes: Object.keys(this.shapes), prefer: this.prefer, terms: ['claim', 'time', 'prefer'], absent: ['relevance', 'effort'] };
  }

  /** Which curve this item's time follows. The source says; `waiting` is the
   *  answer for a source that has not been asked yet. The rules that fired
   *  go with the item, because for most sources *which* curve applies is a
   *  question about what happened, not about what kind of thing it is — a
   *  merged pull request and a reply to your comment are the same `kind`. */
  shapeFor(item, matches = []) {
    const f = this.shapes[item.source];
    const name = (typeof f === 'function' ? f(item, { rules: matches.map((m) => m.rule), matches }) : f) || DEFAULT_SHAPE;
    return SHAPES[name] ? name : DEFAULT_SHAPE;
  }

  /** The time term, now. Cheap on purpose: this runs at read time for every
   *  row on the page (§11.4, stability). */
  time(item, now = this.now(), matches = item.features?.matches || []) {
    const name = this.shapeFor(item, matches);
    const t = now.getTime();
    const start = item.data?.start ? Date.parse(item.data.start) : null;
    const last = item.last_activity ? Date.parse(item.last_activity) : null;
    const value = SHAPES[name]({
      ageMs: Number.isFinite(last) ? Math.max(0, t - last) : null,
      startMs: Number.isFinite(start) ? start - t : null,
    });
    return { name, value, why: value == null ? `no time to read on this item (${name})` : WHY[name](item, { value, startMs: start - t, ageMs: t - last }) };
  }

  /** Claim, from the whole match set: the strongest sets the floor, and
   *  every other rule that fired adds a fraction of its own claim. That is
   *  the point of persisting the set — a corroborating match discarded at
   *  write time is gone from the ranking and from the explanation at once. */
  claim(matches = []) {
    if (!matches.length) return { value: null, why: 'no rule verdict on record for this item' };
    const scored = matches.map((m) => ({ ...m, claim: typeof m.claim === 'number' ? m.claim : claimOf(m) }));
    const [top] = scored;
    const rest = scored.slice(1);
    const value = clamp01(top.claim + this.corroborate * rest.reduce((a, m) => a + m.claim, 0));
    const also = rest.length ? ` (+ ${rest.map((m) => m.rule).join(', ')})` : '';
    return { value, why: `${top.rule}${also} — ${top.reason}` };
  }

  /** Stated preference: the strongest rule that names this item wins, so a
   *  repo you care about is not diluted by a source you are neutral about. */
  preference(item) {
    if (!this.prefer.length) return { value: null, why: 'no stated preference configured (TRIAGE_RANK_PREFER)' };
    const fields = { repo: item.repo, source: item.source, kind: item.kind };
    const actors = (item.actors || []).map((a) => String(a).toLowerCase());
    let best = null;
    for (const p of this.prefer) {
      const hit = p.field === 'actor' ? actors.some((a) => statedMatch(p.value, a)) : statedMatch(p.value, fields[p.field]);
      if (hit && (!best || Math.abs(p.weight) > Math.abs(best.weight))) best = p;
    }
    return best ? { value: clamp01(0.5 + best.weight / 2), why: `you said ${best.field} ${best.value} matters (${best.weight > 0 ? '+' : ''}${best.weight})` }
      : { value: 0.5, why: 'nothing you have said names this' };
  }

  /** The base: everything that does not change until something happens. */
  base(item, { matches = [] } = {}) {
    const c = this.claim(matches);
    const p = this.preference(item);
    return [term('claim', this.weights.claim, c.value, c.why), term('prefer', this.weights.prefer, p.value, p.why)];
  }

  /** The whole blend, as a number and as its own explanation. A weighted
   *  mean over the terms that are *present*: an absent term leaves the
   *  denominator, so it is not a zero wearing a term's clothes. */
  rank(item, { matches = null, now = this.now(), state = item.state } = {}) {
    const set = matches || item.features?.matches || [];
    const t = this.time(item, now, set);
    const terms = [
      ...this.base(item, { matches: set }),
      term('time', this.weights.time, t.value, t.why),
      // Declared and absent: nothing computes them, and since plan §13
      // nothing in triage will — they were the model's two features. Saying
      // so is the point: `absent` is how the list stays honest about what it
      // does not know rather than scoring it as nothing (§11.8, §13.4).
      term('relevance', this.weights.relevance, null, 'nothing computes relevance (plan §13.4)'),
      term('effort', this.weights.effort, null, 'nothing estimates effort (plan §13.4)'),
    ];
    const present = terms.filter((x) => !x.absent && x.weight > 0);
    const denom = present.reduce((a, x) => a + x.weight, 0);
    const blended = denom ? present.reduce((a, x) => a + x.contribution, 0) / denom : 0;
    // Later sinks beneath everything and has no date, exactly as it does in
    // `score()` — the verb means the same thing in both orderings or it
    // means nothing (README §Acting on it).
    const rank = state === 'later' ? blended / 10_000 : blended;
    const top = present.slice().sort((a, b) => b.contribution - a.contribution)[0] || null;
    const baseTerms = terms.filter((x) => x.name !== 'time');
    const basePresent = baseTerms.filter((x) => !x.absent && x.weight > 0);
    const baseDenom = basePresent.reduce((a, x) => a + x.weight, 0);
    return {
      rank,
      // What is worth storing: the blend without the term that goes stale.
      base: baseDenom ? basePresent.reduce((a, x) => a + x.contribution, 0) / baseDenom : 0,
      features: { terms, top: top?.name || null, why: top?.why || null, matches: set, state, at: now.toISOString() },
    };
  }

  /** The read-time rank for a row that already carries a stored one: the
   *  stored verdict set re-blended with the time term as of now, held steady
   *  by hysteresis so a list being read does not rearrange under the reader.
   *  Nothing is fetched and no rule is re-run — everything it needs is on
   *  the row.
   *
   *  `why` and `top` travel together. The sentence on the line is the top
   *  term's own, so the label naming that term has to come from the same
   *  blend — a fresh sentence under a stored label reads "state_change_on_mine
   *  — your pull was merged" tagged `top term: time` once the clock has
   *  handed the lead to the claim (found on the live page, 2026-09-11). */
  live(item, now = this.now()) {
    const stored = Number.isFinite(item.rank) ? item.rank : null;
    const kept = { why: item.features?.why || null, top: item.features?.top || null };
    if (item.rank_at == null) return { rank: stored, moved: false, ...kept };
    const fresh = this.rank(item, { matches: item.features?.matches || [], now });
    const now_ = { why: fresh.features.why, top: fresh.features.top };
    if (stored == null) return { rank: fresh.rank, moved: true, ...now_ };
    const moved = Math.abs(fresh.rank - stored) > this.hysteresis;
    return { rank: moved ? fresh.rank : stored, moved, ...(moved || !kept.why ? now_ : kept) };
  }

  /** Rows in rank order, re-timed and held steady. The page and every list
   *  read through this, so nothing can disagree about what is first. */
  order(items, now = this.now()) {
    return items
      .map((i) => { const l = this.live(i, now); return { ...i, rank: l.rank ?? i.rank ?? 0, rank_moved: l.moved, why: l.why, top: l.top }; })
      .sort((a, b) => (b.rank - a.rank) || ((Date.parse(b.last_activity) || 0) - (Date.parse(a.last_activity) || 0)));
  }
}

/** One sentence per shape, because a number on a line explains nothing. */
const WHY = {
  waiting: (i, { ageMs }) => `waiting ${human(ageMs)} — the wait is the cost`,
  fading: (i, { ageMs }) => `${human(ageMs)} old — this kind goes stale fast`,
  spike: (i, { startMs }) => (startMs <= 0 ? 'under way now' : `starts in ${human(startMs)}`),
  flat: () => 'time says nothing about this one',
};
function human(ms) {
  const s = Math.abs(ms) / 1000;
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

/** Compute the rank and write it. **This is the call every writer of
 *  `items.score` now makes beside it** — lib/pipeline.js on a verdict and on
 *  a snooze wake, lib/actions.js on `later` and on `open` (plan §11.8, trap
 *  1: there are four of them, and one that forgets leaves an item sunk in
 *  one ordering and floating in the other). A null ranker is a no-op, so a
 *  caller that has none — a test, bin/replay.js — behaves as it did. */
export function rerank(store, ranker, item, { matches = null, state = item.state, now = new Date() } = {}) {
  if (!ranker || !item) return null;
  const r = ranker.rank(item, { matches: matches ?? item.features?.matches ?? [], state, now });
  store.setRank(item.id, r, now.toISOString());
  return r;
}
