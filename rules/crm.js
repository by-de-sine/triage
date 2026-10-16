// CRM rules (plan §12.3 item 3): somebody else touching the work, and the
// read itself failing, are what may be worth a buzz; everything else is an
// open task that ranks with the rest of the list. Pure, named, ordered
// strongest first, every match returned; the last is the catch-all like
// every other source's.
//
// **P0 means what it means on GitHub: somebody is waiting on you.** Twenty
// has no comment threads, so a reply arrives as an edit — but an edit is
// not a reply until it lands on something of yours. The first cut
// (2026-10-02) made *every* edit by somebody else a P0, and the first real
// afternoon of it (2026-10-15) was a colleague's agent working through their
// own tasks: nine Slack posts in fifteen minutes, none of them on a task of
// yours. So the edit is split by whose record it lands on, the
// way GitHub splits a comment by whose thread it is on:
//
//   handed_to_me          P0  somebody else gave you a task — created it
//                             assigned to you, or moved it onto you. The
//                             CRM's `review_requested`.
//   changed_on_my_task    P0  somebody else changed a task assigned to you.
//                             The CRM's `reply_to_my_comment`: it is yours
//                             and they wrote in it.
//   changed_what_i_wrote  P1  somebody else changed a task or note you (or
//                             your agents) wrote, that is not assigned to
//                             you. The CRM's `comment_on_my_thread`: yours,
//                             and it moved — usually the person you handed
//                             it to, reporting back.
//   changed_by_other      P2  anything else somebody else changed: their own
//                             tasks, a note on the company. Worth knowing
//                             today, in the list.
//
// **Two interrupt by default** (`deliver/interrupts.js`) — `handed_to_me`,
// `changed_on_my_task` — plus `crm_unread`; the rest never do unless a
// statement arms them (`+crm:changed_what_i_wrote`, or `+crm:changed_by_other`
// to hear about every edit, which is the 2026-10-02 behaviour). The
// interrupt test reads the *strongest* match only, so arming
// `changed_by_other` alone does not re-arm the two above it.
//
//   crm_unread         the CRM has not been read completely for the stale
//                      window. Without it a quiet CRM and a CRM nobody is
//                      reading look the same, and the second is the one
//                      that costs a client.
import { isDue, who } from '../sources/crm.js';

/** An edit by somebody else, made while triage was watching. */
const edited = (e) => e.data?.other && !e.data?.baseline;

const STATUS = { TODO: 'To do', IN_PROGRESS: 'In progress', DONE: 'Done' };

/** What one event did, in the words a person would use: "marked it Done",
 *  "changed the body", "added a note". */
export function didWhat(e) {
  const d = e.data || {};
  const what = d.object === 'note' ? 'note' : 'task';
  if (e.kind === 'created' || e.kind === 'appeared') return `added a ${what}`;
  const changed = d.changed || [];
  if (changed.includes('status') && changed.length === 1) return `marked it ${STATUS[d.status] || d.status || 'something new'}`;
  if (!changed.length) return `changed the ${what}`;
  const named = changed.map((f) => (f === 'status' ? `status (now ${STATUS[d.status] || d.status})` : f));
  return `changed the ${named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0]}`;
}

export const rules = [
  // ---- P0: nobody is reading the CRM -------------------------------------
  {
    name: 'crm_unread', tier: 'P0', claim: 1,
    match(item, fresh) {
      const hit = fresh.find((e) => e.kind === 'unread');
      if (!hit) return null;
      const d = hit.data || {};
      return `the CRM has not been read for ${d.minutes ?? '?'} min${d.error ? ` — ${d.error}` : ''}`;
    },
  },
  // ---- P0: somebody else is waiting on you --------------------------------
  {
    name: 'handed_to_me', tier: 'P0', claim: 0.95,
    match(item, fresh) {
      const hit = fresh.filter((e) => edited(e) && e.data.mine
        && (e.kind === 'created' || e.kind === 'appeared' || (e.data.changed || []).includes('assignee'))).at(-1);
      if (!hit) return null;
      return `${who(hit.data.by)} ${hit.kind === 'changed' ? 'assigned it to you' : 'gave you a task'}`;
    },
  },
  {
    name: 'changed_on_my_task', tier: 'P0', claim: 0.9,
    match(item, fresh) {
      const hit = fresh.filter((e) => edited(e) && e.data.mine).at(-1);
      return hit ? `${who(hit.data.by)} ${didWhat(hit)} — your task` : null;
    },
  },
  // ---- P1: yours, and it moved ---------------------------------------------
  {
    name: 'changed_what_i_wrote', tier: 'P1', claim: 0.55,
    match(item, fresh) {
      const hit = fresh.filter((e) => edited(e) && e.data.authored).at(-1);
      if (!hit) return null;
      return `${who(hit.data.by)} ${didWhat(hit)} — a ${hit.data.object === 'note' ? 'note' : 'task'} you wrote`;
    },
  },
  // ---- P1: a task with a date, and the date is now or past ---------------
  {
    name: 'task_due', tier: 'P1', claim: 0.7,
    match(item, fresh, { now = new Date() } = {}) {
      const d = item.data || {};
      if (item.kind !== 'task' || d.status === 'DONE' || !isDue(d.due, now)) return null;
      return Date.parse(d.due) < now.getTime() - 86_400_000 ? `overdue since ${d.due.slice(0, 10)}` : 'due today';
    },
  },
  // ---- P2: somebody else moved something that is not yours ----------------
  {
    name: 'changed_by_other', tier: 'P2', claim: 0.3,
    match(item, fresh) {
      const hit = fresh.filter(edited).at(-1);
      return hit ? `${who(hit.data.by)} ${didWhat(hit)}` : null;
    },
  },
  // ---- P2: a task assigned to you ----------------------------------------
  {
    name: 'task_mine', tier: 'P2', claim: 0.4,
    match(item) {
      const d = item.data || {};
      if (item.kind !== 'task' || !d.mine || d.status === 'DONE') return null;
      return `assigned to you${d.status === 'IN_PROGRESS' ? ', in progress' : ''}${d.due ? ` — due ${d.due.slice(0, 10)}` : ''}`;
    },
  },
  // ---- P3: anybody's, or nobody's ----------------------------------------
  {
    name: 'task_open', tier: 'P3', claim: 0.15,
    match(item) {
      const d = item.data || {};
      if (item.kind !== 'task' || d.status === 'DONE') return null;
      return d.assignee_name ? `open — ${d.assignee_name}'s` : 'open, unassigned';
    },
  },
  // ---- P3: the catch-all, as every source has ----------------------------
  { name: 'ambient', tier: 'P3', claim: 0.1, fallback: true, match: (item) => `in the CRM (${item.kind})` },
];

export default rules;
