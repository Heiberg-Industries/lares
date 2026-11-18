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
 * APPROVALS AND QUESTIONS ARE CARDS. A sign-in or budget prompt is not recorded here at all. A
 * question is written as a row of its own kind (`kind = 'question'`), so the card layer can tell a
 * late tap on one from a tap on a card nobody knows. Every card also gets the door it was raised on
 * and the person it was put to (`recordCardOrigin`); where it was posted, and whether it was shown
 * whole, the door writes once it has posted (`recordCardPosted`).
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
import { DoorAttachError, attachDoorExactApproval } from "./door-exact-approval.js";
import { hasConsoleTurnAuthorityTag } from "./console-turn-authority.js";
import { getPool } from "./db.js";
import {
  applyPostedCard, payloadFingerprint, recordAnswer, recordAsk, recordCardOrigin, recordQuestion, recordQuestionEnd,
  type AskOutcome,
} from "./approval-ledger.js";
import { NOBODY_DECIDED, openedApproval, openedQuestion, settledApproval, settledQuestion } from "./approval-events.js";
import { doorRowOf } from "./door-kinds.js";
import { CARD_DOORS } from "./card-layer.js";

// The role hooks that sit beside this one read cards the same way; the package exports this file.
export { openedApproval, settledApproval };

function agentNameOf(ctx: unknown): string {
  const name = (ctx as { agent?: { name?: unknown } } | undefined)?.agent?.name;
  return typeof name === "string" ? name : "unknown";
}

let warnedOnce = false;
function warn(where: string, err: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`approval-record-hook: ${where} failed (this and any further failures this process are swallowed; the turn is unaffected):`, err);
}

/** The door a card was raised on and the person it was put to, read from the conversation's
 *  initiator (who started it, never who answered). A web chat card has no platform id: its member
 *  is on the row already. A card with no door initiator (a scheduled job) has neither. */
export function cardOriginOf(ctx: unknown): { door: string; putTo?: string; shownWhole?: boolean } | undefined {
  // A bound console conversation is web chat. Whether its cards are shown whole is the door's row.
  if (hasConsoleTurnAuthorityTag(ctx)) return { door: "console", ...(CARD_DOORS["console"]?.showsLongCardWhole ? { shownWhole: true } : {}) };
  const session = (ctx as { session?: { initiator?: unknown; auth?: { initiator?: unknown } | null } } | undefined)?.session;
  const initiator = session?.auth?.initiator ?? session?.initiator;
  const row = doorRowOf(initiator);
  if (row === undefined) return undefined;
  const sender = row.sender(initiator as never);
  return typeof sender === "string" && sender !== "" ? { door: row.door, putTo: sender } : { door: row.door };
}

export interface ApprovalRecordDeps {
  personalRequested?: (request:{requestId:string;callId:string;input:unknown},ctx:unknown)=>Promise<void>;
  personalResolved?: (requestId:string,outcome:string,ctx:unknown)=>Promise<boolean>;
  record?: (a: { requestId: string; callId: string; agent: string; tool: string; payloadHash: string }) => void | Promise<void>;
  answer?: (a: { requestId: string; outcome: AskOutcome; answeredVia?: string }) => void | Promise<void>;
  posted?: (requestId: string) => void | Promise<void>;
  origin?: (a: { requestId: string; door: string; putTo?: string; shownWhole?: boolean }) => void | Promise<void>;
  question?: (a: { requestId: string; agent: string; prompt: string; door?: string; putTo?: string }) => void | Promise<void>;
  questionEnd?: (a: { requestId: string; answered: boolean }) => void | Promise<void>;
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

  // A card with no door initiator (a scheduled job's) gets no origin, but the door may still have posted it first: its address
  // and shown-whole mark are written once the row exists, whatever the origin.
  const posted = deps.posted ?? (deps.record || deps.origin ? async () => {} : async (requestId: string) => { await applyPostedCard(getPool(), requestId); });
  const origin =
    deps.origin ??
    (async (a) => {
      await recordCardOrigin(getPool(), a);
      // The door may have posted this card before its row existed: write that address now.
      await applyPostedCard(getPool(), a.requestId);
    });
  const question =
    deps.question ??
    (async (a) => {
      await recordQuestion(getPool(), a);
      await applyPostedCard(getPool(), a.requestId);
    });
  const questionEnd =
    deps.questionEnd ??
    (async (a) => {
      await recordQuestionEnd(getPool(), a);
    });

  /** A card opened: write it down (or attach its reserved authority). */
  async function onInteractionOpened(event: unknown, ctx: unknown): Promise<void> {
    try {
      const card = openedApproval(event, ctx);
      if (card === undefined) {
        const asked = openedQuestion(event);
        if (asked === undefined) return;
        const from = cardOriginOf(ctx);
        await question({ requestId: asked.interactionId, agent: agentNameOf(ctx), prompt: asked.prompt, ...from });
        return;
      }
      const requestId = card.interactionId;
      const { callId, toolName } = card;
      const agent = agentNameOf(ctx);
      if(toolName==='personal_mailbox_send'){
        if(!deps.personalRequested)throw new Error('Personal approval handler unavailable');
        await deps.personalRequested({requestId,callId,input:card.input},ctx);return;
      }
      const from = cardOriginOf(ctx);
      if (hasConsoleTurnAuthorityTag(ctx)) {
        await attachExactApproval({requestId,callId,tool:toolName,input:card.input});
        if (from) await origin({ requestId, ...from });
        await posted(requestId);
        return;
      }
      // A card on a door whose call was reserved first (a note save) gets its request id the way a console card does;
      // without it nothing could ever approve it. Any other card is written down as it always was.
      if (!deps.record && await attachDoorExactApproval({ requestId, callId, tool: toolName, input: card.input })) {
        if (from) await origin({ requestId, ...from });
        await posted(requestId);
        return;
      }
      await record({
        requestId,
        callId,
        agent,
        tool: toolName,
        payloadHash: payloadFingerprint(toolName, card.input),
      });
      if (from) await origin({ requestId, ...from });
        await posted(requestId);
    } catch (err) {
      if (hasConsoleTurnAuthorityTag(ctx) || err instanceof DoorAttachError) throw err;
      warn("interaction.opened", err);
    }
  }

  /** A card ended: settle it. Only a person's Approve is `approved`; nobody-decided endings are `ignored`. */
  async function onInteractionSettled(event: unknown, ctx: unknown): Promise<void> {
    try {
      const settled = settledApproval(event, ctx);
      if (settled === undefined) {
        const ended = settledQuestion(event, ctx);
        if (ended !== undefined) await questionEnd({ requestId: ended.interactionId, answered: ended.answered });
        return;
      }
      const { interactionId: requestId, outcome } = settled;
      if(await deps.personalResolved?.(requestId,outcome,ctx))return;
      if (hasConsoleTurnAuthorityTag(ctx)) {
        await settleExactInput(requestId,outcome);
        return;
      }
      // A card with a reservation (a door's exact approval) is settled only by the exact record; the legacy writer skips it.
      if (!deps.answer) await settleExactInput(requestId, outcome);
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
