/**
 * SHARED BY EVERY ROLE'S `agent/hooks/approval-record.ts` (a thin registration).
 *
 * src/approval-record-hook.ts — writes down every approval card eve renders, and what the
 * owner answered. Backs `services/box/sql/001_baseline.sql` via
 * `@lares/agent-kit/approval-ledger`.
 *
 * WHY THESE TWO EVENTS. eve 1.0 carries the whole ledger this hook needs, with no eve patch:
 * `interaction.opened` fires once per request for a person (`InteractionOpenedData`), and a
 * request with `kind: "approval"` is a tool-approval card; `interaction.settled` fires once it
 * ends, with an `outcome`. The tool name and input are not on the event: they are read from the
 * session view the hook receives (`./approval-events.ts`), which is exactly what
 * `payloadFingerprint` needs. `response.submitted` / `response.settled` also exist, but they say
 * who answered, not how the card ended, so this hook does not depend on them.
 *
 * WHO DECIDED. Only `accepted` (with the `approve` option) is an approval and only `declined` is
 * a person's refusal. `withdrawn` (the person typed instead of tapping), `interrupted` (the turn
 * was cancelled) and every other ending mean nobody decided: the ledger row is settled as
 * `ignored`, with `answered_via` saying so, and nothing may act on it afterwards.
 *
 * ONLY A TOOL APPROVAL IS A CARD. A question, sign-in or budget prompt is not recorded here at
 * all — this table is about approvals, not every human-input round trip.
 *
 * LEGACY RECORDING IS BEST-EFFORT. Bound console calls instead attach their pre-reserved
 * exact authority synchronously and propagate a failure; approving a strict row is exclusively
 * the awaited response authorizer's job. Legacy behavior below remains best-effort. eve turns a thrown hook into `turn.failed`
 * (the rule `agent/hooks/origin-taint.ts` states and obeys) — every handler below catches
 * everything and warns at most once per process, the same shape `agent/hooks/turn-capture.ts`
 * and `origin-taint.ts` already use. `getPool()` is called inside each handler, never at module
 * scope, so `eve build` (no secrets, no live Postgres) never touches it.
 */
import { attachExactApproval, settleExactInput } from "./approval-execution.js";
import { hasConsoleTurnAuthorityTag } from "./console-turn-authority.js";
import { getPool } from "./db.js";
import { payloadFingerprint, recordAnswer, recordAsk, type AskOutcome } from "./approval-ledger.js";
import { NOBODY_DECIDED, openedApproval, settledApproval } from "./approval-events.js";

// The role hooks that sit beside this one read cards the same way; the package exports this file.
export { openedApproval, settledApproval };

let warnedOnce = false;
function warn(where: string, err: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`approval-record-hook: ${where} failed (this and any further failures this process are swallowed; the turn is unaffected):`, err);
}

export interface ApprovalRecordDeps {
  personalRequested?: (request:{requestId:string;callId:string;input:unknown},ctx:unknown)=>Promise<void>;
  personalResolved?: (requestId:string,outcome:string,ctx:unknown)=>Promise<boolean>;
  record?: (a: { requestId: string; callId: string; agent: string; tool: string; payloadHash: string }) => void | Promise<void>;
  answer?: (a: { requestId: string; outcome: AskOutcome; answeredVia?: string }) => void | Promise<void>;
}

/**
 * Builds the handlers. Exported so the tests can drive them directly, without reaching into
 * eve's runtime or mocking `defineHook` — the shape `origin-taint.ts`'s `makeOriginTaint` and
 * `turn-capture.ts` already use.
 */
export function makeApprovalRecord(deps: ApprovalRecordDeps = {}) {
  const record =
    deps.record ??
    (async (a) => {
      await recordAsk(getPool(), a);
    });
  const answer =
    deps.answer ??
    (async (a) => {
      await recordAnswer(getPool(), a);
    });

  /** A card opened: write it down (or attach its reserved authority). */
  async function onInteractionOpened(event: unknown, ctx: unknown): Promise<void> {
    try {
      const card = openedApproval(event, ctx);
      if (card === undefined) return;
      const requestId = card.interactionId;
      const { callId, toolName } = card;
      const agent = typeof (ctx as { agent?: { name?: unknown } } | undefined)?.agent?.name === "string"
        ? (ctx as { agent: { name: string } }).agent.name
        : "unknown";
      if(toolName==='personal_mailbox_send'){
        if(!deps.personalRequested)throw new Error('Personal approval handler unavailable');
        await deps.personalRequested({requestId,callId,input:card.input},ctx);return;
      }
      if (hasConsoleTurnAuthorityTag(ctx)) {
        await attachExactApproval({requestId,callId,tool:toolName,input:card.input});
        return;
      }
      await record({
        requestId,
        callId,
        agent,
        tool: toolName,
        payloadHash: payloadFingerprint(toolName, card.input),
      });
    } catch (err) {
      if (hasConsoleTurnAuthorityTag(ctx)) throw err;
      warn("interaction.opened", err);
    }
  }

  /** A card ended: settle it. Only a person's Approve is `approved`; nobody-decided endings are `ignored`. */
  async function onInteractionSettled(event: unknown, ctx: unknown): Promise<void> {
    try {
      const settled = settledApproval(event, ctx);
      if (settled === undefined) return;
      const { interactionId: requestId, outcome } = settled;
      if(await deps.personalResolved?.(requestId,outcome,ctx))return;
      if (hasConsoleTurnAuthorityTag(ctx)) {
        await settleExactInput(requestId,outcome);
        return;
      }
      await answer({ requestId, outcome, ...(settled.decidedByPerson ? {} : { answeredVia: NOBODY_DECIDED }) });
    } catch (err) {
      if (hasConsoleTurnAuthorityTag(ctx)) throw err;
      warn("interaction.settled", err);
    }
  }

  return {
    "interaction.opened": onInteractionOpened,
    "interaction.settled": onInteractionSettled,
  };
}
