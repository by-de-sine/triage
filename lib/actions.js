// actions.js — what the human does to an item, on one code path. The Slack
// buttons, the /api/items/:id/act endpoint and the page all call `act`;
// nothing else changes an item's state.
//
//   done    state done, and whatever the item's *source* does about that,
//           done too — for GitHub, the thread is marked read so the two
//           inboxes agree. A mark that fails (no thread id, a token without
//           the scope, GitHub down) is logged and kept on the action row;
//           the local state still changes, because your inbox is yours.
//           What a source does is a `marks` entry, keyed by source name, not
//           a branch here — built at boot from each source's own `mark`
//           (GitHub marks the thread read, GitLab marks the todo done, Home
//           Assistant ticks the item off) or from a sentence for a source
//           triage only reads. A mark that throws is caught and said.
//   snooze  state snoozed until `until` (ISO, or 30m / 1h / 1d); a poll that
//           finds the time passed wakes it and re-delivers at its tier.
//   later   state later; the score sinks beneath every open item and the
//           item has no date. A new P0 on it reopens it.
//   mute    state muted; still tiered and logged, never delivered again.
//   open    back to open — the undo for any of the four.
//   answer  a choice from the item's own list (a ledger row's `[confirm: …]`,
//           plan §12.3): state done, and the choice on the action row, which
//           is how whoever asked reads the answer back — through the API,
//           never by triage writing into their file (§13.5: an action is a
//           fact about what you did; the source stays read-only).
//
// Every action is a row in `actions`, and the DM that carried the item is
// updated in place through `deliver.reflect` when one exists.
import { score } from './rules.js';
import { rerank } from './rank.js';

export const ACTIONS = ['done', 'snooze', 'later', 'mute', 'open', 'answer'];
export const DURATIONS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "1h", "30m", "2d" or an ISO time -> ISO, or null when unreadable or past. */
export function parseUntil(v, now = new Date()) {
  if (v == null || v === '') return null;
  const m = /^\s*(\d+)\s*([mhd])\s*$/i.exec(String(v));
  let t;
  if (m) t = now.getTime() + parseInt(m[1], 10) * DURATIONS[m[2].toLowerCase()];
  else t = Date.parse(v);
  if (!Number.isFinite(t) || t <= now.getTime()) return null;
  return new Date(t).toISOString();
}

const bad = (status, message) => Object.assign(new Error(message), { status });

/** What Done does outside triage, per source. A source with no entry here
 *  is one triage only reads, and Done on its items is purely local. */
export const NOTHING_TO_MARK = (source) => `nothing marked outside triage: ${source} is read-only here`;

export function createActor({ store, marks = null, deliver = null, rank = null, now = () => new Date(), log = () => {} }) {
  const external = Object.fromEntries(Object.entries(marks || {}).map(([name, f]) => [name, async (item) => { try { return await f(item); } catch (e) { return `not marked: ${e.message}`; } }]));

  return async function act({ id, action, until, choice, by = 'api' }) {
    const item = store.item(id);
    if (!item) throw bad(404, `no item ${id}`);
    if (!ACTIONS.includes(action)) throw bad(400, `action must be one of ${ACTIONS.join(', ')}`);
    const t = now();
    const nowIso = t.toISOString();
    let untilIso = null, marked = null, answered = null;
    switch (action) {
      case 'answer': {
        const choices = item.data?.choices || [];
        const pick = choices.find((c) => c.key === String(choice || '').toUpperCase() || c.label === choice);
        if (!choices.length) throw bad(400, 'this item has no choices to answer');
        if (!pick) throw bad(400, `choice must be one of ${choices.map((c) => `${c.key}) ${c.label}`).join(', ')}`);
        // One answer. A second request racing the first reads the item
        // after it went done and is refused, so the action row that the
        // asker reads back is the one answer given; reopen is the undo.
        if (item.state === 'done') throw bad(409, 'already answered or done — reopen it to answer again');
        answered = pick;
        store.setState(item.id, 'done', null, nowIso);
        const mark = external[item.source];
        marked = mark ? await mark(item) : NOTHING_TO_MARK(item.source);
        break;
      }
      case 'done': {
        store.setState(item.id, 'done', null, nowIso);
        const mark = external[item.source];
        marked = mark ? await mark(item) : NOTHING_TO_MARK(item.source);
        break;
      }
      case 'snooze':
        untilIso = parseUntil(until, t);
        if (!untilIso) throw bad(400, 'snooze needs until: an ISO time in the future, or 30m / 1h / 1d');
        store.setState(item.id, 'snoozed', untilIso, nowIso);
        break;
      case 'later':
        store.setState(item.id, 'later', null, nowIso);
        store.setScore(item.id, score(item.tier, item.last_activity, t.getTime(), { later: true }), nowIso);
        // Writer one of the two here (plan §11.8, trap 1). Later has to sink
        // in *both* orderings or the verb means two different things: an
        // item you tossed away would come back mis-ranked rather than sunk.
        rerank(store, rank, item, { state: 'later', now: t });
        break;
      case 'mute':
        store.setState(item.id, 'muted', null, nowIso);
        break;
      case 'open':
        store.setState(item.id, 'open', null, nowIso);
        store.setScore(item.id, score(item.tier, item.last_activity, t.getTime()), nowIso);
        rerank(store, rank, item, { state: 'open', now: t });   // and writer two: the undo has to undo both
        break;
    }
    store.addAction({ item_id: item.id, action, until: untilIso, by, data: { ...(marked ? { marked } : {}), ...(answered ? { choice: answered.key, label: answered.label } : {}) } }, nowIso);
    log(`${item.key}: ${action}${answered ? ` ${answered.key}) ${answered.label}` : ''}${untilIso ? ' until ' + untilIso : ''} by ${by}${marked ? ' — ' + marked : ''}`);
    const updated = store.item(item.id);
    const result = { item: updated, action, until: untilIso, marked, ...(answered ? { choice: answered.key, label: answered.label } : {}) };
    if (deliver?.reflect) {
      try { await deliver.reflect(result); } catch (e) { log(`${item.key}: could not update the DM — ${e.message}`); }
    }
    return result;
  };
}
