// slack — Slack is the interface you touch. Two ways in, picked by
// `TRIAGE_SLACK` (off | webhook | app; unset infers from what is
// configured), and this file is the half that is the same in both: the
// windows, the age guard, the tiers, and the answer written onto every
// decision row.
//
//   webhook  one URL, one message per interrupt, in one of three shapes
//            picked by TRIAGE_NOTIFY — `slack` (an incoming webhook, the
//            path M0's promise runs through: plan §9 item 2, §11.6),
//            `discord`, or `generic` JSON for anything else (plan §16, G2).
//            No app to create, no token, no socket, no scopes — and no
//            buttons, no redraw, no Home tab. The client is
//            deliver/notify.js and the shapes are deliver/messages.js.
//   app      the Bolt path below, unchanged and not deleted: the richer
//            surface is one config line away if an app is ever worth it.
//
// Through Bolt in Socket Mode (no public URL; Slack never has to reach
// this box):
//
//   the interrupt   one DM per item to SLACK_USER_ID within a minute: title,
//        repo, who did what, one line of the comment, Open · Done · Snooze
//        1h · Snooze 1d · Later · Mute thread. A press updates the DM in
//        place. Which verdicts interrupt is deliver/interrupts.js — a rule
//        list, per source, not a tier.
//   everything else   is placed in the list and never sent. The P1 batch
//        and the P2 digest are gone (plan §11.3; decided 2026-09-12):
//        once the list is the surface, the list is the channel, and a
//        message restating the middle of it is noise. The seat that reads
//        triage is where a digest belongs.
//
// The knobs from plan §3, config not code:
//   coalesce  never two P0 DMs for one item inside the window; the existing
//             message is updated instead (default ten minutes)
//   quiet     a P0 inside the window is held and sent when it ends (default
//             23:00–07:00 local)
// And one guard: an event older than `maxAge` is tiered but not sent — on
// first boot the inbox is history, not news. A snooze that wakes is exempt:
// you asked for it.
//
// **What `webhook` changes, and it is only this** (plan §11.6). A webhook
// can post and cannot redraw, so:
//   - the *first* alarm for an item is never held — it goes the moment the
//     verdict lands, and that send opens the coalesce window. That is the
//     whole promise of the interrupt path, and coalescing has no opinion
//     about it because there is nothing yet to coalesce with;
//   - anything further on the same item inside the window is **held**
//     rather than folded, and goes out once, as one follow-up, when the
//     window ends. Suppressing the second message would be the cheap
//     answer and it discards the newer information; this trades a little
//     latency on the repeats for not losing the update. P0 latency for the
//     thing that matters is unchanged;
//   - `reflect` (saying what you did) is an explicit no-op — see it. The
//     page carries that;
//   - the message carries **no act buttons**. Nothing delivers the press:
//     an incoming webhook has no interaction callback and this mode
//     registers no handlers, so Done · Snooze · Later · Mute were dead the
//     moment they rendered. Open and Join are URL buttons rather than
//     interaction and survive, as the link line an acted message uses;
//   - `deliveries` rows are still written, status `sent` with no
//     `message_ts`, because there is nothing to update later.
// The quiet window and the age guard are untouched by any of it, and
// `deliver/blocks.js` is not forked: a webhook takes the same
// `{text, blocks}` payload `chat.postMessage` does.
//
// Every answer lands on the decision row: sent, updated, held, or the reason
// it was not — so /api/decisions tells the whole story. Without a bot token
// and a user id delivery is disabled and every interrupt is logged as not
// delivered.
import { p0Message } from './blocks.js';
import { registerHandlers, actedMessage } from './handlers.js';
import { webhookClient, webhookHost, MODES as NOTIFY_MODES } from './notify.js';
import { SHAPES } from './messages.js';
import { INTERRUPTS, interrupts as mayInterrupt, allows as mayInterruptWhy } from './interrupts.js';

export function parseQuiet(s) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(s || '');
  if (!m) return null;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const start = h1 * 60 + m1, end = h2 * 60 + m2;
  return start === end ? null : { start, end };
}

/** Minutes past local midnight for a Date in a zone. */
function localMinutes(d, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const h = +parts.find((p) => p.type === 'hour').value % 24, mi = +parts.find((p) => p.type === 'minute').value;
  return h * 60 + mi;
}
export function inQuiet(quiet, d, tz) {
  if (!quiet) return false;
  const m = localMinutes(d, tz);
  return quiet.start < quiet.end ? m >= quiet.start && m < quiet.end : m >= quiet.start || m < quiet.end;
}

const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const hours = (ms) => Math.round(ms / 3_600_000);
/** Where a message went, for the note on a decision row. A webhook answers
 *  with no message id, so there is no `ts` to name and `sent webhook null`
 *  would be the only thing anyone read in /api/decisions. */
const where = (channel, ts) => (ts ? `${channel} ${ts}` : channel);

export class SlackDelivery {
  constructor(store, { mode = null, notify = null, webhookUrl = null, botToken, appToken, userId, user = null, quiet = '23:00-07:00', tz = Intl.DateTimeFormat().resolvedOptions().timeZone, coalesceMs = 600_000, maxAgeMs = 86_400_000, interrupts = INTERRUPTS, projects = {}, mention = null, rank = null, client = null, now = () => new Date(), log = () => {} } = {}) {
    this.store = store;
    // Which shape the webhook posts (deliver/messages.js). `slack` unless
    // told otherwise, which is what every webhook before G2 was; `off` is
    // the webhook half off, a URL or not — never a shape substituted.
    if (notify && !NOTIFY_MODES.includes(notify)) throw new Error(`TRIAGE_NOTIFY must be ${NOTIFY_MODES.join(', ')} (got ${notify})`);
    this.notify = notify || 'slack';
    // lib/config.js always names the mode; constructed directly (the tests,
    // bin/) a webhook URL means `webhook` and anything else means `app`,
    // which is what every caller predating §11.6 meant.
    this.mode = mode || (webhookUrl ? 'webhook' : 'app');
    this.webhookUrl = webhookUrl || null;
    this.userId = userId || null;
    this.user = user;
    this.botToken = botToken || null;
    this.appToken = appToken || null;
    this.quiet = parseQuiet(quiet);
    this.tz = tz;
    this.coalesceMs = coalesceMs;
    this.maxAgeMs = maxAgeMs;
    // M5: the interrupt set (deliver/interrupts.js). The pipeline asks this
    // *whether* to interrupt; `deliver` asks it again as a guard, so nothing
    // can reach Slack on a rule you did not put on the list.
    this.interruptSet = interrupts || {};
    // Plan §14.3: what a "project" is, per source, exactly as `rank.shapes`
    // is built — a map of source name -> (item) -> key, from the registered
    // sources themselves. Nothing here knows a repository from a calendar,
    // and a source that declares none matches only the unscoped statements,
    // which is what "we have not thought about this yet" should do.
    this.projects = projects || {};
    // Plan §14.1: what makes the message notify rather than merely arrive.
    this.mention = mention || null;
    // M5: the ranker, for the lists `/triage` and the Home tab draw. Optional
    // — without it they fall back to the stored order rather than failing.
    this.rank = rank;
    this.client = client;
    this.now = now;
    this.log = log;
    this.app = null;
    this.timer = null;
    this.act = null;
    this.locks = new Map();   // per item: the last redraw of its DM, so two never race
  }

  /** Redraws of one item's DM run one after another: a coalesced repeat
   *  landing while an action is being reflected must not put the buttons
   *  back. */
  #serial(itemId, fn) {
    const prev = this.locks.get(itemId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(itemId, next);
    next.finally(() => { if (this.locks.get(itemId) === next) this.locks.delete(itemId); });
    return next;
  }

  /** Shorthand, used often enough below to be worth a name. */
  get webhook() { return this.mode === 'webhook'; }
  /** Which project this item belongs to, for the scoped layers. The source
   *  says; a source that has not been asked says nothing. */
  projectOf(item, source = null) {
    const f = this.projects[source || item?.source];
    if (!item || typeof f !== 'function') return null;
    try { return f(item) || null; } catch { return null; }
  }

  /** May this verdict fire Slack? Plan §11.6, §11.9, decided 2026-09-10;
   *  scoped to a project by §14. */
  interrupts(source, rule, item = null) { return mayInterrupt(this.interruptSet, source, rule, this.projectOf(item, source)); }

  /** The same question with its reason, naming the statement that decided
   *  it — which is the half that makes the configuration usable (§14.6).
   *  "Why didn't that buzz me" gets an answer on the decision row. */
  allows(source, rule, item = null) { return mayInterruptWhy(this.interruptSet, source, rule, this.projectOf(item, source)); }

  /** What a `deliveries` row records as the destination. A DM's channel id
   *  in app mode; the literal `webhook` otherwise — **never the URL**,
   *  which is the credential and would end up in the store, in every
   *  `sent …` note and so in `/api/decisions`. */
  get channelName() { return this.webhook ? 'webhook' : this.userId; }

  get enabled() {
    if (this.mode === 'off') return false;
    if (this.webhook) return this.notify !== 'off' && !!(this.webhookUrl || this.client);
    return !!(this.userId && (this.client || this.botToken));
  }

  /** Why nothing will be sent, for the boot log and for the note on every
   *  decision — each mode is unconfigured in its own way, and "slack not
   *  configured" for a box that has a webhook URL and a typo in
   *  `TRIAGE_SLACK` would send someone looking in the wrong place. */
  get disabledReason() {
    if (this.mode === 'off') return 'not delivered: slack is off (TRIAGE_SLACK=off)';
    if (this.webhook && this.notify === 'off') return 'not delivered: the webhook is off (TRIAGE_NOTIFY=off)';
    if (this.webhook) return 'not delivered: no TRIAGE_WEBHOOK_URL or SLACK_WEBHOOK_URL (TRIAGE_SLACK=webhook)';
    return 'not delivered: slack not configured';
  }

  /** The effective global set, whichever shape the interrupt config took —
   *  the resolved layers know how to flatten themselves, a plain map is
   *  already flat. What the boot log, `/healthz` and `/api/rank` show. */
  get interruptMap() { return this.interruptSet?.set ?? this.interruptSet ?? {}; }

  describe() {
    return { enabled: this.enabled, mode: this.mode, socket_mode: !!this.app, user: this.userId, channel: this.enabled ? this.channelName : null,
      mention: this.webhook ? this.mention : null, notify: this.webhook ? this.notify : null, projects: Object.keys(this.projects),
      interrupts: this.interruptMap, webhook: this.webhook ? webhookHost(this.webhookUrl || '') : null, quiet: this.quiet ? `${fmt(this.quiet.start)}-${fmt(this.quiet.end)} ${this.tz}` : null, coalesce_ms: this.coalesceMs, max_age_ms: this.maxAgeMs, held: this.store.heldDeliveries().length };
  }

  /** Connect. Socket Mode needs the app token; without it the bot token
   *  alone still posts, but no button, command or Home tab answers.
   *  `act` is the one action path (lib/actions.js); the handlers call it. */
  async start({ act = null } = {}) {
    this.act = act;
    if (!this.enabled) {
      if (this.mode === 'off') this.log('slack: off (TRIAGE_SLACK=off) — interrupts are logged, not sent');
      else if (this.webhook && this.notify === 'off') this.log('notify: off (TRIAGE_NOTIFY=off) — interrupts are logged, not sent');
      else if (this.webhook) this.log('slack: TRIAGE_SLACK=webhook but no TRIAGE_WEBHOOK_URL — interrupts are logged, not sent');
      else this.log('slack: not configured (SLACK_BOT_TOKEN and SLACK_USER_ID) — interrupts are logged, not sent');
    } else if (!this.client) {
      if (this.webhook) {
        // One URL and no handshake: there is nothing to connect to and
        // nothing to fail at boot, which is most of the point.
        // Discord answers before the message is saved unless asked to wait.
        this.client = webhookClient(this.webhookUrl, { confirm: this.notify === 'discord' });
        this.log(`notify: ${this.notify} webhook -> ${this.client.host} — one message per interrupt to the channel it was created for; no buttons, no redraw, no Home tab (TRIAGE_NOTIFY=${this.notify})`);
      } else if (this.appToken) {
        const { App } = await import('@slack/bolt');
        this.app = new App({ token: this.botToken, appToken: this.appToken, socketMode: true, logLevel: 'warn' });
        this.registerHandlers(this.app);
        await this.app.start();
        this.client = this.app.client;
        this.log('slack: socket mode connected — buttons, /triage and the Home tab are live');
      } else {
        const { WebClient } = await import('@slack/web-api');
        this.client = new WebClient(this.botToken);
        this.log('slack: web client only (no SLACK_APP_TOKEN, so no socket mode: DMs go out, buttons do not answer)');
      }
    }
    this.timer = setInterval(() => this.tick().catch((e) => this.log(`slack: tick — ${e.message}`)), 60_000);
  }
  registerHandlers(app) {
    return registerHandlers(app, { store: this.store, act: (a) => { if (!this.act) throw new Error('no act() wired'); return this.act(a); }, user: this.user, userId: this.userId, rank: this.rank, now: this.now, log: this.log });
  }
  async stop() { clearInterval(this.timer); if (this.app) await this.app.stop(); }

  /** The interrupt's message. In webhook mode it carries no act buttons:
   *  an incoming webhook delivers no interaction callbacks and this mode
   *  registers no handlers, so Done · Snooze · Later · Mute rendered and
   *  did nothing when pressed. Open and Join are URL buttons, not
   *  interaction, and survive as links (plan §11.6 — acting is the page's
   *  job). `app` is untouched. */
  message({ item, decision, event, acted = null }) {
    if (this.webhook) return (SHAPES[this.notify] || SHAPES.slack)({ item, decision, event, mention: this.mention });
    return p0Message({ item, decision, event, acted, interactive: true, mention: null });
  }

  async deliver({ item, decision, event, ignoreAge = false }) {
    if (!this.enabled) return { delivered: false, note: this.disabledReason };
    // The interrupt set, as a guard. The pipeline already asks `interrupts()`
    // before calling here, so this catches the other callers — a snooze wake,
    // a future surface — rather than the common path. A rule that is not on
    // the list is not a failure: it is in the list on the page, which is
    // where §11 put everything that is not an interrupt.
    if (decision?.rule && item?.source) {
      const verdict = this.allows(item.source, decision.rule, item);
      if (!verdict.allow) return { delivered: false, note: `not delivered: ${decision.rule} does not interrupt (${verdict.by})` };
    }
    const now = this.now();
    const ts = Date.parse(event?.ts || item.last_activity || 0);
    if (!ignoreAge && this.maxAgeMs && now - ts > this.maxAgeMs) return { delivered: false, note: `not delivered: event is ${hours(now - ts)} h old (older than ${hours(this.maxAgeMs)} h)` };
    if (inQuiet(this.quiet, now, this.tz)) {
      this.#hold(item, decision, now);
      return { delivered: false, note: `held: quiet window until ${fmt(this.quiet.end)}` };
    }
    // Coalescing, webhook-shaped (plan §11.6). With no way to redraw the
    // message already out, the choice is to suppress this one or to hold
    // it; suppressing loses what it says. So: hold, and `flush` sends one
    // follow-up when the window ends. The window is opened by a *send*, so
    // the first alarm for an item never reaches this branch — there is no
    // posted row yet — and is never delayed.
    if (this.webhook && this.coalesceMs) {
      // Scoped to this channel: a box switched from `app` to `webhook`
      // still has recent DM rows, and the first webhook alarm for an item
      // must not be held against a message that went somewhere else.
      const posted = this.store.lastPosted(item.id, this.channelName);
      const opened = posted ? Date.parse(posted.ts) : 0;
      if (posted && now - opened < this.coalesceMs) {
        this.#hold(item, decision, now);
        return { delivered: false, note: `held: coalescing until ${fmt(localMinutes(new Date(opened + this.coalesceMs), this.tz))} (one follow-up when the window ends)` };
      }
    }
    return this.send({ item, decision, event }, now);
  }

  /** Park an item's alarm as a single `held` row, whatever is holding it:
   *  the quiet window, or a coalesce window a send has opened. One row per
   *  item, carrying the newest decision — so what finally goes out says the
   *  latest thing, which is the whole reason holding beats suppressing. */
  #hold(item, decision, now) {
    const held = this.store.heldDeliveries().find((d) => d.item_id === item.id);
    if (held) this.store.updateDelivery(held.id, { status: 'held', decision_id: decision.id }, now.toISOString());
    else this.store.addDelivery({ item_id: item.id, channel: this.channelName, status: 'held', decision_id: decision.id }, now.toISOString());
  }

  async send({ item, decision, event }, now) {
    const msg = this.message({ item, decision, event });
    // Coalesce onto the last DM, whatever dropped holds have been recorded
    // for the item since.
    // Nothing to fold onto in webhook mode: a posted message cannot be
    // redrawn. `lastSent` would come back empty anyway (no row carries a
    // `message_ts`), but saying it here is clearer than depending on that,
    // and `deliver` has already held the repeats that would have folded.
    const last = this.webhook ? null : this.store.lastSent(item.id);
    if (last && now - Date.parse(last.ts) < this.coalesceMs) {
      await this.client.chat.update({ channel: last.channel, ts: last.message_ts, ...msg });
      this.store.updateDelivery(last.id, { message_ts: last.message_ts, status: 'sent', decision_id: decision.id }, now.toISOString());
      return { delivered: true, note: `updated ${last.channel} ${last.message_ts} (coalesced)` };
    }
    // A webhook takes the payload as it is and answers with no message id;
    // the app posts to a DM and gets back the channel and `ts` a later
    // update names.
    const r = this.webhook ? await this.client.post(msg) : await this.client.chat.postMessage({ channel: this.channelName, ...msg, unfurl_links: false });
    const held = this.store.heldDeliveries().find((d) => d.item_id === item.id) || null;
    // In app mode a held row was keyed on the user id and the DM it became
    // has its own channel id, which is what a later chat.update must name.
    // In webhook mode both are the literal `webhook` and nothing moves.
    const channel = r.channel || this.channelName;
    if (held) this.store.updateDelivery(held.id, { channel, message_ts: r.ts, status: 'sent', decision_id: decision.id }, now.toISOString());
    else this.store.addDelivery({ item_id: item.id, channel, message_ts: r.ts, status: 'sent', decision_id: decision.id }, now.toISOString());
    // A webhook answers with the body `ok` and no message id, so there is
    // no `ts` to name here or to update later — the note says where, and
    // that is all there is to say.
    return { delivered: true, note: `sent ${where(channel, r.ts)}` };
  }

  /** After an action, from any surface: the DM that carries the item says
   *  what was done and loses its buttons. A held P0 is dropped — you have
   *  already dealt with it. */
  async reflect(result) {
    const { item } = result;
    const now = this.now();
    // Dropping what is held still matters in both modes — you have dealt
    // with the item, so the follow-up must not arrive. The row does not say
    // which window was holding it (quiet, or coalescing), and it does not
    // need to.
    for (const h of this.store.heldDeliveries().filter((d) => d.item_id === item.id)) this.store.updateDelivery(h.id, { status: 'dropped', decision_id: h.decision_id, error: `${result.action} before the held message went out` }, now.toISOString());
    if (!this.enabled || !this.client) return false;
    // Webhook mode: the message stands as sent. It cannot be rewritten to
    // say what you then did, and acting happens on the page, which is where
    // §11 put it anyway. Explicitly nothing, not a swallowed throw.
    if (this.webhook) return false;
    return this.#serial(item.id, async () => {
      const last = this.store.lastSent(item.id);
      if (!last) return false;
      await this.client.chat.update({ channel: last.channel, ts: last.message_ts, ...actedMessage(this.store, result, now, last.decision_id) });
      return true;
    });
  }

  /** Once a minute: what the quiet window or a coalesce window held, once
   *  it ends. That is the whole of the timer now. */
  async tick() {
    const flushed = await this.flush();
    return { flushed };
  }

  /** Send what the quiet window held, once it is over. One message per item. */
  async flush() {
    const now = this.now();
    if (!this.enabled || inQuiet(this.quiet, now, this.tz)) return 0;
    let n = 0;
    for (const d of this.store.heldDeliveries()) {
      const item = this.store.item(d.item_id);
      // In webhook mode a held row may be waiting on the coalesce window a
      // send opened rather than on quiet; either way this is where the one
      // follow-up goes out, and it goes at the window's end.
      let why = ' (after quiet window)';
      if (this.webhook && this.coalesceMs) {
        const posted = this.store.lastPosted(d.item_id, this.channelName);
        if (posted) {
          if (now - Date.parse(posted.ts) < this.coalesceMs) continue;
          why = ' (coalesced follow-up)';
        }
      }
      const decision = this.store.decisionsFor(d.item_id).find((x) => x.id === d.decision_id) || this.store.lastDecision(d.item_id);
      const events = this.store.events(d.item_id);
      const event = events.filter((e) => decision?.event_ids.includes(e.id)).at(-1) || events.at(-1);
      try {
        const r = await this.send({ item, decision, event }, now);
        if (decision) this.store.markDelivered(decision.id, true, r.note + why);
        n++;
      } catch (e) {
        this.store.updateDelivery(d.id, { status: 'failed', decision_id: d.decision_id, error: e.message }, now.toISOString());
        this.log(`slack: ${item.key}: ${e.message}`);
      }
    }
    return n;
  }
}
