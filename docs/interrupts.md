# Interrupts

Every verdict is placed in the list. A few also **interrupt**: they are
sent as a message — to Slack, Discord or any webhook — within a minute of
landing. Which ones is a short named list of rules per source, not a tier.

## The default set

| Source | Rules that interrupt out of the box |
|---|---|
| GitHub · GitLab | `reply_to_my_review_comment` · `reply_to_my_comment` · `direct_mention` · `review_requested` · `new_pull_request` |
| Calendar | `starts_in_15_min` · `new_invitation` |
| CRM | `handed_to_me` · `changed_on_my_task` · `crm_unread` |
| Ledger · Home Assistant | nothing |

The set and the tiers may disagree: `new_invitation` is a P1 and
interrupts. Every decision row says what happened to it — `sent`, `held`,
or `not delivered: <rule> does not interrupt (<the statement that said
so>); it is in the list`.

## Guards

| | |
|---|---|
| **Quiet window** | `TRIAGE_QUIET` (default `23:00-07:00`, in `TRIAGE_TZ`). Interrupts are held and sent when it ends |
| **Coalescing** | one message per item per `TRIAGE_COALESCE_MIN` (10). The first alarm for an item is never held — it goes the moment the verdict lands, and that opens the window. A second one inside the window is held and sent once, as a follow-up, when the window ends (under the app, the message is updated instead, and a later one is a reply in its thread — below) |
| **Age** | an event older than `TRIAGE_DELIVER_MAX_AGE_H` (24) is tiered but not sent, so a first boot does not replay your inbox into Slack |
| **Acting first** | a held message is dropped if you act on the item before it goes out |
| **Snooze** | a snooze that wakes as a P0 is always sent — you asked to be interrupted then. One that wakes as anything else goes back in the list |

## Where it goes

`TRIAGE_SLACK` picks the delivery path: `webhook`, `app` or `off`. Unset,
it infers: `webhook` if a webhook URL is set, `app` if `SLACK_BOT_TOKEN` is,
otherwise off. With both set, the webhook wins.

### Webhook

One URL in the `.env`, one message per interrupt, to the channel the
webhook was created for. No buttons, no redraw, no Home tab.
`TRIAGE_NOTIFY` picks the shape, inferred from the URL's host when unset:

| Shape | Host | Message |
|---|---|---|
| `slack` | `hooks.slack.com` | the app's message without the act buttons; **Open** (and a meeting's **Join**) as links |
| `discord` | `discord.com` | one markdown message. Only the configured mention may notify (`allowed_mentions`): a `<@id>` a commenter typed is quoted, never pinged |
| `generic` | anything else | JSON with `text`, `mention`, `item`, `decision` and `event`, for a script to do what it likes with |

**Set `TRIAGE_MENTION`.** A channel message that names nobody is an unread
badge, not a push notification, under Slack's and Discord's default
settings. The mention is what turns *delivered* into *arrived*:

| Shape | `TRIAGE_MENTION` takes |
|---|---|
| Slack | a user id (`U…`/`W…`), a user group (`S…`), `!here`, `!channel`, or those in `<…>` markup |
| Discord | a user id (digits or `<@id>`), a role (`<@&id>`), `@here`, `@everyone` |
| generic | any text, passed through as `mention` |

A Slack or Discord form it does not recognise is refused at boot (a bare
name would render as a word and notify nobody); `off` means nobody, on
purpose.

**Point the webhook at a channel you are alone in.** What goes through it
is a thread title, a repository name and a line of a comment, from private
repositories too, and nothing in the code can check where a webhook
points. The URL is the credential: it is never logged, stored or returned
(only its host is). It must be `https`, except on loopback. A post is
abandoned after ten seconds and never retried, and a redirect is an error.

### Slack app

Bolt in Socket Mode, so Slack never needs to reach the box. It is the only
path with buttons, a DM, `/triage` and a Home tab, and it is the direction
the output grows in ([plan §16.5](plan.md#165-the-bolt-app-path-stays-by-decision-and-is-the-direction)).
Create the app from [`slack/manifest.yml`](../slack/manifest.yml) (its
comments say which token is which), then set `SLACK_BOT_TOKEN`,
`SLACK_APP_TOKEN` and `SLACK_USER_ID`, and `npm ci` for the two Slack
packages.

One DM per item: title, repository, who did what, one line of the
comment, and **Open · Done · Snooze 1h · Snooze 1d · Later · Mute thread**.
A meeting's DM is its title, start, place and guests, with **Join** first.

**That DM is where the item lives**, and it follows the item:

| What happened | The DM |
|---|---|
| you pressed something, here or on the page | says what you did; the buttons go (your reopen brings them back) |
| its source resolved it (a ledger row deleted, an issue closed) | `✓ resolved at its source`, no buttons; back in the set, the buttons return |
| the snooze ended as less than a P0 | the buttons return, under `⏰ snooze ended` |
| new activity reopened it | the buttons return, under `↺ reopened by new activity` |
| a newer verdict landed that does not interrupt | keeps its words, with a `since:` line naming the newer one |
| another interrupt, inside the coalesce window | updated in place, silently |
| another interrupt, after it (a P0 snooze waking included) | updated, and the interrupt is a **reply in its thread**, broadcast to the conversation so it notifies. The buttons stay on the DM |

A DM that has been deleted is answered by posting a fresh one, which is
the item's DM from then on. The rank's position is not on the DM, so the
order drifting with time redraws nothing.

**The Home tab is kept current:** republished a moment after the lists
change (a burst of changes is one publish), every fifteen minutes so the
time terms show, and at boot — not only when it is opened.

`/triage` also answers as `/triage-<anything>`, for a second app made from
the manifest for development
([CONTRIBUTING.md](../CONTRIBUTING.md#proving-delivery)).

## Making it yours

The default set is a starting point, not the mechanism. Four layers,
later winning, and **the most specific statement in the highest layer
wins**:

| | Layer | Where | For |
|---|---|---|---|
| 0 | the default set | `deliver/interrupts.js` | a fresh clone |
| 1 | yours, globally | `TRIAGE_PREFS` → `.interrupts` | "also tell me about a new issue" |
| 2 | yours, per project | `TRIAGE_PREFS` → `.projects[…].interrupts` | "…but only in this repo" |
| 3 | from the shell | `TRIAGE_INTERRUPT` | "silence that, now" |

A **statement** is `[+|-]source:rule[@project]`. `+` arms, `-` mutes, `*`
is a wildcard anywhere, and a project may glob (`owner/*`). Signed
statements are a delta on the layer beneath; an **unsigned list replaces**
it. So you never restate the defaults to change one thing about them.

**What a project is, each source says:** GitHub's is the repository,
GitLab's the project path, the calendar's the calendar id, the CRM's the
company's project, Home Assistant's the list (`todo.household`). The
ledger declares none, so only statements without an `@project` reach it.

`TRIAGE_PREFS` is a JSON file — `preferences.json` beside the `.env` by
default, absent normally. A malformed file fails the boot rather than
silently meaning "no preferences". See
[`preferences.example.json`](../preferences.example.json):

```json
{
  "interrupts": { "github": ["+new_issue"], "calendar": "off" },
  "projects": {
    "acme/*":        { "weight": 0.6, "interrupts": { "github": ["+comment_on_my_thread"] } },
    "alice/scratch": { "weight": -0.5, "interrupts": "off" }
  }
}
```

`"off"` and `"all"` are the shorthands: a project that must never
interrupt, and one that is on fire. A project's `weight` is not a fifth
layer — it feeds the [ranker's](ranking.md) stated preferences, and never
moves the interrupt bar by itself. `TRIAGE_RANK_PREFER` and
`TRIAGE_INTERRUPT` win over the file for the same key.

### Asking why

```bash
curl -s localhost:3300/api/interrupts                                         # every statement by layer, and the effective set
curl -s 'localhost:3300/api/interrupts?source=github&rule=new_issue&project=acme/widgets'   # would this interrupt, and which statement says so
```

`&item=<id>` asks the same question about a stored item.

## Configuration

| Variable | Default | |
|---|---|---|
| `TRIAGE_SLACK` | inferred | `webhook` · `app` · `off`, as above. An unknown value is refused at boot |
| `TRIAGE_WEBHOOK_URL` | — | the webhook: Slack incoming webhook, Discord channel webhook, or any JSON endpoint. `SLACK_WEBHOOK_URL` is read as an alias |
| `TRIAGE_NOTIFY` | inferred from the URL | `slack` · `discord` · `generic` · `off`. `off` turns the webhook off whatever the URL says |
| `TRIAGE_MENTION` | nobody | who an interrupt names, in the shape's grammar. Ignored under `app`, where a DM notifies on its own. Does not fall back to `SLACK_USER_ID` |
| `TRIAGE_QUIET` | `23:00-07:00` | the quiet window; empty disables |
| `TRIAGE_TZ` | the system zone | for the quiet window and the reports |
| `TRIAGE_COALESCE_MIN` | `10` | the coalesce window |
| `TRIAGE_DELIVER_MAX_AGE_H` | `24` | the age guard |
| `TRIAGE_INTERRUPT` | — | layer 3: statements, comma-separated. `off` interrupts on nothing; a source named with no rules interrupts on none |
| `TRIAGE_PREFS` | `preferences.json` beside the `.env` | layers 1 and 2 |
| `SLACK_BOT_TOKEN` · `SLACK_APP_TOKEN` · `SLACK_USER_ID` | — | the app path only. Without the bot token and user id nothing is sent; without the app token, DMs go out but no button, `/triage` or Home tab answers |
