// A HaApi stand-in, the shape test/fake-calendar.js and test/fake-github.js
// set: routes to fixtures, counts calls, and can be told to fail.
//
// Home Assistant is modelled as lists of to-do items, so the fake answers
// both halves for real — `todo.get_items` reads whatever is there *now*,
// and `todo.update_item` actually changes it, which is what makes the one
// write and the reconcile that follows it testable without a Home
// Assistant. `api.lists` is the world: mutate it between polls and the
// source sees exactly what a person on a wall tablet would have done.
import { HaApi } from '../lib/ha-api.js';

/** A `todo.get_items` item. Home Assistant omits a field rather than
 *  sending null, so this does too — that is the shape the source parses. */
export function todo({ uid, summary, status = 'needs_action', due = null, description = null }) {
  return { uid, summary, status, ...(due ? { due } : {}), ...(description ? { description } : {}) };
}

/** `fail` is one of: `'auth'` (401 on everything), `{ list: 'todo.x' }` (that
 *  one list is unreachable, the others answer), or `'write'` (the read works
 *  and `update_item` is refused). */
export function fakeHa(lists = {}, { url = 'http://ha.test:8123', token = 'llat', fail = null } = {}) {
  const calls = [];
  const api = new HaApi({ url, token, fetch: (u, init) => call(u, init) });
  api.calls = calls;
  api.lists = lists;
  api.fail = fail;

  async function call(u, { method = 'POST', headers = {}, body } = {}) {
    const url_ = new URL(u);
    const data = JSON.parse(body || '{}');
    const entity = data.entity_id;
    calls.push(`${method} ${url_.pathname}${url_.search} ${entity || ''}`.trim());
    if (headers.authorization !== `Bearer ${token}` || api.fail === 'auth') return json(401, { message: '401: Unauthorized' });
    const list = api.lists[entity];
    if (api.fail?.list === entity || list === undefined) return json(400, { message: `Entity ${entity} does not exist` });

    if (url_.pathname === '/api/services/todo/get_items') {
      if (url_.searchParams.get('return_response') !== 'true') return json(400, { message: 'Service call requires responses but caller did not ask for responses' });
      const want = data.status ? [].concat(data.status) : null;
      const items = list.filter((i) => !want || want.includes(i.status));
      return json(200, { changed_states: [], service_response: { [entity]: { items } } });
    }
    if (url_.pathname === '/api/services/todo/update_item') {
      if (api.fail === 'write') return json(500, { message: 'Error handling the service call' });
      const found = list.find((i) => i.uid === data.item || i.summary === data.item);
      if (!found) return json(400, { message: `Unable to find to-do list item: ${data.item}` });
      if (data.status) found.status = data.status;
      if (data.rename) found.summary = data.rename;
      return json(200, []);
    }
    return json(404, { message: 'Not found' });
  }
  return api;
}

const json = (status, body) => ({ status, ok: status < 400, statusText: String(status), headers: new Headers(), text: async () => JSON.stringify(body) });

const ymd = (d) => d.toLocaleDateString('en-CA');   // the local day, as Home Assistant writes a date-only due
/** `n` days from `t`, by the *calendar* and not by 24-hour blocks: a local
 *  day is 23 or 25 hours twice a year, and on those two days adding
 *  86,400,000 ms repeats a date or skips one. */
const days = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return ymd(d); };

/** Two lists shaped like a household's, relative to `now` — what
 *  `TRIAGE_HA=fake` runs a worktree against so the whole flow (the poll,
 *  every rule, reconcile, Done ticking an item off) can be seen with no
 *  Home Assistant and no route to one. Obviously fake: every summary says
 *  so.
 *
 *  One of each thing the rules exist to separate: something overdue,
 *  something due today, an undated item in your own inbox, two undated
 *  shared chores, and one already ticked off — which is an item that must
 *  never appear. */
export function demoHa({ now = () => new Date() } = {}) {
  const t = now().getTime();
  const day = (n) => days(t, n);
  return fakeHa({
    'todo.alice_inbox': [
      todo({ uid: 'demo-overdue', summary: '(fake) Renew the passport', due: day(-3) }),
      todo({ uid: 'demo-inbox', summary: '(fake) Decide on the bike rack', description: 'roof or hitch' }),
    ],
    'todo.household': [
      todo({ uid: 'demo-today', summary: '(fake) Put the bins out', due: day(0) }),
      todo({ uid: 'demo-chore', summary: '(fake) Rake the leaves' }),
      todo({ uid: 'demo-soon', summary: '(fake) Book the car service', due: day(9) }),
      todo({ uid: 'demo-done', summary: '(fake) Flip the laundry', status: 'completed' }),
    ],
  });
}
