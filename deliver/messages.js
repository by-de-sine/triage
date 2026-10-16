// messages.js — what an interrupt looks like on each kind of webhook, as
// pure functions of store data (plan §16, G2). **`item.kind` decides the
// layout, never `item.source`**: a thread shows its repo and one line of
// the comment; a meeting shows when it starts, where, who is coming and a
// Join link. A source that emits something thread-shaped gets the thread
// layout for free.
//
//   slack     the incoming-webhook payload: `deliver/blocks.js`'s own
//             message without the act buttons, exactly what production has
//             sent since the interrupt path first worked — so the shape the
//             app draws and the shape the webhook posts cannot drift apart;
//   discord   one markdown message, a mention up front;
//   generic   the text and the structure both — item, decision, event —
//             so a script on the far end can do what it likes.
//
// `mention` is what makes a channel message a notification rather than an
// unread badge: Slack and Discord notify on direct messages and mentions
// by default, so an interrupt that names nobody arrives and reaches no one.
import { oneLine } from '../lib/util.js';
import { p0Message, guestLine } from './blocks.js';

/** The parts every endpoint prints, before any markup: a headline, a
 *  second line (where/when/who), an optional quote and the links. */
export function parts({ item, decision, event }) {
  const d = item.data || {};
  const what = decision?.reason || (item.kind === 'event' ? 'starts soon' : `${event?.actor || 'someone'} needs you`);
  if (item.kind === 'event') {
    const guests = guestLine(d);
    const where = [d.location || null, guests ? `with ${guests}` : null].filter(Boolean).join(' · ');
    const links = [...(d.join ? [{ text: 'Join', url: d.join }] : []), ...(item.url ? [{ text: 'Open', url: item.url }] : [])];
    return { title: item.title, what, where, when: d.start || null, quote: null, links, url: d.join || item.url || null };
  }
  const line = event?.body ? oneLine(event.body) : null;
  const url = event?.url || item.url || null;
  return { title: item.title, what, where: item.repo || item.source, when: null, quote: line, links: url ? [{ text: 'Open', url }] : [], url };
}

/** One line of plain text: the whole message for a generic endpoint's
 *  `text`, and the fallback the others carry. */
export function plainText(p, { mention = null, whenText = (iso) => iso } = {}) {
  const at = mention ? `${mention} ` : '';
  const bits = [p.where, p.when ? whenText(p.when) : null].filter(Boolean).join(' · ');
  return `${at}${p.title} — ${p.what}${bits ? ` — ${bits}` : ''}${p.quote ? `: ${p.quote}` : ''}${p.url ? ` ${p.url}` : ''}`;
}

/** Slack's `{text, blocks}`, as an incoming webhook takes it: the app's own
 *  message with no act buttons, since nothing would deliver the press. */
export function slackMessage({ item, decision, event, mention = null }) {
  return p0Message({ item, decision, event, interactive: false, mention });
}

/** Discord's `{content}`: markdown, one message, a mention up front. A
 *  link is wrapped in `<…>` so Discord does not unfurl it. */
export function discordMessage({ item, decision, event, mention = null }) {
  const p = parts({ item, decision, event });
  const when = (iso) => `<t:${Math.floor(Date.parse(iso) / 1000)}:f>`;
  const at = mention ? `${mention} ` : '';
  const bits = [p.when ? when(p.when) : null, p.where].filter(Boolean).join(' · ');
  const lines = [`${at}**${p.title}** — ${p.what}${bits ? `\n${bits}` : ''}`];
  if (p.quote) lines.push(`> ${p.quote}`);
  if (p.links.length) lines.push(p.links.map((l) => `[${l.text}](<${l.url}>)`).join(' · '));
  return { content: lines.join('\n') };
}

/** A generic JSON endpoint gets the text and the structure both. The body
 *  of the event is cut at 600 characters: a comment is private work, and
 *  a line is what an interrupt is for. */
export function genericMessage({ item, decision, event, mention = null }) {
  const p = parts({ item, decision, event });
  return {
    text: plainText(p, { mention }),
    mention,
    item: { id: item.id, key: item.key, source: item.source, kind: item.kind, title: item.title, url: item.url, repo: item.repo, tier: item.tier, state: item.state, data: item.data },
    decision: decision ? { id: decision.id, rule: decision.rule, tier: decision.tier, reason: decision.reason } : null,
    event: event ? { kind: event.kind, actor: event.actor, ts: event.ts, url: event.url, body: event.body ? oneLine(event.body, 600) : null } : null,
  };
}

export const SHAPES = { slack: slackMessage, discord: discordMessage, generic: genericMessage };
