/**
 * agent/hooks/model-usage.ts — writes down the token counts of every model call, so the prompt
 * cache's hit rate can be read back later. Backs `services/box/sql/005_model_steps.sql` via
 * `@lares/agent-kit/model-usage`.
 *
 * eve's `step.completed` event carries `data.usage.{inputTokens, outputTokens, cacheReadTokens,
 * cacheWriteTokens, costUsd}` and `data.{turnId, stepIndex}`
 * (`node_modules/eve/dist/src/protocol/message.d.ts` `StepCompletedStreamEvent`); `meta.id` is
 * the event's unique id and is the row's key. Numbers and ids only are stored.
 *
 * BEST-EFFORT, like `approval-record.ts`: eve turns a thrown hook into `turn.failed`, so the
 * handler catches everything and warns at most once per process. `getPool()` is called inside the
 * handler, never at module scope, so `eve build` never touches it.
 */
import { isPrivateConsoleContext } from "@lares/agent-kit/private-console-surface";
import { defineHook, type HookContext } from "eve/hooks";

import { getPool } from "@lares/agent-kit/db";
import { recordModelStep, type ModelStep } from "@lares/agent-kit/model-usage";

let warnedOnce = false;
function warn(err: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn("model-usage-hook: step.completed failed (this and any further failures this process are swallowed; the turn is unaffected):", err);
}

export interface ModelUsageDeps {
  record?: (s: ModelStep) => void;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Builds the handler. Exported so the tests can drive it directly. */
export function makeModelUsage(deps: ModelUsageDeps = {}) {
  const record =
    deps.record ??
    ((s) => {
      void recordModelStep(getPool(), s);
    });

  async function onStepCompleted(event: unknown, ctx: unknown): Promise<void> {
    if (isPrivateConsoleContext(ctx)) return;
    try {
      const e = event as { data?: Record<string, unknown>; meta?: { id?: unknown; at?: unknown } } | undefined;
      const data = e?.data;
      const eventId = e?.meta?.id;
      if (typeof data !== "object" || data === null || typeof eventId !== "string" || eventId === "") return;
      const turnId = data["turnId"];
      const stepIndex = data["stepIndex"];
      if (typeof turnId !== "string" || typeof stepIndex !== "number") return;
      const c = ctx as { agent?: { name?: unknown }; session?: { id?: unknown } } | undefined;
      const agent = typeof c?.agent?.name === "string" && c.agent.name !== "" ? c.agent.name : "unknown";
      const sessionId = typeof c?.session?.id === "string" ? c.session.id : "";
      const usage = (typeof data["usage"] === "object" && data["usage"] !== null ? data["usage"] : {}) as Record<string, unknown>;
      record({
        eventId, agent, sessionId, turnId, stepIndex,
        inputTokens: num(usage["inputTokens"]),
        outputTokens: num(usage["outputTokens"]),
        cacheReadTokens: num(usage["cacheReadTokens"]),
        cacheWriteTokens: num(usage["cacheWriteTokens"]),
        costUsd: num(usage["costUsd"]),
        at: typeof e?.meta?.at === "string" ? e.meta.at : undefined,
      });
    } catch (err) {
      warn(err);
    }
  }

  return { "step.completed": onStepCompleted };
}

const live = makeModelUsage();

export default defineHook({
  events: {
    "step.completed": live["step.completed"] as (event: unknown, ctx: HookContext) => Promise<void>,
  },
});
