// Configuration: the modes that infer, and the typos that must not read as
// a default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, SLACK_MODES } from '../lib/config.js';

// TRIAGE_ENV names a file that does not exist, so nothing on the box leaks
// into these — least of all the production .env, which has a real webhook
// URL in it.
const cfg = (over = {}) => loadConfig({ TRIAGE_ENV: '/nonexistent/triage.env', ...over });

test('TRIAGE_SLACK unset infers from what is actually configured', () => {
  assert.equal(cfg().slack.mode, 'off');
  assert.equal(cfg({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' }).slack.mode, 'webhook');
  assert.equal(cfg({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_USER_ID: 'U1' }).slack.mode, 'app');
  // Both present — the app path is not deleted, so someone comparing the
  // two will have both lines. The webhook wins; TRIAGE_SLACK=app says
  // otherwise.
  assert.equal(cfg({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x', SLACK_BOT_TOKEN: 'xoxb-1' }).slack.mode, 'webhook');
});

test('TRIAGE_SLACK set wins over the inference, in both directions', () => {
  assert.equal(cfg({ TRIAGE_SLACK: 'app', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' }).slack.mode, 'app');
  assert.equal(cfg({ TRIAGE_SLACK: 'webhook' }).slack.mode, 'webhook');
  assert.equal(cfg({ TRIAGE_SLACK: 'off', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' }).slack.mode, 'off');
  assert.equal(cfg({ TRIAGE_SLACK: 'WebHook' }).slack.mode, 'webhook');
});

test('a mode nobody recognises is refused, not defaulted', () => {
  // The failure this prevents: `TRIAGE_SLACK=appp` reading as "whatever is
  // in the .env" and delivering through a path nobody asked for.
  assert.throws(() => cfg({ TRIAGE_SLACK: 'appp' }), /TRIAGE_SLACK must be off, webhook, app \(got appp\)/);
  assert.throws(() => cfg({ TRIAGE_SLACK: 'webhok', SLACK_WEBHOOK_URL: 'https://x/y' }), /TRIAGE_SLACK must be/);
  assert.deepEqual(SLACK_MODES, ['off', 'webhook', 'app']);
});

test('the webhook URL is carried through as given', () => {
  const c = cfg({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' });
  assert.equal(c.slack.webhookUrl, 'https://hooks.slack.com/services/T/B/x');
  assert.equal(cfg().slack.webhookUrl, null);
});

test('TRIAGE_CALENDAR keeps its shape — the one TRIAGE_SLACK copies', () => {
  assert.equal(cfg().calendar.mode, null);
  assert.equal(cfg({ TRIAGE_CALENDAR: 'fake' }).calendar.mode, 'fake');
  assert.throws(() => cfg({ TRIAGE_CALENDAR: 'googel' }), /TRIAGE_CALENDAR must be/);
});

test('TRIAGE_COMMIT is what the deployer says is running, or null', () => {
  assert.equal(cfg().commit, null);
  assert.equal(cfg({ TRIAGE_COMMIT: '403bb7a874cead4164850240eff25982943d88f8' }).commit, '403bb7a874cead4164850240eff25982943d88f8');
});

test('TRIAGE_ISSUES is a list of repositories, not an inference; a bad entry is refused', () => {
  assert.deepEqual(cfg().github.issues, { repos: [], everyMs: 5 * 60_000 });
  const c = cfg({ TRIAGE_ISSUES: 'o/r, https://github.com/Acme/widgets/, o/r\nacme/site.git', TRIAGE_ISSUES_EVERY_MIN: '2' });
  assert.deepEqual(c.github.issues.repos, ['o/r', 'Acme/widgets', 'acme/site']);
  assert.equal(c.github.issues.everyMs, 120_000);
  assert.throws(() => cfg({ TRIAGE_ISSUES: 'triage' }), /TRIAGE_ISSUES: triage is not owner\/name/);
  assert.throws(() => cfg({ TRIAGE_ISSUES: 'a/b/c' }), /TRIAGE_ISSUES/);
  assert.equal(cfg({ TRIAGE_ISSUES_EVERY_MIN: '0' }).github.issues.everyMs, 0, '0 reads the open set on every poll');
  assert.deepEqual(cfg({ TRIAGE_ISSUES: 'o/r, O/R' }).github.issues.repos, ['o/r'], 'one repository, one read');
});

test('the forges: TRIAGE_GITHUB_ISSUES is the name and TRIAGE_ISSUES its alias; GitLab has its own block; a mode is on, off or refused', () => {
  const c = cfg({ TRIAGE_GITHUB_ISSUES: 'o/r', TRIAGE_ISSUES: 'ignored/when-the-new-name-is-set', TRIAGE_GITLAB_ISSUES: 'acme/platform, https://gitlab.com/acme/platform/sub/', GITLAB_TOKEN: 'glpat', GITLAB_USER: 'alice', TRIAGE_GITLAB_URL: 'https://git.example.com/' });
  assert.deepEqual(c.github.issues.repos, ['o/r']);
  assert.deepEqual(c.gitlab.issues.projects, ['acme/platform', 'acme/platform/sub'], 'a GitLab path may nest');
  assert.equal(c.gitlab.token, 'glpat');
  assert.equal(c.gitlab.user, 'alice');
  assert.equal(c.gitlab.base, 'https://git.example.com');
  assert.equal(c.gitlab.mode, null, 'unset: on if a token resolves');
  assert.equal(cfg().gitlab.base, 'https://gitlab.com');
  assert.equal(cfg().github.base, 'https://api.github.com');
  assert.equal(cfg({ TRIAGE_GITHUB_URL: 'https://github.example.com/api/v3/' }).github.base, 'https://github.example.com/api/v3');
  assert.equal(cfg({ TRIAGE_GITHUB: 'off' }).github.mode, 'off');
  assert.equal(cfg({ TRIAGE_GITLAB: 'ON' }).gitlab.mode, 'on');
  assert.throws(() => cfg({ TRIAGE_GITLAB: 'fake' }), /TRIAGE_GITLAB must be off, on/);
  assert.throws(() => cfg({ TRIAGE_GITHUB_ISSUES: 'a/b/c' }), /TRIAGE_GITHUB_ISSUES: a\/b\/c is not owner\/name/, 'GitHub does not nest');
  assert.throws(() => cfg({ TRIAGE_GITLAB_ISSUES: 'platform' }), /TRIAGE_GITLAB_ISSUES: platform is not group\/project/);
});

// ---------------------------------------------------------------------------
// The preferences file (plan §14.4): layers 1, 2 and 4 of what interrupts
// you, and what a project is worth. Named by the environment, never read
// from the repo, and absent by default.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPrefs, parseMention } from '../lib/config.js';

const withPrefs = (json, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-prefs-'));
  const file = path.join(dir, 'preferences.json');
  fs.writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('no preferences file is the normal case, and costs nothing', () => {
  const c = cfg();
  assert.equal(c.prefs, null);
  assert.equal(c.prefsFile, null);
  assert.deepEqual(c.slack.interrupts.set, { github: ['reply_to_my_review_comment', 'reply_to_my_comment', 'direct_mention', 'review_requested', 'new_pull_request'], gitlab: ['reply_to_my_review_comment', 'reply_to_my_comment', 'direct_mention', 'review_requested', 'new_pull_request'], calendar: ['starts_in_15_min', 'new_invitation'], crm: ['handed_to_me', 'changed_on_my_task', 'crm_unread'] });
  assert.deepEqual(c.rank.prefer, []);
});

test('the file layers over the defaults, per project', () => {
  withPrefs({ projects: { 'acme/*': { weight: 0.6, interrupts: { github: ['+new_issue'] } } } }, (file) => {
    const c = cfg({ TRIAGE_PREFS: file });
    const i = c.slack.interrupts;
    assert.equal(i.allows('github', 'new_issue', 'acme/site').allow, true);
    assert.equal(i.allows('github', 'new_issue', 'other/repo').allow, false);
    // The ordering half of the same entry: one project block says where it
    // sits in the list as well as what it may interrupt on, through the
    // stated preferences lib/rank.js already reads.
    assert.deepEqual(c.rank.prefer, [{ field: 'repo', value: 'acme/*', weight: 0.6 }]);
    assert.equal(c.prefsFile, file);
  });
});

test('TRIAGE_INTERRUPT and TRIAGE_RANK_PREFER win over the file, for the same key', () => {
  withPrefs({ interrupts: { github: ['+new_issue'] }, projects: { 'o/r': { weight: 0.9 }, 'o/other': { weight: 0.2 } } }, (file) => {
    const c = cfg({ TRIAGE_PREFS: file, TRIAGE_INTERRUPT: '-github:*', TRIAGE_RANK_PREFER: 'repo:o/r=-0.5' });
    assert.equal(c.slack.interrupts.allows('github', 'new_issue', 'o/r').allow, false);
    // The env replaces the file's entry for o/r and leaves o/other alone.
    assert.deepEqual(c.rank.prefer, [{ field: 'repo', value: 'o/other', weight: 0.2 }, { field: 'repo', value: 'o/r', weight: -0.5 }]);
  });
});

test('a malformed preferences file throws at boot rather than reading as "none"', () => {
  // The failure this prevents is the one this whole section exists because
  // of: finding out by not being interrupted.
  withPrefs('{ "interrupts": ', (file) => assert.throws(() => cfg({ TRIAGE_PREFS: file }), /not valid JSON/));
  withPrefs({ projects: { 'o/r': 'off' } }, (file) => assert.throws(() => cfg({ TRIAGE_PREFS: file }), /must be an object/));
  withPrefs({ projects: { 'o/r': { weight: 'lots' } } }, (file) => assert.throws(() => cfg({ TRIAGE_PREFS: file }), /must be a number/));
  assert.equal(loadPrefs('/nonexistent/preferences.json'), null);
});

test('the mention is what makes a webhook notify, and it is one env line', () => {
  assert.equal(parseMention('U123'), '<@U123>');
  assert.equal(parseMention(undefined), null);
  assert.equal(parseMention(''), null);
  assert.equal(parseMention('off'), null);
  assert.equal(parseMention('!here'), '<!here>');
  assert.equal(parseMention('<!subteam^S1>'), '<!subteam^S1>');
  assert.equal(cfg({ TRIAGE_MENTION: 'U9' }).slack.mention, '<@U9>');
  assert.equal(cfg({ TRIAGE_MENTION: 'off' }).slack.mention, null);
});

test('the mention does not borrow SLACK_USER_ID from the app path', () => {
  // The production .env lists SLACK_BOT_TOKEN / SLACK_APP_TOKEN /
  // SLACK_USER_ID under "deliberately absent — the app path, superseded by
  // the webhook". Reading one of them here would make that comment quietly
  // false and re-couple webhook configuration to an app nobody is running.
  assert.equal(cfg({ SLACK_USER_ID: 'U9', TRIAGE_SLACK: 'webhook' }).slack.mention, null);
  assert.equal(cfg({ SLACK_USER_ID: 'U9', TRIAGE_MENTION: 'U9' }).slack.mention, '<@U9>');
  // SLACK_USER_ID keeps its own job untouched: it is who the app path DMs.
  assert.equal(cfg({ SLACK_USER_ID: 'U9' }).slack.userId, 'U9');
});

test('only a missing preferences file is "no preferences"', () => {
  // A directory, a bad mode or a full disk reading as absent is the same
  // silent failure wearing a different coat: the box comes up on the
  // defaults and nothing says your configuration was never loaded.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-prefs-'));
  try {
    assert.throws(() => cfg({ TRIAGE_PREFS: dir }), /could not be read/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(loadPrefs('/nonexistent/nowhere/preferences.json'), null);
});

test('a container that is not an object is refused, not coerced', () => {
  // `"interrupts": null` destructures straight past its default and would
  // quietly mean "nothing stated"; an array would name its sources 0, 1, 2.
  withPrefs({ interrupts: null }, (file) => assert.throws(() => cfg({ TRIAGE_PREFS: file }), /interrupts must be an object/));
  withPrefs({ interrupts: ['github'] }, (file) => assert.throws(() => cfg({ TRIAGE_PREFS: file }), /interrupts must be an object/));
  withPrefs({ projects: null }, (file) => assert.throws(() => cfg({ TRIAGE_PREFS: file }), /projects must be an object/));
  withPrefs({ projects: [] }, (file) => assert.throws(() => cfg({ TRIAGE_PREFS: file }), /projects must be an object/));
});

test('a project weight keeps the precision it was written with', () => {
  // An earlier attempt at this rounded through toFixed(4), which turned
  // 1e-7 into a neutral 0 — quieter than dropping it and no more honest.
  withPrefs({ projects: { 'o/small': { weight: 1e-7 }, 'o/precise': { weight: 0.12345 } } }, (file) => {
    const p = cfg({ TRIAGE_PREFS: file }).rank.prefer;
    assert.equal(p.find((x) => x.value === 'o/small').weight, 1e-7);
    assert.equal(p.find((x) => x.value === 'o/precise').weight, 0.12345);
  });
});

test('a mention that Slack would not notify on is refused at boot', () => {
  // TRIAGE_MENTION=alice would put the literal word at the head of every
  // interrupt and ping nobody — this change's own bug, respelled.
  assert.throws(() => parseMention('alice'), /not something Slack notifies on/);
  assert.throws(() => parseMention('<#C123>'), /not something Slack notifies on/, 'a channel link is not a person');
  assert.throws(() => cfg({ TRIAGE_MENTION: 'me@example.com' }), /TRIAGE_MENTION/);
  assert.equal(parseMention('S042'), '<!subteam^S042>');
  assert.equal(parseMention('<!subteam^S042>'), '<!subteam^S042>');
  assert.equal(parseMention('<@u9>'), '<@U9>');
  assert.equal(parseMention('!CHANNEL'), '<!channel>');
});
