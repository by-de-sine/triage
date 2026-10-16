# Contributing

How to work on triage. What it does is in the [README](README.md) and
[docs/](docs/); how it is built is [architecture](docs/architecture.md);
what is still intended is the [plan](docs/plan.md).

## Setup

Node ≥ 24 and nothing else. `npm ci` is only needed to run the Slack app
path (`TRIAGE_SLACK=app`); the tests, the demo and a webhook-delivering
server all run without `node_modules`.

```bash
npm test          # node --test: in-memory store, every source faked, no network, under a second
npm run demo      # every source on its fake at http://127.0.0.1:3300
```

## Where things are

```text
server.js        boot: config, store, the sources that resolve, delivery, the runner, the API
sources/         one file per source — github, gitlab, calendar, ledger, ha, crm
rules/           thread.js (both forges), calendar, ledger, ha, crm — ordered, named, each with a claim
deliver/         slack.js (the guards and the answer on every decision), notify.js (the webhook client),
                 messages.js (the slack / discord / generic shapes), blocks.js (the app's messages and views),
                 handlers.js (the app's buttons, /triage, Home), interrupts.js (what may interrupt, four layers)
lib/             store, runner, pipeline, rules, actions (act), lists, rank, backfill, aggregates, reports,
                 api, config, forge-api + forge (both forges), ics, google-api, ha-api, twenty-api, util
public/          the list page and the stats page — static, no build
bin/replay.js    run the rules over one real thread, step by step, writing nothing
bin/google-consent.js  the one browser step for the Google calendar path
slack/           the Slack app manifest
test/            the suite, and a fake for every source (fake-github, fake-gitlab, fake-calendar,
                 fake-ha, fake-twenty, fake-ledger, fake-webhook)
docs/            the documentation and the plan
```

## The seams

**Source → item → rule → delivery**, with **act** as the one path every
surface calls ([architecture](docs/architecture.md)). Keep them intact:

- A new source is a file in `sources/` and a file in `rules/`, never a
  branch in the runner. Nothing in `lib/` or `deliver/` may learn its name.
- A new surface — a button, a page, a command — ends in `lib/actions.js`
  `act()`.
- A rule is pure and returns a reason or null.
- Delivery reads decisions and writes what it did onto them, and picks a
  message's shape from `item.kind`, never `item.source`.

When a source needs something the seam does not offer, **widen the seam
for every source** rather than naming one. That is how every optional
member of the source contract arrived — `due` and `describeCursor` for the
calendar, `time` for ranking, `reconcile` and `governs` for state-shaped
sources, `project` for interrupt preferences, `whoami` and `mark` for a
second forge — each a map built at boot from the registered sources. The
test a change has to pass: nothing in `lib/` says the new thing's name.

A change that crosses a seam changes the design, and goes in
[`docs/plan.md`](docs/plan.md) first.

**There is no model here, and no seam for one** ([plan §13](docs/plan.md#13-the-reframe-that-removes-the-model-triage-is-a-source-not-a-mind)).
The rank is the structural terms in `lib/rank.js`; `decisions` is what the
rules observed; the only write path is `act()`. A change that writes a
judgement into the store, calls a model, or adds a write path that carries
an opinion goes to the plan first.

## Running an instance

Give each instance its own `.env`, store and port, so it never touches
another's:

```bash
cp .env.example .env     # fill in what this task needs
TRIAGE_ENV=$PWD/.env TRIAGE_DB=/tmp/triage-dev.db TRIAGE_PORT=3301 node server.js
```

`TRIAGE_ENV` **replaces** the default `.env`; it does not layer on it. So
an instance starts with only what its own file says — usually GitHub, with
the token `gh` holds.

Each source has a `fake` mode, and one source at a time is usually what a
change wants (`TRIAGE_DEMO=1` turns on all six):

| Source | To exercise it | Notes |
|---|---|---|
| GitHub | `TRIAGE_GITHUB=fake`, or a real token | a real token reads your real inbox — and **Done marks the real thread read**. Don't set `TRIAGE_GITHUB_ALL=1` on a token another instance uses: reading every thread can spend the token's hourly rate limit |
| GitLab | `TRIAGE_GITLAB=fake` | a real token makes Done mark real todos done |
| Calendar | `TRIAGE_CALENDAR=fake`, or `TRIAGE_CALENDAR_FILE` naming a `.ics` you edit between polls | read-only whatever you point it at |
| Ledger | `TRIAGE_LEDGER` naming a queue file | read-only; the real file is safe |
| Home Assistant | `TRIAGE_HA=fake` | never a real Home Assistant: its token is not read-only |
| CRM | `TRIAGE_CRM=fake` (the interrupt arrives on the second read), or a real read-only key | a real key is safe, but use a fresh store — see [crm.md](docs/sources/crm.md#who-is-not-you) |

`POST /api/sources/<name>/run` polls now and answers with what was decided.

### Proving delivery

**Never point a development instance at a real Slack or Discord.** Two
instances on one webhook post everything twice; two on one Slack app both
receive every button press. Prove delivery against a listener you start
yourself — what it prints is byte for byte what the far end would receive:

```bash
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(b);s.end('ok')})}).listen(3398)"
```

```bash
TRIAGE_WEBHOOK_URL=http://127.0.0.1:3398/hook   # loopback may be plain http
TRIAGE_NOTIFY=slack                             # or discord; loopback defaults to generic
TRIAGE_DELIVER_MAX_AGE_H=168                    # optional: let the last week's interrupts through on a first read
```

`GET /api/decisions` shows what was sent, held or not delivered, and why.
The Slack app's Bolt wiring can only be exercised against a real app.

### Would that have been P0?

```bash
node bin/replay.js owner/repo#123      # or group/project!12 on GitLab
```

Runs the rules over a real thread's history step by step, reading the
forge and writing nothing. For the calendar, the equivalent is
`POST /api/sources/calendar/run` against `TRIAGE_CALENDAR=fake`.

## Tests

`npm test` before every push. Where a change's test goes:

| Change | Test file |
|---|---|
| a rule | `rules.test.js` (and `rank.test.js` if it changes what the rule is worth) |
| the ranker | `rank.test.js` |
| the list, the counts, a report | `lists.test.js`, `aggregates.test.js`, `reports.test.js` (a new report is an entry in `lib/reports.js` and a case here) |
| what may interrupt — layers, statements, projects | `interrupts.test.js` |
| reading config or the preferences file | `config.test.js` |
| what a message says | `slack.test.js` or `handlers.test.js`, against `deliver/blocks.js` |
| webhook delivery — windows, guards | `slack.test.js` (the webhook section) |
| the webhook client, shapes, mentions | `notify.test.js` |
| acting | `actions.test.js`, `api.test.js` |
| the ICS parser and recurrence | `ics.test.js` |
| either calendar reader, the alarm, reconcile | `calendar-source.test.js` |
| the GitHub source | `github-source.test.js` |
| the GitLab source | `gitlab-source.test.js` |
| the forge clients, tokens, paging | `forge-api.test.js` |
| the ledger | `ledger.test.js` (writes a real queue file to a temp dir) |
| Home Assistant | `ha.test.js` (dates derived from `NOW` — a due date is a *local* day and CI may run in UTC) |
| the CRM | `crm.test.js` |
| what the demo boots | `demo.test.js` |
| the runner — ingest, the clock, reconcile, snooze wakes | `pipeline.test.js` |
| the store | `store.test.js` |

The fakes are real clients over a fake far end where it matters:
`fake-twenty.js` pages for real, and `fake-ha.js` mutates its lists, so
Done and reconcile are exercised for real.

## Conventions

- **Configuration is the environment** or the `.env` file. Nothing is read
  from the repository, and no secret is ever committed.
- **No personal configuration in defaults.** A default is for a stranger's
  machine; a list, a path or a name that is one person's goes in `.env`,
  not `lib/config.js`.
- **Refuse what you do not recognise.** A bad mode, statement or name fails
  the boot rather than reading as the default.
- **The store is data, not source.** `lib/store.js`'s idempotent SQL at
  boot is the only schema path — no migration that needs a hand-run step.
- **Comments explain the mechanism and the reason for it.** They may carry
  the date a decision was made; they do not name who made it.
- **The docs describe what shipped; the plan describes what is still
  intended.** A deviation worth keeping is a dated note in the plan.

## Pull requests

Branch from the current `main`; one branch per task. The PR description
says what shipped, what was decided and how it was verified.

**Merging deploys.** Anything a deploy needs first — a credential, a new
`.env` line, a manual step — goes at the top of the PR description, because
nothing pauses to read it later. See [deploying](docs/deploy.md).
