/** Server-only, member-owned persistence for creative studio runs. */
import type { Pool } from "pg";
import { consoleSourceTransaction, gateConsoleOrganisation, type SourceDatabase, type SourcePool } from "@lares/agent-kit/console-source-transaction";
import { managedIdentity } from "@lares/agent-kit/door-authority";
import { isAllowedPrincipal, AUTHENTICATOR_FOR } from "../principals.js";
import type { ApprovalPrincipal } from "../approvals.js";
import type { StudioRun } from "./types.js";

export interface MiniPool extends SourcePool {}
type Assert<T extends true> = T;
type _PoolSatisfiesMiniPool = Assert<Pool extends MiniPool ? true : false>;

const AUTHORITY_REFUSED = "Studio history authority is not available";
const QUERY_BUDGET_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Runtime identity is held only in a module-private WeakMap. Callers cannot construct a valid capture. */
declare const studioOwnerCaptureBrand: unique symbol;
export type StudioOwnerCapture = { readonly [studioOwnerCaptureBrand]: true };
interface CapturedOwner {
  tuple: string;
  memberId: string;
  approver: ApprovalPrincipal;
  agent: string;
  incarnation: string;
  principal: string;
  revision: string;
}
interface OwnerRow {
  member_id: string;
  organisation_id: string;
  primary_email: string;
  agent: string;
  incarnation: string;
  ownership: string;
  resource_state: string;
  pending: boolean;
  runtime_control_token: string;
  applied_definition: unknown;
  definition: unknown;
  definition_hash: string;
  definition_status: string;
  door_enabled: boolean;
  applied_slack_enabled: boolean;
  claim_principal: string;
  owner_email: string;
  claim_revision: string;
  applied_revision: string | null;
  claim_org: string | null;
  mailbox: string | null;
  claimed_at: string | null;
  applied_connection: unknown;
}

function runtime(env: NodeJS.ProcessEnv, approver: ApprovalPrincipal) {
  if (approver.authenticator !== AUTHENTICATOR_FOR.slack || !approver.userId ||
      !isAllowedPrincipal(approver.authenticator, approver.userId, env)) throw new Error(AUTHORITY_REFUSED);
  const identity = managedIdentity(env);
  const principal = env.LARES_SLACK_PRINCIPAL;
  const revision = env.LARES_SLACK_CLAIM_REVISION;
  if (!identity || !principal || principal !== approver.userId || !revision || !UUID.test(revision))
    throw new Error(AUTHORITY_REFUSED);
  return { agent: identity.name, incarnation: identity.incarnation, principal, revision: revision.toLowerCase() };
}

/**
 * Resolve the installed claim's administrative email to its unique active member before any
 * authority locks. The organisation gate is then acquired before member, runtime or claim locks.
 */
async function currentOwner(db: SourceDatabase, approver: ApprovalPrincipal, env: NodeJS.ProcessEnv): Promise<OwnerRow> {
  const run = runtime(env, approver);
  const discovery = await db.query(`SELECT u.id AS member_id
    FROM agent_door_connections c JOIN users u
      ON lower(btrim(u.primary_email))=lower(btrim(c.owner_email))
    WHERE c.agent=$1 AND c.kind='slack' AND c.incarnation=$2::uuid AND c.principal=$3
      AND c.revision=$4::uuid AND c.applied_revision=$4::uuid
      AND u.status='active' AND u.org_id IS NOT NULL
    LIMIT 2`, [run.agent, run.incarnation, run.principal, run.revision]);
  if (discovery.rows.length !== 1) throw new Error(AUTHORITY_REFUSED);
  const memberId = String(discovery.rows[0].member_id);
  await gateConsoleOrganisation(db, memberId);

  const { rows: rawRows } = await db.query(`SELECT
      u.id AS member_id, u.org_id AS organisation_id, u.primary_email,
      r.name AS agent, r.ownership_token::text AS incarnation, r.ownership,
      r.state AS resource_state, r.pending, r.runtime_control_token::text,
      r.applied_definition, a.definition, a.hash AS definition_hash,
      a.status AS definition_status, d.enabled AS door_enabled,
      EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(r.applied_definition->'doors','[]'::jsonb)) x
        WHERE x->>'kind'='slack' AND x->>'enabled'='true') AS applied_slack_enabled,
      c.principal AS claim_principal, c.owner_email, c.revision::text AS claim_revision,
      c.applied_revision::text AS applied_revision, c.org AS claim_org, c.mailbox, c.claimed_at::text,
      c.applied_connection
    FROM users u
    JOIN agent_resources r ON r.name=$1 AND r.ownership_token=$2::uuid
    JOIN agent_definitions a ON a.name=r.name
    JOIN agent_doors d ON d.agent=r.name AND d.kind='slack'
    JOIN agent_door_connections c ON c.agent=r.name AND c.kind='slack' AND c.incarnation=r.ownership_token
    WHERE u.id=$3 AND u.status='active' AND u.org_id IS NOT NULL
      AND lower(btrim(u.primary_email))=lower(btrim(c.owner_email))
      AND r.ownership='owned' AND r.state='ready' AND NOT r.pending
      AND r.runtime_control_token=r.ownership_token
      AND r.applied_definition=a.definition
      AND a.status='valid' AND d.enabled=true
      AND c.principal=$4 AND c.revision=$5::uuid AND c.applied_revision=$5::uuid
    FOR SHARE OF u,r,a,d,c`, [run.agent, run.incarnation, memberId, run.principal, run.revision]);
  const rows = rawRows as OwnerRow[];
  const row = rows[0];
  if (rows.length !== 1 || !row?.door_enabled || !row.applied_slack_enabled ||
      row.runtime_control_token !== row.incarnation || row.claim_principal !== run.principal ||
      row.claim_revision !== run.revision || row.applied_revision !== run.revision ||
      !appliedClaimMatches(row))
    throw new Error(AUTHORITY_REFUSED);
  return row;
}

function captureTuple(row: OwnerRow): string {
  return JSON.stringify([
    row.member_id, row.organisation_id, row.primary_email, row.agent, row.incarnation,
    row.ownership, row.resource_state, row.pending, row.runtime_control_token,
    row.applied_definition, row.definition, row.definition_hash, row.definition_status,
    row.door_enabled, row.applied_slack_enabled,
    row.claim_principal, row.owner_email, row.claim_revision, row.applied_revision,
    row.claim_org, row.mailbox, row.claimed_at, row.applied_connection,
  ]);
}

function appliedClaimMatches(row: OwnerRow): boolean {
  const applied = row.applied_connection as Record<string, unknown> | null;
  return !!row.claimed_at && !!applied && typeof applied === "object" &&
    applied.kind === "slack" && applied.principal === row.claim_principal &&
    applied.revision === row.claim_revision && applied.owner_email === row.owner_email &&
    applied.org === row.claim_org && applied.mailbox === row.mailbox;
}

/** Fixed-column schema check. Migrations, not an application startup hook, own all DDL. */
export async function ensureStudioTables(db: Pick<SourceDatabase, "query">): Promise<void> {
  await db.query(`SELECT id, brief, consensus, spread, picks, principal, created_at, owner_member_id
    FROM studio_runs LIMIT 0`);
}

export function makeStudioStore(db: MiniPool, env: NodeJS.ProcessEnv = process.env) {
  const captures = new WeakMap<object, CapturedOwner>();
  return {
    async captureOwner(verifiedApprover: ApprovalPrincipal): Promise<StudioOwnerCapture> {
      const run = runtime(env, verifiedApprover);
      await ensureStudioTables(db);
      const row = await consoleSourceTransaction(db, async client =>
        currentOwner(client, verifiedApprover, env), undefined,
        { deadlineAtMs: Date.now() + QUERY_BUDGET_MS });
      const capture = Object.freeze({}) as StudioOwnerCapture;
      captures.set(capture, { tuple: captureTuple(row), memberId: row.member_id, approver: { ...verifiedApprover }, ...run });
      return capture;
    },
    async recordRun(run: StudioRun, capture: StudioOwnerCapture): Promise<{ id: string }> {
      const state = capture && typeof capture === "object" ? captures.get(capture) : undefined;
      if (!state) throw new Error(AUTHORITY_REFUSED);
      // Burn synchronously before the first await. No retry after an unknown database outcome.
      captures.delete(capture);
      const id = await consoleSourceTransaction(db, async client => {
        const current = captureTuple(await currentOwner(client, state.approver, env));
        if (current !== state.tuple) throw new Error(AUTHORITY_REFUSED);
        const { rows } = await client.query(`INSERT INTO studio_runs
          (brief, consensus, spread, principal, owner_member_id)
          VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [run.brief, run.consensus, JSON.stringify(run.spread), state.principal, state.memberId]);
        if (rows.length !== 1) throw new Error(AUTHORITY_REFUSED);
        return String(rows[0].id);
      }, undefined, { deadlineAtMs: Date.now() + QUERY_BUDGET_MS });
      return { id };
    },
  };
}
