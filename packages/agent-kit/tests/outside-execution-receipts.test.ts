import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Pool } from "pg";
import { quietPool } from "./helpers/quiet-pool.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  consumeOutsideExecutionApproval,
  outsideExecutionApprovalSchema,
  outsidePayloadHash,
  recordOutsideExecutionApproval,
} from "../src/outside-execution-receipts.js";
import type { OutsideExecutionReceiptStore } from "../src/outside-execution-receipts.js";

let container: StartedPostgreSqlContainer;
let db: Pool;
const SQL = join(import.meta.dirname, "..", "..", "..", "services", "box", "sql");
const actualStore = () => db as unknown as OutsideExecutionReceiptStore;

const base = {
  callId: "call-1", requestId: "request-1", sessionId: "session-1", memberId: "member-a", approverMemberId: "member-a",
  agent: "bookkeeper", incarnation: "123e4567-e89b-42d3-a456-426614174000", definitionHash: "a".repeat(64),
  connectionName: "registry", accountId: "123e4567-e89b-42d3-a456-426614174001", credentialRevision: 4,
  toolName: "lookup", payloadHash: outsidePayloadHash("lookup", { company: "Example" }), expiresAt: Date.now() + 60_000,
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  db = quietPool(container.getConnectionUri());
  const migrations = readdirSync(SQL).filter(file => /^\d+.*\.sql$/.test(file) && Number(file.match(/^\d+/)![0]) <= 29)
    .sort((a,b) => Number(a.match(/^\d+/)![0])-Number(b.match(/^\d+/)![0]) || a.localeCompare(b));
  for (const file of [...migrations, "031_outside_execution_approvals.sql"])
    await db.query(readFileSync(join(SQL, file), "utf8"));
  await db.query("INSERT INTO orgs(id,display_name) VALUES('receipt-org','Receipt test')");
  await db.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('member-a','A','receipt-org','owner','active'),('member-b','B','receipt-org','member','active')");
  await db.query("INSERT INTO org_member_policy(user_id) VALUES('member-a'),('member-b')");
  await db.query("INSERT INTO agent_definitions(name,definition,hash) VALUES('bookkeeper','{}'::jsonb,repeat('a',64))");
  await db.query("INSERT INTO agent_access(agent_name,owner_member_id,organisation_id) VALUES('bookkeeper','member-a','receipt-org')");
  await db.query(`INSERT INTO outside_custody_accounts(account_id,owner_member_id,resource_id,connection_name,consent_generation,state)
    VALUES($1,'member-a','bookkeeper','registry',1,'active')`, [base.accountId]);
}, 120_000);
afterAll(async () => { await db.end(); await container.stop(); });
beforeEach(async () => { await db.query("TRUNCATE outside_execution_approvals"); });

class ReceiptStore {
  row: Record<string, unknown> | undefined;
  consumed = false;
  async query(sql: string, values: unknown[] = []) {
    if (sql.includes("INSERT INTO outside_execution_approvals")) {
      if (!this.row) {
        const v = values;
        this.row = {
          request_id:v[1],session_id:v[2],member_id:v[3],approver_member_id:v[4],agent:v[5],incarnation:v[6],
          definition_hash:v[7],connection_name:v[8],account_id:v[9],credential_revision:String(v[10]),tool_name:v[11],payload_hash:v[12],
          expires_at_ms:String(v[13]),consumed_at:null,
        };
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT request_id")) return { rows: this.row ? [this.row] : [], rowCount: this.row ? 1 : 0 };
    if (sql.includes("UPDATE outside_execution_approvals")) {
      const matches = this.row && !this.consumed && Object.values(values.slice(0, 13)).length === 13 &&
        values.slice(0, 13).every((value, index) => value === [base.callId,base.requestId,base.sessionId,base.memberId,base.approverMemberId,
          base.agent,base.incarnation,base.definitionHash,base.connectionName,base.accountId,base.credentialRevision,base.toolName,base.payloadHash][index]);
      if (matches) { this.consumed = true; return { rows: [{ call_id: base.callId }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    throw new Error("Unexpected receipt query");
  }
}

describe("outside execution approval receipts", () => {
  it("hashes the exact JSON encoding of supported wire arguments", () => {
    expect(outsideExecutionApprovalSchema.safeParse(base).success).toBe(true);
    expect(outsidePayloadHash("lookup", { company: "Example", country: "NO" })).not.toBe(
      outsidePayloadHash("lookup", { country: "NO", company: "Example" }),
    );
    expect(outsidePayloadHash("lookup", { company: "Example" })).not.toBe(outsidePayloadHash("create", { company: "Example" }));
    expect(outsidePayloadHash("lookup", { company: "Example" })).toBe(outsidePayloadHash("lookup", { company: "Example" }));
  });

  it("refuses values JSON.stringify would omit, normalize, or serialize ambiguously", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const custom = new (class Payload { readonly value = "Example"; })();
    const sparse = new Array(1);
    for (const invalid of [
      { memo: undefined }, { when: new Date("2026-01-01T00:00:00Z") }, sparse, cycle,
      { amount: Number.NaN }, { amount: Number.POSITIVE_INFINITY }, custom,
    ]) expect(() => outsidePayloadHash("lookup", invalid)).toThrow("Outside execution approval is unavailable");
  });

  it("consumes the exact approval once and refuses a replay", async () => {
    const store = new ReceiptStore();
    await recordOutsideExecutionApproval(store, base);
    const selectors = { ...base };
    delete (selectors as Partial<typeof base>).expiresAt;
    await consumeOutsideExecutionApproval(store, selectors);
    await expect(consumeOutsideExecutionApproval(store, selectors)).rejects.toThrow("Outside execution approval is unavailable");
  });

  it("refuses a call selector rebound to another member", async () => {
    const store = new ReceiptStore();
    await recordOutsideExecutionApproval(store, base);
    const selectors = { ...base, memberId: "member-b" };
    delete (selectors as Partial<typeof base>).expiresAt;
    await expect(consumeOutsideExecutionApproval(store, selectors)).rejects.toThrow("Outside execution approval is unavailable");
    expect(store.consumed).toBe(false);
  });

  it("does not replace an existing approval with different exact arguments", async () => {
    const store = new ReceiptStore();
    await recordOutsideExecutionApproval(store, base);
    await expect(recordOutsideExecutionApproval(store, { ...base, payloadHash: "b".repeat(64) })).rejects.toThrow(
      "Outside execution approval is unavailable",
    );
  });

  it("refuses an expired or overlong approval window", async () => {
    const store = new ReceiptStore();
    await expect(recordOutsideExecutionApproval(store, { ...base, expiresAt: Date.now() })).rejects.toThrow(
      "Outside execution approval is unavailable",
    );
    await expect(recordOutsideExecutionApproval(store, { ...base, expiresAt: Date.now() + 6 * 60_000 })).rejects.toThrow(
      "Outside execution approval is unavailable",
    );
  });

  it("persists the exact approval in PostgreSQL and atomically permits only one concurrent use", async () => {
    await recordOutsideExecutionApproval(actualStore(), base);
    const persisted = await db.query("SELECT call_id,member_id,approver_member_id,tool_name,encode(payload_hash,'hex') AS payload_hash,consumed_at FROM outside_execution_approvals");
    expect(persisted.rows).toEqual([{ call_id:base.callId,member_id:base.memberId,approver_member_id:base.approverMemberId,
      tool_name:base.toolName,payload_hash:base.payloadHash,consumed_at:null }]);
    const selectors = { ...base };
    delete (selectors as Partial<typeof base>).expiresAt;
    const attempts = await Promise.allSettled([
      consumeOutsideExecutionApproval(actualStore(), selectors),
      consumeOutsideExecutionApproval(actualStore(), selectors),
    ]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await db.query("SELECT consumed_at FROM outside_execution_approvals WHERE call_id=$1", [base.callId])).rows[0]?.consumed_at).not.toBeNull();
  });

  it("reapplies migration 031 without resetting a consumed receipt", async () => {
    await recordOutsideExecutionApproval(actualStore(), base);
    const selectors = { ...base };
    delete (selectors as Partial<typeof base>).expiresAt;
    await consumeOutsideExecutionApproval(actualStore(), selectors);
    const before = await db.query("SELECT * FROM outside_execution_approvals WHERE call_id=$1", [base.callId]);

    await db.query(readFileSync(join(SQL, "031_outside_execution_approvals.sql"), "utf8"));

    const after = await db.query("SELECT * FROM outside_execution_approvals WHERE call_id=$1", [base.callId]);
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0]?.consumed_at).not.toBeNull();
  });

  it("keeps the original persisted selectors when a replay changes its payload or member", async () => {
    await recordOutsideExecutionApproval(actualStore(), base);
    await expect(recordOutsideExecutionApproval(actualStore(), { ...base, payloadHash:"b".repeat(64) })).rejects.toThrow();
    const selectors = { ...base, memberId:"member-b" };
    delete (selectors as Partial<typeof base>).expiresAt;
    await expect(consumeOutsideExecutionApproval(actualStore(), selectors)).rejects.toThrow();
    expect((await db.query("SELECT member_id,encode(payload_hash,'hex') AS payload_hash,consumed_at FROM outside_execution_approvals WHERE call_id=$1", [base.callId])).rows[0])
      .toEqual({ member_id:base.memberId,payload_hash:base.payloadHash,consumed_at:null });
  });

  it("refuses a receipt expired by the database clock", async () => {
    const expiring = { ...base,callId:"expiring-call",expiresAt:Date.now()+500 };
    await recordOutsideExecutionApproval(actualStore(), expiring);
    await new Promise(resolve => setTimeout(resolve, 650));
    const selectors = { ...expiring };
    delete (selectors as Partial<typeof base>).expiresAt;
    await expect(consumeOutsideExecutionApproval(actualStore(), selectors)).rejects.toThrow();
    expect((await db.query("SELECT consumed_at FROM outside_execution_approvals WHERE call_id=$1", [expiring.callId])).rows[0]?.consumed_at).toBeNull();
  });

  it("retains an erased approver's stable reference on another member's receipt", async () => {
    await recordOutsideExecutionApproval(actualStore(), { ...base, approverMemberId:"member-b" });
    await db.query("DELETE FROM users WHERE id='member-b'");
    expect((await db.query("SELECT member_id,approver_member_id FROM outside_execution_approvals WHERE call_id=$1", [base.callId])).rows)
      .toEqual([{ member_id:"member-a",approver_member_id:"member-b" }]);
  });

  it("deletes the owner's private receipt with the owner's custody account", async () => {
    await recordOutsideExecutionApproval(actualStore(), base);
    await db.query("DELETE FROM outside_custody_accounts WHERE account_id=$1", [base.accountId]);
    expect((await db.query("SELECT count(*)::int AS count FROM outside_execution_approvals WHERE call_id=$1", [base.callId])).rows[0]?.count).toBe(0);
  });
});
