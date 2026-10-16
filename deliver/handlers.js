// handlers.js — what the Slack app does when you touch it. Registered on a
// Bolt app (Socket Mode), or on anything with the same three methods, which
// is how the tests drive it. Every button and menu choice goes through the
// same act() the HTTP endpoint calls; the message or Home view it came from
// is updated in place afterwards.
//
// One user. Anyone else in the workspace who opens the app or runs /triage
// is told whose queue it is and nothing more.
import { lists as buildLists } from '../lib/lists.js';
import { parseAction, listBlocks, p0Message, actedLine, sinceLine } from './blocks.js';

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
  // the user a warning triangle. Open, and a meeting's Join (`link:join`).
  app.action(/^(open$|link:)/, async ({ ack }) => { await ack(); });

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
        await client.chat.update({ channel: body.channel.id, ts: body.message.ts, ...itemMessage(store, r.item, row?.decision_id) });
      }
    }
  });

  // `/triage`, or any `/triage-…`: a second app made from the same manifest
  // for development (CONTRIBUTING.md) cannot also own `/triage`, and this
  // way it needs no setting to say what it renamed it to.
  app.command(/^\/triage(-[\w-]+)?$/, async ({ ack, command }) => {
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

  /** Draw the Home tab for one person. Called on `app_home_opened`, after a
   *  menu press on it, and by delivery whenever the lists change (G5), so
   *  the tab is current before it is opened rather than redrawn on it. */
  async function publishHome(client, forUser = userId) {
    const view = mine(forUser)
      ? { type: 'home', blocks: listBlocks(lists(HOME), { menus: true, title: 'triage — your queue', cap: 100 }).blocks }
      : { type: 'home', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: notYours } }] };
    await client.views.publish({ user_id: forUser, view });
  }

  return { publishHome };
}

/** The DM for an item, drawn from where the item stands now (G5). Every
 *  redraw comes through here — a press, and the moves nobody pressed for:
 *  the source resolved it, the snooze ended, new activity reopened it, a
 *  newer verdict landed — so the message cannot say one thing after a press
 *  and another after a poll.
 *
 *  The words are the decision the DM was sent for (`decisionId`), not the
 *  newest one: a P1 that landed since must not rewrite a P0's. A newer
 *  verdict is a `since:` line beneath them instead. The state decides the
 *  rest: done, snoozed, later or muted is the line saying so and no
 *  buttons; open has the buttons, and a line for a wake or a reopen that
 *  happened after the DM's own decision. Your own reopen puts the buttons
 *  back and says nothing more. */
export function itemMessage(store, item, decisionId = null) {
  const decisions = store.decisionsFor(item.id);
  const decision = decisions.find((d) => d.id === decisionId) || decisions.findLast((d) => d.tier === 'P0') || decisions.at(-1) || null;
  const events = store.events(item.id);
  const event = events.filter((e) => decision?.event_ids.includes(e.id)).at(-1) || events.at(-1) || null;
  const last = store.actionsFor(item.id).at(-1) || null;
  if (item.state !== 'open') {
    // A stored item that was never acted on is open, so a closed one has an
    // action row; the fallback keeps a hand-edited store from throwing.
    const a = last || { action: item.state, data: {} };
    const action = a.action === 'snooze' || a.action === 'later' || a.action === 'mute' || a.action === 'done' || a.action === 'answer' || a.action === 'resolved' ? a.action : { snoozed: 'snooze', muted: 'mute' }[item.state] || item.state;
    return p0Message({ item, decision, event, acted: { action, until: item.state_until, marked: a.data?.marked, reason: a.data?.reason, choice: a.data?.choice ? `${a.data.choice}) ${a.data.label || ''}`.trim() : null, at: a.ts || null } });
  }
  const status = [];
  if (last && (last.action === 'wake' || last.action === 'reopen') && (!decision || last.ts >= decision.ts)) status.push(actedLine({ action: last.action, reason: last.data?.reason, at: last.ts }));
  const newer = decisions.findLast((d) => d.by !== 'wake');
  if (decision && newer && newer.id > decision.id) status.push(sinceLine(newer));
  return p0Message({ item, decision, event, status });
}
