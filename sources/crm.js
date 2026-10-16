// crm — Twenty's tasks and notes as a source (plan §12.3 item 3, the last of
// M7). Read-only: one key bound to the *Read-only (API)* role, GraphQL reads
// and nothing else, and no `marks` entry — Done on a CRM item is local.
//
// **It is state and a feed at once**, the way the GitHub source is, and the
// two halves answer two different questions.
//
//   State: every open task is an item, and `reconcile` resolves the ones
//   that leave the open set — completed or deleted in Twenty — against a
//   read that saw every page with no error. An incomplete read resolves
//   nothing (plan §12.2).
//
//   Feed: a task or note created or **changed by somebody who isn't you**
//   is an event the rules can interrupt on — but only some of them do: the
//   source says whose record it is (assigned to you, or written by you or
//   your agents) and the rules decide which of those is somebody waiting on
//   you (rules/crm.js). Twenty has no comment threads
//   on a task, so "a colleague replied" arrives as an edit to a task's body or a
//   new note on the company — which is why **edits count**: an event is
//   keyed on the record *and a fingerprint of its content* (title, body,
//   status, assignee, due date), not on the id alone. Triage is otherwise
//   blind to edits (plan §12.4); here the fingerprint is the fix, and an
//   already-emitted fingerprint is never fresh again.
//
// **Who "isn't you" is decided from the record's own `updatedBy`** — the
// timeline rows Twenty writes for API changes carry no member at all, so they
// cannot say. Not you means: `updatedBy.workspaceMemberId` is none of
// `TRIAGE_CRM_ME`, **and** `updatedBy.name` is none of `TRIAGE_CRM_AGENTS`
// (your agents act through the API under a key's name, so that list is the
// names of their keys). Anything else — a colleague in the UI, their agents,
// a key nobody has named — is somebody else, which is the safe direction to
// be wrong in.
//
// **The read is two-phase, because a body is most of the bytes.** Phase one
// is every open task and every note *without* bodies; phase two asks for the
// bodies of only the records whose `updatedAt` moved since the last read. An
// unchanged `updatedAt` is an unchanged record, so its fingerprint carries
// over from the cursor.
//
// **And the read itself is watched** (`due`): if no complete read has landed
// within `TRIAGE_CRM_STALE_MIN`, that is an event of its own — a bad key, a
// host that is down, a schema that changed — so a quiet day means nothing
// happened rather than that nothing was read.
//
// Cursor: { tasks: { [id]: { at, hash, parts } }, notes: { [id]: { at, hash,
//           parts, item } }, read_at, complete_at, complete, error, counts }.
import { createHash } from 'node:crypto';
import { oneLine } from '../lib/util.js';

const sha = (s) => createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 12);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How far back a read looks for tasks that left the open set, beyond the
 *  last read: clock skew and a slow read are the only reasons it is not 0. */
const OVERLAP_MS = 5 * 60_000;

/** The fields that make a record news. Hashed one by one, so an event can
 *  say *what* changed — "changed the body" is the thing worth reading — and
 *  the whole fingerprint is the hash of the parts. Id is identity, not
 *  content, and is deliberately not in it. */
export const TASK_FIELDS = { t: 'title', b: 'body', s: 'status', a: 'assignee', d: 'due date' };
export const NOTE_FIELDS = { t: 'title', b: 'body' };

export function fingerprint(fields) {
  const parts = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, sha(v)]));
  return { parts, hash: sha(Object.keys(parts).sort().map((k) => `${k}=${parts[k]}`).join('|')) };
}

/** Which fields differ between two sets of parts, by name. */
export function changedFields(was, now, names) {
  if (!was) return [];
  return Object.keys(names).filter((k) => was[k] !== now[k]).map((k) => names[k]);
}

/** Who did it, as Twenty records it on the record itself. */
export function actorOf(by) {
  return { source: by?.source || null, member: by?.workspaceMemberId || null, name: by?.name || null };
}

/** You, or one of your agents — the only two things that are not
 *  "somebody else". Both lists are config; a name is compared without case
 *  because a key's name is typed by hand. */
export function isOther(by, { self = new Set(), agents = [] } = {}) {
  const a = actorOf(by);
  if (a.member && self.has(a.member)) return false;
  const n = String(a.name || '').trim().toLowerCase();
  if (n && agents.some((x) => String(x).trim().toLowerCase() === n)) return false;
  return true;
}

/** How a reason names the actor: the member's name, and how they did it
 *  when it was not by hand — "through the API" is what tells an agent's
 *  edit from a person's. */
export function who(by) {
  const a = actorOf(by);
  const name = a.name || (a.member ? 'a workspace member' : 'someone');
  return a.source && a.source !== 'MANUAL' ? `${name} (${a.source.toLowerCase()})` : name;
}

/** `TRIAGE_CRM_ME` → member ids. Each entry is an id, an email, or a full
 *  name, matched against the workspace's members on every read; one that
 *  matches nobody is an error rather than a smaller set, because an owner the
 *  source cannot recognise makes every one of their own edits an interrupt. */
export function resolveSelf(entries = [], members = []) {
  const out = new Set();
  for (const e of entries) {
    const s = String(e).trim();
    if (!s) continue;
    const lc = s.toLowerCase();
    const m = members.find((x) => x.id === s || String(x.userEmail || '').toLowerCase() === lc || memberName(x).toLowerCase() === lc);
    if (m) out.add(m.id);
    else if (UUID.test(s)) out.add(s);   // a member id need not be visible to be trusted
    else throw new Error(`TRIAGE_CRM_ME: "${s}" is no workspace member (an id, an email or a full name)`);
  }
  return out;
}

const memberName = (m) => [m?.name?.firstName, m?.name?.lastName].filter(Boolean).join(' ');

/** A due date is a moment in Twenty, not a day. "Due" is today or past,
 *  with today ending at local midnight — the same test the household lists
 *  use, so a task due at 9 am is due all day. */
export function isDue(due, now = new Date()) {
  const t = due ? Date.parse(due) : NaN;
  if (!Number.isFinite(t)) return false;
  return t <= new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
}

/** The company a record is about: a company target first, else the
 *  company of a person target. Null when it targets neither. */
function companyOf(targets, people) {
  const edges = targets?.edges || [];
  for (const e of edges) if (e.node?.targetCompanyId) return e.node.targetCompanyId;
  for (const e of edges) { const c = people.get(e.node?.targetPersonId); if (c) return c; }
  return null;
}

/** Everything one poll needs, read in parallel; `complete` only when every
 *  list saw its last page and every body asked for came back. Any error
 *  throws — a failed poll is recorded as one and resolves nothing. */
export async function read(api, { since = null, prev = null } = {}) {
  const [members, companies, people, tasks, notes] = await Promise.all([api.members(), api.companies(), api.people(), api.tasks({ since }), api.notes()]);
  let complete = [members, companies, people, tasks, notes].every((r) => r.complete);
  // A body is fetched only for a record that moved — and, for a task that is
  // already done, only if it was open last time: the poll ignores the rest.
  const moved = (rows, held, wanted = () => true) => rows.filter((r) => held?.[r.id]?.at !== r.updatedAt && wanted(r)).map((r) => r.id);
  const [taskBodies, noteBodies] = await Promise.all([
    api.bodies('tasks', moved(tasks.rows, prev?.tasks, (t) => t.status !== 'DONE' || !!prev?.tasks?.[t.id])),
    api.bodies('notes', moved(notes.rows, prev?.notes)),
  ]);
  return { members: members.rows, companies: companies.rows, people: people.rows, tasks: tasks.rows, notes: notes.rows, taskBodies, noteBodies, complete };
}

const taskKey = (id) => `crm:task:${id}`;
const noteKey = (id) => `crm:note:${id}`;
export const HEALTH_KEY = 'crm:health';

export default {
  name: 'crm',
  every: 60_000,
  describe: 'Twenty: open tasks as state, and any task or note changed by someone who is not you as an event — an interrupt when the task is yours',

  /** A task of yours, or one with a date, is waiting on you; anybody else's
   *  undated task is a fact about the engagement and does not sharpen by
   *  sitting. A note is news. The read failing is somebody — you — not
   *  knowing, which only gets worse. */
  time: (item) => {
    if (item.kind === 'health') return 'waiting';
    if (item.kind === 'note') return 'fading';
    return item.data?.mine || item.data?.due ? 'waiting' : 'flat';
  },

  /** Plan §14.3: the company is the project, named by `TRIAGE_CRM_PROJECTS`
   *  (`Acme Corp=acme`) or by itself when unnamed. */
  project: (item) => item.data?.project || null,

  /** The read's own alarm, on the clock rather than on an answer — exactly
   *  why `due` exists (lib/runner.js): it runs before the poll, in its own
   *  try, so a CRM that never answers still raises it. The event is keyed on
   *  the last complete read, so one outage is one event however many
   *  minutes it lasts, and the next outage is a new one. Before any read has
   *  ever completed, the clock starts at boot. */
  due({ cursor, health = {}, staleMs = 30 * 60_000, url = null, now = new Date() }) {
    const since = cursor?.complete_at || health.startedAt || null;
    if (!since || !staleMs) return null;
    const ms = now.getTime() - Date.parse(since);
    if (!(ms >= staleMs)) return null;
    const minutes = Math.round(ms / 60_000);
    const error = health.error || (cursor && !cursor.complete ? cursor.error || 'the last read was incomplete' : null);
    return {
      batches: [{
        item: {
          source: 'crm', key: HEALTH_KEY, kind: 'health', title: 'The CRM is not being read',
          url, repo: 'crm', actors: [], my_role: 'owner', last_activity: since, last_seen: now.toISOString(),
          data: { object: 'health', since, error },
        },
        events: [{ key: `crm:unread:${since}`, ts: now.toISOString(), kind: 'unread', actor: null, body: error, url, data: { since, minutes, error } }],
      }],
    };
  },

  async poll({ api, self = [], agents = [], projects = {}, health = {}, cursor, now = new Date(), log = () => {} }) {
    const nowIso = now.toISOString();
    const prev = cursor?.tasks ? cursor : null;
    // The first read ever is a baseline: what is already there is stored and
    // ranked, but nobody changed it *while triage was watching*, so it does
    // not interrupt. Every read after that does.
    const baseline = !prev;
    const since = prev?.read_at ? new Date(Date.parse(prev.read_at) - OVERLAP_MS).toISOString() : null;
    let r;
    try { r = await read(api, { since, prev }); }
    catch (e) { health.error = e.message; throw e; }

    const selfIds = resolveSelf(self, r.members);
    const whoIs = { self: selfIds, agents };
    const names = new Map(r.members.map((m) => [m.id, memberName(m)]));
    const companies = new Map(r.companies.map((c) => [c.id, c.name]));
    const people = new Map(r.people.map((p) => [p.id, p.companyId]));
    const projectOf = (companyId) => {
      const name = companies.get(companyId);
      return name ? projects[name] || name : null;
    };
    let complete = r.complete;
    const batches = [];
    const tasks = {}, notes = {};
    let open = 0, closed = 0, others = 0;

    for (const t of r.tasks) {
      const was = prev?.tasks?.[t.id];
      const isOpen = t.status !== 'DONE';
      // A task outside the open set is only news if it was open last time —
      // that is somebody finishing it. Anything else done is history.
      if (!isOpen && !was) continue;
      let fp;
      if (was && was.at === t.updatedAt) fp = { parts: was.parts, hash: was.hash };
      else if (r.taskBodies.has(t.id)) fp = fingerprint({ t: t.title || '', b: r.taskBodies.get(t.id), s: t.status || '', a: t.assigneeId || '', d: t.dueAt || '' });
      else { complete = false; if (was) tasks[t.id] = was; continue; }   // deleted between the two phases
      if (isOpen) { tasks[t.id] = { at: t.updatedAt, hash: fp.hash, parts: fp.parts }; open++; }
      else closed++;
      if (!isOpen && was.hash === fp.hash) continue;
      const by = actorOf(t.updatedBy);
      const other = isOther(t.updatedBy, whoIs);
      // Counted only when the content moved: the status line says what
      // happened on this read, not who touched each task last.
      if (other && !baseline && was?.hash !== fp.hash) others++;
      const companyId = companyOf(t.taskTargets, people);
      const project = projectOf(companyId);
      const url = api.link('task', t.id);
      const mine = !!t.assigneeId && selfIds.has(t.assigneeId);
      // Written by you or one of your agents: the CRM's "a thread you
      // opened", since a task has no comments and an edit is the reply.
      const authored = !!t.createdBy && !isOther(t.createdBy, whoIs);
      const body = r.taskBodies.get(t.id);
      batches.push({
        item: {
          source: 'crm', key: taskKey(t.id), kind: 'task', title: oneLine(t.title || '(untitled task)', 200),
          url, repo: project || 'crm', actors: [by.name].filter(Boolean),
          my_role: mine ? 'assigned' : authored ? 'authored' : 'subscribed', last_activity: t.updatedAt, last_seen: nowIso,
          data: { object: 'task', id: t.id, status: t.status || null, due: t.dueAt || null, assignee: t.assigneeId || null, assignee_name: names.get(t.assigneeId) || null, mine, authored, company: companies.get(companyId) || null, project },
        },
        events: [{
          key: `${taskKey(t.id)}:${fp.hash}`, ts: t.updatedAt,
          kind: baseline ? 'seen' : !was ? (t.createdAt === t.updatedAt ? 'created' : 'appeared') : 'changed',
          actor: by.name, body: body != null ? oneLine(body, 600) || null : null, url,
          data: { object: 'task', by, other, baseline, status: t.status || null, mine, authored, changed: changedFields(was?.parts, fp.parts, TASK_FIELDS) },
        }],
      });
    }
    // An incomplete read keeps what it did not see: forgetting a task on a
    // short read would make its next sighting look like news.
    if (!complete) for (const [id, v] of Object.entries(prev?.tasks || {})) if (!tasks[id] && !r.tasks.some((t) => t.id === id)) tasks[id] = v;

    for (const n of r.notes) {
      const was = prev?.notes?.[n.id];
      let fp;
      if (was && was.at === n.updatedAt) fp = { parts: was.parts, hash: was.hash };
      else if (r.noteBodies.has(n.id)) fp = fingerprint({ t: n.title || '', b: r.noteBodies.get(n.id) });
      else { complete = false; if (was) notes[n.id] = was; continue; }
      const other = isOther(n.updatedBy, whoIs);
      // A note is an item only once somebody else has written in it — there
      // are dozens of your own, and they are your notes, not your queue.
      // After that it stays one, so your reply on it is part of its story.
      const item = !!was?.item || (other && !baseline);
      notes[n.id] = { at: n.updatedAt, hash: fp.hash, parts: fp.parts, item };
      if (!item || was?.hash === fp.hash) continue;
      if (other) others++;
      const by = actorOf(n.updatedBy);
      const authored = !!n.createdBy && !isOther(n.createdBy, whoIs);
      const companyId = companyOf(n.noteTargets, people);
      const project = projectOf(companyId);
      const url = api.link('note', n.id);
      const body = r.noteBodies.get(n.id);
      batches.push({
        item: {
          source: 'crm', key: noteKey(n.id), kind: 'note', title: oneLine(n.title || '(untitled note)', 200),
          url, repo: project || 'crm', actors: [by.name].filter(Boolean), my_role: authored ? 'authored' : 'subscribed',
          last_activity: n.updatedAt, last_seen: nowIso,
          data: { object: 'note', id: n.id, authored, company: companies.get(companyId) || null, project },
        },
        events: [{
          key: `${noteKey(n.id)}:${fp.hash}`, ts: n.updatedAt, kind: !was ? 'created' : 'changed',
          actor: by.name, body: body != null ? oneLine(body, 600) || null : null, url,
          data: { object: 'note', by, other, baseline: false, authored, changed: changedFields(was?.parts, fp.parts, NOTE_FIELDS) },
        }],
      });
    }
    if (!complete) for (const [id, v] of Object.entries(prev?.notes || {})) if (!notes[id] && !r.notes.some((n) => n.id === id)) notes[id] = v;

    const error = complete ? null : 'a page cap was reached or a record vanished mid-read';
    health.error = error;
    if (!complete) log(`the read was incomplete (${error}); reconcile will not resolve on this pass`);
    return {
      batches,
      cursor: {
        tasks, notes, read_at: nowIso, complete_at: complete ? nowIso : prev?.complete_at || null, complete, error,
        counts: { open, closed, notes: r.notes.length, others },
      },
      status: `${open} open tasks, ${r.notes.length} notes${baseline ? ' (baseline)' : ''}${others ? `, ${others} changed by someone else` : ''}${complete ? '' : ', INCOMPLETE'}`,
    };
  },

  /** The current set (plan §12.2), from the cursor the poll just wrote: the
   *  open tasks, and the notes that are items and still exist. The health
   *  item is never in it, so a complete read resolves the alarm — the CRM is
   *  being read again, and the source says so by closing it. */
  reconcile({ cursor }) {
    if (!cursor?.tasks) return null;
    const keys = [
      ...Object.keys(cursor.tasks).map(taskKey),
      ...Object.entries(cursor.notes || {}).filter(([, v]) => v.item).map(([id]) => noteKey(id)),
    ];
    return { keys, complete: !!cursor.complete, error: cursor.error || null };
  },

  describeCursor(state) {
    if (!state || typeof state !== 'object') return state;
    return { open_tasks: state.counts?.open ?? Object.keys(state.tasks || {}).length, notes: state.counts?.notes ?? 0, note_items: Object.values(state.notes || {}).filter((n) => n.item).length, complete: !!state.complete, read_at: state.read_at || null, complete_at: state.complete_at || null, error: state.error || null };
  },
};
