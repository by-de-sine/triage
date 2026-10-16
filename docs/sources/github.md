# GitHub

Your notifications inbox, and optionally the open issues of repositories
you name. On whenever a token resolves.

## What it reads

**The inbox.** `GET /notifications`, conditionally: a `304` costs nothing,
and the API's `X-Poll-Interval` sets how often. For each thread that moved
it fetches the subject and — for issues and pull requests — the comments,
review comments and reviews since it last looked. Unread threads only,
unless `TRIAGE_GITHUB_ALL=1`.

**Open issues as state** (optional). For each repository in
`TRIAGE_GITHUB_ISSUES`, every open issue is read whole every
`TRIAGE_ISSUES_EVERY_MIN` — oldest-updated first, at most ten pages of a
hundred, and a capped read is marked incomplete. GitHub does not notify you
about issues you filed, so without this an issue filed (by you or an agent
acting as you) and never commented on is invisible. An issue closed on
GitHub is resolved by the source; one reopened comes back. The set governs
only the issues it read, so a pull request from the inbox is never resolved
for being absent from it. Which repositories is a list rather than an
inference, because "repos I work in" is not a question GitHub answers.

An issue is one item however it arrives: both halves key it `owner/repo#n`
and write the same fields, and the inbox keeps the thread id only it knows,
so Done still marks the thread read.

## Rules

`rules/thread.js`, shared with [GitLab](gitlab.md). Ordered, strongest
first. Bots — `[bot]` accounts, coderabbit, dependabot, GitLab's
`project_N_bot`/`group_N_bot`, `ghost` — are never "someone": a review bot
answering your comment is P3.

| Tier | Meaning | Rules |
|---|---|---|
| **P0** | someone is waiting on you | `reply_to_my_review_comment` — a human reply to your review comment · `reply_to_my_comment` — a human comment on a thread you commented in, newer than your last · `direct_mention` · `review_requested` — by a person · `new_pull_request` — a person opened a pull request in a repository you follow, within the last day |
| **P1** | yours, moving | `comment_on_my_thread` · `review_on_my_pr` |
| **P2** | worth knowing today | `state_change_on_mine` (merged, closed) · `assigned` · `issue_assigned_to_me` (an open issue with you on it, from either mode) · `my_open_issue` (you filed it and it is still open) · `new_issue` (a human opened one in a repository you follow) |
| **P3** | ambient | `release` · `own_activity` · `bot_only` · `ambient` (you are only subscribed) |

All five P0 rules [interrupt](../interrupts.md) by default. "CI failed on
your PR" is not a rule: the notifications API does not carry check runs
([plan §3](../plan.md#3-the-tiers-and-what-lands-in-each)).

## Done

Marks the thread read on GitHub (`PATCH /notifications/threads/:id`), so
the two inboxes agree. If GitHub refuses — no thread id, a token without
the scope, an outage — the item is still done locally and the reason is
kept on the action row.

## Configuration

| Variable | Default | |
|---|---|---|
| `TRIAGE_GITHUB` | unset | `on` · `off` · `fake`. Unset: on if a token resolves. `on` refuses to start without one; `fake` runs the canned inbox in `test/fake-github.js` |
| `GITHUB_TOKEN` | what `gh auth token` holds | must be a **classic** token with `notifications` (or `repo`): the notifications endpoints do not accept fine-grained tokens |
| `TRIAGE_TOKENS_DIR` | `~/.config/triage/tokens` | per-owner tokens, used for that owner's repositories. Each entry is named for the owner and is either a file holding a token (fine-grained is fine here) or a `gh` config directory holding `hosts.yml`, asked with `gh auth token` every ten minutes |
| `GITHUB_USER` | `GET /user` | who you are: the `me` the rules compare against, and the `user` items are filed under |
| `TRIAGE_GITHUB_URL` | `https://api.github.com` | a GitHub Enterprise API base, `https://host/api/v3` |
| `TRIAGE_GITHUB_ALL` | unset | `1` reads threads you have already marked read too |
| `TRIAGE_GITHUB_ISSUES` | — | repositories whose open issues are read as state, `owner/name` comma-separated (a URL is accepted). `TRIAGE_ISSUES` is read as an alias |
| `TRIAGE_ISSUES_EVERY_MIN` | `5` | how often each open set is read; `0` reads it on every poll. Shared with GitLab |

## Asking "would that have been P0?"

```bash
node bin/replay.js owner/repo#123
```

Runs the rules over one real thread's history, step by step, and prints
what each step would have decided. It reads GitHub and writes nothing.
