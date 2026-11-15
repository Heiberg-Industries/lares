/**
 * The per-turn taint, set at the tool result — the origin model,
 * "The in-turn taint rule".
 *
 * WHAT THIS IS FOR. Prompt laundering. An attacker mails the agent; the model reads the mail,
 * correctly flags the text as an injection attempt, and writes a note about it. Today that note
 * lands in memory with no mark that outside text was in the turn at all, and nightly
 * consolidation can promote it into long-term memory as something the agent worked out for
 * itself. This hook is the seam that notices the outside text arriving. `@lares/agent-kit/origin-taint`
 * is what carries the mark to every write for the rest of the turn.
 *
 * WHY A HOOK AND NOT THE TOOLS THEMSELVES, EVEN NOW. A hook sees EVERY tool result, including
 * results from tools nobody thought to instrument, so the mark cannot be lost by a call site
 * forgetting it. What a hook does NOT see is a tool's ARGUMENTS in the result event:
 * `call.settled` carries `{ callId, outcome, output, ... }` and no tool name at all — the name and
 * kind of the call are read from the session view (`ctx.view`) by the call id. `calendar_list_events` needed its arguments to
 * decide (was a specific calendar named?), so that call is made at the tool's own call site
 * (`catalogue/calendar_list_events.ts`) and this hook no longer taints it at all — a blanket
 * `third_party` here would have been wrong for the common case (a bare listing of the owner's
 * own primary calendar). The three tools still named below never needed that: `gmail_read` and
 * `gmail_search` taint `third_party` on every successful call regardless of arguments, and
 * `read_url`'s web/Google-Docs branches do too — only its Notion branch earns the lower `synced`
 * bar, and that branch is untested against this hook's blanket coverage (see
 * `catalogue/read_url.ts`'s own header). Each of the three also taints itself now, at its own
 * call site; the hook staying here is a backstop, not a second, conflicting classification.
 *
 * A CALL WHOSE NAME CANNOT BE READ TAINTS. If the view does not know the call (it always should),
 * the turn is marked `third_party`: not knowing which tool just returned is the state an attacker
 * would engineer, and an under-marked turn is the unsafe direction.
 *
 * TOTALITY. eve turns a thrown hook into `turn.failed`, and escalates to `session.failed` if the
 * handler for that also throws. Taint bookkeeping is an artifact of the turn, never part of it:
 * every handler warns and returns rather than throwing, whatever the event or context looks like
 * (the same rule, for the same reason, as `turn-capture.ts:40-43`).
 *
 * AND IT FAILS CLOSED ANYWAY. A handler that cannot name the turn does nothing — it cannot mark a
 * turn it cannot identify. That is safe because the write side fails closed on exactly the same
 * missing key: `stampFor` with no usable turn key returns `third_party`, the least trusted class.
 * A hook failure therefore costs the owner nothing and costs trust nothing.
 *
 * MODULE SCOPE IS INERT. `eve build` evaluates every module with no secrets present; nothing here
 * reads the environment at import time (`turn-capture.ts:45-47`).
 *
 * EVE-VERSION-BOUND. The event vocabulary and payloads below were read from the INSTALLED eve
 * 1.0.0-rc.9: a tool result is the fact `call.settled` (`CallSettledData`:
 * `dist/src/protocol/session-events/families/call.d.ts`), the call's name and kind are in the view
 * (`call(view, callId)` from `eve/events`), the turn of a call is `event.scope.turnId`, and a turn
 * ends with `turn.settled` (whose `data.turnId` names it). The model reaches an outside tool by its
 * own name or through `eve__tool`; the view names the entry it resolved to, never `eve__tool`. Any
 * eve version bump must re-read all of those before trusting this file.
 */
import { call as callOf } from "eve/events";
import { defineHook, type HookContext, type HookEvent } from "eve/hooks";

import { clearTurn, taintTurn, turnKeyFrom, type Taint } from "@lares/agent-kit/origin-taint";
import {
  CONNECTION_SEARCH_TOOL,
  outsideProblems,
  outsideProblemWording,
  outsideResultTaint,
  type OutsideDefinitionView,
} from "@lares/agent-kit/outside-connections";

import { thisAgent } from "../../lib/definition.js";
import { emitSignal } from "../../lib/signal-emit.js";

/**
 * Every tool whose result brings back words the owner did not write, and the class it taints at.
 *
 * NAMES ONLY, no classification logic — see the header. `calendar_list_events` is NOT here: it taints itself, precisely, at its own call site, because only the call site has the
 * arguments a correct answer needs.
 */
export const TAINTING_TOOLS: ReadonlyMap<string, Taint> = new Map<string, Taint>([
  ["gmail_read", "third_party"],
  ["gmail_search", "third_party"],
  ["read_url", "third_party"],
]);

/**
 * Builds the handlers. Exported so the tests can drive them directly, without reaching into eve's
 * runtime or mocking `defineHook` — the shape `turn-capture.ts:191` uses.
 *
 * There is no per-instance state: the taint map lives in the kit, so that a tool's `execute` and
 * this hook are looking at the same one.
 */
export interface OriginTaintDeps {
  /** The pinned definition for a session; the outside-tool prefixes come from it. */
  definitionFor?: (sessionId: string | undefined) => Promise<OutsideDefinitionView>;
  /** Raises one plain-wording signal; defaults to the fleet emitter. */
  signal?: (event: string, summary: string, detail: string) => Promise<unknown>;
  now?: () => number;
  /** The name and kind of the call a settled event is about; defaults to the session view. */
  callOf?: (ctx: HookContext, callId: string) => { name: string; kind?: string } | undefined;
}

/** The call's name and kind from the session view, or undefined when the view does not know it. */
function callFromView(ctx: HookContext, callId: string): { name: string; kind?: string } | undefined {
  try {
    const view = (ctx as unknown as { view?: never } | null | undefined)?.view;
    if (view === undefined) return undefined;
    const row = callOf(view, callId);
    return row !== undefined && typeof row.name === "string" ? { name: row.name, kind: row.kind } : undefined;
  } catch {
    return undefined;
  }
}

/** How long one outside-tool problem stays quiet after it was reported. */
const PROBLEM_QUIET_MS = 10 * 60 * 1000;

export function makeOriginTaint(deps: OriginTaintDeps = {}) {
  const definitionFor = deps.definitionFor ?? (async (id) => (await thisAgent(id)).loaded.definition);
  const signal = deps.signal ?? ((event, summary, detail) => emitSignal(event, summary, detail, { severity: "warn" }));
  const now = deps.now ?? Date.now;
  const callOfCtx = deps.callOf ?? callFromView;
  const lastProblem = new Map<string, number>();

  /** Outside-tool results: taint by prefix (untrusted connections), and one signal when the key was
   *  refused or the server did not answer. Never throws. */
  async function outsideEffects(event: HookEvent<"call.settled">, ctx: HookContext, toolName: string): Promise<Taint | undefined> {
    if (toolName !== CONNECTION_SEARCH_TOOL && !toolName.includes("__")) return undefined;
    const sessionId = (ctx as { session?: { id?: string } } | null)?.session?.id;
    const definition = await definitionFor(sessionId);
    const data = event?.data as { output?: unknown; outcome?: unknown } | undefined;
    const result = { toolName, output: data?.output };
    for (const p of outsideProblems(result, data?.outcome, definition)) {
      const key = `${definition.name}:${p.connection}:${p.kind}`;
      const last = lastProblem.get(key);
      if (last !== undefined && now() - last < PROBLEM_QUIET_MS) continue;
      lastProblem.set(key, now());
      const w = outsideProblemWording(definition.name, p);
      await signal(`outside-tool:${key}`, w.summary, w.detail);
    }
    return outsideResultTaint(toolName, definition);
  }

  function warn(where: string, err: unknown): void {
    console.warn(`origin-taint-hook: ${where} failed (turn unaffected):`, err);
  }

  /** The turn an event is about, or undefined when it cannot be named. */
  function keyOf(event: unknown, ctx: HookContext): ReturnType<typeof turnKeyFrom> {
    const e = typeof event === "object" && event !== null ? (event as { data?: unknown; scope?: unknown }) : undefined;
    const field = (v: unknown): unknown => (typeof v === "object" && v !== null ? (v as { turnId?: unknown }).turnId : undefined);
    // A turn event names its turn in `data`; a call event names it in `scope`.
    return turnKeyFrom(ctx, field(e?.data) ?? field(e?.scope));
  }

  /**
   * A tool result came back. If it is one of the tainting tools, the turn is marked.
   *
   * TAINTS ON A FAILED OR REJECTED RESULT TOO. `outcome` is `"completed" | "failed" | "rejected" |
   * "interrupted" | "abandoned"`, and nothing in the payload says how much of a partial body reached
   * the model before a failure. Guessing "nothing did" is the under-tainting direction, so the
   * outcome is not consulted at all.
   */
  async function onCallSettled(event: HookEvent<"call.settled">, ctx: HookContext): Promise<void> {
    try {
      const callId = (event?.data as { callId?: unknown } | undefined)?.callId;
      if (typeof callId !== "string") return;
      const asked = callOfCtx(ctx, callId);
      let taint: Taint | undefined;
      let toolName = asked?.name;
      if (asked === undefined) {
        // Fail closed: a result whose tool we cannot name might be any of them.
        taint = "third_party";
        toolName = "an unnamed call";
      } else {
        // A skill load, a task wait or a subagent call is not a tool returning outside text.
        if (asked.kind !== undefined && asked.kind !== "tool") return;
        taint = TAINTING_TOOLS.get(asked.name);
        if (!taint) {
          // Not one of the fixed names: it may still be an outside tool's result. A definition that
          // cannot be read here means no outside tool resolved either, so there is nothing to taint.
          try {
            taint = await outsideEffects(event, ctx, asked.name);
          } catch (err) {
            warn("outside-tool lookup", err);
          }
        }
      }
      if (!taint) return;

      const key = keyOf(event, ctx);
      if (!key) {
        // Nothing to mark and nothing to guess. Loud, because a turn whose id we cannot read is a
        // turn whose writes will all be stamped `third_party` by `stampFor`'s fail-closed branch —
        // correct, but worth seeing in the log rather than inferring from over-stamped memories.
        console.warn(`origin-taint-hook: ${toolName} returned outside text but the turn could not be identified — every write in it falls back to third_party`);
        return;
      }
      taintTurn(key, taint);
    } catch (err) {
      warn("call.settled", err);
    }
  }

  /**
   * A turn is starting: clear first, before anything else can read it.
   *
   * A turn id reused after a restart must not inherit a stale entry. The kit's ceiling would drop
   * such an entry eventually; this drops it deterministically, at the one moment we know for
   * certain that the turn is new.
   */
  async function onTurnStarted(event: HookEvent<"turn.started">, ctx: HookContext): Promise<void> {
    try {
      const key = keyOf(event, ctx);
      if (key) clearTurn(key);
    } catch (err) {
      warn("turn.started", err);
    }
  }

  /**
   * The turn boundary — `turn.settled`, whatever its outcome (completed, failed or cancelled).
   *
   * All three end the turn, so all three drop the entry. A failed turn especially: its writes are
   * over, and leaving a mark behind for a turn that no longer exists is the one thing this module
   * must not do. A turn paused on an approval is NOT settled and keeps its mark: it continues
   * with the same turn id once the card is answered.
   */
  async function onTurnEnded(event: HookEvent<"turn.settled">, ctx: HookContext): Promise<void> {
    try {
      const key = keyOf(event, ctx);
      if (key) clearTurn(key);
    } catch (err) {
      warn("turn.settled", err);
    }
  }

  return { onCallSettled, onTurnStarted, onTurnEnded };
}

const live = makeOriginTaint();

export default defineHook({
  events: {
    "call.settled": live.onCallSettled,
    "turn.started": live.onTurnStarted,
    "turn.settled": live.onTurnEnded,
  },
});
