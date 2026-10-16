// A Slack incoming webhook stand-in: the far end of deliver/webhook.js, one
// `fetch` that records every POST and answers the way hooks.slack.com does
// — 200 and the body `ok`, or a 4xx with a one-word reason. The recorded
// `posts` are the parsed JSON bodies, which is exactly what would have
// arrived in the channel, so a test can assert on the message rather than
// on the request.
export function fakeWebhook({ url = 'https://hooks.slack.com/services/T0FAKE/B0FAKE/xxxxxxxx', status = 200, body = 'ok', fail = null } = {}) {
  const posts = [];
  const requests = [];
  const fetch = async (to, init = {}) => {
    requests.push({ url: to, init });
    let payload = null;
    try { payload = JSON.parse(init.body); } catch { /* a test may post nonsense on purpose */ }
    posts.push(payload);
    const answer = (fail && fail(payload)) || { status, body };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => answer.body,
    };
  };
  return { url, fetch, posts, requests };
}
