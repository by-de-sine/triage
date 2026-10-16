import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';

const item = (over = {}) => ({ user: 'alice', source: 'github', key: 'octo/repo#1', kind: 'pull', title: 'Fix it', url: 'https://github.com/octo/repo/pull/1', repo: 'octo/repo', actors: ['a'], my_role: 'authored', last_activity: '2026-09-01T00:00:00Z', last_seen: '2026-09-01T00:00:00Z', ...over });

test('migrations are idempotent', () => {
  const s = new Store();
  s.migrate(); s.migrate();
  assert.deepEqual(s.counts(), { items: 0, decisions: 0 });
  s.close();
});

test('upsert creates once and refreshes without touching tier or state', () => {
  const s = new Store();
  const a = s.upsertItem(item());
  assert.equal(a.created, true);
  s.setTier(a.item.id, 'P1', 100);
  s.setState(a.item.id, 'snoozed', '2026-09-02T00:00:00Z');
  const b = s.upsertItem(item({ title: 'Fix it properly', actors: ['a', 'b'] }));
  assert.equal(b.created, false);
  assert.equal(b.item.id, a.item.id);
  assert.equal(b.item.title, 'Fix it properly');
  assert.deepEqual(b.item.actors, ['a', 'b']);
  assert.equal(b.item.tier, 'P1');
  assert.equal(b.item.state, 'snoozed');
  assert.equal(b.item.state_until, '2026-09-02T00:00:00Z');
  assert.equal(s.itemByKey('alice', 'github', 'octo/repo#1').id, a.item.id);
  s.close();
});

test('every item carries a user, and keys are unique per user', () => {
  const s = new Store();
  s.upsertItem(item());
  s.upsertItem(item({ user: 'bob' }));
  assert.equal(s.items().length, 2);
  assert.equal(s.items({ user: 'bob' }).length, 1);
  assert.throws(() => s.upsertItem({ ...item(), user: undefined }));
  s.close();
});

test('events are idempotent by key; only the new ones come back', () => {
  const s = new Store();
  const { item: it } = s.upsertItem(item());
  const ev = [
    { key: 'github:comment:1', ts: '2026-09-01T01:00:00Z', kind: 'comment', actor: 'a', body: 'hi' },
    { key: 'github:comment:2', ts: '2026-09-01T02:00:00Z', kind: 'comment', actor: 'b', body: 'yo', data: { in_reply_to_id: 1 } },
  ];
  const first = s.addEvents(it.id, ev);
  assert.equal(first.length, 2);
  const again = s.addEvents(it.id, [...ev, { key: 'github:comment:3', ts: '2026-09-01T03:00:00Z', kind: 'comment', actor: 'a' }]);
  assert.equal(again.length, 1);
  assert.equal(again[0].key, 'github:comment:3');
  const all = s.events(it.id);
  assert.equal(all.length, 3);
  assert.deepEqual(all[1].data, { in_reply_to_id: 1 });
  s.close();
});

test('decisions log the rule and the tier, delivered or not, and join the item', () => {
  const s = new Store();
  const { item: it } = s.upsertItem(item());
  const id = s.addDecision({ item_id: it.id, rule: 'reply_to_my_comment', tier: 'P0', reason: 'b replied after you', event_ids: [1] });
  s.addDecision({ item_id: it.id, rule: 'ambient', tier: 'P3', reason: 'subscribed only' });
  assert.throws(() => s.addDecision({ item_id: it.id, rule: 'x', tier: 'P9', reason: '' }));
  s.markDelivered(id, true, 'slack C1 1234.5');
  const all = s.decisions();
  assert.equal(all.length, 2);
  assert.equal(all[1].delivered, true);
  assert.equal(all[1].title, 'Fix it');
  assert.equal(s.decisions({ tier: 'P3' }).length, 1);
  assert.equal(s.decisions({ delivered: false }).length, 1);
  assert.deepEqual(s.decisionsFor(it.id).map((d) => d.rule), ['reply_to_my_comment', 'ambient']);
  s.close();
});

test('actions, cursors and deliveries round-trip', () => {
  const s = new Store();
  const { item: it } = s.upsertItem(item());
  s.addAction({ item_id: it.id, action: 'snooze', until: '2026-09-02T00:00:00Z', by: 'alice' });
  assert.equal(s.actionsFor(it.id)[0].action, 'snooze');
  assert.equal(s.cursor('github'), null);
  s.setCursor('github', { last_modified: 'Tue', threads: { 1: { updated_at: 'x' } } });
  assert.equal(s.cursor('github').last_modified, 'Tue');
  assert.equal(s.cursors().github.state.threads[1].updated_at, 'x');
  const d = s.addDelivery({ item_id: it.id, channel: 'D1', status: 'held' });
  assert.equal(s.heldDeliveries().length, 1);
  s.updateDelivery(d, { message_ts: '1.2', status: 'sent' });
  assert.equal(s.lastDelivery(it.id).message_ts, '1.2');
  assert.equal(s.heldDeliveries().length, 0);
  s.recordRun('github', { ok: false, error: 'boom', ms: 5 });
  s.recordRun('github', { ok: true, ms: 7 });
  assert.equal(s.runs().github.runs, 2);
  assert.equal(s.runs().github.failures, 1);
  s.close();
});

// --- plan §13: the boot path has a drop half now -----------------------------
// A store that lived through M2 carries two LLM tables, three LLM columns,
// a batch cursor and — after the first deploy of #12 — `by = 'llm'` decision
// rows. The next boot takes all of it out, in the order that matters (rows
// before the `acted` column, because once that column is gone nothing else
// tells an LLM row from a rule's), and a second boot finds nothing to do.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A file laid out the way lib/store.js at 614ad22 (M2 through M5) left it. */
function seedM2Store(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, user TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, url TEXT, repo TEXT,
      actors TEXT NOT NULL DEFAULT '[]', my_role TEXT, last_activity TEXT, last_seen TEXT, tier TEXT, score REAL NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'open', state_until TEXT,
      data TEXT NOT NULL DEFAULT '{}', created TEXT NOT NULL, updated TEXT NOT NULL, summary TEXT, summary_at TEXT, rank REAL, rank_base REAL, rank_at TEXT, features TEXT, UNIQUE (user, source, key));
    CREATE TABLE events (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items (id), key TEXT NOT NULL UNIQUE, ts TEXT NOT NULL, seen TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT, body TEXT, url TEXT, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE decisions (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items (id), ts TEXT NOT NULL, by TEXT NOT NULL DEFAULT 'rule', rule TEXT NOT NULL, tier TEXT NOT NULL, reason TEXT NOT NULL,
      event_ids TEXT NOT NULL DEFAULT '[]', delivered INTEGER NOT NULL DEFAULT 0, note TEXT, acted INTEGER NOT NULL DEFAULT 1, matches TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX decisions_item ON decisions (item_id, id);
    CREATE TABLE actions (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items (id), ts TEXT NOT NULL, action TEXT NOT NULL, until TEXT, by TEXT, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE cursors (source TEXT PRIMARY KEY, ts TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE deliveries (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items (id), ts TEXT NOT NULL, channel TEXT NOT NULL, message_ts TEXT, status TEXT NOT NULL, decision_id INTEGER, error TEXT);
    CREATE TABLE llm_jobs (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items (id), decision_id INTEGER, kind TEXT NOT NULL, event_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'queued', batch_id TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, error TEXT);
    CREATE INDEX llm_jobs_status ON llm_jobs (status, id);
    CREATE TABLE llm_calls (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, item_id INTEGER, model TEXT, via TEXT NOT NULL DEFAULT 'messages', input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, ms INTEGER, ok INTEGER NOT NULL DEFAULT 1, error TEXT);
    CREATE TABLE source_runs (source TEXT PRIMARY KEY, ok INTEGER NOT NULL, at TEXT NOT NULL, ok_at TEXT, error TEXT, ms INTEGER, runs INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0);
    INSERT INTO items (id, user, source, key, kind, title, url, repo, tier, state, created, updated, summary, summary_at)
      VALUES (1, 'alice', 'github', 'o/r#1', 'pull', 'ambient one', 'u', 'o/r', 'P3', 'open', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z', 'the model said something', '2026-09-11T00:00:00Z'),
             (2, 'alice', 'github', 'o/r#2', 'pull', 'merged one', 'u', 'o/r', 'P2', 'open', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z', NULL, NULL);
    -- The rule's verdict, then the LLM's logged-only second opinion — which
    -- has the higher id, so a naive "latest decision" would hand it back.
    INSERT INTO decisions (id, item_id, ts, by, rule, tier, reason, acted, note) VALUES
      (1, 1, '2026-09-10T00:00:00Z', 'rule', 'ambient', 'P3', 'subscribed, nothing addressed to you', 1, NULL),
      (2, 1, '2026-09-11T00:00:00Z', 'llm', 'llm', 'P1', 'looks like it needs you', 0, 'logged only: TRIAGE_LLM_DELIVER is off'),
      (3, 2, '2026-09-10T00:00:00Z', 'rule', 'state_change_on_mine', 'P2', 'your pull was merged', 1, NULL),
      (4, 2, '2026-09-11T00:00:00Z', 'wake', 'snooze_wake', 'P2', 'snooze ended — your pull was merged', 1, NULL);
    INSERT INTO llm_jobs (item_id, kind, status, created, updated) VALUES (1, 'score', 'submitted', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z');
    INSERT INTO llm_calls (ts, kind, item_id) VALUES ('2026-09-11T00:00:00Z', 'score', 1);
    INSERT INTO cursors (source, ts, state) VALUES ('github', '2026-09-11T00:00:00Z', '{"threads":{}}'), ('llm:batch', '2026-09-11T00:00:00Z', '{"at":"2026-09-11T00:00:00Z"}'),
      ('slack:p1', '2026-09-11T00:00:00Z', '{"at":"2026-09-11T00:00:00Z"}'), ('slack:p2', '2026-09-11T00:00:00Z', '{"date":"2026-09-11"}');
  `);
  db.close();
}

test('a store from the M2 era loses the LLM at boot, and is left alone after that', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'triage-unmind-'));
  const file = path.join(dir, 'triage.db');
  try {
    seedM2Store(file);
    const s = new Store(file);
    const cols = (t) => s.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const tables = () => s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    // The tables and the columns are gone.
    assert.ok(!tables().includes('llm_jobs') && !tables().includes('llm_calls'), tables().join(','));
    assert.ok(!cols('items').includes('summary') && !cols('items').includes('summary_at'), cols('items').join(','));
    assert.ok(!cols('decisions').includes('acted'), cols('decisions').join(','));
    // What was added later is still there: the drop half touches nothing else.
    assert.ok(cols('items').includes('features') && cols('decisions').includes('matches'));
    // The LLM's rows went first, so the item's reason is the rule's verdict
    // and not the second opinion that outranked it by id.
    assert.equal(s.decisions().length, 3);
    assert.equal(s.decisions({ by: 'llm' }).length, 0);
    assert.equal(s.lastDecision(1).rule, 'ambient');
    assert.equal(s.lastDecision(1).tier, 'P3');
    // `wake` rows are not `llm` rows, and the distinction is load-bearing.
    assert.equal(s.lastDecision(2).by, 'wake');
    assert.deepEqual(s.decisionsFor(2).map((d) => d.by), ['rule', 'wake']);
    // No row reads back an `acted` it no longer has, and the items survive.
    assert.equal('acted' in s.lastDecision(1), false);
    assert.equal(s.item(1).title, 'ambient one');
    assert.equal('summary' in s.item(1), false);
    assert.equal(s.cursor('llm:batch'), null);
    // And the batch's and the digest's (§11.3, 2026-09-12): the only thing
    // they left behind.
    assert.equal(s.cursor('slack:p1'), null);
    assert.equal(s.cursor('slack:p2'), null);
    assert.ok(s.cursor('github'), 'the sources\' cursors are untouched');
    s.close();
    // A second boot: the converted store is what it was after the first —
    // the schema and every row of every table, not only a count.
    const snapshot = dumpStore(file);
    const again = new Store(file);
    again.migrate();
    assert.equal(again.decisions().length, 3);
    again.close();
    assert.equal(dumpStore(file), snapshot);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** The whole store as text: the schema, then every row of every table in
 *  rowid order. Two boots that leave anything different disagree here. */
function dumpStore(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const schema = db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all().map((r) => `${r.name}:${r.sql}`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const rows = tables.map((t) => `${t}=${JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())}`);
    return [...schema, ...rows].join('\n');
  } finally { db.close(); }
}
