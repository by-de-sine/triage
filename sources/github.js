// github — the notifications inbox, plus the comment diff the inbox cannot
// give you. Polls /notifications honouring Last-Modified (304 is free) and
// X-Poll-Interval (the API says how often). For each thread that moved
// since the cursor last saw it: the subject (issue or PR), and for those,
// the comments, review comments and reviews since the item was last seen.
// Emits normalised events; never writes tiers. Owns its cursor.
//
// **And a second mode, since plan §12.3 item 2: open issues as state.** The
// inbox is a feed of activity on threads you are subscribed to, and it
// carries almost no issues — GitHub does not notify you about your own,
// and an issue filed and never commented on is not activity (§12.1). So
// for the repositories `TRIAGE_ISSUES` names, the source also reads the
// whole *open set* every few minutes, upserts each issue as an item with
// `data.mode = 'open'`, and hands the runner that set to `reconcile`
// against (§12.2): an issue closed on GitHub leaves the set and is
// resolved here, attributed to the source; one reopened comes back. The
// set governs only the items its own mode ingested — a pull request from
// the inbox is not "gone" for being absent from a set it was never in —
// and the ingestion mode is recorded on the item for that reason.
//
// **And a third half, since plan §17.2: the sweep.** The inbox is a feed of
// what *others* did. It never says that you merged your own pull request,
// and it stops speaking about a thread the moment the thread stops moving —
// so an item the inbox opened stays open here long after GitHub closed it.
// In the first two months that was nine of every ten open threads, and
// nine of the ten ranked highest. So a few of the source's own unfinished
// threads are asked about on every poll, oldest answer first: one call
// each, to the pull request or the issue itself. A thread found closed gets the `state` event the inbox would have
// brought (the same key, so the two never double it), and the rules re-tier
// it like any other event; one that has been closed a day with nothing
// since that needs you leaves the set `reconcile` reports, and is resolved
// there — attributed to the source, like an issue closed in the open set.
//
// Cursor: { last_modified, threads: { [thread id]: { updated_at, seen, key } },
//           issues: { read_at, repos, open: [key], complete, error },
//           sweep: { [key]: { at, closed_at } | { at, error } } }.
// A thread whose updated_at has not moved costs nothing; one that has costs
// one subject call and, for issues and PRs, up to three list calls. The
// open set costs one list call per repository per page, once per cadence.
// The sweep costs at most SWEEP_PER_POLL calls a poll, and once it has
// been round, one call per still-open thread per SWEEP_EVERY_MS.
import { isBot, nextLink, sameLogin } from '../lib/util.js';
import { threadTime, sameRepos } from '../lib/forge.js';

const KINDS = { PullRequest: 'pull', Issue: 'issue', Commit: 'commit', Release: 'release', Discussion: 'discussion', CheckSuite: 'checks', RepositoryInvitation: 'invitation', SecurityAlert: 'alert' };
const ROLE_BY_REASON = { author: 'authored', mention: 'mentioned', team_mention: 'mentioned', review_requested: 'review_requested', assign: 'assigned', comment: 'commented', state_change: 'subscribed', subscribed: 'subscribed', manual: 'subscribed', ci_activity: 'subscribed', invitation: 'subscribed', security_alert: 'subscribed' };
const CURSOR_TTL_MS = 30 * 86_400_000;
const MAX_PAGES = 20; // 1,000 threads; a safety cap, not a design limit
const ISSUE_PAGES = 10; // 1,000 open issues per repository; the same kind of cap
/** The sweep's budget and cadence. Ten a poll is a first pass over a few
 *  hundred stale threads within the hour and well under a tenth of the
 *  token's hourly rate; six hours between looks at a thread that is still
 *  open is slow on purpose — a close that matters arrives through the inbox,
 *  and this is the net under it. A thread that could not be read is left
 *  for a day. */
export const SWEEP_PER_POLL = 10;
export const SWEEP_EVERY_MS = 6 * 3_600_000;
export const SWEEP_RETRY_MS = 24 * 3_600_000;
/** How long a closed thread stays in the list: a day, which is what "worth
 *  knowing today" (P2) means for the news that it closed. */
export const SETTLE_AFTER_MS = 24 * 3_600_000;
/** How far behind a close the thread's own bookkeeping may trail and still
 *  be the close: the notification that says "merged" is stamped a moment
 *  after the merge, and a reviewer who approves and merges does both inside
 *  a minute. Activity later than this after a close is somebody speaking on
 *  a closed thread; activity inside it is the close. */
export const CLOSE_SLACK_MS = 5 * 60_000;
const lower = (s) => String(s || '').toLowerCase();

export function itemKey(n) {
  const num = /\/(\d+)$/.exec(n.subject?.url || '');
  if (num && (n.subject.type === 'PullRequest' || n.subject.type === 'Issue')) return `${n.repository.full_name}#${num[1]}`;
  return `${n.repository.full_name}@${String(n.subject.type).toLowerCase()}:${(n.subject.url || n.id).split('/').pop()}`;
}

function htmlUrl(n, webBase = 'https://github.com') {
  const base = n.repository?.html_url || `${webBase}/${n.repository?.full_name}`;
  const tail = (n.subject?.url || '').split('/').slice(-2).join('/'); // "pulls/12" or "commits/sha"
  if (!tail) return base;
  return `${base}/${tail.replace(/^pulls\//, 'pull/').replace(/^commits\//, 'commit/')}`;
}

export default {
  name: 'github',
  every: 60_000,
  describe: 'GET /notifications (unread) with If-Modified-Since; per moved thread the subject, then comments, review comments and reviews since last seen',

  /** M5: how time changes what one of these is worth (plan §11.4 item 2).
   *  The source declares the shape and lib/rank.js applies it, the way the
   *  source already declares its own cursor and its own clock.
   *
   *  **Which curve depends on what the thread is, and the rules are what
   *  know that** — so the match set comes in with the item. A reply waiting
   *  on you gets *more* urgent as it sits, because the wait is the cost. A
   *  pull request of yours that merged two months ago is **news**, and news
   *  goes stale: nobody is waiting, and the only thing ageing does to it is
   *  make it less worth reading. Running the whole backlog through the
   *  first curve put 34 "your pull was merged" rows at the top of the list
   *  and nothing else anywhere near it, which is a bad list even when every
   *  row in it is scored correctly (plan §11.4 item 6). */
  time: threadTime,

  /** Plan §14.3: what a "project" is here, for the scoped layers of what
   *  interrupts you and of what a project is worth. A repository, which is
   *  the unit you already think in and the one `TRIAGE_ISSUES` and
   *  `TRIAGE_RANK_PREFER` already name. Delivery asks the source rather
   *  than reading `item.repo` itself, because a source whose projects are
   *  not repositories must not have to pretend they are. */
  project: (item) => item.repo || null,

  /** Who the items belong to on GitHub: `GITHUB_USER`, else `GET /user`,
   *  resolved once — at boot (server.js), or by the runner before a poll
   *  when GitHub was not answering then — and handed to every rule as `me`. */
  async whoami({ api, user = null }) { return user || (await api.get('/user')).body.login; },

  /** What Done does on GitHub: the thread is marked read, so the two
   *  inboxes agree. A mark that fails — no thread id, a token without the
   *  scope, GitHub down — is a sentence on the action row, never a thrown
   *  error: the local state changes either way (lib/actions.js). */
  async mark(item, { api }) {
    const id = item.data?.thread_id;
    if (!id) return 'not marked read: no thread id on the item';
    if (!api) return 'not marked read: no GitHub client';
    try { await api.request('PATCH', `/notifications/threads/${id}`); return 'marked read'; }
    catch (e) {
      const why = e.status === 403 || e.status === 404 ? `${e.message} — the token needs the notifications scope (a classic token's repo scope carries it)` : e.message;
      return `not marked read: ${why}`;
    }
  },

  /** Two halves, the state half first so the feed half knows which issues
   *  the open set governs.
   *  @returns {Promise<{batches: Array<{item, events}>, cursor, every, status}>} */
  async poll(ctx) {
    const { cursor, issues = null, now = new Date(), log = () => {} } = ctx;
    const prev = cursor || { last_modified: null, threads: {} };
    const repos = issues?.repos || [];
    const st = repos.length ? await openIssues({ ...ctx, prev, repos, everyMs: issues.everyMs ?? 5 * 60_000, now, log }) : null;
    // What the set governs, for the feed half: the set just read *and* the
    // one before it. An issue that left the set on this very read may have
    // its closing notification in this very inbox, and if the inbox wrote
    // it without the mode, reconcile — which runs after — would not speak
    // for it, and it would sit open with a closed state on it.
    const governed = new Set(st ? [...(prev.issues?.open || []), ...(st.cursor.open || [])] : []);
    const fd = await inbox({ ...ctx, prev, governed, now, log });
    // The third half: what the inbox opened and never heard the end of.
    // After the inbox, so a thread it has just re-read is asked about with
    // what it brought. Its own try — the sweep is a net, and a hole in a
    // net must not cost the poll that carries the interrupts.
    let sw = null;
    try { sw = await sweep({ ...ctx, prev, moved: new Set(fd.batches.map((b) => b.item.key)), now, log }); }
    catch (e) { log(`sweep: ${e.message}`); }
    // The issues half of the cursor survives a 304 on the inbox, and is
    // dropped when the mode is off — a set nobody reads must not be
    // reconciled against later. The sweep's survives a failed pass.
    const sweepCursor = sw ? sw.cursor : prev.sweep;
    const next = { ...fd.cursor, ...(st ? { issues: st.cursor } : {}), ...(sweepCursor ? { sweep: sweepCursor } : {}) };
    return { batches: [...(st?.batches || []), ...fd.batches, ...(sw?.batches || [])], cursor: next, every: fd.every, status: [fd.status, st?.status, sw?.status].filter(Boolean).join('; ') };
  },

  /** The current open set, for the runner to resolve against (plan §12.2),
   *  and which items it speaks for. From the cursor, not the network: the
   *  set is exactly what the last read ingested. `null` when the mode is
   *  off or nothing has been read yet — there is nothing to say. */
  reconcile({ cursor, issues = null, now = new Date() }) {
    const repos = issues?.repos || [];
    const st = cursor?.issues;
    const sw = cursor?.sweep || null;
    const state = repos.length && st ? { complete: !!st.complete && sameRepos(st.repos, repos), same: sameRepos(st.repos, repos) } : null;
    const swept = sw && Object.keys(sw).length ? sw : null;
    if (!state && !swept) return null;
    const watched = new Set(repos.map(lower));
    const inOpenSet = (item) => item.kind === 'issue' && item.data?.mode === 'open' && watched.has(lower(item.repo));
    const error = state && !state.complete ? (state.same ? st.error || null : 'the repository list changed since the last read') : null;
    // The open set alone, as it always was — and whenever it could not be
    // read whole, sweep or no sweep: an incomplete read resolves nothing
    // and says why, and what the sweep found waits for the next whole one.
    if (!swept || (state && !state.complete)) return { keys: st.open || [], complete: state.complete, error, governs: inOpenSet };
    // With the sweep, two authorities share one answer, each over its own
    // items. The open set speaks for the issues its mode ingested; the
    // sweep speaks for a thread it has asked about and found finished —
    // closed for a day, with nothing since the close that needs you. A
    // thread still open, one inside the day, and one somebody has spoken
    // on after it closed are not governed at all, which is how reconcile
    // is told "leave it".
    const t = now.getTime();
    const settled = (item) => {
      const e = swept[item.key];
      if (!e?.closed_at || inOpenSet(item)) return false;
      if (t - Date.parse(e.closed_at) < SETTLE_AFTER_MS) return false;
      // Parsed, because the two ends do not spell an instant alike; and with
      // slack, because the notification of a close trails the close.
      const since = Date.parse(item.last_activity) - Date.parse(e.closed_at) > CLOSE_SLACK_MS;
      return !(since && (item.tier === 'P0' || item.tier === 'P1'));
    };
    return {
      keys: state ? st.open || [] : [],
      complete: true,
      error: null,
      governs: (item) => (state ? inOpenSet(item) : false) || settled(item),
      reason: (item) => (settled(item) ? `${item.data?.state === 'merged' ? 'merged' : 'closed'} on GitHub, and nothing since that needs you` : null),
    };
  },

  /** What /api/sources shows: the conditional stamp and how many threads are
   *  remembered, not the whole per-thread map; and the open set's size. */
  describeCursor(state) {
    if (!state || typeof state !== 'object') return state;
    const out = { last_modified: state.last_modified || null, threads: Object.keys(state.threads || {}).length };
    if (state.issues) out.issues = { repos: (state.issues.repos || []).length, open: (state.issues.open || []).length, complete: !!state.issues.complete, read_at: state.issues.read_at || null };
    if (state.sweep) {
      const es = Object.values(state.sweep);
      out.sweep = { asked: es.length, closed: es.filter((e) => e.closed_at).length, unreadable: es.filter((e) => e.error).length };
    }
    return out;
  },
};


/** The feed half: the inbox, as it always was. `governed` is the open set
 *  the state half just read, so an issue the inbox brings that is in it
 *  is written in the state mode's shape and stays under its authority. */
async function inbox({ api, prev, me, now, log, all = false, governed = new Set() }) {
  const threads = { ...(prev.threads || {}) };
  const nowIso = now.toISOString();
  // per_page is capped at 50 on this endpoint; follow rel="next" so an
  // inbox past that is read whole. Only the first page is conditional.
  const res = await api.get(`/notifications?all=${all}&participating=false&per_page=50`, { ifModifiedSince: prev.last_modified || undefined });
  const every = Math.max(30, parseInt(res.headers.get('x-poll-interval') || '60', 10)) * 1000;
  if (res.status === 304) return { batches: [], cursor: { last_modified: prev.last_modified, threads: prev.threads || {} }, every, status: 'not modified' };
  const list = Array.isArray(res.body) ? [...res.body] : [];
  let next = nextLink(res.headers.get('link'));
  for (let i = 0; next && i < MAX_PAGES; i++) {
    const page = await api.get(next);
    if (Array.isArray(page.body)) list.push(...page.body);
    next = nextLink(page.headers.get('link'));
  }
  // A scan cut short by the cap must not advance Last-Modified, or the
  // threads it never reached would be skipped by the next 304.
  const complete = !next;
  if (!complete) log(`inbox exceeds ${MAX_PAGES * 50} threads; read the first ${list.length}, Last-Modified not advanced`);
  const batches = [];
  let fetched = 0, skipped = 0;
  for (const n of list) {
    const known = threads[n.id];
    if (known && known.updated_at === n.updated_at) { skipped++; threads[n.id] = { ...known, seen: nowIso }; continue; }
    if (api.rate.remaining != null && api.rate.remaining < 50) { log(`rate limit low (${api.rate.remaining}); leaving ${n.repository.full_name} for the next poll`); continue; }
    try {
      const b = await thread(api, n, known, me, governed);
      batches.push(b);
      threads[n.id] = { updated_at: n.updated_at, seen: nowIso, key: b.item.key };
      fetched++;
    } catch (e) {
      log(`${n.repository.full_name} ${n.subject.type} ${n.subject.title}: ${e.message}`);
    }
  }
  for (const [id, t] of Object.entries(threads)) if (now - Date.parse(t.seen || 0) > CURSOR_TTL_MS) delete threads[id];
  const lm = res.headers.get('last-modified');
  return { batches, cursor: { last_modified: complete ? (lm || prev.last_modified) : prev.last_modified, threads }, every, status: `${list.length} unread, ${fetched} read, ${skipped} unchanged` };
}

/** The third half: ask the far end about the source's own unfinished
 *  threads, a few a poll, the one asked longest ago first. `unfinished` is
 *  the runner's — the items of this source that are open, snoozed or later.
 *
 *  What it asks about: issues and pull requests the inbox wrote. An issue
 *  the open set governs already has an authority, and anything else (a
 *  release, a commit) has no open or closed to ask after.
 *
 *  What it does with the answer: remembers it in the cursor, and for a
 *  thread found closed, hands back the item with its state corrected and —
 *  when the close is the last thing that happened on it — the `state`
 *  event the inbox would have carried, keyed exactly as the inbox keys it,
 *  so whichever half saw the close first, it is one event.
 *  The rules then say what the close means (your pull merged; nothing
 *  addressed to you), which is what takes a stale "someone is waiting" off
 *  the top of the list at once. Resolving is `reconcile`'s, a day later.
 *
 *  A thread it cannot read — gone, moved, or behind a token this box does
 *  not hold — is remembered as unreadable and left alone: not knowing is
 *  not the same as closed. */
async function sweep({ api, prev, unfinished = null, moved = new Set(), now, log }) {
  if (typeof unfinished !== 'function') return null;
  const items = unfinished().filter((i) => (i.kind === 'pull' || i.kind === 'issue') && i.data?.mode !== 'open' && /^[^#@]+\/[^#@]+#\d+$/.test(i.key));
  const was = prev.sweep || {};
  const t = now.getTime(), nowIso = now.toISOString();
  // Only what is still unfinished is remembered: an item the sweep settled,
  // or you finished, leaves the cursor with it. If new activity reopens it,
  // it is asked about afresh.
  const next = {};
  for (const i of items) if (was[i.key]) next[i.key] = was[i.key];
  const dueAt = (i) => { const e = next[i.key]; return !e ? 0 : Date.parse(e.at) + (e.error ? SWEEP_RETRY_MS : SWEEP_EVERY_MS); };
  // A thread found closed is never asked about again: closed is the end of
  // what the sweep is for, and a reopening arrives through the inbox.
  const due = items.filter((i) => !next[i.key]?.closed_at && !moved.has(i.key) && dueAt(i) <= t).sort((a, b) => dueAt(a) - dueAt(b) || (Date.parse(a.last_activity) || 0) - (Date.parse(b.last_activity) || 0));
  const batches = [];
  let asked = 0, closed = 0;
  for (const i of due.slice(0, SWEEP_PER_POLL)) {
    if (api.rate.remaining != null && api.rate.remaining < 50) { log(`sweep: rate limit low (${api.rate.remaining}); ${due.length - asked} threads left for a later poll`); break; }
    const [repo, num] = i.key.split('#');
    // A pull request is asked about as a pull request, not through the
    // issues endpoint that also answers for it: a fine-grained token is
    // granted the two separately, so this needs only what the inbox already
    // needed to read the thread — and the pull request says who merged it.
    const pull = i.kind === 'pull';
    let s;
    try { s = (await api.get(`/repos/${repo}/${pull ? 'pulls' : 'issues'}/${num}`)).body; }
    catch (e) {
      // A refusal is an answer about this thread; anything else is about
      // the far end, and the next poll asks again.
      if (!e.status) throw e;
      next[i.key] = { at: nowIso, error: e.status };
      asked++;
      continue;
    }
    asked++;
    const merged_at = pull ? s.merged_at || null : null;
    const closed_at = s.state === 'closed' ? merged_at || s.closed_at || nowIso : null;
    next[i.key] = { at: nowIso, closed_at };
    if (!closed_at) continue;
    closed++;
    const state = merged_at ? 'merged' : 'closed';
    const actor = (merged_at ? s.merged_by?.login : s.closed_by?.login) || null;
    // The event is handed back only when the close is the last thing that
    // happened (give or take the moment its own notification trails it by). The rules judge what is fresh, and a close found late is
    // fresh whenever it happened: one from before a reply would be read as
    // the newest word on the thread and take "ann replied to you" down to
    // "your pull was closed". When something has happened since, the item's
    // verdict is already about that, and only its state is corrected.
    const last = Date.parse(i.last_activity);
    const latest = !Number.isFinite(last) || last - Date.parse(closed_at) <= CLOSE_SLACK_MS;
    batches.push({
      item: { key: i.key, kind: i.kind, title: s.title || i.title, url: i.url, repo: i.repo, actors: i.actors, my_role: i.my_role, last_activity: i.last_activity, last_seen: nowIso, data: { ...i.data, state } },
      events: !latest ? [] : [merged_at
        ? { key: `github:merged:${i.key}`, ts: merged_at, kind: 'state', actor, body: 'merged', url: s.html_url || i.url, data: { state: 'merged' } }
        : { key: `github:closed:${i.key}:${closed_at}`, ts: closed_at, kind: 'state', actor, body: 'closed', url: s.html_url || i.url, data: { state: 'closed' } }],
    });
  }
  const left = due.length - Math.min(due.length, SWEEP_PER_POLL);
  return { batches, cursor: next, status: asked || left ? `sweep: asked about ${asked}, ${closed} closed${left ? `, ${left} still to ask` : ''}` : null };
}

/** The state half: the open issues of every watched repository, whole, once
 *  per cadence. Between reads the cursor's set stands. A repository that
 *  cannot be read whole — a failed call, or more pages than the cap — makes
 *  the set incomplete, and an incomplete set resolves nothing (§12.2); what
 *  *was* read is still ingested. Returns `{ batches, cursor, status }`. */
async function openIssues({ api, prev, repos, everyMs, me, now, log }) {
  const was = prev.issues || null;
  const nowIso = now.toISOString();
  const due = !was || !sameRepos(was.repos, repos) || now - Date.parse(was.read_at || 0) >= everyMs;
  if (!due) return { batches: [], cursor: was, status: `open set of ${repos.length} repo${repos.length === 1 ? '' : 's'} not due` };
  // The inbox remembers the thread behind a key; the state half writes it
  // onto the item so Done can still mark the thread read (lib/actions.js).
  const byKey = new Map();
  for (const [id, t] of Object.entries(prev.threads || {})) if (t.key) byKey.set(t.key, id);
  const seen = new Set(was?.open || []);
  const batches = [], open = [];
  let complete = true, error = null, failed = 0;
  for (const repo of repos) {
    if (api.rate.remaining != null && api.rate.remaining < 50) { complete = false; error = error || `rate limit low (${api.rate.remaining}); ${repo} not read`; log(error); continue; }
    try {
      const { list, whole } = await api.listPages(`/repos/${repo}/issues`, { pages: ISSUE_PAGES, params: { state: 'open', sort: 'updated', direction: 'asc' } });
      if (!whole) { complete = false; error = error || `${repo} has more than ${ISSUE_PAGES * 100} open issues; read the first ${list.length}`; log(error); }
      for (const s of list) {
        if (s.pull_request) continue;   // the issues endpoint lists pull requests too
        const b = openIssue(repo, s, me, { thread_id: null, first: false, nowIso });
        b.item.data = { ...b.item.data, ...(byKey.get(b.item.key) ? { thread_id: byKey.get(b.item.key) } : {}) };
        if (!seen.has(b.item.key)) b.events.unshift({ key: `github:opened:${b.item.key}`, ts: s.created_at, kind: 'opened', actor: b.item.data.author, body: s.body || '', url: s.html_url, data: {} });
        batches.push(b);
        open.push(b.item.key);
      }
    } catch (e) {
      complete = false; failed++; error = error || `${repo}: ${e.message}`;
      log(`${repo}: open issues — ${e.message}`);
    }
  }
  return {
    batches,
    cursor: { read_at: nowIso, repos: [...repos], open, complete, error },
    status: `${open.length} open issue${open.length === 1 ? '' : 's'} in ${repos.length - failed} of ${repos.length} repo${repos.length === 1 ? '' : 's'}${complete ? '' : ' (incomplete)'}`,
  };
}

/** One open issue, as the state mode writes it: the item carries what the
 *  state rules read (`assignees`, `author`, `state`) and the mode; the
 *  events are `opened` on first sight (the same key the inbox would use, so
 *  the two never double it) and one `open` per `updated_at` — a change on
 *  GitHub re-tiers it, an unchanged issue emits nothing new. */
function openIssue(configured, s, me, { thread_id, first, nowIso }) {
  // The repository as GitHub spells it, not as the .env did: `items` is
  // unique on the key exactly, and the inbox keys on `repository.full_name`,
  // so `acme/widgets#4` and `Acme/widgets#4` would be two rows.
  const repo = /\/repos\/([^/]+\/[^/]+)$/.exec(s.repository_url || '')?.[1] || configured;
  const key = `${repo}#${s.number}`;
  const author = s.user?.login || null;
  const assignees = (s.assignees || []).map((u) => u.login).filter(Boolean);
  const data = issueData(s, { mode: 'open', ...(thread_id ? { thread_id } : {}) });
  const item = { source: 'github', key, kind: 'issue', title: s.title, url: s.html_url, repo, actors: [...new Set([author, ...assignees].filter(Boolean))],
    my_role: sameLogin(author, me) ? 'authored' : assignees.some((a) => sameLogin(a, me)) ? 'assigned' : null, last_activity: s.updated_at, last_seen: nowIso, data };
  const events = [];
  if (first) events.push({ key: `github:opened:${key}`, ts: s.created_at, kind: 'opened', actor: author, body: s.body || '', url: s.html_url, data: {} });
  events.push({ key: `github:open:${key}:${s.updated_at}`, ts: s.updated_at, kind: 'open', actor: null, body: null, url: s.html_url, data: { assignees, labels: data.labels, comments: s.comments ?? null } });
  return { item, events };
}

/** The fields both halves write for an issue or pull request, from the same
 *  API shape, so whichever half wrote last the item still says what the
 *  rules need. `upsertItem` replaces `data` whole; that is why. */
function issueData(s, extra = {}) {
  return {
    type: s.pull_request ? 'PullRequest' : 'Issue', number: s.number, state: s.merged ? 'merged' : s.state, author: s.user?.login || null, draft: !!s.draft,
    assignees: (s.assignees || []).map((u) => u.login).filter(Boolean), labels: (s.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    ...extra,
  };
}

/** One thread -> {item, events}. `known` is the cursor's memory of it;
 *  `governed` is the open set the state half speaks for. */
async function thread(api, n, known, me, governed = new Set()) {
  const kind = KINDS[n.subject.type] || String(n.subject.type).toLowerCase();
  const key = itemKey(n);
  const since = known?.updated_at || null;
  const events = [];
  const item = { source: 'github', key, kind, title: n.subject.title, url: htmlUrl(n, api.webBase), repo: n.repository.full_name, actors: [], my_role: ROLE_BY_REASON[n.reason] || 'subscribed', last_activity: n.updated_at, last_seen: n.updated_at, data: { reason: n.reason, thread_id: n.id, type: n.subject.type } };
  // The notification itself is an event: it is what the inbox knows, and it
  // is the one thing guaranteed fresh on every thread that moved.
  events.push({ key: `github:notif:${n.id}:${n.updated_at}`, ts: n.updated_at, kind: 'notification', actor: null, body: null, url: item.url, data: { reason: n.reason } });

  if (kind !== 'pull' && kind !== 'issue') return { item, events };
  const s = (await api.get(n.subject.url)).body;
  const num = s.number;
  const author = s.user?.login || null;
  item.title = s.title || item.title;
  item.url = s.html_url || item.url;
  // The same fields the state half writes, plus what only the inbox knows;
  // and the mode, when the open set governs this issue, so an inbox write
  // does not take it out from under reconcile.
  item.data = issueData(s, { reason: n.reason, thread_id: n.id, ...(kind === 'issue' && governed.has(key) ? { mode: 'open' } : {}) });
  if (sameLogin(author, me)) item.my_role = 'authored';
  const actors = new Set(author ? [author] : []);
  if (!since) events.push({ key: `github:opened:${item.repo}#${num}`, ts: s.created_at, kind: 'opened', actor: author, body: s.body || '', url: s.html_url, data: {} });
  if (s.merged_at && (!since || s.merged_at > since)) events.push({ key: `github:merged:${item.repo}#${num}`, ts: s.merged_at, kind: 'state', actor: s.merged_by?.login || null, body: 'merged', url: s.html_url, data: { state: 'merged' } });
  else if (s.closed_at && s.state === 'closed' && (!since || s.closed_at > since)) events.push({ key: `github:closed:${item.repo}#${num}:${s.closed_at}`, ts: s.closed_at, kind: 'state', actor: null, body: 'closed', url: s.html_url, data: { state: 'closed' } });
  if (n.reason === 'review_requested' && (s.requested_reviewers || []).some((u) => sameLogin(u.login, me))) {
    events.push({ key: `github:review_request:${item.repo}#${num}:${n.updated_at}`, ts: n.updated_at, kind: 'review_request', actor: author, body: null, url: s.html_url, data: { by_bot: isBot(author) } });
  }
  const repoPath = `/repos/${item.repo}`;
  const comments = await api.list(`${repoPath}/issues/${num}/comments`, { params: { since } });
  for (const c of comments) {
    actors.add(c.user?.login);
    events.push({ key: `github:comment:${c.id}`, ts: c.created_at, kind: 'comment', actor: c.user?.login || null, body: c.body || '', url: c.html_url, data: { id: c.id, edited: c.updated_at !== c.created_at } });
  }
  if (kind === 'pull') {
    const rcs = await api.list(`${repoPath}/pulls/${num}/comments`, { params: { since } });
    for (const c of rcs) {
      actors.add(c.user?.login);
      events.push({ key: `github:review_comment:${c.id}`, ts: c.created_at, kind: 'review_comment', actor: c.user?.login || null, body: c.body || '', url: c.html_url, data: { id: c.id, in_reply_to_id: c.in_reply_to_id || null, path: c.path || null } });
    }
    const reviews = await api.list(`${repoPath}/pulls/${num}/reviews`);
    for (const r of reviews) {
      if (!r.submitted_at || (since && r.submitted_at <= since)) continue;
      if (r.state === 'COMMENTED' && !(r.body || '').trim()) continue; // the shell around inline comments
      actors.add(r.user?.login);
      events.push({ key: `github:review:${r.id}`, ts: r.submitted_at, kind: 'review', actor: r.user?.login || null, body: r.body || '', url: r.html_url, data: { id: r.id, state: r.state } });
    }
  }
  item.actors = [...actors].filter(Boolean);
  const latest = events.reduce((m, e) => (e.ts > m ? e.ts : m), n.updated_at);
  item.last_activity = latest;
  return { item, events };
}
