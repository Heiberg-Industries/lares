/**
 * src/approval-supersede.ts — when a redrafted proposal makes an older, unanswered approval card
 * stale, which cards to withdraw. Pure: no database, no network.
 *
 * WHY. eve (0.60.1) keeps an unanswered approval card live while a later message runs an ordinary
 * turn, and it never withdraws an older card when a newer one for the same tool arrives
 * (`packages/board-evals/proofs/pending-reply-2026-10-19.md`, (a) and (d)). A reply that changes a
 * draft therefore leaves the old card approvable, and approving it sends the OLD words. This module
 * decides which old cards the new one replaces; the hook that calls it settles them.
 *
 * THE RULE. An older open card is replaced by a new one only when ALL of these hold:
 *   1. same session (the caller only offers this session's open cards);
 *   2. same tool;
 *   3. the older card was raised in an EARLIER turn. Two cards raised in the same turn are two
 *      separate proposals, and both stay;
 *   4. if both cards carry a target (a thread, a recipient list, an event, a page ...), the targets
 *      are equal. A card without a target never blocks a withdrawal.
 *
 * TARGETS ARE HASHED. The ledger never stores what a card showed (`payloadFingerprint`'s rule), so a
 * target is stored as a SHA-256 and only compared for equality.
 */
import { createHash } from "node:crypto";

/** An unanswered card as the ledger holds it. `turn` is null for a row written before the session
 *  columns existed; such a row is never withdrawn. */
export interface OpenAsk {
  requestId: string;
  tool: string;
  turn: number | null;
  targetHash: string | null;
}

/** The card that just arrived. */
export interface IncomingAsk {
  tool: string;
  turn: number;
  targetHash: string | null;
}

/** The request ids of the open cards the incoming card replaces, in the order given. */
export function selectSupersededAsks(incoming: IncomingAsk, open: readonly OpenAsk[]): string[] {
  return open
    .filter((o) => {
      if (o.tool !== incoming.tool) return false;
      if (o.turn === null || o.turn >= incoming.turn) return false;
      if (o.targetHash !== null && incoming.targetHash !== null && o.targetHash !== incoming.targetHash) return false;
      return true;
    })
    .map((o) => o.requestId);
}

/* ------------------------------------------------------------------------------------------- *
 * Targets: a small, explicit list. A tool not listed here has no target, and the rule above then
 * decides on session, tool and turn alone.
 * ------------------------------------------------------------------------------------------- */

const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** Recipients, normalised so order and case do not matter. Undefined for an empty or odd list. */
function recipients(v: unknown): string | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: string[] = [];
  for (const item of v) {
    const t = text(item);
    if (t === undefined) return undefined;
    out.push(t.toLowerCase());
  }
  return [...new Set(out)].sort().join(",");
}

/** An extension tool arrives as `agent-kit__vault_write`; the own tool is `vault_write`. */
const bareName = (tool: string): string => (tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool);

/**
 * What a card is about, or undefined. One short string per tool family:
 *   mail (send, draft)             the thread, else the recipients
 *   follow-up mail (send, redraft) the meeting page
 *   calendar update / delete       the event
 *   proposal resolvers             the proposal
 *   vault note tools               the note (area plus title or path)
 */
export function approvalTarget(tool: string, input: unknown): string | undefined {
  const i = record(input);
  if (i === undefined) return undefined;
  switch (bareName(tool)) {
    case "gmail_send":
    case "gmail_draft": {
      const thread = text(i["threadId"]);
      if (thread !== undefined) return `thread:${thread}`;
      const to = recipients(i["to"]);
      return to === undefined ? undefined : `to:${to}`;
    }
    case "meeting_followup_send":
    case "meeting_followup_redraft": {
      const page = text(i["notionPageId"]);
      return page === undefined ? undefined : `page:${page}`;
    }
    case "calendar_update_event":
    case "calendar_delete_event": {
      const event = text(i["eventId"]);
      return event === undefined ? undefined : `event:${event}`;
    }
    case "atlas_resolve_proposal":
    case "notion_resolve_proposal":
    case "memory_resolve_proposal": {
      const id = i["id"];
      return typeof id === "number" && Number.isFinite(id) ? `proposal:${id}` : undefined;
    }
    case "vault_write": {
      const area = text(i["area"]);
      const title = text(i["title"]);
      return area === undefined || title === undefined ? undefined : `note:${area}/${title}`;
    }
    case "vault_file":
    case "vault_drop": {
      const area = text(i["area"]);
      const path = text(i["path"]);
      return area === undefined || path === undefined ? undefined : `note:${area}/${path}`;
    }
    default:
      return undefined;
  }
}

/** The stored form of a target: a SHA-256, or null when the tool has none. */
export function targetFingerprint(tool: string, input: unknown): string | null {
  const target = approvalTarget(tool, input);
  return target === undefined ? null : createHash("sha256").update(target).digest("hex");
}
