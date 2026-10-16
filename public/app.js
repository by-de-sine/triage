// triage — the list page. Reads /api/lists and /healthz, draws the groups it
// is given in the order they come, and posts to /api/items/:id/act for the
// buttons. Read-mostly: it refreshes every minute and after an action.
//
// M5: the server decides what the groups are, because `?group=` changes
// them — one queue by default, several when the list is cut by repo, source,
// tier or kind. The page draws what it is handed rather than holding four
// hard-coded sections, which is also why it now shows *everything*: the P2s
// and P3s that were invisible were invisible because the markup had no
// section for them (plan §11.3).
//
// The page narrows as well as groups. A tile in the masthead is a tier
// filter, the tag on a row is a repo (or owner, or source) filter, and the
// find box is a word — each is a query string the server cuts the list by
// (`/api/lists?tier=&repo=&source=&owner=&q=`), so the counts stay honest and
// a P3 past the page's end is still found. The filters live in the URL and
// nowhere else: a narrowing is a question, not a preference, and a reload
// or a shared link should ask the same one. Grouping is the preference
// (localStorage), as before.
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ACTS = [['done', 'done', 'Done'], ['snooze', '1h', 'Snooze 1h'], ['snooze', '1d', 'Snooze 1d'], ['later', null, 'Later'], ['mute', null, 'Mute']];
const BLURB = { queue: 'everything open, in rank order', snoozed: 'back at their wake time', later: 'tossed to the end, no date' };
const FILTERS = ['tier', 'repo', 'source', 'owner', 'q'];
const PAGE = 200;
const group = () => { try { return new URLSearchParams(location.search).get('group') || localStorage.getItem('triage.group') || ''; } catch { return ''; } };
/** The narrowing in force, read from the URL every time so the back button
 *  and a pasted link both mean what they say. */
const narrow = () => { const p = new URLSearchParams(location.search); return Object.fromEntries(FILTERS.map((k) => [k, (p.get(k) || '').trim()]).filter(([, v]) => v)); };
/** Set (or, with null, clear) one filter; the URL is the state. Any change
 *  to the question starts the page again from the top. */
function setNarrow(key, value) {
  const u = new URL(location.href);
  if (value) u.searchParams.set(key, value); else u.searchParams.delete(key);
  history.replaceState(null, '', u);
  ask();
}
/** A new question: back to the first page, and nothing has "moved" — the
 *  copper flash is for a row that slid up under the cursor after an act,
 *  not for a list that was just cut differently. */
function ask() { limit = PAGE; placed = new Map(); load(); }

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
/** A date with no time — a ledger nudge — read as the day it names, not as
 *  midnight UTC shifted into the reader's zone. */
function day(iso) {
  const d = new Date(iso), y = d.getUTCFullYear() !== new Date().getFullYear();
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC', ...(y ? { year: 'numeric' } : {}) });
}
function at(iso) {
  const d = new Date(iso), now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

/** Where a row says it is from — the kind decides, never the source. A
 *  thread has a repo; a meeting has a start, and "which repo" is not a
 *  question anyone asks of it (M3). */
function whereOf(i) {
  // A ledger row says who it waits on, and its nudge date — red once past.
  if (i.kind === 'todo') {
    const past = i.nudge && Date.parse(i.nudge) < Date.now();
    return { text: i.owner || i.source, cls: `repo${past ? ' soon' : ''}`, title: i.nudge ? `nudge ${day(i.nudge)}${past ? ' — past' : ''}` : '' };
  }
  if (i.kind !== 'event') return { text: i.repo || i.source, cls: 'repo' };
  if (!i.start) return { text: 'calendar', cls: 'repo' };
  const ms = Date.parse(i.start) - Date.now();
  return { text: at(i.start), cls: `repo when${ms >= 0 && ms < 900_000 ? ' soon' : ''}`, title: i.location || '' };
}

/** The top term's sentence with the rule id in front of it stripped —
 *  `direct_mention — carol mentioned you` is copy for the API, not for a
 *  line. Time and preference terms have no id and pass through whole. */
function whyOf(i) {
  if (!i.why) return '';
  return i.top === 'claim' ? i.why.split(' — ').slice(1).join(' — ') || i.why : i.why;
}

function row(i) {
  const li = el('li', 'row'); li.dataset.id = i.id; li.item = i;
  li.append(el('span', `word ${i.tier || 'P3'}`, i.tier || '—'));
  const what = el('div', 'what');
  const title = el('div', 'title');
  // A ledger row has no URL: the title is text, and its context is the hover.
  const a = i.url ? el('a', null, i.title) : el('span', 'plain', i.title);
  if (i.url) { a.href = i.url; a.target = '_blank'; a.rel = 'noopener'; } else if (i.context) a.title = i.context;
  const w = whereOf(i);
  // The tag is the filter it names: a repo, a ledger owner, a source. A
  // meeting's tag is a time, and a time is not a category, so it stays text.
  const by = i.kind === 'event' ? null : i.kind === 'todo' && i.owner ? ['owner', i.owner] : i.repo ? ['repo', i.repo] : ['source', i.source];
  const where = el(by ? 'button' : 'span', w.cls, w.text);
  if (by) { where.type = 'button'; where.title = [w.title, `only ${by[1]}`].filter(Boolean).join(' · '); where.onclick = () => setNarrow(by[0], by[1]); }
  else if (w.title) where.title = w.title;
  title.append(a, where);
  const why = el('div', 'why');
  // One human sentence per row: the reason the item was last tiered, or
  // the top term's own sentence when there is no verdict on record. The
  // rule ids are not copy — they, the number and the match set are the
  // hover on the cue that follows (plan §11.7 item 2: the sentence is the
  // explanation, the number is only its order, and it stays hover-only).
  const sentence = i.reason || whyOf(i);
  if (sentence) why.append(el('span', null, sentence));
  if (i.rank != null || i.matches?.length) {
    // Hover shows it; a press pins it under the row, because a phone has
    // no hover and a tooltip cannot be read twice.
    const t = el('button', 'term', 'rank');
    t.type = 'button';
    const more = whyOf(i);
    t.title = [`rank ${i.rank == null ? '—' : i.rank.toFixed(3)}`, i.top ? `top term: ${i.top}` : '', i.matches?.length ? `rules: ${i.matches.join(', ')}` : '', more && !sentence.includes(more) ? more : ''].filter(Boolean).join(' · ');
    t.setAttribute('aria-expanded', 'false');
    t.onclick = () => { const open = what.querySelector('.detail'); if (open) { open.remove(); t.setAttribute('aria-expanded', 'false'); } else { what.append(el('div', 'detail', t.title)); t.setAttribute('aria-expanded', 'true'); } };
    why.append(t);
  }
  // A nudged ledger row has said how long it has waited in its sentence;
  // its date is the hover on the owner tag. Everything else shows its age.
  if (!(i.kind === 'todo' && i.nudge)) why.append(el('span', 'age', ago(i.last_activity)));
  if (i.state === 'snoozed' && i.state_until) why.append(el('span', `wake${Date.parse(i.state_until) <= Date.now() ? ' due' : ''}`, `wakes ${at(i.state_until)}`));
  if (i.state === 'later') why.append(el('span', 'age', 'later'));
  what.append(title, why);
  li.append(what);
  const acts = el('div', 'acts');
  // One dominant action per row, and the rest quiet — every one still one
  // press, none behind a hover or an overflow. Join for a meeting, Open for
  // anything with a page, Ack for an ack, Done for the rest.
  const primary = i.join ? 'join' : i.url ? 'open' : i.state === 'open' && i.ask === 'ack' && !i.choices?.length ? 'ack' : 'done';
  const out = (cls, text, href) => { const a = el('a', cls, text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.title = 'opens in a new tab'; return a; };
  if (i.join) { const j = out(`open join${primary === 'join' ? ' primary' : ''}`, 'Join', i.join); acts.append(j); }
  if (i.url) { const open = out(`open${primary === 'open' ? ' primary' : ''}`, 'Open', i.url); acts.append(open); }
  // The ask, as buttons: a choice each for a confirm, one Ack for an ack.
  // The answer is an action on the item, which whoever asked reads back.
  if (i.state === 'open' && i.choices?.length) {
    for (const c of i.choices) { const b = el('button', 'choice', `${c.key}) ${c.label}`); b.onclick = () => act(li, i, 'answer', null, c.key); acts.append(b); }
  } else if (i.state === 'open' && i.ask === 'ack') {
    const b = el('button', `choice${primary === 'ack' ? ' primary' : ''}`, 'Ack'); b.onclick = () => act(li, i, 'done'); acts.append(b);
  }
  for (const [action, until, label] of ACTS) {
    const b = el('button', `${action}${action === 'done' && primary === 'done' ? ' primary' : ''}`, label);
    b.onclick = () => act(li, i, action, until);
    acts.append(b);
  }
  if (i.state !== 'open') { const b = el('button', 'reopen', 'Reopen'); b.onclick = () => act(li, i, 'open'); acts.append(b); }
  li.append(acts);
  return li;
}

async function act(li, item, action, until, choice) {
  li.classList.add('busy');
  try {
    const r = await fetch(`/api/items/${item.id}/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, until, choice, by: 'web' }) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.statusText);
    // A source that triage only reads says so, and that is not a failure —
    // only a mark that was attempted and refused turns the toast red.
    const failed = /^not marked/.test(body.marked || '');
    const note = body.marked === 'marked read' ? ' — thread marked read' : body.marked ? ` — ${body.marked}` : '';
    const what = body.choice ? `answered ${body.choice}) ${body.label}` : action;
    toast(`${item.title.slice(0, 48)}: ${what}${body.until ? ' until ' + at(body.until) : ''}${note}`, failed);
    li.classList.add('gone');
    // The list re-sorts under a stationary cursor and a stationary focus;
    // the next Enter must not land on the neighbour's Snooze. The redraw
    // moves focus to the heading (below) rather than leaving it on a
    // button that now belongs to another item.
    settle = true;
    setTimeout(load, 320);
  } catch (e) {
    li.classList.remove('busy');
    toast(`${action} failed: ${e.message}`, true);
  }
}

let toastTimer;
function toast(text, bad = false) {
  let t = $('.toast'); if (!t) { t = el('div', 'toast'); document.body.append(t); }
  t.textContent = text; t.classList.toggle('bad', bad);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 5000);
}

// Loads overlap (the interval, a key, a tab coming back, an action); only
// the newest may draw, or a slow old answer restores a row just acted on.
let generation = 0;
// After an act: refocus once the list is redrawn, and flash the rows whose
// neighbour above changed, so the eye can find what is now under the cursor.
let settle = false;
let placed = new Map();
// How deep the page reads. "and N more" raises it a page at a time; a new
// question puts it back.
let limit = PAGE;
async function load() {
  const gen = ++generation;
  try {
    const g0 = group(), n0 = narrow();
    const qs = new URLSearchParams({ limit: String(limit), ...(g0 ? { group: g0 } : {}), ...n0 });
    const [lists, health] = await Promise.all([fetch(`/api/lists?${qs}`).then((r) => r.json()), fetch('/healthz').then((r) => r.json())]);
    if (gen !== generation) return;
    const main = $('#main');
    for (const old of main.querySelectorAll('.group')) old.remove();
    const now = new Map();
    const totals = { queue: 0, snoozed: 0, later: 0 };
    for (const g of lists.groups) {
      totals[g.key.split(':')[0]] += g.items.length + g.more;
      // A row has moved when what sits above it changed — not when it
      // slid up a slot because something above it left. That is the row
      // that lands under a stationary cursor, and the one to flash.
      g.items.forEach((i, n) => now.set(i.id, `${g.key}:${n ? g.items[n - 1].id : 'first'}`));
      const sec = el('section', 'group');
      sec.dataset.group = g.key;
      const h = el('h2', null, g.label);
      const blurb = BLURB[g.key] || (g.group_of ? `${g.group_of} · ${g.items.length}${g.more ? '+' : ''}` : '');
      if (blurb) h.append(' ', el('span', 'muted', blurb));
      const ol = el('ol', 'rows');
      ol.replaceChildren(...g.items.map(row));
      if (placed.size) for (const li of ol.children) { const was = placed.get(Number(li.dataset.id)); if (was && was !== now.get(Number(li.dataset.id))) li.classList.add('moved'); }
      if (!g.items.length) ol.append(el('li', 'empty', Object.keys(n0).length ? 'nothing matches' : 'nothing'));
      // "and N more" is a door, not a caveat — until the read is as deep as
      // the server will go, at which point it is the number again.
      if (g.more) {
        const li = el('li', 'empty');
        if (limit < 500) { const b = el('button', 'more', `and ${g.more} more — show them`); b.type = 'button'; b.onclick = () => { limit = Math.min(500, limit + PAGE); load(); }; li.append(b); }
        else li.textContent = `and ${g.more} more`;
        ol.append(li);
      }
      sec.append(h, ol);
      main.append(sec);
    }
    placed = now;
    if (settle) { settle = false; const h = main.querySelector('.group h2'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }
    place(cursor);
    // Every count on the page is the same /api/lists answer the rows are:
    // the tiles are the open items by tier, and these are the same items
    // by state, so nothing here can say 128 while the tiles say 125.
    // Under a filter the counts are of what matches, and say so.
    $('#ranked').textContent = `${totals.queue} open · ${totals.snoozed} snoozed · ${totals.later} later${Object.keys(n0).length ? ' · matching' : ''}`;
    // The filters in force, each with its own way out. The tier's is its
    // tile; the rest are chips beside the find box.
    const chips = $('#narrow');
    chips.replaceChildren();
    $('.controls').classList.toggle('narrowed', Object.keys(n0).length > 0);
    for (const [k, v] of Object.entries(n0)) {
      if (k === 'tier' || k === 'q') continue;
      const b = el('button', 'chip', `${k === 'repo' ? '' : k + ' '}${v}`); b.type = 'button'; b.title = `stop narrowing by ${k}`;
      b.append(el('span', 'x', '×'));
      b.onclick = () => setNarrow(k, null);
      chips.append(b);
    }
    if ($('#q') !== document.activeElement) $('#q').value = n0.q || '';
    const c = lists.counts || {};
    const glance = $('#glance');
    glance.replaceChildren();
    // A tile is the filter it counts: press P1 and the page is the P1s;
    // press it again and it is everything. The counts are always the
    // whole queue's, because they are what you narrow *with*.
    const tile = (cls, tier, n) => {
      const t = el('button', `tile ${cls}`); t.type = 'button';
      const on = n0.tier === tier;
      t.setAttribute('aria-pressed', String(on));
      t.title = on ? 'show every tier' : `only ${tier}`;
      t.append(el('b', null, String(n)), ` ${tier}`);
      t.onclick = () => setNarrow('tier', on ? null : tier);
      return t;
    };
    glance.append(tile('p0', 'P0', c.P0 || 0), tile('p1', 'P1', c.P1 || 0), tile('', 'P2', c.P2 || 0), tile('', 'P3', c.P3 || 0));
    // The Slack tile leads to the statements that decide what interrupts
    // (plan §14.6) — the thing it is a badge for.
    const s = health.slack || {};
    const st = el('a', `tile slack${s.enabled ? '' : ' off'}`, s.enabled ? (s.socket_mode ? 'slack · buttons live' : 'slack · DMs only') : 'slack · not configured');
    st.href = '/api/interrupts';
    st.title = [s.quiet ? `quiet ${s.quiet}; interrupts only — the rest is this list` : '', 'what interrupts, and which statement says so'].filter(Boolean).join(' · ');
    glance.append(st);
    $('#dot').className = `dot ${health.failing?.length ? 'bad' : 'ok'}`;
    const observed = $('#observed');
    observed.replaceChildren(`${health.user} · ${totals.queue} open · ${health.decisions} verdicts`);
    if (health.failing?.length) { const a = el('a', 'failing', `${health.failing.join(', ')} failing`); a.href = '/api/sources'; a.title = 'the sources, their cursors and what went wrong'; observed.append(' · ', a); }
    // When each source last read successfully (plan §12.3 item 3): a quiet
    // source and one that has stopped reading look identical from the list,
    // so the page says which. A source whose last run failed reads red.
    for (const [name, r] of Object.entries(health.read || {})) {
      const span = el('span', r.ok ? 'read' : 'read failing', `${name} ${r.ok_at ? ago(r.ok_at) : 'never read'}`);
      span.title = r.ok ? `${name}: last read ${r.ok_at ? new Date(r.ok_at).toLocaleString() : 'never'}` : `${name} failing: ${r.error || 'unknown'} — last good read ${r.ok_at ? new Date(r.ok_at).toLocaleString() : 'never'}`;
      observed.append(' · ', span);
    }
    observed.append(` · polled ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
  } catch (e) {
    if (gen !== generation) return;
    $('#dot').className = 'dot bad';
    $('#observed').textContent = `cannot reach the service: ${e.message}`;
  }
}

$('#theme').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('triage.theme', next); } catch {}
};
$('#group').value = group();
$('#group').onchange = (e) => {
  const v = e.target.value;
  try { localStorage.setItem('triage.group', v); } catch {}
  const u = new URL(location.href);
  if (v) u.searchParams.set('group', v); else u.searchParams.delete('group');
  history.replaceState(null, '', u);
  load();
};
// The find box: a word, sent after the typing pauses. Esc empties it.
let typing;
$('#q').oninput = (e) => { clearTimeout(typing); typing = setTimeout(() => setNarrow('q', e.target.value.trim()), 250); };
$('#q').onkeydown = (e) => { if (e.key === 'Escape') { e.target.value = ''; clearTimeout(typing); setNarrow('q', null); e.target.blur(); } if (e.key === 'Enter') { clearTimeout(typing); setNarrow('q', e.target.value.trim()); e.target.blur(); } };
$('#clear').onclick = () => { clearTimeout(typing); const u = new URL(location.href); for (const k of FILTERS) u.searchParams.delete(k); history.replaceState(null, '', u); ask(); };

// A cursor for the keyboard: j and k walk the rows, and the act keys act
// on the row under it. It is an item id, so a redraw finds the same row;
// when that row has gone, the row now in its place is the one you are
// looking at, so the cursor stays put by position.
let cursor = null, cursorAt = 0;
const rows = () => [...document.querySelectorAll('.row')];
function place(id) {
  const all = rows();
  let li = all.find((r) => Number(r.dataset.id) === id) || (id != null ? all[Math.min(cursorAt, all.length - 1)] : null);
  for (const r of all) r.classList.toggle('current', r === li);
  if (!li) { cursor = null; return; }
  cursor = Number(li.dataset.id); cursorAt = all.indexOf(li);
  li.scrollIntoView({ block: 'nearest' });
}
function move(step) {
  const all = rows(); if (!all.length) return;
  const at = all.findIndex((r) => Number(r.dataset.id) === cursor);
  place(Number(all[at < 0 ? (step > 0 ? 0 : all.length - 1) : Math.max(0, Math.min(all.length - 1, at + step))].dataset.id));
}
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'r') load();
  if (e.key === 't') $('#theme').click();
  if (e.key === 'g') $('#group').focus();
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); $('#q').select(); }
  if (e.key === 'Escape') { if (Object.keys(narrow()).length) $('#clear').click(); else place(null); }
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  const li = rows().find((r) => Number(r.dataset.id) === cursor);
  if (!li || li.classList.contains('busy')) return;
  const i = li.item;
  // Enter on a focused button or link is that control's, not the cursor's:
  // a keyboard user expanding the rank must not also press Done.
  if (e.key === 'Enter' && e.target.matches('button, a')) return;
  if (e.key === 'Enter' || e.key === 'o') li.querySelector('.acts .primary')?.click();
  if (e.key === 'd') act(li, i, 'done');
  if (e.key === 's') act(li, i, 'snooze', '1h');
  if (e.key === 'S') act(li, i, 'snooze', '1d');
  if (e.key === 'l') act(li, i, 'later');
  if (e.key === 'm') act(li, i, 'mute');
});
document.addEventListener('click', (e) => { const li = e.target.closest('.row'); if (li) place(Number(li.dataset.id)); });
load();
setInterval(load, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
