// blocks.js — every Slack surface, as pure functions of store data. The
// interrupt's DM with its six buttons, the same DM once acted on, the same
// again with no buttons at all (`interactive: false` — the webhook, which
// can deliver no press), and the list (for /triage and the Home tab). No
// client, no store, no clock but the one passed in; the tests read these
// directly.
import { oneLine } from '../lib/util.js';

export const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const link = (i) => (i.url ? `<${i.url}|${esc(i.title)}>` : esc(i.title));   // a ledger row has no URL
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
/** Slack renders the time in the reader's zone; the fallback is ISO. */
export const when = (iso) => (iso ? `<!date^${unix(iso)}^{date_short_pretty} at {time}|${iso}>` : '');
const plain = (text) => ({ type: 'plain_text', text, emoji: true });
const mrkdwn = (text) => ({ type: 'mrkdwn', text });
const section = (text) => ({ type: 'section', text: mrkdwn(text) });
const context = (text) => ({ type: 'context', elements: [mrkdwn(text)] });
const header = (text) => ({ type: 'header', text: plain(text) });

/** The six buttons. Open is a link; the rest carry the item id and go
 *  through the same act() the HTTP endpoint calls. `links` prepends further
 *  link buttons — a calendar item's Join, and nothing else so far. */
export const BUTTONS = [
  ['done', 'Done', 'primary'], ['snooze:1h', 'Snooze 1h'], ['snooze:1d', 'Snooze 1d'], ['later', 'Later'], ['mute', 'Mute thread'],
];
export function buttons(item, openUrl = item.url, links = []) {
  const els = [];
  for (const l of links) els.push({ type: 'button', text: plain(l.text), url: l.url, action_id: l.action_id || `link:${l.text.toLowerCase()}` });
  els.push({ type: 'button', text: plain('Open'), url: openUrl, action_id: 'open' });
  for (const [id, label, style] of BUTTONS) els.push({ type: 'button', text: plain(label), action_id: `act:${id}`, value: String(item.id), ...(style ? { style } : {}) });
  return { type: 'actions', block_id: `act-${item.id}`, elements: els };
}

/** What a press means, from the payload Slack sends: `act:snooze:1h` with
 *  value `12`, or an overflow choice whose value is `snooze:1h:12`. */
export function parseAction(action) {
  const raw = action.type === 'overflow' ? action.selected_option?.value : `${action.action_id}:${action.value}`;
  const m = /^(?:act:)?(done|later|mute|open|snooze):(?:(\d+[mhd]):)?(\d+)$/.exec(raw || '');
  if (!m) return null;
  return { name: m[1], until: m[2] || null, id: parseInt(m[3], 10) };
}

/** One line under the title: what happened to it, by whose hand. `marked` is
 *  what Done did outside triage — the GitHub thread read, or, for a source
 *  triage only reads, the sentence saying it did nothing there. */
export function actedLine({ action, until, marked, reason, choice, at }) {
  const t = at ? ` · ${when(at)}` : '';
  switch (action) {
    case 'done': return `✓ done${marked === 'marked read' ? ' · thread marked read on GitHub' : marked ? ' · ' + esc(marked) : ''}${t}`;
    case 'answer': return `✓ answered${choice ? ' ' + esc(choice) : ''}${t}`;
    case 'resolved': return `✓ resolved at its source${reason ? ' — ' + esc(reason) : ''}${t}`;
    case 'snooze': return `⏰ snoozed until ${when(until)}${t}`;
    case 'later': return `↓ later — sinks without a date${t}`;
    case 'mute': return `🔇 muted — tiered and logged, never sent${t}`;
    case 'open': return `↺ reopened${t}`;
    case 'wake': return `⏰ snooze ended${t}`;
    case 'reopen': return `↺ reopened ${reason ? '— ' + esc(reason) : 'by new activity'}${t}`;
    default: return `${esc(action)}${t}`;
  }
}

/** The links a message keeps when it carries no buttons: a meeting's Join,
 *  then Open, as plain Markdown. `acted` appends what you did. This is the
 *  one line that replaces the button row — an acted message has nothing left
 *  to press, and under `TRIAGE_SLACK=webhook` nothing was ever pressable. */
function linkLine(links, acted = null) {
  const text = links.map(({ text: t, url }) => `<${url}|${esc(t)}>`).join(' · ');
  return context(acted ? `${text} · ${actedLine(acted)}` : text);
}

/** The P0 DM. With `acted` the buttons give way to a line saying what you did.
 *
 *  **`interactive` is what a webhook cannot do.** An incoming webhook
 *  delivers no interaction callbacks and `TRIAGE_SLACK=webhook` registers no
 *  handlers, so the five act buttons render and do nothing when pressed
 *  (plan §11.6: acting happens on the page). `interactive: false` drops
 *  them for the same link line the `acted` branch already emits. The URL
 *  buttons are not interaction and survive: a meeting keeps Join *and*
 *  Open, exactly the two the button row led with. It defaults to true, so
 *  the `app` path is untouched.
 *
 *  **`item.kind` decides the shape, never `item.source`.** A thread and a
 *  meeting want different second lines — one has a repo and a quoted comment,
 *  the other a time, a place, who is coming and a Join link — but delivery
 *  knows nothing about where either came from, and a third source that emits
 *  something thread-shaped gets the thread shape for free.
 *
 *  **`mention` is what makes it a notification** (plan §14.1). An incoming
 *  webhook posts an ordinary channel message, and Slack's default
 *  preference is direct messages, mentions and keywords — so a message
 *  naming nobody is an unread badge and no push, which is how the first
 *  real P0 this system ever sent (2026-09-13, `sent webhook`, `delivered=1`)
 *  reached nobody. The DM it replaced was a notification by construction.
 *  It goes in **both** the fallback text, which is what a push shows, and
 *  the first block, which is what Slack parses for the mention itself. */
const SHAPES = { event: eventMessage };
export function p0Message({ item, decision, event, acted = null, interactive = true, mention = null, status = [] }) {
  const m = (SHAPES[item.kind] || threadMessage)({ item, decision, event, acted, interactive, mention });
  // G5: what has happened to the item since the message was written that
  // nobody pressed for — the snooze ended, new activity reopened it, a newer
  // verdict landed. Lines above the buttons, which stay: it is open again.
  if (status.length && !acted) m.blocks.splice(m.blocks.length - 1, 0, context(status.join('\n')));
  return m;
}

/** A newer verdict than the one the message was written for, as one line:
 *  the message keeps its own words (a P1 must not rewrite a P0's), and says
 *  where the item stands now beneath them. */
export const sinceLine = (d) => `since: ${d.tier ? `\`${d.tier}\` ` : ''}${esc(d.reason || d.rule)}${d.ts ? ` · ${when(d.ts)}` : ''}`;

/** `<@U123> ` before the line, or nothing at all. Never on an acted message:
 *  that one is a redraw saying what you already did, and buzzing you for it
 *  is the notification you least want. */
const cc = (mention, acted) => (mention && !acted ? `${mention} ` : '');

function threadMessage({ item, decision, event, acted, interactive = true, mention = null }) {
  const line = event?.body ? oneLine(event.body) : null;
  const what = decision?.reason || `${event?.actor || 'someone'} needs you`;
  const at = cc(mention, acted);
  const text = `${at}${item.title} — ${item.repo} — ${what}${line ? ': ' + line : ''}`;
  const blocks = [section(`${at}*${link(item)}*\n${esc(item.repo)} · ${esc(what)}`)];
  if (line) blocks.push(section(`> ${esc(line)}`));
  const open = [{ text: 'Open', url: event?.url || item.url }];
  if (acted || !interactive) blocks.push(linkLine(open, acted));
  else blocks.push(buttons(item, event?.url || item.url));
  return { text, blocks };
}

/** Who is coming, shortest first: names, not addresses, and never a list
 *  long enough to bury the time. */
export function guestLine(d = {}) {
  const others = (d.attendees || []).filter((a) => !a.self).map((a) => String(a.name || '').replace(/@.*$/, ''));
  if (!others.length) return null;
  const shown = others.slice(0, 3).join(', ');
  return others.length > 3 ? `${shown} and ${others.length - 3} more` : shown;
}

/** A meeting: title, when, where, who, and Join if there is a link. */
function eventMessage({ item, decision, event, acted, interactive = true, mention = null }) {
  const d = item.data || {};
  const what = decision?.reason || 'starts soon';
  const guests = guestLine(d);
  const at = cc(mention, acted);
  const bits = [d.start ? when(d.start) : null, d.location ? esc(d.location) : null, guests ? `with ${esc(guests)}` : null].filter(Boolean);
  const plainBits = [d.start || null, d.location || null, guests ? `with ${guests}` : null].filter(Boolean);
  const text = `${at}${item.title} — ${what}${plainBits.length ? ' — ' + plainBits.join(' · ') : ''}`;
  const blocks = [section(`${at}*${link(item)}*\n${esc(what)}`)];
  if (bits.length) blocks.push(context(bits.join(' · ')));
  // Acted keeps the one link it has always shown; a message that never had
  // buttons keeps both, because the row it replaces led with both.
  const join = d.join ? [{ text: 'Join', url: d.join }] : [];
  if (acted) blocks.push(linkLine([{ text: d.join ? 'Join' : 'Open', url: d.join || item.url }], acted));
  else if (!interactive) blocks.push(linkLine([...join, { text: 'Open', url: item.url }]));
  else blocks.push(buttons(item, item.url, join));
  return { text, blocks };
}

/** Where a list line says the item is from: a repo for a thread, the start
 *  for a meeting — an event's repo is nobody's question. */
export const whereOf = (i) => (i.kind === 'event' ? (i.start || i.data?.start ? when(i.start || i.data.start) : 'calendar') : i.kind === 'todo' ? esc(i.owner || i.data?.owner || i.source) : esc(i.repo || i.source));

/** One list line: title, where, reason; the wake time for a snoozed item. */
export function itemLine(i) {
  const why = i.reason ? ` — ${esc(i.reason)}` : '';
  const wake = i.state === 'snoozed' && i.state_until ? ` · wakes ${when(i.state_until)}` : '';
  return `${i.tier ? `\`${i.tier}\` ` : ''}${link(i)} · ${whereOf(i)}${why}${wake}`;
}

const MENU = [['done', 'Done'], ['snooze:1h', 'Snooze 1h'], ['snooze:1d', 'Snooze 1d'], ['later', 'Later'], ['mute', 'Mute thread']];
function menu(i) {
  return { type: 'overflow', action_id: 'act:menu', options: MENU.map(([v, t]) => ({ text: plain(t), value: `${v}:${i.id}` })) };
}

/** The lists as blocks: P0 open, P1 open, snoozed with wake times, Later.
 *  `menus` puts an overflow of the five actions on every line (the Home
 *  tab); the /triage answer is read-only text. `only` shows one group. */
export function listBlocks(lists, { menus = false, only = null, title = null, cap = 50 } = {}) {
  const blocks = [];
  if (title) blocks.push(header(title));
  const groups = (only ? lists.groups.filter((g) => g.key === only) : lists.groups).filter((g) => !g.page_only);
  let text = '';
  for (const g of groups) {
    blocks.push(section(`*${esc(g.label)}*${g.items.length ? '' : ' · nothing'}`));
    text += `${g.label}: ${g.items.length}${g.more ? '+' : ''}\n`;
    for (const i of g.items) blocks.push(menus ? { ...section(itemLine(i)), accessory: menu(i) } : section(itemLine(i)));
    if (g.more) blocks.push(context(`and ${g.more} more`));
  }
  const c = lists.counts || {};
  const foot = context(`open: ${c.P0 || 0} P0 · ${c.P1 || 0} P1 · ${c.P2 || 0} P2 · ${c.P3 || 0} P3 — the page has all of it`);
  // A message holds 50 blocks, a Home view 100; the footer always fits.
  if (blocks.length >= cap) blocks.splice(cap - 2, blocks.length, context(`… and more: the page shows everything`));
  blocks.push(foot);
  return { text: text.trim() || 'nothing', blocks };
}
