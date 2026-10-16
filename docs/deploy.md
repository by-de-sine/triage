# Deploying

What a deploy of triage needs. How one happens belongs to the host that
runs it, not to this repository.

- **One Node process**, started from `<checkout>/server.js`. Nothing to
  build, no artifact, no container. Node ≥ 24 (for `node:sqlite`).
- **A deploy** is the checkout at the new commit, `npm ci` if and only if
  `package-lock.json` changed, and a restart. The lock file matters: the
  two packages (`@slack/bolt`, `@slack/web-api`) are loaded only under
  `TRIAGE_SLACK=app`, so a stale `node_modules` starts fine and fails at
  the first import on that path.
- **The store migrates itself at boot**, idempotently, and drops nothing
  without a dated note in the [plan](plan.md). Nothing rolls a migration
  back, so a **consistent snapshot before every restart** is the rollback
  story for the data. WAL is on, so a bare `cp` of the live file is not a
  snapshot; `node:sqlite`'s `backup()` against a read-only handle is.
- **`GET /healthz` answers 200 with `ok: true`** when it is up, and reports
  `commit` from `TRIAGE_COMMIT` when the deployer sets it (null otherwise).
  It never reads git, because the checkout on disk can move after the
  process started.

Run it as a service behind a reverse proxy if you want the page off the
box — it binds to `127.0.0.1` by default and has no authentication of its
own.

Only one instance should talk to a given Slack app or webhook. A second
Socket Mode connection to one app receives every button press too, and a
second instance with the webhook URL posts every interrupt twice.
