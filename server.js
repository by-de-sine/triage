#!/usr/bin/env node
// triage — your queue, ranked. Sources in (sources/), verdicts out (rules/),
// the few that interrupt to Slack (deliver/), everything in one ordered
// list on a page. One process, one SQLite file, an HTTP API on 127.0.0.1
// that a reverse proxy publishes. See README.md.
import http from 'node:http';
import { Store } from './lib/store.js';
import { loadConfig } from './lib/config.js';
import { GitHubApi, GitLabApi, githubToken, gitlabToken } from './lib/forge-api.js';
import { Runner } from './lib/runner.js';
import { createApp } from './lib/api.js';
import { SlackDelivery } from './deliver/slack.js';
import { createActor } from './lib/actions.js';
import { Ranker } from './lib/rank.js';
import { backfill } from './lib/backfill.js';
import { GoogleApi, readCredentials } from './lib/google-api.js';
import github from './sources/github.js';
import gitlab from './sources/gitlab.js';
import threadRules from './rules/thread.js';
import calendar from './sources/calendar.js';
import calendarRules from './rules/calendar.js';
import ledger from './sources/ledger.js';
import ledgerRules from './rules/ledger.js';
import ha, { markDone } from './sources/ha.js';
import haRules from './rules/ha.js';
import { HaApi } from './lib/ha-api.js';
import crm from './sources/crm.js';
import crmRules from './rules/crm.js';
import { TwentyApi } from './lib/twenty-api.js';
import { existsSync } from 'node:fs';
import { sameLogin } from './lib/util.js';

const log = (m) => console.error(`${new Date().toISOString()} triage: ${m}`);
const cfg = loadConfig();
// Plan §16, G3: one flag, every fake the tree has, nothing off the box.
if (cfg.demo) log(`DEMO (TRIAGE_DEMO=1): every source on its canned fake from test/, store ${cfg.db === ':memory:' ? 'in memory' : cfg.db}, ${cfg.envFile ? `env ${cfg.envFile}` : 'no .env read'}; delivery ${cfg.slack.mode === 'webhook' && cfg.slack.notify !== 'off' ? `to the loopback webhook (${cfg.slack.notify})` : 'off — nothing leaves the box; point TRIAGE_WEBHOOK_URL at a listener on 127.0.0.1 to read the payload'}`);
const store = new Store(cfg.db);

// The forges (plan §16, G1). Each registers when its token resolves — or
// `TRIAGE_<FORGE>=on` insists and fails loudly without one; `off` never
// registers it — and says at boot who you are there, resolved once through
// the source's own `whoami`. One thread-shaped rule set serves both,
// because a reply on GitLab is the same observation as a reply on GitHub.
// `fake` is the canned forge from test/, which answers who you are (alice)
// and says which repositories its open set covers.
const sources = [], extras = {}, rules = {}, identity = {};
async function forge(name, source, c, Api, tokenOf, apiOpts = {}, demoApi) {
  const NAME = name.toUpperCase();
  if (c.mode === 'off') { log(`${name}: off (TRIAGE_${NAME}=off)`); return null; }
  if (c.mode === 'fake') {
    const api = await demoApi();
    return register(name, source, { ...c, user: null, issues: { ...c.issues, ...api.demo } }, api, ` — FAKE (TRIAGE_${NAME}=fake), the canned ${name === 'github' ? 'GitHub' : 'GitLab'} from test/`);
  }
  const token = c.token || await tokenOf(process.env);
  if (!token) {
    log(`${name}: off — no ${NAME}_TOKEN${c.mode === 'on' ? ` (TRIAGE_${NAME}=on)` : ''}${name === 'github' ? ' and nothing from `gh auth token`' : name === 'gitlab' ? ' and nothing from `glab auth token`' : ''}`);
    if (c.mode === 'on') process.exit(1);
    return null;
  }
  return register(name, source, c, new Api({ base: c.base, token, ...apiOpts }));
}
async function register(name, source, c, api, note = '') {
  const NAME = name.toUpperCase();
  let me;
  try { me = await source.whoami({ api, user: c.user }); }
  catch (e) {
    // A forge that is merely available — not insisted on — must not stop
    // the box: a stale `glab` token for the wrong instance, or an outage
    // at boot, is that forge off until the next restart, said out loud.
    log(`${name}: off — cannot resolve who you are at ${api.base} (${e.message}); set ${NAME}_USER${c.mode === 'on' ? '' : `, or TRIAGE_${NAME}=off`}`);
    if (c.mode === 'on') process.exit(1);
    return null;
  }
  const watched = c.issues.repos || c.issues.projects || [];
  sources.push(source);
  extras[name] = { api, all: c.all, issues: c.issues };
  identity[name] = me;
  rules[name] = threadRules;
  // Issues as state (plan §12.3 item 2): the inbox carries none, so the open
  // set of each listed repository is read whole and reconciled. Which ones
  // is yours to say, as config (§12.7); unset, the source is the inbox alone.
  log(`${name}: ${api.base} as ${me}${note}${watched.length ? `; open issues as state from ${watched.join(', ')} every ${Math.round(c.issues.everyMs / 60_000)} min` : '; issues as state off — no repository named'}`);
  return api;
}
await forge('github', github, cfg.github, GitHubApi, githubToken, { tokensDir: cfg.github.tokensDir }, async () => (await import('./test/fake-github.js')).demoGithub());
await forge('gitlab', gitlab, cfg.gitlab, GitLabApi, gitlabToken, {}, async () => (await import('./test/fake-gitlab.js')).demoGitlab());
// The one person the items belong to: `items.user`, which scopes every
// read. Whoever the store already files items under, so that adding a
// forge later never re-keys a queue; on an empty store, the GitHub login
// when GitHub is on, else the GitLab username. The demo's is the fixtures'
// own, always: with both forges off there is no login to take, and a store
// TRIAGE_DB names must not have the canned day filed under its owner.
const user = cfg.demo ? 'alice' : store.firstUser() ?? identity.github ?? identity.gitlab ?? null;
if (user && Object.values(identity).length && !Object.values(identity).some((me) => sameLogin(me, user))) log(`items belong to ${user} (the store's), which is none of this boot's identities (${Object.entries(identity).map(([k, v]) => `${k}: ${v}`).join(', ')}) — set TRIAGE_DB to start a queue of your own`);

// M3: the second source, read from an ICS feed (plan §16, G4) or from
// Google. It registers only when it can actually read a calendar — a box
// without a feed or credentials should run the rest of triage rather than
// fail a poll a minute. `fake` is the canned feed from test/.
const cal = await calendarSource(cfg.calendar, log);
// Your addresses on invitations: `me` to the feed's reader, through the
// identity map like every source's.
if (cal?.feed) identity.calendar = cfg.calendar.me.join(', ') || undefined;
// The ledger (plan §12.3): local files, so it registers whenever the queue
// file is there. The first state-shaped source, and the first with a
// reconcile — nothing in lib/ knows what a queue row is.
const led = await ledgerSource(cfg.ledger, log);
// The household's to-do lists (plan §12.8): the same state shape as the
// ledger, over one long-lived token, and off unless it is configured.
const hass = await haSource(cfg.ha, log);
// The CRM (plan §12.3 item 3): Twenty's tasks as state, and anybody else's
// change as an event; read-only, on its own key, and off unless configured.
const twenty = await crmSource(cfg.crm, log);
if (cal) { sources.push(calendar); rules.calendar = calendarRules; }
if (led) { sources.push(ledger); rules.ledger = ledgerRules; }
if (hass) { sources.push(ha); rules.ha = haRules; }
if (twenty) { sources.push(crm); rules.crm = crmRules; }
if (!sources.length) { log('no source is configured: set GITHUB_TOKEN (or log gh in), GITLAB_TOKEN, or one of the other sources'); process.exit(1); }
if (!user) { log(`items belong to nobody: no forge is on, so there is no login to file them under — set GITHUB_TOKEN or GITLAB_TOKEN`); process.exit(1); }
log(`items belong to ${user}; store ${cfg.db}; env ${cfg.envFile || 'none read'}; commit ${cfg.commit || 'unknown'}`);

// The one action path: the Slack buttons, POST /api/items/:id/act and the
// page all call this. What Done does *outside* triage is per source: the
// GitHub thread is marked read; the calendar is read-only and says so.
// M5: the ranker. `shapes` is built from the sources themselves — each one
// declares how time changes what its items are worth — so nothing in lib/
// has to know what a thread or a meeting is (plan §11.4 item 2).
const rank = new Ranker({ ...cfg.rank, shapes: Object.fromEntries(sources.filter((s) => s.time).map((s) => [s.name, s.time])) });
// Delivery is built after the ranker because it needs it: `/triage` and the
// Home tab draw the same list the page does, and a list built without the
// ranker shows the stored order rather than the one time has since moved.
// Plan §14.3: what a project is, per source — the same map-built-at-boot
// the ranker's `shapes` is, so nothing in deliver/ knows a repository from
// a calendar and a source that declares none is not a special case.
const deliver = new SlackDelivery(store, { ...cfg.slack, user, rank, log, projects: Object.fromEntries(sources.filter((s) => s.project).map((s) => [s.name, s.project])) });
log(`rank: claim ${cfg.rank.weights.claim} · time ${cfg.rank.weights.time} (${Object.keys(rank.shapes).join(', ') || 'none'}) · prefer ${cfg.rank.weights.prefer}${cfg.rank.prefer.length ? ` (${cfg.rank.prefer.length} stated)` : ' — nothing stated (TRIAGE_RANK_PREFER)'}`);
log(`slack: interrupts on ${Object.entries(deliver.interruptMap).map(([k, v]) => `${k}: ${v.join(', ') || 'nothing'}`).join(' · ') || 'nothing (TRIAGE_INTERRUPT=off)'}${cfg.prefsFile ? ` · ${cfg.slack.interrupts.statements.length} statements over ${Object.keys(cfg.prefs.projects).length} projects (${cfg.prefsFile})` : ''}`);
// Plan §14.1: a webhook's channel message notifies nobody unless it names
// somebody, and the first real P0 this system sent proved it the hard way.
if (cfg.slack.mode === 'webhook' && cfg.slack.notify !== 'off') log(`notify: interrupts ${cfg.slack.mention ? `mention ${cfg.slack.mention} — so the channel notifies, not just delivers` : 'mention nobody (TRIAGE_MENTION unset or off): a channel message is an unread badge, not a push'}`);

// What Done does outside triage, per source: a map keyed by source name,
// never a branch in act(). A source that declares `mark` supplies its own
// entry (the forges: the thread read, the todo done); the rest are the
// sentences for what a read-only source does about it.
const marks = {
  calendar: async () => (cal?.feed ? 'nothing marked on your calendar — triage only reads the feed' : 'nothing marked on Google — triage only reads your calendar'),
  ledger: async () => 'nothing changed in the ledger — triage only reads it; the row closes when whoever owns it deletes it',
  // The one write this process makes outside its own store. The entry is
  // here even when the source is off, because the default answer —
  // `ha is read-only here` — would be a lie: it is not read-only, it is
  // unconfigured, and an item from an earlier run is still in the store.
  ha: hass ? markDone(hass) : async () => 'nothing ticked off: the Home Assistant source is off (TRIAGE_HA), so there is nothing to write to',
  ...Object.fromEntries(sources.filter((s) => s.mark).map((s) => [s.name, (item) => s.mark(item, { ...(extras[s.name] || {}), me: identity[s.name] ?? user })])),
};
const act = createActor({ store, marks, deliver, rank, log });
await deliver.start({ act });
// M5's bootstrap, once, bounded: the backlog predates every feature the
// ranker wants and nothing else will ever compute one for it (plan §11.8).
// Rules re-run from stored history; a feature nobody can know stays absent.
if (cfg.rank.backfill) {
  const b = backfill(store, { user, identity, rules, rank, limit: cfg.rank.backfill, log });
  if (!b.ranked) log(`rank: nothing to backfill (${store.countUnranked(user)} unranked)`);
}
const runner = new Runner(store, sources, {
  user, identity,
  rules,
  deliver, rank,
  extras: { ...extras, calendar: cal?.feed
    ? { feed: cal.feed, calendarId: cfg.calendar.id, tz: cfg.slack.tz, fetchMs: cfg.calendar.fetchMs, windowMs: cfg.calendar.windowMs, soonMs: cfg.calendar.soonMs }
    : { api: cal?.api ?? null, calendarId: cfg.calendar.id || 'primary', windowMs: cfg.calendar.windowMs, soonMs: cfg.calendar.soonMs }, ledger: led || {}, ha: { api: hass, lists: cfg.ha.lists, dashboard: cfg.ha.dashboard },
    // `health` is the one mutable thing in an extras block: the source writes
    // the last read's error into it and its clock half reads it back, so the
    // alarm for a CRM that never answers can say why. `startedAt` is when
    // that clock starts if no read has ever completed.
    crm: { api: twenty, url: twenty?.url || null, self: cfg.crm.self, agents: cfg.crm.agents, projects: cfg.crm.projects, staleMs: cfg.crm.staleMs, health: { startedAt: new Date().toISOString(), error: null } } },
  log,
});
const app = createApp({ store, runner, deliver, act, rank, rules, user, identity, commit: cfg.commit, tz: cfg.slack.tz, log });
const server = http.createServer(app);
// The port as bound, not as asked: `TRIAGE_PORT=0` takes any free one.
server.listen(cfg.port, cfg.host, () => { log(`listening on http://${cfg.host}:${server.address().port}`); runner.start(); });

/** How the calendar is read — `{ feed }` or `{ api }` — or null when it
 *  should not be registered. Says out loud which it is, because "the
 *  calendar is quiet" and "the calendar is off" look identical from a list
 *  page. Unset is the feed when one is named, Google when its credentials
 *  resolve, off otherwise (plan §16.7 item b: both paths, until the feed
 *  has had its week). */
async function calendarSource(c, log) {
  const ahead = `the next ${Math.round(c.windowMs / 3_600_000)} h, P0 ${Math.round(c.soonMs / 60_000)} min ahead`;
  if (c.mode === 'off') { log('calendar: off (TRIAGE_CALENDAR=off)'); return null; }
  if (c.mode === 'fake') {
    const { demoIcs } = await import('./test/fake-calendar.js');
    // The canned day's you, unless TRIAGE_CALENDAR_ME says otherwise.
    if (!c.me.length) c.me.push('alice@example.com');
    log(`calendar: FAKE (TRIAGE_CALENDAR=fake) — the canned feed from test/, ${ahead}, as ${c.me.join(', ')}; every title says (fake)`);
    return { feed: { text: demoIcs(), name: 'fake' } };
  }
  if (c.mode === 'ics' || (!c.mode && c.feed)) {
    if (!c.feed) { log('calendar: off — TRIAGE_CALENDAR=ics, but neither TRIAGE_CALENDAR_URL nor TRIAGE_CALENDAR_FILE names a feed'); process.exit(1); }
    // The host, never the path: the path of a published feed is its secret.
    log(`calendar: the feed ${c.feed.file || `at ${c.feed.host}`}${c.feed.url ? `, fetched at most every ${Math.round(c.fetchMs / 60_000)} min` : ''}, ${ahead}${c.me.length ? `, as ${c.me.join(', ')}` : ' — TRIAGE_CALENDAR_ME unset, so no invitation can be yours to answer'}`);
    return { feed: c.feed };
  }
  const creds = readCredentials(c);
  if (!creds) {
    const how = c.mode === 'google' ? 'TRIAGE_CALENDAR=google, but ' : '';
    log(`calendar: off — ${how}no feed (TRIAGE_CALENDAR_URL or TRIAGE_CALENDAR_FILE) and no Google credentials (${c.clientFile} and ${c.tokenFile}); or set TRIAGE_CALENDAR=fake`);
    if (c.mode === 'google') process.exit(1);
    return null;
  }
  log(`calendar: Google, ${c.id || 'primary'}, ${ahead}`);
  return { api: new GoogleApi(creds) };
}

/** The Home Assistant client, or null when the source should not be
 *  registered. Says which of the three it is out loud, for the same reason
 *  the calendar does: "the chores are quiet" and "the chores are off" look
 *  identical from a list page. */
async function haSource(c, log) {
  if (c.mode === 'off') { log('ha: off (TRIAGE_HA=off)'); return null; }
  if (c.mode === 'fake') {
    const { demoHa } = await import('./test/fake-ha.js');
    log('ha: FAKE (TRIAGE_HA=fake) — the canned lists from test/; every item says (fake)');
    // The canned house's own lists, unless HA_LISTS names some of them: with
    // none named the source would read nothing and say so every poll.
    if (!c.lists.length) c.lists.push('todo.alice_inbox', 'todo.household');
    return demoHa();
  }
  if (!c.url || !c.token) {
    const how = c.mode === 'on' ? 'TRIAGE_HA=on, but ' : '';
    log(`ha: off — ${how}HA_URL and HA_TOKEN are not both set; or set TRIAGE_HA=fake`);
    if (c.mode === 'on') process.exit(1);
    return null;
  }
  if (!c.lists.length) {
    log('ha: off — HA_LISTS names no list');
    if (c.mode === 'on') process.exit(1);
    return null;
  }
  const api = new HaApi({ url: c.url, token: c.token });
  log(`ha: ${c.lists.join(', ')} at ${api.host}`);
  return api;
}

/** The Twenty client, or null when the source should not be registered.
 *  Says which of the three it is out loud, like the others — and refuses to
 *  guess who you are, because a source that cannot recognise you reads
 *  every one of your own edits as somebody else's. */
async function crmSource(c, log) {
  if (c.mode === 'off') { log('crm: off (TRIAGE_CRM=off)'); return null; }
  if (c.mode === 'fake') {
    const { demoTwenty } = await import('./test/fake-twenty.js');
    log('crm: FAKE (TRIAGE_CRM=fake) — the canned CRM from test/; every title says (fake), and on the second read a colleague hands you a task');
    // The canned workspace's own identities, so the demo's own edits do not
    // interrupt: the member the fake knows as you, and the key your agents
    // write under. Real mode has no such defaults (lib/config.js).
    if (!c.self.length) c.self.push('alice@example.test');
    if (!c.agents.length) c.agents.push('Agent key');
    if (!Object.keys(c.projects).length) c.projects['Acme Corp'] = 'acme';
    return demoTwenty();
  }
  const missing = [!c.url && 'TWENTY_URL', !c.key && 'TWENTY_API_KEY', !c.self.length && 'TRIAGE_CRM_ME'].filter(Boolean);
  if (missing.length) {
    const how = c.mode === 'on' ? 'TRIAGE_CRM=on, but ' : '';
    log(`crm: off — ${how}${missing.join(', ')} not set; or set TRIAGE_CRM=fake`);
    if (c.mode === 'on') process.exit(1);
    return null;
  }
  const api = new TwentyApi({ url: c.url, key: c.key });
  log(`crm: ${api.host}, you are ${c.self.join(', ')}; your agents are ${c.agents.join(', ') || 'none'}; unread for ${Math.round(c.staleMs / 60_000)} min is a P0${Object.keys(c.projects).length ? `; projects ${Object.entries(c.projects).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`);
  return api;
}

/** The ledger's files, or null when it should not be registered. `fake`
 *  writes a canned queue file and its handoffs to a temp dir, removed at
 *  shutdown. */
async function ledgerSource(c, log) {
  if (c.mode === 'off') { log('ledger: off (TRIAGE_LEDGER names no queue file)'); return null; }
  if (c.mode === 'fake') {
    const { demoLedger } = await import('./test/fake-ledger.js');
    const f = demoLedger();
    log(`ledger: FAKE (TRIAGE_DEMO=1) — a canned queue file at ${f.file}, removed at shutdown; every row says (fake)`);
    return f;
  }
  if (!existsSync(c.file)) { log(`ledger: ${c.file} is not there (TRIAGE_LEDGER names it)`); process.exit(1); }
  log(`ledger: ${c.file}, handoffs in ${c.statusDir}`);
  return { file: c.file, statusDir: c.statusDir };
}

let stopping = false;
const shutdown = async (sig) => {
  if (stopping) return;
  stopping = true;
  log(`${sig}: stopping`);
  runner.stop();
  await new Promise((r) => server.close(r));   // in-flight requests finish first
  await Promise.allSettled([...runner.inflight.values()]);   // a poll in progress lands its verdicts
  await deliver.stop().catch(() => {});
  store.close();
  led?.cleanup?.();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
