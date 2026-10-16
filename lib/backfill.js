// backfill.js — M5's bootstrap, and without it M5's own success criterion
// is unreachable (plan §11.8).
//
// The 51 open items in the store predate every feature a ranker wants, and
// **there is no path that would ever compute one for them**: the rules only
// ever see the events a poll just added. A thread from June will never move
// again, so it would sit in the list for ever with no rank at all.
//
// So: one bounded pass over the items already in the store. Re-run the rules
// against each item's **stored history** — the same rules, the same engine,
// the same match set — score it, persist the rank and the features. Reads
// nothing over the network, writes no decision rows.
//
// **It does not rewrite history, and that is deliberate.** A verdict in
// `decisions` is what a rule observed at the time, with the delivery answer
// it got; a backfill row would be a verdict that was never made and never
// delivered, and `/api/decisions` would stop being a record of what
// happened. What the re-run produces goes on the *item*, in `features`,
// marked `from: 'backfill'` so nothing mistakes it for a live verdict. The
// original row keeps its single `rule`/`reason`; its `matches` stays empty
// and reads back as the one match it names.
//
// **A missing feature stays missing.** An item with no stored events has no
// match set, and the honest answer is an absent claim term — not a zero, not
// a P3 invented to fill the column. lib/rank.js drops an absent term from
// the denominator, so such an item is ranked on what is actually known
// about it. That is the common case for a fortnight and it has to be
// representable (§11.8).
import { matchAll } from './rules.js';

/** One pass. `limit` bounds it; `all` re-ranks everything rather than only
 *  what has never been ranked, which is what a weight change wants. */
export function backfill(store, { user, identity = {}, rules = {}, rank = null, all = false, limit = 500, states = null, now = new Date(), log = () => {} } = {}) {
  if (!rank) return { ranked: 0, skipped: 0, absent: 0, items: [] };
  const out = { ranked: 0, skipped: 0, absent: 0, items: [] };
  for (const item of store.unranked({ user, all, limit })) {
    if (states && !states.includes(item.state)) { out.skipped++; continue; }
    const history = store.events(item.id);
    const set = rules[item.source];
    // **What was fresh is on record, and it is not the whole history.** Every
    // event-local rule asks "did this happen *now*" — a reply after your
    // comment, an invitation you have not answered — so handing it a thread's
    // whole life turns "now" into "ever", and an item that was replied to in
    // June and merged in August comes back as `reply_to_my_comment` on the
    // `waiting` curve, saying a person is blocked on you when nobody is.
    // The verdict on record names the events it was about (`event_ids`), so
    // that is the batch the rules re-run against: the same inputs they had,
    // and the only thing that changes is that they now return the whole set
    // instead of the first match.
    const last = store.lastDecision(item.id);
    const fresh = last ? history.filter((e) => last.event_ids.includes(e.id)) : [];
    let matches = [];
    let why = null;
    if (!last) why = 'no verdict on record — nothing said what this item was about';
    else if (!set) why = `no rules registered for source ${item.source}`;
    else if (!fresh.length) {
      // A verdict with no events still to be found (pruned, or a `wake` row):
      // its own match is the best evidence there is, and a decision written
      // before M5 reads back as the single match its columns name.
      matches = last.matches;
      why = 'the events that verdict was about are no longer on the item; using the verdict itself';
    } else {
      try { matches = matchAll(set, item, fresh, { me: identity[item.source] ?? user, history, now }); }
      catch (e) { why = `rules failed: ${e.message}`; }
    }
    if (!matches.length) out.absent++;
    // One write per item: `rerank()` would persist and then be persisted over
    // again, and this pass walks the whole store.
    const r = rank.rank(item, { matches, state: item.state, now });
    store.setRank(item.id, { ...r, features: { ...r.features, from: 'backfill', absent_because: why } }, now.toISOString());
    out.ranked++;
    out.items.push({ id: item.id, key: item.key, rank: r.rank, rules: matches.map((m) => m.rule), why: why || r.features.why || null });
  }
  if (out.ranked) log(`rank: backfilled ${out.ranked} item(s)${out.absent ? `, ${out.absent} with no rule verdict to read (feature absent, not zero)` : ''}`);
  return out;
}
