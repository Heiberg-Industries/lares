/**
 * The per-turn taint, set at the tool result — docs/specs/2026-09-18-origin-model-design.md,
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
 * forgetting it. What a hook does NOT see is a tool's ARGUMENTS: `action.result` carries
 * `{ result, sequence, stepIndex, status, turnId }` and the result carries only
 * `{ callId, isError?, kind, output, toolName }`. `calendar_list_events` needed its arguments to
 * decide (was a specific calendar named?), so W3A-s5 made that call at the tool's own call site
 * (`catalogue/calendar_list_events.ts`) and this hook no longer taints it at all — a blanket
 * `third_party` here would have been wrong for the common case (a bare listing of the owner's
 * own primary calendar). The three tools still named below never needed that: `gmail_read` and
 * `gmail_search` taint `third_party` on every successful call regardless of arguments, and
 * `read_url`'s web/Google-Docs branches do too — only its Notion branch earns the lower `synced`
 * bar, and that branch is untested against this hook's blanket coverage (see
 * `catalogue/read_url.ts`'s own header). Each of the three also taints itself now, at its own
 * call site; the hook staying here is a backstop, not a second, conflicting classification.
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
 * 0.32.0: `action.result` is exposed to authored hooks at
 * `node_modules/eve/dist/src/public/definitions/hook.d.ts:16`, its payload is at
 * `node_modules/eve/dist/src/protocol/message.d.ts:197-207`, the tool-result shape at
 * `node_modules/eve/dist/src/runtime/actions/types.d.ts:103-113`, and every turn-boundary event
 * carries a required `data.turnId` (`message.d.ts:128-134, 394-400, 404-413, 420-426`). Wave 2's
 * eve bump must re-read all of those before trusting this file.
 */
import { defineHook, type HookContext, type HookEvent } from "eve/hooks";

import { clearTurn, taintTurn, turnKeyFrom, type Taint } from "@lares/agent-kit/origin-taint";

/**
 * Every tool whose result brings back words the owner did not write, and the class it taints at.
 *
 * NAMES ONLY, no classification logic — see the header. `calendar_list_events` is NOT here as of
 * W3A-s5: it taints itself, precisely, at its own call site, because only the call site has the
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
export function makeOriginTaint() {
  function warn(where: string, err: unknown): void {
    console.warn(`origin-taint-hook: ${where} failed (turn unaffected):`, err);
  }

  /** The turn an event is about, or undefined when it cannot be named. */
  function keyOf(event: unknown, ctx: HookContext): ReturnType<typeof turnKeyFrom> {
    const data = typeof event === "object" && event !== null ? (event as { data?: unknown }).data : undefined;
    const turnId = typeof data === "object" && data !== null ? (data as { turnId?: unknown }).turnId : undefined;
    return turnKeyFrom(ctx, turnId);
  }

  /**
   * A tool result came back. If it is one of the tainting tools, the turn is marked.
   *
   * TAINTS ON A FAILED OR REJECTED RESULT TOO. `status` is `"completed" | "failed" | "rejected"`,
   * and nothing in the payload says how much of a partial body reached the model before a failure.
   * Guessing "nothing did" is the under-tainting direction, so the status is not consulted at all.
   */
  async function onActionResult(event: HookEvent<"action.result">, ctx: HookContext): Promise<void> {
    try {
      const result = event?.data?.result as { kind?: unknown; toolName?: unknown } | undefined;
      if (typeof result !== "object" || result === null) return;
      if (result.kind !== "tool-result") return;
      const toolName = result.toolName;
      if (typeof toolName !== "string") return;
      const taint = TAINTING_TOOLS.get(toolName);
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
      warn("action.result", err);
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
   * The turn boundary — `turn.completed`, `turn.failed`, `turn.cancelled` alike.
   *
   * All three end the turn, so all three drop the entry. A failed turn especially: its writes are
   * over, and leaving a mark behind for a turn that no longer exists is the one thing this module
   * must not do.
   */
  async function onTurnEnded(
    event: HookEvent<"turn.completed"> | HookEvent<"turn.failed"> | HookEvent<"turn.cancelled">,
    ctx: HookContext,
  ): Promise<void> {
    try {
      const key = keyOf(event, ctx);
      if (key) clearTurn(key);
    } catch (err) {
      warn("turn.completed/turn.failed/turn.cancelled", err);
    }
  }

  return { onActionResult, onTurnStarted, onTurnEnded };
}

const live = makeOriginTaint();

export default defineHook({
  events: {
    "action.result": live.onActionResult,
    "turn.started": live.onTurnStarted,
    "turn.completed": live.onTurnEnded,
    "turn.failed": live.onTurnEnded,
    "turn.cancelled": live.onTurnEnded,
  },
});
