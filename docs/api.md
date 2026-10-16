# HTTP API

Bound to `127.0.0.1` (`TRIAGE_HOST`), JSON throughout. A browser `Origin`
from another host is refused on writes; `curl` sends none.

## Items and the list

| | |
|---|---|
| `GET /` | the list page (`public/`, no build) |
| `GET /api/items` | `?tier=&state=&source=&since=&order=&limit=` — by rank, then recency, each item with its `features`. `order=score` is the tier's own ordering, which the interrupt path reads |
| `GET /api/items/:id` | one item with its events, decisions, actions and deliveries |
| `POST /api/items/:id/act` | `{action: done\|snooze\|later\|mute\|open\|answer, until?, choice?, by?}`. `until` is an ISO time or `30m` / `1h` / `1d`; `choice` is a letter or a label from the item's `choices`. Answers with the item and, for done, `marked`: what the source did about it |
| `GET /api/lists` | `?limit=&group=source\|repo\|tier\|kind\|owner&tier=&repo=&source=&owner=&q=` — `queue` (everything open), then `snoozed` and `later`, each row with its reason, rank and the sentence for the term that placed it. Filters are echoed as `filter`; `counts` stays the whole queue's by tier |
| `GET /api/aggregates` | `?state=open\|snoozed\|later\|done\|muted\|all` — the queue as counts, for a program: `total`; `by` source, repo, rule (strongest per item), `matches` (every rule that fired), tier, kind and age band; `share`, how much of the list is one repo, source or kind; and `rank` statistics with a ten-bucket histogram |

## Verdicts and delivery

| | |
|---|---|
| `GET /api/decisions` | `?tier=&rule=&by=&item=&since=&delivered=&limit=` — every verdict with its rule and what delivery said: `sent`, `updated … (coalesced)`, `held`, or `not delivered: <why>`. Each row's `by` is `rule`, or `wake` for a snooze ending |
| `GET /api/interrupts` | the interrupt statements by layer, the effective set, and which sources declare a project. `?source=&rule=` with `&project=` or `&item=` answers *would this interrupt, and which statement says so* |
| `GET /api/rank` | the weights, the time curves, the stated preferences, the interrupt set, and how many items are unranked |
| `POST /api/rank/backfill` | `?all=1&limit=` — the [bounded bootstrap pass](ranking.md#backfill). Walks only what has never been ranked unless `all=1` |

## Sources and health

| | |
|---|---|
| `GET /api/sources` | registered sources, their cursors (as each source describes them — never a URL or a token) and health |
| `POST /api/sources/:name/run` | poll now; answers with what was stored and decided |
| `GET /healthz` | `ok`, when it started, `commit` (from `TRIAGE_COMMIT`, or null), `user` and `identity` per source, item and decision counts, failing sources, when each last read successfully, and what delivery would do |

## Reports

| | |
|---|---|
| `GET /stats` | the reports page (`public/stats.html`) |
| `GET /api/reports` | the reports there are, and the question each answers: `flow`, `when`, `where`, `response` |
| `GET /api/reports/:name` | `?since=&until=&bucket=hour\|day\|week&by=&source=` — one report over a window, bucketed in `TRIAGE_TZ`; thirty days by the day by default |

What each report means is on [using the list](using.md#reports). Nothing
in this API writes a judgement: the only writes are actions, a poll, and
the backfill.
