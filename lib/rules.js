// rules.js — the engine. A rule is a pure function with a name:
//
//   { name, tier, claim?, fallback?, match(item, fresh, ctx) -> reason | null }
//
// Rules are per source and ordered strongest first. `fresh` is the events
// this poll added; `ctx.history` is every event on the item including
// those; `ctx.me` is the login the items belong to. The verdict carries
// the rule's name so /api/decisions can say *why* — and a rule that ends
// in P3 is logged exactly like one that ends in P0.
//
// **Every match, not the first (M5, plan §11.3).** First-match-wins is
// correct for picking a channel — you only need one — and throws away
// everything for picking an order: an item that is a reply to your comment
// *and* a review request is strictly more urgent than one with only the
// first, and the engine could not see it. So `decide` returns the whole
// ordered set. The strongest match stays first and keeps every meaning it
// had: `verdict.rule`, `verdict.tier` and `verdict.reason` are still the
// strongest match, which is what the lists, the batches, the wake path,
// delivery and bin/replay.js read.
//
// `claim` is what a rule is worth to the ranker — how hard a hold this
// observation has on you, 0 to 1 (lib/rank.js). It lives on the rule
// because that is where the observation is named: `reply_to_my_comment` is
// not a tier, it is the fact that a named human is blocked on you, and that
// fact is worth more to a ranker than it ever was to a router (§11.2).
// Unset, it falls back to the rule's tier, so a source that has not been
// tuned still ranks.
import { TIERS } from './store.js';

/** What a tier is worth when a rule does not say. The tier survives as one
 *  input to the score rather than as the score (plan §11.1). */
export const TIER_CLAIM = { P0: 1, P1: 0.6, P2: 0.3, P3: 0.05 };
export const claimOf = (rule) => (typeof rule?.claim === 'number' ? rule.claim : TIER_CLAIM[rule?.tier] ?? 0);

/** Every rule that matched, in rule order (strongest first), as
 *  `{ rule, tier, reason, claim }`.
 *
 *  The catch-all is the one exclusion. Each source's last rule matches
 *  everything by contract, so without this it would corroborate every
 *  verdict in the store and mean nothing at all. A rule marked
 *  `fallback: true` is kept only when it is the only thing that matched —
 *  which is exactly when it is saying something. */
export function matchAll(rules, item, fresh, ctx) {
  const hits = [];
  for (const r of rules) {
    const reason = r.match(item, fresh, ctx);
    if (!reason) continue;
    if (!TIERS.includes(r.tier)) throw new Error(`rule ${r.name} names tier ${r.tier}`);
    hits.push({ rule: r.name, tier: r.tier, reason, claim: claimOf(r), fallback: !!r.fallback });
  }
  const real = hits.filter((h) => !h.fallback);
  return (real.length ? real : hits).map(({ fallback, ...h }) => h);
}

/** The verdict: the strongest match, with the whole set beside it. */
export function decide(rules, item, fresh, ctx) {
  const matches = matchAll(rules, item, fresh, ctx);
  if (!matches.length) throw new Error('no rule matched — the last rule must be a catch-all');
  const [top] = matches;
  return { rule: top.rule, tier: top.tier, reason: top.reason, matches };
}

/** Tier first, recency second: a P0 always outranks a P1, and within a tier
 *  the thing that moved last comes first. An item tossed to Later keeps its
 *  tier but the whole score shrinks ten-thousandfold, so it sinks beneath
 *  every open item of any tier (an open P3 is at least 1; a Later P0 is at
 *  most 0.11) while Later items still order among themselves by tier and
 *  recency. It has no date: nothing lifts it back except a new P0.
 *
 *  **This is the tier's own ordering, and M5 leaves it alone** (plan §11.8,
 *  trap 1). It is what `items.score` means, what the interrupt path reads
 *  and what four writers write. The ranking is `items.rank`, a second
 *  column — lib/rank.js says why that was the choice, and what each of
 *  those four writers now does beside this. */
export function score(tier, lastActivity, now = Date.now(), { later = false } = {}) {
  const base = { P0: 1000, P1: 100, P2: 10, P3: 1 }[tier] || 0;
  const age = lastActivity ? Math.max(0, (now - Date.parse(lastActivity)) / 86_400_000) : 30;
  return (base + Math.max(0, 1 - age / 30)) / (later ? 10_000 : 1);
}
