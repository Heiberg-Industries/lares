/**
 * agent/hooks/approval-record.ts — writes down every approval card eve renders, and what the
 * owner answered. Backs `services/box/sql/086_approval_asks.sql` via
 * `@lares/agent-kit/approval-ledger`.
 *
 * WHY THESE TWO EVENTS. eve 0.60.1 already carries the whole ledger this hook needs, with no eve
 * patch: `input.requested` fires with one `InputRequest` per pending human-input item
 * (`node_modules/eve/dist/src/protocol/message.d.ts` `InputRequestedStreamEvent`), and a
 * `kind: "tool-approval"` request carries `action: { callId, input, kind: "tool-call", toolName }`
 * (`node_modules/eve/dist/src/shared/input.d.ts` `inputRequestSchema`) — exactly what
 * `payloadFingerprint` needs. `input.resolved` fires once eve accepts a terminal outcome
 * (`InputResolvedStreamEvent`), each resolution carrying `{ kind, outcome, requestId, response? }`
 * with `outcome: "answered" | "approved" | "denied" | "ignored" | "invalid"`
 * (`InputResolutionOutcome`). `approval.candidate` / `approval.settled` also exist but carry a
 * `responderPrincipalId` that is only ever non-null where a settlement actor exists — on Telegram
 * it is not (`auth: null`, see `services/chief-of-staff/lib/approvals.ts`'s own header) — so this
 * hook does not depend on them.
 *
 * ONLY A TOOL APPROVAL IS A CARD. A `question` or `session-limit` request/resolution is not
 * recorded here at all — this table is about approvals, not every human-input round trip.
 *
 * BEST-EFFORT, LIKE EVERY RECORDER IN THIS REPO. eve turns a thrown hook into `turn.failed`
 * (the rule `agent/hooks/origin-taint.ts` states and obeys) — every handler below catches
 * everything and warns at most once per process, the same shape `agent/hooks/turn-capture.ts`
 * and `origin-taint.ts` already use. `getPool()` is called inside each handler, never at module
 * scope, so `eve build` (no secrets, no live Postgres) never touches it.
 */
import { defineHook, type HookContext } from "eve/hooks";

import { getPool } from "@lares/agent-kit/db";
import { payloadFingerprint, recordAnswer, recordAsk, type AskOutcome } from "@lares/agent-kit/approval-ledger";

/** eve's `InputResolutionOutcome` mapped onto ours. `answered` has no meaning for a tool
 *  approval (it belongs to a free-text question) and is dropped along with anything unrecognised. */
const OUTCOME_MAP: Readonly<Record<string, AskOutcome | undefined>> = {
  approved: "approved",
  denied: "cancelled",
  ignored: "ignored",
  invalid: "invalid",
};

let warnedOnce = false;
function warn(where: string, err: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`approval-record-hook: ${where} failed (this and any further failures this process are swallowed; the turn is unaffected):`, err);
}

export interface ApprovalRecordDeps {
  record?: (a: { requestId: string; callId: string; agent: string; tool: string; payloadHash: string }) => void;
  answer?: (a: { requestId: string; outcome: AskOutcome }) => void;
}

/**
 * Builds the handlers. Exported so the tests can drive them directly, without reaching into
 * eve's runtime or mocking `defineHook` — the shape `origin-taint.ts`'s `makeOriginTaint` and
 * `turn-capture.ts` already use.
 */
export function makeApprovalRecord(deps: ApprovalRecordDeps = {}) {
  const record =
    deps.record ??
    ((a) => {
      void recordAsk(getPool(), a);
    });
  const answer =
    deps.answer ??
    ((a) => {
      void recordAnswer(getPool(), a);
    });

  async function onInputRequested(event: unknown, ctx: unknown): Promise<void> {
    try {
      const data = (event as { data?: unknown } | undefined)?.data;
      const requests = (data as { requests?: unknown } | undefined)?.requests;
      if (!Array.isArray(requests)) return;
      const agent = typeof (ctx as { agent?: { name?: unknown } } | undefined)?.agent?.name === "string"
        ? (ctx as { agent: { name: string } }).agent.name
        : "unknown";
      for (const req of requests) {
        if (typeof req !== "object" || req === null) continue;
        const r = req as {
          kind?: unknown;
          requestId?: unknown;
          action?: { callId?: unknown; toolName?: unknown; input?: unknown };
        };
        if (r.kind !== "tool-approval") continue;
        const requestId = r.requestId;
        const callId = r.action?.callId;
        const toolName = r.action?.toolName;
        if (typeof requestId !== "string" || typeof callId !== "string" || typeof toolName !== "string") continue;
        record({
          requestId,
          callId,
          agent,
          tool: toolName,
          payloadHash: payloadFingerprint(toolName, r.action?.input),
        });
      }
    } catch (err) {
      warn("input.requested", err);
    }
  }

  async function onInputResolved(event: unknown, _ctx: unknown): Promise<void> {
    try {
      const data = (event as { data?: unknown } | undefined)?.data;
      const resolutions = (data as { resolutions?: unknown } | undefined)?.resolutions;
      if (!Array.isArray(resolutions)) return;
      for (const res of resolutions) {
        if (typeof res !== "object" || res === null) continue;
        const r = res as { kind?: unknown; requestId?: unknown; outcome?: unknown };
        if (r.kind !== "tool-approval") continue;
        const requestId = r.requestId;
        if (typeof requestId !== "string" || typeof r.outcome !== "string") continue;
        const outcome = OUTCOME_MAP[r.outcome];
        if (outcome === undefined) continue;
        answer({ requestId, outcome });
      }
    } catch (err) {
      warn("input.resolved", err);
    }
  }

  return {
    "input.requested": onInputRequested,
    "input.resolved": onInputResolved,
  };
}

const live = makeApprovalRecord();

export default defineHook({
  events: {
    "input.requested": live["input.requested"] as (event: unknown, ctx: HookContext) => Promise<void>,
    "input.resolved": live["input.resolved"] as (event: unknown, ctx: HookContext) => Promise<void>,
  },
});
