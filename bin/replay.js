#!/usr/bin/env node
// replay — run the rules over one thread's real history, in order, and
// print what each step would have decided. Reads GitHub, writes nothing:
// an in-memory store, the same source code path, the same rules. This is
// how "would that reply have been P0?" gets answered without waiting for
// the next one.
//
//   node bin/replay.js owner/repo#123 [--me login]
import { Store } from '../lib/store.js';
import { GitHubApi, defaultToken } from '../lib/github-api.js';
import { ingest } from '../lib/pipeline.js';
import github from '../sources/github.js';
import rules from '../rules/github.js';

const arg = process.argv[2];
const m = /^([^/]+\/[^#]+)#(\d+)$/.exec(arg || '');
if (!m) { console.error('usage: replay owner/repo#number [--me login]'); process.exit(2); }
const [, repo, number] = m;
const meIdx = process.argv.indexOf('--me');
if (meIdx > 0 && (!process.argv[meIdx + 1] || process.argv[meIdx + 1].startsWith('--'))) { console.error('--me needs a login'); process.exit(2); }
const token = await defaultToken();
if (!token) { console.error('no GitHub token: set GITHUB_TOKEN or log gh in'); process.exit(1); }
const api = new GitHubApi({ token });
const me = meIdx > 0 ? process.argv[meIdx + 1] : (await api.get('/user')).body.login;

// Shape the thread as a notification so the source reads it the normal way.
const subj = (await api.get(`/repos/${repo}/issues/${number}`)).body;
const type = subj.pull_request ? 'PullRequest' : 'Issue';
const n = { id: `replay-${repo}#${number}`, unread: true, reason: 'subscribed', updated_at: subj.updated_at, subject: { title: subj.title, url: `https://api.github.com/repos/${repo}/${type === 'PullRequest' ? 'pulls' : 'issues'}/${number}`, type }, repository: { full_name: repo, html_url: `https://github.com/${repo}` } };
const fakeInbox = { get: (url, o) => (url.startsWith('/notifications') ? Promise.resolve({ status: 200, headers: new Headers(), body: [n] }) : api.get(url, o)), list: (u, o) => api.list(u, o), rate: api.rate };
const { batches } = await github.poll({ api: fakeInbox, cursor: null, me, log: (x) => console.error(x) });
const [b] = batches;
if (!b) { console.error('nothing read'); process.exit(1); }
const events = b.events.filter((e) => e.kind !== 'notification').sort((a, c) => a.ts.localeCompare(c.ts));
console.log(`${b.item.key} · ${b.item.title}\nas ${me}, role ${b.item.my_role}, ${events.length} events\n`);

const store = new Store();
let p0 = 0;
for (const e of events) {
  // Each step is scored as of its own moment, not the thread's latest.
  const r = await ingest(store, { user: me, source: 'github', batches: [{ item: { ...b.item, last_activity: e.ts }, events: [e] }] }, { rules, now: new Date(e.ts) });
  const d = r.decisions[0];
  const line = `${e.ts}  ${e.kind.padEnd(14)} ${String(e.actor || '-').padEnd(22)}`;
  if (!d) { console.log(`${line} (no decision)`); continue; }
  if (d.tier === 'P0') p0++;
  console.log(`${line} ${d.tier}  ${d.rule.padEnd(28)} ${d.reason}`);
  // M5: the rules return every match now, and the set is what the ranking
  // reads (plan §11.3). Printing the corroborating ones is the cheapest
  // check that they are actually being persisted — this reads them back out
  // of `decisions`, not out of the verdict it just made.
  const stored = store.itemByKey(me, 'github', b.item.key);
  const row = stored ? store.decisionsFor(stored.id).at(-1) : null;
  if (!row) continue;
  for (const m of row.matches.slice(1)) console.log(`${' '.repeat(line.length)} ${m.tier}  ${m.rule.padEnd(28)} ${m.reason}   (also)`);
}
console.log(`\n${p0} step(s) would have been P0.`);
