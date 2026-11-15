/**
 * agent/hooks/model-usage.ts — writes down the token counts of every model call, so the prompt
 * cache's hit rate can be read back later. Backs `services/box/sql/005_model_steps.sql` via
 * `@lares/agent-kit/model-usage`.
 *
 * eve's `usage.recorded` event carries `data.usage.{inputTokens, outputTokens, cacheReadTokens,
 * cacheWriteTokens, costUsd}`, `data.kind` (`"model"` today; an open set) and `data.owner`
 * (`{ runId }` for a model run); the turn is `event.scope.turnId`
 * (`node_modules/eve/dist/src/protocol/session-events/families/usage.d.ts`). Usage is read from
 * this event ONLY: turn and session events no longer carry tokens. The row's key is the event's
 * place on the stream, `<sessionId>:<line>:<index>` (`ctx.position`), which never changes, so a
 * stream read twice, or a hook step retried, cannot add a second row. Numbers and ids only are stored.
 *
 * BEST-EFFORT, like `approval-record.ts`: eve fails the running turn when a hook throws, so the
 * handler catches everything and warns at most once per process. `getPool()` is called inside the
 * handler, never at module scope, so `eve build` never touches it.
 */
import { isPrivateConsoleContext } from "@lares/agent-kit/private-console-surface";
import { defineHook, type HookContext } from "eve/hooks";
import { runs, type SessionView } from "eve/events";

import { getPool } from "@lares/agent-kit/db";
import { recordModelStep, type ModelStep } from "@lares/agent-kit/model-usage";

let warnedOnce = false;
function warn(err: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn("model-usage-hook: usage.recorded failed (this and any further failures this process are swallowed; the turn is unaffected):", err);
}

export interface ModelUsageDeps {
  record?: (s: ModelStep) => void;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Which model run of its turn this usage belongs to (0 for the first), or 0 when it cannot be told. */
function stepIndexOf(view: unknown, turnId: string, owner: unknown): number {
  try {
    const runId = (owner as { runId?: unknown } | undefined)?.runId;
    if (typeof runId !== "string" || view === undefined || view === null) return 0;
    const index = runs(view as SessionView, { turnId }).findIndex((r) => r.runId === runId);
    return index >= 0 ? index : 0;
  } catch {
    return 0;
  }
}

/** Builds the handler. Exported so the tests can drive it directly. */
export function makeModelUsage(deps: ModelUsageDeps = {}) {
  const record =
    deps.record ??
    ((s) => {
      void recordModelStep(getPool(), s);
    });

  async function onUsageRecorded(event: unknown, ctx: unknown): Promise<void> {
    if (isPrivateConsoleContext(ctx)) return;
    try {
      const e = event as { data?: Record<string, unknown>; scope?: { turnId?: unknown } } | undefined;
      const data = e?.data;
      if (typeof data !== "object" || data === null) return;
      // Only model usage is a model call. An unknown kind (eve adds values without a version change)
      // is not counted here rather than guessed at.
      if (data["kind"] !== "model") return;
      const c = ctx as
        | { agent?: { name?: unknown }; session?: { id?: unknown }; position?: { line?: unknown; index?: unknown }; view?: unknown; now?: unknown }
        | undefined;
      const sessionId = typeof c?.session?.id === "string" ? c.session.id : "";
      const line = c?.position?.line;
      const index = c?.position?.index;
      if (sessionId === "" || !Number.isSafeInteger(line) || !Number.isSafeInteger(index)) return;
      const turnId = typeof e?.scope?.turnId === "string" ? e.scope.turnId : "";
      const agent = typeof c?.agent?.name === "string" && c.agent.name !== "" ? c.agent.name : "unknown";
      const usage = (typeof data["usage"] === "object" && data["usage"] !== null ? data["usage"] : {}) as Record<string, unknown>;
      record({
        eventId: `${sessionId}:${String(line)}:${String(index)}`,
        agent, sessionId, turnId,
        stepIndex: stepIndexOf(c?.view, turnId, data["owner"]),
        inputTokens: num(usage["inputTokens"]),
        outputTokens: num(usage["outputTokens"]),
        cacheReadTokens: num(usage["cacheReadTokens"]),
        cacheWriteTokens: num(usage["cacheWriteTokens"]),
        costUsd: num(usage["costUsd"]),
        // The time of the commit the event is in; the database's clock when it is not a date.
        at: c?.now instanceof Date && !Number.isNaN(c.now.getTime()) ? c.now.toISOString() : undefined,
      });
    } catch (err) {
      warn(err);
    }
  }

  return { "usage.recorded": onUsageRecorded };
}

const live = makeModelUsage();

export default defineHook({
  events: {
    "usage.recorded": live["usage.recorded"] as (event: unknown, ctx: HookContext) => Promise<void>,
  },
});
