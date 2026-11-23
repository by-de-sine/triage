// brief.js — what the brief (lib/brief.js) looks like as one message, in
// each shape a webhook takes and for the app's DM (plan §17.3).
//
// One message a day, and only on a day there is something to say. It is
// the interrupt path's other half: an interrupt is said once, within a
// minute, and if that minute was a bad one nothing ever says it again;
// and most of what is yours to do — a decision an agent is waiting on, a
// task past its date — never interrupts at all. The brief is where those
// are said, a few at a time, without anybody sorting a list first.
//
// The layout is the item's kind and never its source, like every other
// message here; the words are the rule's own reason.
import { esc, when } from './blocks.js';

const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const days = (n) => (n == null ? null : n < 1 ? 'today' : `${n} d`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where a line says the item is from, as plain text: a meeting's start, a
 *  queue row's owner, a thread's repository. */
const where = (i) => (i.kind === 'event' ? null : i.kind === 'todo' ? i.owner || i.source : i.repo || i.source);

/** The one-line summary every shape opens with. */
export function headline(b) {
  const c = b.counts;
  const bits = [];
  if (c.fresh) bits.push(`${c.fresh} need${c.fresh === 1 ? 's' : ''} you this week`);
  if (b.aging.length) bits.push(`${b.aging.length} slipping`);
  if (c.waiting) bits.push(`${c.waiting} still waiting`);
  if (c.yours) bits.push(`${c.yours} yours, undated`);
  return bits.join(' · ') || 'nothing needs you';
}

/** A date's parts in the reader's zone. The message is assembled from the
 *  parts and not from the formatter's own punctuation, which differs from
 *  one ICU build to the next — and a brief must read the same everywhere. */
function parts(iso, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return Object.fromEntries(f.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
}
/** When a source last read: `7 Nov 08:00`. */
const since = (iso, tz) => { if (!iso) return null; const p = parts(iso, tz); return `${p.day} ${p.month} ${p.hour}:${p.minute}`; };
/** The day a brief is for: `Tue 10 Nov`. */
const dayLabel = (iso, tz) => { const p = parts(iso, tz); return `${p.weekday} ${p.day} ${p.month}`; };

/** The brief as lines, through one markup: `m.link(title, url)`, `m.bold`,
 *  `m.quiet` and `m.text` (escaping). Slack, Discord and plain text differ
 *  in exactly those four. */
function lines(b, m, { tz = 'UTC', pageUrl = null } = {}) {
  const out = [];
  const item = (i, lead = '') => {
    const title = cut(i.title, 110);
    const bits = [i.kind === 'event' && i.start ? m.when(i.start) : where(i) ? m.text(cut(where(i), 40)) : null, days(i.days), i.new ? 'new' : null].filter(Boolean).join(' · ');
    return `• ${lead}${i.url ? m.link(title, i.join || i.url) : m.bold(m.text(title))}${i.reason ? ` — ${m.text(cut(i.reason, 140))}` : ''}${bits ? ` ${m.quiet(bits)}` : ''}`;
  };
  if (b.needs.length) {
    out.push(m.bold('Needs you'));
    for (const i of b.needs) out.push(item(i));
    if (b.more) out.push(m.quiet(`and ${b.more} more from this week`));
  }
  if (b.aging.length) {
    out.push(m.bold('Slipping'));
    for (const i of b.aging) out.push(item(i, `⏳ ${i.mark} d waiting — `));
  }
  const tail = [];
  if (b.waiting.n) tail.push(`${m.bold('Still waiting on you:')} ${b.waiting.n}${b.waiting.oldest ? ` — the oldest ${b.waiting.oldest_days} d, ${m.text(cut(b.waiting.oldest.title, 70))}` : ''}`);
  if (b.yours.n) tail.push(`${m.bold('Yours, no date:')} ${b.yours.n}${b.yours.oldest_days != null ? ` — the oldest ${b.yours.oldest_days} d` : ''}`);
  if (b.folded.length) tail.push(`${m.bold('Folded away:')} ${b.folded.map((g) => `${g.n} ${m.text(g.label)}`).join(' · ')}`);
  for (const s of b.sources) tail.push(`⚠️ ${m.bold(m.text(s.name))} ${s.since ? `has not been read since ${since(s.since, tz)}` : 'has never been read'}${s.error ? ` — ${m.text(cut(s.error, 120))}` : ''}`);
  if (pageUrl) tail.push(m.link('Open the brief', pageUrl));
  return { head: `${m.bold(`Triage · ${dayLabel(b.now, tz)}`)} — ${headline(b)}`, body: out, tail };
}

const SLACK = { link: (t, u) => `<${u}|${esc(t)}>`, bold: (s) => `*${s}*`, quiet: (s) => `_${s}_`, text: esc, when };
const DISCORD = { link: (t, u) => `[${t.replace(/[[\]]/g, '')}](<${u}>)`, bold: (s) => `**${s}**`, quiet: (s) => `_${s}_`, text: (s) => String(s || '').replace(/([*_`~|<>@])/g, '\\$1'), when: (iso) => `<t:${Math.floor(Date.parse(iso) / 1000)}:f>` };
const PLAIN = { link: (t, u) => `${t} ${u}`, bold: (s) => s, quiet: (s) => `(${s})`, text: (s) => String(s || ''), when: (iso) => iso };

const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

/** Slack's `{text, blocks}` — a webhook and `chat.postMessage` take the
 *  same payload. The mention goes on the first line, because a channel
 *  message that names nobody is an unread badge (plan §14.1). */
export function slackBrief(b, { mention = null, tz = 'UTC', pageUrl = null } = {}) {
  const l = lines(b, SLACK, { tz, pageUrl });
  const at = mention ? `${mention} ` : '';
  const blocks = [section(`${at}${l.head}`)];
  // A section holds 3,000 characters; five items and three slipping fit
  // with room, and the cut is here so a long title can never fail a post.
  if (l.body.length) blocks.push(section(l.body.join('\n').slice(0, 2900)));
  if (l.tail.length) blocks.push(context(l.tail.join('\n').slice(0, 2900)));
  return { text: `${at}Triage — ${headline(b)}`, blocks };
}

/** Discord's `{content, allowed_mentions}`; only the configured mention may
 *  notify, as on an interrupt. `allowed` is `discordAllowedMentions`'s
 *  answer for it. */
export function discordBrief(b, { mention = null, tz = 'UTC', pageUrl = null, allowed = { parse: [] } } = {}) {
  const l = lines(b, DISCORD, { tz, pageUrl });
  return { content: [`${mention ? `${mention} ` : ''}${l.head}`, ...l.body, ...l.tail].join('\n').slice(0, 1990), allowed_mentions: allowed };
}

/** Any other endpoint gets the text and the whole structure. */
export function genericBrief(b, { mention = null, tz = 'UTC', pageUrl = null } = {}) {
  const l = lines(b, PLAIN, { tz, pageUrl });
  return { text: [`${mention ? `${mention} ` : ''}${l.head}`, ...l.body, ...l.tail].join('\n'), mention, brief: b };
}

export const BRIEF_SHAPES = { slack: slackBrief, discord: discordBrief, generic: genericBrief };
