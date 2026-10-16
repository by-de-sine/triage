// interrupts.js — which verdicts, for which projects, may fire Slack. This
// is the answer to plan §11.9's last open call, decided on 2026-09-10,
// and it is the whole of "delivery answers exactly one
// question: does this interrupt?" (§11.6). Plan §14 (2026-09-13) made it
// layered, because the thing the owner actually wanted to say the first
// time the system sent a real interrupt was neither global nor a rule name:
// *a human replying to me in this one project is an interrupt*.
//
// **It is a rule list, not a tier.** Under a ranking the tier is one input
// to a score and no longer picks a channel, so the interrupt test has to
// name the observations that are worth a buzz. §11.6 names three kinds — a
// human blocked on you, a meeting starting, production on fire — and the
// third has no source yet, so it has no rules here.
//
// The call was made with the counts over the 98 decisions on record, which is
// the honest version of "how often would this fire":
//
//   reply_to_my_comment          1      state_change_on_mine    34
//   reply_to_my_review_comment   0      bot_only                45
//   direct_mention               0      ambient                 12
//   review_requested             0      own_activity             6
//   starts_in_15_min             0 (the calendar has never run in production)
//   new_invitation               0 (the same)
//
// The four GitHub P0 rules fired **once between them**, so the set below is
// near-silent on the history it has, and the volume is all in rules nobody
// would ever interrupt on. The choice was today's P0s **plus `new_invitation`**:
// an unanswered invitation is someone waiting for an answer, and an
// invitation you never see is a meeting you are not at.
//
// Two consequences worth stating rather than discovering. `new_invitation`
// is a **P1**, so the interrupt set and the tiers genuinely disagree — that
// is the point of making this a rule list. And every verdict is answered on
// the spot — sent, held, or placed in the list — so nothing is ever pending
// for a second channel; there is none (the batch and the digest went on
// 2026-09-12, plan §11.3).
//
// ## The four layers (plan §14.2)
//
// What qualifies as an interrupt is personal, and the default has to be
// good enough that most people never write a line of config. So: one
// ordered list of **statements**, four layers deep, and *the most specific
// statement in the highest layer wins*. That is the entire resolution rule.
//
//   0  the default set below, in the repo — what a fresh clone does
//   1  yours, globally           TRIAGE_PREFS  .interrupts
//   2  yours, per project        TRIAGE_PREFS  .projects[…].interrupts
//   3  yours, from the shell     TRIAGE_INTERRUPT
//
// The env var is last because typing it is what "right now, silence this"
// looks like. The defaults are a statement like any other on layer 0: there
// is no privileged built-in path, which is what stops the two halves
// drifting into different code.
export const INTERRUPTS = {
  // `new_pull_request`, decided 2026-10-15: a contributor opening a pull
  // request in a repository you follow is waiting for feedback whether
  // or not they remembered to request a review.
  github: ['reply_to_my_review_comment', 'reply_to_my_comment', 'direct_mention', 'review_requested', 'new_pull_request'],
  // The same observations on the other forge (plan §16, G1): one thread
  // rule set, so one interrupt set.
  gitlab: ['reply_to_my_review_comment', 'reply_to_my_comment', 'direct_mention', 'review_requested', 'new_pull_request'],
  calendar: ['starts_in_15_min', 'new_invitation'],
  // Plan §12.3 item 3. The first call (2026-10-02) was every edit by
  // somebody else; its first busy afternoon (2026-10-15) was nine posts in
  // fifteen minutes about a colleague's own tasks, and the second call was
  // the same bar GitHub has: somebody waiting on *you*. So a task handed to
  // you, or changed while it is yours — rules/crm.js has the split — and a
  // CRM nobody is reading, the alarm that keeps "quiet" meaning "nothing
  // happened". `+crm:changed_what_i_wrote` and `+crm:changed_by_other` are
  // the two steps back toward the first call, for whoever wants them.
  crm: ['handed_to_me', 'changed_on_my_task', 'crm_unread'],
};

/** Rules this set does not get to refuse, because something else already
 *  decided them. A snooze is a human saying "interrupt me then", and a wake
 *  silenced because the original rule was off the list would be the one
 *  thing the button is for, not happening.
 *
 *  **This is a guard, not a trigger.** It says these may reach Slack; it does
 *  not say they do. `lib/pipeline.js` `wake()` sends a woken P0 at once and
 *  puts anything else back in the list at a fresh rank — which is what
 *  README §Acting on it promises. A P1 that wakes is placed, not sent. */
export const ALWAYS = ['snooze_wake'];

export const LAYERS = ['default', 'prefs', 'prefs-project', 'env'];

const norm = (s) => String(s ?? '').trim().toLowerCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `*` matches anything including a missing value; `owner/*` globs; anything
 *  else is an exact, case-insensitive match. Case-insensitive because GitHub
 *  repository names are (`lib/config.js` `parseRepos` says the same), and
 *  because nobody wants a mute that failed on a capital letter. */
function matches(pattern, value) {
  if (pattern === '*') return true;
  if (value == null || value === '') return false;
  const p = norm(pattern), v = norm(value);
  if (!p.includes('*')) return p === v;
  return new RegExp(`^${p.split('*').map(escapeRe).join('.*')}$`).test(v);
}

/** How specific a pattern is: a wildcard says least, a glob more, a literal
 *  most. Scope outranks source outranks rule, and all three together can
 *  never outrank the next layer up (26 < 100) — a `-github:*` you typed in
 *  the shell beats a named rule in the defaults, which is what typing it
 *  meant. */
const spec = (p) => (p === '*' ? 0 : String(p).includes('*') ? 1 : 2);
const weight = (s) => LAYERS.indexOf(s.layer) * 100 + spec(s.scope) * 10 + spec(s.source) * 2 + spec(s.rule);

/** One statement, and how it reads back to whoever is asking why. */
function statement({ layer, scope = '*', source = '*', rule = '*', allow = true, from = null }) {
  const text = `${allow ? '+' : '-'}${source}:${rule}${scope === '*' ? '' : `@${scope}`}`;
  return { layer, scope, source, rule, allow, from: from ? `${from}: ${text}` : text, text };
}

/** `github:reply_to_my_comment, -calendar:*@team, +github:new_issue@o/*` —
 *  the env and file grammar, one parser for both.
 *
 *  **Signs make it a delta; an unsigned list replaces.** That is not a new
 *  rule: it is exactly what `TRIAGE_INTERRUPT` has always meant, kept, so
 *  nothing configured on the box changes meaning when layering ships. A
 *  replacement emits a `-*:*` sweep before its own statements, which is how
 *  "this list and nothing else" is said in a language of deltas. */
export function parseStatements(spec_, { layer = 'env', from = null, scope = null, sweep = '*' } = {}) {
  const s = String(spec_ ?? '').trim();
  if (!s) return [];
  if (s.toLowerCase() === 'off') return [statement({ layer, scope: scope || '*', source: sweep, allow: false, from })];
  if (s.toLowerCase() === 'all') return [statement({ layer, scope: scope || '*', source: sweep, allow: true, from })];
  const parts = String(s).split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const signed = parts.some((p) => /^[+-]/.test(p));
  // The sweep an unsigned list emits is scoped to what the list is *about*:
  // `TRIAGE_INTERRUPT=github:x` replaces the whole set (sweep `*`), but
  // `{"interrupts": {"github": [...]}}` in the file replaces github's list
  // and must not silence the calendar (sweep `github`).
  const out = signed ? [] : [statement({ layer, scope: scope || '*', source: sweep, allow: false, from: from ? `${from} (replaces)` : '(replaces)' })];
  for (const part of parts) {
    const m = /^([+-]?)\s*([^:@\s]+)?\s*(?::\s*([^@\s]*))?\s*(?:@\s*(\S+))?$/.exec(part);
    // A statement nobody can parse is refused, not skipped. `github new_issue`
    // — a space where the colon goes — would otherwise boot with a quietly
    // different set, and you would find out by not being interrupted. It is
    // the rule `calendarMode` and `slackMode` already hold to: a typo must
    // not read as the default.
    const where = from ? ` (${from})` : '';
    if (!m || !m[2]) throw new Error(`interrupt statement${where}: "${part}" is not [+|-]source:rule[@project]`);
    const [, sign, src, ruleRaw, proj] = m;
    // `github` alone — a source named with no rules — mutes that source.
    // It is how a noisy new source is silenced without touching the others,
    // and it predates the signs, so it keeps meaning exactly that.
    const rule = ruleRaw === undefined || ruleRaw === '' ? null : ruleRaw;
    out.push(statement({ layer, scope: proj || scope || '*', source: src, rule: rule ?? '*', allow: rule == null ? false : sign !== '-', from }));
  }
  return out;
}

/** The legacy shape, kept because it is what `parseInterrupts` has always
 *  returned and what several tests read: a plain `{source: [rule, …]}` map.
 *  `''` is the built-in set, `off` is nothing. It cannot express a scope or
 *  a delta — that is what `resolve()` is for — and the free `interrupts()`
 *  below still accepts it. */
export function parseInterrupts(spec_) {
  const s = String(spec_ ?? '').trim();
  if (!s) return INTERRUPTS;
  if (s.toLowerCase() === 'off') return {};
  const out = {};
  for (const part of s.split(/[,\n]/)) {
    const t = part.trim();
    if (!t) continue;
    const [source, rule] = t.split(':').map((x) => x.trim());
    if (!source) continue;
    out[source] ||= [];
    if (rule) out[source].push(rule);
  }
  return out;
}

/** The resolved list, and the one thing that answers "does this interrupt,
 *  and which statement said so". Every caller goes through `allows()`;
 *  nothing else knows the layers exist. */
export class Interrupts {
  constructor(statements = []) {
    this.statements = statements;
  }

  /** The verdict, and its reason in one human phrase — which is the feature
   *  (plan §14.6). "Why didn't that buzz me" has to have an answer naming
   *  the statement that decided it, or the config is unusable however good
   *  the grammar is. */
  allows(source, rule, project = null) {
    if (ALWAYS.includes(rule)) return { allow: true, by: `${rule} is always allowed — you asked to be interrupted then` };
    let best = null, bestW = -1;
    for (const s of this.statements) {
      if (!matches(s.source, source) || !matches(s.rule, rule)) continue;
      if (s.scope !== '*' && !matches(s.scope, project)) continue;
      const w = weight(s);
      if (w >= bestW) { best = s; bestW = w; }     // later wins a tie: written order is intent
    }
    if (!best) return { allow: false, by: 'nothing on the interrupt list names it' };
    return { allow: best.allow, by: best.from, statement: best };
  }

  /** The effective global set, `{source: [rule, …]}` — what the boot log
   *  prints, what `describe()` has always returned, and what `/healthz`
   *  shows. Built by asking `allows()` about every rule any statement
   *  names, so it can never disagree with the thing that actually decides.
   *  A source armed by a wildcard reads as `*`, because there is no list to
   *  print and pretending otherwise would be a lie. */
  get set() {
    const named = new Map();
    // A rule armed across every source (`+*:new_issue`) is live for each of
    // them, so it has to be asked about for each of them — otherwise the map
    // the boot log and /healthz print disagrees with the thing that decides.
    const wild = new Set();
    for (const s of this.statements) {
      if (s.source === '*' || s.source.includes('*')) { if (s.rule !== '*') wild.add(s.rule); continue; }
      const rules = named.get(s.source) || new Set();
      rules.add(s.rule);
      named.set(s.source, rules);
    }
    const out = {};
    for (const [source, rules] of named) {
      for (const r of wild) rules.add(r);
      const allowed = [...rules].filter((r) => r !== '*' && this.allows(source, r).allow);
      if (this.allows(source, '*').allow) out[source] = ['*'];
      else out[source] = allowed;
    }
    // And the wildcard statements get a row of their own, because folding
    // them into the named sources is only *most* of the truth: a source no
    // statement mentions is armed by `+*:new_issue` too, and this map has no
    // register of sources to enumerate. Saying "these apply to every source"
    // is the honest shape, and it is what the resolver actually does.
    const everywhere = [...wild].filter((r) => this.statements.some((s) => (s.source === '*' || s.source.includes('*')) && s.rule === r && s.allow));
    if (everywhere.length) out['*'] = everywhere;
    return out;
  }

  /** Everything, for `GET /api/interrupts`: the statements grouped by layer
   *  in the order they are applied, plus the effective set. */
  describe() {
    return {
      set: this.set,
      layers: LAYERS.map((layer) => ({ layer, statements: this.statements.filter((s) => s.layer === layer).map((s) => ({ ...s, weight: weight(s) })) })).filter((l) => l.statements.length),
      always: ALWAYS,
    };
  }
}

/** Build the four layers (plan §14.2). Every argument is optional and an
 *  absent one contributes no statements, so a box with nothing configured
 *  gets exactly the default set and pays nothing for the machinery. */
export function resolve({ defaults = INTERRUPTS, prefs = null, env = null } = {}) {
  const out = [];
  for (const [source, rules] of Object.entries(defaults || {})) {
    for (const rule of rules) out.push(statement({ layer: 'default', source, rule, allow: true, from: 'the default set' }));
  }
  // Layer 1: yours, globally. Per source, so `{github: [...], calendar: 'off'}`
  // says two independent things.
  for (const [source, spec_] of Object.entries(prefs?.interrupts || {})) {
    for (const s of parseStatements(specToParts(spec_, source), { layer: 'prefs', from: 'TRIAGE_PREFS .interrupts', sweep: source })) out.push(s);
  }
  // Layer 2: yours, per project. The project key is the scope, so a
  // statement written here never needs to repeat it.
  for (const [project, cfg] of Object.entries(prefs?.projects || {})) {
    const spec_ = cfg?.interrupts;
    if (spec_ == null) continue;
    const from = `TRIAGE_PREFS projects."${project}"`;
    if (typeof spec_ === 'string') { for (const s of parseStatements(spec_, { layer: 'prefs-project', from, scope: project })) out.push(s); continue; }
    for (const [source, sub] of Object.entries(spec_)) {
      for (const s of parseStatements(specToParts(sub, source), { layer: 'prefs-project', from, scope: project, sweep: source })) out.push(s);
    }
  }
  // Layer 3: the shell. Wins, because that is what typing it means.
  for (const s of parseStatements(env, { layer: 'env', from: 'TRIAGE_INTERRUPT' })) out.push(s);
  return new Interrupts(out);
}

/** `{github: ['+new_issue']}` and `{github: 'off'}` are both worth writing,
 *  so the file's per-source value may be a list, a string, or the two
 *  shorthands. Flattened into the one grammar `parseStatements` reads. */
function specToParts(value, source) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((r) => withSource(String(r), source)).join(',');
  const s = String(value).trim();
  if (s.toLowerCase() === 'off') return `-${source}:*`;
  if (s.toLowerCase() === 'all') return `+${source}:*`;
  return s.split(/[,\n]/).map((r) => withSource(r.trim(), source)).filter(Boolean).join(',');
}
/** `+new_issue` under the `github` key means `+github:new_issue`; a value
 *  that already names a source is left alone, so the flat grammar can be
 *  pasted into the file without being rewritten. */
function withSource(r, source) {
  const t = r.trim();
  if (!t) return '';
  const m = /^([+-]?)(.*)$/.exec(t);
  return m[2].includes(':') ? t : `${m[1]}${source}:${m[2]}`;
}

/** May this verdict interrupt? Accepts the resolved `Interrupts` or the
 *  legacy plain map — `SlackDelivery` may be constructed either way (the
 *  tests and `bin/` pass a map), and a source with no entry in a map
 *  interrupts on nothing: a source nobody has thought about does not get to
 *  buzz. */
export function interrupts(set, source, rule, project = null) {
  if (set instanceof Interrupts) return set.allows(source, rule, project).allow;
  if (ALWAYS.includes(rule)) return true;
  return !!set?.[source]?.includes(rule);
}

/** The same question, with the reason. A plain map has only one thing it
 *  could possibly say, and says it. */
export function allows(set, source, rule, project = null) {
  if (set instanceof Interrupts) return set.allows(source, rule, project);
  return { allow: interrupts(set, source, rule), by: 'TRIAGE_INTERRUPT' };
}
