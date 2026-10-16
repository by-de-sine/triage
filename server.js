#!/usr/bin/env node
// triage — your queue, tiered. GitHub notifications in (sources/), tiered
// items out (rules/), the urgent ones in Slack (deliver/). One process,
// one SQLite file, an HTTP API on 127.0.0.1 that Caddy publishes at
// triage.<zone>. See README.md.
import http from 'node:http';
import { Store } from './lib/store.js';
import { loadConfig } from './lib/config.js';
import { GitHubApi, defaultToken } from './lib/github-api.js';
import { Runner } from './lib/runner.js';
import { createApp } from './lib/api.js';
import { SlackDelivery } from './deliver/slack.js';
import { createActor } from './lib/actions.js';
import { Ranker } from './lib/rank.js';
import { backfill } from './lib/backfill.js';
import { GoogleApi, readCredentials } from './lib/google-api.js';
import github from './sources/github.js';
import githubRules from './rules/github.js';
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

const log = (m) => console.error(`${new Date().toISOString()} triage: ${m}`);
const cfg = loadConfig();

const token = await defaultToken(process.env);
if (!token) { log('no GitHub token: set GITHUB_TOKEN or log gh in'); process.exit(1); }
const api = new GitHubApi({ token, tokensDir: cfg.github.tokensDir });
let user = cfg.github.user;
if (!user) {
  try { user = (await api.get('/user')).body.login; } catch (e) { log(`GET /user failed: ${e.message}`); process.exit(1); }
}
log(`items belong to ${user}; store ${cfg.db}; env ${cfg.envFile}; commit ${cfg.commit || 'unknown'}`);

const store = new Store(cfg.db);

// Issues as state (plan §12.3 item 2): the inbox carries none, so the open
// set of each repository TRIAGE_ISSUES names is read whole and reconciled.
// Which repositories is yours to say, as config (§12.7); unset, the source
// is the inbox alone, and says so.
if (cfg.github.issues.repos.length) log(`github: open issues as state from ${cfg.github.issues.repos.join(', ')}, every ${Math.round(cfg.github.issues.everyMs / 60_000)} min`);
else log('github: issues as state off — TRIAGE_ISSUES names no repository');

// M3: the second source. It registers only when it can actually read a
// calendar — a Google OAuth client and a refresh token are ring-0 work
// (plan §9 item 5), and a box without them should run the rest of triage
// rather than fail a poll a minute. `fake` is the canned calendar from
// test/.
const cal = await calendarSource(cfg.calendar, log);
// The ledger (plan §12.3): local files, so it registers whenever the queue
// file is there. The first state-shaped source, and the first with a
// reconcile — nothing in lib/ knows what a queue row is.
const led = ledgerSource(cfg.ledger, log);
// The household's to-do lists (plan §12.8): the same state shape as the
// ledger, over one long-lived token, and off unless it is configured.
const hass = await haSource(cfg.ha, log);
// The CRM (plan §12.3 item 3): Twenty's tasks as state, and anybody else's
// change as an event; read-only, on its own key, and off unless configured.
const twenty = await crmSource(cfg.crm, log);
const sources = [github, ...(cal ? [calendar] : []), ...(led ? [ledger] : []), ...(hass ? [ha] : []), ...(twenty ? [crm] : [])];

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
if (cfg.slack.mode === 'webhook') log(`slack: interrupts ${cfg.slack.mention ? `mention ${cfg.slack.mention} — so Slack notifies, not just delivers` : 'mention nobody (TRIAGE_MENTION unset or off): a channel message is an unread badge, not a push'}`);

const act = createActor({ store, github: api, marks: {
  calendar: async () => 'nothing marked on Google — triage only reads your calendar',
  ledger: async () => 'nothing changed in the ledger — triage only reads it; the row closes when whoever owns it deletes it',
  // The one write this process makes outside its own store: Done here ticks
  // the item off on the kitchen screen too, or says why it could not. The
  // entry is here even when the source is off, because the default answer —
  // `ha is read-only here` — would be a lie: it is not read-only, it is
  // unconfigured, and an item from an earlier run is still in the store.
  ha: hass ? markDone(hass) : async () => 'nothing ticked off: the Home Assistant source is off (TRIAGE_HA), so there is nothing to write to',
}, deliver, rank, log });
await deliver.start({ act });
const rules = { github: githubRules, calendar: calendarRules, ledger: ledgerRules, ha: haRules, crm: crmRules };
// M5's bootstrap, once, bounded: the backlog predates every feature the
// ranker wants and nothing else will ever compute one for it (plan §11.8).
// Rules re-run from stored history; a feature nobody can know stays absent.
if (cfg.rank.backfill) {
  const b = backfill(store, { user, rules, rank, limit: cfg.rank.backfill, log });
  if (!b.ranked) log(`rank: nothing to backfill (${store.countUnranked(user)} unranked)`);
}
const runner = new Runner(store, sources, {
  user,
  rules,
  deliver, rank,
  extras: { github: { api, all: cfg.github.all, issues: cfg.github.issues }, calendar: { api: cal, calendarId: cfg.calendar.id, windowMs: cfg.calendar.windowMs, soonMs: cfg.calendar.soonMs }, ledger: led || {}, ha: { api: hass, lists: cfg.ha.lists, dashboard: cfg.ha.dashboard },
    // `health` is the one mutable thing in an extras block: the source writes
    // the last read's error into it and its clock half reads it back, so the
    // alarm for a CRM that never answers can say why. `startedAt` is when
    // that clock starts if no read has ever completed.
    crm: { api: twenty, url: twenty?.url || null, self: cfg.crm.self, agents: cfg.crm.agents, projects: cfg.crm.projects, staleMs: cfg.crm.staleMs, health: { startedAt: new Date().toISOString(), error: null } } },
  log,
});
const app = createApp({ store, runner, deliver, act, rank, rules, user, commit: cfg.commit, tz: cfg.slack.tz, log });
const server = http.createServer(app);
server.listen(cfg.port, cfg.host, () => { log(`listening on http://${cfg.host}:${cfg.port}`); runner.start(); });

/** The calendar's client, or null when it should not be registered. Says
 *  out loud which of the three it is, because "the calendar is quiet" and
 *  "the calendar is off" look identical from a list page. */
async function calendarSource(c, log) {
  if (c.mode === 'off') { log('calendar: off (TRIAGE_CALENDAR=off)'); return null; }
  if (c.mode === 'fake') {
    const { demoCalendar } = await import('./test/fake-calendar.js');
    log('calendar: FAKE (TRIAGE_CALENDAR=fake) — the canned calendar from test/; every title says (fake)');
    return demoCalendar();
  }
  const creds = readCredentials(c);
  if (!creds) {
    const how = c.mode === 'google' ? 'TRIAGE_CALENDAR=google, but ' : '';
    log(`calendar: off — ${how}no Google credentials (${c.clientFile} and ${c.tokenFile}); run bin/google-consent.js once, or set TRIAGE_CALENDAR=fake`);
    if (c.mode === 'google') process.exit(1);
    return null;
  }
  log(`calendar: ${c.id}, the next ${Math.round(c.windowMs / 3_600_000)} h, P0 ${Math.round(c.soonMs / 60_000)} min ahead`);
  return new GoogleApi(creds);
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

/** The ledger's files, or null when it should not be registered. */
function ledgerSource(c, log) {
  if (c.mode === 'off') { log('ledger: off (TRIAGE_LEDGER names no queue file)'); return null; }
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
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
