# triage — the plan

Prepared 2026-09-08 from a planning conversation. A plan, not an
implementation. Section 9 lists what only you can do; everything else is
decided here and recorded so the build session does not re-decide it.
Lived in the host's own configuration repository while M0 and M1
were built (the prompt that started the build was beside it); moved here
2026-09-09 so the repo carries its own plan. Sections 6, 7 and 10 are
decided; `README.md` says what the milestones have made of them. "This
repo" below means the host's own configuration repository where it names `services/triage/`.

**Pruned 2026-09-12 (#16), after §13 shipped as #14.** The rule: the README
describes what shipped, the plan describes what is still intended. A
section that shipped, or that §13 superseded, is collapsed here to a dated
note carrying the decision and where it now lives; the argument is in git
(`git show 614ad22:docs/plan.md` is the last full text). Nothing below is
struck without a date.

## 0. The recommendation in one paragraph

Build it, small, as a Node service on the host in the exact shape its other services
already have, with Slack as the only interface you touch day to day. Nothing
off the shelf does the three things you actually asked for together —
Slack-first, "someone replied to *my* comment" as a first-class signal, and a
queue you can snooze and reorder — and the one tool that comes close
(Octobox) is a Rails web UI that only knows GitHub. The system is a
**normalised item store with rules on one side and Slack on the other**;
GitHub is source one, calendar and mail are sources two and three~~, and an LLM
touches only the items the rules cannot decide~~ (struck 2026-09-11, §13:
no model in triage). Start by *logging and scoring
everything without delivering most of it*, so the second week is spent
tuning tiers against real data rather than guessing.

## 1. What is out there, and why it is not the answer

*Evaluated 2026-09-08, and the answer is still build.* **Octobox** is the
closest thing — a self-hostable Rails web inbox for GitHub notifications —
and it is a web UI rather than Slack, GitHub only, with no "reply to my
comment" signal and no other sources. GitHub's own Slack app is a firehose
per channel with no per-item state; Gitify and Neat are desktop-bound;
Graphite, Pullpo and Reviewable are PR-shaped SaaS; n8n, Huginn and
Node-RED are plumbing that would need a database beside them anyway; and a
Hermes-style life agent is the endpoint, not the start — it needs a clean
item store and an action API to sit on (§13 is where that ended up).

The notifications API itself is why a wrapper is needed rather than a
filter: it reports a *reason* per thread but cannot say "a reply landed on
a thread you commented in" — that signal only exists by fetching the
thread's comments and diffing them against what you last saw. Webhooks
would give it for free, but only on repositories you administer, and most
of the owner's notifications are on repositories the owner does not. So polling plus a
per-thread comment diff is the foundation on every repo.

## 2. Architecture

*Decided 2026-09-08; built as M0 (#1) and unchanged in shape since: one
process, one SQLite file, four seams — source → item → rule → delivery,
with act as the one path every surface calls (`README.md` §The shape;
`AGENTS.md` for how to work on them). §11 changed what the tiers are for,
§12 widens the source seam on paper, §13 removed the model's seam.*

## 3. The tiers, and what lands in each

*Decided 2026-09-08; shipped as M0 and M1 (#1, #2); the table is
`README.md` §The tiers. Since then: the tier is a category and one input
to the rank, not a channel (§11, 2026-09-10); what interrupts is the rule
list of §11.6 (M5, #11); the P1 batch and the P2 digest are gone (#15,
2026-09-12); the quiet and coalesce windows survive on the interrupt path.
"CI failed on your PR" is still deferred — it needs check runs, which the
notifications API does not carry.*

## 4. Dumb rules versus LLM: the mix

*Decided 2026-09-08; built as M2 (#4, then Gemini instead of Haiku in #5 on
2026-09-10, then `gemini-3.5-flash-lite` in #12 on 2026-09-11 after Google
retired the 2.5 model). **Superseded 2026-09-11 by §13 and removed from
the tree 2026-09-12 (#14).** What survives is the first sentence: nearly
every GitHub signal is structural, and rules decide tier. The two jobs
this section gave a model — a one-line summary, a second opinion on the
grey band — were per-item, which §13.1 names as the defect; the
paid-tier condition, the cost notes and the four M2 deviations retired
with the caller. The reasoning now lives in §13.*

## 5. Sources two and three

> *Note, 2026-09-10 (§12):* **there are more than three, and this is no
> longer the ordering.** §12 adds the ledger, issues *as state*, and
> the CRM — all state, which the runner cannot yet reconcile — and drops
> the calendar's weight.


Both Google. The seam is the same `Source` interface, so each is a file:

- **Calendar** — poll the primary calendar (`events.list` with `syncToken`);
  items are events in the next 48 h; P0 is "starts in 15 min", P1 is a new
  invitation, P2 is the day-ahead brief, in the list. This is the cheapest
  second source and proves the interface is not GitHub-shaped.
- **Gmail** — `history.list` against a label you choose (`triage`), never
  the whole inbox to start; items are threads~~; the grey band is *all*
  mail, which is where the LLM scorer starts paying~~ (§13: no scorer; mail
  is ranked by the same structural terms as everything else). Third, because the
  OAuth consent screen and token refresh are the fiddly part and you want
  the pattern settled on calendar first.

Both need a Google Cloud project with OAuth client credentials in
`~/.config/triage/`. Ring 0 work, batched in section 9 but not
needed until milestone 3.

> *Note, 2026-09-09 (M3, PR #6):* built as written. What it did to the
> seam — `due(ctx)`, `describeCursor`, `item.kind` for the DM's shape, a
> per-source map for what Done does outside triage — is the pattern
> `AGENTS.md` tells the next source to copy; the window and the cursor are
> `README.md` §The shape. The live poll still waits on §9 item 5.

## 6. Stack, repo, deployment — decided

- **Node 24, plain `node:http`, `node:sqlite`, `@slack/bolt`, `node --test`.**
  No framework, no ORM, no bundler: the same shape as the host's other services.
  GitHub and Google are stdlib `fetch`. ~~`@anthropic-ai/sdk`~~
  ~~`@google/genai`~~ — gone with the model (2026-09-12, #14); Bolt is the
  one dependency, and only reached under `TRIAGE_SLACK=app`.
- **Repo `acme/triage`**, public is fine (no secrets in it, ever).
  Laid out per the host's own docs: `~/src/triage/.bare`, `main/`, one worktree
  per task.
- **Runs on the host as a user systemd unit** from `~/src/triage/main`;
  the unit and the `publish` file live in the host's own configuration
  repository, because the deployment is machine meta-work — the
  one deliberate deviation from the services doctrine, since unlike its other services
  the code *is* developed. Deploy is `AGENTS.md` §Deploy.
- **HTTP API**, bound to 127.0.0.1, published by Caddy at
  its hostname. The surface is `README.md` §The API; it is
  what Claude Code sessions and the chief-of-staff seat (§13) use.
- **Secrets** in `~/.config/triage/.env`, mode 0600: the Slack
  line(s), optionally `GITHUB_TOKEN`, and Google's two credential files
  beside it. ~~`GEMINI_API_KEY`~~ left the box with #14. Nothing in the repo.
- **Single user, but not single-user shaped:** items carry a `user` column.

## 7. Milestones

Each is a PR or two and ends with something you use.

- **M0 · see it (week 1).** GitHub source polling every minute; items
  stored, scored, tiered, every decision logged; **only P0 delivered**, as
  a Slack DM with the Open button. `/api/items` and `/api/decisions`
  work. Success: the next reply to one of your comments reaches you in
  Slack inside a minute, and you can read why everything else was not
  sent. *Shipped as #1 (2026-09-08).*
- **M1 · act on it.** Done / Snooze / Later / Mute buttons; `/triage`
  slash command and Home tab lists; ~~P1 hourly batches and the P2 daily
  digest~~ (retired 2026-09-12, #15); quiet and coalesce windows in
  config; the list page. Done marks the GitHub thread read. *Shipped as
  #2 (2026-09-09).*
- **M2 · make it readable.** Shipped as #4 (2026-09-09) and #5; **removed
  by §13** (#14, 2026-09-12). Summaries and a second opinion on the grey
  band were the wrong shape — per-item questions to a model that should
  be asked once, across the list, by the seat that holds the other
  evidence.
- **M3 · second source.** Google Calendar per section 5. Proves the
  source seam — and did, by widening it for every source rather than
  naming one: `due(ctx)` for the clock, `describeCursor` for health,
  `item.kind` for the DM's shape, and a per-source map for what Done does
  outside triage (§5 note, 2026-09-09). Gmail follows
  the same pattern when you want it, and the test it has to pass is that it
  needs no sixth.
- ~~**M4 · the agent.** Not planned here; triggered by data.~~ **Superseded
  2026-09-11 (§13.2):** the intelligence is the chief-of-staff seat's, a
  decision for the host's own harness rather than a triage milestone, and it reads triage
  through the API. The old trigger (~2,000 items with actions on them) is
  history.
- **M5 · rank it** — §11, added 2026-09-10; **shipped as #11** the same
  day. Every match rather than the first, `lib/rank.js`, one ordered list,
  the bounded backfill, the interrupt set.
- **M6 · learn it** — structural only, since §13: revealed preference
  from `actions` (§11.4 term 4, with §12.2's rule that only owner-authored
  actions count), saturation and spread (§11.4 term 6; the cheap half is
  `?group=` and `/api/aggregates`), and hysteresis tuning against real
  use. ~~Effort and relevance as model features~~ — gone with the model
  (§13.4). Gated on M5 having run long enough to produce actions worth
  learning from: one action on record at 2026-09-11.
- **M7 · the sources that matter** — §12.6: ~~the ledger and
  `reconcile`~~ (shipped 2026-09-12, #17), ~~issues as state~~ (shipped
  2026-09-13, #19), ~~the CRM~~ (shipped 2026-10-03, §12.3 item 3).
  Numbered after M6 but not gated on it. Only the quota (§12.5) remains,
  and it still has no trigger.
- **M4** stays a trigger rather than a position; the numbers do not imply
  an order. Gmail moves behind the ranker (§11.8).


## 8. Slack app manifest

*The manifest is `slack/manifest.yml`, with the three tokens named in its
comments. The app path is superseded in practice by the incoming webhook
(2026-09-10, §9 item 2 and §11.6) and deliberately not deleted (§10): it is
one `TRIAGE_SLACK=app` away if buttons, `/triage` and the Home tab are
ever worth an app.*

## 9. Ring-0 actions, batched — the only things the build cannot do

1. **Create the repository** `acme/triage` on github.com and grant the
   ring-2 fine-grained token access to it. Done before M0.
2. ~~**Create the Slack app** from section 8 and write the three values into
   `~/.config/triage/.env`.~~ **Superseded 2026-09-10 (§11.6 note):**
   an **incoming webhook URL** in that `.env` as `SLACK_WEBHOOK_URL`,
   pointed at a channel the owner is alone in. Done 2026-09-10; the privacy
   requirement is in `README.md` §Run it and in the `.env`'s own comments.
   Strictly Slack issues a webhook *through* an app; what is avoided is
   its configuration, and an existing webhook avoids even the creation.
3. ~~An Anthropic API key~~ ~~A Gemini API key on a billing-enabled Google
   Cloud project, into the same `.env` as `GEMINI_API_KEY`~~ **Obsolete
   2026-09-12 (#14, §13): not done, not needed — the key leaves the box
   with the deploy that carries the removal, and revoking it in the
   console is the owner's.** The paid-tier condition it carried retired with
   the caller: no thread body leaves the box from triage.
4. **Confirm the ring-2 token has `Notifications: read`.** It does — because
   the token `gh` holds is a classic OAuth token (noted 2026-09-09), and
   GitHub's notifications endpoints accept classic tokens only. If it is
   ever replaced, triage needs its own classic token scoped to
   `notifications` as `GITHUB_TOKEN` (`README.md` §Run it).
5. **For M3: a Google Cloud project with an OAuth desktop client, plus the
   consent, once, from the laptop** — the steps are the ledger row
   and `bin/google-consent.js`'s own comments. Publish the OAuth app rather
   than leaving it in *Testing*, or the refresh token expires weekly. Scope
   `calendar.readonly`. **Still open** (2026-09-12).

## 10. Decisions taken here, so they are not re-litigated

- Build, not buy; Node in the host's services shape; SQLite; no framework.
- ~~Slack Socket Mode; no ingress for Slack;~~ (superseded by the webhook
  line below, 2026-09-10) web page via Caddy like the host's other services.
- ~~Rules decide tier; the LLM summarises and scores the grey band only, and
  its verdicts are logged not acted on until you have read them.~~
  **Half superseded 2026-09-11 (§13).** *Rules decide tier* stands and is now
  the whole of it: there is no LLM in triage to log, to promote, or to
  disagree with.
- ~~Haiku 4.5 by default behind an adapter; Anthropic SDK, no shim.~~
  ~~Gemini Flash-Lite on the paid tier behind the same adapter, `@google/genai`
  (2026-09-10, §4 note). The seam is the decision; the model is config.~~
  **Superseded 2026-09-11 (§13): no model, no adapter, no seam, and the
  dependency comes out.** The seam was the decision and the decision was
  wrong — not about which model, but about triage holding one at all.
- Polling with per-thread comment diff on every repo; webhooks deferred.
- A source may own a **clock** as well as a poll — `due(ctx)`, the same
  shape as the snooze wake — and delivery picks its shape from `item.kind`,
  never from `item.source` (2026-09-09, §5 note). The seam is what widens
  when a source needs something; the runner never learns a source's name.
- Code in this repository, deployment files in the host's own configuration repository.
- Deliver only P0 in M0. Everything else is stored and visible, not sent.
- Name: triage. Published at its own hostname.
- **The interrupt goes out through an incoming webhook, not a Slack app**
  (2026-09-10, §11.6 note). Notify-only by construction, which is what
  §11.6 wanted anyway; the Bolt path stays behind `TRIAGE_SLACK=app`
  rather than being deleted, and §8's manifest stays in the repo.
- **Triage reads the CRM through its own read-only Twenty role**, not
  through Admin and not through the role the picker defaults to
  (2026-09-10, §12.7). Read-only is a role to create, not a checkbox.
- **The goal is an ordered list, not a delivery system** (2026-09-10, §11).
  The score is the product; the tier survives as a category and as the
  interrupt test. Rules return every match, not the first.
  ~~The LLM emits features — summary, relevance, effort, label — and never
  the final order, which is the surviving half of "rules decide, the LLM is
  logged".~~ **Amended 2026-09-11 (§13):** everything above stands. What goes
  is the LLM clause — no model emits features here either, so the order is
  structural by construction rather than by restraint (§13.5).

Deferred, with triggers: webhooks (when a P0 on your own repo arrives
later than a minute and it bothers you); multi-user (when the work install
happens); ~~the persistent agent (section 4's row count)~~ (§13: the seat's); Gmail (~~after
calendar has run a fortnight~~ — **after the ranker**, 2026-09-10, §11.8).


## 11. The reframe: an ordered list, not a delivery system

*Added 2026-09-10, from the owner's review of the shipped M0–M3. This section
changes the goal, so it supersedes §3 where the two disagree; §3 is now a
dated note pointing at what shipped.*

*Built since: **the webhook half of §11.6** — the delivery client,
`TRIAGE_SLACK=webhook|app|off`, and hold-and-send coalescing — shipped
2026-09-10, as the last piece of M0's promise rather than as a milestone;
and **M5 · rank it** (§11.8) on the same day, which carries the narrowing
§11.6 described as intention. What is left unbuilt in §11 is M6 —
revealed preference, saturation and spread, hysteresis tuning; ~~the
model's features~~ went with §13.*

*Five notes recorded from building M5, each a deviation or a decision the
section did not settle (the last two added 2026-09-12, #16, closing the
ledger row that said M5 never got its note):*

1. ***`items.rank` is a second column***, not a new meaning for
   `items.score` — §11.8's trap 1 offered either. The tier's own ordering is
   what the interrupt path and `/api/items`'s fallback read, and one of its
   jobs (Later, divided by ten thousand) is not the list's. **Both halves of
   the trap still had to be answered:** all four writers of `score` now write
   the rank beside it, and a fifth was found while building — `lib/readable.js`
   set the tier and the score under `TRIAGE_LLM_DELIVER`. That one was
   harmless to the rank *by construction*, because the ranker reads the match
   set and never `items.tier`. (That fifth writer left with #14.)
2. ~~***The P1 batch and the P2 digest stay***, though §11.3 retires them.~~
   **Decided 2026-09-12 (the owner): dropped, no nudge in their place — #15.**
   The seat is where a digest belongs, and the interrupt set already carries
   the alarm. M5 had kept them pending this call; what they left behind is
   two cursor rows, deleted at boot.
3. ***The time term is per item, not per kind.*** §11.4 item 2 says "per
   source and per kind"; per *kind* is not enough, and ranking the real
   backlog is what showed it. A merged pull request and a reply to your
   comment are both `kind: pull`, and one is news while the other is someone
   waiting. The source is handed the **match set** and declares the curve
   from it. The same exercise caught a second error worth recording: two
   curves that mean opposite things about "now" have to share a zero point,
   so 0.5 on every curve means "time says nothing here" — a `waiting` curve
   that started at zero said a reply that had just arrived was timeless.*

4. ***§11.4's stability question was answered before the first blend, as it
   asked to be, and never recorded as answered:*** the base (claim and
   preference) is stored on the item, the time term is recomputed at read
   time, and hysteresis (`TRIAGE_RANK_HYSTERESIS`, 0.02) holds the order
   still unless something moved further than that. `README.md` §The rank.
5. ***M5 shipped without the ledger source and without `reconcile`***,
   which §12.6 had made its proving input. Its proving set was the GitHub
   backlog after all — 47 merged pull requests ranked in an order the owner
   agreed with — and the ledger, `reconcile` and the quota move whole to
   M7. §12.6 says so in place.

### 11.1 The goal that changed

M0–M3 optimise for **deliver the urgent few and archive the rest**. Inbox
zero is the success state, the tiers exist to pick a channel, and the
windows exist to protect the channel. It works: 47 items were tiered
correctly on the first boot and every verdict is on record.

The goal is now **rank everything and let me work down it**. The owner's
words, 2026-09-10: not inbox zero but infinite scroll — an endless
priority list the owner goes as far down as they can, with new things appearing as
the world moves on. The inputs widen well past GitHub and a calendar:
mail, system errors, world news. Maybe categorised; certainly ordered.
**The value of the service is helping the owner prioritise smartly, in a way
that evolves.**

That is a different centre of gravity, and it is worth naming what it is
*not*. It is not "show P2 on the page too". Adding two groups to
`lib/lists.js` would make today's backlog visible and would still be a
delivery system with a longer list stapled to it. The change is that the
**score becomes the product** and the tier becomes one of its inputs.


### 11.2 What survives

*All five did, and are the shipped system (`README.md`): the item store
entirely; the act path, which under a ranking is also the feedback signal;
the source seam and M3's widenings of it; the rules, promoted from a
switch that picks a channel to a labelled observation that carries weight
(`claim`); and the quiet and coalesce windows, narrower in scope and not
weaker, protecting the one interrupt. One strain still stands as written:
a news source will have no `my_role`, and the GitHub rules key off it.*

### 11.3 What does not survive

*Five things named; four are gone and one was answered differently:*

- **First match wins** — gone with M5 (#11, 2026-09-10). Rules return every
  match; `decisions.matches` carries the ordered set beside the
  `rule`/`tier`/`reason` that still mean the strongest.
- **`score()` in its present form** — kept, beside a new `items.rank`
  (M5 note 1 above): the tier's ordering is still what the interrupt path
  reads, and the rank is the product.
- **`lib/lists.js` GROUPS** — gone with M5: one ordered list, `?group=`.
- **The P1 batch and the P2 digest** — gone 2026-09-12 (#15, the owner's call,
  no nudge in their place): every verdict is answered on its own row the
  moment it lands, and nothing is pending for a second channel.
- **The grey band as a category** — gone with §13 (#14): `ambient` is a
  rule like the others, and nothing gives it a second opinion.

### 11.4 What a real ranking needs

*Six terms were named on 2026-09-10; where each stands:*

1. **Claim** — shipped with M5. Every rule declares one; the strongest
   sets the floor and the rest corroborate (`TRIAGE_RANK_CORROBORATE`).
2. **Time, per source and per item** — shipped with M5, and *per item*
   rather than per kind (M5 note 3 above): the source declares the curve
   from the match set. Four shapes, sharing 0.5 as "time says nothing".
3. ~~**Effort.**~~ Gone with §13 (2026-09-11): it was the model's term, and
   §13.4 item 2 accepts what its absence costs — the list will never float
   a thirty-second reply above an hour of reading. Declared and absent in
   `lib/rank.js`; nothing computes it.
4. **Revealed preference — the `actions` table.** M6. What you did, to
   what, how fast; the term that makes the ranking *evolve*. Needs volume
   (the old ~2,000-row trigger from the pre-prune §4 is the right shape of gate; one action on
   record at 2026-09-11), and §12.2's filter — only owner-authored actions
   count.
5. **Stated preference** — shipped with M5 as `TRIAGE_RANK_PREFER`,
   structure rather than prose. **Unset on the box** as of 2026-09-11,
   which is why the middle of the live list is flat (a `human-decision`
   ledger row carries the suggested line).
6. **Saturation and spread.** The cheap half shipped — `?group=` on the
   lists, and `/api/aggregates` (#14) reports how much of the list is one
   repository rather than interleaving it away (§13.6). The rest is M6.

**Stability** was decided before the first blend and is M5 note 4.

### 11.5 Where the LLM belongs now

*Written 2026-09-10; **superseded 2026-09-11 by §13** and never built.*
*It gave the model four per-item jobs — summary, relevance, effort, label
— and one constraint: it must never produce the final order. The jobs
went with the model; the constraint is promoted, not dropped — with no
model in triage the order is structural by construction (§13.3), and the
same reasoning is why §13.5 refuses to let the seat write judgements back
in. `decisions.acted` and `TRIAGE_LLM_DELIVER`, which this section
scheduled for M6, went with #14 instead.*

### 11.6 What delivery becomes

Delivery answers exactly one question: **does this interrupt?** Yes for a
short, named, explicit set — a human blocked on you, a meeting starting,
production on fire — and no for everything else, which goes in the list
and is not delivered item by item. The quiet and coalesce windows apply
to the interrupt path unchanged. Slack DMs for genuinely urgent things
are the one feature not to be traded for a better list; keeping the
interrupt path narrow is what keeps it credible.

*The standing nudge this section left open — "the top of your list has
moved", no items — was decided against on 2026-09-12 (§11.9).*

> *Decided 2026-09-10 (the owner, answering §11.9 and §9 item 2):* **the
> interrupt goes out through an incoming webhook, not a Slack app**, and
> shipped the same day (#9, #10). The Bolt path stays behind
> `TRIAGE_SLACK=webhook|app|off`. A webhook can post and cannot redraw,
> so coalescing **holds** the repeats and sends one follow-up when the
> window ends, the first alarm is never held, the message stands as sent,
> and there are no buttons — acting happens on the page. All of it is
> `README.md`'s interrupt-path paragraph, above §The shape.
>
> **The requirement, not the footnote:** a DM to `SLACK_USER_ID` was
> private by construction and a webhook is not, so it **must target a
> channel the owner is alone in** — what it posts is a thread title, a repo
> name and a line of a comment from private repositories. Nothing in the
> code can check where a webhook points. The URL is the credential:
> no scopes, not narrowable, rotated by replacing the line.

### 11.7 What we lose, named

*Five real costs of the reframe, named 2026-09-10; three are answered:*

1. **The "not delivered, and here is why" story** — answered: every
   contributing term keeps its weight and its sentence on the item
   (`items.features`), and every verdict still carries a delivery answer
   on its row, now including "placed in the list" (#15).
2. **Explainability** — answered: the top contributing term is on every
   line, as a requirement (M5), and #14 fixed the one place the label had
   drifted from the sentence.
3. **Inbox zero as a legible success state.** *Open.* Under infinite
   scroll there is no done and no signal that the system is working.
   It wants a replacement — throughput, or a line that says you have
   gone as far down as is worth going today.
4. **Archival pressure.** *Open.* Nothing in a ranked list forces an
   item out; decay-to-invisible has to be explicit. One action in three
   months against a list that only accumulates: whether the list is not
   being worked down or Done is the wrong verb decides what M6 builds.
   *Left open 2026-09-12 by the owner's call — a design question, not a prune.*
5. ~~**Determinism, partially.**~~ Moot since §13: there is no model term,
   so the blend is a pure function of the store and `bin/replay.js` stays
   answerable.

### 11.8 The path

- **M5 · rank it — shipped 2026-09-10 as PR #11.** Every match, the
  scorer in its own module with §11.4's terms and weights in config, one
  ordered list, the interrupt set, tiers as a category. Both of the traps
  this section named were answered: `items.score` kept its meaning and
  `items.rank` was added beside it with all four writers writing both
  (M5 note 1), and the backlog got its bounded backfill — rules re-run
  over the events the verdict on record was about, features persisted,
  a missing feature left absent rather than zero (`README.md` §The rank).
- **M6 · learn it** — as §7 now states it: revealed preference from
  `actions`, saturation and spread, hysteresis tuning. Structural only.

Gmail moves behind the ranker: under the new goal it is the source that
makes an unranked list unusable rather than merely long, so it lands on a
ranker, not before one. §12.6 carries M7.

### 11.9 Not decided here — The owner's calls

- ~~**Whether tiers keep their names.**~~ **Decided 2026-09-12 (the owner):
  keep P0–P3.** A category is cheap to keep; renaming it is a wide rename
  for a word.
- ~~**Whether the standing nudge of §11.6 ships at all.**~~ **Decided
  2026-09-12 (the owner): no.** The batch and the digest went with #15 and
  nothing replaces them in triage — the seat is where a digest belongs
  (§13.2), and the interrupt set is the only delivery there is.
- ~~**The interrupt set.**~~ **Decided 2026-09-10 (the owner), shipped with
  M5:** today's four GitHub P0 rules plus `new_invitation` on the calendar
  — a P1, which is the point of making it a rule list and not a tier. The owner
  was asked with the counts over the 98 decisions on record: the four P0
  rules had fired once between them. `deliver/interrupts.js` carries the
  set and `TRIAGE_INTERRUPT` overrides it.

## 12. Where the items come from

*Added 2026-09-10, same review session as §11 and continuous with it: §11
decided that the product is an ordered list, and a list is only as good as
what is in it. The owner's ask — "the first thing we need is a way to get
information out of agents", then the CRM, then chat with bots, and a valve
so none of it arrives faster than it can be judged. Nothing here is built.*


### 12.1 The ask, and the one assumption that does not survive

The owner's proposal was that agent output arrive as **GitHub issues**,
which the existing source would sweep up for free. **It is not free, and
today it does not work at all** — two facts verified against the box on
2026-09-10, and both still true:

1. **The notifications endpoint carries no issues.** All 50 threads in the
   inbox were `PullRequest`; 25 open and 22 closed issues across three of the owner's
   repositories were in the store not at all. `/notifications` is a
   feed of recent activity on threads you are subscribed to, and GitHub
   does not notify you about your own — an issue filed and not commented
   on never enters the store.
2. **Even a notified issue would be tiered wrong.** `new_issue_on_my_repo`
   requires the repository owner to be `me` (excluding every repo the owner
   actually files in) and the opener to be someone else (and agents on
   this box act as the owner), so an agent-filed issue is `own_activity` —
   P3, invisible. *Both fixed 2026-09-13 (#19): the rule is `new_issue`
   with no owner condition, and `my_open_issue` reads the item's state.*

So the cheapest-looking source is the one with the most work in it:
**triage's problem is not that it lacks sources. It is that its one source
is a feed, and most of what the owner is describing is not a feed.**

### 12.2 Events versus state — the seam that has to widen

*Shipped 2026-09-12 as #17, for the ledger, as written below: `reconcile(ctx)`
returns `{ keys, complete }`, the runner resolves what has left the set
with a `resolved` action attributed to the source, reopens what the source
resolved that has come back, and an incomplete read resolves nothing. It
runs beside `wake()`, on its own path. Issues and the CRM will use the
same declaration.*

Every source so far emits **events**: something happened, at a time, with
an idempotency key, and the item's `state` is changed only by the owner
through `act()`. That model is wrong for all three of the new sources.

An issue, a CRM task and a queue row are **state**: something is true and
unfinished. They have no feed. You read the current set, diff it against
what you hold, and — the part nothing in triage handles — **items
disappear when they are resolved somewhere else.** A CRM task completed in
Twenty, a queue row deleted by another agent, an issue closed on GitHub:
today triage would show all three forever, because nothing but `act()`
ever moves an item out of `open`.

This is the third widening of the source seam, after M3's `due(ctx)`, and
it is the same shape: a source may declare **`reconcile(ctx)`** — the
current set in, and the runner resolves the difference.

**The difference may only be computed against a snapshot the source says
is complete**, and this is the contract's most important clause rather
than a caveat. A paged read that hit its cap, a request that failed
halfway, a filter that silently narrowed: any of those produce a set that
is *missing* items, and resolving everything not seen would empty the
list in one poll. So `reconcile` returns its set **and a completeness
flag**, an incomplete read resolves nothing, and held work survives a bad
read by default. `sources/calendar.js` already does exactly this for its
own cursor — it will not advance a sync token or forget an `upcoming`
entry on a walk cut short, on the reasoning that "forgetting on that
basis is how an event goes missing for good" — so the pattern is
established here, not invented. A source that cannot honestly answer
"complete" may still reconcile against a **watermark**: everything
changed since T, with items untouched since T left alone.

**And reconciliation cannot ride the ingest path**, which is worth
settling in the plan because it looks like it could. `lib/pipeline.js`
`ingest()` opens every batch with `if (!fresh.length) continue;` — no new
events, nothing decided — and that guard is correct for a feed, where an
item that did not move needs no verdict. But a reconcile's most important
finding is an **absence**, and an absence has no event to be fresh. Routed
through `ingest()`, every resolution would be silently dropped. So
reconciliation runs on its own path beside `wake()`, which is already
exactly this shape: it too acts on the clock rather than on an arrival, it
too writes a state change and an `actions` row with no triggering event,
and it too is called by the runner in its own try. Nothing new is being
invented; the second caller of an existing pattern is.

Three answers a source must give for what the difference contains,
because the right one differs per source:

- **Gone from the set** — resolved elsewhere. Default: the item closes
  with a `resolved` action attributed to the source, not to the owner, so the
  `actions` table does not learn a preference they never expressed. This
  matters twice over, and both readers have to filter on `actions.by`:
  for §11.4's term 4, revealed preference; and for §12.5's quota, which
  compares a source's share of the list against the actions its items
  earn. A source that resolves its own items would otherwise look
  busily-acted-upon and grow its quota by doing nothing the owner valued —
  **only owner-authored actions count as feedback**, anywhere.
- **Back in the set** — reopened elsewhere. It reopens here.
- **Changed in the set** — re-tiered, and the change itself is an event.

Note what this buys beyond the new sources: it is also the honest fix for
"I marked it done in triage and it is still open on GitHub", which today
only works in the one direction `act()` pushes.


### 12.3 The four sources, by yield over cost

Ordered by what they return for what they cost, which is not the order
they were proposed in.

*A fifth arrived later and is not on this list: the household's to-do
lists in Home Assistant (§12.8), which is not about getting work out of a
tool but about the half of the queue that never touched one.*

**1 · The ledger — the agent channel that already exists.**
*Shipped 2026-09-12 as #17: `sources/ledger.js` and `rules/ledger.js`. On
its first read of the real ledger it found 86 rows and handoffs against 39
GitHub items — 45 of them waiting on the owner, 30 past their nudge — and the
rank absorbed them without a quota: an agent's row has a claim of 0.05 and
sinks, a row past its nudge waits from the nudge, and a quick answer (an
`[ack]` or a `[confirm: …]`, the owner's ask shape of 2026-09-12) floats above
a hard action. §12.5's valve is therefore not built yet; its trigger is the
next source, not this one. The wrinkle below was answered as written.*

The ledger file named by `TRIAGE_LEDGER` — a markdown queue file — and
`status/*.md`. Agents are *already required* to write here before stopping
(the host's own harness rules, and the walk-away contract). It holds **75 rows today — 33
`agent`, 23 `human-decision`, 13 `human-laptop`, 4 `human-htpc`, 2
`human-sudo`** — plus 12 handoffs, 4 of them in `review`.

That is **42 rows already owned by a human and waiting on the owner**, and
triage shows none of them while showing 33 merged pull requests.
It is local files, no API, no credential, no network and no new secret;
the `Owner` column is a ready-made claim signal (§11.4 term 1); and it is
state-shaped, so it is the natural first user of `reconcile`. **This is
the highest-yield source on the board and the cheapest, and it is a better
answer to "get information out of agents" than GitHub issues are** — for
work on this box. GitHub issues remain the right channel for anything a
collaborator should see, which the ledger deliberately is not.

One wrinkle to solve, not to discover later: a queue row has **no stable
id**. The key has to be derived from the `Item` cell, so bumping a nudge
date keeps identity and rewording the item creates a new one. Acceptable,
and it should be written down rather than found.

**2 · GitHub issues, as state rather than as a feed.** *Shipped
2026-09-13 as #19, as written below with two deviations. The mode is the
second half of `sources/github.js` `poll` — the open set of each
repository in `TRIAGE_ISSUES` (the list is config, §12.7), read whole once
per `TRIAGE_ISSUES_EVERY_MIN` through `GET /repos/:repo/issues?state=open`
rather than the Search API (per-repo paging says honestly when a read was
cut short; Search caps at a thousand and rate-limits separately). The
authority rule below landed generically: `reconcile` returns
`governs(item)` beside its set and `lib/pipeline.js` applies it, so the
inbox's pull requests are never resolved for being absent from a set they
were never in. The rules: `issue_assigned_to_me` (P2, claim 0.5) and
`my_open_issue` (P2, 0.35) read the item's state; `new_issue_on_my_repo`
became `new_issue` with the owner condition dropped. Both new rules
follow the `waiting` curve, not `fading`: an open issue of yours does not
go stale in twelve hours, and fading is how it would vanish again. On its
first read of the five repositories the owner files in it found 22 open
issues, 19 the owner's own; they ranked just under the overdue ledger rows and
above the merged pull requests. **Not built, deliberately: the closed-issue
backfill.** Its only consumer was extraction, which went to the seat
(§12.4), and whether the merged pull requests are held or dismissed is
still §12.7's open call; a closed issue is data the seat can read from
GitHub when it wants it. The `mode` on the item and the promotion rule
below therefore have one mode today, `open`; a backfill would add
`backfill` and the transfer as written.* A second ingestion
mode on the existing source: query the Issues/Search API for open issues
in the repos the owner works in, reconcile them, and treat closed ones as a
**bounded one-time backfill** (§12.4).

Those two must not be the same set, or the second destroys the first: a
backfilled *closed* issue is by definition absent from the *open* set, so
one reconcile pass would resolve away everything the backfill just
brought in. **Reconciliation governs only the items its own mode
ingested.** The ingestion mode is recorded on the item, the open-issue
reconcile compares against open-issue items alone, and backfilled items —
closed issues, and the follow-ups extracted from them — are outside its
authority for good. The same rule protects derived items (§12.4), which
have no upstream set to be present in at all.

**A backfilled issue that reopens is promoted, not duplicated.** There is
no duplicate to fear — `items` is `UNIQUE (user, source, key)` and an
issue's key is `owner/repo#n` whichever mode found it, so the open-issue
query upserts the row the backfill already created. What must be explicit
is the *authority* transfer: the item's mode moves to open, and from then
on reconciliation owns its lifecycle. Without that it is a permanently
orphaned row, correct on the day it was written and never updated again. 25 open issues are the single
largest visible-work miss in the system and need no judgement at all to
be worth showing. The rule also needs fixing: drop the "repo owner is me"
condition, which is what excludes every repository the owner actually files
in, and add a rule for an issue *assigned to* or *authored by* the owner that
is still open — which is a state fact, not an event.

**3 · The CRM.** *Shipped 2026-10-03: `sources/crm.js`, `rules/crm.js`,
`lib/twenty-api.js`, reading the Twenty host named by `TWENTY_URL`. What
changed the shape was the reason it was built when it was: the owner began
handing development work to a collaborator through tasks in Twenty,
and wanted to hear when **anyone but the owner** changed one, through triage and
in Slack, without going to look. So the source is state **and** a feed.
State: every open task is an item (129 on the first live read, 128 of them
under `acme`), reconciled against a read that saw every page; a task
completed or deleted in Twenty is resolved by the source. Feed: a task or
note created or changed by somebody who is not the owner is an event, and
`changed_by_other` is in the default interrupt set. Twenty has no comments
on a task, so a reply is an edit to a body — the event is keyed on the
record plus a fingerprint of title, body, status, assignee and due date,
which makes this the one source that is not blind to edits (§12.4); an
emitted fingerprint is never fresh again. "Not the owner" is read from the
record's own `updatedBy` (the timeline rows for API changes carry no
member): not the owner's workspace member, and not a name in `TRIAGE_CRM_AGENTS`
(the names of the owner's own keys, listed explicitly — there is no default). The first read is a baseline and interrupts on
nothing. **Notes are items only once somebody else writes in one** — 59
notes, nearly all the owner's own, are the owner's notes and not their queue. And the
read is watched: no complete read within `TRIAGE_CRM_STALE_MIN` (30) is a
P0 of its own, `crm_unread`, raised by the source's `due()` so it fires
when the CRM never answers; the page prints when every source last read
successfully, from `source_runs.ok_at` (generic, on `/healthz`). Two
deviations from the first sketch: opportunities are not read (none are in
use), and the read is two-phase — every record without its body, then the
bodies of only what moved — because a body is nine tenths of the bytes.
**Found on the first live read, and not solved in code:** besides
the owner's own key, five records were last changed by an actor carrying a
second key's name with no member id (the latest 2026-10-03 05:11 UTC, on a DEV task), and
neither the record nor its timeline can say whose. Until the collaborator's agents act under a key or
name of their own, triage cannot tell them from the owner's; by default it
treats that second key as somebody else, which is the loud direction.*
*2026-10-15, P0 narrowed to "waiting on you".* The first busy afternoon
was that second key — the owner reads it as the collaborator's agent — working through
the collaborator's own email-audit tasks: nine Slack posts in fifteen minutes, on
tasks created two weeks earlier, none of them assigned to the owner. The owner's call:
P0 means what it means on GitHub, somebody waiting on their reply. So
`changed_by_other` split by whose record the edit lands on —
`handed_to_me` and `changed_on_my_task` (P0, the interrupt set),
`changed_what_i_wrote` (P1: a task or note the owner or the owner's agents wrote, i.e. a
handoff reporting back), and `changed_by_other` (P2, everything else) —
with the items now carrying `authored` from `createdBy` and `my_role`
`assigned`/`authored`/`subscribed`. Each step is its own rule so a second
user (the collaborator, next) can arm the ones they want. The same conversation named
the GitHub P0 that was missing: a contributor opening a pull request in a
repository the owner follows, with no review request — `new_pull_request`, in
the set, bounded to an `opened` within the last day because the source
synthesises `opened` for an old pull request met for the first time.
**Not done:** a burst of genuine P0s still posts once per edit in webhook
mode; coalescing by actor is the next lever if one recurs.
Twenty: tasks, notes and opportunities, all state-shaped, all exactly the
"waiting, important, blocked" the owner says they lose track of. The credential
question is settled (§12.7): triage holds its own **read-only** API key,
minted 2026-09-11 against a role that can read every record and change
none.

**4 · Chat with bots — last, and not by polling transcripts.** The
structured output of a session already exists: the handoff file and the
queue rows the ledger doctrine requires — source 1, written by an agent
that was present for the whole conversation. So the first move here is to
make source 1 good and tighten what agents must write when they stop; if a
gap remains, it is the seat's extraction job (§13.4), not a poll over 157
JSONL transcripts with no item boundary and no cursor.


### 12.4 Extraction, and derived items

*Written 2026-09-10; **moved to the seat 2026-09-11 (§13.4 item 4)** and
never built in triage.* Extraction — read a resolved thread and say
whether anything in it is unfinished — was the only model job that could
*create* an item, and it goes to the chief-of-staff seat, which is what
knows whether the unfinished thing is already a ledger row. The guards it
would have needed (derived items with a `derived_from`, output keyed on a
hash of what was read, a bounded one-pass backfill, precision over recall)
travel with it. One fact found here is triage's own and still open:
**triage is blind to edits** — an event's key is `github:comment:<id>` and
its `ts` is `created_at`, so an edited comment re-emits nothing and the
stored body never changes (a ledger row carries the fix). The owner's rule for
the 33 merged pull requests in the store — probably done, unless something
came up during them — is §12.7's to answer.

### 12.5 The valve

The owner's instruction is to err toward putting things in, while not adding
too much too soon. Those pull against each other, and the answer is a
mechanism rather than a schedule:

**Ingest everything; admit by quota.** A source's items are always stored
— that is the dataset, and §11's whole argument rests on it — but each
source declares how much of the *list* it may occupy. One chatty source
cannot drown the others, a new source is added at a small quota and
widened once it earns it, and nothing is lost while that happens, because
storage and admission are separate decisions.

Then make the quota answer to evidence, which is the "evolves" property
§11 promises applied to sources rather than items: **compare a source's
share of the list against the share of actions taken on its items.** A
source producing items the owner never acts on shrinks; one whose items the owner
acts on immediately grows. That is measurable from `actions` on day one
and needs no model — with the one filter §12.2 insists on: **`actions.by`
must be the owner.** A `resolved` written by a reconcile is the source marking
its own homework, and counting it would let a chatty source earn quota by
churning.

**Two guards, or the loop starves the source it is meant to tune.**
Comparing *shares*, as first written, punishes a small source for being
small: a low quota shows few items, few items earn few actions, and the
quota shrinks toward zero with no way back — so a new source could never
prove itself, which is the opposite of the intent. Feedback is therefore
the **action rate per item admitted**, which is scale-free and lets a
source showing three items a week out-earn one showing thirty; and every
source keeps a **floor** it cannot be reduced below, so there is always a
sample to judge it on. A source is retired by the owner deciding to, never by
arithmetic.

Two numbers make the valve concrete rather than a principle: 75 ledger
rows and 25 open issues would together be **twice the current store**,
arriving at once. Without a quota the first day of the ledger source is
the last day anyone trusts the list.

### 12.6 What this does to the path

- ~~**M5 · rank it** gains the **ledger source** as its proving input.~~
  *Did not happen: M5 shipped (#11, 2026-09-10) without the ledger source,
  without `reconcile` and without the quota, proving itself on the GitHub
  backlog instead (§11 M5 note 5). All three are M7's, below.* The
  reasoning stands as the design for M7: cheap, local, no credential,
  state-shaped, and it means the list ranks things that are genuinely
  waiting on the owner rather than merged pull requests. `reconcile` lands with
  it. The quota (§12.5) was to ship with it, because the ledger is exactly
  the source that would flood — and did not need to (§12.3, 2026-09-12):
  the rank absorbed it, and the valve waits for the source that does not.

  **What the 42 means, since §12.5 caps a new source:** all 75 rows are
  *stored* and *scored* — never quota-bounded, they are the dataset —
  and admission to the list is. Start the bootstrap quota high enough
  that the 42 human-owned rows all fit, since hiding them is the failure
  this source exists to fix; the success criterion is **the order, not
  the count**, which is checkable at any quota.
- **M7 · the sources that matter** — ~~the ledger source with `reconcile`~~
  (shipped, #17) and the quota (above; not yet needed), ~~issues as state
  (and the rule fixes of §12.3)~~ (shipped, #19: 22 open issues arrived
  and the rank absorbed them too — the valve still has no trigger), ~~then
  the CRM on the read-only key it already has~~ (shipped 2026-10-03: 129
  open tasks, 103 of them P3 `task_open`, and the rank absorbed those as
  well). ~~Extraction and
  derived items (§12.4)~~ went to the seat with §13. Numbered after M6 but
  not gated on it: ranking must exist first, learning need not.
- **The calendar's weight drops.** The owner does not use it much. It stays —
  built, and what proved the seam — but the Google credential work is not
  prioritised for it. Gmail stays behind the ranker (§11.8).
- **Chat transcripts are not a milestone.** They become one only if the
  ledger, tightened, leaves a gap worth the cost.


### 12.7 Not decided here — The owner's calls

- ~~**Whether triage gets its own Twenty credential, and whether it can be
  read-only.**~~ **Answered 2026-09-10 and done 2026-09-11.** Twenty
  assigns an API key a *role*, and the two the picker offered could both
  write to the system of record; so a fourth was created on the owner's
  go-ahead — *Read-only (API)*:
  reads every object, updates nothing, assignable to API keys only. The
  key was minted at *Settings › APIs › API keys* against it and verified
  read-only (a `PATCH` and a `DELETE` both `PERMISSION_DENIED`); it sits in
  `~/.config/triage/.env` as `TWENTY_API_KEY`, one more ring-2
  secret at rest, inventoried in the ledger. The role reads every
  object deliberately for now; narrowing it per object is supported and is
  a task on M7, once M7 knows what it reads. *M7 knows now (2026-10-03):
  `workspaceMembers`, `companies`, `people`, `tasks` and `notes`, read over
  GraphQL — narrowing the role to those five is safe whenever the owner wants
  it.*
- **Which repositories the issue source watches.** "Repos I work in" is
  not a query GitHub answers; it is a list, and it should be config rather
  than inference. *The mechanism shipped as `TRIAGE_ISSUES` (#19); the
  list itself is still the owner's to write into the production `.env`. The
  worktree that proved it used the five the owner files in, this repository
  among them.*
- **Whether the 33 merged pull requests are bulk-dismissed now or held
  for extraction.** Holding them costs one bounded backfill; dismissing
  them costs the only real corpus extraction could first be judged on.
- **Whether agent output should go to GitHub issues *as well as* the
  ledger** for work a collaborator should see. §12.3 argues the ledger is
  the better default on this box; the two are not exclusive, and the
  choice is per project.


### 12.8 Home Assistant's to-do lists — the household queue

*Added 2026-09-20, from the owner's ask. It is not one of §12.3's four, and
deliberately: those are about
getting work **out of** the tools work happens in, and this is about the
half of the queue that never touched a tool at all. The family board
shipped in Home Assistant the day before (`todo.my_inbox`,
`todo.household`, on the to-do dashboard), and it is already
where a household item is written down — so triage does not need a new
place for chores, it needs to stop pretending they are not in the queue.*

**It is the ledger's shape, over HTTP.** The read is the whole of each
list, so `reconcile` (§12.2) is a complete set and everything that follows
from that is the ledger's argument, unchanged: an item ticked off on the
kitchen tablet has no event to announce itself, it simply stops being in
the set, and it is resolved by the source (`by = source:ha`) rather than
by the owner. A list that cannot be read makes the read incomplete and
resolves nothing, because one unreachable box must not close every chore
in the house. This is the third source to make that declaration and the
first that did not need the seam widened at all, which is the test §12.2
set for it.

**Two things differ from the ledger, and both are improvements.**
Identity is a **uid**, not the text — Home Assistant gives every to-do
item a stable one, so renaming a chore on a wall tablet keeps the item,
where rewording a queue row necessarily creates a new one (§12.3's
"wrinkle to solve"). And there is **one write**: Done in triage calls
`todo.update_item` with `status: completed`, so the two surfaces agree
rather than each holding half the truth. That is not a new seam — it is
the `marks` map `act()` has had since M1, which is exactly what it was
for; triage stays read-mostly, and the write carries no opinion, only the
fact that the owner did the thing (§13.5).

**The read is a service call, over REST.** A to-do list's entity *state*
is a count, not its items, so the only way to read one is
`todo.get_items` with `return_response: true`. Both transports can carry
it. The WebSocket API is a stateful connection with an auth handshake,
per-message ids, a reconnect loop and in-flight bookkeeping; the REST form
is `POST /api/services/todo/get_items?return_response=true` and nothing
else. For two idempotent reads a minute, where a minute of downtime is one
failed poll, the socket is machinery with no buyer. When a source wants to
*watch* state change rather than read it, that is the argument for the
socket, and it can be made then.

**The rules are three, and none of them interrupts.** A date is the only
thing on a to-do list that claims anything by itself, so `due_today` (P1,
claim 0.7) is anything due today or already past, from either list, and it
waits *from the due date* the way an overdue ledger row waits from its
nudge. Then it is whose list it is: `inbox_item` (P2, 0.4) for your own
inbox and `household_item` (P3, 0.2) for a list the house shares, which is
ambient until it has a date — and so follows the `flat` curve, because a
chore does not become more urgent by sitting on the fridge. Nothing here
is in the interrupt set on purpose: **the point of putting the chores in
the list is that they stop being something you are buzzed about.** A date
that has passed is still not a person waiting.

**The credential is the uncomfortable part, and it is stated rather than
hidden.** Home Assistant has exactly one kind of credential — a long-lived
access token with the rights of the user who minted it — so there is no
read-only grant to ask for, as there was for Twenty (§12.7) and as the
calendar's `calendar.readonly` scope gave for free. `HA_TOKEN` can do
anything the owner can do in their own house. What bounds it is this tree: one
service call to read, one to complete an item, and no third.

**Not built, and the reason it ships off by default.** Triage runs on
the host and Home Assistant is on the LAN, and whether the host may reach it
is a decision about the network rather than about this source — so no path
was opened for it. There is no special switch for that: `TRIAGE_HA` unset
means *on if the credentials are there*, and production holds neither
`HA_URL` nor `HA_TOKEN`, so the source does not register and nothing is
tried. The queue row that carries the decision says what it needs:
that host and port, or the Nabu Casa remote URL, which needs no route at
all. `TRIAGE_HA=fake` runs the whole flow — poll, rules, reconcile, Done
ticking an item off — against the canned pair of lists in `test/`, which
is what the worktree and the suite prove it with.

## 13. The reframe that removes the model: triage is a source, not a mind

*Added 2026-09-11 (the owner's call, during the standing review). This section
supersedes §4's "dumb rules versus LLM: the mix" and §11.5's "where the LLM
belongs now" in their entirety. §§6, 7 and 10 are otherwise untouched.*

*Shipped 2026-09-12 as #14 — the removal, §13.7's inventory made true,
with `GET /api/aggregates` as the cheap half of §13.6. The batch and the
digest followed as #15 (§11.3), and this prune as #16.*

### 13.1 What happened, and why the decision is right

M2 was deployed on 2026-09-09 and made **zero calls** until the model id
was fixed on 2026-09-11. Running it for the first time is what settled
this section, because the output could finally be read rather than
imagined. Six batched calls against a real backlog produced three
summaries:

```text
"your pull was merged"
"your pull request was merged successfully"
"pull request merged successfully"
```

2,251 input tokens for the first of them, to restate a sentence the rule
had already written for free. The grey-band verdicts were better — real
judgements, and all three agreed with the rule's P3 — but they are still
answers to a question about *one item*.

**Every LLM job this plan has ever specified is per-item**, and that is
the defect. §4's two jobs are per-item. §11.5's replacements — relevance,
effort, label, summary — are per-item. §12.4's extraction is per-thread.
Nothing ever looks across the list. So the model was being asked fifty-four
small questions when the only interesting question is the one that spans
them: *what is going on here, and what should I do about it?*

That question was tested during the review. The whole open list —
fifty-three rows with rank, rule, repo and age — is **3,104 tokens**. One
call answered it better than six per-item calls did, for a third of the
cost, opening with "nothing in this queue is waiting on the owner" and
correctly reading the backlog as a pivot from product work into
infrastructure.

**And that is precisely the job triage should not be doing.** The good
answer needs triage's items *plus* the ledger, the cross-repo PR
dashboard, the calendar and the CRM. Triage holds one of those five. An
aggregator that can only see a fifth of the evidence produces a confident
paragraph about a fifth of the truth — which is exactly what the test
produced, and why it read well and helped nothing.

### 13.2 The decision

**Two paths were on the table:**

1. Keep triage tight and put the intelligence in the chief-of-staff seat —
   the agent harness the host's own docs already plan, whose first phase
   already polls and displays the other sources.
2. Let triage become a mind: something that inspects all incoming data and
   has opinions.

**Path 1, on separation of concerns.** The intelligence belongs where the
*other* information already is. Triage's job is to be the best possible
structured input to that seat: deterministic, explainable, replayable, and
cheap to query. It emits; it does not opine.

**So the LLM comes out of triage entirely.** Not disabled behind a flag —
removed, with its tables, its columns, its config and its tests. A seam
kept "in case" is a seam that has to keep working, and this one has cost
two milestones' worth of plan and delivered three sentences about merged
pull requests.

### 13.3 What this buys, stated plainly

- **The rank becomes purely structural, permanently.** claim, time and
  stated preference today, and whatever M6 adds — revealed preference,
  saturation — is structural too; nothing a model emits, ever. §11.5's hard constraint — "one job
  it must not have: producing the final order" — stops being a rule that
  needs defending and becomes a property of the architecture. `decisions`
  stays a clean dataset, `bin/replay.js` stays answerable, and the weights
  stay tunable in config.
- **No private repository content leaves the box, from triage, ever.**
  §4's paid-tier condition existed solely because thread bodies were being
  sent to Google. That constraint retires with the caller. Whether the
  chief-of-staff seat sends anything anywhere becomes its decision, made
  with its own data and its own threat model — including the option of a
  local model, which is a real argument on privacy grounds even though it
  is not one on volume: the whole open list is three thousand tokens.
- **It deletes more than it adds**, in the §11.3 tradition.
- **Two open queue rows evaporate rather than being fixed**: the failing
  batch *submit* retried every minute (the window cursor only advances on
  success), and the missing `profile.md` that would have had the grey band
  scored against a built-in stranger's interests. Both were real; neither
  needs a fix if the caller is gone.

### 13.4 What it costs, named honestly

Not hedges. Each of these was a genuine argument for the model, and each
is now somebody else's problem or nobody's:

1. **No summary on the list.** §11.5 argued summarising "moves from 'the
   DM is skimmable' to 'the *list* is skimmable'", which is the ergonomic
   premise for working down two hundred rows. What remains on a row is the
   title and the rule's own reason. On today's backlog that is no loss —
   the reason *was* the summary. On a forty-comment argument it is a real
   one, and the answer is that the chief-of-staff seat can read the thread
   and say so, because it can already read everything else.
2. **`relevance` and `effort` die as rank terms.** §11.4 item 3 called
   effort "the term most likely to change which item is actually first".
   They have always been declared-and-absent, so nothing breaks; but they
   are now permanently absent rather than waiting on M6. The list will
   never float a thirty-second reply above an hour of reading. Accepted:
   the seat can say that in prose without the rank having to churn.
3. **The grey band loses its second opinion.** `ambient` P3s are what a
   rule could not tier, and the model's verdict beside the rule's was how
   §4 intended to measure whether it earned promotion. That measurement
   will now never be made. Accepted, with the observation that in the
   three verdicts ever produced the model simply agreed with the rule.
4. **§12.4's extraction goes with it.** It is the only LLM job that could
   *create* an item — reading a resolved thread for something unfinished.
   That is a genuine capability and it is now the seat's, where it belongs
   anyway, since the seat is what knows whether the unfinished thing is
   already a ledger row.

### 13.5 The seam: triage emits, and never ingests an opinion

The obvious temptation is to let the seat write its judgements back — a
relevance score, a label, a "do this first" — into `items.features` so the
rank can use them. **That is path 2 wearing path 1's clothes**, and it is
refused for the same reason path 2 was: the order would stop being
explainable from data triage holds, and `decisions` would stop being a
record of what the rules observed.

**The API is read-only as far as judgement is concerned.** The existing
write path stays exactly what it is — `POST /api/items/:id/act`, the five
actions, one code path — because an action is a fact about what the owner did,
not an opinion about what they should do. The seat may act on the owner's behalf
through the same door every other surface uses. It may not rank.


### 13.6 What "more programmatic output" means

This is the actual work of the milestone, and it is unglamorous. The
consumer is a program, so the surface should answer in one call what an
agent would otherwise reconstruct from fifty-four rows:

- **Aggregates, not just rows.** Counts and spreads by repo, rule, tier,
  kind and age band; the rank distribution; how much of the list is one
  repository. The saturation question of §11.4 item 6 is answered by
  *reporting* saturation rather than by silently interleaving it away.
  *Shipped as `GET /api/aggregates` (#14, 2026-09-12) — its own route
  rather than a view on `/api/lists`, because the two answer different
  questions with different shapes.*
- **Diffs, which is the thing an aggregator actually wants.** "What
  changed since I last asked" — new items, items that moved tier, items
  that went quiet, actions taken. `events` and `decisions` already carry
  the timestamps; nothing exposes the delta. This is the single highest
  value addition and the one an agent cannot cheaply compute for itself.
- **A stable cursor** so consecutive calls compose. *Not* the
  `describeCursor` idiom — that is a source's polling position and answers
  a different question. Three things are settled: it has to cover **all
  three kinds of change** — `events` (the far end moved), `decisions` (a
  rule spoke) and `actions` (the owner did something; a Done through `act()`
  writes an `actions` row and nothing else, so a cursor on the other two
  would miss it); row ids are per table and timestamps are neither unique
  nor ordered across tables, so one change sequence spanning the three is
  the shape; and **it must not be the rank or a position in the list**,
  which is recomputed at read time and held only by hysteresis. Ordering
  key, tie-breaker and what a deleted or re-tiered item does to a cursor
  are §13.8's, designed against a real consumer. *Asked and answered on
  2026-09-12 (#14): a change-sequence column is cheap to add now but
  **not** expensive to retrofit — all three tables carry `ts` and an id,
  history can be numbered in one pass, and no consumer holds a cursor yet
  — so it is not added before the consumer's first question fixes its
  shape.*
- **The whole open list in one response, cheap to parse**, which it nearly
  is — `GET /api/lists` needs a leaner projection for machine readers, not
  a new endpoint.
- **Direct read access to the store as a supported path.** It is SQLite on
  the same box; an agent with a read-only handle can ask questions no API
  designer anticipated. Documenting the schema as an interface is cheaper
  than growing endpoints forever, and the file is already "data, not
  source".


### 13.7 What comes out of the tree

*Shipped 2026-09-12 as #14; the inventory is now `README.md` §The store
and the commit that carried it.* One PR, mostly deletion: the `llm/`
adapter, `lib/readable.js`, the `llm_jobs` and `llm_calls` tables,
`items.summary` and `summary_at`, `decisions.acted`, the `llm` value of
`decisions.by` (the column stays — `wake` lives there), `GET /api/llm`,
the grey list group, the boot wiring, the `readable` seam, six config
keys, the fake, the tests, `@google/genai`. Historical `by = 'llm'` rows
are deleted at boot **before** the `acted` column goes, because once that
column is gone nothing else tells a logged-only verdict from a rule's;
`lastDecision` is unconditional because of that order. The boot path
gained its drop half — the mirror of `LATER_COLUMNS`, guarded on `PRAGMA
table_info` saying *present* — and one test boots a store seeded with the
M2-era shape and boots it again. Not a migration framework, and not a
rollback: the restore path is `~/backups/triage/`, snapshotted before any
deploy that drops anything, and that snapshot is the only copy of
`decisions`, `actions`, `deliveries` and the cursors there is.

*Corrections found against the code, 2026-09-12:* three columns, not
four; the `llm:batch` cursor row was missing from the inventory; the `llm`
bypass in `deliver/interrupts.js` went too; production had written two
`llm` rows by the time the PR was cut (#12 was deployed 23:41 PDT on
2026-09-11), so the boot path was run against a copy of the live store
first. `relevance` and `effort` stay declared-and-absent in `lib/rank.js`,
on purpose.

### 13.8 Not decided here

- **Whether the chief-of-staff seat is the harness the host's own docs
  already plan, or something new.** That is the host's decision, not
  a triage one, and that plan's own precondition — "do not build this before
  feeling that pain too" — still applies.
- **Whether that seat runs a local model.** The privacy argument is real
  and is the one worth deciding on; the volume argument is not, at three
  thousand tokens for the whole list.
- **What the diff endpoint's shape actually is.** It wants designing
  against a real consumer rather than in the abstract, which means the
  seat's first version should come first, or at least its first question.

## 14. What interrupts you is yours: the configuration seam

Added 2026-09-13, from the first real interrupt the system ever sent and
the question it raised.

### 14.1 What happened, and what it proved

At 15:49 UTC on 2026-09-13 triage decided
`acme/site` P0 `reply_to_my_comment` —
somebody replied after the owner did — and delivered it: `delivered=1`, note
`sent webhook`, a `deliveries` row with status `sent`. Every layer this
repo owns did its job, on the one rule that had fired once in ninety-eight
decisions (§11.9). The owner got nothing.

The miss is Slack's and it is structural, not a fluke. An incoming webhook
posts an ordinary channel message from an app, and Slack's default
notification preference is *direct messages, mentions and keywords*. A
channel message that mentions nobody produces an unread badge and no push.
The DM path the webhook replaced was a notification by construction — that
property was not carried across in #9, and nothing since then had actually
tested it, because until this week nothing had ever been sent.

**So the first fix is one line of the message, not one line of config**: an
interrupt in webhook mode carries `<@SLACK_USER_ID>`, which is what makes
Slack treat it as a mention. It costs one env line on the box and nothing
else. Stated plainly because it is the general lesson: *an interrupt that
does not interrupt is not an interrupt*, and "delivered" is not the same
claim as "arrived". `deliveries` can only ever record the first.

What the incident proved beyond the bug: the interrupt set is a global
list of rule names, and the thing the owner actually wanted to say is neither
global nor a rule name. It was **"a human replying to me in
`acme/site` is an interrupt"** — a rule, in a project, for a
person. The set can say the first third of that.

### 14.2 The four layers, and the thing that is not one of them

What qualifies as an interrupt is *personal*, and this is the feature that
decides whether anybody else adopts triage when it is extracted. So the
shape is four layers, each one narrower than the last, the later winning:

0. **The default set** — `deliver/interrupts.js`, in the repo. What the
   system does for somebody who has configured nothing, and the layer that
   has to be *good*, because most people will never pass it. Today: a
   human is waiting on you, or a meeting is about to start.
1. **Yours, globally** — `TRIAGE_PREFS` `.interrupts`. One person's answer
   across every project. "Also buzz me when someone opens an issue."
   "Never buzz me for a calendar."
2. **Yours, per project** — `TRIAGE_PREFS` `.projects[…].interrupts`, the
   same grammar, scoped. "In `acme/site`, a new issue is an
   interrupt." "In this scratch repo, nothing is."
3. **Yours, from the shell** — `TRIAGE_INTERRUPT`. What you reach for to
   silence something *right now*, and it wins over everything, because
   that is what typing it means.

The layers are not modes. They are one ordered list of **statements**, and
the most specific statement in the highest layer wins. That is the whole
resolution rule, and it is stated in one sentence on purpose: a
configuration system nobody can predict is worse than one nobody can
customise.

**What a project is worth is the fourth thing the owner asked for and it is
not a fifth layer** — worth stating plainly, because two different "four
layers" in one design is how a document stops being readable. "Not all
repos are equal" is about *ordering*, and that half is already built:
`TRIAGE_RANK_PREFER` (§11.4 item 5) is a stated preference per repo feeding
the rank. What §14 adds is that a project's `weight` lives in the same
`projects` block as its interrupt overrides, so one entry in one file says
both things about a project — where it sits in the list, and what it may
interrupt on. The weight moves the rank and nothing else; the interrupts
are statements on layer 2. They travel together and they are not the same
mechanism, and §14.7 records why the weight is deliberately not allowed to
move the interrupt bar by itself.

### 14.3 The seam: a source says what a project is

Layers 3 and 4 need a "project", and nothing in `lib/` or `deliver/` may
know what one is — the same constraint `due()`, `describeCursor()`,
`time()` and `reconcile()` were each answered under (AGENTS.md). So a
source may declare **`project(item)`**, returning a string key or null, and
it is a map built at boot from the registered sources exactly as `shapes`
is. GitHub returns `item.repo`. The calendar returns its calendar id — a
shared team calendar and your own are genuinely different projects. The
ledger declares nothing and therefore has no project scope, which is the
honest answer for a single queue file and costs it nothing: layers 1 and 2
still apply to it.

A source that has not declared one is not a special case anywhere. It
matches `*` and no project-scoped statement, which is what "we have not
thought about this yet" should do.

### 14.4 The grammar, and the two places it is written

One grammar, two homes, because the two are for different moments.

A statement is `[+|-]source:rule[@project]`. `+` arms, `-` mutes, `*` is a
wildcard in any of the three positions, and a project may glob as
`owner/*`. **Signs make it a delta on the layer beneath; an unsigned list
replaces.** That is not a new rule — it is exactly what `TRIAGE_INTERRUPT`
has always meant, kept, so nothing on the box changes meaning when this
ships.

- **`TRIAGE_INTERRUPT`**, the env var, unchanged and now able to carry
  deltas and scopes: `+github:new_issue@acme/*`. This is
  the layer you reach for to silence something *right now*, from the
  shell, and it wins over everything, because that is what typing it means.
- **`TRIAGE_PREFS`**, a JSON file (default
  `~/.config/triage/preferences.json`, absent by default and then
  it simply does not exist). This is where a considered configuration
  lives — several projects, several weights, comments you will want in six
  months. JSON because the tree has one npm dependency and a TOML parser
  would be the second; the shape is small enough to survive the format.

```json
{
  "interrupts": { "github": ["+new_issue"], "calendar": "off" },
  "projects": {
    "acme/*":        { "weight": 0.6, "interrupts": { "github": ["+comment_on_my_thread"] } },
    "alice/scratch": { "weight": -0.5, "interrupts": "off" }
  }
}
```

`weight` is the ordering half of §14.2 and is fed straight into the ranker's
stated preferences, which already read `repo:owner/name=0.8`;
`TRIAGE_RANK_PREFER` still wins over the file for the same key, for the same
reason `TRIAGE_INTERRUPT` does. `"off"` and `"all"` are the two shorthands worth
having: a project that must never buzz, and one that is on fire.

Nothing is read from the repo, and the file is named by the environment —
the rule AGENTS.md states, and the precedent `GOOGLE_CLIENT_FILE` set.

### 14.5 Out of the box versus yours

The distinction the owner named, made concrete, because it is the one that
decides adoption:

- **Out of the box, triage is opinionated and quiet.** Four GitHub rules
  and two calendar rules, chosen against a real corpus of decisions
  (§11.9). No file, no env var, nothing to read. Somebody who clones this
  and runs it should be interrupted correctly on day one and not be
  presented with a configuration language.
- **Customising is additive and local.** You never restate the default set
  to change one thing about it — `+github:new_issue` is a complete,
  legible statement, and the defaults continue to improve underneath it.
  A full replacement is still available (an unsigned list), for the person
  who wants to own the whole thing.
- **The defaults are a *statement* like any other**, on layer 0. There is
  no privileged built-in path, which is what stops the two halves drifting
  into different code.

### 14.6 Explaining itself is the feature

The thing that makes configuration usable is not the grammar. It is being
able to ask *why didn't that buzz me* and get an answer naming the
statement that decided it. So:

- every decision that does not interrupt already carries a note, and the
  note now names the deciding layer rather than always saying
  `TRIAGE_INTERRUPT` — `not delivered: new_issue does not interrupt
  (TRIAGE_PREFS projects."alice/scratch": -github:*); it is in the list`;
- **`GET /api/interrupts`** returns the resolved statements by layer, the
  effective global set, and the project seam each source declared;
- the same endpoint with `?source=&rule=&project=` answers the one-shot
  question — would *this* interrupt, and which statement says so — which
  is `bin/replay.js`'s trick (AGENTS.md) applied to delivery instead of to
  rules.

### 14.7 Not decided here — The owner's calls

- **Whether a project's `weight` should also move the interrupt bar
  automatically** — a project you have weighted 0.9 arguably ought to buzz
  on more than one you have weighted 0.1, without you saying so twice.
  Shipped as *explicit only*: weight moves the rank, and interrupting is
  still a statement you write. Inferring a channel from a score is the
  thing §11.6 spent a section refusing, and it should not come back in
  through the config file. Worth revisiting once there is more than one
  user.
- **Whether a keyword layer belongs here** — "buzz me whenever anything
  says `prod` or my name" is how most people actually configure Slack, and
  it is a fifth kind of statement, matching item text rather than a rule
  name. It is not in this design. It would fit the statement list without
  widening the seam, and it would be the first thing that reads the *body*
  of an item to decide delivery.
- **Whether `TRIAGE_PREFS` should be reloadable without a restart.** It is
  read at boot today, like everything else. A file people edit is a
  different kind of config from an env var, and a watcher is a small
  change; it is deliberately not in this PR.

**When to batch, decided 2026-09-19 (the owner): not yet, and here is the
trigger.** The interrupt set was chosen against a corpus where the four
GitHub P0 rules had fired *once* in ninety-eight decisions (§11.9). That
is no longer the rate: four P0s landed on 2026-09-15 alone, all from one
repository, as the open-source side of a project of the owner's picked up —
and the owner expects more as they go back to full speed. **This is the
feature working**, so nothing changes now: every interrupt goes out on its
own, unbatched, because that is what the path is for.

The trigger to revisit is a *rate*, not a feeling: **more than one
interrupt an hour, sustained.** At that point the thing to build is a
grouping mechanism — and note that it is not the P1 batch or the P2 digest
that §11.3 removed on 2026-09-12, which were about the tiers that never
interrupted. This would be grouping *within* the interrupt path: several
P0s from one repository in one window arriving as one message. The
coalesce window (`TRIAGE_COALESCE_MIN`) already does exactly this per
*item*; the unbuilt half is doing it per project. `/api/aggregates`
already reports the rate, so the trigger is measurable rather than
remembered.

## 15. Reports: the store read over time

Added 2026-09-19, from the owner's ask: "some reports and graphs so I can tell
how things are changing over time or when my most active areas are", with
the caveat stated up front that completion is tracked thinly, and the
intention that a background watcher will one day notice what the owner does
*outside* this UI. This section is the reporting infrastructure; the
watcher is §15.5 and is not built.

### 15.1 What the market draws, and what of it applies

*Surveyed 2026-09-19.* Jira's reports are still the reference set —
created-versus-resolved, the cumulative flow diagram, the control chart
(cycle time as a scatter over time), velocity — and every modern tracker
draws a subset of the same four with less chrome: Linear's Insights are
slice-and-dice counts over issues plus a burn-up per cycle and a completion
rate as the velocity stand-in; the kanban tools (Businessmap, KanbanFlow,
Kanban Tool) settle on lead time, cycle time, work in progress and
throughput, all read off one cumulative flow diagram. The 2026 additions
are forecasting from the slope of the done band, which needs a team and a
sprint to mean anything.

Triage is not a tracker and has no sprint, no assignee and no estimate. What
carries over is exactly three things, and the fourth is its own:

1. **Flow** — arrivals against closures per bucket, and the open count over
   time (the created-versus-resolved chart and the cumulative flow diagram,
   which for a one-person queue are the same picture drawn twice).
2. **Cycle time** — how long an item waited before something was done about
   it: the control chart, as far as the data allows (§15.3).
3. **Where** — which repositories, sources and rules the activity is in, per
   bucket: the "slice by" of every Insights page.
4. **When** — hour of the day by day of the week, in `TRIAGE_TZ`, for the far
   end's activity and for the owner's own. No tracker draws this because a team
   has no single clock; a person does, and it is the direct answer to "when
   are my most active areas".

### 15.2 The shape: one read, named reports, nothing written

`lib/reports.js` is `lib/aggregates.js` extended along the time axis, and
it keeps that file's contract: a query over what is already in the store,
nothing written, nothing judged. A **report** is a named pure function over
one bounded read — every event, verdict and action in a window, plus the
items they belong to — bucketed by hour, day or week in the configured
zone. Adding a report is adding a function to the registry; `GET
/api/reports` lists them with the sentence each answers, and `GET
/api/reports/:name?since=&until=&bucket=&by=` runs one. The page at `/stats`
draws them with no build and no chart library, in the list page's own
tokens, and every chart has a table beside it, because a chart nobody can
read as numbers is decoration.

Three things are settled here rather than found:

- **Time is the far end's, not the poll's.** An event's `ts` is when the
  comment was written; `seen` is when triage noticed. Reports bucket on
  `ts`, because "when is the world active" is a question about the world —
  and because the first boot's backfill of thread history lands in `seen` as
  one spike and in `ts` as three months of real activity.
- **"You" is `actions.by` not `system` and not `source:<name>`** — §12.2's
  rule, applied to reporting as it is to learning. A ledger row deleted by
  its owner is a closure, and it is reported as one, in its own series
  (*resolved elsewhere*), never folded into what the owner did.
- **State over time is replayed from `actions`, not stored.** Every state
  change since M1 has written an action row — done, snooze, later, mute,
  open, answer, and the system's wake, reopen and resolved — so the open
  count at any past moment is the items created by then, walked through
  their actions to then. No snapshot table, no new column; the store's
  history is already the history.

### 15.3 What the data can and cannot say today

Read against the production store on 2026-09-19: 193 items, 1,122 events
(216 of them the owner's own comments and reviews, from June), 359 verdicts, 7
delivered, and **16 actions, two of them the owner's** — the rest thirteen
ledger resolutions and one system reopen. So:

- **Flow** is honest on arrivals and on what left, and says which door it
  left by.
- **Where** and **when** are well fed: the far end's activity and the owner's
  GitHub activity are both in `events` with real timestamps.
- **Cycle time** has a sample of two. The report exists, computes the
  median and the ninetieth percentile, and **prints its sample size in the
  same breath** — a number without its n is the one thing this page must
  not show. It fills in as the actions do.
- **Interrupts** are reported per bucket against §14.7's trigger (more than
  one an hour, sustained), so that trigger is a line on a chart rather than
  a memory.

### 15.4 Not a fifth seam

A report reads the store through the API, as the seat does (§13.6). It does
not widen the source seam, the rules, delivery or `act()`, and it must not:
a report that needed a source to say something new would be a diff endpoint
wearing a chart, and §13.8 still says the diff is designed against its first
consumer. `/api/aggregates` stays as it is — the queue *now*, as counts;
`/api/reports` is the queue *over time*.

### 15.5 The watcher, recorded and not built

The owner's second paragraph: not everything they do happens here, and the app
has to be responsive to activity that arrives sideways. Two-thirds of that
is already true and worth saying plainly before anything is added:

- **The owner's activity at the far end is already an event.** Their comment on
  GitHub is `events.actor = me`, timestamped by GitHub; the `when` report
  reads it today. A source that carries its user's own activity as events
  is the watcher for that source.
- **Out-of-band completion on a state-shaped source is already
  `reconcile`.** A queue row the owner deletes, an issue they close on GitHub:
  resolved, attributed to the source, in the list within a poll.

The third that is missing is the **feed-shaped** case: a GitHub thread the owner
reads and answers in GitHub's own inbox, which triage never learns about
because the notifications endpoint only reports what is unread and a read
thread simply stops appearing. That is a source question and has a
source-shaped answer — the inbox is *also* a set, of unread thread ids, and
a thread that leaves it was handled somewhere — which is `reconcile` on the
GitHub source's first mode, with `governs` scoped to inbox items and a
resolution attributed to `source:github`. Nothing in `lib/` would learn a
thing. It is not built here because it changes what Done means for a thread
(read at GitHub would close it in triage) and that is the owner's call; the
mechanism is named so the next session does not invent a daemon for what
is a `reconcile`.
