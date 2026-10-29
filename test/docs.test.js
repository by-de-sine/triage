// The docs describe what shipped (CONTRIBUTING.md § Conventions), and a link
// to a file that moved describes nothing. Every relative link in every
// Markdown file — README, CONTRIBUTING, AGENTS, SECURITY, docs/ — must name
// a file that exists. Anchors are not checked: a heading is a sentence
// here, and sentences are allowed to change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'log', 'agent']);

function* markdown(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* markdown(p);
    else if (name.endsWith('.md')) yield p;
  }
}

// `[text](target)` and `[text]: target`, skipping images' alt text, which the
// same regexp also matches — an image is a link to a file, and is checked.
const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)|^\[[^\]]+\]:\s*(\S+)/gm;
const external = (t) => /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('#') || t.startsWith('//');

test('every relative link in the Markdown names a file that exists', () => {
  const broken = [];
  for (const file of markdown(root)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(LINK)) {
      const target = m[1] ?? m[2];
      if (external(target)) continue;
      const rel = target.split('#')[0];
      if (!rel) continue;
      // A leading slash is the repository root, as GitHub renders it.
      const resolved = rel.startsWith('/') ? path.join(root, decodeURIComponent(rel)) : path.resolve(path.dirname(file), decodeURIComponent(rel));
      if (!existsSync(resolved)) broken.push(`${path.relative(root, file)} → ${target}`);
    }
  }
  assert.deepEqual(broken, [], `links to files that do not exist:\n${broken.join('\n')}`);
});
