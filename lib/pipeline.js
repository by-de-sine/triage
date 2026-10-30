// pipeline.js — one poll's batches through the store, the rules and, for
// the verdicts that interrupt, delivery. Sources emit; this is the only
// place that writes items, events and decisions from them.
//
// For each batch: upsert the item, append its events, keep only the ones
// that were new. Nothing new means nothing to decide. Otherwise the rules
// see the fresh events against the item's whole history, the verdict is
// logged with its rule name whether or not it will be sent, the item's
// tier and score are set, and a verdict whose rule is on the interrupt set
// goes to delivery — whose answer (sent, updated, held, skipped, or not
// configured) is written back onto the decision so /api/decisions tells
// the whole story. Every other verdict is placed in the list and its row
// says so. Nothing is left pending, because nothing comes back for it
// later: the P1 batch and the P2 digest are gone (plan §11.3, decided
// 2026-09-12) and the list is the channel for everything that does not
// interrupt.
//
// State meets new activity here too. A done item that draws a new P0–P2
// reopens (you handled it; now there is more), a Later item reopens only
// for a P0 (someone is waiting, and Later had no date), and snoozed or
// muted items keep their state — snooze wakes by time (`wake`, below),
// mute never does.
import { decide, score } from './rules.js';
import { rerank } from './rank.js';
import { isBot, sameLogin } from './util.js';

const REOPEN = { done: new Set(['P0', 'P1', 'P2']), later: new Set(['P0']) };

export async function ingest(store, { user, source, batches }, { rules, me = user, deliver = null, rank = null, now = new Date(), log = () => {} }) {
  const nowIso = now.toISOString();
  const out = { items: 0, created: 0, events: 0, decisions: [], delivered: 0 };
  for (const b of batches) {
    const { item: stored, created } = store.upsertItem({ ...b.item, user, source }, nowIso);
    out.items++; if (created) out.created++;
    const fresh = store.addEvents(stored.id, b.events, nowIso);
    out.events += fresh.length;
    if (!fresh.length) continue;
    const history = store.events(stored.id);
    const item = refineRole(store, stored, history, me, nowIso);
    let verdict;
    try { verdict = decide(rules, item, fresh, { me, history, now }); }
    catch (e) { log(`${item.key}: rules failed — ${e.message}`); continue; }
    let state = item.state;
    if (REOPEN[state]?.has(verdict.tier)) {
      store.setState(item.id, 'open', null, nowIso);
      store.addAction({ item_id: item.id, action: 'reopen', by: 'system', data: { was: state, tier: verdict.tier, rule: verdict.rule } }, nowIso);
      log(`${item.key}: was ${state}, reopened by ${verdict.tier} ${verdict.rule}`);
      state = 'open';
    }
    store.setTier(item.id, verdict.tier, score(verdict.tier, item.last_activity, now.getTime(), { later: state === 'later' }), nowIso);
    // M5: the whole match set is persisted, not just the strongest — a
    // corroborating match discarded here is gone from the ranking, from the
    // explanation and from replay at once (plan §11.3).
    const decisionId = store.addDecision({ item_id: item.id, rule: verdict.rule, tier: verdict.tier, reason: verdict.reason, event_ids: fresh.map((e) => e.id), matches: verdict.matches }, nowIso);
    const ranked = rerank(store, rank, store.item(item.id), { matches: verdict.matches, state, now });
    const record = { id: decisionId, item: item.key, rule: verdict.rule, tier: verdict.tier, reason: verdict.reason, rank: ranked?.rank ?? null, why: ranked?.features.why ?? null, delivered: false, note: null };
    // M5: **the rule decides whether this interrupts, not the tier** — the
    // interrupt set, per source, is the call of 2026-09-10 answering
    // plan §11.9, and it is a short named list (deliver/interrupts.js). A
    // rule in it goes to Slack the moment the verdict lands whatever its
    // tier; everything else is placed in the list, and says so.
    // Plan §14: the same question, and the statement that answered it — the
    // note below names the layer rather than always saying TRIAGE_INTERRUPT,
    // so "why didn't that buzz me" is answered on the row.
    const current = store.item(item.id);
    const gate = deliver?.allows ? deliver.allows(source, verdict.rule, current)
      : deliver?.interrupts ? { allow: deliver.interrupts(source, verdict.rule), by: 'TRIAGE_INTERRUPT' }
      : { allow: verdict.tier === 'P0', by: 'no interrupt set configured: P0 interrupts' };
    // Whether delivery wrote the item's DM itself: a delivered message did,
    // unless delivery says the redraw is still owed.
    let drawn = false;
    if (gate.allow) {
      const trigger = fresh.filter((e) => e.actor && !sameLogin(e.actor, me) && !isBot(e.actor)).at(-1) || fresh.at(-1);
      let note = 'not delivered: no delivery configured', delivered = false;
      if (state !== 'open') note = `not delivered: item is ${state}`;
      else if (deliver) {
        try { ({ delivered, note, drawn = delivered } = await deliver.deliver({ item: current, decision: { id: decisionId, ...verdict }, event: trigger })); }
        catch (e) { note = `delivery failed: ${e.message}`; log(`${item.key}: ${note}`); }
      }
      store.markDelivered(decisionId, delivered, note);
      record.delivered = delivered; record.note = note;
      if (delivered) out.delivered++;
    } else {
      // No other channel exists, so the answer is written now rather than
      // the row sitting for ever with an empty note: /api/decisions stays a
      // record of what happened to every verdict.
      record.note = `not delivered: ${verdict.rule} does not interrupt (${gate.by}); it is in the list`;
      store.markDelivered(decisionId, false, record.note);
    }
    // G5: the item moved — a new verdict, perhaps a reopen — so whatever
    // already shows it (a DM, the Home tab) follows, unless delivery just
    // wrote that DM itself.
    await moved(deliver, store.item(item.id), drawn, log);
    out.decisions.push(record);
  }
  return out;
}

/** Tell delivery an item moved for a reason other than a press (plan §16.5,
 *  G5). Optional on `deliver`, and never the reason a poll fails. */
export async function moved(deliver, item, drawn = false, log = () => {}) {
  if (!deliver?.moved || !item) return;
  try { await deliver.moved({ item, drawn }); }
  catch (e) { log(`${item.key}: could not follow the move — ${e.message}`); }
}

/** Snoozes that have ended. Each item goes back to open with a `snooze_wake`
 *  decision: a P0 is sent now (age is no bar — you asked for it); anything
 *  else is back in the list at a fresh rank, and the row says so. Runs after
 *  every poll, so "past its until" is noticed within a minute. */
export async function wake(store, { deliver = null, rank = null, now = new Date(), log = () => {} } = {}) {
  const nowIso = now.toISOString();
  const out = [];
  for (const item of store.snoozedDue(nowIso)) {
    store.setState(item.id, 'open', null, nowIso);
    store.setScore(item.id, score(item.tier, item.last_activity, now.getTime()), nowIso);
    store.addAction({ item_id: item.id, action: 'wake', by: 'system', data: { until: item.state_until } }, nowIso);
    const tier = item.tier || 'P3';
    const last = store.lastDecision(item.id);
    // Writer three of four (plan §11.8, trap 1): waking changes the state, so
    // the rank has to be recomputed with it or an item comes back sunk.
    rerank(store, rank, store.item(item.id), { matches: last?.matches || null, state: 'open', now });
    const reason = `snooze ended${last ? ' — ' + last.reason : ''}`;
    // The wake carries the original evidence forward. Without it the *second*
    // wake reads this row back as its own single `snooze_wake` match, and the
    // item is re-ranked on a synthetic rule: the claim changes and so does
    // the time curve, because the curve is chosen from the rule names.
    const decisionId = store.addDecision({ item_id: item.id, by: 'wake', rule: 'snooze_wake', tier, reason, event_ids: last?.event_ids || [], matches: last?.matches || [] }, nowIso);
    const record = { id: decisionId, item: item.key, rule: 'snooze_wake', tier, reason, delivered: false, note: null };
    let drawn = false;
    if (tier === 'P0') {
      const events = store.events(item.id);
      const event = events.filter((e) => last?.event_ids.includes(e.id)).at(-1) || events.at(-1) || null;
      let note = 'not delivered: no delivery configured', delivered = false;
      if (deliver) {
        try { ({ delivered, note, drawn = delivered } = await deliver.deliver({ item: store.item(item.id), decision: { id: decisionId, tier, reason, rule: 'snooze_wake' }, event, ignoreAge: true })); }
        catch (e) { note = `delivery failed: ${e.message}`; }
      }
      store.markDelivered(decisionId, delivered, note);
      record.delivered = delivered; record.note = note;
    } else {
      record.note = `not delivered: woke as ${tier}; it is back in the list`;
      store.markDelivered(decisionId, false, record.note);
    }
    await moved(deliver, store.item(item.id), drawn, log);
    log(`${item.key}: woke (${tier})${record.note ? ' — ' + record.note : ''}`);
    out.push(record);
  }
  return out;
}

/** Reconciliation — the third widening of the source seam (plan §12.2), for
 *  a source whose items are *state*: something is true and unfinished, and
 *  it stops being so somewhere else, with no event to say so. The runner
 *  hands this the current set of keys the source just read; anything of the
 *  source's (that the set governs — below) not in the set is resolved — closed with a `resolved` action
 *  attributed to the source, never to you, so `actions` learns no
 *  preference he did not express — and anything the source resolved that
 *  is back in the set reopens. **Only a complete read may resolve**: a read
 *  that could not see the whole set says so and this touches nothing,
 *  because resolving everything not seen would empty the list in one poll.
 *  It runs beside `wake()`, on its own path, because `ingest()` skips a
 *  batch with no fresh events and an absence has none. */
export function reconcile(store, { user, source, keys = [], complete = false, governs = null }, { rank = null, now = new Date(), log = () => {} } = {}) {
  const out = { resolved: [], reopened: [], complete };
  if (!complete) return out;
  const nowIso = now.toISOString();
  const have = new Set(keys);
  const by = `source:${source}`;
  for (const item of store.sourceItems({ user, source })) {
    // **The set has authority only over what its own mode ingested** (plan
    // §12.3 item 2). A source that is a feed *and* a state — GitHub, whose
    // inbox brings pull requests and whose issue mode brings the open set
    // of a few repositories — says with `governs` which of its items the
    // set speaks for; an item outside it is not "gone" merely for being
    // absent from a set it was never in. Nothing here knows what a mode
    // is: the predicate is the source's, and a source without one is
    // governing everything, as the ledger does.
    if (governs && !governs(item)) continue;
    const present = have.has(item.key);
    if (!present && (item.state === 'open' || item.state === 'snoozed' || item.state === 'later')) {
      store.setState(item.id, 'done', null, nowIso);
      store.addAction({ item_id: item.id, action: 'resolved', by, data: { was: item.state, reason: `gone from ${source}` } }, nowIso);
      out.resolved.push(item.key);
    } else if (present && item.state === 'done') {
      // Back in the set, and it was the source that closed it — not you.
      const last = store.actionsFor(item.id).at(-1);
      if (last?.action !== 'resolved' || last.by !== by) continue;
      store.setState(item.id, 'open', null, nowIso);
      store.setScore(item.id, score(item.tier, item.last_activity, now.getTime()), nowIso);
      store.addAction({ item_id: item.id, action: 'reopen', by: 'system', data: { was: 'done', reason: `back in ${source}` } }, nowIso);
      rerank(store, rank, store.item(item.id), { state: 'open', now });
      out.reopened.push(item.key);
    }
  }
  if (out.resolved.length || out.reopened.length) log(`reconcile: ${out.resolved.length} resolved, ${out.reopened.length} reopened`);
  return out;
}

/** The source knows the notification's reason; the history knows whether
 *  you have actually spoken in the thread. `commented` beats `subscribed`,
 *  and nothing beats `authored`. */
function refineRole(store, item, history, me, nowIso) {
  if (item.my_role === 'authored') return item;
  const spoke = history.some((e) => sameLogin(e.actor, me) && (e.kind === 'comment' || e.kind === 'review_comment' || e.kind === 'review'));
  if (spoke && (item.my_role === 'subscribed' || item.my_role === 'commented' || !item.my_role)) {
    if (item.my_role !== 'commented') store.upsertItem({ ...item, my_role: 'commented' }, nowIso);
    return { ...item, my_role: 'commented' };
  }
  return item;
}
