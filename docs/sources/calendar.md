# Calendar

The events starting in the next 48 hours. A P0 fifteen minutes before one
begins, a P1 for an invitation you have not answered, and the rest of the
day in the list.

## Two readers

**An ICS feed** — the default. Every calendar publishes one: Google's
*Settings › your calendar › Integrate calendar › Secret address in iCal
format*, Outlook's *publish calendar* link, a Fastmail or Apple
subscription URL. There is no OAuth client and no consent step: **the URL
is the credential**, so it is never logged, stored or returned by the API
(only its host is).

- Fetched at most every `TRIAGE_CALENDAR_EVERY_MIN`, conditionally; between
  fetches the cached text is re-expanded every minute so the window and
  the alarm keep moving.
- Parsed by `lib/ics.js` — enough of RFC 5545 for a feed: unfolding, time
  zones through `Intl` (and the Windows zone names Outlook writes), all-day
  entries, `EXDATE`, `RECURRENCE-ID`, and `RRULE` daily, weekly, monthly
  and yearly with `INTERVAL`, `COUNT` and `UNTIL`. Stdlib only.
- An item is one event, or one occurrence of a recurring one
  (`<UID>@<occurrence>`). Its event key hashes what a rule reads, so a
  reschedule, a cancellation or an answer re-tiers it, and an unchanged
  feed emits nothing.
- **It is state, too:** an event gone from the feed is resolved by the
  source.
- Redirects are followed by hand, at most five and only to `https`; a body
  past 20 MB is abandoned as it streams.

**Google's `events.list`** — the other path, kept until the feed has run in
production for a week ([plan §16.7 b](../plan.md#167-not-decided-here--the-owners-calls)).
Incremental sync with a `syncToken`; events keyed
`calendar:<eventId>:<updated>`. It never resolves anything, since an
incremental sync has no whole set to compare. Needs an OAuth desktop client
and a one-time `node bin/google-consent.js` from a machine with a browser;
the scope is `calendar.readonly`.

## Rules

| Tier | Meaning | Rules |
|---|---|---|
| **P0** | it is about to start | `starts_in_15_min` — from the clock, not a poll. Never for one you declined, one that was cancelled, or an all-day entry |
| **P1** | someone is waiting for an answer | `new_invitation` — you are an attendee, have not answered, and it is not your own event. In a feed this needs `TRIAGE_CALENDAR_ME` to know which attendee is you |
| **P2** | worth knowing today | `day_ahead` — anything else in the window |
| **P3** | nothing to do | `declined` · `cancelled` · `all_day` · `own_event` (yours, nobody else on it) · `ambient` |

Both `starts_in_15_min` and `new_invitation` [interrupt](../interrupts.md)
by default. A timed event of your own with no guests is P3 in the list but
still rings fifteen minutes out: a calendar cannot tell a focus block from
a dentist appointment, and of the two errors silence is worse. All-day
entries never ring.

The calendar's **project** is the feed's name (`X-WR-CALNAME`) unless
`TRIAGE_CALENDAR_ID` names one.

## Done

Local only — triage never writes to a calendar. A feed cannot be written,
and the Google scope is read-only. Decline an invitation in the calendar;
the next read notices.

## Configuration

| Variable | Default | |
|---|---|---|
| `TRIAGE_CALENDAR` | unset | `off` · `ics` · `google` · `fake`. Unset: the feed if one is named, Google if its credentials resolve, otherwise off. `fake` runs the canned feed in `test/fake-calendar.js` — every title says `(fake)` |
| `TRIAGE_CALENDAR_URL` | — | the feed (`webcal://` is read as `https://`). Must be `https` except on loopback |
| `TRIAGE_CALENDAR_FILE` | — | the feed as a file on disk, re-read every poll. Not with `TRIAGE_CALENDAR_URL` |
| `TRIAGE_CALENDAR_ME` | — | your address on invitations, comma-separated. Without it no invitation is yours to answer, and the boot log says so |
| `TRIAGE_CALENDAR_EVERY_MIN` | `5` | how often the URL is fetched; `0` fetches every poll |
| `TRIAGE_CALENDAR_ID` | the feed's name · `primary` | which calendar, and so its project |
| `TRIAGE_CALENDAR_WINDOW_H` | `48` | how far ahead an event becomes an item |
| `TRIAGE_CALENDAR_SOON_MIN` | `15` | how long before the start the P0 fires |
| `GOOGLE_CLIENT_FILE` | `google-oauth.json` beside the `.env` | Google path: the OAuth desktop client (`{"installed": …}`). `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` override it |
| `GOOGLE_TOKEN_FILE` | `google-token.json` beside the `.env` | Google path: the refresh token `bin/google-consent.js` writes. `GOOGLE_REFRESH_TOKEN` overrides it |

To test without a real calendar, point `TRIAGE_CALENDAR_FILE` at a `.ics`
you edit between polls, or use `TRIAGE_CALENDAR=fake` and
`POST /api/sources/calendar/run`.
