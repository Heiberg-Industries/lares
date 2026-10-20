/**
 * src/approval-supersede-hook.ts — the shared body of every role's `agent/hooks/approval-supersede.ts`:
 * when a NEW tool-approval card arrives, withdraw the older unanswered card it replaces
 * (`./approval-supersede.ts` decides which). Backs `services/box/sql/006_approval_session.sql`.
 *
 * WITHDRAWING A CARD, IN TWO STEPS, IN THIS ORDER.
 *   1. The ledger row is settled as `cancelled` with `answered_via = 'revised'`. From this moment
 *      `assertApprovedCall` (`./approval-ledger.ts`) refuses the old call even if someone still
 *      manages to approve it: a cancelled card is not an approval. This is the step that is safe on
 *      its own.
 *   2. eve is told to cancel the request: `POST /eve/v1/session/<id>` with
 *      `{ inputResponses: [{ requestId, optionId: "cancel" }] }`, the same call the console's chat
 *      makes for a Cancel tap. eve settles the card as "Cancelled" (outcome `denied`) and the tool
 *      never runs (`packages/board-evals/proofs/pending-reply-2026-10-19.md`, (c)). eve's later
 *      `input.resolved` then finds the ledger row already settled and writes nothing
 *      (`recordAnswer` is first-answer-wins), so the row keeps `revised`.
 *
 * WHY HTTP AND NOT AN IN-PROCESS CALL. A hook receives `{ agent, channel, session }` and cannot
 * answer a request; only a channel route has `respond`/`attachSession` (eve docs, "Channels →
 * custom"). The agent's own session route is the way in, authenticated with the route password the
 * agent already holds (`/run/secrets/eve-route-password`, the same secret the console uses), over
 * loopback. That identity is a signed-in caller, which is what eve requires to accept a Cancel; it
 * is not an approver and it cannot approve anything (`lib/principals.ts` allows no `http-basic`
 * principal).
 *
 * The cancel request is NOT awaited: eve awaits hooks inside the turn, and the route may wait on
 * that turn. A failure is logged once and is safe, because step 1 already made the old call refuse.
 *
 * BEST-EFFORT like every recorder here: a thrown hook becomes `turn.failed`, so each step swallows
 * its own failure and warns at most once per process. `getPool()` is called inside the handlers,
 * never at module scope, so `eve build` never touches it.
 */
import { readFileSync } from "node:fs";

import { getPool } from "./db.js";
import { payloadFingerprint } from "./approval-ledger.js";
import {
  selectSupersededAsks,
  targetFingerprint,
  type OpenAsk,
} from "./approval-supersede.js";

/** What a card is, as the hook sees it when it arrives. */
export interface NewAsk {
  requestId: string;
  callId: string;
  agent: string;
  tool: string;
  payloadHash: string;
  sessionId: string;
  turn: number;
  targetHash: string | null;
}

export interface ApprovalSupersedeDeps {
  /** Writes the card down with its session, turn and target. Idempotent. */
  record?: (ask: NewAsk) => Promise<void>;
  /** This session's unanswered cards, other than the ones named. */
  openAsks?: (sessionId: string, exceptRequestIds: readonly string[]) => Promise<OpenAsk[]>;
  /** Settles one card as cancelled/revised. True only when this call changed the row. */
  markRevised?: (requestId: string) => Promise<boolean>;
  /** Tells eve to cancel the request. */
  cancel?: (sessionId: string, requestId: string) => Promise<void>;
}

let warnedOnce = false;
function warn(where: string, err: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(
    `approval-supersede-hook: ${where} failed (this and any further failures this process are swallowed; the turn is unaffected):`,
    err,
  );
}

/* --------------------------------- database (production) --------------------------------- */

async function recordWithSession(a: NewAsk): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO approval_asks (request_id, call_id, agent, tool, payload_hash, session_id, turn_sequence, target_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING`,
    [a.requestId, a.callId, a.agent, a.tool, a.payloadHash, a.sessionId, a.turn, a.targetHash],
  );
  // The role's own recorder may have inserted the row first, without these columns.
  await db.query(
    `UPDATE approval_asks SET session_id = $2, turn_sequence = $3, target_hash = $4
     WHERE request_id = $1 AND session_id IS NULL`,
    [a.requestId, a.sessionId, a.turn, a.targetHash],
  );
}

async function openAsksForSession(sessionId: string, except: readonly string[]): Promise<OpenAsk[]> {
  const { rows } = await getPool().query<{
    request_id: string;
    tool: string;
    turn_sequence: number | null;
    target_hash: string | null;
  }>(
    `SELECT request_id, tool, turn_sequence, target_hash
       FROM approval_asks
      WHERE session_id = $1 AND outcome IS NULL AND NOT (request_id = ANY($2::text[]))
      ORDER BY asked_at`,
    [sessionId, [...except]],
  );
  return rows.map((r) => ({
    requestId: r.request_id,
    tool: r.tool,
    turn: r.turn_sequence,
    targetHash: r.target_hash,
  }));
}

async function settleAsRevised(requestId: string): Promise<boolean> {
  const res = await getPool().query(
    `UPDATE approval_asks SET answered_at = now(), outcome = 'cancelled', answered_via = 'revised'
      WHERE request_id = $1 AND outcome IS NULL`,
    [requestId],
  );
  return (res.rowCount ?? 0) > 0;
}

/* --------------------------------- eve session route (production) --------------------------------- */

const ROUTE_USERNAME = "eve";
const DEFAULT_PASSWORD_FILE = "/run/secrets/eve-route-password";
/** The port every role's eve process listens on inside its container (the keeper's health check
 *  reads the same one). */
export const LOCAL_EVE_URL = "http://127.0.0.1:3000";

/**
 * The cancel call. Reads the route password per call (never at import), the way the door's own
 * auth does. Throws on a refusal so the caller can log it.
 */
export async function cancelApprovalRequest(
  sessionId: string,
  requestId: string,
  opts: {
    baseUrl?: string;
    passwordFile?: string;
    fetchImpl?: typeof fetch;
    readFile?: (path: string) => string;
  } = {},
): Promise<void> {
  const file = opts.passwordFile ?? process.env["EVE_ROUTE_PASSWORD_FILE"] ?? DEFAULT_PASSWORD_FILE;
  const password = (opts.readFile ?? ((p: string) => readFileSync(p, "utf8")))(file).trim();
  if (password === "") throw new Error(`route password file is empty: ${file}`);
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl ?? LOCAL_EVE_URL}/eve/v1/session/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${ROUTE_USERNAME}:${password}`).toString("base64")}`,
    },
    body: JSON.stringify({ inputResponses: [{ requestId, optionId: "cancel" }] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`eve answered ${res.status} to the cancel`);
}

/* --------------------------------- the handler --------------------------------- */

const asString = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const asTurn = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

/** Builds the `input.requested` handler. Exported so tests can drive it with injected deps. */
export function makeApprovalSupersede(deps: ApprovalSupersedeDeps = {}) {
  const record = deps.record ?? recordWithSession;
  const openAsks = deps.openAsks ?? openAsksForSession;
  const markRevised = deps.markRevised ?? settleAsRevised;
  const cancel = deps.cancel ?? ((s: string, r: string) => cancelApprovalRequest(s, r));

  async function onInputRequested(event: unknown, ctx: unknown): Promise<void> {
    try {
      const requests = ((event as { data?: { requests?: unknown } } | undefined)?.data?.requests);
      if (!Array.isArray(requests)) return;
      const c = ctx as { agent?: { name?: unknown }; session?: { id?: unknown; turn?: { sequence?: unknown } } } | undefined;
      const sessionId = asString(c?.session?.id);
      const turn = asTurn(c?.session?.turn?.sequence);
      if (sessionId === undefined || turn === undefined) return;
      const agent = asString(c?.agent?.name) ?? "unknown";

      const arrived: NewAsk[] = [];
      for (const req of requests) {
        if (typeof req !== "object" || req === null) continue;
        const r = req as { kind?: unknown; requestId?: unknown; action?: { callId?: unknown; toolName?: unknown; input?: unknown } };
        if (r.kind !== "tool-approval") continue;
        const requestId = asString(r.requestId);
        const callId = asString(r.action?.callId);
        const tool = asString(r.action?.toolName);
        if (requestId === undefined || callId === undefined || tool === undefined) continue;
        arrived.push({
          requestId,
          callId,
          agent,
          tool,
          payloadHash: payloadFingerprint(tool, r.action?.input),
          sessionId,
          turn,
          targetHash: targetFingerprint(tool, r.action?.input),
        });
      }
      if (arrived.length === 0) return;

      for (const a of arrived) {
        try {
          await record(a);
        } catch (err) {
          warn("record", err);
        }
      }

      let open: OpenAsk[];
      try {
        open = await openAsks(sessionId, arrived.map((a) => a.requestId));
      } catch (err) {
        warn("read open cards", err);
        return;
      }

      const withdrawn = new Set<string>();
      for (const a of arrived) {
        for (const requestId of selectSupersededAsks(a, open)) {
          if (withdrawn.has(requestId)) continue;
          withdrawn.add(requestId);
          try {
            if (!(await markRevised(requestId))) continue;
          } catch (err) {
            warn("settle as revised", err);
            continue;
          }
          void cancel(sessionId, requestId).catch((err: unknown) => warn("cancel request", err));
        }
      }
    } catch (err) {
      warn("input.requested", err);
    }
  }

  return { "input.requested": onInputRequested };
}
