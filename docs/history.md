# History

How triage got its shape, in one table. The reasoning for each step is in
the [plan](plan.md) under the section named; the pull requests before
2026-10-15 were in the previous repository, whose history was not carried
over.

| When | What | Plan |
|---|---|---|
| 2026-09-08 | **M0 · see it** — GitHub polled every minute, items stored, tiered, every decision logged, P0 as a Slack DM | §7 |
| 2026-09-09 | **M1 · act on it** — Done · Snooze · Later · Mute everywhere through one `act()`; the list page; quiet and coalesce windows. Done marks the GitHub thread read | §7 |
| 2026-09-09 | **M2 · make it readable** — summaries from a model. Removed 2026-09-12 | §13 |
| 2026-09-09 | **M3 · second source** — Google Calendar. The seam widened for every source (`due`, `describeCursor`, shape by `item.kind`) rather than naming one | §5, §7 |
| 2026-09-10 | **The interrupt path** — an incoming webhook instead of a Slack app; `TRIAGE_SLACK=webhook\|app\|off`; hold-and-follow-up coalescing | §11.6 |
| 2026-09-10 | **M5 · rank it** — every match rather than the first, `lib/rank.js`, one ordered list, the interrupt set, the backfill | §11 |
| 2026-09-12 | **No model** — the LLM, its tables and its dependency removed: triage is a source, not a mind | §13 |
| 2026-09-12 | The P1 batch and P2 digest retired: the list is the channel | §11.3 |
| 2026-09-12 | **The ledger** — the first state-shaped source; `reconcile`; the ask grammar | §12.2, §12.3 |
| 2026-09-13 | **Open issues as state** — GitHub's second mode; `governs` | §12.3 |
| 2026-09 | **Interrupt preferences** — four layers, `project(item)`, the mention; prompted by the first real interrupt, which arrived as an unread badge and notified nobody | §14 |
| 2026-09-19 | **Reports** — `/stats` and `/api/reports` | §15 |
| 2026-09-20 | **Home Assistant** — the first source that writes on Done, and the first that needed no widening of the seam | §12.8 |
| 2026-10-03 | **The CRM** — Twenty's tasks as state, others' edits as events, a watched read | §12.3 |
| 2026-10-15 | Moved to the `by-de-sine` organisation; this box's paths moved out of the defaults | §16 |
| 2026-10-15 | **G1 · forges** — `lib/forge-api.js`, GitLab, `rules/thread.js`; `whoami` and `mark` (#2) | §16.3 |
| 2026-10-15 | **G2 · webhook shapes** — `slack`, `discord`, `generic` (#3) | §16.3 |
| 2026-10-15 | **G3 · the demo** — `TRIAGE_DEMO=1`, every fake at once (#4) | §16.3 |
| 2026-10-15 | **G4 · ICS** — the calendar as a feed, `lib/ics.js` (#5) | §16.3 |

Still intended: **M6 · learn it** (revealed preference from actions,
saturation, hysteresis tuning), **G5 · the Slack app surface** (when the
app exists), and Gmail after the ranker. See the [plan](plan.md).
