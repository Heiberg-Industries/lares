import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgGrantStore } from "@lares/agent-kit/grant-store";
import { captureWebContinuityFence, putInbox } from "../lib/web-inbox.js";
import { privateWebInboxContinuity } from "../lib/conversation-continuity.js";
import { quiet } from "./helpers/quiet-pool.js";

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "../../box/sql");
let container: StartedPostgreSqlContainer;
let pool: Pool;
let grants: PgGrantStore;
let accessRevision: number;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = quiet(new Pool({ connectionString: container.getConnectionUri() }));
  for (const name of readdirSync(sqlDir).filter(name => name.endsWith(".sql")).sort()) {
    await pool.query(readFileSync(join(sqlDir, name), "utf8"));
  }
  grants = new PgGrantStore(pool);
}, 120_000);
afterAll(async () => { await pool?.end(); await container?.stop(); });

beforeEach(async () => {
  await pool.query("DELETE FROM web_inbox; DELETE FROM connected_accounts; DELETE FROM resource_grants; DELETE FROM agent_access; DELETE FROM agent_definitions; DELETE FROM org_member_policy; DELETE FROM users; DELETE FROM orgs;");
  await pool.query(`INSERT INTO orgs(id,display_name) VALUES('org-a','Fixture');
    INSERT INTO users(id,display_name,org_id,org_role,status) VALUES
      ('member-a','Owner','org-a','owner','active'),('member-b','Member','org-a','member','active');
    INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES('member-a',NULL),('member-b',NULL);
    INSERT INTO agent_definitions(name,definition,hash,status) VALUES('helper','{"grants":[]}','fixture-hash','valid');`);
  const view = await grants.adoptAgent("member-a", { agentName: "helper", expectedDefinitionHash: "fixture-hash" }, { designatedOwnerMemberId: "member-a" });
  const shared = await grants.updateAgentAccess("member-a", { agentName: "helper", expectedRevision: view.accessRevision, grants: [
    { principal: { kind: "member", id: "member-b" }, permission: "use", expiresAt: null },
  ] });
  accessRevision = shared.accessRevision;
  await pool.query(`INSERT INTO connected_accounts
    (id,owner_member_id,connector_id,provider_issuer,provider_subject,provider_label,status,generation,lifecycle_revision)
    VALUES ('account-b','member-b','google','issuer','subject','Work','ok',1,4)`);
});

describe("web inbox continuity authority fence", () => {
  it("retires published text on revoke/regrant or account reconnect and rejects delayed stale publication", async () => {
    const now = new Date();
    const fence1 = await captureWebContinuityFence(pool, "member-b", "helper");
    expect(fence1).toBeDefined();
    await putInbox(pool, { owner: "member-b", agent: "helper", kind: "brief", title: "First", body: "old body", itemKey: "first", continuityFence: fence1 });
    expect((await privateWebInboxContinuity("member-b", "helper", now, pool)).some(line => line.includes("old body"))).toBe(true);

    // Revoke access and later grant it again. A new revision cannot adopt the old publication.
    const revoked = await grants.updateAgentAccess("member-a", { agentName: "helper", expectedRevision: accessRevision, grants: [] });
    accessRevision = revoked.accessRevision;
    expect(await privateWebInboxContinuity("member-b", "helper", now, pool)).toEqual([]);
    const regranted = await grants.updateAgentAccess("member-a", { agentName: "helper", expectedRevision: accessRevision, grants: [
      { principal: { kind: "member", id: "member-b" }, permission: "use", expiresAt: null },
    ] });
    accessRevision = regranted.accessRevision;
    expect(await privateWebInboxContinuity("member-b", "helper", now, pool)).toEqual([]);

    const fence2 = await captureWebContinuityFence(pool, "member-b", "helper");
    await pool.query("UPDATE connected_accounts SET generation=generation+1,lifecycle_revision=lifecycle_revision+1 WHERE id='account-b'");
    // A body generated under the old account epoch but published after reconnect is stamped NULL.
    await putInbox(pool, { owner: "member-b", agent: "helper", kind: "brief", title: "Delayed", body: "delayed old body", itemKey: "delayed", continuityFence: fence2 });
    expect(await privateWebInboxContinuity("member-b", "helper", now, pool)).toEqual([]);

    const fence3 = await captureWebContinuityFence(pool, "member-b", "helper");
    await putInbox(pool, { owner: "member-b", agent: "helper", kind: "brief", title: "Current", body: "current body", itemKey: "current", continuityFence: fence3 });
    expect((await privateWebInboxContinuity("member-b", "helper", now, pool)).some(line => line.includes("current body"))).toBe(true);
    await pool.query("UPDATE connected_accounts SET generation=generation+1,lifecycle_revision=lifecycle_revision+1 WHERE id='account-b'");
    expect(await privateWebInboxContinuity("member-b", "helper", now, pool)).toEqual([]);
  });
});
