# Ranking

Everything open is in **one ordered list**. The order is a function of
data triage holds, computed by `lib/rank.js` and nothing else — no model.

## Tiers

Every rule belongs to a tier, and the tier means the same thing for every
source:

| Tier | Means |
|---|---|
| **P0** | someone is waiting on you, or something is about to start |
| **P1** | yours, and moving |
| **P2** | worth knowing today |
| **P3** | ambient |

The tier is a category and one input to the rank — it is a word on the
row, not a section of the list, and it does not decide what interrupts
(see [interrupts](interrupts.md)). Each source's page has its rule table:
[GitHub & GitLab](sources/github.md#rules),
[calendar](sources/calendar.md#rules), [ledger](sources/ledger.md#rules),
[Home Assistant](sources/home-assistant.md#rules),
[CRM](sources/crm.md#rules).

## The rank

Three structural terms:

| Term | Weight | What it is |
|---|---|---|
| **claim** | `TRIAGE_RANK_W_CLAIM` (1) | the hold this has on you, from the rules that fired. Each rule declares a claim 0–1 (`reply_to_my_review_comment` 1, `state_change_on_mine` 0.25, `bot_only` 0.05). The strongest sets the floor; every other match adds `TRIAGE_RANK_CORROBORATE` (0.25) of its own |
| **time** | `TRIAGE_RANK_W_TIME` (0.6) | a curve the **source picks per item**, from the rules that fired: `waiting` (0.5 when it lands, rising — a reply someone is waiting on gets more urgent), `fading` (news, 12 h half-life — a merged pull request goes stale), `spike` (a meeting: flat inside the quarter hour, nothing an hour after the start), `flat`. 0.5 means "time says nothing", so the curves blend |
| **prefer** | `TRIAGE_RANK_W_PREFER` (0.4) | stated preference: `TRIAGE_RANK_PREFER`, e.g. `repo:acme/widgets=0.8, actor:carol=0.5`, plus each project's `weight` in the preferences file |

The blend is a weighted mean **over the terms that are present**. A term
nobody computed is *absent* and leaves the denominator, rather than
scoring zero — "we do not know" is not "there is none".

**Stability.** The match set and the base are stored on the item; the time
term is recomputed when the list is read, because a rank written at
decision time is stale within the hour. A rank that has moved less than
`TRIAGE_RANK_HYSTERESIS` (0.02) reads as the stored one, so the list does
not rearrange under your hand.

Every term keeps its weight and its own sentence on the item. The row shows
the top one ("why it is here"); the hover shows the rank and the whole
match set.

`items.score` is separate from `items.rank`: tier first, recency second,
Later divided by ten thousand. The interrupt path reads it.

## Backfill

`lib/backfill.js` is one bounded pass over items the ranker has never
seen — the bootstrap for a store that predates it. For each item the rules
re-run against **the events its recorded verdict was about**, not the whole
history: every event-local rule asks "did this happen *now*", and a whole
thread's life would turn "now" into "ever". It writes no decision rows and
marks what it cannot know as absent. It runs once at boot (up to
`TRIAGE_RANK_BACKFILL`, 500) and on `POST /api/rank/backfill`.

## Configuration

| Variable | Default | |
|---|---|---|
| `TRIAGE_RANK_W_CLAIM` · `TRIAGE_RANK_W_TIME` · `TRIAGE_RANK_W_PREFER` | `1` · `0.6` · `0.4` | the weights |
| `TRIAGE_RANK_PREFER` | — | `repo:owner/name=0.8, source:calendar=0.3, actor:login=0.5, kind:pull=0.2`, weights −1…1. A bare `owner/name` is a repo |
| `TRIAGE_RANK_CORROBORATE` | `0.25` | what each match beyond the strongest adds. `0` is "strongest only" |
| `TRIAGE_RANK_HYSTERESIS` | `0.02` | how far a rank must move before the list reorders |
| `TRIAGE_RANK_BACKFILL` | `500` | how many unranked items the boot pass takes; `0` disables |
| `TRIAGE_RANK_W_RELEVANCE` · `TRIAGE_RANK_W_EFFORT` | `0` | declared and permanently absent — they were a model's features ([plan §13.4](plan.md#134-what-it-costs-named-honestly)). Setting them does nothing |

`GET /api/rank` shows the weights, the registered time curves, the stated
preferences, the interrupt set and how many items are unranked.
