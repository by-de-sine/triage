# Home Assistant

The household's to-do lists — your inbox and the shared list, say — read
whole and reconciled. Off unless `HA_URL`, `HA_TOKEN` and `HA_LISTS` are
all set.

## What it reads

Each list in `HA_LISTS`, through `todo.get_items`, every poll. An item is
identified by Home Assistant's own **uid**, so renaming a chore keeps the
item and re-tiers it (the event key hashes summary, due date and status).
An item ticked off on the tablet leaves the set and is resolved by the
source; one un-ticked comes back.

## Rules

| Tier | Meaning | Rules |
|---|---|---|
| **P1** | it has a date, and the date is now or past | `due_today` — due today or overdue, on any list. A date with no time is due at the *end* of that day; past it, the item has been waiting since the date |
| **P2** | it is on your own list | `inbox_item` — anything on a list whose name ends in `inbox` (`todo.alice_inbox`) |
| **P3** | the house shares it | `household_item` — anything on a shared list; it follows the flat time curve, since a chore does not get more urgent by sitting on the fridge · `ambient` |

**Nothing here interrupts**, on purpose: putting the chores in the list is
what stops them being something you are buzzed about.

## Done

**Writes.** `todo.update_item` with `status: completed` on that item's list,
so ticking a chore off here ticks it off on the kitchen screen. If Home
Assistant refuses or cannot be reached, the item is still done locally and
the reason is on the action row.

## Configuration

| Variable | Default | |
|---|---|---|
| `TRIAGE_HA` | unset | `on` · `off` · `fake`. Unset: on if the three below are set. `fake` runs two canned lists from `test/fake-ha.js` — mutable, so Done and reconcile are exercised for real |
| `HA_URL` · `HA_TOKEN` | — | where Home Assistant is (`http://<host>:8123`, or a Nabu Casa URL) and a long-lived access token from *Profile › Security*. Home Assistant has no narrower grant: the token can do whatever its user can |
| `HA_LISTS` | — | which lists, as `todo.*` entity ids, comma- or space-separated. A list ending in `inbox` is yours; the rest are the house's |
| `TRIAGE_HA_DASHBOARD` | `<HA_URL>/todo` | where an item's **Open** goes. There is no deep link to a single to-do item |

Do not point a development instance at a real Home Assistant "to check":
the token is not read-only. Use `TRIAGE_HA=fake`.
