// ledger — a markdown queue file as a source (plan §12.3, source 1: "the agent
// channel that already exists"). Reads `OPEN_LOOPS.md` and the handoffs in
// `status/*.md` from the ledger directory and turns every row that waits on
// a human into an item — local files, no API, no credential, no network.
// Never writes: an answer given here is an `actions` row on the item, read
// back through the API by whoever asked (lib/actions.js `answer`); the row
// itself is closed by deleting it, which is the ledger's own rule.
//
// **It is state, not a feed** (plan §12.2), and that is why it is the first
// source with a `reconcile`: a row deleted by an agent or by you has no
// event to announce its absence, so the runner is handed the current set of
// keys after every poll and resolves what is no longer in it. A read that
// could not see the whole file says `complete: false` and resolves nothing.
//
// **The ask.** A row is a topic and one of three asks, which is the shape
// scripts and agents are asked to write (2026-09-12): something to
// *acknowledge*, something to *confirm or deny* — a multiple choice, the
// more of these the better — or an *action*, which is the hard one. It is
// a tag at the end of the Item cell, readable by a human and by this
// parser, and absent it defaults to `action`:
//
//   | 2026-09-20 | `human-decision` | Rename the org [confirm: yes · no · later] | why … |
//   | 2026-09-20 | `human-laptop`   | The PAT was reissued [ack] | … |
//   | 2026-09-20 | `human-sudo`     | Point Caddy at the user config [action] | … |
//
// `[confirm]` alone is yes / no. Choices are lettered A, B, C… in order.
//
// **Identity is the Item text, not the row** (§12.3): bumping a nudge date
// or rewording the context keeps the item; rewording the item — any change
// to its words, case or punctuation; emphasis and spacing do not count —
// makes a new one. The event key hashes the whole row, so any change
// re-tiers it.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export const ASKS = ['ack', 'confirm', 'action'];
export const isHuman = (owner) => /^human-/.test(String(owner || ''));
const LETTERS = 'ABCDEFGHIJ';
const sha = (s) => createHash('sha1').update(s).digest('hex');

/** The cells of one table row, split on `|` outside backticks — a row's
 *  context routinely carries `webhook|app|off`. */
export function cells(line) {
  const s = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '');
  const out = []; let cur = ''; let tick = false;
  for (const ch of s) {
    if (ch === '`') tick = !tick;
    if (ch === '|' && !tick) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** `[confirm: yes · no]` → { ask, choices }, and the text without the tag. */
export function parseAsk(text) {
  const m = /\s*\[(ack|confirm|action)(?:\s*:\s*([^\]]+))?\]\s*/i.exec(text);
  if (!m) return { ask: null, choices: null, text };
  const ask = m[1].toLowerCase();
  let choices = null;
  if (ask === 'confirm') {
    const raw = (m[2] || 'yes · no').split(/\s*[·;]\s*|\s+\/\s+/).map((c) => c.trim()).filter(Boolean).slice(0, LETTERS.length);
    choices = raw.map((label, i) => ({ key: LETTERS[i], label }));
  }
  return { ask, choices, text: (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).trim() };
}

const plain = (s) => String(s || '').replace(/\*\*|~~|`/g, '').replace(/\s+/g, ' ').trim();
/** Identity is the Item text with its markdown emphasis and whitespace
 *  removed and nothing else: case and punctuation stay, so `Ship v2.0` and
 *  `Ship v2 0` are two rows, as they are in the file. */
const norm = plain;

/** One `| nudge | owner | item | context |` row → what an item needs, or null
 *  for a line that is not a row (the header, the rule, prose). */
export function parseRow(line, n = 0) {
  if (!/^\s*\|/.test(line)) return null;
  const c = cells(line);
  if (c.length < 3 || /^:?-+:?$/.test(c[0]) || c[0].toLowerCase() === 'nudge') return null;   // the header, or a separator (alignment colons included)
  const nudge = /^\d{4}-\d{2}-\d{2}$/.test(c[0]) ? c[0] : null;
  const owner = c[1].replace(/`/g, '').trim() || 'unknown';
  const rawItem = c[2];
  const context = c.slice(3).join(' | ');
  const struck = /^\s*~~/.test(rawItem);
  const { ask, choices, text } = parseAsk(rawItem);
  const title = plain(text);
  if (!title) return null;
  const effAsk = ask || (isHuman(owner) ? 'action' : null);
  return {
    key: `row:${sha(norm(title)).slice(0, 12)}`,
    kind: 'todo', title, owner, nudge, ask: effAsk, choices, context: plain(context), struck, line: n,
    hash: sha(line.trim()).slice(0, 12),
  };
}

/** The frontmatter of one handoff → an item, when its state waits on a human. */
export function parseHandoff(name, text) {
  const fm = {};
  for (const l of text.split('\n').slice(0, 12)) { const m = /^([a-z-]+):\s*(.*)$/.exec(l); if (m) fm[m[1]] = m[2].trim(); }
  const state = (fm.state || '').split(/\s+/)[0];
  if (!['review', 'blocked'].includes(state)) return null;
  const slug = name.replace(/\.md$/, '');
  const title = `${state === 'review' ? 'review' : 'unblock'} ${slug.replace('--', '/')}: ${plain(fm.next || '').slice(0, 140) || 'no next line'}`;
  return {
    key: `handoff:${slug}`, kind: 'todo', title,
    owner: state === 'blocked' ? (fm['blocked-on'] || 'human-decision') : 'human-decision',
    nudge: /^\d{4}-\d{2}-\d{2}$/.test(fm.updated || '') ? fm.updated : null,
    ask: 'action', choices: null, context: plain(fm.next || ''), struck: false, line: 0,
    hash: sha(`${state}|${fm.next || ''}|${fm.updated || ''}`).slice(0, 12), handoff: state,
  };
}

/** Everything in the ledger directory that could be an item. Throws when the
 *  queue file cannot be read — a missing ledger is a failed poll, never an
 *  empty one. `complete` is false when any handoff could not be read: what
 *  was read is still returned, but reconcile must not treat the set as the
 *  whole set (plan §12.2). A ledger with no `status/` directory at all has
 *  no handoffs, which is complete. */
export function read({ file, statusDir }) {
  const rows = [];
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((l, i) => { const r = parseRow(l, i + 1); if (r) rows.push({ ...r, file }); });
  let handoffs = 0, complete = true, error = null;
  if (statusDir && existsSync(statusDir)) {
    let names = [];
    try { names = readdirSync(statusDir).filter((n) => n.endsWith('.md')).sort(); } catch (e) { complete = false; error = `${statusDir}: ${e.message}`; }
    for (const n of names) {
      let h = null;
      try { h = parseHandoff(n, readFileSync(path.join(statusDir, n), 'utf8')); } catch (e) { complete = false; error = error || `${n}: ${e.message}`; continue; }
      if (h) { rows.push({ ...h, file: path.join(statusDir, n) }); handoffs++; }
    }
  }
  return { rows, handoffs, complete, error };
}

export default {
  name: 'ledger',
  every: 60_000,
  describe: 'the ledger: queue rows and handoffs waiting on a human',

  /** Every row in the ledger sits until somebody acts, so the wait is the
   *  cost — the same curve as a reply waiting on you. */
  time: () => 'waiting',

  // No `project` (plan §14.3). One queue file is not several projects, and
  // inventing a key so the seam looks uniform would be a lie the scoped
  // layers then have to be configured against. Layers 1 and 2 still apply
  // to it; nothing in delivery treats its absence as a special case.

  /** Cursor: { rows: { [key]: { hash, since } }, read_at, count }. `since` is
   *  when the row was last seen to change — the file has no timestamps of
   *  its own — and is the item's last_activity unless its nudge has passed. */
  async poll({ file, statusDir, cursor, now = new Date(), log = null }) {
    const nowIso = now.toISOString();
    const prev = cursor?.rows || {};
    const { rows, handoffs, complete, error } = read({ file, statusDir });
    if (!complete) log?.(`a handoff could not be read (${error}); reconcile will not resolve on this pass`);
    const next = {};
    const batches = [];
    for (const r of rows) {
      const since = prev[r.key]?.hash === r.hash ? prev[r.key].since : nowIso;
      next[r.key] = { hash: r.hash, since };
      // The wait is the cost (the `waiting` curve), and a row past its nudge
      // has been waiting since the nudge — not since triage first read it.
      // So an overdue row's last_activity is its nudge date, and the longer
      // overdue it is the higher it sits; a row not yet due waits from when
      // it was last seen to change.
      const nudgeMs = r.nudge ? Date.parse(r.nudge) : NaN;
      const waitingSince = Number.isFinite(nudgeMs) && nudgeMs < Date.parse(since) ? new Date(nudgeMs).toISOString() : since;
      const data = { owner: r.owner, nudge: r.nudge, ask: r.ask, choices: r.choices, context: r.context, struck: r.struck, file: r.file, line: r.line, ...(r.handoff ? { handoff: r.handoff } : {}) };
      batches.push({
        item: { source: 'ledger', key: r.key, kind: 'todo', title: r.title, url: null, repo: null, actors: [r.owner], my_role: isHuman(r.owner) ? 'owner' : 'subscribed', last_activity: waitingSince, last_seen: nowIso, data },
        events: [{ key: `ledger:${r.key}:${r.hash}`, ts: since, kind: 'row', actor: r.owner, body: r.context, data: { owner: r.owner, nudge: r.nudge, ask: r.ask } }],
      });
    }
    return { batches, cursor: { rows: next, read_at: nowIso, count: rows.length, handoffs }, status: `${rows.length} rows, ${handoffs} handoffs` };
  },

  /** The current set, for the runner to resolve against (plan §12.2). A
   *  ledger that cannot be read is an incomplete set, and resolves nothing. */
  async reconcile({ file, statusDir }) {
    try { const r = read({ file, statusDir }); return { keys: r.rows.map((x) => x.key), complete: r.complete, error: r.error }; }
    catch (e) { return { keys: [], complete: false, error: e.message }; }
  },

  describeCursor(state) { return { rows: state?.count ?? 0, handoffs: state?.handoffs ?? 0, read_at: state?.read_at || null }; },
};
