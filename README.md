# triage

Your queue, tiered. GitHub notifications, GitLab todos and merge
requests, and your calendar (mail later) become items in one SQLite
store; rules assign each a tier and log why; the urgent ones reach you in
Slack within a minute of landing. `npm run demo` shows the whole thing
with nothing installed and no credential — §Run it starts there.

Milestone **M0 · see it** polled, stored, scored and tiered everything and
delivered only P0, as one DM with an Open button. Milestone **M1 · act on
it** added the acting: Done · Snooze · Later · Mute on the DM, on the
Home tab, on the page and over HTTP, all one code path; `/triage` and the
Home tab as lists; P1 as an hourly batch per repo and P2 as a daily
digest (both since retired, below); the quiet and coalesce windows in
config; the list page. Done marks the GitHub thread read, so the two inboxes agree.
Milestone **M2 · make it readable** put a model behind an `llm/` seam, and
**plan §13 took it out again** (2026-09-12, #14): triage is a source, not
a mind. Nothing here calls a model, no thread body leaves the box, and the
rank is a function of data triage holds — the intelligence belongs where
the *other* evidence already is, and reads triage through the API.
Milestone **M3 · second source** adds Google Calendar: the events
starting in the next 48 h, a P0 fifteen minutes before one begins, a P1 for
an invitation you have not answered, and the rest of the day in the list.
It is the milestone that proves the seam is not GitHub-shaped — a
source is still a file in `sources/` and a file in `rules/`, and the runner
learned one general thing (a source may have a clock as well as a poll)
rather than anything about calendars.

Milestone **M5 · rank it** makes the score the product and the tier
one of its inputs. The rules stop returning the first match and return
**every** match, ordered, persisted whole; a new `lib/rank.js` blends three
structural terms — claim from the rules that fired, time on a curve **each
source declares per item**, and stated preference as config — with the
weights in the environment and no model involved at all. `lib/lists.js`
becomes one ordered list with optional grouping, and the page shows
everything, which is how 51 open items stopped being invisible. Delivery
narrows to an **interrupt set**: a short named list of rules, per source,
that may fire Slack — the tier no longer picks a channel. A bounded
**backfill** re-runs the rules over the stored history of items that predate
the ranker, because nothing else ever would; a feature nobody can compute
stays *absent* rather than becoming a zero. Every contributing term keeps its
weight and its own sentence on the item, and the top one is on the line.

**The interrupt path** (2026-09-10) is not a milestone — it is the last
piece of M0's promise. Every P0 the system had ever decided was logged
*not delivered: slack not configured*, because delivery meant a Slack app
and creating one had been the open queue row since the start. It now goes
out through an **incoming webhook**: one URL in the `.env`, no app to
configure, no token, no socket, no scopes (plan §9 item 2, §11.6).
`TRIAGE_SLACK` picks the path — `webhook | app | off`, and unset infers
from what is configured — and the Bolt path is not deleted, so the richer
surface is one config line away if an app is ever worth it. What a webhook
can do is post; what it cannot is redraw a message it has already posted,
and the two places that mattered are answered rather than broken:
coalescing **holds** the repeats and sends one follow-up when the window
ends (folding kept the newer information, suppressing would discard it),
and a message stands as sent rather than being rewritten to say what you
then did. The first alarm for an item is never held: it goes the moment
the verdict lands, and that send is what opens the window.

**The P1 batch and the P2 digest are gone** (2026-09-12, #15; plan §11.3).
They existed because a tier needed a channel and P1 and P2
had none; once the list is the surface, the list is the channel, and a
message restating the middle of it is noise. What interrupts is the
interrupt set and nothing else; every other verdict is placed in the list
and its row says so. The seat that reads triage is where a digest belongs.

**The ledger** (2026-09-12, #17) is the third source and the first that
is *state* rather than a feed: a markdown queue file written by agents, and
the handoffs beside it. Every row that waits on a human is an item — grouped
by what it takes (`?group=owner`: a root command, the laptop, the HTPC, a
decision), ranked by the ask on the row and by how long past its nudge it
is — and a row deleted by whoever owns it is **resolved** by the source
rather than sitting open for ever (plan §12.2, `reconcile`). A row can
carry an ask — `[ack]`, `[confirm: yes · no · later]`, `[action]` — and
the page offers the choices as buttons; the answer is an action on the
item, which whoever asked reads back through the API. Triage never writes
to the ledger. §Asking through the ledger has the grammar.

**Issues as state** (2026-09-13, #19; plan §12.3 item 2) is the GitHub
source's second mode, not a fourth source. The inbox is a feed of activity
on threads you are subscribed to and carries almost no issues — GitHub
does not notify you about your own, and an issue filed and never
commented on is not activity — so for the repositories `TRIAGE_ISSUES`
names, the source also reads the whole **open set** every few minutes,
and hands it to the same `reconcile` the ledger uses: an issue closed on
GitHub leaves the list, resolved by the source; one reopened comes back.
Two rules read the item rather than the poll — an open issue **assigned
to you**, and one **you filed** that is still open — which is what makes
an agent-filed issue (agents here act as you) visible instead of
`own_activity`. The set governs only what its own mode brought in: a pull
request from the inbox is not "gone" for being absent from a set it was
never in. Which repositories is a list in config, because "repos I work
in" is not a question GitHub answers.

**The household's to-do lists** (2026-09-20; plan §12.8) are the fourth
source and the second that is *state* rather than a feed: the Home
Assistant lists in
`HA_LISTS` — your inbox and the household's shared list, say — read whole
and reconciled exactly as the ledger is.
It is the first source that needed no widening of the seam at all, which
is the test §12.2 set for it. Two things differ from the ledger, and both
are better: identity is Home Assistant's own **uid**, so renaming a chore
keeps the item rather than creating a new one; and **Done writes**, once —
`todo.update_item` with `status: completed` — so ticking something off
here ticks it off on the tablet, through the same `marks` map GitHub's
mark-as-read has always used. A date is the only thing on a to-do list
that claims anything by itself, so `due_today` leads and the rest is whose
list it is. **Nothing here interrupts**, on purpose: the point of putting
the chores in the list is that they stop being something you are buzzed
about. **It ships off**, and by the ordinary route rather than a special
one: `TRIAGE_HA` unset means *on if `HA_URL` and `HA_TOKEN` are both set*,
exactly as `TRIAGE_CALENDAR` does, and production has neither — because
whether the box triage runs on may reach Home Assistant is a decision
about the network, not about this source.

**The CRM** (2026-10-03; plan §12.3 item 3) is the fifth source and the
last of M7: Twenty's tasks and notes, on a key bound to a role that can
read every record and change none. It is **state and a feed at once**.
Every open task is an item, ranked with the rest — due or overdue leads
(`task_due`), then yours (`task_mine`), then anybody's — and a task
completed or deleted in Twenty is resolved by the source against a read
that saw every page. The feed is the point of it: **a task or note created
or changed by somebody who is not you is news, and it interrupts when it
lands on something of yours** — a task handed to you or changed while it
is yours (`handed_to_me`, `changed_on_my_task`). The same edit on a task
you wrote and handed on is a P1, and on anybody else's work a P2, both in
the list (the tiers are below). Tasks have no comments, so a collaborator's reply arrives as an edit to a
body or a new note — which is why the event is keyed on the record *and a
fingerprint of its content* (title, body, status, assignee, due), and an
edit is news where everywhere else triage is blind to one (plan §12.4).
"Not you" is read from the record's own `updatedBy`: not your workspace
member (`TRIAGE_CRM_ME`) and not one of your agents' key names
(`TRIAGE_CRM_AGENTS`, none by default). The first read is a
**baseline** and interrupts on nothing. And **the read itself is
watched**: no complete read within `TRIAGE_CRM_STALE_MIN` is a P0 of its
own (`crm_unread`), so a quiet CRM means nothing happened rather than that
nothing was read; the page prints when every source last read
successfully. Done on a CRM item is local — there is no `marks` entry and
the key could not write one.

**GitLab** (2026-10-15; plan §16, G1) is the sixth source and the first
that is another *forge*: your pending todos as the inbox, the merge
requests and issues that are yours updated since the last poll (GitLab's
todos do not fire for an ordinary comment on your own merge request), and
the open issues of `TRIAGE_GITLAB_ISSUES` as state, reconciled exactly as
GitHub's are. A reply on GitLab is the same observation as a reply on
GitHub, so there is **one thread-shaped rule set** for both
(`rules/thread.js`), one interrupt set, and one client shape
(`lib/forge-api.js`: `GitHubApi` and `GitLabApi` over one `RestApi`, either
pointed at a self-hosted instance by `TRIAGE_GITHUB_URL` /
`TRIAGE_GITLAB_URL`). What it asked of the seam was two declarations every
source may now make: **`whoami(ctx)`** — who you are on this source,
resolved once at boot, so `me` in a rule is your GitLab username on a
GitLab item and your GitHub login on a GitHub one — and **`mark(item,
ctx)`** — what Done does at the far end, which is the `marks` map
`server.js` has always built, with the entry now supplied by the source.
Done on a GitLab item marks the todo done. Nothing in `lib/` or
`deliver/` learned the word gitlab. It ships off: `GITLAB_TOKEN` unset (and
nothing from `glab auth token`) means the source does not register.

## The shape

```
sources/            rules/             deliver/                     act/
  github  ─┐                                    ┌─ slack (the interrupt set: one message per verdict that interrupts)
  gitlab   ┤                                    │
  calendar ┤                                    │
  ledger   ┼─▶ items · events (sqlite) ─▶ tier ─┤
  ha       ┤        ▲   ▲                       └─ the list: /triage · Home tab · GET / · GET /api/lists (everything else)
  crm     ─┘        │   └─ the clock: a snooze that ended, a meeting 15 min out, a CRM unread too long; and reconcile: a ledger row, a chore, or a task, that is gone
                    └── decisions (every verdict, delivered or not)
                    └── actions ◀── done · snooze · later · mute · open · answer ◀── buttons, menu, page, POST /act
```

One process, one SQLite file, four seams:

- **Source** — `sources/<name>.js`: `{ name, every, describe, poll(ctx),
  due?(ctx), reconcile?(ctx), describeCursor?(state), time?(item, { rules }),
  project?(item), whoami?(ctx), mark?(item, ctx) }`. `poll` gets the cursor it returned
  last time and hands back `{ batches: [{item, events}], cursor, every?,
  status? }`. It owns its cursor and never writes; the runner stores what it
  returns. `whoami` says who you are on this source, once at boot; `mark`
  is what Done does at the far end, and a source without one is read-only
  there. GitHub honours `Last-Modified` (a 304 is free) and
  `X-Poll-Interval` (the API says how often), and for each thread that moved
  fetches the subject and, for issues and PRs, the comments, review comments
  and reviews since the cursor last saw it. Events are keyed
  (`github:comment:<id>`) so a restart re-emits nothing.

  **The calendar is read from an ICS feed** (plan §16, G4), the address
  every calendar publishes — Google's "secret address in iCal format",
  Outlook's "publish calendar", a Fastmail or Apple subscription URL — so
  there is no OAuth client, no cloud project and no consent step: the URL
  is the credential, and only its host is ever logged. The feed is fetched
  at most every `TRIAGE_CALENDAR_EVERY_MIN` and then conditionally (a 304
  re-reads what it had), parsed by `lib/ics.js` — enough of RFC 5545:
  unfolding, zones through `Intl` (and the Windows names Outlook writes),
  all-day entries, `EXDATE`, `RECURRENCE-ID`, and `RRULE` daily, weekly,
  monthly and yearly with `INTERVAL`, `COUNT` and `UNTIL`; stdlib only —
  and expanded from a day back to 48 h ahead. An item is one event, or one
  occurrence of a recurring one (`<UID>@<occurrence>`); its event is keyed
  on a hash of what a rule reads (`calendar:<key>:<hash>`), so a
  reschedule, a cancellation or an answer re-tiers it and an unchanged
  feed emits nothing. **It is state, too**: an event gone from the feed
  leaves the set `reconcile` hands the runner and is resolved by the
  source. The calendar's **project** is the feed's own name
  (`X-WR-CALNAME`) unless `TRIAGE_CALENDAR_ID` names one. *The other
  path*, kept until the feed has run a week in production (plan §16.7
  item b): Google's `events.list` with a `syncToken` — the first call a
  full sync, every one after it only what moved — events keyed
  `calendar:<eventId>:<updated>`. It never resolves anything: an
  incremental sync has no whole set to hand over.

  **The GitHub source has a second mode, open issues as state** (#19):
  for the repositories in `TRIAGE_ISSUES`, every open issue is read whole
  once per `TRIAGE_ISSUES_EVERY_MIN` (oldest-updated first, ten pages of a
  hundred per repository, a capped read marked incomplete), written as an
  item with `data.mode = 'open'`, and the set kept in the cursor for
  `reconcile`. Its events are `opened` on first sight — the inbox's own
  key, so the two halves never double it — and one `open` per
  `updated_at`, so a change on GitHub re-tiers it and an unchanged issue
  emits nothing. The inbox writes the same fields for an issue the set
  governs, and keeps the thread id it alone knows, so Done still marks
  the thread read.

  **The GitLab source is the same shape on the other forge**: `GET
  /todos?state=pending` is the inbox (a mention, a review or approval
  request, an assignment, a failed pipeline — each names its target and
  why); the merge requests you authored, review or are assigned to and
  the issues assigned to or filed by you, updated since the cursor, fill
  in what todos never say (an ordinary comment on your own merge request);
  and the open issues of `TRIAGE_GITLAB_ISSUES` are the state half. For each
  thread that moved the discussions are read and become the same events
  the GitHub source emits — a note is a `comment` (a `review_comment` when
  it is on the diff, carrying the id of the note it answers), and the
  system notes GitLab writes for an approval, a review request, a merge or
  a close become `review`, `review_request` and `state`. Events are keyed
  (`gitlab:note:<id>`, `gitlab:todo:<id>`) so a restart re-emits nothing.

  **`due` is the clock's half of a source**, and it is why "starts in 15
  minutes" is reliable rather than lucky: nothing changed at Google, only
  the time. It gets the source's own open items and `now`, returns batches
  like a poll, and the runner calls it **before** every poll in its own try
  — exactly as it already wakes snoozes — so an outage at the far end does
  not stop the alarm for a meeting already in the store. Its events are
  keyed by the start they are about, so a minute-by-minute check emits each
  one once.

  **`reconcile` is the state half of a source** (plan §12.2), for a source
  whose items are *true and unfinished* rather than *happened*: a queue
  row, later an open issue or a CRM task. Such an item stops being so
  somewhere else, with no event to say so. After every poll the runner
  asks the source for the current set of keys and resolves what is no
  longer in it — `state = done` with a `resolved` action attributed to
  the source, never to you, so `actions` learns no preference you did not
  express — and reopens what the source resolved that has come back.
  **Only a complete read may resolve**: a source that could not see the
  whole set says `complete: false` and nothing is touched, because
  resolving everything not seen would empty the list in one poll. It runs
  beside the snooze wake, on its own path, because `ingest` skips a batch
  with no fresh events and an absence has none. **A set speaks only for
  what its own mode ingested**: a source that is a feed *and* a state —
  GitHub — returns `governs(item)` with its set, and an item outside it is
  left alone; a source without one (the ledger) governs everything.
  Reconcile returns `null` when there is nothing to say — the mode off,
  or nothing read yet — and the runner is silent. **`ha` is the second
  state-shaped source and needed nothing new**: it reads each list in
  `HA_LISTS` whole through `todo.get_items`, keeps the set in its cursor
  (so reconcile costs no second read), and identifies an item by Home
  Assistant's uid — a rename keeps the item and re-tiers it, because the
  event key hashes summary, due and status. An item ticked off on the
  tablet leaves the set and is resolved by the source; one un-ticked comes
  back. The ledger reads
  the queue file `TRIAGE_LEDGER` names and the `status/*.md` beside it —
  local files, no API, no credential — and identifies a row by its Item text,
  so bumping a nudge date keeps the item and rewording the item makes a
  new one; the event key hashes the whole row, so any change re-tiers it.
- **Item** — one per GitHub thread, GitLab thread, calendar event, ledger
  row or to-do item: `source`,
  `key` (`owner/repo#n` — whichever mode found it, so an issue is one
  item however many ways it arrives — `group/project!n` for a merge
  request and `group/project#n` for a GitLab issue, the event id,
  `row:<hash of the item text>`, or `ha:<list>:<uid>`),
  `kind` (`pull` · `issue` · `event` · `todo` · …), `title`, `url` (null
  for a ledger row), `repo` (null for an event or a row), `actors`,
  `my_role` (authored · commented · mentioned · review_requested · assigned
  · subscribed · organizer · invited · attendee · owner), `last_activity`,
  `last_seen`, `tier`, `score`, `state` (open · snoozed · later · done ·
  muted). An event's `data` carries its start, end, location, Join link,
  organizer, guests and the answer you gave; a row's carries its owner
  kind, nudge date, ask and choices, context, and where in the file it
  is; a chore's carries its list, its due date and its description; an
  issue's or pull request's carries its `state`, `author`,
  `assignees` and `labels` from either half of the source, the inbox's
  `reason` and `thread_id` when it has been through the inbox, and
  `mode: 'open'` when the open set governs it. Every item carries a
  `user`.
- **Rule** — `rules/<source>.js`, or one file for a shape several sources
  share: `rules/thread.js` serves both forges, because a reply on GitLab
  is the same observation as a reply on GitHub. Pure, named, ordered;
  every match is returned (M5), and the strongest is the `rule`, `tier`
  and `reason` on the decision row.
  `match(item, fresh, { me, history, now })` returns a reason or null. Every
  verdict is a row in `decisions` with the rule's name, P3 included.
- **Delivery** — `deliver/slack.js`, in two halves that `TRIAGE_SLACK`
  picks between. **The webhook half** (`webhook`; plan §16, G2) is
  `deliver/notify.js`: one URL, one message per interrupt, in one of three
  shapes from `deliver/messages.js` that `TRIAGE_NOTIFY` names — `slack`
  (an incoming webhook: the app's own message without the act buttons, so
  the two cannot drift apart), `discord` (a channel webhook, one markdown
  message) or `generic` (any endpoint that takes JSON: the text and the
  structure both). Unset, the shape is inferred from the URL's host. Once
  `TRIAGE_MENTION` says who, **it names you**, in that endpoint's grammar,
  because a channel message that mentions nobody is an unread badge and
  not a push under Slack's and Discord's default preferences, which is how
  the first real P0 this system sent arrived and reached nobody (plan
  §14.1). **The app half** (`app`) is Bolt in Socket Mode, so Slack never
  needs to reach this box, and it is the only one with buttons, `/triage`
  and a Home tab — and the direction output grows in (plan §16.5). Everything below is written for the app; under `webhook`
  the message is the same **without the act buttons** — nothing delivers a
  press, so Done · Snooze · Later · Mute are not rendered at all, and Open
  (with a meeting's Join) stays on the line beneath as a link. One DM per interrupt: title, repo,
  who did what,
  one line of the comment, **Open · Done · Snooze 1h · Snooze 1d · Later
  · Mute thread**. **`item.kind` decides the shape, never `item.source`** —
  a meeting's DM is its title, when it starts, where, who is coming and a
  **Join** button before the same six, and a third source that emits
  something thread-shaped gets the thread shape for free. Never two DMs for
  one item inside ten minutes (the message is updated instead); a quiet
  window holds interrupts until it ends; an event older than a day is tiered but
  not sent, so the first boot does not replay the inbox into Slack — and
  under `webhook`, where nothing can be updated, the second interrupt inside the
  window is held instead and one follow-up goes out at its end. Nothing
  else is sent: a verdict that does not interrupt is placed in the list and
  its decision row says so, on the spot. `deliver/blocks.js` builds every
  message and view as a pure function; `deliver/handlers.js` is what the
  buttons, the overflow menu, `/triage` and the Home tab do.
- **Act** — `lib/actions.js`: the one path every surface calls. The
  buttons, the Home tab menu, the page and `POST /api/items/:id/act` all
  end in the same `act()`, and it updates the DM that carried the item.

There is no fifth seam. Plan §13 is explicit: triage **emits** and never
ingests an opinion. The write path is the five actions through `act()`,
because an action is a fact about what you did; nothing writes a
judgement — a relevance, a label, a "do this first" — into the store, from
inside or from outside, so the order stays explainable from data triage
holds and `decisions` stays a record of what the rules observed.

## Acting on it

| Action | What it does |
|---|---|
| **Done** | `state = done`, plus whatever the item's *source* does about that — a `marks` entry keyed by source name, not a branch in `act()`, supplied by the source's own `mark` where it has one. GitHub's marks the thread read (`PATCH /notifications/threads/:id`, the id the notification carried); **GitLab's marks the todo done** (`POST /todos/:id/mark_as_done`, the todo that brought the item — a thread that arrived without one says `no todo on the item`); if the forge refuses — no thread id, a token without the scope, an outage — the local state still changes and the reason is logged and kept on the action row. **The calendar's marks nothing: triage only reads it** — a feed cannot be written, and on the Google path the scope is read-only — so Done is local and the answer says `nothing marked on your calendar — triage only reads the feed` (on the Google path, `nothing marked on Google — triage only reads your calendar`). Declining an invitation still happens in the calendar, and the next read notices. **Home Assistant's marks writes**: `todo.update_item` with `status: completed` on that item's own list, so ticking a chore off here ticks it off on the kitchen screen; if Home Assistant refuses or cannot be reached, the local state still changes and the reason is on the action row. It is the only write this process makes outside its own store. Reopens on a new P0–P2: you handled it; now there is more. |
| **Snooze** | `state = snoozed until`; the first poll past the time wakes it, sets it open again and writes a `snooze_wake` decision — a P0 is sent at once (its age is no bar, you asked for it); anything else is back in the list at a fresh rank, and the row says so. Buttons offer 1 h and 1 d; the API takes any ISO time or `30m` / `1h` / `1d`. New activity while snoozed does not wake it. |
| **Later** | `state = later`; the score is divided by ten thousand, so the item sinks beneath every open item of every tier and has no date. Re-tiered on new activity but stays sunk; only a new P0 lifts it. |
| **Mute thread** | `state = muted`; still tiered and logged on every poll, never delivered, never reopened. |
| **Reopen** (`open`) | back to open with a fresh score — the undo for any of the four. On the page and over HTTP as `{action: "open"}`; not a DM button. The DM's and the page's **Open** is a link to the thread, not this. |
| **Answer** | `{action: "answer", choice: "B"}` (a letter or the label) — for an item that carries choices, a ledger row with `[confirm: …]`: `state = done`, and the choice is on the action row, which is how whoever asked reads the answer back (`GET /api/items/:id` → `actions`). Triage does not write into the ledger; the row closes when its owner deletes it. An `[ack]` row's button is Done. The page offers the choices as buttons; over HTTP a wrong letter is refused with the list. |

Every action is a row in `actions` with who did it (`slack`, `web`,
`api`, or whatever a caller says), and the system's own moves are there
too: `wake` when a snooze ends, `reopen` when a done item drew a new
P0–P2 or a Later item a new P0 (or when a source's own resolution is
undone by the item coming back), and `resolved` — `by = source:<name>` —
when a state-shaped source no longer holds the item. Only your own
actions are feedback; a source resolving its own items is not you
preferring anything (plan §12.2).

## The list

Since M5 there is **one** ordered list, and it holds everything that is
open — every tier, in rank order, the tier a word on the line rather than a
section heading. `/triage` (a word narrows it: `queue`, `snoozed`,
`later`; `now` and `soon` still mean the top), the Home tab and the page
all show the same order from `lib/lists.js`, so they cannot disagree about
what is first. `?group=repo|source|tier|kind|owner` cuts the list without
reordering it — each group in the rank order of its best item — which is
the cheap half of §11.4's saturation term and the page's grouping control.
`owner` is **what it takes**: a ledger row's owner kind (`human-sudo`,
`human-laptop`, `human-htpc`, `human-decision`, `agent`), a thread's repo.
The list also **narrows** — `?tier=&repo=&source=&owner=&q=`, any of
them, together — and a narrowing is not a group: it says which rows,
never how the page is drawn, so the two compose, and the counts (`more`,
the "N open" line) are of what matches while the counts by tier stay the
whole queue's. On the page the tier tiles in the masthead are those
filters (press P1 for the P1s, press it again for everything), the tag on
a row is its repo's, owner's or source's, and the find box (`/`) is a
word from the title, key or repo. The filters live in the URL, so a
reload or a pasted link asks the same question; the grouping is the
preference and lives in `localStorage`. The page also walks with the
keyboard — `j` and `k` move a cursor, `d`, `s`, `S`, `l`, `m` act on the
row under it, Enter takes its solid action — and "and N more" is a
button that reads the next page.
`GET /api/aggregates` is the other half of the same answer for a program:
the whole queue as counts and spreads, with how much of it is one
repository said outright rather than interleaved away (plan §13.6).

A row says where it is from according to its *kind*: a thread shows its
repo, a meeting shows when it starts — reddening once it is inside the
fifteen minutes — and offers **Join** beside **Open** when there is a link.
It also carries **why it is where it is**: the top contributing term's own
sentence, with the rank and the whole match set on the hover. The Home tab
puts a five-item menu on every line; `/triage` is read-only text; the page
has the buttons. Snoozed and Later are their own groups, because they are
states rather than ranks — snoozed keeps its wake-time order, since it is a
queue of alarms and a rank says nothing about which rings first. The app
serves one person: anyone else in the workspace who opens it is told whose
queue it is.

## The rank

`lib/rank.js` is the only thing that computes it. Three terms, all
structural — since plan §13 nothing in triage calls a model, so the order
is a function of data triage holds and nothing else:

| Term | Weight | What it is |
|---|---|---|
| **claim** | `TRIAGE_RANK_W_CLAIM` (1) | what hold this has on you, from the rules that fired. Each rule declares a `claim` 0–1 (`reply_to_my_review_comment` 1, `state_change_on_mine` 0.25, `bot_only` 0.05); the strongest sets the floor and every other match adds `TRIAGE_RANK_CORROBORATE` (0.25) of its own. That is what persisting the whole match set buys |
| **time** | `TRIAGE_RANK_W_TIME` (0.6) | per source *and* per item, because one curve cannot say what any of them mean. **The source declares the shape** and is handed the match set to decide with: `waiting` (0.5 when it lands, rising — the wait is the cost), `fading` (news, 12 h half-life), `spike` (a meeting: flat inside the quarter hour, nothing an hour after the start), `flat`. **0.5 means "time says nothing here"**, so the curves share a zero point and can be blended |
| **prefer** | `TRIAGE_RANK_W_PREFER` (0.4) | `TRIAGE_RANK_PREFER`, e.g. `repo:acme/widgets=0.8, actor:carol=0.5` — stated preference as structure a scorer with no model can read |

The blend is a weighted mean **over the terms that are present**. A term
nobody has computed is `absent`, and absence leaves the denominator rather
than scoring zero — the difference between "we do not know" and "there is
none", which is the common case while the backlog is being bootstrapped.
`relevance` and `effort` are declared and **permanently** absent: they
were the model's two features, and §13.4 names what their absence costs
(the list will never float a thirty-second reply above an hour of reading).

**Stability**, decided before the first blend (§11.4): the match set and the
base are stored on the item and the time term is recomputed at *read* time,
because a rank written at decision time is stale within the hour. Hysteresis
(`TRIAGE_RANK_HYSTERESIS`, 0.02) holds the order still — a rank that has not
moved further than that is read as the stored one, so nothing rearranges
under your hand.

**`items.rank` is its own column.** `items.score` keeps its present meaning —
tier first, recency second, Later divided by ten thousand — because it has
four writers and one of its jobs belongs to the interrupt path rather than
to the list. All four write the rank beside it (`lib/pipeline.js` on a
verdict and on a snooze wake, `lib/actions.js` on `later` and on `open`), so
an item you tossed to Later sinks in both orderings.

**The backfill** (`lib/backfill.js`) is the bootstrap: one bounded pass over
items the ranker has never seen. For each, the rules re-run against **the
events the item's verdict on record was about** — `decisions.event_ids`, not
the whole history, because every event-local rule asks "did this happen
*now*", and a thread's whole life turns "now" into "ever": an item replied to
in June and merged in August would come back as `reply_to_my_comment` on the
waiting curve, saying somebody is blocked on you when the thread is closed.
Results are persisted on the item. It writes no decision rows — a verdict that
was never made and never delivered would stop `/api/decisions` being a record
of what happened — and marks what it could not know as absent, with the
reason. It runs once at boot and again on `POST /api/rank/backfill`.

## What interrupts

Delivery answers one question: **does this interrupt?** The answer is a short
named list of rules, per source (`deliver/interrupts.js`), not a tier —
because under a ranking the tier no longer picks a channel.

| Source | Rules that may fire Slack, out of the box |
|---|---|
| `github` · `gitlab` | `reply_to_my_review_comment` · `reply_to_my_comment` · `direct_mention` · `review_requested` · `new_pull_request` |
| `calendar` | `starts_in_15_min` · `new_invitation` |
| `crm` | `handed_to_me` · `changed_on_my_task` · `crm_unread` |

`new_invitation` is a **P1**, which is the point: the set and the tiers are
allowed to disagree. Every verdict is answered on its own row the moment it
lands — sent, held, or `not delivered: <rule> does not interrupt (<the
statement that said so>); it is in the list` — so a P0 that is *not* on the
list is placed, and says so. A snooze that wakes as a P0 is always sent —
you asked to be interrupted then; one that wakes as anything else is back in
the list.

### Making it yours

What qualifies as an interrupt is personal, so the set above is a **default,
not the mechanism** (plan §14). Four layers, later winning, and *the most
specific statement in the highest layer wins* — that is the whole resolution
rule:

| | Layer | Where | For |
|---|---|---|---|
| 0 | the default set | `deliver/interrupts.js` | a fresh clone, configured with nothing |
| 1 | yours, globally | `TRIAGE_PREFS` → `.interrupts` | "also buzz me on a new issue" |
| 2 | yours, per project | `TRIAGE_PREFS` → `.projects[…].interrupts` | "…but only in this repo" |
| 3 | yours, from the shell | `TRIAGE_INTERRUPT` | "silence that, now" |

A statement is `[+|-]source:rule[@project]`. `+` arms, `-` mutes, `*` is a
wildcard anywhere in it, and a project may glob (`owner/*`). **Signs make it
a delta on the layer beneath; an unsigned list replaces** — which is exactly
what `TRIAGE_INTERRUPT` has always meant, so nothing already configured
changes meaning. You never restate the defaults to change one thing about
them, and they go on improving underneath you.

**What a project is, each source says** (`project(item)`, the same
built-at-boot map `rank`'s time curves use): GitHub's is the repository, the
calendar's is the calendar id, the ledger declares none and is scoped by
layers 1 and 2 alone. Nothing in `lib/` or `deliver/` knows what a project
is.

`TRIAGE_PREFS` is a JSON file — `preferences.json` beside the `.env`
unless the env names another, absent by default, and malformed is a boot
failure rather than a silent "no preferences":

```json
{
  "interrupts": { "github": ["+new_issue"], "calendar": "off" },
  "projects": {
    "acme/*":        { "weight": 0.6, "interrupts": { "github": ["+comment_on_my_thread"] } },
    "alice/scratch": { "weight": -0.5, "interrupts": "off" }
  }
}
```

`"off"` and `"all"` are the two shorthands worth having: a project that must
never buzz, and one that is on fire.

`weight` is the other thing a project entry says, and it is **not a fifth
layer** — not all repos are equal, but that is a question about *ordering*.
It feeds the stated preferences the ranker already reads
(`repo:owner/name=0.8`), so one entry in one file says both things about a
project: where it sits in the list, and what it may interrupt on. They
travel together and they are not the same mechanism — a weight never moves
the interrupt bar by itself (plan §14.7). `TRIAGE_RANK_PREFER` and
`TRIAGE_INTERRUPT` still win over the file for the same key.

**`GET /api/interrupts` is the half that makes it usable**: every statement
grouped by the layer it came from, the effective set, and — with
`?source=&rule=` and either `&project=` or `&item=` — the one-shot answer to
*would this interrupt, and which statement says so*. It is `bin/replay.js`'s
trick applied to delivery instead of to rules.

## The tiers

Each source has its own ordered rules, and the tier means the same thing in
both: P0 is a thing to do now.

| Tier | Meaning | Thread rules (GitHub and GitLab, in order) |
|---|---|---|
| **P0** | someone is waiting on you | `reply_to_my_review_comment` (a human reply whose `in_reply_to_id` is yours — on GitLab, a reply in a discussion you opened on the diff) · `reply_to_my_comment` (a human comment on a thread you commented in, newer than your last) · `direct_mention` · `review_requested` (by a person) · `new_pull_request` (a person opened a pull or merge request in a repository you follow, within the last day — they want feedback whether or not they named you) |
| **P1** | yours, moving | `comment_on_my_thread` · `review_on_my_pr` |
| **P2** | worth knowing today | `state_change_on_mine` (merged, closed) · `assigned` (the notification) · `issue_assigned_to_me` (an open issue with you on it — a fact about the item, from either mode; claim 0.5) · `my_open_issue` (you filed it and it is still open; claim 0.35 — this is what an agent-filed issue is, since agents here act as you) · `new_issue` (a human opened one in a repo you follow; was `new_issue_on_my_repo`, whose owner condition excluded every repo you actually file in) |
| **P3** | ambient | `release` · `own_activity` · `bot_only` · `ambient` |

| Tier | Meaning | Rules (calendar, in order) |
|---|---|---|
| **P0** | it is about to start | `starts_in_15_min` — fifteen minutes before an event you are going to, from the clock rather than a poll. Never for one you declined, one that was cancelled, or an all-day entry |
| **P1** | someone is waiting for an answer | `new_invitation` — you are an attendee, your answer is still `needsAction` (`PARTSTAT=NEEDS-ACTION` in a feed, which needs `TRIAGE_CALENDAR_ME` to know which attendee is you), and it is not your own event |
| **P2** | worth knowing today | `day_ahead` — anything else on your calendar in the window. This is the day-ahead brief, and it is in the list under `calendar` |
| **P3** | on the calendar, nothing to do | `declined` · `cancelled` · `all_day` · `own_event` (yours, nobody else on it) · `ambient` |

A *timed* event of your own with no guests is P3 in the day-ahead brief and
still gets the fifteen-minute P0 (an all-day one never rings — there is no
minute to be late for). Those are not in tension: a focus block is not
news for a brief of the day's meetings, but the alarm exists so you do not
miss what is starting, and Google cannot tell a focus block from a dentist
appointment. Of the two errors, silence is the worse one.

Bots (`[bot]`, coderabbit, dependabot, GitLab's `project_N_bot` access
tokens, `ghost`, …) are never "someone": a review bot answering your
comment is P3.

| Tier | Meaning | Rules (ledger, in order) |
|---|---|---|
| **P1** | yours, and quick | `quick_answer` — a row of yours tagged `[ack]` or `[confirm: …]`: an answer you can give from the line. Claim 0.8, above an overdue action, because working down a list is a throughput problem and a multiple choice is the cheapest thing on it |
| **P1** | yours, and past its date | `past_its_nudge` — a row of yours whose nudge date has passed. It has been *waiting since the nudge*: that date is its `last_activity`, so the longer overdue it is the higher it sits |
| **P2** | yours, an action | `waiting_on_you` — a row of yours tagged `[action]`, or untagged (the default), or a handoff in `review` or `blocked` |
| **P3** | not yours | `kept_for_history` (a struck-through row) · `agents_own` (owner `agent`: an agent's to do, nothing for you) · `ambient` |

"Yours" is an owner kind that starts with `human-`. Nothing in the ledger
interrupts: its rules are not in the interrupt set, so every row is placed
in the list and says so on its decision.

| Tier | Meaning | Rules (Home Assistant, in order) |
|---|---|---|
| **P1** | it has a date, and the date is now or past | `due_today` — due today or already overdue, on either list. A date with no time is due at the *end* of that day, so an item dated today qualifies all day; past it, the item has been waiting **since the date**, exactly as an overdue ledger row waits from its nudge |
| **P2** | it is on your own list | `inbox_item` — anything in a list whose name ends in `inbox` (`todo.alice_inbox`), dated or not |
| **P3** | the house shares it | `household_item` — anything on a shared list, which is ambient until it has a date, and follows the `flat` curve because a chore does not get more urgent by sitting on the fridge · `ambient` |

Nothing in Home Assistant interrupts either, and that one is the point
rather than an omission: putting the chores in the list is what stops them
being something you are buzzed about.

| Tier | Meaning | Rules (CRM, in order) |
|---|---|---|
| **P0** | the CRM is not being read | `crm_unread` — no complete read within `TRIAGE_CRM_STALE_MIN` |
| **P0** | someone is waiting on you | `handed_to_me` — somebody else created a task assigned to you, or moved one onto you · `changed_on_my_task` — somebody else changed a task assigned to you. Twenty has no comments, so this is a reply |
| **P1** | yours, and it moved | `changed_what_i_wrote` — somebody else changed a task or note you or your agents wrote, not assigned to you: usually the person you handed it to, reporting back · `task_due` — due today or overdue |
| **P2** | worth knowing today | `changed_by_other` — anything else somebody else changed: their own tasks, a note on the company · `task_mine` — assigned to you |
| **P3** | somebody's | `task_open` · `ambient` |

"Yours" for a task is its assignee; "wrote" is its `createdBy`, judged
exactly as "not you" is (`TRIAGE_CRM_ME`, `TRIAGE_CRM_AGENTS`). Only the
P0s interrupt out of the box. A colleague working through their own tasks
is the list, not Slack — and if you want every edit again,
`+crm:changed_what_i_wrote,+crm:changed_by_other` (in `TRIAGE_INTERRUPT`,
or per company in the preferences file) is the whole of it. Because the
interrupt test reads the strongest match, arm the steps you want, not just
the bottom one.

## Asking through the ledger

The shape a script or an agent should write when it needs something from
you is **a topic and one of three asks** — acknowledge it, confirm or deny
it, or do it (the hard one) — and the more of them that are a multiple
choice, the better. It is one table row in `OPEN_LOOPS.md`, the file
agents already write, with a tag at the end of the Item cell:

```markdown
| 2026-09-20 | `human-decision` | Rename the org [confirm: rename the user · new org · leave it] | why, briefly |
| 2026-09-20 | `human-laptop`   | The PAT was reissued [ack] | nothing to do but know |
| 2026-09-20 | `human-sudo`     | Point Caddy at the user config [action] | the one line to run |
```

`[confirm]` alone is yes / no. Choices are separated by `·`, `;` or ` / `
(never `|`, which is the table's) and lettered A, B, C… in order. No tag
on a row of yours means `[action]`. The row shows up on the page within a
minute with a button per choice; pressing one records the answer on the
item and closes it. **Reading the answer back** is one call for whoever
asked — `GET /api/items?source=ledger&state=done`, then the item's
`actions`, where the row is `{action: "answer", data: {choice: "B", label:
"new org"}}` — and then they delete the row, which is the ledger's own rule
for closing anything. Until they do, the item stays done here; if they
bump or reword the row instead, it comes back as a new verdict, because
now there is more.

**`ambient`** is the GitHub verdict for a thread you are only subscribed to
— nothing structural addressed to you. It is a rule like the others: a P3
with a low claim, ranked by the same three terms, and nothing gives it a
second opinion (plan §13.4 item 3 accepts that). "CI failed on your PR"
(P1 in the plan's original tier table) is still deferred: it needs check runs, which the
notifications API does not carry, so it is a source change rather than a
rule.

`bin/replay.js owner/repo#n` (or `group/project!n` on GitLab) runs the
rules over one thread's real history step by step and prints what each
would have decided — how "would that reply have been P0?" is answered
without waiting for the next one. It reads the forge and writes nothing.

## Run it

Node ≥ 24 and nothing else — `node:sqlite` and `fetch` are built in, and
the two npm packages are reached only under `TRIAGE_SLACK=app`.

```bash
git clone https://github.com/by-de-sine/triage.git && cd triage
npm run demo          # http://127.0.0.1:3300 — a canned GitHub, GitLab, calendar, CRM, household and queue file, in memory, no credential
npm test              # node --test, fake everything, under a second
```

Then your own queue: a GitHub token (`gh auth login` is enough) or a
GitLab token, `node server.js`, and the page shows what is waiting on you.
A Slack incoming webhook URL, or a Discord one, is one more line and the
P0s reach you within a minute. The Slack app — buttons, a DM, a Home tab
— is `slack/manifest.yml` and `TRIAGE_SLACK=app`.

**The demo needs no install.** `@slack/bolt` and `@slack/web-api` are
imported only on the app path, so with no `node_modules` at all the demo,
the tests and a server on the webhook all boot; `npm ci` is for
`TRIAGE_SLACK=app`. GitHub, GitLab, Google and Twenty are stdlib `fetch`
and no dependency. The demo is `TRIAGE_DEMO=1` (plan §16, G3): every
source runs its fake from `test/` — the five below that have a `fake`
mode, and a queue file written to a temp dir and removed at shutdown —
filed under `alice`, the fixtures' you; the store is in memory unless
`TRIAGE_DB` names one; and **nothing leaves the box**: no `.env` is read
unless `TRIAGE_ENV` names one, no token is asked for, the Slack app never
starts, and the webhook is `TRIAGE_NOTIFY=off` — so every interrupt reads
`not delivered: the webhook is off` in `/api/decisions` — unless
`TRIAGE_WEBHOOK_URL` is a listener on loopback, which is how you read
the payload. A source's own `off` still leaves its fake out.

```bash
node server.js                 # 127.0.0.1:3300 — the page is at /
node bin/google-consent.js     # once, by hand, on the Google path only: the consent that mints the refresh token
node bin/replay.js o/r#123     # what the rules would have said, step by step (group/project!12 on GitLab)
curl -X POST localhost:3300/api/items/12/act -H 'content-type: application/json' -d '{"action":"snooze","until":"1h"}'
```

Configuration is the environment, or `~/.config/triage/.env` (`TRIAGE_ENV`
moves it; [`.env.example`](.env.example) lists every variable). Nothing is
read from the repo.

| Variable | Default | |
|---|---|---|
| `GITHUB_TOKEN` | what `gh auth token` holds | a **classic** token with `notifications` (or `repo`): GitHub's notifications endpoints — the inbox and marking a thread read — do not accept fine-grained tokens. A per-owner token in `<TRIAGE_TOKENS_DIR>/<owner>` (`~/.config/triage/tokens` by default) is used for that owner's repos when present, and those can be fine-grained; the entry is a file holding the token, or a directory holding a `gh` config (`hosts.yml`), in which case `gh auth token` is asked with `GH_CONFIG_DIR` pointed there, once every ten minutes |
| `GITHUB_USER` | `GET /user` | who you are on GitHub — the `me` every thread rule compares an actor to on a GitHub item, and, when GitHub is on, the `user` every item is filed under |
| `TRIAGE_DEMO` | unset | `1` is the demo, above: every source on its fake, the store in memory, nothing delivered off the box. `npm run demo` sets it. Anything but `1`/`0` (or `true`/`false`, `on`/`off`, `yes`/`no`) is refused at boot |
| `TRIAGE_GITHUB` | unset | `on` · `off` · `fake`. Unset means **on if a token resolves**; `on` refuses to start without one; `off` never registers the source; `fake` runs the canned inbox from `test/fake-github.js` (a reply on your pull request, a mention, a review request, a merge, a bot's bump, and an open set of three issues) with no token. A mode it does not recognise is refused at boot |
| `TRIAGE_GITHUB_URL` | `https://api.github.com` | a GitHub Enterprise API base, `https://host/api/v3`; the web links pair with it |
| `GITLAB_TOKEN` | what `glab auth token` holds | a personal access token with `read_api`, and `api` if Done is to mark the todo done. A box without `glab` reads as no token, and the source stays off |
| `GITLAB_USER` | `GET /user` | who you are on GitLab — the `me` on a GitLab item, and the `user` every item is filed under when GitHub is off. Switching which forge is first on an existing store changes that `user` and leaves the old rows filed under the old name |
| `TRIAGE_GITLAB` | unset | `on` · `off` · `fake`, exactly as `TRIAGE_GITHUB`; `fake` is `test/fake-gitlab.js` |
| `TRIAGE_GITLAB_URL` | `https://gitlab.com` | the instance; the API is `/api/v4` under it |
| `TRIAGE_GITLAB_ISSUES` | — | projects whose **open issues** are read as state and reconciled, `group/project` comma-separated (a path may nest; a URL is accepted; a bad entry is refused at boot) |
| `TRIAGE_SLACK` | unset | `webhook` · `app` · `off`. Unset means **infer from what is configured** — `webhook` if a webhook URL is set (and `TRIAGE_NOTIFY` is not `off`), `app` if `SLACK_BOT_TOKEN` is, `off` otherwise; with both set the webhook wins and `app` says otherwise. A mode it does not recognise is refused at boot, as `TRIAGE_CALENDAR` is: a typo must not read as the default |
| `TRIAGE_NOTIFY` | inferred | the webhook's shape (plan §16, G2): `slack` · `discord` · `generic` · `off`. Unset is inferred from `TRIAGE_WEBHOOK_URL`'s host — `hooks.slack.com` is Slack, `discord.com` is Discord, anything else is generic JSON — and `off` with no URL. `off` turns the webhook half off whatever the URL says, and typed beside `TRIAGE_SLACK=webhook` is refused as a contradiction. On Discord the configured mention is the only thing the message may notify (`allowed_mentions`): a `<@id>` a commenter typed in a thread is quoted, never pinged; and the post asks Discord to answer only once the message is saved (`wait=true`). A redirect from any webhook is an error, never followed. A shape it does not recognise is refused at boot |
| `TRIAGE_WEBHOOK_URL` | — | the webhook: a Slack incoming webhook (plan §11.6), a Discord channel webhook, or any endpoint that takes a JSON POST. One message per interrupt to the channel it was created for; no DM, no buttons, no redraw, no Home tab. **`SLACK_WEBHOOK_URL` is read as an alias** — the name it had when Slack was the only shape — so a `.env` written then goes on working. **Point it at a channel you are alone in** — a DM to `SLACK_USER_ID` was private by construction and this is not, and what goes through it is a thread title, a repo name and a line of a comment, from private repositories. Nothing in the code can check where a webhook points. The URL *is* the credential: it carries no scopes, cannot be narrowed, and is never logged, stored or returned by the API — only its host is. Must be `https`, except on loopback — plain `http://127.0.0.1:…` is allowed because that is how a worktree proves delivery against a listener of its own. A post is abandoned after ten seconds and never retried: `deliver()` is awaited by the poll, and an ambiguous POST may well have arrived |
| `SLACK_BOT_TOKEN` · `SLACK_APP_TOKEN` · `SLACK_USER_ID` | — | the `app` path, superseded by the webhook but not deleted, and **read by nothing else**: the webhook path's mention is `TRIAGE_MENTION`, so these three stay app-only and a box on the webhook leaves all of them unset. Without the first and last, delivery is off and every interrupt is logged as not delivered; without the app token there is no Socket Mode, so DMs go out but no button, `/triage` or Home tab answers |
| `TRIAGE_QUIET` | `23:00-07:00` | local quiet window; empty disables. Interrupts are held and sent when it ends |
| `TRIAGE_TZ` | the system zone | |
| `TRIAGE_COALESCE_MIN` | `10` | one DM per item per window. Under `app` a second interrupt inside it updates the message that is out; under `webhook`, which cannot, it is held and sent once as one follow-up when the window ends. The *first* alarm for an item is never held, in either mode |
| `TRIAGE_DELIVER_MAX_AGE_H` | `24` | an event older than this is tiered, not sent — so the first boot does not replay the inbox into Slack. A snooze that wakes is exempt |
| `TRIAGE_PORT` · `TRIAGE_HOST` | `3300` · `127.0.0.1` | `0` takes any free port, and the boot log names it |
| `TRIAGE_DB` | `~/.local/state/triage/triage.db` | data, not config. In memory under `TRIAGE_DEMO=1` unless set |
| `TRIAGE_GITHUB_ALL` | unset | `1` reads threads you have marked read too |
| `TRIAGE_GITHUB_ISSUES` | — | repositories whose **open issues** are read as state and reconciled, `owner/name` comma-separated (a GitHub URL is accepted; a bad entry is refused at boot). Unset, the source is the inbox alone. A list and not an inference: "repos I work in" is not a question GitHub answers (plan §12.7). **`TRIAGE_ISSUES` is read as an alias** — the name it had before there were two forges — so a `.env` written then goes on meaning it |
| `TRIAGE_ISSUES_EVERY_MIN` | `5` | how often each open set is read whole — one list call per repository per hundred issues. `0` reads it on every poll. Between reads the last set stands, and nothing is resolved against a set the read could not complete |
| `TRIAGE_LEDGER` | unset | a path names the markdown queue file, whose `status/` sibling is the handoffs directory, and refuses to start if it is missing; unset or `off` never registers the source. The read is local and read-only — a worktree can point at the real file; its own store is the only thing reconcile touches |
| `TRIAGE_CALENDAR` | unset | `off` · `ics` · `google` · `fake`. Unset means **the feed when `TRIAGE_CALENDAR_URL` or `TRIAGE_CALENDAR_FILE` names one, Google when its credentials resolve, off otherwise** — a box without either should run the rest of triage rather than fail a poll a minute. `ics` and `google` refuse to start without what they need; `off` never registers the source; `fake` runs the canned feed from `test/fake-calendar.js` — a meeting twelve minutes out, an unanswered invitation, a recurring standup with one occurrence moved — with no feed at all, every title saying `(fake)`. A mode it does not recognise is refused at boot |
| `TRIAGE_CALENDAR_URL` | — | the feed: Google's *Settings › your calendar › Integrate calendar › Secret address in iCal format*, Outlook's *publish calendar* ICS link, or any subscription URL (`webcal://` is read as `https://`). **The URL is the credential** — anyone holding it reads your calendar — so it is never logged, stored or returned by the API (its host is), and must be `https` off loopback. Read-only by construction: a feed cannot be written to |
| `TRIAGE_CALENDAR_FILE` | — | the feed as a file on disk instead, re-read on every poll. Not with `TRIAGE_CALENDAR_URL`: naming both is refused |
| `TRIAGE_CALENDAR_ME` | — | **your** address on invitations, comma-separated if you have more than one. A feed lists attendees by address and says nothing about which is you, so without it no invitation can be yours to answer (`new_invitation` never fires) and only an entry with nobody on it reads as your own; the boot log says so. An entry that is not an address is refused at boot |
| `TRIAGE_CALENDAR_EVERY_MIN` | `5` | how often the feed URL is fetched; between fetches the last text is re-expanded every minute, so the window and the alarm still move. Published feeds lag the calendar by minutes to hours anyway. `0` fetches on every poll |
| `GOOGLE_CLIENT_FILE` | `google-oauth.json` beside the `.env` | *The other path* (`TRIAGE_CALENDAR=google`). The OAuth **desktop client** downloaded from the Google Cloud console (`{"installed": {…}}`). `GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET` in the environment override it |
| `GOOGLE_TOKEN_FILE` | `google-token.json` beside the `.env` | *The other path.* The refresh token, written once by `node bin/google-consent.js` — the one browser step, from the laptop. `GOOGLE_REFRESH_TOKEN` overrides it. Scope is `calendar.readonly`: triage never writes to your calendar |
| `TRIAGE_CALENDAR_ID` | the feed's name · `primary` | which calendar, and so the project its items belong to (`projects."<id>"` in the preferences file). Unset, a feed's own name (`X-WR-CALNAME`, else the file's name or the URL's host); on the Google path, `primary`. One calendar, for now |
| `TRIAGE_CALENDAR_WINDOW_H` | `48` | an event starting further out than this is not an item yet. Its start is remembered, and it becomes one when it enters the window |
| `TRIAGE_CALENDAR_SOON_MIN` | `15` | how long before an event starts the P0 fires |
| `TRIAGE_HA` | unset | the household to-do lists (plan §12.8). Unset means **on if `HA_URL` and `HA_TOKEN` are both set**, off otherwise; `on` refuses to start without them; `off` never registers the source; `fake` runs the canned pair of lists from `test/` — `todo.alice_inbox` and `todo.household`, read unless `HA_LISTS` names some of them — so a worktree, or a box with no route to Home Assistant, proves the whole flow, Done included. A mode it does not recognise is refused at boot, as `TRIAGE_CALENDAR` is. **It is unset in production**: whether the box triage runs on may reach Home Assistant is a decision about the network, and it is in the queue |
| `HA_URL` · `HA_TOKEN` | — | where Home Assistant is (`http://<host>:8123`, or a Nabu Casa remote URL) and a **long-lived access token** from Profile → Security. Home Assistant has no narrower grant: the token can do whatever the user who minted it can do, which is why the only write in this tree is ticking one item off |
| `HA_LISTS` | — | which lists are read (none by default, so the source is off until this names one), as `todo.*` entity ids, comma- or space-separated. A list whose name ends in `inbox` is *yours* (`inbox_item`); anything else is the house's. A bad entry is refused at boot |
| `TRIAGE_HA_DASHBOARD` | `<HA_URL>/todo` | where an item's **Open** goes. Home Assistant has no deep link to a single to-do item, so it is the to-do panel — set it to the dashboard you would actually tap if that is not it |
| `TRIAGE_CRM` | unset | Twenty's tasks and notes (plan §12.3 item 3). Unset means **on if `TWENTY_URL`, `TWENTY_API_KEY` and `TRIAGE_CRM_ME` are all set**; `on` refuses to start without them; `off` never registers the source; `fake` runs the canned CRM from `test/fake-twenty.js`, where, on the second read, a colleague hands you a task (P0), rewords one you handed them (P1) and an unnamed key adds a note (P2) — every title says `(fake)`. A mode it does not recognise is refused at boot |
| `TWENTY_URL` · `TWENTY_API_KEY` | — | where Twenty is and a key from *Settings › APIs › API keys* bound to the **Read-only (API)** role (plan §12.7). Read over GraphQL, never `/mcp`. Never an admin key: triage must not be able to write to the system of record |
| `TRIAGE_CRM_ME` | — | **you**, as Twenty's workspace member: an id, an email or a full name, comma-separated. No default, on purpose — a source that cannot recognise you reads every one of your own edits as somebody else's. An entry that matches no member fails the read rather than shrinking the set |
| `TRIAGE_CRM_AGENTS` | — | the `updatedBy.name` your **agents'** edits carry, comma-separated — they act through the API under a key's name, not as you, so this is the names of their keys. Anything not named here and not you is somebody else, including a key nobody has named. Unset or empty means you have no agents |
| `TRIAGE_CRM_PROJECTS` | — | `Company Name=project`, comma-separated: which project a company's tasks and notes belong to (plan §14.3), so `projects."acme"` in the preferences file and `@acme` in a statement reach them. A company not named is its own project, by name |
| `TRIAGE_CRM_STALE_MIN` | `30` | how long without a **complete** read before that is a P0 (`crm_unread`). One alarm per outage, resolved by the next complete read. Before any read has completed the clock starts at boot. `0` turns the alarm off |
| `TRIAGE_INTERRUPT` | unset | which rules may fire Slack, and where — `[+\|-]source:rule[@project]`, comma-separated (M5 plan §11.6; layered by §14). The top layer: it wins over the preferences file, because typing it is what "silence this now" means. Unset is whatever the layers beneath resolve to; an unsigned list still *replaces* the whole set, as it always has; `off` interrupts on nothing; a source named with no rules of its own interrupts on none, which is how a noisy new source is muted |
| `TRIAGE_PREFS` | `<envFile dir>/preferences.json` | the preferences file (plan §14.4): what interrupts you globally and per project, and what each project is worth. Beside the `.env`, as `GOOGLE_CLIENT_FILE` is — and gitignored for the same reason, since in a worktree that directory is the checkout. Absent is the normal case and means the built-in set. **Malformed is a boot failure** — a typo read as "no preferences" is the bug you discover by not being interrupted |
| `TRIAGE_MENTION` | unset — **nobody is named, so nothing pushes** | who an interrupt names in `webhook` mode, so the channel *notifies* rather than badges (plan §14.1). **The one line that turns the interrupt path from delivered into arrived.** In the grammar of the shape it goes to: on Slack a user id (`U…`/`W…`), a user group (`S…`), `!here`, `!channel`, or those same forms in Slack's `<…>` markup; on Discord a user id (bare digits or `<@id>`), a role (`<@&id>`), `@here` or `@everyone`; on a generic endpoint any text, passed through in the payload's `mention`. A Slack or Discord form it does not recognise is refused at boot — a bare name would render as a word and notify nobody — and `off` says "nobody" on purpose. It does **not** fall back to `SLACK_USER_ID`, which belongs to the `app` path. Ignored under `app`, where a DM notifies on its own |
| `TRIAGE_RANK_W_CLAIM` · `TRIAGE_RANK_W_TIME` · `TRIAGE_RANK_W_PREFER` | `1` · `0.6` · `0.4` | the weights of the blend. Plan §13.3 puts them in config on purpose: a deterministic function combines the features, and nothing else produces the order |
| `TRIAGE_RANK_W_RELEVANCE` · `TRIAGE_RANK_W_EFFORT` | `0` | declared and **absent**: they were the model's two features and nothing computes them (plan §13.4), so a weight here does nothing — which is the point of absence not being zero |
| `TRIAGE_RANK_PREFER` | — | stated preference as structure: `repo:owner/name=0.8, source:calendar=0.3, actor:login=0.5, kind:pull=0.2`, weights −1…1. A bare `owner/name` is a repo. Empty means the term is absent rather than a flat half |
| `TRIAGE_RANK_CORROBORATE` | `0.25` | how much each match beyond the strongest adds to the claim. `0` means "the strongest match only" |
| `TRIAGE_RANK_HYSTERESIS` | `0.02` | how far a read-time rank must move before the list is allowed to reorder |
| `TRIAGE_RANK_BACKFILL` | `500` | how many unranked items the one bootstrap pass takes at boot; `0` disables it |

A webhook is created in Slack's or Discord's UI and is one line in the
`.env`; nothing in this repo configures it. A generic endpoint is whatever
takes a JSON POST — the payload is `text`, `mention`, `item`, `decision`
and `event`, and a script on the far end does what it likes with them. The Slack **app** — only needed for
`TRIAGE_SLACK=app`, and so for buttons, `/triage` and the Home tab — is
created from `slack/manifest.yml` (the comments there say which token is
which). Where it runs the service is one user systemd unit behind a
reverse proxy; the unit and the deploy steps belong to that host, not to
this repo. Working on it is a worktree per task with its own instance and
Slack off — [`AGENTS.md`](AGENTS.md) has the flow, and
[`docs/plan.md`](docs/plan.md) the plan.

## Deploy

What a deploy of triage *needs*. Not how it happens, or what performs it:
triage is an app and does not know where it runs — the box it runs on owns
deploying, generically, and its half of this contract lives with that
box's own configuration.

- It is **one Node process**, started from `<checkout>/server.js`. There is
  nothing else to start, nothing to build, and no artifact.
- A deploy is: **the checkout at the new commit, `npm ci` if and only if
  `package-lock.json` changed, a restart.** The lock file matters — there
  are two packages (`@slack/bolt`, `@slack/web-api`), reached only under
  `TRIAGE_SLACK=app`, so a pulled `main` on a stale `node_modules` starts
  and then fails at the first import on that path.
- **The store migrates itself at boot**, idempotently (§The store), and drops
  nothing without a dated note in `docs/plan.md`. Nothing rolls a migration
  back, so a **consistent snapshot before every restart** is the whole
  rollback story for the data. WAL is on, which means a bare `cp` of the live
  file is not a snapshot; `node:sqlite`'s `backup()` against a read-only
  handle is.
- **`GET /healthz` answers 200 with `ok: true` when it is up**, and reports
  `commit` — the sha that is running — when the environment tells it one in
  `TRIAGE_COMMIT`, and `null` otherwise. It never reads git: the checkout on
  disk can move after this process started, so git answers a question about
  the disk, not about what is running. A deployer that sets `TRIAGE_COMMIT`
  can therefore verify it deployed what it thinks it did; one that does not
  set it loses that check and nothing else.

Only `main` is ever deployed. A task worktree is a separate instance with its
own port, store and `.env` (`AGENTS.md`), and is never what this contract
describes.

## The API

Bound to 127.0.0.1; JSON.

| | |
|---|---|
| `GET /api/items` | `?tier=&state=&source=&since=&order=&limit=` — by **rank**, then recency, each item carrying its `features`; `order=score` is the tier's own ordering, which the interrupt path reads |
| `GET /` | the list page (`public/`, no build) |
| `GET /api/items/:id` | one item with its events, decisions, actions and deliveries |
| `POST /api/items/:id/act` | `{action: done\|snooze\|later\|mute\|open\|answer, until?, choice?, by?}` — `until` is an ISO time or `30m` / `1h` / `1d`; `choice` is a letter or a label from the item's own `choices`. Answers with the item and, for done, `marked`: what the item's source did about it — the GitHub thread read, or the sentence saying a read-only source did nothing. A browser `Origin` from another host is refused; curl sends none |
| `GET /api/lists` | `?limit=&group=source\|repo\|tier\|kind\|owner&tier=&repo=&source=&owner=&q=` — one ordered list (`queue`) holding everything open, then `snoozed` and `later`, each row with its reason, rank and the sentence for the term that put it there. The last five narrow every group under one clause (`q` is a word from the title, key or repo, case-insensitive) and are echoed back as `filter`; `counts` stays the whole queue's by tier |
| `GET /api/aggregates` | `?state=open\|snoozed\|later\|done\|muted\|all` — the queue as counts, for a program (plan §13.6): `total`; `by` source, repo, rule (the strongest match per item), `matches` (every rule that fired), tier, kind and age band (`<1h` · `<1d` · `<7d` · `<30d` · `30d+`, on `last_activity`); `share`, how much of the list is one repo, source or kind; and `rank` — how many are ranked, min, max, mean, median and a ten-bucket histogram of the same read-time ranks the page orders by. Nothing is written and nothing is judged |
| `GET /api/reports` | the reports there are and the sentence each answers (plan §15): `flow`, `when`, `where`, `response` |
| `GET /api/reports/:name` | `?since=&until=&bucket=hour\|day\|week&by=&source=` — one report over a window, bucketed in `TRIAGE_TZ`; thirty days by the day when nothing is asked. `flow` is arrivals against closures per bucket (who closed what: you, or the source), the state of the queue at the end of each bucket replayed from `actions`, and the interrupt rate against §14.7's trigger; `when` is hour of the day by day of the week for the far end, for you, for bots and for interrupts, `?source=` narrowing it; `where` is the activity per repo, source, kind, actor or rule per bucket, the tail folded into `other`; `response` is how long an item waited for you, and an interrupt for your first action, with its sample size on every number. Nothing is written and nothing is judged |
| `GET /stats` | the reports page (`public/stats.html`, no build): every report as a chart with its table beside it |
| `GET /api/rank` | the weights, the time shapes registered, the stated preferences, the interrupt set, and how many items have never been ranked |
| `GET /api/interrupts` | the resolved interrupt statements grouped by layer, the effective set, and which sources declare a project. `?source=&rule=` with `&project=` or `&item=` answers one question — would this interrupt, and which statement says so (plan §14.6) |
| `POST /api/rank/backfill` | `?all=1&limit=` — the bounded bootstrap pass. Idempotent: it walks only what has never been ranked unless `all=1` |
| `GET /api/sources` | registered sources, their cursors and health. A cursor is shown the way its own source describes it — GitHub's conditional stamp and thread count and, with `TRIAGE_ISSUES`, `issues: { repos, open, complete, read_at }` for the open set; the calendar's — from a feed — when it was last fetched and read, whether that read was complete, how many entries the feed holds and how many are in the window, and the feed's name; from Google, `synced_at` and how many events are waiting to enter the window. Never the feed's URL, and never the sync token |
| `POST /api/sources/:name/run` | poll now; answers with what was stored and decided |
| `GET /api/decisions` | `?tier=&rule=&by=&item=&since=&delivered=&limit=` — every verdict with its rule and what delivery said: `sent`, `updated … (coalesced)`, `held`, or why not — `not delivered: <rule> does not interrupt (<the statement that said so — the default set, a `TRIAGE_PREFS` project, `TRIAGE_INTERRUPT`>); it is in the list` for everything the interrupt set does not name. Each row carries `by` (`rule`, or `wake` for the row a snooze that ended wrote) |
| `GET /healthz` | `ok`, when it started, `commit` (what the deploy said is running, or null — §Deploy), `user` and `identity` (who you are, per source), the item and decision counts, which sources are failing, when each last read successfully (`read`), and what Slack would do |

## The reports

`/stats` is the store read over time (plan §15), where the list page is the
store read now. One window — seven, thirty, ninety days or a year, by the
hour, the day or the week, in `TRIAGE_TZ` — scopes every chart on the page,
and each chart is one report from `lib/reports.js` drawn beside its own
table. **Flow** is what arrived against what left and by which door: a
closure you made, or one the source made (a ledger row its owner deleted,
an issue closed on GitHub) — never the same series, because only what you
did is feedback (§12.2) — and the open count at the end of each bucket,
replayed from `actions` rather than stored. **Interrupts** is every verdict
per bucket with the ones that reached Slack in front, and the rate an hour
beside §14.7's trigger. **When** is hour of the day by day of the week —
the far end, you, and when Slack was told — because a person has a single
clock even if a team does not; bots are counted and left off the grid. A
source whose events carry the poll's time rather than the world's (the
ledger's do) says nothing useful here, and `source` narrows the grid to
one. **Where** is the activity by repository, source, kind, actor or rule,
the tail folded into `other` past seven. **Response** is how long an item
waited between its verdict and your action, and how long an interrupt
waited for your first — and it prints its sample size in the same breath,
because a median of two is not a median. Every number on the page is
reachable without a pointer: the tables, and `GET /api/reports/:name`. **The
data is the export**: every chart carries a `json` link to its own report for
the window on screen, and `export json` (or `e`) saves all four for that
window as one file — the same answers the page drew, unchanged, for a
spreadsheet, a notebook or the seat.

## The store

SQLite, WAL, at `~/.local/state/triage/triage.db` (`TRIAGE_DB`). Four tables carry the
design — `items`, `events` (append-only, unique by key), `decisions` (with
`by`: `rule`, or `wake`), `actions` — and three support it: `cursors` (per
source), `deliveries` and `source_runs` (health). M3 added no table and no column: a
calendar event is an item like any other, and the alarm that fires fifteen
minutes before it is an event row like any other. M5 added no table
either, and five columns: `decisions.matches` (the whole ordered verdict,
in the `event_ids` idiom, beside the `rule`/`tier`/`reason` that still mean
the strongest match — a row written before M5 has none stored and reads back
as the one match it names), and `items.rank`, `rank_base`, `rank_at` and
`features`. **§13 took two tables and three columns out** — `llm_jobs`,
`llm_calls`, `items.summary`, `items.summary_at`, `decisions.acted` — and
the `by = 'llm'` rows with them, at boot, rows first: once `acted` is gone
nothing else tells a logged-only verdict from a rule's. **#15 took the P1
batch and the P2 digest out** and their two cursors, `slack:p1` and
`slack:p2`, with them at boot; a `batched` delivery row is history and is
no longer written. `deliveries` is which
Slack message carries which item: `sent` for a DM, `held` inside the quiet window — or, under
`TRIAGE_SLACK=webhook`, inside a coalesce window a send has opened —
`dropped` when you acted before it went out. `message_ts` is Slack's
message id and is what a later update names; a webhook answers with the
body `ok` and no id, so in that mode it is null and there is nothing to
update later. Migrations are idempotent SQL run at boot — `CREATE IF NOT
EXISTS`, a list of later columns added when `PRAGMA table_info` says one
is missing, and its mirror: a list of what has been removed, dropped when
`PRAGMA table_info` says it is still there. A store that has been through
it boots unchanged. There is no versioned migration and no rollback: the
file is data, not source, and it wants a restore path, not history —
`~/backups/triage/`, snapshotted before every deploy (§Deploy), because a
migration that has run is not undone by putting the old commit back.
