/**
 * src/approval-ledger.ts — the approval ledger: what was asked, and what the owner answered.
 * Backs `services/box/sql/086_approval_asks.sql`.
 *
 * WHY THIS EXISTS, NOT A SECOND `approval_events`. `approval_events` (box 038,
 * `packages/agent-kit/src/ratchet.ts`) records what the POLICY decided — asked, autonomous,
 * denied, locked, failed-closed — one row per call id. It has never recorded what happened next:
 * whether the owner approved, cancelled, or never answered. This module is the other half.
 *
 * `payloadFingerprint` HASHES, NEVER STORES. What the owner was shown is a mail body, a note, a
 * recipient list — someone's words. This table is evidence about the gate, never a second copy
 * of the message.
 *
 * BEST-EFFORT BY CONSTRUCTION, modelled line for line on `recordRead`
 * (`services/chief-of-staff/lib/memory-reads.ts`) and `openRepair` (`./repairs.ts`). NEVER
 * throws, never blocks, and a failure is logged at most once per process: recording an ask or an
 * answer must not be able to cost the turn that produced it.
 *
 * `used_at`/`use_count` (W7A-s5b) COUNT, THEY DO NOT ENFORCE. 086 has no execution marker, so a
 * second execution of an approved call id cannot be told from the first, and eve has a legitimate
 * durable-replay path nobody has observed live. `assertApprovedCall`, after a PASS on an existing
 * row, bumps them via `markUsed` (best-effort, never able to turn a pass into a refusal) and, on a
 * repeat, warns once — naming the tool and the call id, never the payload — and still passes.
 * Whether to refuse a repeat is a later, one-line decision made once those numbers exist.
 *
 * `assertApprovedCall` IS THE ONE PART THAT REFUSES (W7A-s5), and it refuses in exactly three
 * shapes, never in a fourth:
 *   1. NO CALL ID, OR NO ROW ⇒ return. A missing row is also what an autonomous, un-carded call
 *      looks like, and what every call looks like on a box that has not applied box 086 —
 *      refusing there would refuse exactly the calls the permissions board deliberately allowed.
 *      The APPROVER check (`services/<role>/lib/approvals.ts`) is the unconditional one; this is
 *      the additional one. For the same reason a ledger that THROWS is treated as case 1:
 *      evidence never fails an action.
 *   2. A ROW OLDER THAN `ttlMs` ⇒ settle `expired` and throw `StaleApprovalError`. The age is
 *      measured from the row's own `asked_at` — the database's clock, or an injected `now` in a
 *      test — never from anything a caller or a door supplies.
 *   3. A ROW WHOSE `payloadHash` DIFFERS from `payloadFingerprint(toolName, input)` ⇒ settle
 *      `payload-changed` and throw `ApprovalPayloadChangedError`. Same function on both sides,
 *      imported and never re-derived, so "the arguments that execute are the ones the card was
 *      rendered for" is a checked property rather than a coincidence of the code path.
 * A row that is ALREADY settled as something other than `approved` is refused before any of that
 * and is never written a second time: a cancelled, ignored, invalid, expired or payload-changed
 * card is not an approval, whatever calls it.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "@lares/vault-format/forget-ledger";

import { getPool } from "./db.js";

/** The outcomes this table can record. `expired` and `payload-changed` are settled by the
 *  freshness check (W7A-s5), never by the hook. */
export const ASK_OUTCOMES = [
  "approved", "cancelled", "ignored", "invalid", "expired", "payload-changed",
] as const;
export type AskOutcome = (typeof ASK_OUTCOMES)[number];

export interface AskRow {
  requestId: string;
  callId: string;
  agent: string;
  tool: string;
  payloadHash: string;
  askedAt: Date;
  answeredAt: Date | null;
  outcome: AskOutcome | null;
  answeredVia: string | null;
  /** First time an approved call PASSED `assertApprovedCall`'s checks. Counting only (W7A-s5b) —
   *  see the module header. */
  usedAt: Date | null;
  useCount: number;
}

let warnedAboutApprovalAsks = false;

function warnAboutApprovalAsks(err: unknown): void {
  if (warnedAboutApprovalAsks) return;
  warnedAboutApprovalAsks = true;
  console.warn(
    "approval-ledger: could not record an ask/answer (this and any further failures this " +
      "process are swallowed) — apply services/box/sql/086_approval_asks.sql if it is not there " +
      "yet. The turn that triggered this is unaffected.",
    err,
  );
}

/** Resets the once-per-process warning flag. Test-only. */
export function resetApprovalLedgerWarningForTests(): void {
  warnedAboutApprovalAsks = false;
}

/** A recursive JSON.stringify with object keys sorted, so the same input hashes the same
 *  whatever order its keys were built in. Arrays keep their order (order is meaningful there).
 *  `undefined` is dropped, matching JSON.stringify's own behaviour for object values. A cycle is
 *  guarded by a WeakSet, returning the literal "[cycle]" rather than throwing — this function
 *  feeds an approval card's own input, and a cycle there is a bug elsewhere, not a reason to
 *  crash the recorder.
 *
 *  `undefined` becomes `null`. Inside an array that is JSON.stringify's own behaviour; as an
 *  object VALUE it deliberately differs from it, because the key itself is still written out —
 *  a key that is present with no value is a different call from a key that is not there at all,
 *  and a payload binding must never be loosened by a key appearing
 *  (`tests/approval-check.test.ts` pins it). */
function canonical(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value as object)) return '"[cycle]"';
  seen.add(value as object);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonical(v, seen)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k], seen)}`,
  );
  return `{${parts.join(",")}}`;
}

/** sha256 over the tool name and a canonical (key-sorted) JSON of the input. The one string that
 *  says "this is the call that was shown". */
export function payloadFingerprint(toolName: string, input: unknown): string {
  return createHash("sha256").update(`${toolName} ${canonical(input)}`).digest("hex");
}

function toAskRow(row: {
  request_id: string;
  call_id: string;
  agent: string;
  tool: string;
  payload_hash: string;
  asked_at: Date;
  answered_at: Date | null;
  outcome: string | null;
  answered_via: string | null;
  used_at: Date | null;
  use_count: number;
}): AskRow {
  return {
    requestId: row.request_id,
    callId: row.call_id,
    agent: row.agent,
    tool: row.tool,
    payloadHash: row.payload_hash,
    askedAt: row.asked_at,
    answeredAt: row.answered_at,
    outcome: row.outcome as AskOutcome | null,
    answeredVia: row.answered_via,
    usedAt: row.used_at,
    useCount: row.use_count,
  };
}

/**
 * Writes down that a card was shown. A repeat ask for the same call id (the same tool call
 * re-parked, or a retry) keeps the FIRST asked_at — `ON CONFLICT DO NOTHING` with no target
 * covers both the primary key (request_id) and the unique call index.
 *
 * BEST-EFFORT. Never throws; warns once per process when box 086 is missing.
 */
export async function recordAsk(
  db: Queryable,
  a: { requestId: string; callId: string; agent: string; tool: string; payloadHash: string },
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO approval_asks (request_id, call_id, agent, tool, payload_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [a.requestId, a.callId, a.agent, a.tool, a.payloadHash],
    );
  } catch (err) {
    warnAboutApprovalAsks(err);
  }
}

/**
 * Records the answer for a request id. First answer wins (`WHERE outcome IS NULL`) — a settled
 * row is never overwritten.
 *
 * BEST-EFFORT. Never throws; warns once per process when box 086 is missing.
 */
export async function recordAnswer(
  db: Queryable,
  a: { requestId: string; outcome: AskOutcome; answeredVia?: string },
): Promise<void> {
  try {
    await db.query(
      `UPDATE approval_asks SET answered_at = now(), outcome = $2, answered_via = $3
       WHERE request_id = $1 AND outcome IS NULL`,
      [a.requestId, a.outcome, a.answeredVia ?? null],
    );
  } catch (err) {
    warnAboutApprovalAsks(err);
  }
}

/**
 * Reads the card for a call id, or null when there is none — a missing table, a missing row, or
 * an unreadable database all answer null rather than throwing.
 *
 * BEST-EFFORT. Never throws; warns once per process when box 086 is missing.
 */
export async function askForCall(db: Queryable, callId: string): Promise<AskRow | null> {
  try {
    const { rows } = await db.query<{
      request_id: string;
      call_id: string;
      agent: string;
      tool: string;
      payload_hash: string;
      asked_at: Date;
      answered_at: Date | null;
      outcome: string | null;
      answered_via: string | null;
      used_at: Date | null;
      use_count: number;
    }>(
      `SELECT request_id, call_id, agent, tool, payload_hash, asked_at, answered_at, outcome,
              answered_via, used_at, use_count
       FROM approval_asks WHERE call_id = $1`,
      [callId],
    );
    const row = rows[0];
    return row === undefined ? null : toAskRow(row);
  } catch (err) {
    warnAboutApprovalAsks(err);
    return null;
  }
}

/* ------------------------------------------------------------------------------------------- *
 * W7A-s5 — the card is still fresh, and it showed these arguments.
 * ------------------------------------------------------------------------------------------- */

/** How long a card stays an answer. Owner decision A2; 24 hours is the safe default.
 *  One constant, exported, so a door cannot quietly hold a different opinion. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** The card that authorised this call is older than the window. The owner's tap DID happen, so
 *  this is not counted as a refusal — `readApprovalCounts` (`./approval-stats.ts`) reads
 *  `approved`/`cancelled` only, and `expired` falls into "never answered". */
export class StaleApprovalError extends Error {
  constructor(readonly toolName: string, readonly askedAt: Date, readonly now: Date) {
    const hours = Math.max(1, Math.round((now.getTime() - askedAt.getTime()) / (60 * 60 * 1000)));
    super(
      `I asked about this ${hours} ${hours === 1 ? "hour" : "hours"} ago and the answer has gone ` +
        "stale — ask me again and I will put a fresh card up. Nothing was done.",
    );
    this.name = "StaleApprovalError";
  }
}

/** What would execute is not what the card was rendered for. The message never quotes the
 *  arguments: a refusal is not a place to leak the words a card deliberately shortened. */
export class ApprovalPayloadChangedError extends Error {
  constructor(readonly toolName: string) {
    super("What this would do is not what the card showed, so I did not do it. Ask me again.");
    this.name = "ApprovalPayloadChangedError";
  }
}

/** The card was already settled as something that is not an approval — cancelled by the owner,
 *  ignored, or rejected by eve as invalid. Nothing may act on it afterwards. */
export class ApprovalNotGivenError extends Error {
  constructor(readonly toolName: string, readonly outcome: AskOutcome) {
    super("You did not approve this, so I did not do it. Ask me again if you want it done.");
    this.name = "ApprovalNotGivenError";
  }
}

/** The call id eve gave this tool call, or undefined.
 *
 *  eve's authored `ToolContext` names it `callId` — "the same `callId` carried by the call's
 *  stream events and its `ApprovalContext`" (`eve/dist/src/tools/definition.d.ts`). `toolCallId`
 *  is the AI SDK's name, which eve renames on the way in. This function first read only
 *  `toolCallId`, found nothing on any real call, and — because "no call id" passes — the whole
 *  check never ran: no expiry, no payload binding, no refusal of a cancelled card. Every unit
 *  test handed it a `toolCallId` by hand, so none of them saw it; a run against the real
 *  framework did (`packages/board-evals/proofs/approval-binding-2026-09-20.md`). `callId` is read
 *  FIRST; `toolCallId` stays as a fallback for a caller that holds the SDK's own options object.
 *
 *  Defensive for the same reason `turnKeyFrom` (`./origin-taint.ts`) is: a half-read id would
 *  check the WRONG card, and an empty one would check none. */
export function callIdFrom(ctx: unknown): string | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  const bag = ctx as { callId?: unknown; toolCallId?: unknown };
  for (const id of [bag.callId, bag.toolCallId]) {
    if (typeof id === "string" && id !== "") return id;
  }
  return undefined;
}

/** The reads/writes `assertApprovedCall` needs, injected so the check is testable without a
 *  database and so a role can bind its own pool. */
export interface ApprovalLedgerReader {
  ask(callId: string): Promise<AskRow | null>;
  settle(requestId: string, outcome: "expired" | "payload-changed"): Promise<void>;
  /** Records that an approved call PASSED, atomically. Best-effort: any implementation must
   *  answer `null` on error, never throw — see `approvalLedger()`. Counting only (W7A-s5b); the
   *  return value never changes whether the call passes. */
  markUsed(requestId: string): Promise<{ useCount: number } | null>;
}

/** Settling is evidence, not enforcement: a failed write must never turn a refusal into a pass,
 *  so it is swallowed and the caller throws regardless. */
async function settleQuietly(
  ledger: ApprovalLedgerReader,
  requestId: string,
  outcome: "expired" | "payload-changed",
): Promise<void> {
  try {
    await ledger.settle(requestId, outcome);
  } catch (err) {
    warnAboutApprovalAsks(err);
  }
}

/**
 * Throws when the card that authorised this call is too old, or was shown different arguments.
 * Returns silently when there is no card to check — see the three directions in the module
 * header. The approver check stays where it is and stays unconditional; this is the second
 * question ("which card did they answer?"), never a replacement for the first.
 */
export async function assertApprovedCall(
  ledger: ApprovalLedgerReader,
  call: { callId: string | undefined; toolName: string; input: unknown; now?: Date; ttlMs?: number },
): Promise<void> {
  if (call.callId === undefined || call.callId === "") return;

  let row: AskRow | null;
  try {
    row = await ledger.ask(call.callId);
  } catch (err) {
    warnAboutApprovalAsks(err);
    return;
  }
  if (row === null) return;

  const now = call.now ?? new Date();
  const ttlMs = call.ttlMs ?? APPROVAL_TTL_MS;

  // Already settled against the owner: refuse as whatever it was settled as, and never write it
  // a second time. `null` (still parked, or the answer hook has not landed yet) and `approved`
  // are the only two outcomes that go on to the freshness and payload checks.
  if (row.outcome === "expired") throw new StaleApprovalError(call.toolName, row.askedAt, now);
  if (row.outcome === "payload-changed") throw new ApprovalPayloadChangedError(call.toolName);
  if (row.outcome !== null && row.outcome !== "approved") {
    throw new ApprovalNotGivenError(call.toolName, row.outcome);
  }

  if (now.getTime() - row.askedAt.getTime() > ttlMs) {
    await settleQuietly(ledger, row.requestId, "expired");
    throw new StaleApprovalError(call.toolName, row.askedAt, now);
  }

  if (row.payloadHash !== payloadFingerprint(call.toolName, call.input)) {
    await settleQuietly(ledger, row.requestId, "payload-changed");
    throw new ApprovalPayloadChangedError(call.toolName);
  }

  // A PASS, on an existing row. Count it — never enforce on it (see the module header). A
  // `markUsed` that throws or answers null changes nothing: no count, no warning, still a pass.
  let used: { useCount: number } | null;
  try {
    used = await ledger.markUsed(row.requestId);
  } catch {
    used = null;
  }
  if (used !== null && used.useCount > 1) {
    console.warn(
      `approval-ledger: ${call.toolName} call ${call.callId} has now executed ${used.useCount} ` +
        "times off the same approval — eve may have replayed it. Not refused; enforcement is a " +
        "later decision once these numbers exist.",
    );
  }
}

/**
 * The production reader, over `getPool()`. `getPool()` is called INSIDE `ask`/`settle`/`markUsed`,
 * never at module scope, so `eve build` (no secrets, no live Postgres) never touches a connection.
 *
 * `settle` writes only over a row that is unsettled or `approved`, so a cancelled card cannot be
 * rewritten as expired by a late call. `answered_at` keeps the moment the OWNER answered where
 * there was an answer — box 086's check constraint requires the two columns to agree.
 *
 * `markUsed` is ONE atomic statement — `use_count = use_count + 1` in the same UPDATE that reads
 * it back, so two concurrent passes on the same row both land, not one clobbering the other.
 * Best-effort like every other write here: any error, including a row that has since disappeared,
 * answers `null` rather than throwing — `assertApprovedCall` must never fail a call over this.
 */
export function approvalLedger(): ApprovalLedgerReader {
  return {
    ask: (callId) => askForCall(getPool(), callId),
    settle: async (requestId, outcome) => {
      try {
        await getPool().query(
          `UPDATE approval_asks
              SET answered_at = COALESCE(answered_at, now()), outcome = $2
            WHERE request_id = $1 AND (outcome IS NULL OR outcome = 'approved')`,
          [requestId, outcome],
        );
      } catch (err) {
        warnAboutApprovalAsks(err);
      }
    },
    markUsed: async (requestId) => {
      try {
        const { rows } = await getPool().query<{ use_count: number }>(
          `UPDATE approval_asks
              SET use_count = use_count + 1, used_at = COALESCE(used_at, now())
            WHERE request_id = $1
            RETURNING use_count`,
          [requestId],
        );
        const row = rows[0];
        return row === undefined ? null : { useCount: row.use_count };
      } catch (err) {
        warnAboutApprovalAsks(err);
        return null;
      }
    },
  };
}
