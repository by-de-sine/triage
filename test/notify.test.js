// The webhook half of delivery (plan §16, G2): the client, the three
// shapes, the mention grammar per endpoint, and the delivery posting each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { SlackDelivery } from '../deliver/slack.js';
import { webhookClient, webhookHost, inferMode, parseMention, isLoopback } from '../deliver/notify.js';
import { slackMessage, discordMessage, genericMessage, discordAllowedMentions, parts, plainText } from '../deliver/messages.js';
import { p0Message } from '../deliver/blocks.js';
import { fakeWebhook } from './fake-webhook.js';

const item = { id: 1, source: 'github', key: 'o/r#1', kind: 'pull', title: 'Fix <the> thing', url: 'https://github.com/o/r/pull/1', repo: 'o/r', tier: 'P0', state: 'open', data: { number: 1 } };
const decision = { id: 5, rule: 'direct_mention', tier: 'P0', reason: 'bob mentioned you' };
const event = { id: 1, kind: 'comment', actor: 'bob', ts: '2026-09-08T12:00:00Z', body: 'hey @alice\n\nlook at this', url: 'https://github.com/o/r/pull/1#c' };
const meeting = { id: 2, source: 'calendar', key: 'e1', kind: 'event', title: 'Design review', url: 'https://cal/e1', tier: 'P0', state: 'open', data: { start: '2026-09-08T12:12:00Z', location: 'Room 2', join: 'https://meet/x', attendees: [{ name: 'Alice', self: true }, { name: 'Bob Lee' }, { name: 'carol@example.com' }, { name: 'D' }, { name: 'E' }] } };

test('the slack shape is blocks.js without the act buttons — the webhook and the app cannot drift apart', () => {
  const s = slackMessage({ item, decision, event, mention: '<@U1>' });
  assert.deepEqual(s, p0Message({ item, decision, event, interactive: false, mention: '<@U1>' }));
  assert.ok(s.text.startsWith('<@U1> Fix <the> thing — o/r — bob mentioned you: hey @alice look at this'));
  assert.equal(s.blocks.find((b) => b.type === 'actions'), undefined);
});

test('the discord shape: markdown, a mention up front, links wrapped so nothing unfurls', () => {
  const d = discordMessage({ item, decision, event, mention: '<@123>' });
  assert.equal(d.content, '<@123> **Fix <the> thing** — bob mentioned you\no/r\n> hey @alice look at this\n[Open](<https://github.com/o/r/pull/1#c>)');
  assert.deepEqual(d.allowed_mentions, { parse: [], users: ['123'] });
  const m = discordMessage({ item: meeting, decision: { reason: 'starts in 12 min' }, event: null });
  assert.match(m.content, /^\*\*Design review\*\* — starts in 12 min\n<t:\d+:f> · Room 2 · with Bob Lee, carol, D and 1 more\n\[Join\]\(<https:\/\/meet\/x>\) · \[Open\]\(<https:\/\/cal\/e1>\)$/);
});

test('the generic shape: the text and the structure both, the body cut to a line', () => {
  const g = genericMessage({ item, decision, event: { ...event, body: 'x'.repeat(700) }, mention: 'on-call' });
  assert.equal(g.mention, 'on-call');
  assert.ok(g.text.startsWith('on-call Fix <the> thing — bob mentioned you — o/r: '));
  assert.deepEqual(g.item, { id: 1, key: 'o/r#1', source: 'github', kind: 'pull', title: 'Fix <the> thing', url: 'https://github.com/o/r/pull/1', repo: 'o/r', tier: 'P0', state: 'open', data: { number: 1 } });
  assert.deepEqual(g.decision, { id: 5, rule: 'direct_mention', tier: 'P0', reason: 'bob mentioned you' });
  assert.equal(g.event.actor, 'bob');
  assert.equal(g.event.body.length, 600);
  const m = genericMessage({ item: meeting, decision: null, event: null });
  assert.equal(m.decision, null);
  assert.match(m.text, /^Design review — starts soon — Room 2 · with Bob Lee, carol, D and 1 more · 2026-09-08T12:12:00Z https:\/\/meet\/x$/);
  const p = parts({ item: meeting, decision: null, event: null });
  assert.deepEqual(p.links.map((l) => l.text), ['Join', 'Open']);
  assert.equal(plainText({ title: 't', what: 'w', where: null, when: null, quote: null, links: [], url: null }), 't — w');
});

test('discord may notify the configured mention and nobody else — not a <@id> a commenter typed', () => {
  assert.deepEqual(discordAllowedMentions(null), { parse: [] });
  assert.deepEqual(discordAllowedMentions('<@42>'), { parse: [], users: ['42'] });
  assert.deepEqual(discordAllowedMentions('<@&7>'), { parse: [], roles: ['7'] });
  assert.deepEqual(discordAllowedMentions('@here'), { parse: ['everyone'] });
  assert.deepEqual(discordAllowedMentions('@everyone'), { parse: ['everyone'] });
  const quoted = discordMessage({ item, decision, event: { ...event, body: 'ping <@999> and <@&5> and @everyone' } });
  assert.ok(quoted.content.includes('<@999>'), 'the quote is what was written');
  assert.deepEqual(quoted.allowed_mentions, { parse: [] }, 'and it notifies nobody');
  const role = discordMessage({ item, decision, event, mention: '<@&7>' });
  assert.ok(role.content.startsWith('<@&7> '));
  assert.deepEqual(role.allowed_mentions, { parse: [], roles: ['7'] });
});

test('the shape is inferred from the host, and the mention is checked per endpoint', () => {
  assert.equal(inferMode('https://hooks.slack.com/services/T/B/x'), 'slack');
  assert.equal(inferMode('https://discord.com/api/webhooks/1/x'), 'discord');
  assert.equal(inferMode('https://discordapp.com/api/webhooks/1/x'), 'discord');
  assert.equal(inferMode('https://notslack.com/x'), 'generic');
  assert.equal(inferMode('https://hooks.example.com/x'), 'generic');
  assert.equal(inferMode(null), 'off');
  assert.equal(parseMention('slack', 'U0123'), '<@U0123>');
  assert.equal(parseMention('slack', '!here'), '<!here>');
  assert.equal(parseMention('slack', 'S99'), '<!subteam^S99>');
  assert.equal(parseMention('slack', 'off'), null);
  assert.throws(() => parseMention('slack', 'alice'), /not something Slack notifies on/);
  assert.equal(parseMention('discord', '12345'), '<@12345>');
  assert.equal(parseMention('discord', '<@&77>'), '<@&77>');
  assert.equal(parseMention('discord', 'here'), '@here');
  assert.equal(parseMention('discord', '@everyone'), '@everyone');
  assert.throws(() => parseMention('discord', 'alice'), /Discord/);
  assert.equal(parseMention('generic', 'anyone at all'), 'anyone at all');
  assert.equal(parseMention('generic', ''), null);
});

test('the client: the payload on the wire, no message id back, the host and never the path', async () => {
  const hook = fakeWebhook();
  const c = webhookClient(hook.url, { fetch: hook.fetch });
  const r = await c.post({ text: 'hi' });
  assert.deepEqual(r, { ok: true, id: null });
  assert.equal(hook.requests[0].url, hook.url);
  assert.equal(hook.requests[0].init.method, 'POST');
  assert.equal(hook.requests[0].init.headers['content-type'], 'application/json');
  assert.equal(hook.requests[0].init.redirect, 'error', 'a redirect would carry the body elsewhere');
  assert.deepEqual(hook.posts[0], { text: 'hi' });
  const dc = fakeWebhook({ url: 'https://discord.com/api/webhooks/1/abc', body: '{"id":"9"}' });
  const confirmed = webhookClient(dc.url, { fetch: dc.fetch, confirm: true });
  assert.deepEqual(await confirmed.post({ content: 'x' }), { ok: true, id: null });
  assert.equal(dc.requests[0].url, 'https://discord.com/api/webhooks/1/abc?wait=true', 'Discord is asked to answer once the message is saved');
  const redirected = fakeWebhook({ status: 307, body: '' });
  await assert.rejects(webhookClient(redirected.url, { fetch: redirected.fetch }).post({}), /HTTP 307/);
  assert.equal(c.host, 'hooks.slack.com');
  assert.equal(webhookHost('https://hooks.slack.com/services/T1/B1/secret'), 'hooks.slack.com');
  assert.equal(webhookHost('not a url'), 'invalid url');
});

test('the client: https only off loopback, refused at construction; a known reason repeated, an unknown body counted, the URL never quoted', async () => {
  assert.throws(() => webhookClient('http://hooks.example.com/x'), /must be https for hooks\.example\.com/);
  assert.throws(() => webhookClient('ftp://x/y'), /must be http\(s\)/);
  assert.throws(() => webhookClient('nonsense'), /TRIAGE_WEBHOOK_URL is not a URL/);
  assert.throws(() => webhookClient(''), /no URL/);
  assert.ok(isLoopback('http://127.0.0.1:9/hook'));
  assert.ok(isLoopback('http://[::1]:9/hook'));
  assert.ok(isLoopback('http://localhost/hook'));
  assert.ok(!isLoopback('http://127.0.0.1.example.com/hook'));
  assert.equal(webhookClient('http://127.0.0.1:9/hook', { fetch: fakeWebhook().fetch }).host, '127.0.0.1:9');
  const bad = fakeWebhook({ status: 404, body: 'channel_is_archived' });
  await assert.rejects(webhookClient(bad.url, { fetch: bad.fetch }).post({}), (e) => /HTTP 404 — channel_is_archived/.test(e.message) && !e.message.includes('B0FAKE'));
  const odd = fakeWebhook({ status: 500, body: '<html>the secret is B0FAKE</html>' });
  await assert.rejects(webhookClient(odd.url, { fetch: odd.fetch }).post({}), (e) => /HTTP 500 — \d+ bytes not recognised as a known reason/.test(e.message) && !e.message.includes('B0FAKE'));
});

test('the client: a post carries a deadline, so a stalled endpoint rejects rather than stalling the poll', async () => {
  let signal = null;
  const stalled = (url, init) => { signal = init.signal; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); };
  const c = webhookClient('https://hooks.slack.com/services/T/B/x', { fetch: stalled, timeoutMs: 20 });
  await assert.rejects(c.post({}), /timeout|abort/i);
  assert.ok(signal instanceof AbortSignal);
});

/** A delivery on one webhook, with its clock. */
const setup = ({ notify, url = 'https://hooks.example.com/triage', mention = null } = {}) => {
  const store = new Store();
  const { item: it } = store.upsertItem({ user: 'alice', source: 'github', key: 'o/r#1', kind: 'pull', title: 'Fix it', url: 'https://github.com/o/r/pull/1', repo: 'o/r', last_activity: '2026-09-08T12:00:00Z' });
  const hook = fakeWebhook({ url });
  const d = new SlackDelivery(store, { mode: 'webhook', notify, webhookUrl: hook.url, mention, client: webhookClient(hook.url, { fetch: hook.fetch, confirm: notify === 'discord' }), tz: 'UTC', now: () => new Date('2026-09-08T12:05:00Z') });
  return { store, item: it, hook, d };
};

test('delivery posts the shape TRIAGE_NOTIFY names, and says so on the decision row and in describe()', async () => {
  const g = setup({ notify: 'generic', mention: 'on-call' });
  const r = await g.d.deliver({ item: g.item, decision, event });
  assert.equal(r.note, 'sent webhook');
  assert.equal(g.hook.posts[0].item.key, 'o/r#1');
  assert.equal(g.hook.posts[0].decision.rule, 'direct_mention');
  assert.equal(g.hook.posts[0].mention, 'on-call');
  assert.deepEqual([g.d.describe().notify, g.d.describe().webhook, g.d.describe().channel, g.d.describe().mention], ['generic', 'hooks.example.com', 'webhook', 'on-call']);
  assert.equal(JSON.stringify(g.d.describe()).includes('/triage'), false, 'the path is the secret half');
  const dc = setup({ notify: 'discord', url: 'https://discord.com/api/webhooks/1/abc', mention: '<@42>' });
  await dc.d.deliver({ item: dc.item, decision, event });
  assert.ok(dc.hook.posts[0].content.startsWith('<@42> **Fix it** — bob mentioned you\no/r'));
  assert.equal(Object.keys(dc.hook.posts[0]).join(), 'content,allowed_mentions');
  const sl = setup({ notify: undefined, url: 'https://hooks.slack.com/services/T/B/x' });
  await sl.d.deliver({ item: sl.item, decision, event });
  assert.ok(Array.isArray(sl.hook.posts[0].blocks), 'unset is slack, which is what every webhook before G2 was');
  assert.equal(sl.d.notify, 'slack');
  assert.throws(() => new SlackDelivery(new Store(), { mode: 'webhook', notify: 'teams', webhookUrl: 'https://x/y' }), /TRIAGE_NOTIFY must be/);
  // off is off, a URL or not: no shape is substituted for it.
  const off = setup({ notify: 'off', url: 'https://hooks.slack.com/services/T/B/x' });
  assert.equal(off.d.enabled, false);
  assert.equal((await off.d.deliver({ item: off.item, decision, event })).note, 'not delivered: the webhook is off (TRIAGE_NOTIFY=off)');
  assert.equal(off.hook.posts.length, 0);
  assert.equal(dc.d.describe().webhook, 'discord.com');
  assert.match(dc.hook.requests[0].url, /\?wait=true$/, 'a discord delivery asks for confirmation');
});

test('the app half is untouched by the shape: app mode draws the interactive message and ignores notify', () => {
  const store = new Store();
  const d = new SlackDelivery(store, { userId: 'U1', notify: 'discord', client: { chat: {} } });
  assert.equal(d.mode, 'app');
  assert.equal(d.describe().notify, null);
  const m = d.message({ item, decision, event });
  assert.ok(m.blocks.some((b) => b.type === 'actions'), 'the six buttons are there');
  assert.ok(!m.text.includes('<@'));
});
