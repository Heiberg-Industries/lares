/**
 * agent/hooks/approval-record.ts — writes down every approval card eve renders, and what the
 * owner answered. The logic and its reasons live in `@lares/agent-kit/approval-record-hook`
 * (shared with the other roles); this file only registers it. Backs
 * `services/box/sql/001_baseline.sql` via `@lares/agent-kit/approval-ledger`.
 */
import { defineHook, type HookContext } from "eve/hooks";

import { makeApprovalRecord } from "@lares/agent-kit/approval-record-hook";

export { makeApprovalRecord };
export type { ApprovalRecordDeps } from "@lares/agent-kit/approval-record-hook";

import {personalSendInputRequested,personalSendInputResolved} from '../../lib/personal-send-approval.js';
import { getPool } from "@lares/agent-kit/db";
import { approverFrom, assertApprover } from "../../lib/approvals.js";
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
  const requests = (event as { data?: { requests?: unknown } } | undefined)?.data?.requests;
  if (!Array.isArray(requests)) return;
  for (const raw of requests) {
    if (!raw || typeof raw !== "object") continue;
    const req = raw as { kind?: unknown; requestId?: unknown; action?: { kind?: unknown; callId?: unknown; toolName?: unknown; input?: unknown } };
    if (req.kind !== "tool-approval" || req.action?.kind !== "tool-call" ||
        typeof req.requestId !== "string" || typeof req.action.callId !== "string" || typeof req.action.toolName !== "string") continue;
    if (req.action.toolName !== "track_add_item" && req.action.toolName !== "track_move_item") continue;
    await recordRouteApprovalLink(db, {
      requestId: req.requestId, sessionId, turnSequence, callId: req.action.callId, tool: req.action.toolName, input: req.action.input,
      memberId, door, address, accessRevision,
    });
  }
}

async function applyScheduledRouteDeclines(event: unknown, ctx: HookContext): Promise<void> {
  const resolutions = (event as { data?: { resolutions?: unknown } } | undefined)?.data?.resolutions;
  if (!Array.isArray(resolutions)) return;
  for (const raw of resolutions) {
    if (!raw || typeof raw !== "object") continue;
    const resolution = raw as { kind?: unknown; requestId?: unknown; outcome?: unknown };
    // An ignored question or an invalid answer creates neither a veto nor a learned fact.
    if (resolution.kind !== "tool-approval" || resolution.outcome !== "denied" || typeof resolution.requestId !== "string") continue;
    const audience = await routeApprovalLinkAudience(getPool(), resolution.requestId);
    if (!audience) continue;
    const principal = approverFrom(ctx?.session?.auth);
    assertApprover(principal);
    const auth = {
      authenticator: principal.authenticator,
      attributes: { user_id: principal.userId },
    };
    await withCurrentNativeContinuity(audience.door, auth, audience.identity,
      (db, identity) => applyRouteProposalDecline(db, resolution.requestId as string, identity));
  }
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
    "input.requested": async (event: unknown, ctx: HookContext) => {
      await live["input.requested"](event, ctx);
      try { await linkScheduledRouteRequests(getPool(), event, ctx); } catch (error) { warnRouteDecline(error); }
    },
    "input.resolved": async (event: unknown, ctx: HookContext) => {
      await live["input.resolved"](event, ctx);
      try { await applyScheduledRouteDeclines(event, ctx); } catch (error) { warnRouteDecline(error); }
    },
  },
});
