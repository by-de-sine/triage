#!/usr/bin/env node
// google-consent.js — the one-time browser step for the calendar source,
// run once, by hand, from an interactive shell. Everything else about
// triage is unattended; this is not, because only a human can approve an
// OAuth scope.
//
//   node bin/google-consent.js
//
// It reads the OAuth *desktop client* from beside the .env, writes the
// authorize URL to a file to carry to a machine with a browser, waits
// for the address the browser lands on to be pasted back, exchanges the code
// and writes the refresh token to google-token.json, mode 0600. Nothing
// else on this box ever runs it, and the service never needs it again.
//
// **The redirect is meant to fail.** Google sends the browser to
// `http://localhost:9004/?code=…`, which is this box, not the laptop, so the
// page does not load. That is the expected outcome, not an error — the whole
// address bar is the payload, and it is the same paste-back Claude Code's own
// OAuth does over SSH.
// A listener on this box would not help: the browser is on the laptop.
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { readCredentials, AUTH_URL, TOKEN_URL, SCOPES } from '../lib/google-api.js';

const REDIRECT = 'http://localhost:9004';
const cfg = loadConfig().calendar;
const say = (m) => console.error(m);

// The refresh token is what this script is here to produce, so stand one in
// to get past the check that the *client* is what readCredentials also wants.
const creds = readCredentials({ ...cfg, refreshToken: 'about to be minted' });
if (!creds) {
  say(`no OAuth client. Put the desktop client JSON from the Google Cloud console at\n  ${cfg.clientFile}\n(mode 0600), or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. See docs/plan.md §9 item 5.`);
  process.exit(1);
}

// PKCE. A desktop client's secret is not a secret — it ships in the app —
// so the verifier is what actually binds this exchange to this request.
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const url = `${AUTH_URL}?${new URLSearchParams({
  client_id: creds.clientId,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPES.join(' '),
  access_type: 'offline',
  prompt: 'consent',            // without it a second run returns no refresh token
  code_challenge: challenge,
  code_challenge_method: 'S256',
})}`;

const urlFile = path.join(path.dirname(cfg.tokenFile), 'google-consent-url.txt');
mkdirSync(path.dirname(urlFile), { recursive: true, mode: 0o700 });
writeFileSync(urlFile, url + '\n', { mode: 0o600 });

say(`\ntriage · Google Calendar consent — once, from the laptop.\n`);
say(`1. Carry the authorize URL to a browser — it is in:\n`);
say(`     ${urlFile}\n`);
say(`2. Open it in the laptop browser and approve read-only access to your calendar.`);
say(`   An unverified app warns once: Advanced → Go to <app> (unsafe). That is this app.`);
say(`3. The browser lands on a localhost page that FAILS TO LOAD. That is expected.`);
say(`   Copy the whole address bar — it is http://localhost:9004/?code=… — and paste it below.\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const pasted = (await rl.question('paste the address here: ')).trim();
rl.close();

// The whole address, or just the query — either carries the code.
const m = /[?&]code=([^&\s]+)/.exec(pasted);
const code = m ? decodeURIComponent(m[1]) : null;
if (!code) { say('\nno ?code= in that. Paste the whole address, including http://localhost:9004/.'); process.exit(1); }

const body = new URLSearchParams({ client_id: creds.clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: REDIRECT });
if (creds.clientSecret) body.set('client_secret', creds.clientSecret);
const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
const out = await res.json().catch(() => null);
if (!res.ok || !out?.refresh_token) {
  say(`\nthe exchange failed: ${out?.error || res.status}${out?.error_description ? ' — ' + out.error_description : ''}`);
  if (out?.access_token && !out.refresh_token) say('Google gave an access token but no refresh token — the account has approved this client before. Revoke it at myaccount.google.com/permissions and run this again.');
  process.exit(1);
}

writeFileSync(cfg.tokenFile, JSON.stringify({ refresh_token: out.refresh_token, scope: out.scope || SCOPES.join(' '), obtained: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
// `mode` only applies when writeFileSync *creates* the file, so a second run
// over a file that was once 0644 would leave a refresh token world-readable.
chmodSync(cfg.tokenFile, 0o600);
writeFileSync(urlFile, '', { mode: 0o600 });   // the code is spent; do not leave the URL lying about
say(`\nwritten: ${cfg.tokenFile} (mode 0600), scope ${out.scope || SCOPES.join(' ')}`);
say(`Now: systemctl --user restart triage — the calendar source registers on the next boot.`);
say(`If the OAuth app is still in *Testing*, this token dies in seven days; publish it.`);
