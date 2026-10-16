// Ledger rules (plan §12.3): the Owner column is the claim signal, the ask
// is what kind of answer is wanted, and the nudge date is the clock. Pure,
// named, ordered strongest first, every match returned; the last is the
// catch-all like every other source's.
//
// What the order says. A quick answer — an ack, or a confirm with its
// choices on the line — floats above a hard action at the same age, because
// working down a list is a throughput problem (§11.4 item 3, now structural:
// the ask *is* the effort signal). A row past its nudge corroborates
// whichever of those it is. An agent's row is ambient, and a struck row is
// history.
import { isHuman } from '../sources/ledger.js';

const DAY = 86_400_000;
const daysPast = (nudge, now) => (nudge ? Math.floor((now.getTime() - Date.parse(nudge)) / DAY) : null);
const who = (d) => d.owner || 'someone';
const live = (d) => isHuman(d.owner) && !d.struck;

export const rules = [
  // ---- P1: yours, and quick — an answer you can give from the line --------
  {
    name: 'quick_answer', tier: 'P1', claim: 0.8,   // above an overdue action (0.6 + a quarter of 0.5): the quick ones first
    match(item) {
      const d = item.data || {};
      if (!live(d) || !(d.ask === 'ack' || d.ask === 'confirm')) return null;
      if (d.ask === 'ack') return `an ack is all that is asked (${who(d)})`;
      return `a choice: ${(d.choices || []).map((c) => `${c.key}) ${c.label}`).join(' · ')}`;
    },
  },
  // ---- P1: yours, and past its date ---------------------------------------
  {
    name: 'past_its_nudge', tier: 'P1', claim: 0.6,
    match(item, fresh, { now = new Date() } = {}) {
      const d = item.data || {};
      if (!live(d)) return null;
      const days = daysPast(d.nudge, now);
      if (days == null || days <= 0) return null;
      return `waiting on you (${who(d)}) — ${days} d past its nudge`;
    },
  },
  // ---- P2: yours, an action, not yet due ---------------------------------
  {
    name: 'waiting_on_you', tier: 'P2', claim: 0.5,
    match(item) {
      const d = item.data || {};
      if (!live(d) || d.ask !== 'action') return null;
      return d.handoff ? `a handoff in ${d.handoff} (${who(d)})` : `waiting on you (${who(d)})${d.nudge ? ` — nudge ${d.nudge}` : ''}`;
    },
  },
  // ---- P3: not yours ------------------------------------------------------
  {
    name: 'kept_for_history', tier: 'P3', claim: 0.02,
    match: (item) => ((item.data || {}).struck ? 'struck through — kept for history' : null),
  },
  {
    name: 'agents_own', tier: 'P3', claim: 0.05,
    match: (item) => (!isHuman((item.data || {}).owner) ? `an agent's row (${who(item.data || {})}); nothing for you` : null),
  },
  { name: 'ambient', tier: 'P3', claim: 0.05, fallback: true, match: () => 'in the ledger' },
];

export default rules;
