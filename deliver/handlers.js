// handlers.js — what the Slack app does when you touch it. Registered on a
// Bolt app (Socket Mode), or on anything with the same three methods, which
// is how the tests drive it. Every button and menu choice goes through the
// same act() the HTTP endpoint calls; the message or Home view it came from
// is updated in place afterwards.
//
// One user. Anyone else in the workspace who opens the app or runs /triage
// is told whose queue it is and nothing more.
import { lists as buildLists } from '../lib/lists.js';
import { parseAction, listBlocks, p0Message } from './blocks.js';

export function registerHandlers(app, { store, act, user, userId, rank = null, now = () => new Date(), log = () => {} }) {
  const mine = (id) => id === userId;
  const notYours = `triage is ${user}'s queue; this install serves one person.`;
  // M5: one ordered list, so the queue's own limit is what fills the message
  // rather than four tiers' worth — and it is budgeted per group, because a
  // queue allowed to take all 50 blocks leaves snoozed and later to be
  // truncated away by `listBlocks`, and they are part of the default view.
  // The ranker goes in too: /triage, the Home tab and the page are supposed
  // to be one order, and a list built without it shows the stored rank
  // rather than the one the time term has since moved.
  const lists = (limits) => buildLists(store, { user, limits, rank, now: now() });
  const TRIAGE = { queue: 30, snoozed: 6, later: 6 };     // + 3 headings + a footer < 50
  const HOME = { queue: 70, snoozed: 12, later: 12 };     // < 100

  // A link button still sends an interaction; an unacknowledged one shows
  // the user a warning triangle.
  app.action('open', async ({ ack }) => { await ack(); });

  app.action(/^act:/, async ({ ack, body, action, client, respond }) => {
    await ack();
    // After ack, a failure has to be said out loud or the press just does
    // nothing; respond() reaches the user from a DM and from the Home tab.
    const tell = async (text) => { try { await respond?.({ response_type: 'ephemeral', text }); } catch {} };
    if (!mine(body.user?.id)) return log(`slack: ignored an action from ${body.user?.id}`);
    const a = parseAction(action);
    if (!a) { log(`slack: unreadable action ${action.action_id} ${action.value || action.selected_option?.value}`); return tell('triage could not read that action.'); }
    let r;
    try { r = await act({ id: a.id, action: a.name, until: a.until, by: 'slack' }); }
    catch (e) { log(`slack: act ${a.name} on ${a.id} failed — ${e.message}`); return tell(`${a.name} failed: ${e.message}`); }
    if (body.container?.type === 'view' || body.view?.type === 'home') {
      await publishHome(client, body.user.id);
    } else if (body.channel?.id && body.message?.ts) {
      // act() already refreshed the DM the store knows as the latest for this
      // item; the one that was pressed may be an older DM for the same item.
      const last = store.lastSent(r.item.id);
      if (!last || last.message_ts !== body.message.ts || last.channel !== body.channel.id) {
        const row = store.deliveriesFor(r.item.id).find((d) => d.message_ts === body.message.ts) || null;
        await client.chat.update({ channel: body.channel.id, ts: body.message.ts, ...actedMessage(store, r, now(), row?.decision_id) });
      }
    }
  });

  app.command('/triage', async ({ ack, command }) => {
    if (!mine(command.user_id)) return ack({ response_type: 'ephemeral', text: notYours });
    // M5: one ordered list, so `queue` is the word for all of it. `now` and
    // `soon` were the P0 and P1 groups and are kept as aliases for it — the
    // muscle memory is older than the reframe, and both meant "the top".
    const word = (command.text || '').trim().toLowerCase();
    const only = /^(queue|now|soon)$/.test(word) ? 'queue' : /^(snoozed|later)$/.test(word) ? word : null;
    await ack({ response_type: 'ephemeral', ...listBlocks(lists(only ? { [only]: 45 } : TRIAGE), { only, cap: 50 }) });
  });

  app.event('app_home_opened', async ({ event, client }) => {
    if (event.tab && event.tab !== 'home') return;
    await publishHome(client, event.user);
  });

  async function publishHome(client, forUser) {
    const view = mine(forUser)
      ? { type: 'home', blocks: listBlocks(lists(HOME), { menus: true, title: 'triage — your queue', cap: 100 }).blocks }
      : { type: 'home', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: notYours } }] };
    await client.views.publish({ user_id: forUser, view });
  }

  return { publishHome };
}

/** The DM for an item, rewritten to say what was just done to it. It is
 *  rebuilt from the decision the DM was sent for (`decisionId`), not the
 *  newest one — a P1 that landed since must not rewrite a P0's words.
 *  Reopening puts the buttons back. */
export function actedMessage(store, { item, action, until, marked }, at = new Date(), decisionId = null) {
  const decisions = store.decisionsFor(item.id);
  const decision = decisions.find((d) => d.id === decisionId) || decisions.findLast((d) => d.tier === 'P0') || decisions.at(-1) || null;
  const events = store.events(item.id);
  const event = events.filter((e) => decision?.event_ids.includes(e.id)).at(-1) || events.at(-1) || null;
  return p0Message({ item, decision, event, acted: action === 'open' ? null : { action, until, marked, at: at.toISOString() } });
}
