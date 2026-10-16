// lists.js — the one order every list shows. /triage, the Home tab and the
// page all call this, so they cannot disagree about what is first.
//
// **M5: one ordered list, not four tier queries** (plan §11.3). Four
// hard-coded queries plus a page-only fifth were the tier wearing a list's
// clothes — and they are also why 51 open items were invisible on
// 2026-09-10, since `GROUPS` listed neither P2 nor P3 and P2's only surface
// was a Slack digest. Now there is one queue, in rank order, holding
// everything that is open: the tier is a word on the line, not a section
// heading. Snoozed and Later keep their own groups because they are
// *states*, not ranks — a snoozed item is out of the list at its own
// request, and Later has no date.
//
// `group` splits the queue without reordering it: `source`, `repo`, `tier`
// or `kind`, each sub-group in the rank order of its best item. That is
// the asked-for "maybe categorised" and the cheap half of §11.4's saturation
// term; the rest of that term is M6's.
//
// The order comes from lib/rank.js at *read* time — the stored base plus a
// fresh time term, held steady by hysteresis — because a rank written at
// decision time is stale within the hour of any time curve (§11.4).
export const GROUPS = [
  { key: 'queue', label: 'the list', query: { state: 'open' } },
  { key: 'snoozed', label: 'snoozed', query: { state: 'snoozed', order: 'until' } },
  { key: 'later', label: 'later', query: { state: 'later' } },
];

export const GROUP_BY = { source: (i) => i.source, repo: (i) => i.repo || i.source, tier: (i) => i.tier || 'P3', kind: (i) => i.kind, owner: (i) => i.data?.owner || i.repo || i.source };

/** What a list may be narrowed by: a tier, a repo, a source, a ledger
 *  row's owner kind, and `q` — a word from the title, key or repo. The
 *  page's tiles, tags and find box all send one of these; nothing else
 *  does, yet. */
export const FILTERS = ['tier', 'repo', 'source', 'owner', 'q'];

/** `limits` is a per-group cap, because one number applied to every group
 *  starves the last one: a Slack message holds 50 blocks, and a queue that
 *  takes all of them leaves snoozed and later to be truncated away. The page
 *  has no such budget and passes none.
 *
 *  `filter` narrows every group the same way — one of `FILTERS` each,
 *  each optional — and the counts by tier are left whole, because they are
 *  the page's tiles and the tiles are what a reader narrows *with*. A
 *  filter is not a group: it says which rows, never how the page is drawn,
 *  so the two compose, and "and N more" is counted under the same clause
 *  the rows were read with. */
export function lists(store, { user, limit: fallback = 25, limits = null, group = null, filter = null, rank = null, now = new Date() } = {}) {
  const narrow = Object.fromEntries(FILTERS.map((k) => [k, filter?.[k] || null]).filter(([, v]) => v));
  const out = { groups: [], counts: store.openByTier(user), group: group && GROUP_BY[group] ? group : null, filter: Object.keys(narrow).length ? narrow : null };
  for (const g of GROUPS) {
    const limit = limits?.[g.key] ?? fallback;
    const total = store.countItems({ user, state: g.query.state, tier: g.query.tier || null, ...narrow });
    // Read deeper than is shown, so the read-time time term can reorder
    // across the page boundary and not only inside it; the page is cut
    // afterwards. Bounded, because this is the read path.
    const deep = Math.min(Math.max(limit * 4, 50), 500);
    let items = store.itemsWithReason({ user, ...g.query, ...narrow, order: g.query?.order || (rank ? 'rank' : 'score'), limit: deep });
    // Snoozed keeps its wake-time order: it is a queue of alarms, not of
    // claims, and a rank says nothing about which one rings first.
    if (rank && g.query.order !== 'until') items = rank.order(items, now);
    const shown = items.slice(0, limit);
    const base = { key: g.key, label: g.label, ...(g.page_only ? { page_only: true } : {}), items: shown.map(brief), more: Math.max(0, total - shown.length) };
    if (out.group && g.key === 'queue') out.groups.push(...split(base, items, limit, out.group, store.countItemsBy({ user, state: g.query.state, by: out.group, ...narrow })));
    else out.groups.push(base);
  }
  return out;
}

/** The queue cut into sub-groups by one field, each in the rank order of its
 *  best item — so grouping never changes what is at the top of the page,
 *  only how the page is drawn. */
function split(base, items, limit, by, totals = new Map()) {
  const of = GROUP_BY[by];
  const seen = new Map();
  for (const i of items) {
    const k = String(of(i) ?? '—');
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(i);
  }
  return [...seen.entries()].map(([k, rows]) => {
    const shown = rows.slice(0, limit);
    // From the whole queue, not from the page of it that was prefetched —
    // `rows` is capped by `deep` and would report "and 75 more" where there
    // are 975.
    const total = totals.get(k) ?? rows.length;
    return { key: `${base.key}:${k}`, label: k, group_of: by, items: shown.map(brief), more: Math.max(0, total - shown.length) };
  });
}

/** The fields a list line needs and nothing more. `source` and the three
 *  `data` fields a meeting needs (M3) are here because a line is drawn from
 *  the item's *kind*: a thread shows its repo, an event shows when it
 *  starts and how to join.
 *
 *  M5 adds the rank and, beside it, **the top contributing term's own
 *  sentence** — `why`. A tier is explainable in four words and a blend is
 *  not, unless the thing that put it there is on the line (plan §11.7 item
 *  2). `features` carries the rest, for /api/items and the item page. */
export function brief(i) {
  const d = i.data || {};
  return { id: i.id, key: i.key, kind: i.kind, source: i.source, title: i.title, url: i.url, repo: i.repo, tier: i.tier, state: i.state, state_until: i.state_until, score: i.score, last_activity: i.last_activity, reason: i.reason || null, rule: i.rule || null, my_role: i.my_role,
    rank: i.rank ?? null, why: i.why || i.features?.why || null, top: i.top || i.features?.top || null, matches: (i.features?.matches || []).map((m) => m.rule),
    start: d.start || null, join: d.join || null, location: d.location || null,
    // A ledger row (kind `todo`): who it waits on, its nudge date, and the
    // ask — with its choices, so the page can offer them as buttons.
    owner: d.owner || null, nudge: d.nudge || null, ask: d.ask || null, choices: d.choices || null, context: d.context || null };
}
