# Ledger

A markdown queue file that agents and scripts write to when they need
something from you, plus the handoff files beside it. Every row that waits
on a human is an item. Off unless `TRIAGE_LEDGER` names the file.

This is the most box-specific source in the tree: it reads one table format
with one vocabulary of owner kinds ([plan §16.4](../plan.md#164-what-stays-and-why)).

## What it reads

The file `TRIAGE_LEDGER` names, and `status/*.md` beside it. Local files,
no API, no credential, and **triage never writes to them**.

- A row is identified by its Item text, so bumping its nudge date keeps the
  item and rewording it makes a new one.
- The event key hashes the whole row, so any change re-tiers it.
- A row deleted by its owner leaves the set and is resolved by the source.

## Asking through the ledger

What a script or agent should write when it needs you is **a topic and one
of three asks** — acknowledge it, confirm or deny it, or do it — and the
more of them are multiple choice, the better. One table row, with a tag at
the end of the Item cell:

```markdown
| 2026-09-20 | `human-decision` | Rename the org [confirm: rename the user · new org · leave it] | why, briefly |
| 2026-09-20 | `human-laptop`   | The PAT was reissued [ack] | nothing to do but know |
| 2026-09-20 | `human-sudo`     | Point Caddy at the user config [action] | the one line to run |
```

- `[confirm]` alone is yes / no. Choices are separated by `·`, `;` or ` / `
  (never `|`) and lettered A, B, C… in order.
- No tag on a row of yours means `[action]`.
- The row appears on the page within a minute with a button per choice.
  Pressing one records the answer and closes the item.

**Reading the answer back** is one call:
`GET /api/items?source=ledger&state=done`, then the item's `actions`, where
the answer is `{action: "answer", data: {choice: "B", label: "new org"}}`.
The asker then deletes the row — the ledger's own rule for closing
anything. If they bump or reword it instead, it comes back as a new
verdict.

## Rules

"Yours" is an owner kind starting with `human-`. Grouping the list by
`owner` groups rows by what they take: `human-sudo`, `human-laptop`,
`human-htpc`, `human-decision`, `agent`.

| Tier | Meaning | Rules |
|---|---|---|
| **P1** | yours, and quick | `quick_answer` — a row of yours tagged `[ack]` or `[confirm: …]`. Ranked above an overdue action: a multiple choice is the cheapest thing on the list |
| **P1** | yours, and past its date | `past_its_nudge` — its nudge date has passed. It has been waiting since that date, so the longer overdue, the higher it sits |
| **P2** | yours, an action | `waiting_on_you` — tagged `[action]`, untagged, or a handoff in `review` or `blocked` |
| **P3** | not yours | `kept_for_history` (struck through) · `agents_own` (owner `agent`) · `ambient` |

**Nothing in the ledger interrupts.** Every row is placed in the list.

## Done

Local only. An `[ack]` row's button is Done; a `[confirm]` row's buttons
are its choices (the `answer` action).

## Configuration

| Variable | Default | |
|---|---|---|
| `TRIAGE_LEDGER` | unset | the queue file; its `status/` sibling is the handoffs directory. Refuses to start if the file is missing. Unset or `off` never registers the source |

The read is local and read-only, so a worktree can point at the real file.
