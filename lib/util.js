// util.js — the few helpers everything needs. Stdlib only.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const nowIso = () => new Date().toISOString();

/** Run a command and capture it. Never throws. */
export function sh(cmd, args = [], { cwd, timeout = 30_000, env } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (ok, extra = '') => { if (done) return; done = true; resolve({ ok, stdout: out.trim(), stderr: (err + extra).trim() }); };
    let child;
    try { child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return finish(false, String(e)); }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(false, `timed out after ${timeout} ms`); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); finish(false, String(e)); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0, code === 0 ? '' : `exit ${code}`); });
  });
}

/** KEY=value lines, `#` comments, optional quotes. Missing file -> {}. */
export function readEnvFile(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return {}; }
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

/** The first non-comment line of a token file, or null. */
export function readTokenFile(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || null;
  } catch { return null; }
}

export const TOKENS_DIR = path.join(HOME, '.config', 'triage', 'tokens');

/** Logins that are automation, not people — GitHub's `[bot]` suffix and
 *  the usual review and dependency bots; GitLab's project and group access
 *  tokens (`project_123_bot`), its own `gitlab-bot`, and `ghost`, which is
 *  what both forges call a deleted account. */
export function isBot(login) {
  return /\[bot\]$|^(dependabot|renovate|coderabbitai|copilot|github-actions|codecov|sonarcloud)(\[bot\]|[-_]|$)|^(project|group)_\d+_bot|^gitlab-bot$|^ghost$/i.test(String(login || ''));
}

/** Logins are case-insensitive on both forges, and `me` may be typed into
 *  the .env in either case; an exact compare would make your own issue
 *  someone else's. */
export const sameLogin = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** Is this actor you? `me` is one login, or every name you act under on a
 *  source: a source may know you by several names (a person's, and the
 *  names your agents act under), so an identity may be a list, and an
 *  actor is you when it is any of them. */
export const isMe = (actor, me) => (Array.isArray(me) ? me : [me]).some((m) => m != null && sameLogin(actor, m));

/** The `rel="next"` URL of a Link header, or null. */
export function nextLink(link) { const m = /<([^>]+)>;\s*rel="next"/.exec(link || ''); return m ? m[1] : null; }

/** One line, at most n characters, for a Slack message or a log. */
export function oneLine(s, n = 160) {
  const t = String(s || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** Hosts allowed to be plain `http:`. A worktree proves delivery — or serves a
 *  calendar feed — on 127.0.0.1, and that is the only reason http exists;
 *  anything else must be https, because the URL is the credential and what
 *  travels over it is private. Syntactic on purpose — no
 *  DNS lookup, so nothing here can be steered by a resolver. */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|0:0:0:0:0:0:0:1)$/i;
export const isLoopback = (url) => { try { return LOOPBACK.test(new URL(url).hostname.replace(/^\[|\]$/g, '')); } catch { return false; } };
