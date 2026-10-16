// GitHub rules, plan §3. Pure, named, ordered; every match is returned and
// the strongest is the verdict (M5). Bots are
// never "someone": a review bot answering your comment is not a person
// waiting on you.
import { isBot } from '../lib/util.js';

const COMMENT_KINDS = new Set(['comment', 'review_comment']);
// Logins are case-insensitive on GitHub, and `me` may be typed into the
// .env in either case; an exact compare would make your own issue someone
// else's.
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const human = (me) => (e) => e.actor && !same(e.actor, me) && !isBot(e.actor);
const mine = (me) => (e) => same(e.actor, me);
const talk = (e) => COMMENT_KINDS.has(e.kind) || e.kind === 'review' || e.kind === 'opened';
const mentions = (body, me) => new RegExp(`(^|[^\\w/])@${me}(?![\\w-])`, 'i').test(body || '');
/** How old an `opened` event can be and still be somebody who just opened
 *  it: a day, so a pull request opened overnight is still news at breakfast. */
const NEW_PR_MS = 24 * 3_600_000;
const who = (es) => [...new Set(es.map((e) => e.actor))].join(', ');

export const rules = [
  // ---- P0: someone is waiting on you ------------------------------------
  {
    name: 'reply_to_my_review_comment', tier: 'P0', claim: 1,   // a named human is blocked on your answer, in a thread you opened yourself
    match(item, fresh, { me, history }) {
      const myIds = new Set(history.filter((e) => e.kind === 'review_comment' && e.actor === me).map((e) => e.data.id));
      const hits = fresh.filter((e) => e.kind === 'review_comment' && human(me)(e) && myIds.has(e.data.in_reply_to_id));
      return hits.length ? `${who(hits)} replied to your review comment` : null;
    },
  },
  {
    name: 'reply_to_my_comment', tier: 'P0', claim: 0.95,   // the same, one step less specific
    match(item, fresh, { me, history }) {
      const myLast = history.filter((e) => COMMENT_KINDS.has(e.kind) && e.actor === me).map((e) => e.ts).sort().at(-1);
      if (!myLast) return null;
      const hits = fresh.filter((e) => COMMENT_KINDS.has(e.kind) && human(me)(e) && e.ts > myLast);
      return hits.length ? `${who(hits)} commented after you did` : null;
    },
  },
  {
    name: 'direct_mention', tier: 'P0', claim: 0.9,   // someone typed your name on purpose
    match(item, fresh, { me }) {
      const hits = fresh.filter((e) => talk(e) && human(me)(e) && mentions(e.body, me));
      return hits.length ? `${who(hits)} mentioned you` : null;
    },
  },
  {
    name: 'review_requested', tier: 'P0', claim: 0.8,   // a person is waiting, on a task rather than mid-conversation
    match(item, fresh) {
      const hit = fresh.find((e) => e.kind === 'review_request' && !e.data.by_bot);
      return hit ? `${hit.actor} asked for your review` : null;
    },
  },
  {
    // Decided 2026-10-15: a contributor opening a pull request to a
    // repository you are active in or own is news you want immediately, so
    // you can give them feedback. The inbox only carries
    // repositories you watch, which is the "active in or own" part. The
    // `opened` event is also synthesised when triage first meets an old pull
    // request (sources/github.js), so it has to be recent to be news — a
    // comment on a year-old PR is not somebody who just opened one.
    name: 'new_pull_request', tier: 'P0', claim: 0.75,   // a person just asked for feedback, whether or not they named you
    match(item, fresh, { me, now = new Date() }) {
      if (item.kind !== 'pull' || item.my_role === 'authored') return null;
      const hit = fresh.find((e) => e.kind === 'opened' && human(me)(e) && now.getTime() - Date.parse(e.ts) <= NEW_PR_MS);
      return hit ? `${hit.actor} opened a pull request` : null;
    },
  },
  // ---- P1: yours, moving ------------------------------------------------
  {
    name: 'comment_on_my_thread', tier: 'P1', claim: 0.55,   // yours, and it moved
    match(item, fresh, { me }) {
      if (item.my_role !== 'authored') return null;
      const hits = fresh.filter((e) => COMMENT_KINDS.has(e.kind) && human(me)(e));
      return hits.length ? `${who(hits)} commented on your ${item.kind}` : null;
    },
  },
  {
    name: 'review_on_my_pr', tier: 'P1', claim: 0.6,   // yours, and somebody spent time on it
    match(item, fresh, { me }) {
      if (item.my_role !== 'authored' || item.kind !== 'pull') return null;
      const hit = fresh.filter((e) => e.kind === 'review' && human(me)(e)).at(-1);
      return hit ? `${hit.actor} ${String(hit.data.state || '').toLowerCase().replace('_', ' ')} your PR` : null;
    },
  },
  // ---- P2: worth knowing today ------------------------------------------
  {
    name: 'state_change_on_mine', tier: 'P2', claim: 0.25,   // news about your own work; nothing is waiting
    match(item, fresh) {
      if (item.my_role !== 'authored') return null;
      const hit = fresh.find((e) => e.kind === 'state');
      return hit ? `your ${item.kind} was ${hit.data.state}` : null;
    },
  },
  {
    name: 'assigned', tier: 'P2', claim: 0.45,   // it is now yours, but nobody is mid-sentence
    match(item, fresh) {
      return fresh.some((e) => e.kind === 'notification' && e.data.reason === 'assign') ? 'assigned to you' : null;
    },
  },
  // ---- P2, as state: an open issue that is yours (plan §12.3 item 2) ----
  // These two read the item, not the events: an issue assigned to you, or
  // one you filed, that is *still open* is a fact about now, and it holds
  // whether the poll that brought it was the inbox or the open set of a
  // watched repository. Agents on this box act as you, so an agent-filed
  // issue is `authored` — which is exactly the one `own_activity` made
  // invisible (§12.1). Neither is news: both wait, and both get more
  // pressing the longer they sit (sources/github.js `time`).
  {
    name: 'issue_assigned_to_me', tier: 'P2', claim: 0.5,   // it is yours to do, and it is not done
    match(item, fresh, { me }) {
      if (item.kind !== 'issue' || item.data?.state !== 'open') return null;
      return (item.data.assignees || []).some((a) => a.toLowerCase() === me.toLowerCase()) ? 'assigned to you and still open' : null;
    },
  },
  {
    name: 'my_open_issue', tier: 'P2', claim: 0.35,   // you filed it; nobody has closed it
    match(item, fresh, { me }) {
      if (item.kind !== 'issue' || item.data?.state !== 'open') return null;
      return item.data.author && item.data.author.toLowerCase() === me.toLowerCase() ? 'you filed it and it is still open' : null;
    },
  },
  {
    // Was `new_issue_on_my_repo`, which also required the repository owner
    // to be you — the one condition that excluded every repository you
    // actually file in (plan §12.1). Dropped 2026-09-13 (§12.3 item 2).
    name: 'new_issue', tier: 'P2', claim: 0.3,   // someone else's problem to describe, in a repo you follow
    match(item, fresh, { me }) {
      if (item.kind !== 'issue') return null;
      const hit = fresh.find((e) => e.kind === 'opened' && human(me)(e));
      return hit ? `${hit.actor} opened an issue` : null;
    },
  },
  // ---- P3: ambient ------------------------------------------------------
  {
    name: 'release', tier: 'P3', claim: 0.05,   // worth knowing once, and it fades
    match: (item) => (item.kind === 'release' ? 'a release' : null),
  },
  {
    name: 'own_activity', tier: 'P3', claim: 0.02,   // you did it
    match(item, fresh, { me }) {
      const actors = fresh.filter((e) => e.actor);
      return actors.length && actors.every(mine(me)) ? 'only your own activity' : null;
    },
  },
  {
    name: 'bot_only', tier: 'P3', claim: 0.05,   // a bot is not someone
    match(item, fresh, { me }) {
      const others = fresh.filter((e) => e.actor && e.actor !== me);
      return others.length && others.every((e) => isBot(e.actor)) ? `only bot activity (${who(others)})` : null;
    },
  },
  {
    name: 'ambient', tier: 'P3', claim: 0.1, fallback: true,   // the catch-all: subscribed, nothing addressed to you
    match: (item) => `${item.my_role || 'subscribed'}, nothing addressed to you`,
  },
];

export default rules;
