# Architecture

One Node process, one SQLite file, four seams.

```text
sources/            rules/              deliver/                    act
  github   ─┐                                    ┌─ interrupt: one message per verdict that interrupts (Slack, Discord, any webhook)
  gitlab    ┤                                    │
  calendar  ┤                                    │
  ledger    ┼─▶ items · events (sqlite) ─▶ tier ─┤
  ha        ┤        ▲   ▲                       └─ the list: the page · /api/lists · /triage · Home tab (everything else)
  crm      ─┘        │   └─ the clock (a snooze ending, a meeting 15 min out, a CRM unread too long)
                     │      and reconcile (a ledger row, chore, task or open issue that is gone)
                     └── decisions (every verdict, delivered or not)
                     └── actions ◀── done · snooze · later · mute · open · answer ◀── buttons, page, POST /act
```

**Source → item → rule → delivery**, with **act** as the one write path
every surface calls. Those seams are the design, and they stay intact:

- A new source is a file in `sources/` and a file in `rules/`, never a
  branch in the runner.
- A new surface (a button, a page, a command) ends in `lib/actions.js`
  `act()` and nowhere else.
- A rule is pure and returns a reason or null.
- Delivery reads decisions and writes what it did onto them.
- Nothing in `lib/` or `deliver/` knows a source's name, except the API
  clients that speak a far end's protocol (`lib/forge-api.js`,
  `lib/ics.js`, `lib/google-api.js`, `lib/ha-api.js`, `lib/twenty-api.js`),
  which no runner, rule or delivery code branches on. Delivery picks a
  message's shape from `item.kind`, never `item.source`.

There is **no model** and no seam for one ([plan §13](plan.md)). Triage
emits deterministic, explainable structure; it never ingests an opinion.
The only write path is the actions through `act()`, because an action is a
fact about what you did, not a judgement about what you should do.

## Source

`sources/<name>.js` exports:

| Member | Required | What it is |
|---|---|---|
| `name`, `every`, `describe` | yes | identity, poll interval, one line for `/api/sources` |
| `poll(ctx)` | yes | gets the cursor it returned last time; returns `{ batches: [{ item, events }], cursor, every?, status? }`. It owns its cursor and never writes — the runner stores what it returns |
| `due(ctx)` | | the clock's half: what became true because time passed, not because the far end changed (a meeting fifteen minutes out). Called **before** every poll in its own `try`, so an outage at the far end does not stop an alarm for something already in the store. Events are keyed by the moment they are about, so they fire once |
| `reconcile(ctx)` | | the state half, for items that are *true and unfinished* rather than *happened*: returns the current set of keys and whether the read was `complete`. The runner resolves what has left the set and reopens what the source resolved that has come back. May also return `governs(item)` — which items the set speaks for — or `null` for "nothing to say" |
| `describeCursor(state)` | | how the cursor is shown in `/api/sources` (never a secret) |
| `time(item, { rules })` | | which time curve ranks this item (`waiting`, `fading`, `spike`, `flat`) — decided from the rules that fired |
| `project(item)` | | which project the item belongs to, for [interrupt preferences](interrupts.md#making-it-yours) |
| `whoami(ctx)` | | who you are on this source, resolved once at boot, so `me` in a rule is right per source |
| `mark(item, ctx)` | | what Done does at the far end. A source without one is read-only there |

Every optional member is a map built at boot from the registered sources;
nothing in `lib/` asks which source it is talking to.

Three rules govern reconcile:

- **Only a complete read may resolve.** A read that could not see the whole
  set says `complete: false` and nothing is touched — otherwise one bad
  poll would empty the list.
- **A resolution is the source's, not yours.** It is written as an action
  with `by = source:<name>`, so the ranker never learns a preference you
  did not express.
- **A set speaks only for what its own mode ingested.** A source that is a
  feed *and* state (GitHub: the inbox and the open issues) returns
  `governs(item)`, and items outside it are left alone.

Each source's own page says what it reads: [GitHub](sources/github.md),
[GitLab](sources/gitlab.md), [calendar](sources/calendar.md),
[ledger](sources/ledger.md), [Home Assistant](sources/home-assistant.md),
[CRM](sources/crm.md).

## Item

One row per thing that can need you: a forge thread, a calendar event (or
one occurrence of a recurring one), a ledger row, a to-do, a CRM task or
note.

| Field | |
|---|---|
| `source`, `key` | the key is the source's identity for it: `owner/repo#n`, `group/project!n` (a merge request), the event id, `row:<hash>`, `ha:<list>:<uid>`… |
| `kind` | `pull` · `issue` · `event` · `todo` · … — what delivery draws by |
| `title`, `url`, `repo`, `actors` | `url` is null for a ledger row; `repo` for anything that is not a thread |
| `my_role` | authored · commented · mentioned · review_requested · assigned · subscribed · organizer · invited · attendee · owner |
| `last_activity`, `last_seen` | |
| `tier`, `score`, `rank` | see [ranking](ranking.md) |
| `state` | open · snoozed · later · done · muted |
| `user` | whose queue this is |
| `data` | per source: an event's start, end, location, Join link and your answer; a row's owner kind, ask and choices; an issue's state, author, assignees, labels and thread id… |

Events are keyed (`github:comment:<id>`, `gitlab:note:<id>`,
`calendar:<key>:<hash>`) and unique, so a restart re-emits nothing.

## Rule

`rules/<source>.js`, or one file for a shape several sources share —
`rules/thread.js` serves both forges, because a reply on GitLab is the same
observation as one on GitHub. Rules are pure, named and ordered:

```js
match(item, fresh, { me, history, now }) // → a reason string, or null
```

Every match is returned, not just the first. The strongest is the `rule`,
`tier` and `reason` on the decision row; the whole set is kept for the
ranker. Each rule declares a `claim` (0–1): how much hold it has on you.
Every verdict is a row in `decisions`, P3 included.

## Delivery

`deliver/slack.js` answers one question per verdict — *does this
interrupt?* — and writes the answer onto the decision row. Two halves, of
which one runs:

- **Webhook** (`deliver/notify.js`, `deliver/messages.js`): one URL, one
  message per interrupt, in one of three shapes — `slack`, `discord` or
  `generic` JSON.
- **App** (Bolt in Socket Mode, `deliver/blocks.js`,
  `deliver/handlers.js`): a DM with buttons, `/triage`, a Home tab.

See [interrupts](interrupts.md).

## Act

`lib/actions.js` `act()` is the one path every surface calls: the buttons,
the Home tab menu, the page and `POST /api/items/:id/act`. Done also calls
the source's `mark` where it has one. See [using the list](using.md).

## Store

SQLite in WAL mode, at `TRIAGE_DB` (default
`~/.local/state/triage/triage.db`).

| Table | |
|---|---|
| `items` | one per thing, with `rank`, `rank_base`, `rank_at`, `features` |
| `events` | append-only, unique by key |
| `decisions` | every verdict: rule, tier, reason, the whole `matches` set, `event_ids`, what delivery did, and `by` (`rule`, or `wake`) |
| `actions` | everything done to an item, by whom |
| `deliveries` | which message carries which item: `sent`, `held`, `dropped`; `message_ts` is Slack's id (null from a webhook, which returns none) |
| `cursors`, `source_runs` | per-source cursor and read health |

**The schema migrates itself at boot**, idempotently: `CREATE IF NOT
EXISTS`, columns added when `PRAGMA table_info` says they are missing, and
a list of removed columns and tables dropped when they are still there.
There are no versioned migrations and no rollback: the file is data, not
source, and wants a restore path (a snapshot before every deploy — see
[deploy](deploy.md)) rather than history.
