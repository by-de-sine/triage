// gitlab — the same seam as GitHub's, on GitLab's API. Three reads:
//
//   todos      GET /todos?state=pending — the inbox: a mention, a review or
//              approval request, an assignment, a failed pipeline. A todo
//              names its target (an issue or a merge request) and why.
//   my threads merge requests you authored, review or are assigned to, and
//              issues assigned to or filed by you, updated since the cursor
//              — GitLab's todos do not fire for ordinary comments on your
//              own merge request, and this is where those come from.
//   open set   for the projects `TRIAGE_GITLAB_ISSUES` names, every open
//              issue as state, reconciled exactly as GitHub's are.
//
// For every thread that moved, the discussions are read and turned into
// the events rules/thread.js reads: a note is a `comment` (or a
// `review_comment` when it is on the diff), a reply carries the id of the
// note it answers, and the system notes GitLab writes for approvals,
// review requests, merges and closes become `review`, `review_request` and
// `state`. Done marks the todo done.
//
// Cursor: { since, todos: { [id]: seen }, threads: { [key]: { updated_at, seen, todo } },
//           issues: { read_at, repos, open, complete, error } }.
import { isBot, sameLogin } from '../lib/util.js';
import { threadTime, sameRepos } from '../lib/forge.js';

const REASON = { mentioned: 'mention', directly_addressed: 'mention', assigned: 'assign', review_requested: 'review_requested', approval_required: 'review_requested', build_failed: 'ci_activity', unmergeable: 'ci_activity', marked: 'manual', merge_train_removed: 'ci_activity', review_submitted: 'review', member_access_requested: 'manual' };
const ROLE_BY_REASON = { mention: 'mentioned', assign: 'assigned', review_requested: 'review_requested', review: 'authored' };
const CURSOR_TTL_MS = 30 * 86_400_000;
const FIRST_LOOKBACK_MS = 7 * 86_400_000;
const ISSUE_PAGES = 10;
const lower = (s) => String(s || '').toLowerCase();

const isMr = (t) => t?.merge_status !== undefined || t?.source_branch !== undefined || t?.target_branch !== undefined;
/** `group/project!12` for a merge request, `group/project#12` for an issue. */
export const keyOf = (path, iid, kind) => `${path}${kind === 'pull' ? '!' : '#'}${iid}`;

export default {
  name: 'gitlab',
  every: 60_000,
  describe: 'GET /todos, plus the merge requests and issues that are yours updated since the last poll; per moved thread the discussions since then; open issues of the listed projects as state',
  time: threadTime,
  project: (item) => item.repo || null,

  async whoami({ api, user = null }) { return user || (await api.get('/user')).body.username; },

  /** What Done does on GitLab: the todo that brought the item is marked done. */
  async mark(item, { api }) {
    const id = item.data?.thread_id;
    if (!id) return 'not marked done: no todo on the item';
    try { await api.request('POST', `/todos/${id}/mark_as_done`); return 'todo marked done'; }
    catch (e) { return `not marked done: ${e.message}`; }
  },

  async poll(ctx) {
    const { api, cursor, me, issues = null, now = new Date(), log = () => {} } = ctx;
    const prev = cursor || { since: null, todos: {}, threads: {} };
    const nowIso = now.toISOString();
    const repos = issues?.projects || [];
    const st = repos.length ? await openIssues({ api, prev, repos, everyMs: issues.everyMs ?? 5 * 60_000, me, now, log }) : null;
    const governed = new Set(st ? [...(prev.issues?.open || []), ...(st.cursor.open || [])] : []);

    // 1. The inbox: every pending todo not yet seen.
    const todos = { ...(prev.todos || {}) };
    const moved = new Map();   // key -> { target, kind, path, todo? }
    const pending = await api.list('/todos', { params: { state: 'pending' }, pages: 5 });
    let fresh = 0;
    for (const t of pending) {
      if (!t.target || !t.project?.path_with_namespace) continue;
      const kind = t.target_type === 'MergeRequest' ? 'pull' : t.target_type === 'Issue' ? 'issue' : null;
      if (!kind) continue;
      const key = keyOf(t.project.path_with_namespace, t.target.iid, kind);
      if (!todos[t.id]) { fresh++; todos[t.id] = nowIso; moved.set(key, { target: t.target, kind, path: t.project.path_with_namespace, todo: t, todos: [...(moved.get(key)?.todos || []), t] }); }
      else if (!moved.has(key)) moved.set(key, { target: t.target, kind, path: t.project.path_with_namespace, todo: null, todos: [], quiet: true });
    }
    for (const [id, seen] of Object.entries(todos)) if (now - Date.parse(seen) > CURSOR_TTL_MS) delete todos[id];

    // 2. My threads, updated since the cursor (with a minute of overlap).
    const since = prev.since ? new Date(Date.parse(prev.since) - 60_000).toISOString() : new Date(now.getTime() - FIRST_LOOKBACK_MS).toISOString();
    const mine = [];
    for (const who of ['author_username', 'reviewer_username', 'assignee_username']) mine.push(...(await api.list('/merge_requests', { params: { scope: 'all', state: 'opened', [who]: me, updated_after: since, order_by: 'updated_at', sort: 'asc' }, pages: 3 })).map((t) => ({ target: t, kind: 'pull' })));
    for (const who of ['assignee_username', 'author_username']) mine.push(...(await api.list('/issues', { params: { scope: 'all', state: 'opened', [who]: me, updated_after: since, order_by: 'updated_at', sort: 'asc' }, pages: 3 })).map((t) => ({ target: t, kind: 'issue' })));
    for (const { target, kind } of mine) {
      const path = target.references?.full?.replace(/[!#]\d+$/, '') || pathOf(target);
      if (!path) continue;
      const key = keyOf(path, target.iid, kind);
      const known = prev.threads?.[key];
      if (known && known.updated_at === target.updated_at) continue;
      if (!moved.has(key) || moved.get(key).quiet) moved.set(key, { ...(moved.get(key) || {}), target, kind, path, quiet: false });
    }

    // 3. Each thread that moved: the discussions since it was last seen.
    const threads = { ...(prev.threads || {}) };
    const batches = [];
    for (const [key, m] of moved) {
      if (m.quiet) { if (threads[key]) threads[key] = { ...threads[key], seen: nowIso }; continue; }
      const known = threads[key];
      try {
        const b = await thread(api, m, known, me, governed, nowIso);
        batches.push(b);
        threads[key] = { updated_at: b.item.last_activity, seen: nowIso, todo: b.item.data.thread_id || known?.todo || null };
      } catch (e) { log(`${key}: ${e.message}`); }
    }
    for (const [k, t] of Object.entries(threads)) if (now - Date.parse(t.seen || 0) > CURSOR_TTL_MS) delete threads[k];
    const next = { since: nowIso, todos, threads, ...(st ? { issues: st.cursor } : {}) };
    const status = `${pending.length} pending todos (${fresh} new), ${moved.size} threads considered, ${batches.length} read`;
    return { batches: [...(st?.batches || []), ...batches], cursor: next, status: st ? `${status}; ${st.status}` : status };
  },

  reconcile({ cursor, issues = null }) {
    const repos = issues?.projects || [];
    const st = cursor?.issues;
    if (!repos.length || !st) return null;
    const watched = new Set(repos.map(lower));
    const same = sameRepos(st.repos, repos);
    return { keys: st.open || [], complete: !!st.complete && same, error: same ? st.error || null : 'the project list changed since the last read',
      governs: (item) => item.kind === 'issue' && item.data?.mode === 'open' && watched.has(lower(item.repo)) };
  },

  describeCursor(state) {
    if (!state || typeof state !== 'object') return state;
    const out = { since: state.since || null, todos: Object.keys(state.todos || {}).length, threads: Object.keys(state.threads || {}).length };
    if (state.issues) out.issues = { projects: (state.issues.repos || []).length, open: (state.issues.open || []).length, complete: !!state.issues.complete, read_at: state.issues.read_at || null };
    return out;
  },
};

/** The project path of a target, from its web URL when `references` is absent. */
function pathOf(t) {
  const m = /^https?:\/\/[^/]+\/(.+?)\/-\/(?:merge_requests|issues)\/\d+/.exec(t.web_url || '');
  return m ? m[1] : null;
}

function issueData(t, kind, extra = {}) {
  return {
    type: kind === 'pull' ? 'MergeRequest' : 'Issue', number: t.iid, state: t.state === 'opened' ? 'open' : t.state, author: t.author?.username || null, draft: !!t.draft,
    assignees: (t.assignees || []).map((u) => u.username).filter(Boolean), labels: (t.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    ...extra,
  };
}

/** One moved thread -> {item, events}. */
async function thread(api, { target, kind, path, todo = null, todos = [] }, known, me, governed, nowIso) {
  const key = keyOf(path, target.iid, kind);
  const since = known?.updated_at || null;
  const reason = todo ? REASON[todo.action_name] || 'subscribed' : null;
  const author = target.author?.username || null;
  const events = [];
  const item = { source: 'gitlab', key, kind, title: target.title, url: target.web_url, repo: path, actors: [], my_role: sameLogin(author, me) ? 'authored' : ROLE_BY_REASON[reason] || ((target.assignees || []).some((u) => sameLogin(u.username, me)) ? 'assigned' : 'subscribed'),
    last_activity: target.updated_at, last_seen: nowIso, data: issueData(target, kind, { ...(reason ? { reason } : {}), thread_id: todo?.id || known?.todo || null, ...(kind === 'issue' && governed.has(key) ? { mode: 'open' } : {}) }) };
  if (sameLogin(author, me)) item.my_role = 'authored';
  for (const t of todos) {
    const r = REASON[t.action_name] || 'subscribed';
    events.push({ key: `gitlab:todo:${t.id}`, ts: t.created_at, kind: 'notification', actor: t.author?.username || null, body: t.body || null, url: t.target_url || item.url, data: { reason: r, action: t.action_name } });
    if (r === 'review_requested') events.push({ key: `gitlab:review_request:${key}:${t.id}`, ts: t.created_at, kind: 'review_request', actor: t.author?.username || null, body: null, url: item.url, data: { by_bot: isBot(t.author?.username) } });
  }
  const actors = new Set(author ? [author] : []);
  if (!since) events.push({ key: `gitlab:opened:${key}`, ts: target.created_at, kind: 'opened', actor: author, body: target.description || '', url: target.web_url, data: {} });
  if (target.state === 'merged' && target.merged_at && (!since || target.merged_at > since)) events.push({ key: `gitlab:merged:${key}`, ts: target.merged_at, kind: 'state', actor: target.merged_by?.username || target.merge_user?.username || null, body: 'merged', url: target.web_url, data: { state: 'merged' } });
  else if (target.state === 'closed' && target.closed_at && (!since || target.closed_at > since)) events.push({ key: `gitlab:closed:${key}:${target.closed_at}`, ts: target.closed_at, kind: 'state', actor: target.closed_by?.username || null, body: 'closed', url: target.web_url, data: { state: 'closed' } });
  const base = `${api.project(path)}/${kind === 'pull' ? 'merge_requests' : 'issues'}/${target.iid}`;
  for (const d of await api.list(`${base}/discussions`, { pages: 10 })) {
    const notes = d.notes || [];
    const root = notes[0];
    for (const n of notes) {
      if (since && n.created_at <= since) continue;
      const by = n.author?.username || null;
      if (n.system) {
        const sys = systemNote(n.body || '', me);
        if (!sys) continue;
        actors.add(by);
        events.push({ key: `gitlab:sys:${n.id}`, ts: n.created_at, kind: sys.kind, actor: by, body: null, url: `${target.web_url}#note_${n.id}`, data: sys.data });
        continue;
      }
      actors.add(by);
      const onDiff = n.type === 'DiffNote' || !!n.position;
      events.push({ key: `gitlab:note:${n.id}`, ts: n.created_at, kind: onDiff ? 'review_comment' : 'comment', actor: by, body: n.body || '', url: `${target.web_url}#note_${n.id}`,
        data: { id: n.id, in_reply_to_id: root && n.id !== root.id ? root.id : null, path: n.position?.new_path || null, edited: n.updated_at !== n.created_at } });
    }
  }
  item.actors = [...actors].filter(Boolean);
  item.last_activity = events.reduce((m, e) => (e.ts > m ? e.ts : m), target.updated_at);
  return { item, events };
}

/** GitLab's system notes, the ones that are observations a rule reads. */
export function systemNote(body, me) {
  const b = body.trim();
  if (/^approved this merge request/i.test(b)) return { kind: 'review', data: { state: 'approved' } };
  if (/^unapproved this merge request/i.test(b)) return { kind: 'review', data: { state: 'dismissed' } };
  if (/^requested review from/i.test(b)) return new RegExp(`@${String(me).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(b) ? { kind: 'review_request', data: { by_bot: false } } : null;
  if (/^merged/i.test(b)) return { kind: 'state', data: { state: 'merged' } };
  if (/^closed/i.test(b)) return { kind: 'state', data: { state: 'closed' } };
  if (/^reopened/i.test(b)) return { kind: 'state', data: { state: 'reopened' } };
  return null;
}

/** The state half, as GitHub's: every open issue of every listed project. */
async function openIssues({ api, prev, repos, everyMs, me, now, log }) {
  const was = prev.issues || null;
  const nowIso = now.toISOString();
  const due = !was || !sameRepos(was.repos, repos) || now - Date.parse(was.read_at || 0) >= everyMs;
  if (!due) return { batches: [], cursor: was, status: `open set of ${repos.length} project${repos.length === 1 ? '' : 's'} not due` };
  const seen = new Set(was?.open || []);
  const batches = [], open = [];
  let complete = true, error = null, failed = 0;
  for (const repo of repos) {
    try {
      const { list, whole } = await api.listPages(`${api.project(repo)}/issues`, { pages: ISSUE_PAGES, params: { state: 'opened', order_by: 'updated_at', sort: 'asc' } });
      if (!whole) { complete = false; error = error || `${repo} has more than ${ISSUE_PAGES * 100} open issues; read the first ${list.length}`; log(error); }
      for (const s of list) {
        const path = s.references?.full?.replace(/#\d+$/, '') || pathOf(s) || repo;
        const key = keyOf(path, s.iid, 'issue');
        const author = s.author?.username || null;
        const assignees = (s.assignees || []).map((u) => u.username).filter(Boolean);
        const data = issueData(s, 'issue', { mode: 'open', thread_id: prev.threads?.[key]?.todo || null });
        const item = { source: 'gitlab', key, kind: 'issue', title: s.title, url: s.web_url, repo: path, actors: [...new Set([author, ...assignees].filter(Boolean))],
          my_role: sameLogin(author, me) ? 'authored' : assignees.some((a) => sameLogin(a, me)) ? 'assigned' : null, last_activity: s.updated_at, last_seen: nowIso, data };
        const events = [{ key: `gitlab:open:${key}:${s.updated_at}`, ts: s.updated_at, kind: 'open', actor: null, body: null, url: s.web_url, data: { assignees, labels: data.labels, comments: s.user_notes_count ?? null } }];
        if (!seen.has(key)) events.unshift({ key: `gitlab:opened:${key}`, ts: s.created_at, kind: 'opened', actor: author, body: s.description || '', url: s.web_url, data: {} });
        batches.push({ item, events });
        open.push(key);
      }
    } catch (e) { complete = false; failed++; error = error || `${repo}: ${e.message}`; log(`${repo}: open issues — ${e.message}`); }
  }
  return { batches, cursor: { read_at: nowIso, repos: [...repos], open, complete, error }, status: `${open.length} open issue${open.length === 1 ? '' : 's'} in ${repos.length - failed} of ${repos.length} project${repos.length === 1 ? '' : 's'}${complete ? '' : ' (incomplete)'}` };
}
