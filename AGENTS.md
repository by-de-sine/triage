# AGENTS.md — triage

Instructions for agents working in this repository.

- **How to work on it:** [CONTRIBUTING.md](CONTRIBUTING.md) — the layout,
  the seams, running an instance, proving delivery, where each test goes,
  the conventions. Read it first.
- **What it does:** [README.md](README.md) and [docs/](docs/).
- **What it holds and what a contributor can reach:**
  [SECURITY.md](SECURITY.md).
- **What is still intended:** [docs/plan.md](docs/plan.md). Sections 6
  (stack, repo, deployment), 7 (milestones) and 10 (decisions) are decided
  and are not re-litigated in a build session. Where the docs and the plan
  differ, the docs describe what shipped; a deviation worth keeping is
  written into the plan as a dated note.

## Rules for agents

- **One worktree per task**, on its own branch, with its own running
  instance: its own `.env` (handed to the process as `TRIAGE_ENV`), store
  (`TRIAGE_DB`) and port (`TRIAGE_PORT`, on 127.0.0.1). Never edit the
  checkout production runs from. How a worktree is published (a hostname,
  a proxy, a unit) belongs to the box, not this repo.
- **Slack is off in every worktree: no `SLACK_` line of any kind** in its
  `.env`. A webhook URL posts to the real channel from a branch; a token
  opens a second Socket Mode connection that receives every button press.
  Prove delivery against a loopback listener
  ([CONTRIBUTING.md](CONTRIBUTING.md#proving-delivery)). Only production
  talks to Slack.
- **A worktree reads your real GitHub** with the token production uses, and
  Done on its page marks the real thread read. Press Done only when you
  mean it, and leave `TRIAGE_GITHUB_ALL` unset — a full read can spend the
  token's hourly rate limit, which production shares.
- **Never point a worktree at a real Home Assistant** (its token is not
  read-only). A real GitLab token or calendar is allowed, but say so in the
  PR.
- **No model, no opinion in the store** — see
  [CONTRIBUTING.md](CONTRIBUTING.md#the-seams). A change that wants one
  goes to the plan first.
- **`npm test` before every push, and CI green before anyone reads the
  PR.** CI runs the suite in two zones (`TZ=UTC npm test` catches what
  your zone hides), boots the demo with nothing installed, and installs
  the lock file. The workflow is `.github/workflows/ci.yml`; it runs on
  GitHub's own actions only, pinned to commits — do not add a third-party
  action to it.
- **CodeRabbit is spent on purpose.** Open a real pull request when the
  work is done, and add the `coderabbit` label once, as the last act, when
  nothing more will be pushed — every later push is another review from a
  shared hourly quota. Fix what it finds in one push.
- **Merging deploys.** Agents open the pull request; the owner merges it,
  and production follows within minutes. Anything a deploy needs first (a
  credential, a new `.env` line, a manual step) goes at the top of the PR
  body. Agents do not merge.
