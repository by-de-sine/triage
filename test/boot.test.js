// What server.js does when a forge is not answering at boot (plan §17.1).
// The process, not a function: the failure this guards against was a
// reboot racing the network, and a forge dropped for the life of the
// process because one question failed once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** A port nothing is listening on: taken, then given back. */
const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** server.js with one forge configured, at a base that is not answering. */
function start(t, { db, port }) {
  const home = mkdtempSync(path.join(tmpdir(), 'triage-boot-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { stdio: ['ignore', 'ignore', 'pipe'],
    env: { HOME: home, TZ: 'UTC', TRIAGE_ENV: path.join(home, 'no.env'), TRIAGE_DB: db, TRIAGE_PORT: '0', TRIAGE_QUIET: '', GITHUB_TOKEN: 'ghp_test', TRIAGE_GITHUB_URL: `http://127.0.0.1:${port}`, TRIAGE_TOKENS_DIR: path.join(home, 'tokens') } });
  t.after(() => child.kill('SIGKILL'));
  const out = { child, log: '' };
  child.stderr.on('data', (b) => { out.log += b; });
  out.exit = new Promise((resolve) => child.on('exit', resolve));
  out.listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line in 5 s:\n${out.log}`)), 5000);
    child.stderr.on('data', () => { const m = /listening on (http:\/\/\S+)/.exec(out.log); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server.js exited ${code}:\n${out.log}`)); });
  });
  return out;
}

test('a forge that is not answering at boot is registered anyway when the store knows whose queue this is — failing in plain sight, and reading again the moment it answers', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'triage-boot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'triage.db');
  const seed = new Store(db);
  seed.upsertItem({ user: 'alice', source: 'github', key: 'o/r#1', kind: 'pull', title: 'From before the reboot', repo: 'o/r' });
  seed.close();
  const port = await freePort();
  const s = start(t, { db, port });
  const base = await s.listening;
  assert.match(s.log, /github: http:\/\/127\.0\.0\.1:\d+ is not answering \(.*\) — registered without knowing who you are there/);
  assert.ok(!/github: off/.test(s.log));
  // Asked now rather than on the runner's stagger: still down.
  let r = await fetch(`${base}/api/sources/github/run`, { method: 'POST' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /^cannot resolve who you are: /);
  let h = await (await fetch(`${base}/healthz`)).json();
  assert.deepEqual(h.failing, ['github']);
  assert.match(h.read.github.error, /^cannot resolve who you are: /);
  assert.equal(h.identity.github, undefined);
  const b = await (await fetch(`${base}/api/brief`)).json();
  assert.deepEqual(b.sources.map((x) => [x.name, x.since]), [['github', null]], 'and the brief says so, where a forge dropped at boot was on no surface at all');
  // The far end comes back.
  const forge = http.createServer((q, res) => {
    res.setHeader('content-type', 'application/json');
    if (q.url.startsWith('/user')) return res.end(JSON.stringify({ login: 'alice' }));
    if (q.url.startsWith('/notifications')) return res.end('[]');
    res.statusCode = 404; res.end('{"message":"Not Found"}');
  });
  await new Promise((resolve) => forge.listen(port, '127.0.0.1', resolve));
  t.after(() => forge.close());
  r = await fetch(`${base}/api/sources/github/run`, { method: 'POST' });
  assert.equal(r.status, 200);
  h = await (await fetch(`${base}/healthz`)).json();
  assert.deepEqual([h.failing, h.identity.github, h.read.github.ok], [[], 'alice', true]);
  assert.match(s.log, /github: you are alice — resolved now, not at boot/);
});

test('with an empty store there is nobody to file items under, so the forge is off, as it always was — and a refusal is never retried', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'triage-boot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const empty = start(t, { db: path.join(dir, 'empty.db'), port: await freePort() });
  empty.listening.catch(() => {});
  assert.equal(await empty.exit, 1);
  assert.match(empty.log, /github: off — cannot resolve who you are at http:\/\/127\.0\.0\.1:\d+/);
  assert.match(empty.log, /no source is configured/);
  // A 401 will not get better by asking: off, with a store that has a user.
  const db = path.join(dir, 'triage.db');
  const seed = new Store(db);
  seed.upsertItem({ user: 'alice', source: 'github', key: 'o/r#1', kind: 'pull', title: 'x', repo: 'o/r' });
  seed.close();
  const port = await freePort();
  const forge = http.createServer((q, res) => { res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end('{"message":"Bad credentials"}'); });
  await new Promise((resolve) => forge.listen(port, '127.0.0.1', resolve));
  t.after(() => forge.close());
  const refused = start(t, { db, port });
  refused.listening.catch(() => {});
  assert.equal(await refused.exit, 1);
  assert.match(refused.log, /github: off — cannot resolve who you are .*GitHub 401.*Bad credentials/);
  assert.ok(!/registered without knowing/.test(refused.log));
});
