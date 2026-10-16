// Home Assistant to-do rules (plan §12.8): the date is the clock, and the
// list is the claim. Pure, named, ordered strongest first, every match
// returned; the last is the catch-all like every other source's.
//
// What the order says. A date is the only thing on a to-do list that can
// make a claim by itself, so anything due today or already past comes
// first, from either list. After that it is whose list it is: your inbox is
// addressed to you and the household list is addressed to the house, and
// an item on the latter is ambient until it has a date.
//
// **Nothing here interrupts.** None of these rules is in the built-in
// interrupt set (`deliver/interrupts.js`), on purpose: the whole point of
// putting the chores in the list is that they stop being a thing you are
// buzzed about. A date that has passed is still not a person waiting.
import { dueAt, isDue, isInbox, listName } from '../sources/ha.js';

const DAY = 86_400_000;
/** Whole *local days* between two moments, so "overdue" counts calendar
 *  days and not 24-hour blocks: something due yesterday reads as a day
 *  late at nine in the morning, which is what a person means by it. */
const midnight = (ms) => { const d = new Date(ms); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
const when = (d, now) => {
  const days = Math.round((midnight(now.getTime()) - midnight(dueAt(d.due))) / DAY);
  return days >= 1 ? `${days} d overdue` : 'due today';
};

export const rules = [
  // ---- P1: it has a date, and the date is now or past --------------------
  {
    name: 'due_today', tier: 'P1', claim: 0.7,
    match(item, fresh, { now = new Date() } = {}) {
      const d = item.data || {};
      if (!isDue(d.due, now)) return null;
      // The date is what claims, so the list is only context here.
      return `${when(d, now)} — ${listName(d.list)}`;
    },
  },
  // ---- P2: it is on your own list ----------------------------------------
  {
    name: 'inbox_item', tier: 'P2', claim: 0.4,
    match(item) {
      const d = item.data || {};
      if (!isInbox(d.list)) return null;
      return `in your ${listName(d.list)}${d.due ? ` — due ${d.due}` : ''}`;
    },
  },
  // ---- P3: it is on a list the house shares ------------------------------
  {
    name: 'household_item', tier: 'P3', claim: 0.2,
    match(item) {
      const d = item.data || {};
      if (!d.list || isInbox(d.list)) return null;
      // Named from the list rather than from the rule, so a third shared
      // list reads as itself rather than as "household".
      return `on the ${listName(d.list)} list${d.due ? ` — due ${d.due}` : ''}`;
    },
  },
  // ---- P3: the catch-all, as every source has ----------------------------
  { name: 'ambient', tier: 'P3', claim: 0.2, fallback: true, match: () => 'on a Home Assistant list' },
];

export default rules;
