// The webhook client itself: what goes on the wire, what comes back, and
// the two calls that must fail clearly rather than obscurely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webhookClient, webhookHost } from '../deliver/webhook.js';
import { fakeWebhook } from './fake-webhook.js';
import { p0Message } from '../deliver/blocks.js';

const item = { id: 1, kind: 'pull', title: 'Fix <it>', url: 'https://github.com/o/r/pull/1', repo: 'o/r' };
const decision = { id: 1, rule: 'reply_to_my_comment', tier: 'P0', reason: 'ann commented after you did' };
const event = { id: 1, ts: '2026-09-08T12:00:00Z', actor: 'ann', body: 'can this be split?', url: 'https://github.com/o/r/pull/1#issuecomment-1' };

test('postMessage puts the blocks on the wire and answers with no ts', async () => {
  const hook = fakeWebhook();
  const c = webhookClient(hook.url, { fetch: hook.fetch });
  const r = await c.chat.postMessage({ channel: 'webhook', ...p0Message({ item, decision, event }), unfurl_links: false });

  assert.equal(r.ok, true);
  assert.equal(r.channel, 'webhook');
  // No message id comes back, and that is what keeps `deliveries.message_ts`
  // empty and `lastSent` silent in this mode (plan §11.6).
  assert.equal(r.ts, null);

  assert.equal(hook.requests.length, 1);
  assert.equal(hook.requests[0].url, hook.url);
  assert.equal(hook.requests[0].init.method, 'POST');
  assert.equal(hook.requests[0].init.headers['content-type'], 'application/json');
});

test('the payload is the one blocks.js already renders, minus the channel', async () => {
  const hook = fakeWebhook();
  const c = webhookClient(hook.url, { fetch: hook.fetch });
  const msg = p0Message({ item, decision, event });
  await c.chat.postMessage({ channel: 'webhook', ...msg, unfurl_links: false });

  const [sent] = hook.posts;
  // blocks.js is not forked: what a webhook receives is byte for byte what
  // chat.postMessage would have received.
  assert.deepEqual(sent.blocks, msg.blocks);
  assert.equal(sent.text, msg.text);
  assert.equal(sent.unfurl_links, false);
  // A webhook posts to the channel it was created for; Slack ignores an
  // override, so honouring one would be a lie.
  assert.equal('channel' in sent, false);
});

test('chat.update and views.publish say "not available on a webhook"', async () => {
  const hook = fakeWebhook();
  const c = webhookClient(hook.url, { fetch: hook.fetch });
  assert.throws(() => c.chat.update({ channel: 'D1', ts: '1.0' }), /not available on a webhook/);
  assert.throws(() => c.chat.update({ channel: 'D1', ts: '1.0' }), /can only post a new message/);
  assert.throws(() => c.views.publish({ user_id: 'U1', view: {} }), /not available on a webhook/);
  assert.throws(() => c.views.publish({ user_id: 'U1', view: {} }), /no Home tab/);
  // Neither reached the wire.
  assert.equal(hook.posts.length, 0);
});

test('a rejected post throws with Slack\'s reason, and never the URL', async () => {
  const hook = fakeWebhook({ status: 404, body: 'no_service' });
  const c = webhookClient(hook.url, { fetch: hook.fetch });
  await assert.rejects(() => c.chat.postMessage({ text: 'hi' }), (e) => {
    assert.match(e.message, /HTTP 404/);
    assert.match(e.message, /no_service/);
    assert.match(e.message, /hooks\.slack\.com/);
    // The URL is the credential: the host is as much as any message says.
    assert.equal(e.message.includes('B0FAKE'), false);
    assert.equal(e.message.includes(hook.url), false);
    return true;
  });
});

test('a URL that is not one is refused at construction, not at the first send', () => {
  assert.throws(() => webhookClient('not a url'), /is not a URL/);
  assert.throws(() => webhookClient('ftp://hooks.slack.com/x'), /must be http\(s\)/);
  assert.throws(() => webhookClient(null), /no URL/);
});

test('webhookHost is the host and nothing else', () => {
  assert.equal(webhookHost('https://hooks.slack.com/services/T1/B2/secret'), 'hooks.slack.com');
  assert.equal(webhookHost('http://127.0.0.1:9999/hook'), '127.0.0.1:9999');
  assert.equal(webhookHost('nonsense'), 'invalid url');
});

// ---- what a review found (CodeRabbit on #9) --------------------------------

test('plain http is for a local listener only; anything else must be https', () => {
  // A worktree proves delivery against a listener it starts itself
  // (AGENTS.md), and that is the whole reason http is allowed at all.
  for (const ok of ['http://127.0.0.1:3401/hook', 'http://localhost:9999/x', 'http://127.1.2.3/x', 'http://[::1]:8080/x']) {
    assert.doesNotThrow(() => webhookClient(ok), `should accept ${ok}`);
  }
  // Over the wire in the clear, the URL is the credential and the payload is
  // the contents of private work.
  assert.throws(() => webhookClient('http://hooks.slack.com/services/T/B/x'), /must be https for hooks\.slack\.com/);
  assert.throws(() => webhookClient('http://192.168.1.5/hook'), /must be https for 192\.168\.1\.5/);
  assert.doesNotThrow(() => webhookClient('https://hooks.slack.com/services/T/B/x'));
});

test('a post carries a deadline, so a stalled webhook cannot stall the poll', async () => {
  const hook = fakeWebhook();
  const c = webhookClient(hook.url, { fetch: hook.fetch, timeoutMs: 5_000 });
  await c.chat.postMessage({ text: 'hi' });
  const { signal } = hook.requests[0].init;
  assert.ok(signal, 'no AbortSignal was passed to fetch');
  assert.equal(signal.aborted, false);
});

test('a stalled webhook rejects rather than hanging', async () => {
  // deliver() is awaited by the pipeline, which is awaited by the poll, so a
  // webhook that accepts the connection and never answers would stop the
  // runner; node's fetch has no deadline of its own.
  const stalled = (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  const c = webhookClient('https://hooks.slack.com/services/T/B/x', { fetch: stalled, timeoutMs: 20 });
  await assert.rejects(() => c.chat.postMessage({ text: 'hi' }), (e) => e.name === 'TimeoutError');
});

test('an unrecognised failure body is counted, not quoted', async () => {
  // The body is whatever the far end chose to send and the message reaches
  // the journal; a proxy or a misconfigured endpoint could put anything in it.
  const hook = fakeWebhook({ status: 500, body: '<html>secret=hunter2</html>\u0007' });
  const c = webhookClient(hook.url, { fetch: hook.fetch });
  await assert.rejects(() => c.chat.postMessage({ text: 'hi' }), (e) => {
    assert.match(e.message, /HTTP 500/);
    assert.match(e.message, /bytes not recognised as a Slack reason/);
    assert.equal(e.message.includes('hunter2'), false);
    assert.equal(/[\u0000-\u001f]/.test(e.message), false);
    return true;
  });
  // A reason Slack actually sends is repeated, because it is the difference
  // between a bug here and a fix on Slack's side.
  const hook2 = fakeWebhook({ status: 400, body: 'channel_is_archived' });
  const c2 = webhookClient(hook2.url, { fetch: hook2.fetch });
  await assert.rejects(() => c2.chat.postMessage({ text: 'hi' }), /channel_is_archived/);
});
