/**
 * ORB-138 — write every completed door turn back into the Brain as a conversation log.
 *
 * Saga's old container held this wiring; when it was retired on 2026-08-13 capture stopped with
 * it, and the dream cycle (whose ONLY input is these files) has reflected on nothing every night
 * since. `lib/turn-capture.ts` does the writing; this file is the seam that decides WHAT a turn
 * was and WHO spoke.
 *
 * WHY AN AGENT-LEVEL HOOK, NOT A CHANNEL `events` HANDLER
 * Two reasons, both structural.
 *   1. A channel `events` map cannot subscribe to `message.received` at all — `ChannelEvents`
 *      exposes a subset of the stream vocabulary and that event is not in it. Without it there
 *      is no input text, and `message.completed` alone carries only the reply.
 *   2. eve merges channel handlers as `{...defaultEvents, ...yourEvents}`, so supplying a key
 *      REPLACES the built-in default. On both doors the `message.completed` default is what
 *      posts the reply. That is exactly the 2026-08-17 production failure (see the long comment
 *      in `agent/channels/telegram.ts`): an override shipped without the default's post, and
 *      every reply went silently undelivered. Hooks are a separate dispatch step, not a spread —
 *      "Both fire when both are registered" (eve docs, guides/hooks.md) — so this seam is
 *      incapable of repeating that, and it covers both doors (and any future door) from one file.
 *
 * THE UNIT IS AN EXCHANGE, NOT A TURN
 * An exchange runs from Bendik's message to Saga's next terminal reply. eve's "turn" is a
 * smaller thing: when the model calls a tool behind an approval gate the turn PARKS,
 * `harness/tool-loop.js` emits the epilogue there, and the continuation arrives as a brand-new
 * turn id carrying no `message.received`. Keyed per turn, that produced TWO files for one
 * conversation — the first with the question and the proposals but no reply, the second with the
 * reply and an empty `**Bendik:**` line. Observed live 2026-08-20 06:50 (two files, 43 seconds
 * apart, one exchange), and a regression: the 160-file pre-outage corpus contains no
 * question-less file at all. It also actively harms the dream cycle, which would reflect on a
 * question with no answer and an answer with no question.
 *
 * So the buffer is keyed by SESSION, `message.completed` (non-interim, with text) is what
 * flushes, and `turn.completed` no longer does — it cannot, because the exchange may not be over.
 *
 * `message.completed` fires more than once per turn (interim tool-call narration, then the
 * terminal reply), so nothing here keys off "an event arrived". `turn.failed` / `turn.cancelled`
 * discard: a failed exchange is never recorded as a finished one.
 *
 * TOTALITY
 * eve turns a thrown hook into `turn.failed`, and escalates to `session.failed` if the handler
 * for that also throws. Capture is an artifact of the turn, not part of it: every handler is
 * total — it warns and returns rather than throwing, whatever the event or context looks like.
 *
 * MODULE SCOPE IS INERT. `eve build` evaluates every module with no secrets present; nothing
 * here reads the environment at import time. The vault root is resolved lazily inside
 * `captureTurn`, per call.
 *
 * ADR-0020 ADDENDUM (W3B-s2, docs/decisions/0020-conversations.md). `flush` now hands
 * `deps.capture` a `sessionId`, a `turnId` and an `origin` (`lib/turn-capture.ts`'s
 * `originForTurn`) on every entry — the conversation record this hook's output primarily feeds
 * from here on. None of the buffering or attribution reasoning above changes; only what a
 * finished exchange carries when it is handed off.
 */
import { defineHook, type HookContext, type HookEvent } from "eve/hooks";

import { configuredOwnerId } from "../../lib/identity-client.js";
import { captureTurn, originForTurn, type TurnLogEntry } from "../../lib/turn-capture.js";

/**
 * A HOOK context reports the adapter's bare kind — `"slack"` / `"telegram"` — because
 * `buildHookContext` (`dist/src/context/hook-lifecycle.js`) derives it via
 * `getAdapterKind(channel)`, which is a plain `channel.kind`, and `slackChannel.js` /
 * `telegramChannel.js` pass `kindHint: "slack"` / `"telegram"`.
 *
 * The `"channel:<name>"` spelling exists too, but it is the INSTRUMENTATION projection, stored
 * under a different context key that hooks never receive. An earlier revision of this file
 * matched only the prefixed form, so `doorOf` returned undefined for every real turn and nothing
 * was ever captured — silently, with no error and no warning. That is the exact failure mode this
 * ticket exists to end, so both spellings are accepted and the decision is made by the
 * known-door set below rather than by the prefix.
 */
const CHANNEL_PREFIX = "channel:";

/**
 * The two doors Bendik actually converses through. Anything else — `http`, `subagent`,
 * `schedule`, `unknown`, or a `defineChannel` default — is not a conversation.
 */
const DOORS = new Set(["slack", "telegram"]);

/**
 * How long an exchange may sit in the buffer before it is written out unfinished.
 *
 * EVICTION WRITES, IT DOES NOT DISCARD. That is what preserves a real and legitimate case: an
 * exchange that ends on a gated proposal nobody ever approves produces a question and proposals
 * but no reply, and the pre-outage corpus contains exactly such files (a question,
 * `proposals: calendar.create_event`, no `**Saga:**` line). Those must still reach the vault
 * rather than evaporate. Only a genuinely empty entry is dropped.
 *
 * WHAT THE WINDOW BOUNDS is therefore residence time, not correctness: an unbounded `Map` in a
 * container that runs for weeks. It is NOT a timeout on the conversation.
 *
 * A PARKED HITL TURN IS NOT AN ORPHAN. `harness/tool-loop.js` calls `emitTurnEpilogue` at the
 * park point itself, on both the `input.requested` and `authorization.required` branches, guarded
 * by `mode === "conversation"` (the default: `channel/channel-address.js` does
 * `mode: o.mode ?? "conversation"`, and neither door nor any schedule's `to().send()` passes a
 * mode). So a parked turn emits `turn.completed` and the continuation comes back as a NEW turn
 * id — which is precisely why the buffer is keyed by session and not by turn.
 *
 * WHY 24 HOURS rather than minutes: `evictStale()` runs on event arrivals, not on a timer, so the
 * window does not drive how often eviction happens — only how long an unfinished exchange waits
 * before being written. A generous ceiling avoids cutting a slow exchange in half.
 */
const MAX_EXCHANGE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The words Bendik actually said, unwrapped from any channel envelope around them.
 *
 * Saga's Slack door delivers the model a structured wrapper, and the raw event text is the whole
 * thing — `<slack_message>` with `sender_id`, `channel_id`, `thread_ts`, `team_id` and the human's
 * sentence buried in a `<content>` block. Logging that verbatim (observed live 2026-08-20) puts
 * markup and channel identifiers into the Brain, and leaves Part B's reflector chewing on XML.
 * The pre-outage corpus has the clean sentence and no envelope anywhere in it.
 *
 * Deliberately door-agnostic — it keys off the envelope's shape, not `door === "slack"`, because
 * the same wrapper can appear elsewhere. Every malformed shape (no `<content>`, an unclosed tag,
 * an empty body) falls back to the raw text: losing the words would be far worse than keeping a
 * little markup.
 */
const CONTENT_OPEN = "<content>";
const CONTENT_CLOSE = "</content>";

export function spokenText(raw: string): string {
  if (typeof raw !== "string") return "";
  const open = raw.indexOf(CONTENT_OPEN);
  if (open === -1) return raw;
  const close = raw.indexOf(CONTENT_CLOSE, open + CONTENT_OPEN.length);
  if (close === -1) return raw;
  const inner = raw.slice(open + CONTENT_OPEN.length, close).trim();
  return inner === "" ? raw : inner;
}

/**
 * The scheduled lane that started this turn, or `undefined` when a human spoke.
 *
 * THIS IS THE MOST IMPORTANT FUNCTION IN THE FILE. These logs live inside the vault Saga's
 * brain-search walks: a machine nudge rendered as "**Bendik:**" lets a later turn quote him
 * saying something he never said.
 *
 * A schedule starts its turn with eve's one shared framework constant
 * (`dist/src/channel/schedule-auth.js`):
 *   `{ attributes:{}, authenticator:"app", principalId:"eve:app", principalType:"runtime" }`
 * while a human turn carries `"slack-webhook"` / `"telegram-webhook"`. `ctx.channel.kind` is
 * NOT a schedule signal — a schedule targeting a door still reports that door. Only auth
 * distinguishes them. (eve ships `isScheduleAppAuth` for this check, but only at the internal
 * `#channel/schedule-auth.js` path, which no public `eve/*` entry point re-exports — hence the
 * inline comparison, which tests the same three fields the framework helper does.)
 *
 * Read `auth.current`, NEVER `auth.initiator`. `.initiator` stays `"eve:app"` for the whole life
 * of a schedule-started session, so a human replying inside a brief's thread would be recorded
 * as machine-spoken on every later turn. `.current` is per-turn and is correct.
 *
 * Each schedule passes its own name through `attributes.lane` (there is no metadata parameter on
 * `send()`, but `SessionAuthContext.attributes` is public). Anything that is not a non-empty
 * string — missing, an empty string, or the `readonly string[]` the type also permits —
 * deliberately falls through to `"scheduled"`. That fallback is a safety net, not the design: it
 * guarantees a machine turn can never be attributed to Bendik even if a schedule is added later
 * and its author forgets the lane.
 */
function laneOf(ctx: HookContext): string | undefined {
  const current = ctx?.session?.auth?.current;
  if (!current) return undefined;
  if (current.authenticator !== "app" || current.principalId !== "eve:app" || current.principalType !== "runtime") {
    return undefined;
  }
  const lane = current.attributes?.lane;
  return typeof lane === "string" && lane.trim() !== "" ? lane : "scheduled";
}

/** One exchange in flight, gathered across every turn it spans. */
interface PendingExchange {
  startedAt: number;
  /**
   * The turn that opened this exchange. A later `message.received` on a DIFFERENT turn is a new
   * exchange — possibly with a different speaker — and must not be merged into this one.
   */
  turnId: string;
  door: string;
  lane?: string;
  input: string;
  reply: string;
  proposals: string[];
}

export interface TurnCaptureDeps {
  /** Where a finished entry goes. Injected so the hook's logic is testable without a vault. */
  capture: (entry: TurnLogEntry) => Promise<void>;
  /** Injected clock, for the eviction test. */
  now?: () => number;
}

/**
 * Builds the handlers over one private buffer. Exported so the tests can drive them directly,
 * without reaching into eve's runtime or mocking `defineHook`.
 */
export function makeTurnCapture(deps: TurnCaptureDeps) {
  const pending = new Map<string, PendingExchange>();
  const now = deps.now ?? (() => Date.now());

  /**
   * TRIPWIRE. Every channel kind this instance has already complained about, so the log carries
   * one line per unrecognised kind rather than one per turn.
   *
   * There is an open question only the live box can settle: whether a SCHEDULE-started turn's
   * hook context has a channel populated at all. If it does not, scheduled turns get no door and
   * are silently never captured. Rather than wait to notice that the way we noticed the original
   * outage — six days later, from an empty directory — this makes the box say so on day one.
   *
   * Per-instance rather than module-scope: production builds exactly one instance, so behaviour
   * is identical there, but a module-level Set would leak "already warned" state between tests
   * and let a future test silently observe no warning.
   */
  const warnedKinds = new Set<string>();

  /**
   * Which door this turn came in on, or `undefined` when it is not a door turn at all.
   *
   * Tolerates both the bare and the `channel:`-prefixed spelling; `DOORS` is what actually
   * decides.
   */
  function doorOf(ctx: HookContext): string | undefined {
    const kind = ctx?.channel?.kind;
    if (typeof kind === "string") {
      const door = kind.startsWith(CHANNEL_PREFIX) ? kind.slice(CHANNEL_PREFIX.length) : kind;
      if (DOORS.has(door)) return door;
    }
    const seen = typeof kind === "string" ? kind : String(kind);
    if (!warnedKinds.has(seen)) {
      warnedKinds.add(seen);
      console.warn(`turn-capture-hook: not capturing turns for channel kind ${JSON.stringify(seen)} — recognised doors are ${[...DOORS].join(", ")} (this warns once per kind)`);
    }
    return undefined;
  }

  function warn(where: string, err: unknown): void {
    console.warn(`turn-capture-hook: ${where} failed (turn unaffected):`, err);
  }

  /**
   * The buffer key: the SESSION.
   *
   * It used to be `${session.id}:${turnId}`, which split every tool-using exchange into two files
   * (see this file's header).
   *
   * BE CLEAR ABOUT WHAT A SESSION IS, because an earlier version of this comment got it wrong and
   * a Critical defect followed. A session is ONE CHAT-DAY on one address, not one conversation
   * and not one speaker. Schedules do NOT get their own: `to(telegram, { chatId }).send(...)`
   * goes through `deliver()`, which calls `runtime.dispatchContinuation({command,
   * continuationToken})` (`dist/src/channel/channel-address.js`) — it RESUMES an existing session
   * by token rather than creating one, and for a private chat
   * `telegramContinuationToken({chatId, messageThreadId, conversationId})`
   * (`dist/src/public/channels/telegram/api.js`) collapses to the same token an inbound message
   * from Bendik resolves to. So the morning brief runs INSIDE Bendik's live session.
   *
   * One slot therefore holds his exchanges and every scheduled push to that address, one at a
   * time. What separates them is not the key but the seeding turn id — see `onMessageReceived`.
   */
  function keyOf(ctx: HookContext): string | undefined {
    const sessionId = ctx?.session?.id;
    return typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined;
  }

  /**
   * Hand one exchange to the writer — the SINGLE place that decides whether it is written at all.
   *
   * AN EXCHANGE NOBODY SPOKE INTO IS NOT WRITTEN. The rule is asymmetric on purpose:
   *   - an input with no reply IS written — that is the gated proposal awaiting approval, and the
   *     160-file pre-outage corpus contains 3 such files;
   *   - an input-less exchange is NEVER written, whatever else it accumulated. The same corpus
   *     contains ZERO files with a `**Saga:**` reply above an empty `**Bendik:**` line.
   *
   * In practice this drops the HITL button tap: he taps, Saga acts and confirms, and no words
   * were ever typed. So we deliberately lose Saga's confirmation message after an approved
   * proposal — which is exactly what the old runtime did, and this is a faithful port. If Part B's
   * dream cycle later wants those confirmations, that is a separate decision with its own ticket,
   * not something to reintroduce quietly here.
   *
   * The skip is logged (taps are rare, so it will not be noisy) because it is the only way we
   * would notice this rule starting to eat real conversations.
   *
   * `atMs` is explicit because `conversation-log.ts` derives BOTH the date directory and the
   * filename from it, and the dream cycle reads by date. A finished exchange is stamped now; an
   * UNFINISHED one is stamped `startedAt`, which may be many hours earlier — stamping those at
   * flush time filed them under the wrong day and Part B would never have seen them.
   *
   * `unfinished` names why an exchange is being written without a terminal reply; passing it also
   * produces the distinct log line, so an unfinished write is never mistaken for a normal one.
   */
  async function flush(key: string, x: PendingExchange, atMs: number, unfinished?: string): Promise<void> {
    if (x.input.trim() === "") {
      console.warn(`turn-capture-hook: skipping an exchange nobody spoke into — session ${key}, door ${x.door} (a button tap, most likely)`);
      return;
    }
    if (unfinished !== undefined) {
      console.warn(`turn-capture-hook: writing UNFINISHED exchange for session ${key} — ${unfinished}`);
    }
    await deps.capture({
      // MUST be well-formed ISO or Part B's cursor never sees the entry.
      at: new Date(atMs).toISOString(),
      door: x.door,
      // The person who spoke, canonicalised. 159 of the 160 logs the old runtime wrote carry
      // `principal: bendik`, and its own type says `principal: string; // who sent it
      // (e.g. 'bendik')`. The "never canonicalise a channel address" trap is about addresses
      // stored AS addresses (delivery targets, allowlist entries, threadRefs) — not about
      // naming who spoke. The conversation record's `person_key` is this same value
      // (`lib/turn-capture.ts` copies `principal` straight across) — the same identity
      // resolution the door already uses for the principal, never a display name.
      principal: configuredOwnerId(),
      // ADR-0020: the session and the opening turn this exchange is keyed on, and the origin
      // class it carries — computed once, here, at write time.
      sessionId: key,
      turnId: x.turnId,
      origin: originForTurn(x.lane, { sessionId: key, turnId: x.turnId }),
      input: x.input,
      reply: x.reply,
      proposals: x.proposals,
      ...(x.lane ? { lane: x.lane } : {}),
    });
  }

  /**
   * Hygiene — but hygiene that WRITES. An exchange left unfinished past the window (typically one
   * that ended on a gated proposal nobody answered) is written out as it stands rather than
   * dropped, which is how the old runtime's reply-less files came to exist. Only an empty shell
   * is discarded. Logged distinctly so an unfinished write is never mistaken for a normal one.
   */
  async function evictStale(): Promise<void> {
    const cutoff = now() - MAX_EXCHANGE_AGE_MS;
    for (const [key, x] of [...pending]) {
      if (x.startedAt > cutoff) continue;
      // The snapshot is stale the moment we await below, so re-check membership before acting:
      // a handler that ran in between may already have flushed and replaced this slot, and a
      // double write would put the same exchange in the vault twice.
      if (pending.get(key) !== x) continue;
      pending.delete(key);
      try {
        await flush(key, x, x.startedAt, `no terminal reply within ${MAX_EXCHANGE_AGE_MS / 3600000} hours`);
      } catch (err) {
        warn("eviction flush", err);
      }
    }
  }

  /**
   * Door and lane are properties of the turn that opened the exchange, not of a later event's
   * context — which is exactly why a new turn must re-seed rather than reuse the open slot.
   */
  function seed(key: string, ctx: HookContext, turnId: string, input: string): void {
    const door = doorOf(ctx);
    if (!door) return;
    const lane = laneOf(ctx);
    pending.set(key, { startedAt: now(), turnId, door, ...(lane ? { lane } : {}), input, reply: "", proposals: [] });
  }

  /**
   * Where an exchange is first recognised.
   *
   * `emitTurnPreamble` always emits `turn.started`, but emits `message.received` only when the
   * delivery carried a message (`t.message !== undefined`) — a turn resumed by a proposal-button
   * tap arrives as `inputResponses`, typed `message?: never`, and emits none. Door and lane are
   * only reliably available here, and an entry seeded before its input arrives is fine:
   * `message.received` fills it in a moment later, if there is one at all.
   *
   * SEEDING HERE NO LONGER EXISTS TO CAPTURE TAPS — `flush` now drops any exchange with no input,
   * so a tap is never written. What it still buys is that the tap is OBSERVED: the slot exists, so
   * the drop is logged with its door instead of passing silently. (`message.received` also seeds
   * defensively, so an input-carrying turn would be captured either way.)
   *
   * Returns early when the session is already buffered: the SECOND `turn.started` of a
   * tool-using exchange must not reset the question and proposals gathered by the first.
   */
  async function onTurnStarted(event: HookEvent<"turn.started">, ctx: HookContext): Promise<void> {
    try {
      await evictStale();
      const key = keyOf(ctx);
      const turnId = event?.data?.turnId;
      if (!key || typeof turnId !== "string" || turnId === "" || pending.has(key)) return;
      seed(key, ctx, turnId, "");
    } catch (err) {
      warn("turn.started", err);
    }
  }

  /**
   * A turn's input — the human's words, unwrapped from any channel envelope (see `spokenText`).
   *
   * THE RE-SEED RULE, and the Critical it exists to prevent. A schedule does NOT get its own
   * session (see `keyOf`): `morning-brief.ts`'s `to(telegram, { chatId }).send(...)` resumes
   * Bendik's live session. So the open slot and an incoming scheduled push can collide, and
   * whatever the slot already holds — its `door`, its `lane`, its `reply`, its `proposals` —
   * would be inherited by the wrong speaker.
   *
   * This used to re-seed only when the slot's input was non-empty. Empty-input slots are not
   * exotic: EVERY HITL button-tap turn seeds exactly one (`turn.started` with no
   * `message.received`, which is why seeding lives on `turn.started` at all). A brief arriving
   * into such a slot filled in its prompt text under the tap's laneless, human-attributed
   * entry — producing `**Bendik:** Write the morning brief for today.` in the vault, with the
   * tap's proposal bled in. A later turn could then quote Bendik saying a brief's prompt. That
   * is the precise corruption this whole branch exists to prevent.
   *
   * So the test is the TURN, not the input: a `message.received` on a different turn than the one
   * that seeded the slot is a new exchange, gets the open one written out first, and is seeded
   * fresh from the current `ctx` — inheriting nothing.
   *
   * Read the id from `event.data.turnId`, never `ctx.session.turn.id`: `turnId` is required and
   * non-nullable on both `turn.started` and `message.received` (`protocol/message.d.ts:128-149`),
   * and the event is the thing that actually varies per turn.
   *
   * The tool-park continuation is untouched by this rule, because it emits no `message.received`
   * at all — which is what keeps a tool-using exchange in one file.
   *
   * LATENT EDGE, unreachable today — read this before adding a schedule. The rule keys off
   * `message.received`, so a schedule that started a turn WITHOUT sending a prompt would inherit
   * whatever slot is open instead of starting its own exchange, and its turn would be attributed
   * to whoever opened that slot. All six schedules send a prompt
   * (`to(...).send(prompt, { auth: ... })`), so nothing hits this. A promptless one would need
   * `turn.started` to carry the re-seed decision as well — which it cannot do safely today,
   * because it fires for the tool-park continuation too.
   */
  async function onMessageReceived(event: HookEvent<"message.received">, ctx: HookContext): Promise<void> {
    try {
      const key = keyOf(ctx);
      if (!key) return;
      await evictStale();
      const turnId = event?.data?.turnId;
      if (typeof turnId !== "string" || turnId === "") return;
      const input = spokenText(typeof event.data.message === "string" ? event.data.message : "");

      const open = pending.get(key);
      if (open && open.turnId !== turnId) {
        pending.delete(key);
        // Stamped `startedAt`, not now: this exchange happened when it happened, and the dream
        // cycle reads by date. `flush` decides whether it is written at all.
        await flush(key, open, open.startedAt, "a new turn began before any terminal reply");
        seed(key, ctx, turnId, input);
        return;
      }

      // Seeded by `turn.started` a moment ago; just fill in what was said.
      if (open) open.input = input;
      else seed(key, ctx, turnId, input);
    } catch (err) {
      warn("message.received", err);
    }
  }

  /** Tool names accumulate across every turn of the exchange, not just the first. */
  async function onActionsRequested(event: HookEvent<"actions.requested">, ctx: HookContext): Promise<void> {
    try {
      const key = keyOf(ctx);
      const entry = key ? pending.get(key) : undefined;
      if (!entry) return;
      for (const action of event.data.actions ?? []) {
        if (action.kind === "tool-call") entry.proposals.push(action.toolName);
      }
    } catch (err) {
      warn("actions.requested", err);
    }
  }

  /**
   * THE FLUSH POINT. A non-interim `message.completed` carrying text is Saga's terminal reply, and
   * that is what ends an exchange — not `turn.completed`, which also fires at a park boundary
   * mid-conversation.
   *
   * `finishReason === "tool-calls"` marks interim narration: real text, but not the answer.
   * A non-interim event with no text ends no exchange either — the entry stays buffered so it can
   * still be written later as the reply-less file it legitimately is.
   *
   * THE FIRST such event CLOSES THE EXCHANGE IRREVERSIBLY: the slot is deleted and the file
   * written, so nothing arriving afterwards — a second reply, a `turn.failed` — can amend or
   * unwrite it. That is deliberate; a reply Bendik has already read is a fact.
   *
   * Note the gate is a BLACKLIST (`"tool-calls"` only) and not a `"stop"` whitelist. eve
   * normalises any provider finish reason it does not recognise to `"other"`
   * (`normalizeAssistantStepFinishReason`), so a whitelist would silently stop capturing the day
   * a provider returns something new. Failing towards "this was the answer" is the safe
   * direction here.
   */
  async function onMessageCompleted(event: HookEvent<"message.completed">, ctx: HookContext): Promise<void> {
    try {
      const key = keyOf(ctx);
      const entry = key ? pending.get(key) : undefined;
      if (!key || !entry) return;
      if (event.data.finishReason === "tool-calls") return;
      if (typeof event.data.message !== "string" || event.data.message === "") return;
      entry.reply = event.data.message;
      pending.delete(key);
      await flush(key, entry, now());
    } catch (err) {
      warn("message.completed", err);
    }
  }

  /**
   * NOT a flush point, and not a discard either.
   *
   * A turn can end at a park boundary with the exchange still going, and the continuation needs
   * the buffered question. All this does now is give eviction a heartbeat.
   */
  async function onTurnCompleted(event: HookEvent<"turn.completed">, ctx: HookContext): Promise<void> {
    void event;
    void ctx;
    try {
      await evictStale();
    } catch (err) {
      warn("turn.completed", err);
    }
  }

  /**
   * `turn.failed` / `turn.cancelled`: the exchange ends here, with whatever it has.
   *
   * A blanket discard was right when the buffer was keyed per turn. It is too broad now that one
   * slot spans a whole chat-day: a tool-using exchange whose CONTINUATION turn fails would lose
   * the question and the proposals entirely — which the per-turn code had already written at the
   * park boundary, and so did the pre-outage runtime — and, because schedules share the session,
   * a failing scheduled turn would destroy an unrelated buffered human exchange.
   *
   * So: if Bendik actually said something, it is written as a reply-less file (a shape the corpus
   * already contains). Otherwise it is dropped. "A failed turn is never recorded as a finished
   * one" still holds either way — there is no `**Saga:**` line on it.
   */
  async function onTurnDiscarded(
    event: HookEvent<"turn.failed"> | HookEvent<"turn.cancelled">,
    ctx: HookContext,
  ): Promise<void> {
    void event;
    try {
      const key = keyOf(ctx);
      const open = key ? pending.get(key) : undefined;
      if (key) pending.delete(key);
      if (key && open) await flush(key, open, open.startedAt, "the turn failed or was cancelled");
      await evictStale();
    } catch (err) {
      warn("turn.failed/turn.cancelled", err);
    }
  }

  return {
    onTurnStarted,
    onMessageReceived,
    onActionsRequested,
    onMessageCompleted,
    onTurnCompleted,
    onTurnDiscarded,
  };
}

const live = makeTurnCapture({ capture: captureTurn });

export default defineHook({
  events: {
    "turn.started": live.onTurnStarted,
    "message.received": live.onMessageReceived,
    "actions.requested": live.onActionsRequested,
    "message.completed": live.onMessageCompleted,
    "turn.completed": live.onTurnCompleted,
    "turn.failed": live.onTurnDiscarded,
    "turn.cancelled": live.onTurnDiscarded,
  },
});
