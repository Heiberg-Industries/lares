/**
 * agent/hooks/approval-record.ts — writes down every approval card eve renders, and what the
 * owner answered. The logic and its reasons live in `@lares/agent-kit/approval-record-hook`
 * (shared with the other roles); this file only registers it. Backs
 * `services/box/sql/001_baseline.sql` via `@lares/agent-kit/approval-ledger`.
 */
import { defineHook, type HookContext } from "eve/hooks";

import { makeApprovalRecord, openedApproval, settledApproval } from "@lares/agent-kit/approval-record-hook";

export { makeApprovalRecord };
export type { ApprovalRecordDeps } from "@lares/agent-kit/approval-record-hook";

import {personalSendInputRequested,personalSendInputResolved} from '../../lib/personal-send-approval.js';
import { getPool } from "@lares/agent-kit/db";
import { approverFrom, assertApprover, takeNativeAnswerer } from "../../lib/approvals.js";
import { noteApprovalCardTurn } from "../../lib/approval-card-turns.js";
import { settleAcceptedAnswer } from "@lares/agent-kit/private-console-resume";
import { applyRouteProposalDecline, recordRouteApprovalLink, routeApprovalLinkAudience } from "../../lib/route-decline.js";
import { withCurrentNativeContinuity } from "../../lib/conversation-continuity.js";
const live = makeApprovalRecord({personalRequested:(r,c)=>personalSendInputRequested(r,c as never),personalResolved:(r,o,c)=>personalSendInputResolved(r,o,c as never)});

function currentAppAttributes(ctx: HookContext): Record<string, unknown> | undefined {
  const auth = ctx?.session?.auth?.current;
  if (auth?.authenticator !== "app" || !auth.attributes || typeof auth.attributes !== "object") return undefined;
  return auth.attributes as Record<string, unknown>;
}

export async function linkScheduledRouteRequests(db: import("pg").Pool, event: unknown, ctx: HookContext): Promise<void> {
  const attrs = currentAppAttributes(ctx);
  const sessionId = ctx?.session?.id;
  const turnSequence = ctx?.session?.turn?.sequence;
  if (!attrs || attrs.lane !== "track-routing" || typeof sessionId !== "string" || !sessionId.trim() ||
      !Number.isSafeInteger(turnSequence) || turnSequence < 0) return;
  const memberId = attrs.lares_continuity_member_id;
  const address = attrs.lares_continuity_address;
  const revision = attrs.lares_continuity_revision;
  if (typeof memberId !== "string" || typeof address !== "string" || typeof revision !== "string" ||
      !/^[1-9]\d*$/.test(revision)) return;
  const door = address.startsWith("slack-user:") ? "slack" : address.startsWith("telegram-user:") ? "telegram" : undefined;
  const accessRevision = Number(revision);
  if (!door || !Number.isSafeInteger(accessRevision)) return;
  const card = openedApproval(event, ctx);
  if (!card || (card.toolName !== "track_add_item" && card.toolName !== "track_move_item")) return;
  await recordRouteApprovalLink(db, {
    requestId: card.interactionId, sessionId, turnSequence, callId: card.callId, tool: card.toolName, input: card.input,
    memberId, door, address, accessRevision,
  });
}

async function applyScheduledRouteDeclines(event: unknown, ctx: HookContext): Promise<void> {
  // Only a person's Deny is a veto. A card nobody answered (withdrawn, interrupted) or an invalid
  // answer creates neither a veto nor a learned fact.
  const settled = settledApproval(event, ctx);
  if (!settled || settled.outcome !== "cancelled" || !settled.decidedByPerson) return;
  const requestId = settled.interactionId;
  const audience = await routeApprovalLinkAudience(getPool(), requestId);
  if (!audience) return;
  // eve 1.0: `session.auth.current` is the scheduled job's app identity, not the person who tapped
  // Deny. The owner's answer is the one the native response policy accepted for this card.
  const principal = approverFrom({ current: takeNativeAnswerer(requestId) });
  assertApprover(principal);
  const auth = {
    authenticator: principal.authenticator,
    attributes: { user_id: principal.userId },
  };
  await withCurrentNativeContinuity(audience.door, auth, audience.identity,
    (db, identity) => applyRouteProposalDecline(db, requestId, identity));
}

/** The turn a card belongs to: the event's own scope, else the hook's current turn (the same turn
 *  while it runs; packages/agent-kit/tests/answer-turn-position.test.ts). */
/** Whether an opened interaction is an approval card, from the event alone: unlike
 *  `openedApproval`, it does not need the call to be readable, so an unreadable call still marks. */
function asksApproval(event: unknown): boolean {
  return (event as { data?: { request?: { kind?: unknown } } } | undefined)?.data?.request?.kind === "approval";
}
function cardTurnOf(event: unknown, ctx: HookContext): unknown {
  return (event as { scope?: { turnId?: unknown } } | undefined)?.scope?.turnId ?? ctx?.session?.turn?.id;
}

let routeDeclineWarned = false;
function warnRouteDecline(error: unknown): void {
  if (routeDeclineWarned) return;
  routeDeclineWarned = true;
  console.warn("approval-record-hook: track proposal decline link unavailable; approval handling remains unchanged",
    error instanceof Error ? error.message : "unknown error");
}

export default defineHook({
  events: {
    "interaction.opened": async (event: unknown, ctx: HookContext) => {
      // A turn that asks a card carries no new human instruction from here on (durable; throws,
      // failing the turn, when it cannot be recorded).
      if (asksApproval(event)) noteApprovalCardTurn(cardTurnOf(event, ctx));
      await live["interaction.opened"](event, ctx);
      try { await linkScheduledRouteRequests(getPool(), event, ctx); } catch (error) { warnRouteDecline(error); }
    },
    "interaction.settled": async (event: unknown, ctx: HookContext) => {
      const settled = settledApproval(event, ctx);
      if (settled) {
        // Marked again on settle; a no-op when the opening hook already marked the turn.
        noteApprovalCardTurn(cardTurnOf(event, ctx));
        // The turn continues only from the answer eve applied, never from an earlier one.
        settleAcceptedAnswer(settled.interactionId, ctx?.session?.id,
          settled.outcome === "approved" ? "approve" : settled.outcome === "cancelled" && settled.decidedByPerson ? "deny" : undefined);
      }
      await live["interaction.settled"](event, ctx);
      try { await applyScheduledRouteDeclines(event, ctx); } catch (error) { warnRouteDecline(error); }
    },
  },
});
