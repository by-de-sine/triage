# Using the list

The page (`/`), `GET /api/lists`, `/triage` and the Slack Home tab all show
the same order, from `lib/lists.js`, so they cannot disagree about what is
first.

## The list

One ordered list of everything open — every tier, in [rank](ranking.md)
order. **Snoozed** and **Later** are their own groups after it, because
they are states rather than ranks; snoozed is ordered by wake time.

Each row says where it is from by its kind — a thread shows its repository;
a meeting shows when it starts (red inside the fifteen minutes) and offers
**Join** beside **Open** — and **why it is where it is**: the top term's
sentence, with the rank and the whole match set on hover.

**Group** with `?group=repo|source|tier|kind|owner`: groups each list
without reordering it, each group in the rank order of its best item.
`owner` is *what it takes* — a ledger row's owner kind, a thread's
repository. The grouping is a preference, kept in `localStorage`.

**Narrow** with `?tier=&repo=&source=&owner=&q=` (`q` is a word from the
title, key or repository). Filters live in the URL, so a reload or a
pasted link asks the same question. Counts (`more`, "N open") are of what
matches; counts by tier stay the whole queue's. On the page the tier tiles
are those filters, and `/` focuses the find box.

**Keyboard:** `j`/`k` (or the arrows) move, `d` done, `s`/`S` snooze 1 h /
1 d, `l` later, `m` mute, Enter or `o` takes the row's main action, `/`
finds, `g` groups, `r` reloads, `t` switches theme.

In Slack (app path only), `/triage` is read-only text — a word narrows it:
`queue`, `snoozed`, `later` — and the Home tab puts a menu on every line.
The app serves one person; anyone else who opens it is told whose queue it
is.

## Acting

Every surface calls one function, `act()`, and every action is a row in
`actions` with who did it (`web`, `slack`, `api`, or whatever a caller
says).

| Action | What it does |
|---|---|
| **Done** | `state = done`, plus whatever the item's source does: GitHub marks the thread read, GitLab marks the todo done, Home Assistant ticks the item off. The calendar, the ledger and the CRM are read-only, and Done says so. If the far end refuses, the item is still done and the reason is on the action row. A done item **reopens** on a new P0–P2: you handled it; now there is more |
| **Snooze** | `state = snoozed` until a time. The first poll after it wakes the item and writes a `snooze_wake` decision: a P0 is sent at once; anything else is back in the list. Buttons offer 1 h and 1 d; the API takes an ISO time or `30m` / `1h` / `1d`. New activity does not wake it early |
| **Later** | `state = later`: sinks beneath every open item, with no date. Re-tiered on new activity but stays sunk; only a new P0 lifts it |
| **Mute** | `state = muted`: still tiered and logged, never delivered, never reopened |
| **Reopen** (`open`) | back to open with a fresh rank — the undo for the four above. On the page and the API, not a Slack button. (The **Open** button is a link to the thread) |
| **Answer** | `{action: "answer", choice: "B"}` — for an item that carries choices, like a [ledger](sources/ledger.md#asking-through-the-ledger) `[confirm: …]` row. `state = done`, and the choice is on the action row for whoever asked to read back. A wrong letter is refused with the list |

The system's own moves are actions too: `wake` when a snooze ends,
`reopen` when a done item draws new activity, and `resolved`
(`by = source:<name>`) when a state-shaped source no longer holds the item.
Only your own actions are feedback.

```bash
curl -X POST localhost:3300/api/items/12/act -H 'content-type: application/json' -d '{"action":"snooze","until":"1h"}'
```

## Reports

`/stats` is the store read over time, where the list is the store read
now. One window — 7, 30 or 90 days, or a year, by hour, day or week, in
`TRIAGE_TZ` — scopes every chart, each drawn beside its table:

- **Flow** — what arrived against what left, and by which door: closed by
  you, or by the source (a ledger row deleted, an issue closed on GitHub).
  The open count at the end of each bucket is replayed from `actions`.
- **Interrupts** — every verdict per bucket, the ones that reached you in
  front, and the rate per hour.
- **When** — hour of day by day of week: the far end, you, and when you
  were interrupted. Bots are counted and left off the grid.
- **Where** — activity by repository, source, kind, actor or rule, the
  tail folded into `other` past seven.
- **Response** — how long an item waited for your action, and an interrupt
  for your first, each with its sample size.

Every chart has a `json` link to its report; `export json` (or `e`) saves
all four for the window as one file. See the [API](api.md#reports).
