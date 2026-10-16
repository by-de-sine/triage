// ha — the household's to-do lists as a source (plan §12.8). Reads the
// Home Assistant lists `HA_LISTS` names — `todo.alice_inbox`,
// `todo.household` — through `todo.get_items`, and turns every
// item still needing action into an item here. The only write in the whole
// source is Done: `todo.update_item` with `status: completed`, so ticking
// something off in triage ticks it off on the kitchen screen.
//
// **It is state, not a feed**, and it is shaped exactly like the ledger
// (plan §12.2): the read is always the *whole* list, so `reconcile` is a
// complete set and anything no longer in it is resolved — an item ticked
// off on the tablet, or deleted, has no event to announce itself. A list
// that could not be read makes the read incomplete and resolves nothing,
// because resolving everything unseen would empty the list in one poll.
//
// **Identity is the uid, not the text.** This is the one place it differs
// from the ledger, and it is the better end of that trade: Home Assistant
// gives every to-do item a stable uid (`local_todo` writes an ICS `UID`),
// so renaming an item keeps it — which is what somebody editing a chore on
// a wall tablet means by editing it. What re-tiers an item is the *event*
// key, which hashes summary, due and status: a reworded or newly dated item
// is news about the same item.
//
// Items have no timestamps of any kind — a to-do list is not an activity
// log — so, as in the ledger, `since` (when the item was last seen to
// change) is the clock, and an item past its due date waits from the due
// date rather than from when triage first saw it.
//
// Cursor: { items: { [key]: { hash, since } }, lists, read_at, count,
//           completed, complete, error }.
import { createHash } from 'node:crypto';
import { oneLine } from '../lib/util.js';

const sha = (s) => createHash('sha1').update(s).digest('hex');

/** The inbox is a list addressed to one person; everything else is shared.
 *  The test is the entity id's own name, so `todo.alice_inbox` is an inbox
 *  and `todo.household` is not, and adding `todo.ann_inbox` needs no code.
 *  It is what `my_role` and two of the three rules read. */
export const isInbox = (list) => /(^|[._])inbox$/.test(String(list || '').toLowerCase());

/** The list's own name, for a reason a human reads: `todo.household` reads
 *  as `household`. */
export const listName = (list) => String(list || '').replace(/^todo\./, '').replace(/_/g, ' ') || 'a list';

/** When an item is actually late, in milliseconds.
 *
 *  Home Assistant returns `due` as either a date (`2026-09-20`) or a
 *  datetime, and the two mean different things: **a date with no time is
 *  due at the end of that day**, locally, because a chore due today is not
 *  late until the day is out. A datetime is the moment it says. Anything
 *  unparseable is no due date at all rather than an epoch-zero one. */
export function dueAt(due) {
  if (!due) return null;
  const s = String(due).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999).getTime();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Due today or already past — the P1 test, and the only question the rules
 *  ask about a date. "Today" ends at midnight local, so an item dated today
 *  qualifies all day and one dated tomorrow does not qualify at all. */
export function isDue(due, now = new Date()) {
  const t = dueAt(due);
  if (t == null) return false;
  return t <= new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
}

/** One `todo.get_items` item → what this source needs, or null when it
 *  cannot be keyed. Home Assistant omits a field rather than sending null,
 *  so everything but `summary` and `status` is optional. */
export function normalise(list, it) {
  const uid = it?.uid ? String(it.uid) : null;
  if (!uid) return null;
  const summary = oneLine(it.summary || '', 200) || '(no title)';
  const status = it.status === 'completed' ? 'completed' : 'needs_action';
  const due = it.due ? String(it.due) : null;
  const description = it.description ? oneLine(it.description, 600) : null;
  return {
    key: `ha:${list}:${uid}`, list, uid, summary, status, due, description,
    // What makes it *news*: the three fields a person can change on a wall
    // tablet. The uid is deliberately not in it — that is identity, and
    // hashing it would make every item its own single event for ever.
    hash: sha(`${summary}|${due || ''}|${status}`).slice(0, 12),
  };
}

/** Every list, read whole. A list that fails is not fatal on its own — the
 *  others are still worth having — but it makes the read incomplete, so
 *  reconcile resolves nothing on that pass. All of them failing is a failed
 *  poll: an empty read and an unreachable Home Assistant must not look the
 *  same, or one network hiccup closes every chore in the house. */
export async function read(api, lists = []) {
  // No lists is a misconfiguration and not an empty house: read as "the
  // whole set is nothing", it would resolve every chore on the next pass.
  if (!lists.length) throw new Error('HA_LISTS names no list');
  const rows = [];
  let ok = 0, complete = true, error = null;
  for (const list of lists) {
    let items;
    try { items = await api.items(list); }
    catch (e) { complete = false; error = error || `${list}: ${e.message}`; continue; }
    ok++;
    for (const it of items) {
      const r = normalise(list, it);
      // An item with no uid cannot be keyed *or* ticked off, and it cannot
      // be told apart from one of ours that lost its uid — so it is skipped
      // and the set is not the whole set.
      if (!r) { complete = false; error = error || `${list}: an item has no uid`; continue; }
      rows.push(r);
    }
  }
  if (!ok) throw new Error(error || 'no list could be read');
  return { rows, lists: ok, complete, error };
}

/** Done, outside triage: the one write this source makes (`server.js`
 *  `marks`). A refusal is returned rather than thrown — the local state
 *  still changes, because your queue is yours (lib/actions.js). */
export const markDone = (api) => async (item) => {
  const list = item.data?.list || null;
  const prefix = list ? `ha:${list}:` : null;
  const uid = prefix && item.key.startsWith(prefix) ? item.key.slice(prefix.length) : null;
  if (!uid) return 'not ticked off: the item does not name a list and a uid';
  try { await api.complete(list, uid); return `ticked off in ${listName(list)}`; }
  catch (e) { return `not ticked off: ${e.message}`; }
};

export default {
  name: 'ha',
  every: 60_000,
  describe: 'the household to-do lists in Home Assistant: todo.get_items on each, read whole and reconciled',

  /** An item in your inbox, or one with a date on it, is somebody waiting —
   *  the wait is the cost. A shared chore with no date is not: it sits on
   *  the fridge, and sitting there longer does not make it more urgent.
   *  Read from the item and not from the rules that fired, because it is a
   *  question about what kind of thing it is, and the answer must be the
   *  same on a backfill pass with no verdict on record. */
  time: (item) => (isInbox(item.data?.list) || item.data?.due ? 'waiting' : 'flat'),

  /** Plan §14.3: the list is the project. "Never buzz me for household" is
   *  a sentence somebody will want to write, and the two lists genuinely
   *  belong to different people. */
  project: (item) => item.data?.list || null,

  async poll({ api, lists = [], dashboard = null, cursor, now = new Date(), log = () => {} }) {
    const nowIso = now.toISOString();
    const prev = cursor?.items || {};
    const { rows, lists: ok, complete, error } = await read(api, lists);
    if (!complete) log(`the read was incomplete (${error}); reconcile will not resolve on this pass`);
    const next = {};
    const batches = [];
    let completed = 0;
    for (const r of rows) {
      // A completed item is read but never ingested: it is not something to
      // do, and its absence from the key set below is what resolves it.
      if (r.status !== 'needs_action') { completed++; continue; }
      const was = prev[r.key];
      const since = was?.hash === r.hash ? was.since : nowIso;
      next[r.key] = { hash: r.hash, since };
      // Past its date, it has been waiting *since the date* — not since
      // triage noticed — so the longer overdue it is the higher it sits.
      // The ledger's nudge column works the same way, for the same reason.
      const dueMs = dueAt(r.due);
      const waitingSince = dueMs != null && dueMs < Date.parse(since) ? new Date(dueMs).toISOString() : since;
      batches.push({
        item: {
          source: 'ha', key: r.key, kind: 'todo', title: r.summary,
          url: dashboard, repo: null, actors: [],
          my_role: isInbox(r.list) ? 'owner' : 'subscribed',
          last_activity: waitingSince, last_seen: nowIso,
          data: { list: r.list, due: r.due, description: r.description },
        },
        events: [{
          key: `${r.key}:${r.hash}`, ts: since,
          kind: was ? 'changed' : 'added',
          actor: null, body: r.description, url: dashboard,
          data: { list: r.list, due: r.due, status: r.status },
        }],
      });
    }
    return {
      batches,
      cursor: { items: next, lists: [...lists], read_at: nowIso, count: batches.length, completed, complete, error },
      status: `${ok}/${lists.length} lists — ${batches.length} to do, ${completed} done${complete ? '' : ', INCOMPLETE'}`,
    };
  },

  /** The current set, for the runner to resolve against (plan §12.2). From
   *  the cursor the poll just wrote, not from a second read: the set is
   *  exactly what that read ingested, and asking Home Assistant twice a
   *  minute for the same two lists to learn the same answer is a cost with
   *  no buyer. `null` before the first read — there is nothing to say.
   *
   *  **`governs` is what makes taking a list out of `HA_LISTS` safe**, and
   *  it is the same predicate `sources/github.js` returns for the same
   *  reason: a set speaks only for what it actually read. Without it, the
   *  first poll after a list is dropped would resolve every item that was
   *  ever on it — they are absent from the new set, but nothing looked.
   *  The equality check below cannot catch that on its own: the poll writes
   *  the cursor *before* reconcile reads it, so by then the two agree. It
   *  is kept for a caller that asks directly with a different set. */
  reconcile({ cursor, lists = [] }) {
    const st = cursor;
    if (!st?.items || !lists.length) return null;
    const watched = new Set(lists);
    const same = JSON.stringify([...(st.lists || [])].sort()) === JSON.stringify([...lists].sort());
    return {
      keys: Object.keys(st.items),
      complete: !!st.complete && same,
      error: same ? st.error || null : 'HA_LISTS changed since the last read',
      governs: (item) => watched.has(item.data?.list),
    };
  },

  /** What /api/sources shows: how much is on the lists, not every key. */
  describeCursor(state) {
    if (!state || typeof state !== 'object') return state;
    return { lists: state.lists || [], to_do: state.count ?? 0, done: state.completed ?? 0, complete: !!state.complete, read_at: state.read_at || null };
  },
};
