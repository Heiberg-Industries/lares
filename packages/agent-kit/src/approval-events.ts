/**
 * src/approval-events.ts — reads an approval card out of eve's `interaction.opened` /
 * `interaction.settled` events, for the hooks that record and withdraw cards.
 *
 * WHY THIS FILE EXISTS. On eve 0.60 one event (`input.requested`) carried the card, the tool name
 * and the tool input together. On eve 1.0 the event only names the call (`subject.callId`); the
 * tool name and input live in the session's view (`ctx.view`), which every hook receives as of the
 * commit the event is in. So each hook needs the same three steps: is this an approval card, which
 * call is it about, and how did it end. They live here once.
 *
 * WHO DECIDED. An interaction ends with an `outcome`. `accepted` and `declined` mean a person
 * answered. `withdrawn` (the person typed instead of tapping), `interrupted` (the turn was
 * cancelled), `abandoned`, `expired` and `failed` mean NOBODY decided, and are never an approval.
 * `accepted` only approves when the chosen option is `approve`; anything else is refused as
 * `invalid`. An outcome this file does not know is treated as "nobody decided" — the safe side.
 *
 * NEVER THROWS. A hook that throws fails the turn, so every read here is defensive and answers
 * `undefined` for anything it cannot read.
 */
import { APPROVE_OPTION_ID, call as callOf, interaction as interactionOf } from "eve/events";

import type { AskOutcome } from "./approval-ledger.js";

/** An approval card as a hook sees it when it opens. */
export interface OpenedApproval {
  interactionId: string;
  callId: string;
  toolName: string;
  input: unknown;
}

/** How a card ended, in the ledger's words. */
export interface SettledApproval {
  interactionId: string;
  /** What the ledger records. */
  outcome: AskOutcome;
  /** True when a person decided (approved or denied). False: nobody decided. */
  decidedByPerson: boolean;
  /** The tool the card was about, when the view still knows it. */
  toolName?: string;
}

const asString = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** The session view a hook context carries, or undefined. */
function viewOf(ctx: unknown): never | undefined {
  return (ctx as { view?: never } | null | undefined)?.view;
}

/** The call an interaction asks about, from the view. Never throws. */
export function askedCallOf(
  ctx: unknown,
  interactionId: string,
  callId?: string,
): { callId: string; name: string; input: unknown } | undefined {
  const view = viewOf(ctx);
  if (view === undefined) return undefined;
  try {
    const asked = interactionOf(view, interactionId)?.call;
    if (asked !== undefined && asString(asked.name) !== undefined) {
      return { callId: asked.callId, name: asked.name, input: asked.input };
    }
  } catch {
    /* fall through to the call table */
  }
  try {
    const id = callId ?? undefined;
    if (id === undefined) return undefined;
    const row = callOf(view, id);
    if (row !== undefined && asString(row.name) !== undefined) return { callId: id, name: row.name, input: row.input };
  } catch {
    /* unreadable: nothing to say */
  }
  return undefined;
}

/**
 * The approval card an `interaction.opened` event carries, or undefined when it is not an approval
 * (a question, a sign-in, a budget prompt) or the call it asks about cannot be read.
 */
export function openedApproval(event: unknown, ctx: unknown): OpenedApproval | undefined {
  try {
    const data = asRecord(asRecord(event)?.["data"]);
    if (data === undefined) return undefined;
    const request = asRecord(data["request"]);
    if (request?.["kind"] !== "approval") return undefined;
    const interactionId = asString(data["interactionId"]);
    const callId = asString(asRecord(data["subject"])?.["callId"]);
    if (interactionId === undefined || callId === undefined) return undefined;
    const asked = askedCallOf(ctx, interactionId, callId);
    if (asked === undefined) return undefined;
    return { interactionId, callId, toolName: asked.name, input: asked.input };
  } catch {
    return undefined;
  }
}

/**
 * How an `interaction.settled` event ended, mapped onto the ledger's outcomes, or undefined when
 * the interaction is not an approval card.
 *
 *   accepted + the `approve` option   approved             a person approved
 *   accepted + any other option       invalid              fail closed
 *   declined                          cancelled            a person denied
 *   invalid                           invalid              eve refused the answer
 *   withdrawn, interrupted, anything  ignored              NOBODY decided; never an approval
 *     else
 */
export function settledApproval(event: unknown, ctx: unknown): SettledApproval | undefined {
  try {
    const data = asRecord(asRecord(event)?.["data"]);
    if (data === undefined) return undefined;
    const interactionId = asString(data["interactionId"]);
    const result = asString(data["outcome"]);
    if (interactionId === undefined || result === undefined) return undefined;

    // The settled event does not say what kind of interaction it was; the view does. A view that
    // knows the interaction and says it is not an approval is a question or a sign-in: skip it.
    let toolName: string | undefined;
    const view = viewOf(ctx);
    if (view !== undefined) {
      try {
        const row = interactionOf(view, interactionId);
        if (row !== undefined && row.request.kind !== "approval") return undefined;
        toolName = asString(row?.call?.name);
      } catch {
        /* unreadable: treat as an approval card, which only ever writes a refusal or a settle */
      }
    }

    const optionId = asString(asRecord(data["response"])?.["optionId"]);
    if (result === "accepted") {
      return optionId === APPROVE_OPTION_ID
        ? { interactionId, outcome: "approved", decidedByPerson: true, ...(toolName !== undefined && { toolName }) }
        : { interactionId, outcome: "invalid", decidedByPerson: false, ...(toolName !== undefined && { toolName }) };
    }
    if (result === "declined") {
      return { interactionId, outcome: "cancelled", decidedByPerson: true, ...(toolName !== undefined && { toolName }) };
    }
    if (result === "invalid") {
      return { interactionId, outcome: "invalid", decidedByPerson: false, ...(toolName !== undefined && { toolName }) };
    }
    // withdrawn, interrupted, abandoned, expired, failed, and anything a newer eve adds.
    return { interactionId, outcome: "ignored", decidedByPerson: false, ...(toolName !== undefined && { toolName }) };
  } catch {
    return undefined;
  }
}

/** The `answered_via` text the ledger gets when nobody decided. */
export const NOBODY_DECIDED = "nobody-decided";
