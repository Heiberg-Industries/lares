/**
 * src/approval-supersede-hook.ts — the shared body of every role's `agent/hooks/approval-supersede.ts`:
 * when a NEW tool-approval card arrives, withdraw the older unanswered card it replaces
 * (`./approval-supersede.ts` decides which). Backs `services/box/sql/006_approval_session.sql`.
 *
 * WHAT eve 1.0 NOW DOES ITSELF. On eve 0.60 an older card stayed live while a later message ran an
 * ordinary turn, and nothing withdrew it. On eve 1.0 a turn cannot end while an approval waits, and
 * ordinary text from the person the turn serves withdraws every unanswered approval first (the
 * interaction ends `withdrawn`, reason `superseded-by-message`; `docs/concepts/sessions-runs-and-
 * streaming.md`, "Answering approvals"). So the case this hook was written for — a reply that
 * changes a draft — is now ended by eve before the new card exists, and the ledger records that
 * ending as "nobody decided" (`./approval-record-hook.ts`).
 *
 * WHAT THIS HOOK STILL DOES, AND WHY.
 *   0. It writes each new card into the ledger with its session, turn and target. That is what lets
 *      a later card find an older one, and it is the only recorder the creative role has.
 *   1. The ledger row of an older card for the same tool and target, raised in an earlier turn, is
 *      settled as `cancelled` with `answered_via = 'revised'`. From this moment `assertApprovedCall`
 *      (`./approval-ledger.ts`) refuses the old call even if someone still manages to approve it: a
 *      cancelled card is not an approval. This is the step that is safe on its own.
 *   2. Only if eve's own view still shows that older card as OPEN, eve is told to deny it:
 *      `POST /eve/v1/session/<id>` with `{ answers: [{ interactionId, optionId: "deny" }] }`.
 *      A card eve has already ended is never answered again: eve would deliver a late answer to the
 *      model as a new message. That request is made by the route identity, which is not an allowed
 *      approver, so a tool whose response policy refuses any Deny from anyone but the person who
 *      may approve it will refuse this one too and the card stays pending. That is intended: step 1
 *      is what keeps the old call from running, and nothing here may decide a card for the owner.
 *
 * WHY HTTP AND NOT AN IN-PROCESS CALL. A hook receives `{ agent, channel, session }` and cannot
 * answer a request; only a channel route has `respond`/`attachSession` (eve docs, "Channels →
 * custom"). The agent's own session route is the way in, authenticated with the route password the
 * agent already holds (`/run/secrets/eve-route-password`, the same secret the console uses), over
 * loopback.
 *
 * The deny request is NOT awaited: eve awaits hooks inside the turn, and the route may wait on
 * that turn. A failure is logged once and is safe, because step 1 already made the old call refuse.
 *
 * BEST-EFFORT like every recorder here: a thrown hook becomes `turn.failed`, so each step swallows
 * its own failure and warns at most once per process. `getPool()` is called inside the handlers,
 * never at module scope, so `eve build` never touches it.
 */
import { readFileSync } from "node:fs";

import { getPool } from "./db.js";
import { payloadFingerprint } from "./approval-ledger.js";
import { openedApproval } from "./approval-events.js";
import { interaction as interactionOf } from "eve/events";
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
  /** Tells eve to deny the request. Only called for a card eve's own view still shows as open. */
  deny?: (sessionId: string, requestId: string) => Promise<void>;
  /** Whether eve's view of the session still shows this card as open. Unknown counts as not open. */
  isOpen?: (ctx: unknown, requestId: string) => boolean;
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
     WHERE request_id = $1 AND session_id IS NULL AND to_jsonb(approval_asks)->>'original_authority' IS NULL`,
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
      WHERE session_id = $1 AND request_id IS NOT NULL AND outcome IS NULL AND NOT (request_id = ANY($2::text[]))
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
 * The deny call. Reads the route password per call (never at import), the way the door's own
 * auth does. Throws on a refusal so the caller can log it.
 */
export async function denyApprovalRequest(
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
    body: JSON.stringify({ answers: [{ interactionId: requestId, optionId: "deny" }] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`eve answered ${res.status} to the deny`);
}

/* --------------------------------- the handler --------------------------------- */

const asString = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const asTurn = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

/** Whether eve's own view shows the interaction as open. Anything unreadable is "not open". */
function viewShowsOpen(ctx: unknown, requestId: string): boolean {
  try {
    const view = (ctx as { view?: never } | null | undefined)?.view;
    if (view === undefined) return false;
    return interactionOf(view, requestId)?.status === "open";
  } catch {
    return false;
  }
}

/** Builds the `interaction.opened` handler. Exported so tests can drive it with injected deps. */
export function makeApprovalSupersede(deps: ApprovalSupersedeDeps = {}) {
  const record = deps.record ?? recordWithSession;
  const openAsks = deps.openAsks ?? openAsksForSession;
  const markRevised = deps.markRevised ?? settleAsRevised;
  const deny = deps.deny ?? ((s: string, r: string) => denyApprovalRequest(s, r));
  const isOpen = deps.isOpen ?? viewShowsOpen;

  async function onInteractionOpened(event: unknown, ctx: unknown): Promise<void> {
    try {
      const c = ctx as { agent?: { name?: unknown }; session?: { id?: unknown; turn?: { sequence?: unknown } } } | undefined;
      const sessionId = asString(c?.session?.id);
      const turn = asTurn(c?.session?.turn?.sequence);
      if (sessionId === undefined || turn === undefined) return;
      const agent = asString(c?.agent?.name) ?? "unknown";

      const card = openedApproval(event, ctx);
      if (card === undefined) return;
      const arrived: NewAsk[] = [{
        requestId: card.interactionId,
        callId: card.callId,
        agent,
        tool: card.toolName,
        payloadHash: payloadFingerprint(card.toolName, card.input),
        sessionId,
        turn,
        targetHash: targetFingerprint(card.toolName, card.input),
      }];

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
          // The ledger already refuses the old call. Asking eve to deny the card is only worth
          // doing while eve still shows it as open; a card eve ended needs no answer.
          if (!isOpen(ctx, requestId)) continue;
          void deny(sessionId, requestId).catch((err: unknown) => warn("deny request", err));
        }
      }
    } catch (err) {
      warn("interaction.opened", err);
    }
  }

  return { "interaction.opened": onInteractionOpened };
}
