# CRM (Twenty)

[Twenty](https://twenty.com)'s tasks and notes, on an API key bound to a
role that can read every record and change none. Off unless `TWENTY_URL`,
`TWENTY_API_KEY` and `TRIAGE_CRM_ME` are all set.

It is **state and a feed at once**:

- **State:** every open task is an item. A task completed or deleted in
  Twenty is resolved by the source — only against a read that saw every
  page.
- **Feed:** a task or note created or changed by somebody who is not you is
  news. By default it interrupts only when it lands on a task assigned to
  you (the P0 rules below); the rest is placed in the list.

## Who is "not you"

Read from each record's own `updatedBy`: not your workspace member
(`TRIAGE_CRM_ME`) and not one of your agents' API key names
(`TRIAGE_CRM_AGENTS`). Anything else — including a key nobody has named —
is somebody else.

That is the safe direction to be wrong in, and the one that drifts: a key
minted after the list was written is somebody else until someone notices,
and what they notice is their own agents' edits arriving as P0s. So the
first time a key nobody named edits a record, the log says so once —
`"Kevin" edits records through the API and is on no list … add it to
TRIAGE_CRM_AGENTS` — and the poll's status line names it for as long as it
keeps editing. If the key is yours, add it and restart; its edits then
re-rank quietly, and the [reports](../using.md#reports) count them as yours.

Twenty has no comments, so a collaborator's reply arrives as an edit to a
body or a new note. That is why the event is keyed on the record **and a
fingerprint of its content** (title, body, status, assignee, due): an edit
is news here, where every other source is blind to edits.

**The first read is a baseline** and interrupts on nothing. Switching one
store from `fake` to a real Twenty makes the real read a non-baseline, and
everything anybody else last touched reads as news — give a live read a
store of its own.

## The read itself is watched

No complete read within `TRIAGE_CRM_STALE_MIN` is a P0 of its own
(`crm_unread`) — one alarm per outage, resolved by the next complete read.
A quiet CRM therefore means nothing happened, not that nothing was read.

## Rules

"Yours" is the task's assignee; "wrote" is its `createdBy`, judged the same
way as "not you".

| Tier | Meaning | Rules |
|---|---|---|
| **P0** | the CRM is not being read | `crm_unread` |
| **P0** | someone is waiting on you | `handed_to_me` — somebody else created a task assigned to you, or moved one onto you · `changed_on_my_task` — somebody else changed a task assigned to you |
| **P1** | yours, and it moved | `changed_what_i_wrote` — somebody else changed a task or note you or your agents wrote, not assigned to you (usually the person you handed it to, reporting back) · `task_due` — due today or overdue |
| **P2** | worth knowing today | `changed_by_other` — anything else somebody else changed · `task_mine` — assigned to you |
| **P3** | somebody's | `task_open` · `ambient` |

Only the three P0s [interrupt](../interrupts.md) by default. To be told
about every edit again:

```bash
TRIAGE_INTERRUPT=+crm:changed_what_i_wrote,+crm:changed_by_other
```

The interrupt test reads the strongest match, so arm each step you want,
not just the bottom one.

Ranking: due or overdue first, then yours, then anybody's. A company's
tasks and notes belong to the project `TRIAGE_CRM_PROJECTS` maps it to, or
the company's own name.

## Done

Local only. The key could not write even if the source tried, and it has
no write path.

## Configuration

| Variable | Default | |
|---|---|---|
| `TRIAGE_CRM` | unset | `on` · `off` · `fake`. Unset: on if the three below are set. `fake` runs `test/fake-twenty.js`, where on the second read a colleague hands you a task (P0), rewords one you handed them (P1), and an unnamed key adds a note (P2) |
| `TWENTY_URL` · `TWENTY_API_KEY` | — | where Twenty is, and a key from *Settings › APIs › API keys* bound to a **read-only** role. Read over GraphQL. Never an admin key: triage must not be able to write to the system of record |
| `TRIAGE_CRM_ME` | — | you, as a workspace member: an id, email or full name, comma-separated. No default — a source that cannot recognise you reads all your own edits as somebody else's. An entry matching no member fails the read |
| `TRIAGE_CRM_AGENTS` | — | the `updatedBy.name` your agents' API edits carry (their keys' names), comma-separated. Unset means you have no agents. A key this list does not name is somebody else, and is named in the log the first time it edits something |
| `TRIAGE_CRM_PROJECTS` | — | `Company Name=project`, comma-separated, so preferences and interrupt statements can scope to a company |
| `TRIAGE_CRM_STALE_MIN` | `30` | minutes without a complete read before `crm_unread`. `0` turns the alarm off |

Unlike Home Assistant, pointing a development instance at a real Twenty is
safe — the key's role can update nothing. To test the alarm, use a bad key
and a short `TRIAGE_CRM_STALE_MIN`.
