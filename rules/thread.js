// Rules for a code-review thread — an issue, a pull request or a merge
// request — shared by every forge source, because a reply on GitLab is the
// same observation as a reply on GitHub. Pure, named, ordered; every match
// is returned and the strongest is the verdict. Bots are never "someone".
//
// The events a forge source emits, and what these rules read from them:
//   notification   {reason}                    what the inbox said
//   opened         actor, body                 the thread was created
//   comment        actor, body, {id}           a comment on the thread
//   review_comment actor, body, {id, in_reply_to_id}   a comment on the diff
//   review         actor, body, {state}        approved · changes_requested · commented · dismissed
//   review_request actor, {by_bot}             your review was asked for
//   state          {state}                     merged · closed · reopened
//   open           {assignees, labels}         the state half's heartbeat: still open, as of now
import { isBot, sameLogin } from '../lib/util.js';

const COMMENT_KINDS = new Set(['comment', 'review_comment']);
const human = (me) => (e) => e.actor && !sameLogin(e.actor, me) && !isBot(e.actor);
const talk = (e) => COMMENT_KINDS.has(e.kind) || e.kind === 'review' || e.kind === 'opened';
const escapeRe = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (body, me) => !!me && new RegExp(`(^|[^\\w/])@${escapeRe(me)}(?![\\w-])`, 'i').test(body || '');
const who = (es) => [...new Set(es.map((e) => e.actor))].join(', ');
/** How old an `opened` event can be and still be somebody who just opened
 *  it: a day, so a pull request opened overnight is still news at breakfast. */
const NEW_PR_MS = 24 * 3_600_000;

export const rules = [
  // ---- P0: someone is waiting on you ------------------------------------
  {
    name: 'reply_to_my_review_comment', tier: 'P0', claim: 1,
    match(item, fresh, { me, history }) {
      const myIds = new Set(history.filter((e) => e.kind === 'review_comment' && sameLogin(e.actor, me)).map((e) => e.data.id));
      const hits = fresh.filter((e) => e.kind === 'review_comment' && human(me)(e) && myIds.has(e.data.in_reply_to_id));
      return hits.length ? `${who(hits)} replied to your review comment` : null;
    },
  },
  {
    name: 'reply_to_my_comment', tier: 'P0', claim: 0.95,
    match(item, fresh, { me, history }) {
      const myLast = history.filter((e) => COMMENT_KINDS.has(e.kind) && sameLogin(e.actor, me)).map((e) => e.ts).sort().at(-1);
      if (!myLast) return null;
      const hits = fresh.filter((e) => COMMENT_KINDS.has(e.kind) && human(me)(e) && e.ts > myLast);
      return hits.length ? `${who(hits)} commented after you did` : null;
    },
  },
  {
    name: 'direct_mention', tier: 'P0', claim: 0.9,
    match(item, fresh, { me }) {
      const hits = fresh.filter((e) => talk(e) && human(me)(e) && mentions(e.body, me));
      return hits.length ? `${who(hits)} mentioned you` : null;
    },
  },
  {
    name: 'review_requested', tier: 'P0', claim: 0.8,   // a person is waiting, on a task rather than mid-conversation
    match(item, fresh) {
      const hit = fresh.find((e) => e.kind === 'review_request' && !e.data.by_bot);
      return hit ? `${hit.actor || 'someone'} asked for your review` : null;
    },
  },
  {
    // Decided 2026-10-15: a contributor opening a pull request to a
    // repository you are active in or own is news you want immediately, so
    // you can give them feedback. The inbox only carries repositories you
    // watch, which is the "active in or own" part. The `opened` event is
    // also synthesised when triage first meets an old thread (the forge
    // sources), so it has to be recent to be news — a comment on a
    // year-old PR is not somebody who just opened one.
    name: 'new_pull_request', tier: 'P0', claim: 0.75,   // a person just asked for feedback, whether or not they named you
    match(item, fresh, { me, now = new Date() }) {
      if (item.kind !== 'pull' || item.my_role === 'authored') return null;
      const hit = fresh.find((e) => e.kind === 'opened' && human(me)(e) && now.getTime() - Date.parse(e.ts) <= NEW_PR_MS);
      return hit ? `${hit.actor} opened a ${item.data?.type === 'MergeRequest' ? 'merge' : 'pull'} request` : null;
    },
  },
  // ---- P1: yours, moving ------------------------------------------------
  {
    name: 'comment_on_my_thread', tier: 'P1', claim: 0.55,
    match(item, fresh, { me }) {
      if (item.my_role !== 'authored') return null;
      const hits = fresh.filter((e) => COMMENT_KINDS.has(e.kind) && human(me)(e));
      return hits.length ? `${who(hits)} commented on your ${item.kind}` : null;
    },
  },
  {
    name: 'review_on_my_pr', tier: 'P1', claim: 0.6,
    match(item, fresh, { me }) {
      if (item.my_role !== 'authored' || item.kind !== 'pull') return null;
      const hit = fresh.filter((e) => e.kind === 'review' && human(me)(e)).at(-1);
      return hit ? `${hit.actor} ${String(hit.data.state || '').toLowerCase().replace('_', ' ')} your ${item.kind === 'pull' ? 'PR' : item.kind}` : null;
    },
  },
  // ---- P2: worth knowing today ------------------------------------------
  {
    name: 'state_change_on_mine', tier: 'P2', claim: 0.25,
    match(item, fresh) {
      if (item.my_role !== 'authored') return null;
      const hit = fresh.find((e) => e.kind === 'state');
      return hit ? `your ${item.kind} was ${hit.data.state}` : null;
    },
  },
  {
    name: 'assigned', tier: 'P2', claim: 0.45,
    match(item, fresh) { return fresh.some((e) => e.kind === 'notification' && e.data.reason === 'assign') ? 'assigned to you' : null; },
  },
  // Two rules that read the item rather than the events: an open issue that
  // is yours is a fact about now, whichever poll brought it.
  {
    name: 'issue_assigned_to_me', tier: 'P2', claim: 0.5,
    match(item, fresh, { me }) {
      if (item.kind !== 'issue' || item.data?.state !== 'open') return null;
      return (item.data.assignees || []).some((a) => sameLogin(a, me)) ? 'assigned to you and still open' : null;
    },
  },
  {
    name: 'my_open_issue', tier: 'P2', claim: 0.35,
    match(item, fresh, { me }) {
      if (item.kind !== 'issue' || item.data?.state !== 'open') return null;
      return item.data.author && sameLogin(item.data.author, me) ? 'you filed it and it is still open' : null;
    },
  },
  {
    name: 'new_issue', tier: 'P2', claim: 0.3,
    match(item, fresh, { me }) {
      if (item.kind !== 'issue') return null;
      const hit = fresh.find((e) => e.kind === 'opened' && human(me)(e));
      return hit ? `${hit.actor} opened an issue` : null;
    },
  },
  // ---- P3: ambient ------------------------------------------------------
  { name: 'release', tier: 'P3', claim: 0.05, match: (item) => (item.kind === 'release' ? 'a release' : null) },
  {
    name: 'own_activity', tier: 'P3', claim: 0.02,
    match(item, fresh, { me }) {
      const actors = fresh.filter((e) => e.actor);
      return actors.length && actors.every((e) => sameLogin(e.actor, me)) ? 'only your own activity' : null;
    },
  },
  {
    name: 'bot_only', tier: 'P3', claim: 0.05,
    match(item, fresh, { me }) {
      const others = fresh.filter((e) => e.actor && !sameLogin(e.actor, me));
      return others.length && others.every((e) => isBot(e.actor)) ? `only bot activity (${who(others)})` : null;
    },
  },
  { name: 'ambient', tier: 'P3', claim: 0.1, fallback: true, match: (item) => `${item.my_role || 'subscribed'}, nothing addressed to you` },
];

export default rules;
