// forge.js — what the forge sources share: which rules observe *news*
// rather than a person waiting (nothing there gets more urgent by sitting),
// the time curve that follows from it, and the repository-list parser.
export const NEWS = new Set(['state_change_on_mine', 'release', 'own_activity', 'bot_only', 'ambient', 'new_issue']);

/** Which curve time follows for a thread: a reply waiting on you gets more
 *  urgent as it sits; a merged pull request is news and goes stale. The
 *  rules that fired are what know which it is. */
export const threadTime = (item, { rules = [] } = {}) => (item.kind === 'release' || (rules.length && rules.every((r) => NEWS.has(r))) ? 'fading' : 'waiting');

/** `owner/name, group/sub/project` — the repositories whose open issues are
 *  read as state. A URL is accepted; a bad entry is refused at boot. */
export function parseRepos(spec, { name = 'TRIAGE_GITHUB_ISSUES', host = 'github.com', nested = host !== 'github.com' } = {}) {
  const out = [];
  for (const part of String(spec || '').split(/[,\s]+/)) {
    const r = part.trim().replace(new RegExp(`^https?://${host.replace(/\./g, '\\.')}/`), '').replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    if (!r) continue;
    // GitHub is exactly owner/name; a GitLab project path may nest groups.
    // Names are case-insensitive on both; the first spelling is kept.
    if (!(nested ? /^[\w.-]+(\/[\w.-]+)+$/ : /^[\w.-]+\/[\w.-]+$/).test(r)) throw new Error(`${name}: ${part} is not ${nested ? 'group/project' : 'owner/name'}`);
    if (!out.some((x) => x.toLowerCase() === r.toLowerCase())) out.push(r);
  }
  return out;
}

export const sameRepos = (a, b) => JSON.stringify((a || []).map((s) => s.toLowerCase()).sort()) === JSON.stringify((b || []).map((s) => s.toLowerCase()).sort());
