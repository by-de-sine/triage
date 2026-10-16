# Configuration

Configuration is the environment, or a `.env` file — `~/.config/triage/.env`
by default, or whatever `TRIAGE_ENV` names (it **replaces** the default
file rather than layering on it). Nothing is read from the repository.
[`.env.example`](../.env.example) lists every variable, commented.

The file is plain `KEY=value`: no quotes, no spaces around `=`, `#` only at
the start of a line, and `~` is not expanded. The boot log says which mode
every source came up in, and why.

A value a variable does not recognise — a mode, a statement, a mention
form, a repository name — is **refused at boot** rather than read as the
default, so a typo cannot silently turn something off.

## Core

| Variable | Default | |
|---|---|---|
| `TRIAGE_ENV` | `~/.config/triage/.env` | which `.env` to read. Under `TRIAGE_DEMO=1`, no `.env` is read unless this names one |
| `TRIAGE_DEMO` | unset | `1` boots every source on its fake, the store in memory, and delivery off — see [the README](../README.md#try-it). `npm run demo` sets it |
| `TRIAGE_PORT` · `TRIAGE_HOST` | `3300` · `127.0.0.1` | port `0` takes any free one; the boot log names it |
| `TRIAGE_DB` | `~/.local/state/triage/triage.db` | the store. In memory under `TRIAGE_DEMO=1` unless set |
| `TRIAGE_TZ` | the system zone | for the quiet window and reports |
| `TRIAGE_COMMIT` | unset | set by a deployer, never by hand: the commit `/healthz` reports as running ([deploy](deploy.md)) |

## Sources

Each source is off until configured, and each has a `fake` mode that runs
its canned world from `test/`. Variables are on each source's page:

| Source | Turns on with | Page |
|---|---|---|
| GitHub | a token — `GITHUB_TOKEN`, or what `gh auth token` holds | [github.md](sources/github.md#configuration) |
| GitLab | a token — `GITLAB_TOKEN`, or what `glab auth token` holds | [gitlab.md](sources/gitlab.md#configuration) |
| Calendar | `TRIAGE_CALENDAR_URL` or `TRIAGE_CALENDAR_FILE` (or Google credentials) | [calendar.md](sources/calendar.md#configuration) |
| Ledger | `TRIAGE_LEDGER` | [ledger.md](sources/ledger.md#configuration) |
| Home Assistant | `HA_URL`, `HA_TOKEN`, `HA_LISTS` | [home-assistant.md](sources/home-assistant.md#configuration) |
| CRM | `TWENTY_URL`, `TWENTY_API_KEY`, `TRIAGE_CRM_ME` | [crm.md](sources/crm.md#configuration) |

With no source configured at all, the process says so and exits.

## Delivery and interrupts

`TRIAGE_SLACK`, `TRIAGE_WEBHOOK_URL`, `TRIAGE_NOTIFY`, `TRIAGE_MENTION`,
`TRIAGE_QUIET`, `TRIAGE_COALESCE_MIN`, `TRIAGE_DELIVER_MAX_AGE_H`,
`TRIAGE_INTERRUPT`, `TRIAGE_PREFS` and the Slack app's tokens — see
[interrupts](interrupts.md#configuration).

## Ranking

`TRIAGE_RANK_*` — see [ranking](ranking.md#configuration).

## The preferences file

`TRIAGE_PREFS` (default `preferences.json` beside the `.env`) says what
interrupts you globally and per project, and what each project is worth.
See [making it yours](interrupts.md#making-it-yours) and
[`preferences.example.json`](../preferences.example.json). It is
gitignored, as are `google-oauth.json` and `google-token.json`, because in
a development checkout the directory beside the `.env` is the checkout.
