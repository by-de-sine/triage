// The demo (plan §16, G3): `TRIAGE_DEMO=1` is every fake the tree has, the
// store in memory, and nothing leaving the box. The config half is checked
// as resolved; the boot half runs server.js itself, because the promise is
// "a stranger with nothing sees the demo", and that is a process, not a
// function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.js';
import { SlackDelivery } from '../deliver/slack.js';
import { Store } from '../lib/store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCES = ['github', 'gitlab', 'calendar', 'ledger', 'ha', 'crm'];
const modes = (c) => ({ github: c.github.mode, gitlab: c.gitlab.mode, calendar: c.calendar.mode, ledger: c.ledger.mode, ha: c.ha.mode, crm: c.crm.mode });
const allFake = Object.fromEntries(SOURCES.map((s) => [s, 'fake']));

test('the demo resolves to every fake, a store in memory, and delivery off', () => {
  const c = loadConfig({ TRIAGE_DEMO: '1' });
  assert.equal(c.demo, true);
  assert.deepEqual(modes(c), allFake);
  assert.equal(c.db, ':memory:');
  assert.equal(c.envFile, null, 'TRIAGE_DEMO in the environment reads no default .env');
  assert.equal(c.slack.mode, 'webhook');
  assert.equal(c.slack.notify, 'off', 'TRIAGE_NOTIFY=off — the mode G2 made real, not a new one');
  const d = new SlackDelivery(new Store(), c.slack);
  assert.equal(d.enabled, false);
  assert.match(d.disabledReason, /^not delivered: .* off/);
  // Not the demo: nothing changes.
  const plain = loadConfig({ TRIAGE_ENV: '/nonexistent/triage.env' });
  assert.equal(plain.demo, false);
  assert.deepEqual(modes(plain), { github: null, gitlab: null, calendar: null, ledger: 'off', ha: null, crm: null });
  assert.throws(() => loadConfig({ TRIAGE_DEMO: 'maybe' }), /TRIAGE_DEMO must be 1 or 0/);
  assert.equal(loadConfig({ TRIAGE_DEMO: '0', TRIAGE_ENV: '/nonexistent/triage.env' }).demo, false);
});

test('the demo reads nothing of yours: real credentials are dropped, and only a loopback webhook is posted to', () => {
  const real = { TRIAGE_DEMO: '1', GITHUB_TOKEN: 'ghp_real', TRIAGE_LEDGER: '/home/alice/OPEN_LOOPS.md', TRIAGE_CALENDAR: 'google', SLACK_BOT_TOKEN: 'xoxb-real', SLACK_APP_TOKEN: 'xapp-real', SLACK_USER_ID: 'U1' };
  let c = loadConfig({ ...real, TRIAGE_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' });
  assert.deepEqual(modes(c), allFake, 'a named ledger, a Google calendar: the demo runs the fakes instead');
  assert.equal(c.slack.notify, 'off');
  assert.equal(c.slack.webhookUrl, null, 'the real URL is not even held');
  assert.deepEqual([c.slack.botToken, c.slack.appToken, c.slack.userId], [null, null, null], 'the app path never runs in the demo');
  c = loadConfig({ ...real, TRIAGE_SLACK: 'app' });
  assert.equal(c.slack.mode, 'webhook');
  assert.equal(new SlackDelivery(new Store(), c.slack).enabled, false);
  // A listener of your own on loopback is the one way out, as in a worktree.
  c = loadConfig({ TRIAGE_DEMO: '1', TRIAGE_WEBHOOK_URL: 'http://127.0.0.1:9999/hook' });
  assert.equal(c.slack.notify, 'generic');
  assert.equal(c.slack.webhookUrl, 'http://127.0.0.1:9999/hook');
  assert.equal(new SlackDelivery(new Store(), c.slack).enabled, true);
  // A source's own `off` still leaves one fake out; TRIAGE_DB still names a store.
  c = loadConfig({ TRIAGE_DEMO: '1', TRIAGE_CALENDAR: 'off', TRIAGE_LEDGER: 'off', TRIAGE_GITLAB: 'off', TRIAGE_DB: '/tmp/demo.db' });
  assert.deepEqual(modes(c), { ...allFake, calendar: 'off', ledger: 'off', gitlab: 'off' });
  assert.equal(c.db, '/tmp/demo.db');
});

test('a .env that says TRIAGE_DEMO=1 is the demo too, read because TRIAGE_ENV names it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'triage-demo-'));
  try {
    writeFileSync(path.join(dir, '.env'), 'TRIAGE_DEMO=1\nTRIAGE_DB=/tmp/worktree.db\nTRIAGE_PORT=3301\n');
    const c = loadConfig({ TRIAGE_ENV: path.join(dir, '.env') });
    assert.equal(c.demo, true);
    assert.deepEqual(modes(c), allFake);
    assert.equal(c.db, '/tmp/worktree.db');
    assert.equal(c.port, 3301);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TRIAGE_DEMO=1 boots server.js on every fake: items from every source, nothing delivered, the temp ledger removed at shutdown', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'triage-demo-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // A bare environment: no token, no .env, no PATH to `gh` — the stranger with nothing.
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { HOME: home, TRIAGE_DEMO: '1', TRIAGE_PORT: '0', TRIAGE_QUIET: '', TZ: 'UTC' }, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let log = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line in 5 s:\n${log}`)), 5000);
    child.stderr.on('data', (b) => { log += b; const m = /listening on (http:\/\/\S+)/.exec(log); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server.js exited ${code}:\n${log}`)); });
  });
  const get = async (p) => (await fetch(base + p)).json();
  // Poll each now rather than wait for the runner's stagger.
  for (const s of SOURCES) assert.equal((await fetch(`${base}/api/sources/${s}/run`, { method: 'POST' })).status, 200, s);
  const { sources } = await get('/api/sources');
  assert.deepEqual(sources.map((s) => s.name).sort(), [...SOURCES].sort());
  for (const s of sources) assert.ok(!s.error, `${s.name}: ${s.error}`);
  const { items } = await get('/api/items?limit=1000');
  assert.deepEqual([...new Set(items.map((i) => i.source))].sort(), [...SOURCES].sort(), 'the page shows items from every source');
  const { decisions } = await get('/api/decisions?limit=1000');
  assert.ok(decisions.length >= items.length);
  assert.equal(decisions.filter((d) => d.delivered).length, 0);
  // The interrupts the fakes are built to raise are refused for the one reason.
  const p0 = decisions.filter((d) => d.tier === 'P0');
  assert.ok(p0.length > 0, 'the demo has P0s to show');
  for (const d of p0) assert.match(d.note, /^not delivered: .* off/, `${d.rule}: ${d.note}`);
  assert.match(log, /DEMO \(TRIAGE_DEMO=1\)/);
  const ledgerFile = /ledger: FAKE .* at (\S+OPEN_LOOPS\.md)/.exec(log)?.[1];
  assert.ok(ledgerFile && existsSync(ledgerFile));
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  assert.equal(existsSync(path.dirname(ledgerFile)), false, 'the temp ledger is removed at shutdown');
});
