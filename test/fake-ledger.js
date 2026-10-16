// A canned ledger: a queue file and its handoffs, written to a temp dir the
// way test/ledger.test.js writes one, for `TRIAGE_DEMO=1`. The ledger source
// reads local files and nothing else, so the fake is real files — the
// source, its rules and reconcile all run as they would on a box's queue.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A local `YYYY-MM-DD` `n` days from `t`, by the calendar rather than by
 *  86,400,000 ms, so a nudge date is the day it says in any zone. */
const day = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** A queue shaped like a week's, relative to `now`. One of each thing the
 *  ledger rules separate — a choice to make, an ack, an action past its
 *  nudge, an action not yet due, an agent's own row, a struck row — and a
 *  handoff waiting on review. Obviously fake: every row says so. Returns the
 *  paths the source reads and a `cleanup` that removes them. */
export function demoLedger({ now = () => new Date() } = {}) {
  const t = now().getTime();
  const dir = mkdtempSync(path.join(tmpdir(), 'triage-demo-ledger-'));
  const file = path.join(dir, 'OPEN_LOOPS.md');
  const statusDir = path.join(dir, 'status');
  mkdirSync(statusDir);
  writeFileSync(file, `# Open Loops

**The queue.** One line per open item; close a row by deleting it.

## Open

| Nudge | Owner | Item | Context |
|---|---|---|---|
| ${day(t, 2)} | \`human-decision\` | (fake) Which region does the Acme tenant move to [confirm: us-east · eu-west · leave it] | the export times out past 10k rows either way |
| ${day(t, 5)} | \`human-laptop\` | **(fake) The deploy token was reissued** [ack] | nothing to do but know |
| ${day(t, -3)} | \`human-sudo\` | (fake) Open port 8443 for the staging proxy [action] | one rule; the proxy is up and waiting |
| ${day(t, 9)} | \`human-decision\` | (fake) Renew the widgets.example domain [action] | auto-renew is off on purpose |
| ${day(t, 1)} | \`agent\` | (fake) Re-run the flaky upload test on main | an agent's row: nothing for you |
| ${day(t, 30)} | \`human-laptop\` | ~~(fake) Rotate the old CI key~~ (kept for history) | superseded |
`);
  writeFileSync(path.join(statusDir, 'acme--widgets.md'), `# acme/widgets\nstate: review\nnext: (fake) merge #41 once the 502 path streams too\nupdated: ${day(t, 0)}\n`);
  writeFileSync(path.join(statusDir, 'acme--site.md'), `# acme/site\nstate: done\nnext: nothing\nupdated: ${day(t, -7)}\n`);
  return { file, statusDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
