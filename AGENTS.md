# AGENTS.md — triage

Instructions for agents working in this repository. `README.md` is the
design — the shape, the tiers, the API, the store, the configuration — and
is not repeated here; read it first. This file is how to *work on* it.

## Where things are

```text
server.js        boot: config, store, the forge clients (GitHub, GitLab — each registers when its token resolves, and says who you are there), the Google client, Slack, the runner, the API; under TRIAGE_DEMO=1 (lib/config.js `demoConfig`) every source on its fake from test/ and delivery off
sources/         one file per source: github.js, gitlab.js, calendar.js, ledger.js, ha.js, crm.js — poll(ctx) → batches + cursor; due(ctx) for the clock's half; reconcile(ctx) for the state half (github.js, gitlab.js and crm.js have both: a forge's inbox is a feed and the open issues of TRIAGE_GITHUB_ISSUES / TRIAGE_GITLAB_ISSUES are state; the CRM's open tasks are state and anybody else's edit is an event; ledger.js and ha.js are state throughout; calendar.js has two readers — an ICS feed, which is state, and Google's events.list, which is a feed — picked by whether the context carries `feed` or `api`); whoami(ctx) and mark(item, ctx) on the forges
rules/           thread.js (both forges: a reply on GitLab is the same observation as one on GitHub), calendar.js, ledger.js, ha.js, crm.js — ordered, named, every match returned; each rule declares its `claim`
deliver/         slack.js (the windows, the guards, the answer on every decision — the same for both halves), notify.js (the webhook half, TRIAGE_SLACK=webhook: one URL, one post, the mention grammar per endpoint), messages.js (pure; the three shapes TRIAGE_NOTIFY picks — slack, discord, generic — each drawn by item.kind), blocks.js (pure; the app's message and views, and the slack shape's source), handlers.js (TRIAGE_SLACK=app only: buttons, /triage, Home), interrupts.js (M5 + §14: which rules, per source, for which project, may fire Slack — four layers resolved into one statement list)
lib/             store.js (node:sqlite), runner.js, pipeline.js, rules.js, actions.js, lists.js, api.js, config.js, forge-api.js (one RestApi; GitHubApi with a token per owner, GitLabApi), forge.js (what the forge sources share: the news set, the time curve, the repository-list parser), ics.js (enough of RFC 5545 for a feed: the parser and the recurrence expansion, pure), google-api.js (the calendar's other path), ha-api.js, twenty-api.js (GraphQL, read-only), util.js, rank.js (M5: the score, which is the product), backfill.js (M5: the one bounded pass that gives the backlog a rank), aggregates.js (§13.6: the queue as counts, for a program), reports.js (§15: the queue over time — named reports over one bounded read, for the stats page and for a program)
public/          the list page (index.html, app.js) and the stats page (stats.html, stats.js): static, no build, one stylesheet
bin/replay.js    run the rules over one real thread, on either forge, step by step, writing nothing
bin/google-consent.js  the one browser step, run once by hand: mints the calendar's refresh token
slack/           the app manifest
test/            node --test; in-memory store, fake GitHub (fake-github.js), fake GitLab (fake-gitlab.js), fake Slack, fake calendar (fake-calendar.js: a feed, and the Google path's API), fake Home Assistant (fake-ha.js), fake Twenty (fake-twenty.js), a temp-dir ledger (ledger.test.js; fake-ledger.js is the demo's). Each fake's demo*() is what its `fake` mode and `npm run demo` run
docs/plan.md     the plan: what is still intended, with dated notes for what shipped or was superseded
.env.example     every variable, commented; preferences.example.json is the preferences file's shape
```

The four seams — **source → item → rule → delivery**, with **act** as the
one path every surface calls — are the design (`README.md` §The shape).
They stay intact: a new source is a file in `sources/` and a file in
`rules/`, never a branch in the runner; a new surface (a button, a page, a
command) ends in `lib/actions.js` `act()` and nowhere else; a rule is pure
and returns a reason or null; delivery reads decisions and writes what it
did onto them.

**M3 is the worked example, and what it did to the seams is the pattern to
copy.** The calendar needed four things GitHub had not asked for, and each
was answered by widening a seam for every source rather than by naming one:
a source may declare `due(ctx)` (what became true because time passed, not
because the far end changed) and `describeCursor(state)`; delivery picks its
shape from `item.kind`, never from `item.source`; what Done does outside
triage is a map keyed by source name, in `server.js`, as the time curve
is (below). Nothing in `lib/` says "calendar" and
nothing in `lib/` says "github" — true since G1 (plan §16, 2026-10-15)
moved the GitHub mark-as-read out of `lib/actions.js` and into the
source's own `mark`. If a fifth thing is needed for Gmail, that is the
test it has to pass.

**M5 widened the source seam once more, and the same rule applied.** A
source may declare `time(item, { rules })` — which curve time follows for
this item — because a reply someone is waiting on gets *more* urgent as it
sits while a merged pull request is news and goes stale, and no single
decay can be both. It is a map keyed by source name, built at boot from the
registered sources, exactly as `due()` and `describeCursor()` were: nothing
in `lib/rank.js` knows what a thread or a meeting is. The one thing to copy
from it is that the *rules that fired* come in with the item — for most
sources which curve applies is a question about what happened, not about
what kind of thing it is.

**The ledger widened it a third time (#17), and it is the pattern for every
state-shaped source after it.** A source may declare `reconcile(ctx)` —
the current set of keys and whether the read was complete — and the
runner resolves what has left the set and reopens what the source itself
resolved that has come back (`lib/pipeline.js` `reconcile`, beside
`wake`). Nothing in `lib/` knows what a queue row is; an open issue or a
CRM task (plan §12.3) is the same declaration. Two rules travel with it:
an incomplete read resolves nothing, and a resolution is attributed to the
source (`actions.by = source:<name>`), never to the person.

**Open issues (#19) used that declaration from inside a source that is
also a feed, and the seam gave one more inch, generically.** A `reconcile`
may return `governs(item)` beside its set — which of the source's items
the set speaks for — because the GitHub inbox brings pull requests that
were never in the open set of `TRIAGE_ISSUES` and must not be resolved for
being absent from it. The runner passes the predicate through and
`lib/pipeline.js` applies it, knowing nothing about modes; the ledger
returns none and governs everything. And a `reconcile` may return `null`
— nothing to say — so a mode that is off does not log a skipped read a
minute. The mode is recorded on the item (`data.mode = 'open'`) by
whichever half of the source writes it, because `upsertItem` replaces
`data` whole: both halves write the same fields for an issue, and the
inbox keeps the `thread_id` only it knows. A second mode on a source is
therefore two halves of one `poll`, one cursor with two parts, and one
`reconcile` — never a second source keyed the same way, which would be two
rows for one issue.

**Plan §14 widened it a fourth time, and this one is about the person
rather than the source.** A source may declare `project(item)` — which
project one of its items belongs to (`sources/github.js` returns the repo,
`sources/calendar.js` the calendar id, `sources/ledger.js` declares none)
— because what interrupts you is personal, and the thing the owner wanted
to say the first time this system sent a real interrupt was "a human
replying to me *in this one project*". It is a map built at boot from the
registered sources, exactly as `shapes` and `due()` are, and nothing in
`lib/` or `deliver/` knows what a project is. What resolves against it is a
list of **statements** across four layers (the default set, `TRIAGE_PREFS`
globally, `TRIAGE_PREFS` per project, `TRIAGE_INTERRUPT`), and the rule is
one sentence: *the most specific statement in the highest layer wins*. Two
things travel with it. The defaults are a statement like any other on layer
0 — there is no privileged built-in path, which is what stops out-of-the-box
and customised drifting into different code. And every refusal names the
statement that made it, on the decision row and through
`GET /api/interrupts`: a configuration nobody can interrogate is one nobody
can adopt, which is the whole argument of §14.6.

**G1 (plan §16, 2026-10-15) widened it a fifth time, for a second forge,
and the two declarations are about identity and about writing.** A source
may declare `whoami(ctx)` — who you are on it, resolved once at boot into
an identity map, so `me` in a rule is the GitLab username on a GitLab item
and the GitHub login on a GitHub one, while `items.user` stays the one
person (the GitHub login when GitHub is on, else GitLab's) — and
`mark(item, ctx)`, what Done does at the far end, which is the `marks` map
`server.js` has always built with the entry now supplied by the source
rather than written beside it. Both are maps built at boot from the
registered sources, like `shapes` and `projects`. What proved the
abstraction cost nothing: `rules/github.js` became `rules/thread.js` and
the GitHub fixtures passed unchanged.

If a change wants to cross a seam, that is the design
changing, and it goes in `docs/plan.md` first.

**There is no model here, and no seam for one.** Plan §13 (2026-09-11,
shipped as #14) took the LLM out of triage entirely — adapter, tables,
columns, config, tests — because triage is a source, not a mind: it emits
deterministic, explainable, replayable structure to the seat that holds
the *other* evidence, and that seat reads it through the API. The rank is
the three structural terms in `lib/rank.js` and nothing else; `decisions`
is what the rules observed; the one write path is `act()`, because an
action is a fact about what the person did and not an opinion about what
they should do. A change that wants to put a judgement into
`items.features`, call a model from anywhere in this tree, or add a write
path that carries an opinion is path 2 wearing path 1's clothes (§13.5) and
goes to the plan first.

## The plan lives here

`docs/plan.md`. Sections 6 (stack, repo, deployment), 7 (milestones) and 10
(decisions) are decided and are not re-litigated in a build session. What
each milestone actually made of them is in `README.md`; where the two
differ, the README describes what shipped and the plan describes what was
intended, and a deviation worth keeping is written into the plan as a
dated note rather than silently absorbed. M0 and M1 have shipped as PRs
#1 and #2, M2 — LLM summaries and grey-band scoring — as #4, and the swap
to Gemini as #5. M3 (the calendar source) shipped as #6; the reframe of
§§11–12 as #7 and #8, plan only. The **interrupt path** — delivery through
an incoming webhook, `TRIAGE_SLACK=webhook|app|off` — is #9, and it is not
a milestone: it is the last piece of M0's promise, which had never
delivered a P0 because the Slack app did not exist. #10 removed the five act
buttons from the webhook's message, which had rendered and done nothing.
**M5 · rank it** is #11: every match rather than the first, `lib/rank.js`,
one ordered list, the bounded backfill, and the interrupt set that answers
§11.9's last open call. #12 changed the model id and #13 wrote §13, which
**#14 made true**: the LLM is out of the tree, `decisions.acted` with it.
#15 dropped the P1 batch and the P2 digest (§11.3), and #16 pruned the plan
to what is still intended. **#17 is the ledger source** (§12.3 item 1,
§12.2's `reconcile`): the first state-shaped source, the `answer` action,
and the ask grammar — the first piece of M7. **#19 is the second: open
issues as state** (§12.3 item 2), a mode on the GitHub source with
`governs`, and the two state rules that make an agent-filed issue visible.
**The household's to-do lists (§12.8) are the third**, and the one worth
copying from: it is a state-shaped source that needed **no** widening of
the seam at all — `poll`, `reconcile`, `time`, `project` and a `marks`
entry, and nothing in `lib/` learned a thing. It is also the first source
that *writes*: Done calls `todo.update_item`, through the same `marks`
map GitHub's mark-as-read has always used, which is the seam that already
existed rather than a new one. **The CRM is the fourth and the last of
M7** (§12.3 item 3): Twenty's open tasks as state and anybody else's edit
as an event, on the read-only key. It needed no widening either — `poll`,
`due`, `reconcile`, `time`, `project` — and its clock half is the first
that watches the *source* rather than the world: no complete read within
the stale window is a P0. Edits count there, by fingerprint, which is the
one place triage is not blind to them (§12.4). What is left of M7 is the
quota (§12.5), if a source ever needs it. **§14 is the interrupt path
becoming configurable** — the four layers, the `project(item)` seam, and
the mention that makes a webhook's message a notification rather than a
badge; it is not a milestone either, it is what the first real interrupt
this system sent turned out to need. **§16 (2026-10-15) is triage for
strangers** — flexible on the input, opinionated on the output — and its
G1, the forge layer and GitLab, is the first port (#2 in this
repository's numbering); G2, the webhook shapes, is #3; G3, the demo —
`TRIAGE_DEMO=1`, every fake at once — is the third; G4 (the calendar as an
ICS feed) follows, and G5 (the Slack app surface) waits on the app. **M6 · learn it**
is structural only — revealed preference from `actions`, saturation and
spread, hysteresis tuning (§7) — and is not gated on them. Gmail moves
behind M6 (§11.8) and is not started.

## Running it: one worktree, one instance

**`TRIAGE_DEMO=1` (`npm run demo`) is every fake below at once** — both
forges, the calendar, the ledger, Home Assistant and the CRM — with the
store in memory unless `TRIAGE_DB` names one and delivery off unless
`TRIAGE_WEBHOOK_URL` is loopback (plan §16, G3). A source's own `off`
leaves one fake out; each `fake` mode still works on its own, because a
worktree proving one source wants one fake, not six. In a worktree, put
`TRIAGE_DEMO=1` in its `.env` — the demo reads a `.env` only when
`TRIAGE_ENV` names it, which the worktree's unit does.

Every task is a worktree on its own branch with its own running instance:
its own `.env` (gitignored, handed to the process as `TRIAGE_ENV`), its own
store (`TRIAGE_DB`), its own port (`TRIAGE_PORT`, bound to 127.0.0.1). The
production `.env` is never read by a worktree — `TRIAGE_ENV` *replaces*
the default file, it does not layer on it — so a worktree starts with every
source off except GitHub and turns on only what its `.env` says.

```bash
cp .env.example .env            # then fill in what this task needs
TRIAGE_ENV=$PWD/.env TRIAGE_DB=/tmp/triage-scratch.db TRIAGE_PORT=3301 node server.js
npm test                        # node --test, in the worktree
```

How a worktree is published (a hostname, a reverse proxy, a unit) belongs
to the box it runs on, not to this repo; the project ships no container and
no compose file, on purpose — the service is one Node process with
`node:sqlite` and two npm dependencies, and that is the whole stack.

**A worktree runs with the calendar off unless you say otherwise**: a
worktree's `.env` names no feed and replaces the file the Google
credentials sit beside, so `TRIAGE_CALENDAR` resolves to off and the
source does not register. Three options. `TRIAGE_CALENDAR=fake` runs the
canned feed from `test/fake-calendar.js` behind the real feed reader — a
meeting twelve minutes out, an unanswered invitation, an all-day entry, a
focus block, one you declined, a daily standup with one occurrence moved,
and one a week away — so the parse, the expansion, the poll, the clock's
alarm, every rule, reconcile and the page's rows are all exercised with no
feed at all; every title says `(fake)`. `TRIAGE_CALENDAR_FILE` names a
`.ics` on disk you can edit between polls, which is the quickest way to
see a reschedule re-tier or a deletion resolve. Or point it at a real feed
(`TRIAGE_CALENDAR_URL`, and `TRIAGE_CALENDAR_ME`) or, on the other path,
the real Google credentials by name — read-only either way and costing
nothing, but it is your real calendar in a branch's database, so say so in
the PR. Nothing a worktree does can write to a calendar: a feed cannot be
written, the Google scope is `calendar.readonly`, and Done on a calendar
item is local by construction.

**A worktree runs with Home Assistant off** for the same reason.
`TRIAGE_HA=fake` is the answer, and it is a better one than the calendar's:
the canned lists in `test/fake-ha.js` are mutable, so the poll, every rule,
reconcile and the one write (Done ticking an item off) are all exercised
for real. Do not point a worktree at a real Home Assistant to "check": the
token is not read-only, because Home Assistant has no such thing.

**A worktree runs with the ledger off** until `TRIAGE_LEDGER` names a
queue file. Pointing it at the real one is fine — the read is local and
read-only, and the worktree's own store is the only thing reconcile
touches. `test/ledger.test.js` writes a real queue file to a temp dir,
which is the shape to copy for a canned one.

**A worktree runs with the CRM off** until you give it the three lines
that turn it on — `TWENTY_URL`, `TWENTY_API_KEY` (a key bound to a
read-only role, never printed) and `TRIAGE_CRM_ME` — plus
`TRIAGE_CRM_PROJECTS` so statements can scope to a company, and
`TRIAGE_CRM_AGENTS` if your own agents write through the API. Unlike Home
Assistant, **pointing a worktree at the real Twenty is fine**: the key's
role can update nothing, and the source has no write path to try. Its
first read is a baseline and interrupts on nothing, so the proof of the
interrupt itself is `TRIAGE_CRM=fake`, where a colleague hands you a task
on the second read (and rewords one you handed them, which is a P1 and
does not); the live run proves the read, the counts and the unread alarm
(a bad `TWENTY_API_KEY` with a short `TRIAGE_CRM_STALE_MIN`). One trap:
switching from fake to live on one store makes the live read a
non-baseline, and every task anybody else last touched reads as news.
Prove the live read on a store of its own.

**A worktree runs with GitLab off** until `GITLAB_TOKEN` names a token (or
`glab auth token` holds one): the source does not register and the boot
log says so. `test/fake-gitlab.js` is the canned GitLab the suite runs
against — Alice's todos, a merge request of hers with a reply on the diff,
one she is asked to review, an open issue assigned to her — and
`test/gitlab-source.test.js` proves the inbox, the discussions, Done
marking the todo done and the open set reconciled through the runner. A
real token in a worktree reads your real GitLab and Done marks a real todo
done; say so in the PR.

**A worktree runs with Slack off, always** — **no `SLACK_` line of any
kind** in a worktree's `.env`. Two Socket Mode connections to one Slack app
would *both* receive every button press, and two bots would both DM you;
and `SLACK_WEBHOOK_URL` needs neither a socket nor a token, so it would
post to the real channel from a branch with nothing to stop it. Only
`main`, the production unit, talks to Slack.

A worktree proves a change through the page and the API — `GET
/api/decisions` shows what would have been sent and why, `POST
/api/items/:id/act` exercises the one action path, and the buttons on the
page do the same — and, for delivery itself, **against a local listener it
starts, never against `hooks.slack.com`**. `TRIAGE_WEBHOOK_URL` pointed at
`http://127.0.0.1:<port>/hook` is the whole setup (a loopback URL reads as
`generic`; `TRIAGE_NOTIFY=slack` or `discord` to see that payload instead);
whatever the listener prints is byte for byte what the far end would have
received, which is a better proof than a message arriving. Slack-shaped
code — blocks, handlers — is covered by the tests against the fakes
(`test/fake-webhook.js` is the webhook's, whatever its shape); a change to the real Bolt
wiring is verified on `main` after the merge, by the deploy.

What a worktree *does* do for real: poll GitHub every minute with the same
token production uses (rate limits are per token, and the notifications
endpoint says how often to poll; two or three instances are fine), and
mark a thread read when Done is pressed on its page. That is a real write
to your real inbox. Press Done on a worktree only when you mean it.

## Tests

`node --test` — `npm test` in the worktree. The suite
runs against an in-memory store with a fake GitHub, a fake Slack and a
fake calendar, and needs no token, no network and no running instance; it takes well under a
second. Run it before every push. A rule change gets a case in
`test/rules.test.js` (and, if it changes what a rule is *worth*, one in
`test/rank.test.js`); a change to the scorer gets one in `test/rank.test.js`,
to the list in `test/lists.test.js`, to the counts in `test/aggregates.test.js`, to a report in `test/reports.test.js` (a new report is an entry in `lib/reports.js`'s registry and a case there), to what may fire Slack in
`test/interrupts.test.js` (the layers, the statement grammar and the project
seam are all there), to how the preferences file is read in
`test/config.test.js`; a change to what a message says gets one in
`test/slack.test.js` or `test/handlers.test.js` against `deliver/blocks.js`;
a change to delivery in webhook mode gets one in `test/slack.test.js`
(the webhook section at the end: the windows and the guards) or
`test/notify.test.js` (the client, the three shapes, the mention per
endpoint);
a change to acting gets one in `test/actions.test.js` or `test/api.test.js`;
a change to the calendar's feed parser or recurrence expansion gets one
in `test/ics.test.js`; a change to either calendar reader, the clock's
alarm or the calendar's reconcile gets one in `test/calendar-source.test.js`
(the Google half first, the feed below it, against `test/fake-calendar.js`,
which holds both);
a change to the GitLab source — the todos, the discussions, the system
notes, Done marking the todo, the open set — gets one in
`test/gitlab-source.test.js` against `test/fake-gitlab.js`; a change to the
forge clients (auth headers, the per-owner token, paging, the web base) or
to the token fallbacks gets one in `test/forge-api.test.js`;
a change to the ledger's parsing, rules, reconcile or answers gets one in
`test/ledger.test.js`, which writes a real queue file to a temp dir;
a change to what the demo boots — which fakes, the store, what may be
delivered — gets one in `test/demo.test.js`, which resolves the config and
boots `server.js` itself on every fake (a fake's own canned world is
tested beside its source);
a change to the CRM source — who counts as somebody else, the
fingerprint, its rules, its reconcile or the unread alarm — gets one in
`test/crm.test.js`, against `test/fake-twenty.js`, which is the real
`TwentyApi` over a fake `fetch` that pages for real and whose records you
edit between polls as a person would;
a change to the Home Assistant source, its rules, its reconcile or what
Done writes gets one in `test/ha.test.js`, against `test/fake-ha.js` —
which is the REST service-call API over lists it actually mutates, so
ticking an item off and the reconcile that follows are both real. Its
dates are derived from `NOW` rather than written down, because a due date
is a *local* day and CI runs in UTC.
`bin/replay.js owner/repo#n` (or `group/project!n`) is the other tool: it
runs the rules over a real thread's history and prints what each step
would have decided, reading the forge and writing nothing — how "would
that have been P0?" is answered without waiting for the next one. It is
for threads and stays that way: a calendar has no thread to replay, and its equivalent question
is answered by `POST /api/sources/calendar/run` against
`TRIAGE_CALENDAR=fake`, which decides everything and delivers nothing.

## Deploy

**What a deploy needs is `README.md` §Deploy; how one happens is not this
repo's business.** Triage is an app, and the box it runs on owns deploying —
the unit, the poll that notices a merge, the snapshot, the restart and the
health check all live with that box's own configuration. A copy of someone
else's mechanism is the thing that goes stale, so none of it is restated
here.

The one thing to know while working in this repo: **merging is what deploys**.
Agents open the pull request, the owner merges it, and production follows on
its own within a couple of minutes. So a change that needs something done
first — a credential, a new `.env` line, a manual step, a migration that has
to be watched — says so at the top of the pull request body, because nothing
will pause to read it later.

Nothing on a task branch is ever pointed at by the production unit.

## Working here

- Worktree-first: one worktree per task, branch name is the worktree name;
  never edit the `main` checkout. Work leaves as a pull request against
  `main`; agents do not merge.
- Configuration is the environment or the `.env` file `TRIAGE_ENV` names.
  Nothing is read from the repo, and no secret is ever committed — the
  manifest and the unit file are not secrets; tokens are. **No personal
  configuration in the defaults**: a default is for a stranger's box, and
  a list, a path or a name that is one person's goes in `.env`, not in
  `lib/config.js`.
- Comments explain the mechanism and the reason for it, and may carry the
  date a call was made; they do not name who made it.
- The store is data, not source: no migrations that need a hand-run step,
  and `lib/store.js`'s idempotent SQL at boot is the only schema path.
- The PR body says what shipped, what was decided and how it was verified.
