import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitHubApi, GitLabApi, RestApi, githubToken, gitlabToken } from '../lib/forge-api.js';
import { isBot, sameLogin } from '../lib/util.js';

/** A fetch that records what it was asked and answers with canned pages. */
function recorder(pages = [[]]) {
  const calls = [];
  let i = 0;
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, method: init.method });
    const body = pages[Math.min(i, pages.length - 1)]; i++;
    const hdr = new Headers({ 'x-ratelimit-remaining': '42' });
    if (i < pages.length) hdr.set('link', `<${url.split('?')[0]}?page=${i + 1}>; rel="next"`);
    return { status: 200, headers: hdr, text: async () => JSON.stringify(body) };
  };
  return { calls, fetch };
}

test('GitHub: bearer auth, the api version header, and a web base that pairs with the API base', async () => {
  const r = recorder([{ login: 'alice' }]);
  const api = new GitHubApi({ token: 'tok', tokensDir: '/nonexistent', fetch: r.fetch });
  assert.equal((await api.get('/user')).body.login, 'alice');
  assert.equal(r.calls[0].url, 'https://api.github.com/user');
  assert.equal(r.calls[0].headers.authorization, 'Bearer tok');
  assert.equal(r.calls[0].headers['x-github-api-version'], '2022-11-28');
  assert.equal(api.rate.remaining, 42);
  assert.equal(api.webBase, 'https://github.com');
  const ghe = new GitHubApi({ base: 'https://git.example.com/api/v3', token: 't', fetch: r.fetch });
  assert.equal(ghe.webBase, 'https://git.example.com');
  assert.equal(ghe.ownerOf('https://git.example.com/api/v3/repos/acme/widgets/issues'), 'acme');
  assert.equal(ghe.ownerOf('https://api.github.com/repos/acme/widgets'), null, 'another host is not this base');
});

test('the token goes only where the base does: another origin gets the request bare', async () => {
  const r = recorder([[]]);
  const api = new GitHubApi({ token: 'tok', tokensDir: '/nonexistent', fetch: r.fetch });
  await api.get('https://api.github.com/repos/o/r/issues');
  assert.equal(r.calls[0].headers.authorization, 'Bearer tok');
  await api.get('https://evil.example.com/repos/o/r/issues');
  assert.equal(r.calls[1].headers.authorization, undefined);
  const gl = new GitLabApi({ token: 'glpat', fetch: r.fetch });
  await gl.get('https://gitlab.com/api/v4/user');
  assert.equal(r.calls[2].headers['PRIVATE-TOKEN'], 'glpat');
  await gl.get('https://gitlab.example.com/api/v4/user');
  assert.equal(r.calls[3].headers['PRIVATE-TOKEN'], undefined);
});

test('a redirect is followed only on the origin, and never with the token off it', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, redirect: init.redirect });
    if (url.endsWith('/repos/old/name')) return { status: 301, headers: new Headers({ location: 'https://api.github.com/repos/new/name' }), text: async () => '' };
    if (url.endsWith('/repos/away')) return { status: 302, headers: new Headers({ location: 'https://evil.example.com/repos/away' }), text: async () => '' };
    if (url.endsWith('/repos/loop')) return { status: 307, headers: new Headers({ location: '/repos/loop' }), text: async () => '' };
    return { status: 200, headers: new Headers(), text: async () => '{"ok":true}' };
  };
  const api = new GitHubApi({ token: 'tok', tokensDir: '/nonexistent', fetch });
  assert.deepEqual((await api.get('/repos/old/name')).body, { ok: true }, 'a renamed repository is followed');
  assert.deepEqual(calls.map((c) => [c.url, c.auth, c.redirect]), [['https://api.github.com/repos/old/name', 'Bearer tok', 'manual'], ['https://api.github.com/repos/new/name', 'Bearer tok', 'manual']]);
  await assert.rejects(api.get('/repos/away'), /302 on GET .*redirected off https:\/\/api\.github\.com, not followed/);
  assert.equal(calls.length, 3, 'the off-origin hop is never fetched');
  await assert.rejects(api.get('/repos/loop'), /more than 3 redirects/);
});

test('GitHub: a per-owner token is a file, or a gh config directory asked through gh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-tokens-'));
  fs.writeFileSync(path.join(dir, 'acme'), '# the owner\nghp_acme\n');
  fs.mkdirSync(path.join(dir, 'beta'));
  fs.writeFileSync(path.join(dir, 'beta', 'hosts.yml'), 'github.com:\n');
  fs.mkdirSync(path.join(dir, 'gamma'));   // a directory with no hosts.yml: nothing to ask
  const asked = [];
  const gh = async (configDir) => { asked.push(configDir); return 'gho_beta'; };
  const r = recorder([[]]);
  const api = new GitHubApi({ token: 'default', tokensDir: dir, gh, fetch: r.fetch });
  assert.equal(await api.tokenFor('https://api.github.com/repos/acme/widgets/issues'), 'ghp_acme');
  assert.equal(await api.tokenFor('https://api.github.com/repos/beta/site/issues'), 'gho_beta');
  assert.equal(await api.tokenFor('https://api.github.com/repos/beta/site/pulls'), 'gho_beta');
  assert.deepEqual(asked, [path.join(dir, 'beta')], 'gh is asked once per owner, then cached');
  assert.equal(await api.tokenFor('https://api.github.com/repos/gamma/x'), 'default');
  assert.equal(await api.tokenFor('https://api.github.com/repos/nobody/x'), 'default');
  assert.equal(await api.tokenFor('https://api.github.com/notifications'), 'default', 'the inbox is not any owner\'s');
  await api.get('/repos/acme/widgets/issues');
  assert.equal(r.calls[0].headers.authorization, 'Bearer ghp_acme');
  fs.rmSync(dir, { recursive: true });
});

test('GitLab: PRIVATE-TOKEN, /api/v4 under the instance, and a project by its encoded path', async () => {
  const r = recorder([{ username: 'alice' }]);
  const api = new GitLabApi({ token: 'glpat', fetch: r.fetch });
  assert.equal((await api.get('/user')).body.username, 'alice');
  assert.equal(r.calls[0].url, 'https://gitlab.com/api/v4/user');
  assert.equal(r.calls[0].headers['PRIVATE-TOKEN'], 'glpat');
  assert.equal(r.calls[0].headers.authorization, undefined);
  assert.equal(api.webBase, 'https://gitlab.com');
  assert.equal(api.project('acme/platform/sub'), '/projects/acme%2Fplatform%2Fsub');
  const self = new GitLabApi({ base: 'https://git.example.com/', token: 't', fetch: r.fetch });
  assert.equal(self.base, 'https://git.example.com/api/v4');
  assert.equal(self.webBase, 'https://git.example.com');
});

test('paging: listPages follows rel=next up to the cap and says whether the list ended', async () => {
  const r = recorder([[1, 2], [3], [4]]);
  const api = new RestApi({ base: 'https://x.test', fetch: r.fetch });
  const capped = await api.listPages('/things', { pages: 2, params: { state: 'open', skip: null } });
  assert.deepEqual(capped, { list: [1, 2, 3], whole: false });
  assert.match(r.calls[0].url, /per_page=100/);
  assert.match(r.calls[0].url, /state=open/);
  assert.doesNotMatch(r.calls[0].url, /skip/);
  const r2 = recorder([[1], [2]]);
  const whole = await new RestApi({ base: 'https://x.test', fetch: r2.fetch }).listPages('/things', { pages: 5 });
  assert.deepEqual(whole, { list: [1, 2], whole: true });
});

test('errors carry the status; 304 and 205 carry no body; 5xx throws', async () => {
  const fetch = async (url) => {
    const st = parseInt(url.split('/').pop(), 10);
    return { status: st, headers: new Headers(), text: async () => (st === 404 ? '{"message":"Not Found"}' : '') };
  };
  const api = new RestApi({ base: 'https://x.test', fetch });
  await assert.rejects(api.get('/404'), (e) => e.status === 404 && /Not Found/.test(e.message));
  await assert.rejects(api.get('/503'), /503/);
  assert.equal((await api.get('/304')).body, null);
  assert.equal((await api.request('PATCH', '/205')).status, 205);
});

test('tokens: the environment first; a missing gh or glab reads as no token, never as an error', async () => {
  assert.equal(await githubToken({ GITHUB_TOKEN: 'ghp_x' }), 'ghp_x');
  assert.equal(await gitlabToken({ GITLAB_TOKEN: 'glpat_x' }), 'glpat_x');
  const PATH = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    assert.equal(await gitlabToken({}), null);
    assert.equal(await githubToken({}), null);
  } finally { process.env.PATH = PATH; }
});

test('bots on both forges, and logins compared without case', () => {
  assert.ok(isBot('project_123_bot'));
  assert.ok(isBot('group_7_bot_abc'.replace('_abc', '')));
  assert.ok(isBot('gitlab-bot'));
  assert.ok(isBot('ghost'));
  assert.ok(!isBot('ghostwriter'));
  assert.ok(!isBot('projector'));
  assert.ok(sameLogin('Alice', 'alice'));
  assert.ok(!sameLogin('alice', 'alicia'));
});
