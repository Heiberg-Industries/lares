/**
 * Write every completed door turn back into the Brain as a conversation log.
 *
 * Without this capture the dream cycle (whose ONLY input is these files) has reflected on nothing every night
 * since. `lib/turn-capture.ts` does the writing; this file is the seam that decides WHAT a turn
 * was and WHO spoke.
 *
 * WHY AN AGENT-LEVEL HOOK, NOT A CHANNEL `events` HANDLER
 * eve merges channel handlers as `{...defaultEvents, ...yourEvents}`, so supplying a key
 * REPLACES the built-in default. On both doors the reply-posting default is what posts the
 * reply. That is exactly a past production failure (see the long comment in
 * `agent/channels/telegram.ts`): an override shipped without the default's post, and every reply
 * went silently undelivered. Hooks are a separate dispatch step, not a spread — "Both fire when
 * both are registered" (eve docs, guides/hooks.md) — so this seam is incapable of repeating that,
 * and it covers both doors (and any future door) from one file.
 *
 * THE EVENTS (eve 1.0 session events; `node_modules/eve/docs/guides/upgrade/session-events.md`)
 *   delivery.consumed   the person's words (it was `message.received`); `data.parts` holds them.
 *   call.requested      one per call; a tool call's name becomes a "proposal" (it was `actions.requested`).
 *   interaction.opened  an approval card was raised (it was `input.requested`).
 *   content.completed   text with `phase: "reply"` is the answer (it was a non-interim `message.completed`).
 *   turn.settled        the turn ended: `data.outcome` is `completed`, `failed` or `cancelled`.
 *   turn.paused         the turn waits for a person; the exchange is NOT over.
 * Token usage is not read here at all (`usage.recorded` belongs to `model-usage.ts`).
 *
 * THE UNIT IS AN EXCHANGE, NOT A TURN
 * An exchange runs from the owner's message to the chief of staff's next terminal reply. When the
 * model calls a tool behind an approval gate the turn PAUSES (`turn.paused`) and, in eve 1.0, the
 * SAME turn continues after the answer. (In 0.60 the turn ended at that park point and the
 * continuation was a brand-new turn id carrying no message, which produced TWO files for one
 * conversation: the first with the question and the proposals but no reply, the second with the
 * reply and an empty `**the owner:**` line. Keyed per turn, that was a regression; the pre-outage
 * corpus contains no question-less file at all, and such a file harms the dream cycle, which
 * would reflect on a question with no answer and an answer with no question.)
 *
 * So the buffer is keyed by SESSION, a reply (`content.completed`, phase `reply`) is what
 * flushes, and a settled turn flushes only what is still open when it ends.
 *
 * `content.completed` fires more than once per turn (narration, then the reply), so nothing here
 * keys off "an event arrived". A `failed` or `cancelled` `turn.settled` writes a reply-less file
 * if the owner said something, and never a finished one.
 *
 * ONE ROW PER EXCHANGE, EVEN IF A LINE IS READ TWICE
 * eve numbers every event by `ctx.position` = `{ line, index }`. The writes below are keyed on
 * `(session, line, index)` of the event that caused them: an event seen a second time (the same
 * line read again, a retried step) changes nothing.
 *
 * TOTALITY
 * eve 1.0 FAILS THE RUNNING TURN when a hook throws. Capture is an artifact of the turn, not part
 * of it: every handler is total — it warns and returns rather than throwing, whatever the event
 * or context looks like.
 *
 * MODULE SCOPE IS INERT. `eve build` evaluates every module with no secrets present; nothing
 * here reads the environment at import time. The vault root is resolved lazily inside
 * `captureTurn`, per call.
 *
 * ADR-0020 ADDENDUM (docs/decisions/0020-conversations.md). `flush` now hands
 * `deps.capture` a `sessionId`, a `turnId` and an `origin` (`lib/turn-capture.ts`'s
 * `originForTurn`) on every entry — the conversation record this hook's output primarily feeds
 * from here on. None of the buffering or attribution reasoning above changes; only what a
 * finished exchange carries when it is handed off.
 */
import { isPrivateConsoleContext } from "@lares/agent-kit/private-console-surface";
import { interaction } from "eve/events";
import { defineHook, type HookContext, type HookEvent } from "eve/hooks";

import { configuredOwnerId } from "../../lib/identity-client.js";
import { captureTurn, originForTurn, type TurnLogEntry } from "../../lib/turn-capture.js";

/**
 * A hook context's `ctx.channel.kind` is `"channel:<name>"` in eve 1.0 (`"channel:slack"`,
 * `"channel:telegram"`); it was the adapter's bare kind before. Both spellings are accepted and
 * the decision is made by the known-door set below rather than by the prefix. An earlier
 * revision of this file matched only one spelling, so `doorOf` returned undefined for every real
 * turn and nothing was ever captured — silently, with no error and no warning. That is the exact
 * failure mode to avoid, and the one-line-per-kind warning in `doorOf` is its tripwire.
 */
const CHANNEL_PREFIX = "channel:";

/**
 * The two doors the owner actually converses through. Anything else — `http`, `subagent`,
 * `schedule`, `unknown`, or a `defineChannel` default — is not a conversation.
 */
const DOORS = new Set(["slack", "telegram"]);

/**
 * How long an exchange may sit in the buffer before it is written out unfinished.
 *
 * EVICTION WRITES, IT DOES NOT DISCARD. That is what preserves a real and legitimate case: an
 * exchange that ends on a gated proposal nobody ever approves produces a question and proposals
 * but no reply, and the pre-outage corpus contains exactly such files (a question,
 * `proposals: calendar.create_event`, no `**the chief of staff:**` line). Those must still reach the vault
 * rather than evaporate. Only a genuinely empty entry is dropped.
 *
 * WHAT THE WINDOW BOUNDS is therefore residence time, not correctness: an unbounded `Map` in a
 * container that runs for weeks. It is NOT a timeout on the conversation.
 *
 * A PAUSED HITL TURN IS NOT AN ORPHAN. A turn that waits for an approval emits `turn.paused`
 * and, in eve 1.0, the SAME turn continues once a person answers. (In 0.60 the turn ended at the
 * park point and the continuation came back as a NEW turn id; the buffer is keyed by session and
 * not by turn so that neither version splits one conversation into two files.)
 *
 * WHY 24 HOURS rather than minutes: `evictStale` runs on event arrivals, not on a timer, so the
 * window does not drive how often eviction happens — only how long an unfinished exchange waits
 * before being written. A generous ceiling avoids cutting a slow exchange in half.
 */
const MAX_EXCHANGE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The words the owner actually said, unwrapped from any channel envelope around them.
 *
 * Chief of staff's Slack door delivers the model a structured wrapper, and the raw event text is the whole
 * thing — `<slack_message>` with `sender_id`, `channel_id`, `thread_ts`, `team_id` and the human's
 * sentence buried in a `<content>` block. Logging that verbatim (observed live) puts
 * markup and channel identifiers into the Brain, and leaves the dream cycle's reflector chewing on XML.
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
 * THIS IS THE MOST IMPORTANT FUNCTION IN THE FILE. These logs live inside the vault the chief of staff's
 * brain-search walks: a machine nudge rendered as "**the owner:**" lets a later turn quote the owner
 * saying something never said.
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
 * `send`, but `SessionAuthContext.attributes` is public). Anything that is not a non-empty
 * string — missing, an empty string, or the `readonly string[]` the type also permits —
 * deliberately falls through to `"scheduled"`. That fallback is a safety net, not the design: it
 * guarantees a machine turn can never be attributed to the owner even if a schedule is added later
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
   * The turn that opened this exchange. A later `delivery.consumed` on a DIFFERENT turn is a new
   * exchange — possibly with a different speaker — and must not be merged into this one.
   */
  turnId: string;
  door: string;
  lane?: string;
  input: string;
  reply: string;
  proposals: string[];
  audienceMemberId?: string;
  audienceAddress?: string;
  audienceAccessRevision?: number;
}

/** These attributes are stamped only by the authored private-channel admission or trusted
 * schedule sender. Provider text cannot supply session auth attributes. */
function audienceOf(ctx: HookContext): Pick<PendingExchange, "audienceMemberId" | "audienceAddress" | "audienceAccessRevision"> {
  const attrs = ctx?.session?.auth?.current?.attributes;
  const memberId = attrs?.lares_continuity_member_id;
  const address = attrs?.lares_continuity_address;
  const revisionText = attrs?.lares_continuity_revision;
  if (typeof memberId !== "string" || !memberId.trim() || typeof address !== "string" || !address.trim() ||
      typeof revisionText !== "string" || !/^[1-9]\d*$/.test(revisionText)) return {};
  const revision = Number(revisionText);
  if (!Number.isSafeInteger(revision)) return {};
  return { audienceMemberId: memberId, audienceAddress: address, audienceAccessRevision: revision };
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
   * Events already handled, by their place on the stream: `<session>:<line>:<index>`. eve gives
   * every event a position that never changes, so an event seen again (a line read twice, a
   * retried step) must change nothing. Bounded: positions only repeat close together.
   */
  const seen = new Set<string>();
  const MAX_SEEN = 4096;
  function firstSight(ctx: HookContext): boolean {
    const sessionId = ctx?.session?.id;
    const line = ctx?.position?.line;
    const index = ctx?.position?.index;
    // No usable position means no way to tell a repeat from a first sight. Handle it: dropping
    // a real turn would be the worse mistake, and the buffer still writes each exchange once.
    if (typeof sessionId !== "string" || !Number.isSafeInteger(line) || !Number.isSafeInteger(index)) return true;
    const id = `${sessionId}:${String(line)}:${String(index)}`;
    if (seen.has(id)) return false;
    if (seen.size >= MAX_SEEN) seen.delete(seen.values().next().value as string);
    seen.add(id);
    return true;
  }

  /** Persist the visible approval card at the pause. The card's rendered text is archive data; its
   *  interaction id only lets the reader drop it as soon as the normal approval ledger settles it. */
  async function onInteractionOpened(event: HookEvent<"interaction.opened">, ctx: HookContext): Promise<void> {
    if (isPrivateConsoleContext(ctx)) return;
    try {
      if (!firstSight(ctx)) return;
      const data = event?.data;
      const key = keyOf(ctx);
      const door = doorOf(ctx);
      const audience = audienceOf(ctx);
      const req = data?.request;
      if (!data || !req || !key || !door || !audience.audienceMemberId) return;
      // Only an approval of a tool call is archived. Questions, sign-ins and budget prompts are not.
      if (req.kind !== "approval" || typeof data.interactionId !== "string" || typeof req.prompt !== "string") return;
      const asked = interaction(ctx.view, data.interactionId)?.call;
      if (!asked || typeof asked.name !== "string") return;
      const turnId = data.subject && "turnId" in data.subject ? data.subject.turnId : (event.scope?.turnId ?? ctx.session?.turn?.id);
      if (typeof turnId !== "string" || turnId === "") return;
      const detail = (globalThis as typeof globalThis & { __eveApprovalDetails?: (tool: unknown, input: unknown) => string | undefined })
        .__eveApprovalDetails?.(asked.name, asked.input);
      const options = Array.isArray(req.options) ? req.options.flatMap((option) => {
        const label = (option as { label?: unknown } | null)?.label;
        return typeof label === "string" ? [label] : [];
      }) : [];
      const text = [req.prompt, detail?.trim(), `Action: ${asked.name}`, options.length ? `Choices: ${options.join(" / ")}` : undefined]
        .filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
      await deps.capture({
        at: new Date(now()).toISOString(), door, principal: configuredOwnerId(), ...audience,
        sessionId: key, turnId, origin: "third_party", input: "", reply: text,
        proposals: [asked.name], approvalRequestId: data.interactionId,
      });
    } catch (err) {
      warn("interaction.opened", err);
    }
  }

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
   * goes through `deliver`, which calls `runtime.dispatchContinuation({command,
   * continuationToken})` (`dist/src/channel/channel-address.js`) — it RESUMES an existing session
   * by token rather than creating one, and for a private chat
   * `telegramContinuationToken({chatId, messageThreadId, conversationId})`
   * (`dist/src/public/channels/telegram/api.js`) collapses to the same token an inbound message
   * from the owner resolves to. So the morning brief runs INSIDE the owner's live session.
   *
   * One slot therefore holds the owner's exchanges and every scheduled push to that address, one at a
   * time. What separates them is not the key but the seeding turn id — see `onDeliveryConsumed`.
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
   *     contains ZERO files with a `**the chief of staff:**` reply above an empty `**the owner:**` line.
   *
   * In practice this drops the HITL button tap: the owner taps, the chief of staff acts and confirms, and no words
   * were ever typed. So we deliberately lose the chief of staff's confirmation message after an approved
   * proposal — which is deliberate. If the
   * dream cycle later wants those confirmations, that is a separate decision,
   * not something to reintroduce quietly here.
   *
   * The skip is logged (taps are rare, so it will not be noisy) because it is the only way we
   * would notice this rule starting to eat real conversations.
   *
   * `atMs` is explicit because `conversation-log.ts` derives BOTH the date directory and the
   * filename from it, and the dream cycle reads by date. A finished exchange is stamped now; an
   * UNFINISHED one is stamped `startedAt`, which may be many hours earlier — stamping those at
   * flush time filed them under the wrong day and the dream cycle would never have seen them.
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
      // MUST be well-formed ISO or the dream cycle's cursor never sees the entry.
      at: new Date(atMs).toISOString(),
      door: x.door,
      // The person who spoke, canonicalised: logs carry
      // `principal: the owner`, and the field's type is `principal: string; // who sent it
      // (e.g. 'the owner')`. The "never canonicalise a channel address" trap is about addresses
      // stored AS addresses (delivery targets, allowlist entries, threadRefs) — not about
      // naming who spoke. The conversation record's `person_key` is this same value
      // (`lib/turn-capture.ts` copies `principal` straight across) — the same identity
      // resolution the door already uses for the principal, never a display name.
      principal: configuredOwnerId(),
      ...(x.audienceMemberId ? {
        audienceMemberId: x.audienceMemberId,
        audienceAddress: x.audienceAddress,
        audienceAccessRevision: x.audienceAccessRevision,
      } : {}),
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
   * dropped, which is how reply-less log files come to exist. Only an empty shell
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
    pending.set(key, { startedAt: now(), turnId, door, ...(lane ? { lane } : {}), ...audienceOf(ctx), input, reply: "", proposals: [] });
  }

  /**
   * Where an exchange is first recognised.
   *
   * `turn.started` always arrives, but a turn that carries no message of its own (a turn resumed
   * from a button tap) has no `delivery.consumed` words. Door and lane are only reliably
   * available here, and an entry seeded before its input arrives is fine: `delivery.consumed`
   * fills it in a moment later, if there is one at all.
   *
   * SEEDING HERE NO LONGER EXISTS TO CAPTURE TAPS — `flush` drops any exchange with no input,
   * so a tap is never written. What it still buys is that the tap is OBSERVED: the slot exists, so
   * the drop is logged with its door instead of passing silently.
   *
   * Returns early when the session is already buffered: a later `turn.started` of a tool-using
   * exchange must not reset the question and proposals gathered by the first.
   */
  async function onTurnStarted(event: HookEvent<"turn.started">, ctx: HookContext): Promise<void> {
    if (isPrivateConsoleContext(ctx)) { if (ctx.session?.id) pending.delete(ctx.session.id); return; }
    try {
      if (!firstSight(ctx)) return;
      await evictStale();
      const key = keyOf(ctx);
      const turnId = event?.data?.turnId;
      if (!key || typeof turnId !== "string" || turnId === "" || pending.has(key)) return;
      seed(key, ctx, turnId, "");
    } catch (err) {
      warn("turn.started", err);
    }
  }

  /** The words a delivery carried: its text parts, unwrapped from any channel envelope. A file or
   *  an unknown part kind adds nothing (the part kinds are an open set). */
  function wordsOf(event: HookEvent<"delivery.consumed">): string {
    const parts = event?.data?.parts;
    if (!Array.isArray(parts)) return "";
    return parts
      .flatMap((part) => (part && part.kind === "text" && typeof part.text === "string" ? [spokenText(part.text)] : []))
      .filter((text) => text.trim() !== "")
      .join("\n");
  }

  /**
   * A turn's input — the human's words, unwrapped from any channel envelope (see `spokenText`).
   *
   * THE RE-SEED RULE, and the Critical it exists to prevent. A schedule does NOT get its own
   * session (see `keyOf`): `morning-brief.ts`'s `to(telegram, { chatId }).send(...)` resumes
   * Owner's live session. So the open slot and an incoming scheduled push can collide, and
   * whatever the slot already holds — its `door`, its `lane`, its `reply`, its `proposals` —
   * would be inherited by the wrong speaker.
   *
   * The test is the TURN, not the input: a `delivery.consumed` on a different turn than the one
   * that seeded the slot is a new exchange, gets the open one written out first, and is seeded
   * fresh from the current `ctx` — inheriting nothing. (A brief arriving into a slot seeded by a
   * button tap once produced `**the owner:** Write the morning brief for today.` in the vault,
   * with the tap's proposal bled in.)
   *
   * Read the id from `event.data.turnId`, never `ctx.session.turn.id`: it is required on
   * `delivery.consumed`, and the event is the thing that actually varies per turn.
   *
   * A second delivery on the SAME turn (a follow-up message, or the text answer to a question)
   * is more of what the same sender said in this exchange; it is added after the first rather
   * than replacing it. A delivery with no words (it only added context) changes nothing.
   *
   * The pause/resume continuation is untouched by this rule: it consumes no new delivery on a
   * new turn, which is what keeps a tool-using exchange in one file.
   *
   * LATENT EDGE, unreachable today — read this before adding a schedule. The rule keys off
   * `delivery.consumed`, so a schedule that started a turn WITHOUT sending a prompt would inherit
   * whatever slot is open instead of starting its own exchange. All six schedules send a prompt
   * (`to(...).send(prompt, { auth: ... })`), so nothing hits this.
   */
  async function onDeliveryConsumed(event: HookEvent<"delivery.consumed">, ctx: HookContext): Promise<void> {
    if (isPrivateConsoleContext(ctx)) { if (ctx.session?.id) pending.delete(ctx.session.id); return; }
    try {
      if (!firstSight(ctx)) return;
      const key = keyOf(ctx);
      if (!key) return;
      await evictStale();
      const turnId = event?.data?.turnId;
      if (typeof turnId !== "string" || turnId === "") return;
      const input = wordsOf(event);

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
      if (open) {
        if (input !== "") open.input = open.input === "" ? input : `${open.input}\n${input}`;
      } else seed(key, ctx, turnId, input);
    } catch (err) {
      warn("delivery.consumed", err);
    }
  }

  /** Tool names accumulate across every turn of the exchange, not just the first. Only a TOOL call
   *  is a proposal; skills, agents and the model's own task control are not. */
  async function onCallRequested(event: HookEvent<"call.requested">, ctx: HookContext): Promise<void> {
    if (isPrivateConsoleContext(ctx)) { if (ctx.session?.id) pending.delete(ctx.session.id); return; }
    try {
      if (!firstSight(ctx)) return;
      const key = keyOf(ctx);
      const entry = key ? pending.get(key) : undefined;
      if (!entry) return;
      const capability = event?.data?.capability;
      if (capability?.kind === "tool" && typeof capability.name === "string" && capability.name !== "") {
        entry.proposals.push(capability.name);
      }
    } catch (err) {
      warn("call.requested", err);
    }
  }

  /**
   * THE FLUSH POINT. A completed text part with `phase: "reply"` is the chief of staff's terminal
   * reply, and that is what ends an exchange — not `turn.paused`, which also fires at an approval
   * pause mid-conversation.
   *
   * `phase: "narration"` marks interim text: real words, but not the answer. A phase that is not
   * `reply` (the set is open, and eve itself reads an unknown phase as narration) ends no
   * exchange either. A reply with no inline text (a large value eve carries by reference) ends
   * none here; the entry stays buffered and `turn.settled` writes it, reply-less.
   *
   * THE FIRST such event CLOSES THE EXCHANGE IRREVERSIBLY: the slot is deleted and the file
   * written, so nothing arriving afterwards — a second reply, a failed settle — can amend or
   * unwrite it. That is deliberate; a reply the owner has already read is a fact.
   */
  async function onContentCompleted(event: HookEvent<"content.completed">, ctx: HookContext): Promise<void> {
    if (isPrivateConsoleContext(ctx)) { if (ctx.session?.id) pending.delete(ctx.session.id); return; }
    try {
      if (!firstSight(ctx)) return;
      const key = keyOf(ctx);
      const entry = key ? pending.get(key) : undefined;
      if (!key || !entry) return;
      const data = event?.data;
      if (data?.kind !== "text" || data.phase !== "reply") return;
      if (typeof data.value !== "string" || data.value === "") return;
      entry.reply = data.value;
      pending.delete(key);
      await flush(key, entry, now());
    } catch (err) {
      warn("content.completed", err);
    }
  }

  /**
   * `turn.paused`: NOT a flush point, and not a discard either.
   *
   * A turn pauses while a person is asked (an approval, a question), with the exchange still
   * going; the same turn continues after the answer and the continuation needs the buffered
   * question. All this does is give eviction a heartbeat.
   */
  async function onTurnPaused(event: HookEvent<"turn.paused">, ctx: HookContext): Promise<void> {
    void event;
    if (isPrivateConsoleContext(ctx)) { if (ctx.session?.id) pending.delete(ctx.session.id); return; }
    try {
      if (!firstSight(ctx)) return;
      await evictStale();
    } catch (err) {
      warn("turn.paused", err);
    }
  }

  /**
   * `turn.settled`: the turn is over, whatever the outcome. One exchange is written once.
   *
   * A reply normally flushed the exchange already (`onContentCompleted`), so for a `completed`
   * turn there is usually nothing open and this only gives eviction a heartbeat. What is open at
   * the end of a turn is written as it stands:
   *   - `failed` / `cancelled`: if the owner actually said something, a reply-less file (a shape
   *     the corpus already contains); otherwise it is dropped. "A failed turn is never recorded as
   *     a finished one" holds either way — there is no `**the chief of staff:**` line on it.
   *   - `completed` with no reply text captured (the answer arrived by reference, or the turn
   *     answered with something other than text): the same reply-less file, or the settled turn's
   *     own `reply` parts when eve gives them.
   * The slot is keyed by session, so a settle can only ever write the exchange of ITS turn: a
   * failing scheduled turn does not touch an unrelated human exchange buffered on another turn.
   */
  async function onTurnSettled(event: HookEvent<"turn.settled">, ctx: HookContext): Promise<void> {
    if (isPrivateConsoleContext(ctx)) { if (ctx.session?.id) pending.delete(ctx.session.id); return; }
    try {
      if (!firstSight(ctx)) return;
      const key = keyOf(ctx);
      const open = key ? pending.get(key) : undefined;
      const turnId = event?.data?.turnId;
      // Another turn's settle must not write this exchange. (The session slot belongs to the turn
      // that seeded it; an exchange whose turn is still going stays open.)
      if (key && open && typeof turnId === "string" && open.turnId === turnId) {
        pending.delete(key);
        const outcome = event.data.outcome;
        if (outcome === "completed") {
          const reply = Array.isArray(event.data.reply) ? event.data.reply.filter((p): p is string => typeof p === "string").join("\n") : "";
          open.reply = reply;
          await flush(key, open, reply === "" ? open.startedAt : now(), reply === "" ? "the turn settled without a text reply" : undefined);
        } else {
          await flush(key, open, open.startedAt, `the turn ${outcome === "cancelled" ? "was cancelled" : "failed"}`);
        }
      }
      await evictStale();
    } catch (err) {
      warn("turn.settled", err);
    }
  }

  return {
    onTurnStarted,
    onDeliveryConsumed,
    onCallRequested,
    onInteractionOpened,
    onContentCompleted,
    onTurnPaused,
    onTurnSettled,
  };
}

const live = makeTurnCapture({ capture: captureTurn });

export default defineHook({
  events: {
    "turn.started": live.onTurnStarted,
    "delivery.consumed": live.onDeliveryConsumed,
    "call.requested": live.onCallRequested,
    "interaction.opened": live.onInteractionOpened,
    "content.completed": live.onContentCompleted,
    "turn.paused": live.onTurnPaused,
    "turn.settled": live.onTurnSettled,
  },
});
