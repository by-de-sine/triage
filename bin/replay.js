#!/usr/bin/env node
// replay — run the rules over one thread's real history, in order, and
// print what each step would have decided. Reads the forge, writes
// nothing: an in-memory store, the same source code path, the same rules.
// This is how "would that reply have been P0?" gets answered without
// waiting for the next one.
//
//   node bin/replay.js owner/repo#123             a GitHub issue or pull request
//   node bin/replay.js group/project!12           a GitLab merge request
//   node bin/replay.js group/project#12 --gitlab  a GitLab issue
//   … [--me login]
import { Store } from '../lib/store.js';
import { loadConfig } from '../lib/config.js';
import { GitHubApi, GitLabApi, githubToken, gitlabToken } from '../lib/forge-api.js';
import { ingest } from '../lib/pipeline.js';
import github from '../sources/github.js';
import gitlab from '../sources/gitlab.js';
import rules from '../rules/thread.js';

const args = process.argv.slice(2);
const arg = args.find((a) => !a.startsWith('--'));
const m = /^([^#!]+)([#!])(\d+)$/.exec(arg || '');
if (!m) { console.error('usage: replay owner/repo#number | group/project!number [--gitlab] [--me login]'); process.exit(2); }
const [, repo, sep, number] = m;
const meIdx = args.indexOf('--me');
if (meIdx >= 0 && (!args[meIdx + 1] || args[meIdx + 1].startsWith('--'))) { console.error('--me needs a login'); process.exit(2); }
const cfg = loadConfig();
const onGitlab = sep === '!' || args.includes('--gitlab');

let batches, source, me;
if (onGitlab) {
  const token = cfg.gitlab.token || await gitlabToken();
  if (!token) { console.error('no GitLab token: set GITLAB_TOKEN or log glab in'); process.exit(1); }
  const api = new GitLabApi({ base: cfg.gitlab.base, token });
  me = meIdx >= 0 ? args[meIdx + 1] : await gitlab.whoami({ api, user: cfg.gitlab.user });
  const kind = sep === '!' ? 'pull' : 'issue';
  const target = (await api.get(`${api.project(repo)}/${kind === 'pull' ? 'merge_requests' : 'issues'}/${number}`)).body;
  // Shape it as a todo so the source reads it the normal way; the "my
  // threads" lists answer empty so only this thread is read.
  const todo = { id: 0, action_name: 'marked', target_type: kind === 'pull' ? 'MergeRequest' : 'Issue', target, project: { path_with_namespace: repo }, created_at: target.created_at, author: target.author };
  const fake = { get: api.get.bind(api), request: api.request.bind(api), list: (url, o) => (url === '/todos' ? Promise.resolve([todo]) : /^\/(merge_requests|issues)$/.test(url) ? Promise.resolve([]) : api.list(url, o)), listPages: api.listPages.bind(api), project: api.project.bind(api), rate: api.rate, webBase: api.webBase };
  ({ batches } = await gitlab.poll({ api: fake, cursor: null, me, log: (x) => console.error(x) }));
  source = 'gitlab';
} else {
  const token = cfg.github.token || await githubToken();
  if (!token) { console.error('no GitHub token: set GITHUB_TOKEN or log gh in'); process.exit(1); }
  const api = new GitHubApi({ base: cfg.github.base, token, tokensDir: cfg.github.tokensDir });
  me = meIdx >= 0 ? args[meIdx + 1] : await github.whoami({ api, user: cfg.github.user });
  // Shape the thread as a notification so the source reads it the normal way.
  const subj = (await api.get(`/repos/${repo}/issues/${number}`)).body;
  const type = subj.pull_request ? 'PullRequest' : 'Issue';
  const n = { id: `replay-${repo}#${number}`, unread: true, reason: 'subscribed', updated_at: subj.updated_at, subject: { title: subj.title, url: `${api.base}/repos/${repo}/${type === 'PullRequest' ? 'pulls' : 'issues'}/${number}`, type }, repository: { full_name: repo, html_url: `${api.webBase}/${repo}` } };
  const fake = { get: (url, o) => (url.startsWith('/notifications') ? Promise.resolve({ status: 200, headers: new Headers(), body: [n] }) : api.get(url, o)), list: api.list.bind(api), listPages: api.listPages.bind(api), rate: api.rate, webBase: api.webBase };
  ({ batches } = await github.poll({ api: fake, cursor: null, me, log: (x) => console.error(x) }));
  source = 'github';
}
const [b] = batches;
if (!b) { console.error('nothing read'); process.exit(1); }
const events = b.events.filter((e) => e.kind !== 'notification').sort((a, c) => a.ts.localeCompare(c.ts));
console.log(`${b.item.key} · ${b.item.title}\nas ${me}, role ${b.item.my_role}, ${events.length} events\n`);

const store = new Store();
let p0 = 0;
for (const e of events) {
  // Each step is scored as of its own moment, not the thread's latest.
  const r = await ingest(store, { user: me, source, batches: [{ item: { ...b.item, last_activity: e.ts }, events: [e] }] }, { rules, me, now: new Date(e.ts) });
  const d = r.decisions[0];
  const line = `${e.ts}  ${e.kind.padEnd(14)} ${String(e.actor || '-').padEnd(22)}`;
  if (!d) { console.log(`${line} (no decision)`); continue; }
  if (d.tier === 'P0') p0++;
  console.log(`${line} ${d.tier}  ${d.rule.padEnd(28)} ${d.reason}`);
  // M5: the rules return every match now, and the set is what the ranking
  // reads (plan §11.3). Printing the corroborating ones is the cheapest
  // check that they are actually being persisted — this reads them back out
  // of `decisions`, not out of the verdict it just made.
  const stored = store.itemByKey(me, source, b.item.key);
  const row = stored ? store.decisionsFor(stored.id).at(-1) : null;
  if (!row) continue;
  for (const x of row.matches.slice(1)) console.log(`${' '.repeat(line.length)} ${x.tier}  ${x.rule.padEnd(28)} ${x.reason}   (also)`);
}
console.log(`\n${p0} step(s) would have been P0.`);
