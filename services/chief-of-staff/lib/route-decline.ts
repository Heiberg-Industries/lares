import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { payloadFingerprint } from "@lares/agent-kit/approval-ledger";
import type { ContinuityIdentity } from "./conversation-continuity.js";
import { PROPOSAL_COOLDOWN_DAYS } from "./route-engine.js";

const common = {
  home: z.string().min(1).max(256),
  trackId: z.string().min(1).max(63),
  step: z.string().min(1).max(80),
  note: z.string().min(1).max(500),
  sourceSignal: z.string().min(1).max(200),
};
const addInput = z.strictObject({
  ...common,
  who: z.strictObject({ personId: z.string().min(1).optional(), organisationId: z.string().min(1).optional() })
    .refine((v) => !!v.personId || !!v.organisationId),
});
const moveInput = z.strictObject({ ...common, itemId: z.string().min(1).max(63) });

export interface RouteApprovalRequest {
  requestId: string;
  sessionId: string;
  turnSequence: number;
  callId: string;
  tool: string;
  input: unknown;
  memberId: string;
  door: "slack" | "telegram";
  address: string;
  accessRevision: number;
}

export interface RouteApprovalLinkAudience {
  door: "slack" | "telegram";
  identity: ContinuityIdentity;
}

export interface PendingRouteDeclineQuestion {
  requestId: string; door: "slack" | "telegram"; identity: ContinuityIdentity;
  personId: string; home: string; trackId: string;
}

export async function listPendingRouteDeclineQuestions(db: Pool): Promise<PendingRouteDeclineQuestion[]> {
  const { rows } = await db.query(`SELECT request_id,door,member_id,audience_address,audience_access_revision,
      contact_person_id,home,track_id FROM route_proposal_approval_links
    WHERE question_pending AND question_claimed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM route_proposal_approval_links open
        WHERE open.member_id=route_proposal_approval_links.member_id
          AND open.audience_address=route_proposal_approval_links.audience_address
          AND open.audience_access_revision=route_proposal_approval_links.audience_access_revision
          AND open.question_sent_at > clock_timestamp() - ($1 * interval '1 day')
          AND open.answered_at IS NULL)
    ORDER BY declined_at,request_id LIMIT 25`, [PROPOSAL_COOLDOWN_DAYS]);
  return rows.flatMap((row) => {
    const accessRevision = Number(row.audience_access_revision);
    const personId = row.contact_person_id;
    if (!['slack','telegram'].includes(row.door) || !Number.isSafeInteger(accessRevision) || accessRevision <= 0 ||
        typeof row.member_id !== 'string' || typeof row.audience_address !== 'string' ||
        typeof personId !== 'string' || typeof row.home !== 'string' || typeof row.track_id !== 'string') return [];
    return [{ requestId: row.request_id, door: row.door,
      identity: { memberId: row.member_id, address: row.audience_address, accessRevision },
      personId, home: row.home, trackId: row.track_id }];
  });
}

/** The one-shot claim is after current authority is checked and immediately before delivery. */
export async function claimRouteDeclineQuestion(
  db: Pool,
  question: PendingRouteDeclineQuestion,
): Promise<boolean> {
  const { rowCount } = await db.query(`UPDATE route_proposal_approval_links
    SET question_claimed_at=clock_timestamp(),question_pending=false
    WHERE request_id=$1 AND question_pending AND question_claimed_at IS NULL
      AND member_id=$2 AND audience_address=$3 AND audience_access_revision=$4`,
  [question.requestId, question.identity.memberId, question.identity.address, question.identity.accessRevision]);
  return rowCount === 1;
}

export async function markRouteDeclineQuestionSent(db: Pool, requestId: string, replyAnchor: string): Promise<void> {
  if (!replyAnchor.trim() || replyAnchor.length > 256) return;
  await db.query(`UPDATE route_proposal_approval_links
    SET question_sent_at=clock_timestamp(),question_reply_anchor=$2
    WHERE request_id=$1 AND question_claimed_at IS NOT NULL AND question_sent_at IS NULL`, [requestId, replyAnchor]);
}

export async function routeDeclineAnswerScope(
  db: PoolClient, requestId: string, identity: ContinuityIdentity, replyAnchor: string,
): Promise<{ personId: string; home: string; trackId: string } | undefined> {
  const { rows } = await db.query(`SELECT contact_person_id,home,track_id FROM route_proposal_approval_links
    WHERE request_id=$1 AND declined_at IS NOT NULL AND question_claimed_at IS NOT NULL AND question_sent_at IS NOT NULL
      AND answered_at IS NULL
      AND member_id=$2 AND audience_address=$3 AND audience_access_revision=$4
      AND question_pending=false AND question_reply_anchor=$5
      AND question_sent_at > clock_timestamp() - ($6 * interval '1 day')`,
  [requestId, identity.memberId, identity.address, identity.accessRevision, replyAnchor, PROPOSAL_COOLDOWN_DAYS]);
  if (rows.length !== 1 || typeof rows[0]!.contact_person_id !== "string" ||
      typeof rows[0]!.home !== "string" || typeof rows[0]!.track_id !== "string") return undefined;
  return { personId: rows[0]!.contact_person_id, home: rows[0]!.home, trackId: rows[0]!.track_id };
}

/** Resolve a fresh human reply only through the exact native message/thread anchor it answers.
 * The caller separately checks the current member, grant, address, and human-turn authority. */
export async function routeDeclineAnswerForReply(
  db: Pool, identity: ContinuityIdentity, door: "slack" | "telegram", replyAnchor: string | undefined,
): Promise<{ kind: "none" } | { kind: "ambiguous" } | { kind: "stale" } | {
  kind: "match"; requestId: string; door: "slack" | "telegram"; identity: ContinuityIdentity;
}> {
  if (!replyAnchor?.trim()) return { kind: "none" };
  const { rows } = await db.query(`SELECT request_id,door,member_id,audience_address,audience_access_revision
    FROM route_proposal_approval_links
    WHERE door=$1 AND member_id=$2 AND audience_address=$3 AND audience_access_revision=$4
      AND declined_at IS NOT NULL AND question_claimed_at IS NOT NULL
      AND question_sent_at > clock_timestamp() - ($6 * interval '1 day')
      AND question_reply_anchor=$5 AND answered_at IS NULL AND question_pending=false
    ORDER BY request_id LIMIT 2`, [door, identity.memberId, identity.address, identity.accessRevision,
      replyAnchor, PROPOSAL_COOLDOWN_DAYS]);
  if (rows.length === 0) {
    const expired = await db.query(`SELECT 1 FROM route_proposal_approval_links
      WHERE door=$1 AND member_id=$2 AND audience_address=$3 AND audience_access_revision=$4
        AND declined_at IS NOT NULL AND question_claimed_at IS NOT NULL AND question_reply_anchor=$5
        AND question_sent_at <= clock_timestamp() - ($6 * interval '1 day')
        AND answered_at IS NULL AND question_pending=false LIMIT 1`,
    [door, identity.memberId, identity.address, identity.accessRevision, replyAnchor, PROPOSAL_COOLDOWN_DAYS]);
    return expired.rows.length ? { kind: "stale" } : { kind: "none" };
  }
  if (rows.length !== 1 || !["slack", "telegram"].includes(rows[0]!.door) ||
      typeof rows[0]!.request_id !== "string" || typeof rows[0]!.member_id !== "string" ||
      typeof rows[0]!.audience_address !== "string") return { kind: "ambiguous" };
  const accessRevision = Number(rows[0]!.audience_access_revision);
  if (!Number.isSafeInteger(accessRevision) || accessRevision <= 0) return { kind: "ambiguous" };
  return { kind: "match", requestId: rows[0]!.request_id, door: rows[0]!.door,
    identity: { memberId: rows[0]!.member_id, address: rows[0]!.audience_address, accessRevision } };
}

/** Return only the stored audience fence needed to re-check a later click. */
export async function routeApprovalLinkAudience(db: Pool, requestId: string): Promise<RouteApprovalLinkAudience | undefined> {
  const { rows } = await db.query(`SELECT door,member_id,audience_address,
      audience_access_revision FROM route_proposal_approval_links WHERE request_id=$1`, [requestId]);
  if (rows.length !== 1 || !["slack", "telegram"].includes(rows[0]!.door) ||
      typeof rows[0]!.member_id !== "string" || typeof rows[0]!.audience_address !== "string") return undefined;
  const accessRevision = Number(rows[0]!.audience_access_revision);
  if (!Number.isSafeInteger(accessRevision) || accessRevision <= 0) return undefined;
  return { door: rows[0]!.door, identity: { memberId: rows[0]!.member_id, address: rows[0]!.audience_address, accessRevision } };
}

/** Parse only the two actions that the scheduled router can propose. A quoted or model-written
 * sourceSignal is data; it becomes useful only when the stored approval hash and exact route row
 * agree with the same validated payload. */
export function routeApprovalIdentity(tool: string, input: unknown): {
  personId: string | null; opportunityId: string | null; home: string; trackId: string;
  proposedStage: string; signalRef: string;
} | undefined {
  if (tool === "track_add_item") {
    const p = addInput.safeParse(input);
    if (!p.success || !p.data.who.personId || p.data.who.organisationId) return undefined;
    return { personId: p.data.who.personId, opportunityId: null, home: p.data.home, trackId: p.data.trackId,
      proposedStage: p.data.step, signalRef: p.data.sourceSignal };
  }
  if (tool === "track_move_item") {
    const p = moveInput.safeParse(input);
    if (!p.success) return undefined;
    return { personId: null, opportunityId: p.data.itemId, home: p.data.home, trackId: p.data.trackId,
      proposedStage: p.data.step, signalRef: p.data.sourceSignal };
  }
  return undefined;
}

/** Persist the exact validated card identity. Approval row and link are checked together; a
 * repeated request event is accepted only when every bound field is identical. */
export async function recordRouteApprovalLink(db: Pool, request: RouteApprovalRequest): Promise<boolean> {
  const identity = routeApprovalIdentity(request.tool, request.input);
  if (!identity || !request.requestId || !request.sessionId || !Number.isSafeInteger(request.turnSequence) || request.turnSequence < 0 || !request.callId || !request.memberId || !request.address ||
      !Number.isSafeInteger(request.accessRevision) || request.accessRevision <= 0) return false;
  const hash = payloadFingerprint(request.tool, request.input);
  const client = await db.connect();
  try {
  await client.query("BEGIN");
  const { rows: asks } = await client.query<{ call_id: string; tool: string; payload_hash: string; outcome: string | null }>(
    `SELECT call_id, tool, payload_hash, outcome FROM approval_asks WHERE request_id=$1`, [request.requestId]);
  if (asks.length !== 1 || asks[0]!.call_id !== request.callId || asks[0]!.tool !== request.tool ||
      asks[0]!.payload_hash !== hash || asks[0]!.outcome !== null) { await client.query("ROLLBACK"); return false; }
  const route = await client.query(`SELECT id,person_id,status FROM route_proposals WHERE
      (($1::text IS NOT NULL AND person_id=$1 AND opportunity_id IS NULL)
       OR ($1::text IS NULL AND opportunity_id=$2))
      AND home=$3 AND track_id=$4 AND proposed_stage=$5 AND signal_ref=$6 AND status IN ('pending','proposed')
      FOR UPDATE`, [identity.personId,identity.opportunityId,identity.home,identity.trackId,identity.proposedStage,identity.signalRef]);
  if (route.rows.length !== 1 || typeof route.rows[0]!.person_id !== "string") { await client.query("ROLLBACK"); return false; }
  await client.query(`INSERT INTO route_proposal_approval_links
    (request_id,session_id,request_turn_sequence,member_id,door,audience_address,audience_access_revision,tool_name,call_id,payload_hash,
     person_id,contact_person_id,opportunity_id,home,track_id,proposed_stage,signal_ref)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (request_id) DO NOTHING`,
  [request.requestId,request.sessionId,request.turnSequence,request.memberId,request.door,request.address,request.accessRevision,request.tool,request.callId,hash,
    identity.personId,route.rows[0]!.person_id,identity.opportunityId,identity.home,identity.trackId,identity.proposedStage,identity.signalRef]);
  const { rows } = await client.query(`SELECT 1 FROM route_proposal_approval_links WHERE request_id=$1 AND session_id=$2 AND request_turn_sequence=$3 AND
    member_id=$4 AND door=$5 AND audience_address=$6 AND audience_access_revision=$7 AND tool_name=$8 AND
    call_id=$9 AND payload_hash=$10 AND person_id IS NOT DISTINCT FROM $11 AND contact_person_id IS NOT DISTINCT FROM $12 AND
    opportunity_id IS NOT DISTINCT FROM $13 AND home=$14 AND track_id=$15 AND proposed_stage=$16 AND signal_ref=$17`,
  [request.requestId,request.sessionId,request.turnSequence,request.memberId,request.door,request.address,request.accessRevision,request.tool,request.callId,hash,
    identity.personId,route.rows[0]!.person_id,identity.opportunityId,identity.home,identity.trackId,identity.proposedStage,identity.signalRef]);
  if (rows.length !== 1) { await client.query("ROLLBACK"); return false; }
  if (route.rows[0]!.status === "pending") {
    const promoted = await client.query(`UPDATE route_proposals SET status='proposed' WHERE id=$1 AND status='pending'`, [route.rows[0]!.id]);
    if (promoted.rowCount !== 1) { await client.query("ROLLBACK"); return false; }
  }
  await client.query("COMMIT");
  return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** A decline changes exactly one still-proposed row. The caller runs this in the current,
 * locked member/grant transaction, so duplicate events, stale audiences, and cross-member taps
 * cannot own another question attempt. */
export async function applyRouteProposalDecline(
  db: PoolClient,
  requestId: string,
  identity: ContinuityIdentity,
): Promise<boolean> {
  const { rows: links } = await db.query(`SELECT l.*, a.outcome, a.call_id AS stored_call_id,
      a.tool AS stored_tool, a.payload_hash AS stored_payload_hash
    FROM route_proposal_approval_links l JOIN approval_asks a USING (request_id)
    WHERE l.request_id=$1 AND l.declined_at IS NULL FOR UPDATE OF l,a`, [requestId]);
  if (links.length !== 1) return false;
  const link = links[0]!;
  if (link.outcome !== "cancelled" || link.stored_call_id !== link.call_id || link.stored_tool !== link.tool_name ||
      link.stored_payload_hash !== link.payload_hash || link.member_id !== identity.memberId ||
      link.audience_address !== identity.address || Number(link.audience_access_revision) !== identity.accessRevision) return false;

  const exactRoute = await db.query(`SELECT id,person_id FROM route_proposals
    WHERE (($1::text IS NOT NULL AND person_id=$1 AND opportunity_id IS NULL)
        OR ($1::text IS NULL AND opportunity_id=$2))
      AND home=$3 AND track_id=$4 AND proposed_stage=$5 AND signal_ref=$6 AND status='proposed'
    FOR UPDATE`, [link.person_id,link.opportunity_id,link.home,link.track_id,link.proposed_stage,link.signal_ref]);
  // Ambiguous legacy duplicates fail closed. No newest-row or person-only fallback.
  if (exactRoute.rows.length !== 1 || typeof exactRoute.rows[0]!.person_id !== "string") return false;
  const updated = await db.query(`UPDATE route_proposals SET status='vetoed' WHERE id=$1 AND status='proposed'`, [exactRoute.rows[0]!.id]);
  if (updated.rowCount !== 1) return false;
  const marked = await db.query(`UPDATE route_proposal_approval_links
    SET declined_at=clock_timestamp(),question_pending=true,contact_person_id=$2
    WHERE request_id=$1 AND declined_at IS NULL AND $2::text IS NOT NULL`, [requestId, exactRoute.rows[0]!.person_id]);
  return marked.rowCount === 1;
}
