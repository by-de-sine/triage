// The two dependencies, driven for real. Every other test fakes Slack; this
// one loads `@slack/bolt` and `@slack/web-api` from `node_modules` and holds
// them to the contract `deliver/` relies on: how a failed call is shaped
// (`e.data.error` is what the logs say), what a sent message comes back
// with (`r.channel`, `r.ts` is what the delivery row records), that a
// socket-mode App builds offline and takes our handlers, and that a command
// and a button travel Bolt's own pipeline into them. It is what makes a
// Dependabot bump reviewable: a major version that moves any of this fails
// here, in CI's `install` job, before anyone reads a changelog. Without
// `node_modules` it skips — `npm test` needs no install (CONTRIBUTING.md) —
// unless TRIAGE_REQUIRE_SDK is set, which is how the `install` job says
// "and it must have run".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { registerHandlers } from '../deliver/handlers.js';

const sdk = await Promise.all([import('@slack/web-api'), import('@slack/bolt')])
  .then(([webApi, bolt]) => ({ WebClient: webApi.WebClient, App: bolt.App }))
  .catch((e) => (e.code === 'ERR_MODULE_NOT_FOUND' ? null : Promise.reject(e)));
const skip = sdk || process.env.TRIAGE_REQUIRE_SDK ? false : 'the Slack SDKs are not installed — npm ci';

/** Slack's far end: records every call, answers the few the test needs. */
async function fakeSlack() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const method = req.url.replace(/^\//, '');
      let body = {};
      try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
      calls.push({ method, body, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (method === 'auth.test') return res.end(JSON.stringify({ ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: 'T1', user: 'triage', team: 'example' }));
      if (method === 'chat.postMessage' && body.channel === 'nowhere') return res.end(JSON.stringify({ ok: false, error: 'channel_not_found' }));
      if (method === 'chat.postMessage') return res.end(JSON.stringify({ ok: true, channel: 'D1', ts: '1700000000.000100' }));
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

test('the Slack SDKs honour the contract deliver/ relies on — shapes, an offline App, our handlers through Bolt', { skip }, async () => {
  assert.ok(sdk, 'TRIAGE_REQUIRE_SDK is set and the SDKs did not load: npm ci failed to put them in place');
  const { WebClient, App } = sdk;
  const slack = await fakeSlack();
  try {
    // web-api: a sent message, and a refused one. `deliver/slack.js` records
    // `r.channel` and `r.ts` and logs `e.data?.error || e.message`.
    const client = new WebClient('xoxb-fake', { slackApiUrl: slack.url, retryConfig: { retries: 0 } });
    const sent = await client.chat.postMessage({ channel: 'D1', text: 'hi' });
    assert.equal(sent.ok, true);
    assert.equal(sent.channel, 'D1');
    assert.equal(sent.ts, '1700000000.000100');
    assert.equal(slack.calls.at(-1).auth, 'Bearer xoxb-fake', 'the token travels as a bearer header');
    const refused = await client.chat.postMessage({ channel: 'nowhere', text: 'hi' }).then(() => null, (e) => e);
    assert.ok(refused instanceof Error, 'a failed call rejects with an Error');
    assert.equal(refused.data?.error, 'channel_not_found', 'and carries the API error where the logs read it');
    for (const [group, method] of [['chat', 'postMessage'], ['chat', 'update'], ['views', 'publish']]) assert.equal(typeof client[group][method], 'function', `client.${group}.${method}`);

    // bolt: the App as `deliver/slack.js` builds it, with no network until
    // start() — which this test never calls.
    const app = new App({ token: 'xoxb-fake', appToken: 'xapp-fake', socketMode: true, logLevel: 'error', clientOptions: { slackApiUrl: slack.url, retryConfig: { retries: 0 } } });
    assert.ok(app.client instanceof WebClient, 'app.client is the WebClient deliver/ posts through');
    for (const m of ['action', 'command', 'event', 'start', 'stop']) assert.equal(typeof app[m], 'function', `app.${m}`);

    // Our handlers, registered on the real App and reached through Bolt's
    // own dispatch: a stranger's command is answered in place, a button is
    // acknowledged. Neither path touches the store, so none is wired.
    const acts = [];
    registerHandlers(app, { store: {}, act: (a) => acts.push(a), user: 'alice', userId: 'U1', log: () => {} });
    let acked = null;
    await app.processEvent({ body: { command: '/triage', user_id: 'U2', text: '', team_id: 'T1', channel_id: 'C1', trigger_id: 't', api_app_id: 'A1', response_url: `${slack.url}resp` }, ack: async (r) => { acked = r; }, retryNum: 0 });
    assert.equal(acked?.response_type, 'ephemeral');
    assert.match(acked?.text || '', /alice's queue/, "Bolt handed the command to registerHandlers' /triage");
    acked = null;
    await app.processEvent({ body: { type: 'block_actions', user: { id: 'U1' }, team: { id: 'T1' }, api_app_id: 'A1', container: { type: 'message' }, actions: [{ action_id: 'open', block_id: 'b', type: 'button', value: 'x' }], response_url: `${slack.url}resp` }, ack: async () => { acked = 'open'; }, retryNum: 0 });
    assert.equal(acked, 'open', 'the Open button is acknowledged');
    assert.deepEqual(acts, [], 'and nothing acted');
    assert.deepEqual(slack.calls.map((c) => c.method).filter((m) => !m.startsWith('chat.')), ['auth.test'], 'Bolt reached Slack once, to learn who the bot is');
  } finally {
    await slack.close();
  }
});
