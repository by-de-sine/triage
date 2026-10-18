// config.js — everything the process is told, in one place. Secrets come
// from the .env file TRIAGE_ENV names (~/.config/triage/.env by default) or
// the environment; nothing here is read from the repo.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, readEnvFile } from './util.js';
import { resolve as resolveInterrupts } from '../deliver/interrupts.js';
import { MODES as NOTIFY_MODES, inferMode as inferNotify, parseMention as parseNotifyMention, isLoopback } from '../deliver/notify.js';
import { parsePreferences, DEFAULT_WEIGHTS, DEFAULT_CORROBORATE, DEFAULT_HYSTERESIS } from './rank.js';
import { parseRepos } from './forge.js';
export { parseRepos };

export const CALENDAR_MODES = ['off', 'google', 'ics', 'fake'];
export const SLACK_MODES = ['off', 'webhook', 'app'];
export const HA_MODES = ['off', 'on', 'fake'];
export const CRM_MODES = ['off', 'on', 'fake'];
export const FORGE_MODES = ['off', 'on', 'fake'];

/** A forge — GitHub or GitLab — registers when a token resolves for it.
 *  `on` insists and fails loudly without one; `off` never registers it;
 *  `fake` is the canned forge from test/, as the other sources' `fake` is;
 *  unset is "on if a token resolves", and a value that is none of these is
 *  refused at boot for the reason every other mode here is. */
function forgeMode(name, v) {
  const m = (v || '').toLowerCase();
  if (!m) return null;
  if (!FORGE_MODES.includes(m)) throw new Error(`${name} must be ${FORGE_MODES.join(', ')} (got ${v})`);
  return m;
}

/** A typo must not read as the default. `TRIAGE_CALENDAR=googel` would
 *  otherwise fall through to "on if the credentials happen to be there",
 *  which is the one answer nobody typing it meant. */
function calendarMode(v) {
  const m = (v || '').toLowerCase();
  if (!m) return null;
  if (!CALENDAR_MODES.includes(m)) throw new Error(`TRIAGE_CALENDAR must be ${CALENDAR_MODES.join(', ')} (got ${v})`);
  return m;
}

/** The calendar's feed (plan §16, G4): `TRIAGE_CALENDAR_URL` or
 *  `TRIAGE_CALENDAR_FILE`, never both. The URL is the credential — Google's
 *  "secret address in iCal format" is a password in a path — so it must be
 *  https off loopback, and only its host is ever logged. `webcal://`, which
 *  Apple and Outlook hand out, is https by another name. */
export function calendarFeed(e) {
  const url = String(e.TRIAGE_CALENDAR_URL || '').trim(), file = String(e.TRIAGE_CALENDAR_FILE || '').trim();
  if (url && file) throw new Error('TRIAGE_CALENDAR_URL and TRIAGE_CALENDAR_FILE are both set — name one feed');
  if (file) return { file, name: path.basename(file).replace(/\.ics$/i, '') };
  if (!url) return null;
  let u;
  try { u = new URL(url.replace(/^webcals?:\/\//i, 'https://')); } catch { throw new Error('TRIAGE_CALENDAR_URL is not a URL (only its host is ever logged)'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.href))) throw new Error(`TRIAGE_CALENDAR_URL must be https for ${u.hostname} — the URL is the credential`);
  return { url: u.href, host: u.host, name: u.host };
}

/** Your addresses on invitations (TRIAGE_CALENDAR_ME), comma-separated.
 *  An entry that is not an address is refused: it would match nobody, and
 *  every invitation would read as somebody else's, silently. */
export function parseCalendarMe(v) {
  const out = [];
  for (const part of String(v ?? '').split(/[,\s]+/)) {
    const a = part.trim().replace(/^mailto:/i, '').toLowerCase();
    if (!a) continue;
    if (!/^[^@\s]+@[^@\s]+$/.test(a)) throw new Error(`TRIAGE_CALENDAR_ME: "${part}" is not an email address`);
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** How the interrupt goes out (plan §11.6). Unset infers from what is
 *  actually configured — a webhook URL means `webhook`, a bot token means
 *  `app`, neither means `off` — which is the shape `TRIAGE_CALENDAR` uses,
 *  and it refuses a mode it does not recognise for the same reason: a typo
 *  must not read as the default. `TRIAGE_SLACK=appp` silently falling back
 *  to "whatever is in the .env" is the one answer nobody typing it meant.
 *
 *  The inference order is deliberate. Both may be set — the app path is not
 *  deleted, and someone comparing the two will have both lines present —
 *  and the webhook is what M0's promise now runs through, so it wins unless
 *  `TRIAGE_SLACK=app` says otherwise. */
function slackMode(v, e) {
  const m = (v || '').toLowerCase();
  if (!m) return webhookUrl(e) && notifyMode(e) !== 'off' ? 'webhook' : e.SLACK_BOT_TOKEN ? 'app' : 'off';
  if (!SLACK_MODES.includes(m)) throw new Error(`TRIAGE_SLACK must be ${SLACK_MODES.join(', ')} (got ${v})`);
  // The two typed against each other is a contradiction, not a default to
  // pick: say which one is meant.
  if (m === 'webhook' && String(e.TRIAGE_NOTIFY || '').toLowerCase() === 'off') throw new Error('TRIAGE_SLACK=webhook with TRIAGE_NOTIFY=off: one says the webhook is on and the other says off — drop one');
  return m;
}

/** The webhook (plan §16, G2): `TRIAGE_WEBHOOK_URL`, with `SLACK_WEBHOOK_URL`
 *  — the name it had when Slack was the only shape — read as an alias, so
 *  a .env written then goes on meaning it. */
const webhookUrl = (e) => e.TRIAGE_WEBHOOK_URL || e.SLACK_WEBHOOK_URL || null;

/** Which shape the webhook posts: `TRIAGE_NOTIFY` as typed, else inferred
 *  from the URL's host — Slack's and Discord's are known, anything else is
 *  generic JSON — and `off` without a URL. A shape it does not recognise
 *  is refused at boot, as every mode here is. */
function notifyMode(e) {
  const m = (e.TRIAGE_NOTIFY || '').toLowerCase();
  if (!m) return inferNotify(webhookUrl(e));
  if (!NOTIFY_MODES.includes(m)) throw new Error(`TRIAGE_NOTIFY must be ${NOTIFY_MODES.join(', ')} (got ${e.TRIAGE_NOTIFY})`);
  return m;
}

/** The preferences file (plan §14.4): layers 1, 2 and 4 of what interrupts
 *  you, and what a project is worth. Absent is the normal case and means
 *  nothing — out of the box triage is the default set and no file.
 *
 *  **Malformed throws.** A typo in JSON silently read as "no preferences"
 *  is the failure where you find out by not being interrupted, which is
 *  exactly the bug this whole section exists because of. Same argument as
 *  `calendarMode`: a typo must not read as the default. */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function loadPrefs(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    // **Only a missing file is "no preferences".** A directory, a bad mode,
    // a full disk read as absent would be the same silent failure in a
    // different coat: the box comes up with the defaults and nothing says
    // your configuration was never loaded.
    if (e.code === 'ENOENT') return null;
    throw new Error(`TRIAGE_PREFS: ${file} could not be read — ${e.message}`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error(`TRIAGE_PREFS: ${file} is not valid JSON — ${e.message}`); }
  if (!isPlainObject(parsed)) throw new Error(`TRIAGE_PREFS: ${file} must be a JSON object`);
  const { interrupts = {}, projects = {} } = parsed;
  // Refused rather than coerced, for the same reason. `"interrupts": null`
  // destructures past its default and would quietly mean "nothing stated";
  // an array would give itself numeric source or project names.
  if (!isPlainObject(interrupts)) throw new Error(`TRIAGE_PREFS: interrupts must be an object of source -> rules`);
  if (!isPlainObject(projects)) throw new Error(`TRIAGE_PREFS: projects must be an object of project -> settings`);
  for (const [k, v] of Object.entries(projects)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`TRIAGE_PREFS: projects."${k}" must be an object`);
    if (v.weight != null && !Number.isFinite(Number(v.weight))) throw new Error(`TRIAGE_PREFS: projects."${k}".weight must be a number`);
  }
  return { file, interrupts, projects };
}

/** A project's `weight` in the preferences file, merged into the ranker's
 *  stated preferences (plan §14.2). This is *ordering*, not interrupting —
 *  it is the half of "not all repos are equal" that `TRIAGE_RANK_PREFER`
 *  (§11.4 item 5) already answered, and it lives in the same `projects`
 *  block as that project's interrupt statements so one entry says both
 *  things. It never moves the interrupt bar by itself (§14.7).
 *
 *  `TRIAGE_RANK_PREFER` still wins for the same key — the env is the layer
 *  you type, here as everywhere — so a file entry is dropped when the env
 *  names the same field and value. */
function mergePreferences(prefs, env) {
  const fromFile = [];
  for (const [project, cfg] of Object.entries(prefs?.projects || {})) {
    if (cfg?.weight == null) continue;
    // `parsePreferences` reads exponent notation, so the weight goes through
    // as written. Rounding it here (an earlier attempt used `toFixed(4)`)
    // turned 1e-7 into a neutral 0 and 0.12345 into something else — quieter
    // than dropping it and no more honest.
    fromFile.push(...parsePreferences(`repo:${project}=${Number(cfg.weight)}`));
  }
  const typed = parsePreferences(env);
  const named = new Set(typed.map((p) => `${p.field}:${p.value}`));
  return [...fromFile.filter((p) => !named.has(`${p.field}:${p.value}`)), ...typed];
}

/** Who the interrupt names, so Slack actually notifies (plan §14.1). An
 *  incoming webhook posts an ordinary channel message, and Slack's default
 *  preference is *direct messages, mentions and keywords* — a message that
 *  mentions nobody is an unread badge and no push. The DM path it replaced
 *  was a notification by construction; this is how that property is carried
 *  across. Unset is nobody; `off` says so out loud; a bare `U0123` becomes
 *  `<@U0123>`; `!here` and `!channel` are taken as written.
 *
 *  **Its own variable, and it does not fall back to `SLACK_USER_ID`.** That
 *  one belongs to the `app` path, which the webhook superseded, and the
 *  production `.env` lists it under "deliberately absent" — reading it here
 *  would make that comment quietly false and re-couple webhook
 *  configuration to an app nobody is running. One knob, one job. */
export function parseMention(v, mode = 'slack') {
  // Only forms the endpoint actually notifies on (deliver/notify.js). **No
  // free-text fallback** on Slack or Discord: `TRIAGE_MENTION=alice` would
  // render the literal word `alice` at the head of every interrupt and
  // notify nobody, which is this whole change's bug with a new spelling. A
  // channel reference (`<#C…>`) is refused for the same reason — it links
  // a channel, it does not ping a person. Generic takes any text.
  return parseNotifyMention(mode, v);
}

/** Which Home Assistant to-do lists are read (plan §12.8), comma- or
 *  space-separated. Entity ids, and refused rather than coerced: `household`
 *  without its domain is not a mistake this should paper over, because the
 *  source would then read nothing and say nothing about why. */
export function parseHaLists(spec) {
  const out = [];
  for (const part of String(spec ?? '').split(/[,\s]+/)) {
    const l = part.trim().toLowerCase();
    if (!l) continue;
    if (!/^todo\.[a-z0-9_]+$/.test(l)) throw new Error(`HA_LISTS: ${part} is not a to-do entity id (todo.something)`);
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

/** Home Assistant (plan §12.8). `mode` unset means "on if the credentials
 *  are there" — the same shape the calendar and the ledger use, and for the
 *  same reason: a box that cannot reach Home Assistant should run the rest
 *  of triage rather than fail a poll a minute. `fake` is the canned pair of
 *  lists from test/, so a worktree proves the flow with no Home Assistant
 *  and no LAN route at all. */
function haConfig(e) {
  const m = (e.TRIAGE_HA || '').toLowerCase();
  if (m && !HA_MODES.includes(m)) throw new Error(`TRIAGE_HA must be ${HA_MODES.join(', ')} (got ${e.TRIAGE_HA})`);
  const url = String(e.HA_URL || '').trim().replace(/\/+$/, '');
  const lists = parseHaLists(e.HA_LISTS);
  return {
    mode: m || null,
    url: url || null,
    token: e.HA_TOKEN || null,
    lists,
    // Where an item's Open goes. There is no deep link to one to-do item in
    // Home Assistant, so it is the to-do panel — or the dashboard the lists
    // are actually ticked off on, when TRIAGE_HA_DASHBOARD names one.
    dashboard: e.TRIAGE_HA_DASHBOARD || (url ? `${url}/todo` : null),
  };
}

/** A comma- or newline-separated list, trimmed, empties dropped. */
const list = (v) => String(v ?? '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

/** `Acme Corp=acme, Another Co=other` — which project a company's
 *  records belong to (plan §14.3). A company it does not name is its own
 *  project, by name; an entry without `=` is refused rather than guessed. */
export function parseCrmProjects(spec) {
  const out = {};
  for (const part of list(spec)) {
    const i = part.lastIndexOf('=');
    const name = i > 0 ? part.slice(0, i).trim() : '';
    const project = i > 0 ? part.slice(i + 1).trim() : '';
    if (!name || !project) throw new Error(`TRIAGE_CRM_PROJECTS: "${part}" is not Company Name=project`);
    out[name] = project;
  }
  return out;
}

/** Twenty (plan §12.3 item 3). The same three-way shape as Home Assistant:
 *  unset means on when it can actually run — a URL, a key, and who you
 *  are — `on` refuses to start without them, `fake` is test/. Who you are
 *  has no default: without it every one of your own edits would read as
 *  somebody else's, and the first poll would be a page of interrupts. */
function crmConfig(e) {
  const m = (e.TRIAGE_CRM || '').toLowerCase();
  if (m && !CRM_MODES.includes(m)) throw new Error(`TRIAGE_CRM must be ${CRM_MODES.join(', ')} (got ${e.TRIAGE_CRM})`);
  const stale = e.TRIAGE_CRM_STALE_MIN != null && e.TRIAGE_CRM_STALE_MIN !== '' ? Number(e.TRIAGE_CRM_STALE_MIN) : 30;
  if (!Number.isFinite(stale) || stale < 0) throw new Error(`TRIAGE_CRM_STALE_MIN must be a number of minutes (got ${e.TRIAGE_CRM_STALE_MIN})`);
  const accessClientId = e.TWENTY_CF_ACCESS_CLIENT_ID || null;
  const accessClientSecret = e.TWENTY_CF_ACCESS_CLIENT_SECRET || null;
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) throw new Error('TWENTY_CF_ACCESS_CLIENT_ID and TWENTY_CF_ACCESS_CLIENT_SECRET must be set together');
  return {
    mode: m || null,
    url: String(e.TWENTY_URL || '').trim().replace(/\/+$/, '') || null,
    key: e.TWENTY_API_KEY || null,
    accessClientId,
    accessClientSecret,
    self: list(e.TRIAGE_CRM_ME),
    // Your agents act through the API under a key's name, not as you, so
    // the list is the names of the keys they hold. No default: a key this
    // list does not name is somebody else, which is the safe way to be wrong.
    agents: list(e.TRIAGE_CRM_AGENTS),
    projects: parseCrmProjects(e.TRIAGE_CRM_PROJECTS),
    // 0 turns the alarm off — said here so nobody has to read the source.
    staleMs: stale * 60_000,
  };
}

/** `TRIAGE_DEMO` (plan §16, G3): yes or no, and a typo is neither. */
function demoFlag(v) {
  const m = String(v ?? '').trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(m)) return true;
  if (['', '0', 'false', 'off', 'no'].includes(m)) return false;
  throw new Error(`TRIAGE_DEMO must be 1 or 0 (got ${v})`);
}

/** The demo (plan §16, G3): every source on its fake — the two forges, the
 *  calendar, the ledger, Home Assistant and the CRM — unless that source's
 *  own variable says `off`, so one fake can still be left out; and delivery
 *  off, because "no credential" has to mean nothing leaves the box. The one
 *  way out is a webhook on loopback, which is how a worktree reads the
 *  payload; the app path never runs here, whatever its tokens say. Applied
 *  to a config already resolved, so the fakes are exactly the modes a
 *  worktree sets one at a time. */
export function demoConfig(c, e) {
  const fake = (m) => (m === 'off' ? 'off' : 'fake');
  c.github.mode = fake(c.github.mode);
  c.gitlab.mode = fake(c.gitlab.mode);
  c.calendar.mode = fake(c.calendar.mode);
  c.ha.mode = fake(c.ha.mode);
  c.crm.mode = fake(c.crm.mode);
  // A queue file written to a temp dir at boot (test/fake-ledger.js), never
  // the one TRIAGE_LEDGER names.
  c.ledger = String(e.TRIAGE_LEDGER || '').trim().toLowerCase() === 'off' ? c.ledger : { mode: 'fake', file: null, statusDir: null };
  const s = c.slack;
  s.botToken = s.appToken = s.userId = null;
  if (String(e.TRIAGE_SLACK || '').toLowerCase() === 'off') return c;
  s.mode = 'webhook';
  if (!s.webhookUrl || !isLoopback(s.webhookUrl)) { s.notify = 'off'; s.webhookUrl = null; }
  return c;
}

/** The ledger (plan §12.3 item 1): a path names the queue file and turns the
 *  source on; its `status/` sibling is the handoffs directory. Unset is off —
 *  there is no default place for a file only some hosts have. */
function ledgerConfig(v) {
  const s = (v || '').trim();
  if (!s || s.toLowerCase() === 'off') return { mode: 'off', file: null, statusDir: null };
  return { mode: 'on', file: s, statusDir: path.join(path.dirname(s), 'status') };
}

export function loadConfig(env = process.env) {
  // `npm run demo` reads nothing of yours: with TRIAGE_DEMO in the
  // environment the default .env is skipped — its TRIAGE_DB would put the
  // demo's items in your store — and only a TRIAGE_ENV you name is read.
  const file = env.TRIAGE_ENV || (demoFlag(env.TRIAGE_DEMO) ? null : path.join(HOME, '.config', 'triage', '.env'));
  const e = { ...(file ? readEnvFile(file) : {}), ...env };
  const demo = demoFlag(e.TRIAGE_DEMO);
  // Where the files that live beside the .env default to, when there is one.
  const beside = path.dirname(file || path.join(HOME, '.config', 'triage', '.env'));
  const int = (k, d) => (e[k] != null && e[k] !== '' && !Number.isNaN(parseInt(e[k], 10)) ? parseInt(e[k], 10) : d);
  const num = (k, d) => (e[k] != null && e[k] !== '' && Number.isFinite(Number(e[k])) ? Number(e[k]) : d);
  // Plan §14: what interrupts you, and what your projects are worth. Named
  // by the environment, and defaulting beside the .env exactly as
  // GOOGLE_CLIENT_FILE does — which in a worktree is inside the checkout,
  // so it is gitignored: "nothing is read from the repo" (AGENTS.md) stays
  // true by making it uncommittable. Absent is the normal case.
  const prefsFile = e.TRIAGE_PREFS || (file ? path.join(beside, 'preferences.json') : null);
  const prefs = prefsFile ? loadPrefs(prefsFile) : null;
  const c = {
    envFile: file,
    demo,
    prefsFile: prefs ? prefsFile : null,
    prefs,
    // What is deployed, when whatever deployed it says so. triage never asks
    // git: the checkout it runs from may have moved on since this process
    // started, so the answer git gives is about the disk, not about what is
    // running. Unset — running by hand, or a deploy that does not set it —
    // reads as null, which is honest rather than wrong.
    commit: e.TRIAGE_COMMIT || null,
    port: int('TRIAGE_PORT', 3300),
    host: e.TRIAGE_HOST || '127.0.0.1',
    db: e.TRIAGE_DB || (demo ? ':memory:' : path.join(HOME, '.local', 'state', 'triage', 'triage.db')),
    // The forges (plan §16, G1). Each registers when its token resolves,
    // and `TRIAGE_GITHUB` / `TRIAGE_GITLAB` say `on` or `off` outright.
    github: {
      mode: forgeMode('TRIAGE_GITHUB', e.TRIAGE_GITHUB),
      base: String(e.TRIAGE_GITHUB_URL || 'https://api.github.com').replace(/\/+$/, ''),   // a GitHub Enterprise `https://host/api/v3`
      token: e.GITHUB_TOKEN || null,          // null -> `gh auth token`
      user: e.GITHUB_USER || null,            // null -> GET /user at boot
      all: e.TRIAGE_GITHUB_ALL === '1',       // read threads too, not just unread
      // A token per repository owner, by file name, for owners the default
      // token cannot read (lib/forge-api.js). Absent is the normal case.
      tokensDir: e.TRIAGE_TOKENS_DIR || path.join(HOME, '.config', 'triage', 'tokens'),
      // Issues as state (plan §12.3 item 2): the open set of each listed
      // repository, read whole every few minutes and reconciled. The list
      // is yours to write (§12.7); empty means the mode is off.
      // `TRIAGE_ISSUES` is the name it had before there were two forges and
      // is read as an alias, so a .env written then goes on meaning it.
      issues: { repos: parseRepos(e.TRIAGE_GITHUB_ISSUES ?? e.TRIAGE_ISSUES, { name: e.TRIAGE_GITHUB_ISSUES != null ? 'TRIAGE_GITHUB_ISSUES' : 'TRIAGE_ISSUES' }), everyMs: int('TRIAGE_ISSUES_EVERY_MIN', 5) * 60_000 },
    },
    gitlab: {
      mode: forgeMode('TRIAGE_GITLAB', e.TRIAGE_GITLAB),
      base: String(e.TRIAGE_GITLAB_URL || 'https://gitlab.com').replace(/\/+$/, ''),   // the instance; the API is /api/v4 under it
      token: e.GITLAB_TOKEN || null,          // null -> `glab auth token`
      user: e.GITLAB_USER || null,            // null -> GET /user at boot
      // The same mode, for projects: `group/project`, and a path may nest.
      issues: { projects: parseRepos(e.TRIAGE_GITLAB_ISSUES, { name: 'TRIAGE_GITLAB_ISSUES', host: 'gitlab.com' }), everyMs: int('TRIAGE_ISSUES_EVERY_MIN', 5) * 60_000 },
    },
    slack: {
      mode: slackMode(e.TRIAGE_SLACK, e),     // off | webhook | app; unset infers
      notify: notifyMode(e),                  // the webhook's shape: slack | discord | generic | off
      webhookUrl: webhookUrl(e),              // the credential: host only is ever logged
      botToken: e.SLACK_BOT_TOKEN || null,
      appToken: e.SLACK_APP_TOKEN || null,
      userId: e.SLACK_USER_ID || null,
      // What makes a webhook's channel message actually notify (plan §14.1),
      // in the grammar of the endpoint it goes to.
      mention: parseMention(e.TRIAGE_MENTION, notifyMode(e) === 'off' ? 'slack' : notifyMode(e)),
      quiet: e.TRIAGE_QUIET ?? '23:00-07:00', // "" disables
      tz: e.TRIAGE_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
      coalesceMs: int('TRIAGE_COALESCE_MIN', 10) * 60_000,
      maxAgeMs: int('TRIAGE_DELIVER_MAX_AGE_H', 24) * 3_600_000,
      // M5: which rules, per source, may fire Slack (plan §11.6, §11.9,
      // decided 2026-09-10) — and, since plan §14, for which
      // projects. Four layers: the built-in set in deliver/interrupts.js,
      // the preferences file globally, the preferences file per project,
      // and `TRIAGE_INTERRUPT`, which wins because typing it is what
      // "silence this now" looks like. Unset everything and it is exactly
      // the built-in set; `TRIAGE_INTERRUPT=off` interrupts on nothing.
      interrupts: resolveInterrupts({ prefs, env: e.TRIAGE_INTERRUPT }),
    },
    // M5: the ranking. The score is the product now and the tier is one of
    // its inputs (plan §11.1); the weights are config because a deterministic
    // function combines the features and nothing else does (§11.5, §13.3).
    rank: {
      weights: {
        claim: num('TRIAGE_RANK_W_CLAIM', DEFAULT_WEIGHTS.claim),
        time: num('TRIAGE_RANK_W_TIME', DEFAULT_WEIGHTS.time),
        prefer: num('TRIAGE_RANK_W_PREFER', DEFAULT_WEIGHTS.prefer),
        relevance: num('TRIAGE_RANK_W_RELEVANCE', DEFAULT_WEIGHTS.relevance),  // declared, absent: nothing computes it (§13.4)
        effort: num('TRIAGE_RANK_W_EFFORT', DEFAULT_WEIGHTS.effort),           // the same
      },
      // Stated preference as structure, which a scorer with no model can
      // read (§11.4 item 5) — and, since plan §14.2, where a project's
      // `weight` in the preferences file lands. Ordering only: the same
      // entry's interrupt statements are a separate mechanism (§14.7).
      prefer: mergePreferences(prefs, e.TRIAGE_RANK_PREFER),
      corroborate: num('TRIAGE_RANK_CORROBORATE', DEFAULT_CORROBORATE),
      hysteresis: num('TRIAGE_RANK_HYSTERESIS', DEFAULT_HYSTERESIS),
      backfill: int('TRIAGE_RANK_BACKFILL', 500),   // 0 disables the one bootstrap pass
    },
    // M3: the second source. `mode` is unset by default, which means "on if
    // the credentials are there" — a Google project is ring-0 work, and a
    // box without one should run the rest of triage rather than fail a poll
    // a minute. `fake` is the canned calendar from test/, so a worktree
    // proves the flow with no project at all.
    // The ledger as a source (plan §12.3): off unless `TRIAGE_LEDGER` names
    // the queue file (its `status/` sibling is the handoffs directory).
    ledger: ledgerConfig(e.TRIAGE_LEDGER),
    // The household's to-do lists (plan §12.8). Unset means on when HA_URL
    // and HA_TOKEN are both set; `off` never registers it; `fake` is test/.
    ha: haConfig(e),
    // Twenty's tasks and notes (plan §12.3 item 3). Unset means on when
    // TWENTY_URL, TWENTY_API_KEY and TRIAGE_CRM_ME are all set.
    crm: crmConfig(e),
    calendar: {
      // off | google | ics | fake; null -> ics when a feed is named, google
      // when the credentials resolve, off otherwise (server.js).
      mode: calendarMode(e.TRIAGE_CALENDAR),
      feed: calendarFeed(e),
      me: parseCalendarMe(e.TRIAGE_CALENDAR_ME),
      fetchMs: int('TRIAGE_CALENDAR_EVERY_MIN', 5) * 60_000,
      // Which calendar: the project its items belong to. Unset, the feed's
      // own name (X-WR-CALNAME), and Google's `primary`.
      id: e.TRIAGE_CALENDAR_ID || null,
      windowMs: int('TRIAGE_CALENDAR_WINDOW_H', 48) * 3_600_000,
      soonMs: int('TRIAGE_CALENDAR_SOON_MIN', 15) * 60_000,
      clientFile: e.GOOGLE_CLIENT_FILE || path.join(beside, 'google-oauth.json'),
      tokenFile: e.GOOGLE_TOKEN_FILE || path.join(beside, 'google-token.json'),
      clientId: e.GOOGLE_CLIENT_ID || null,
      clientSecret: e.GOOGLE_CLIENT_SECRET || null,
      refreshToken: e.GOOGLE_REFRESH_TOKEN || null,
    },
  };
  return demo ? demoConfig(c, e) : c;
}
