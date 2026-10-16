// Calendar rules, plan §5: P0 is "starts in 15 min", P1 is a new invitation,
// P2 is the day-ahead brief, in the list with everything else, and the rest
// is P3. Pure, named, ordered; first match wins, and the last is a catch-all
// like every other source's.
//
// Two things are worth saying about the order. The P0 is driven by a `starts`
// event, which only sources/calendar.js `due()` emits and only for an event
// you are actually going to — so the alarm cannot fire on something you
// declined even before this rule guards it, and it guards it anyway. And the
// P2 carries its own exclusions rather than sitting after the P3s: an
// all-day entry and your own solo block are P3 *because of what they are*,
// not because a later rule caught them, and a reader should be able to see
// that in the rule that says no.
const NOT_GOING = (d) => d.status === 'cancelled' || d.response === 'declined';
const solo = (d) => !!d.mine && (d.guests || 0) === 0;   // `guests` counts everyone but you
const whose = (d) => (d.mine ? null : d.organizer || null);

export const rules = [
  // ---- P0: it is about to start -----------------------------------------
  {
    name: 'starts_in_15_min', tier: 'P0', claim: 1,   // you are about to be late
    match(item, fresh, { now = new Date() } = {}) {
      const hit = fresh.find((e) => e.kind === 'starts');
      if (!hit) return null;
      const d = item.data || {};
      // Note what is *not* excluded: an event of your own with no guests.
      // `day_ahead` skips those because a focus block is not news for a brief
      // of the day's meetings — but the alarm's whole job is that you do not
      // miss what is about to start, and Google cannot tell a focus block
      // from a dentist appointment. Silence is the worse of the two errors.
      if (d.all_day || NOT_GOING(d)) return null;
      const mins = Math.round((Date.parse(hit.data?.start || hit.ts) - now.getTime()) / 60_000);
      const where = d.join ? ' · a video call' : d.location ? ` · ${d.location}` : '';
      return mins <= 0 ? `starts now${where}` : `starts in ${mins} min${where}`;
    },
  },
  // ---- P1: someone is waiting for an answer ------------------------------
  {
    name: 'new_invitation', tier: 'P1', claim: 0.5,   // an answer is owed, on a day's scale not a minute's
    match(item, fresh) {
      const hit = fresh.find((e) => e.kind === 'invite');
      if (!hit) return null;
      return `${whose(item.data || {}) || hit.actor || 'someone'} invited you — you have not answered`;
    },
  },
  // ---- P2: the day-ahead brief ---------------------------------------------
  {
    name: 'day_ahead', tier: 'P2', claim: 0.25,   // the brief; nothing is waiting
    match(item, fresh) {
      const d = item.data || {};
      if (d.all_day || NOT_GOING(d) || solo(d)) return null;
      if (!fresh.some((e) => e.kind === 'update' || e.kind === 'invite')) return null;
      const who = whose(d);
      return who ? `on your calendar — ${who}` : 'on your calendar';
    },
  },
  // ---- P3: on the calendar, nothing to do about it ------------------------
  {
    name: 'declined', tier: 'P3', claim: 0.02,   // you already answered
    match: (item) => ((item.data || {}).response === 'declined' ? 'you declined it' : null),
  },
  {
    name: 'cancelled', tier: 'P3', claim: 0.02,   // it is not happening
    match: (item) => ((item.data || {}).status === 'cancelled' ? 'cancelled' : null),
  },
  {
    name: 'all_day', tier: 'P3', claim: 0.05,   // no minute to be late for
    match: (item) => ((item.data || {}).all_day ? 'an all-day entry, not a meeting' : null),
  },
  {
    name: 'own_event', tier: 'P3', claim: 0.08,   // yours alone
    match: (item) => (solo(item.data || {}) ? 'your own event, no guests' : null),
  },
  {
    name: 'ambient', tier: 'P3', claim: 0.1, fallback: true,   // the catch-all
    match: (item) => `on your calendar, nothing addressed to you${whose(item.data || {}) ? ' — ' + whose(item.data) : ''}`,
  },
];

export default rules;
