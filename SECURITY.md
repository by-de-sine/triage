# Security

## Reporting a vulnerability

Use **Report a vulnerability** under the repository's Security tab (GitHub's
private vulnerability reporting). It reaches the maintainers and nobody else,
and the conversation stays private until a fix is out. Please do not open a
public issue for anything that could be a vulnerability.

What to expect: an acknowledgement within a few days, a fix on `main` —
which is the only supported version; there are no releases — and credit
in the advisory if you want it.

## What triage holds, and where

Triage runs on your own machine, as you, and reads the places your work
waits with your credentials. So the thing worth protecting is the `.env`
file, not the process:

- **Every credential is in `~/.config/triage/.env`**, which you keep at
  mode `0600`, in a file it names beside it (the two the Google path
  mints, a per-owner token in `TRIAGE_TOKENS_DIR`), or in the `gh` or
  `glab` store a forge token is borrowed from when the `.env` names none.
  Nothing is read from the repository. `.gitignore` names the defaults —
  `.env`, the preferences file, the two Google files — so none of them can
  be committed from a checkout; a tokens directory, or a credential file
  you named yourself, belongs outside the checkout, where no `git add`
  can reach it ([`.env.example`](.env.example) is the documented shape,
  with no values).
- **The tokens are read-mostly, and the writes are named.** GitHub's
  `notifications` scope, GitLab's `read_api` (plus `api` only if Done is to
  mark a todo done), a read-only CRM key, a calendar feed URL. The writes
  the tree makes are listed in each source's page under `docs/sources/`:
  Done marks a thread read, a todo done or a chore ticked, and that is
  all. Home Assistant's token is the one that is not read-only, which is
  why no development instance is ever pointed at a real one
  ([AGENTS.md](AGENTS.md)).
- **The page binds to `127.0.0.1` and has no authentication of its own.**
  Anyone who can reach the port can act on your queue — Done, Snooze, Mute
  — so put it behind a proxy that authenticates before you put it on a
  hostname ([deploying](docs/deploy.md)). The API never returns a token.
- **What leaves the box** is one HTTP POST per interrupt to the webhook you
  configured, or a Socket Mode connection the Slack app opens outbound.
  The message carries the item's title, link and the rule that fired, and
  the one line that says why — a comment's first line, a meeting's
  location and guests; the generic shape also carries the item's data and
  the event's body cut at 600 characters, because the endpoint is yours
  to render. That is private work, so it goes only to the endpoint you
  named, over https unless the endpoint is loopback, and never follows a
  redirect. Nothing from your `.env` is ever in it. Logs name a feed's
  host, never its URL, and never a token.
- **Two dependencies**, both from Slack, both loaded only under
  `TRIAGE_SLACK=app`; the tests and the demo run with no `node_modules`.
  Dependabot keeps them and the pinned CI actions current.

## What a contributor can reach

The repository is public and takes pull requests from anyone, and is set up
so that a pull request can reach nothing it should not:

- **CI runs on `pull_request`, never `pull_request_target`.** A fork's code
  runs in its own context: a read-only `GITHUB_TOKEN`, no secrets — there
  are none on the repository to begin with — and nothing from the event
  interpolated into a shell. The actions are GitHub's own, pinned to commit
  SHAs. The whole workflow is [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
- **A first run from a fork waits for a maintainer.** The repository
  requires approval for workflows from all external contributors, so a
  stranger's pull request runs nothing until someone has read it. The
  `main` branch takes only pull requests whose checks have passed.
- **CodeRabbit reviews on request, for members.** Nothing is reviewed until
  a maintainer adds the `coderabbit` label, only members of the
  organisation can talk to it on a thread, and what it learns on this
  repository stays on this repository. The policy is
  [`.coderabbit.yaml`](.coderabbit.yaml); the same settings are the
  organisation's global overrides on CodeRabbit's side, which a branch
  cannot change.
- **Merging deploys** to the maintainer's own box, which is why a
  maintainer merges, and why anything a deploy needs comes first in the
  pull request ([CONTRIBUTING.md](CONTRIBUTING.md#pull-requests)).

## Not in scope

Triage is one person's queue on one person's machine. A report that needs
a second user on the same instance, or the page reachable from the open
internet without a proxy in front of it, describes a deployment the tree
does not support rather than a vulnerability in it — see
[architecture](docs/architecture.md) and [deploying](docs/deploy.md).
