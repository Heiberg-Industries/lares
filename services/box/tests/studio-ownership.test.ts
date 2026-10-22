import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPerson } from "../lib/export-person.js";
import { erasePerson } from "../lib/erase-person.js";
import { startThreeSpellingsDb, FIXTURE_OWNER, FIXTURE_SECOND, type TestDb } from "./helpers/three-spellings.js";
import { makeStudioStore } from "../../creative/lib/studio/store.js";
import type { StudioRun } from "../../creative/lib/studio/types.js";

const INCARNATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVISION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENV = {
  LARES_AGENT_NAME: "studio-fixture",
  LARES_AGENT_INCARNATION: INCARNATION,
  LARES_SLACK_PRINCIPAL: "U_fixture",
  LARES_SLACK_CLAIM_REVISION: REVISION,
};
const APPROVER = { authenticator: "slack-webhook", userId: "U_fixture" };
const RUN: StudioRun = {
  brief: "A private fixture brief",
  consensus: "A fixture grounding note",
  spread: [{ id: "fixture-idea", lens: "fixture", title: "An idea", body: "Fixture content",
    oddsTypical: 0.2, coherence: 0.9, novelty: 0.8, relevance: 0.7, kind: "outlier", rationale: "fixture" }],
};

let db: TestDb;
afterEach(async () => { if (db) await db.stop(); });

describe("studio ownership migration and store", () => {
  it("retains legacy history without attribution, refuses ownerless writes and rechecks single-use ownership", async () => {
    db = await startThreeSpellingsDb({ vaultAreas: false, beforeMigration: async (pool, migration) => {
      if (migration !== "028_studio_ownership.sql") return;
      await pool.query(`CREATE TABLE studio_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brief text NOT NULL, consensus text NOT NULL,
        spread jsonb NOT NULL, picks jsonb, principal text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
      await pool.query(`INSERT INTO studio_runs(brief,consensus,spread,principal)
        VALUES('legacy private brief','legacy grounding','[{"body":"legacy content"}]'::jsonb,'U_legacy')`);
    }});

    const legacyBefore = (await db.pool.query(`SELECT brief,consensus,spread,principal FROM studio_runs WHERE owner_member_id IS NULL`)).rows;
    expect(legacyBefore).toEqual([{ brief: "legacy private brief", consensus: "legacy grounding",
      spread: [{ body: "legacy content" }], principal: "U_legacy" }]);

    // Reapplication preserves the unknown row and the trigger; no backfill or guard bypass.
    await db.pool.query(readFileSync(join(__dirname, "../sql/028_studio_ownership.sql"), "utf8"));
    await expect(db.pool.query(`INSERT INTO studio_runs(brief,consensus,spread,principal)
      VALUES('unowned','grounding','[]'::jsonb,'U_fixture')`)).rejects.toMatchObject({ code: "23514" });
    const legacyId = (await db.pool.query("SELECT id FROM studio_runs WHERE owner_member_id IS NULL")).rows[0].id;
    await expect(db.pool.query("UPDATE studio_runs SET owner_member_id=$1 WHERE id=$2", [FIXTURE_OWNER, legacyId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(db.pool.query("UPDATE studio_runs SET owner_member_id=$1 WHERE owner_member_id=$2", [FIXTURE_SECOND, FIXTURE_OWNER]))
      .rejects.toMatchObject({ code: "23514" });

    const tempParent = mkdtempSync(join(tmpdir(), "studio-ownership-export-"));
    const outDir = join(tempParent, "export");
    const exported = await exportPerson(db.pool, { person: FIXTURE_OWNER, outDir, vaults: [] });
    expect(exported.refusals.join(" ")).toMatch(/studio history contains records with no recorded owner/i);
    expect((await import("node:fs")).existsSync(outDir)).toBe(false);
    rmSync(tempParent, { recursive: true, force: true });
    expect((await erasePerson(db.pool, { person: FIXTURE_OWNER, dryRun: true })).refusals.join(" "))
      .toMatch(/studio history contains records with no recorded owner/i);

    await db.pool.query("INSERT INTO orgs(id,display_name) VALUES('fixture-org','Fixture organisation')");
    await db.pool.query("UPDATE users SET org_id='fixture-org',org_role='owner' WHERE id=$1", [FIXTURE_OWNER]);
    await db.pool.query(`INSERT INTO agent_definitions(name,definition,hash,status)
      VALUES('studio-fixture',$1::jsonb,'definition-a','valid')`, [JSON.stringify({ name: "studio-fixture", doors: [{ kind: "slack", enabled: true }] })]);
    await db.pool.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,
      runtime_control_token,state,pending,applied_definition)
      VALUES('studio-fixture','127.0.0.9','studio-fixture','owned',$1::uuid,$1::uuid,'ready',false,$2::jsonb)`,
      [INCARNATION, JSON.stringify({ name: "studio-fixture", doors: [{ kind: "slack", enabled: true }] })]);
    await db.pool.query("INSERT INTO agent_doors(agent,kind,enabled) VALUES('studio-fixture','slack',true)");
    await db.pool.query(`INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,
      principal,org,claimed_at,applied_revision,applied_connection)
      VALUES('studio-fixture','slack',$1::uuid,$2::uuid,' owner@fixture.test ','U_fixture','fixture-org',
        now(),$2::uuid,jsonb_build_object('kind','slack','principal','U_fixture','revision',$2::text,'owner_email',' owner@fixture.test '))`,
      [INCARNATION, REVISION]);

    const storeEnv = { ...ENV, SLACK_ALLOWED_USER_IDS: "U_fixture" };
    const store = makeStudioStore(db.pool, storeEnv);
    await db.pool.query(`UPDATE agent_definitions SET definition='{"name":"studio-fixture","doors":[{"kind":"slack","enabled":true}],"pending":true}'::jsonb,
      hash='definition-unapplied' WHERE name='studio-fixture'`);
    await expect(store.captureOwner(APPROVER)).rejects.toThrow(/authority/i);
    await db.pool.query(`UPDATE agent_definitions SET definition=$1::jsonb,hash='definition-a' WHERE name='studio-fixture'`,
      [JSON.stringify({ name: "studio-fixture", doors: [{ kind: "slack", enabled: true }] })]);
    await db.pool.query(`UPDATE agent_door_connections SET applied_connection=jsonb_set(applied_connection,'{principal}','"U_stale"')
      WHERE agent='studio-fixture' AND kind='slack'`);
    await expect(store.captureOwner(APPROVER)).rejects.toThrow(/authority/i);
    await db.pool.query(`UPDATE agent_door_connections SET applied_connection=jsonb_build_object(
      'kind','slack','principal','U_fixture','revision',$1::uuid::text,'owner_email',' owner@fixture.test ',
      'org','fixture-org','mailbox',NULL),claimed_at=NULL WHERE agent='studio-fixture' AND kind='slack'`, [REVISION]);
    await expect(store.captureOwner(APPROVER)).rejects.toThrow(/authority/i);
    await db.pool.query("UPDATE agent_door_connections SET claimed_at=now() WHERE agent='studio-fixture' AND kind='slack'");
    const capture = await store.captureOwner(APPROVER);
    const otherStore = makeStudioStore(db.pool, storeEnv);
    await expect(otherStore.recordRun(RUN, capture)).rejects.toThrow(/authority/i);
    const saved = await store.recordRun(RUN, capture);
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect((await db.pool.query("SELECT owner_member_id,principal,brief FROM studio_runs WHERE id=$1", [saved.id])).rows)
      .toEqual([{ owner_member_id: FIXTURE_OWNER, principal: "U_fixture", brief: RUN.brief }]);
    await expect(store.recordRun(RUN, capture)).rejects.toThrow(/authority/i);

    const refreshed = await store.captureOwner(APPROVER);
    await db.pool.query("UPDATE agent_definitions SET valid_at=now(),checked_at=now() WHERE name='studio-fixture'");
    await expect(store.recordRun(RUN, refreshed)).resolves.toHaveProperty("id");

    const changedDefinition = await store.captureOwner(APPROVER);
    await db.pool.query(`UPDATE agent_definitions SET definition='{"name":"studio-fixture","doors":[{"kind":"slack","enabled":true}],"changed":true}'::jsonb,
      hash='definition-b' WHERE name='studio-fixture'`);
    await expect(store.recordRun(RUN, changedDefinition)).rejects.toThrow(/authority/i);

    const currentDefinition = { name: "studio-fixture", doors: [{ kind: "slack", enabled: true }], changed: true };
    await db.pool.query("UPDATE agent_resources SET applied_definition=$1::jsonb WHERE name='studio-fixture'", [JSON.stringify(currentDefinition)]);
    let loseCommitAcknowledgement = false;
    const uncertainPool = {
      query: db.pool.query.bind(db.pool),
      connect: async () => {
        const client = await db.pool.connect();
        return {
          query: async (query: string | { text: string }, values?: unknown[]) => {
            const result = await client.query(query as never, values as never);
            if (loseCommitAcknowledgement && result.command === "COMMIT") {
              loseCommitAcknowledgement = false;
              throw new Error("fixture lost COMMIT acknowledgement");
            }
            return result;
          },
          release: client.release.bind(client),
        };
      },
    };
    const uncertainStore = makeStudioStore(uncertainPool, storeEnv);
    const uncertainStoreCapture = await uncertainStore.captureOwner(APPROVER);
    loseCommitAcknowledgement = true;
    await expect(uncertainStore.recordRun(RUN, uncertainStoreCapture)).rejects.toThrow();
    await expect(uncertainStore.recordRun(RUN, uncertainStoreCapture)).rejects.toThrow(/authority/i);
    expect((await db.pool.query("SELECT count(*)::int AS count FROM studio_runs WHERE brief=$1", [RUN.brief])).rows[0].count).toBe(3);

    let locked!: () => void;
    let releaseLock!: () => void;
    const lockReached = new Promise<void>(resolve => { locked = resolve; });
    const lockReleased = new Promise<void>(resolve => { releaseLock = resolve; });
    const racingPool = {
      query: db.pool.query.bind(db.pool),
      connect: async () => {
        const client = await db.pool.connect();
        return {
          query: async (query: string | { text: string }, values?: unknown[]) => {
            const sql = typeof query === "string" ? query : query.text;
            const result = await client.query(query as never, values as never);
            if (/FOR SHARE OF u,r,a,d,c/.test(sql)) {
              locked();
              await lockReleased;
            }
            return result;
          },
          release: client.release.bind(client),
        };
      },
    };
    const racingStore = makeStudioStore(racingPool, storeEnv);
    const racingCapturePromise = racingStore.captureOwner(APPROVER);
    const writer = await db.pool.connect();
    try {
      await lockReached;
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout='100ms'");
      await expect(writer.query(`UPDATE agent_door_connections SET webhook_set_at=now()
        WHERE agent='studio-fixture' AND kind='slack'`)).rejects.toMatchObject({ code: "55P03" });
      await writer.query("ROLLBACK");
    } finally {
      writer.release();
      releaseLock();
    }
    const racedCapture = await racingCapturePromise;
    await db.pool.query("UPDATE agent_door_connections SET principal='U_changed' WHERE agent='studio-fixture' AND kind='slack'");
    await expect(racingStore.recordRun(RUN, racedCapture)).rejects.toThrow(/authority/i);
    await db.pool.query(`UPDATE agent_door_connections SET principal='U_fixture',applied_connection=jsonb_build_object(
      'kind','slack','principal','U_fixture','revision',$1::uuid::text,'owner_email',' owner@fixture.test ',
      'org','fixture-org','mailbox',NULL) WHERE agent='studio-fixture' AND kind='slack'`, [REVISION]);

    await db.pool.query("UPDATE users SET org_id='fixture-org',org_role='owner' WHERE id=$1", [FIXTURE_SECOND]);
    const removedMemberCapture = await store.captureOwner(APPROVER);
    await db.pool.query("UPDATE users SET status='removed' WHERE id=$1", [FIXTURE_OWNER]);
    await expect(store.recordRun(RUN, removedMemberCapture)).rejects.toThrow(/authority/i);
    await db.pool.query("UPDATE users SET status='active' WHERE id=$1", [FIXTURE_OWNER]);

    const stale = await store.captureOwner(APPROVER);
    await db.pool.query("UPDATE agent_resources SET pending=true WHERE name='studio-fixture'");
    await expect(store.recordRun(RUN, stale)).rejects.toThrow(/authority/i);
    await expect(store.recordRun(RUN, stale)).rejects.toThrow(/authority/i);

    const noOwnerStore = makeStudioStore(db.pool, { ...ENV, LARES_SLACK_PRINCIPAL: "U_unmatched", SLACK_ALLOWED_USER_IDS: "U_unmatched" });
    await expect(noOwnerStore.captureOwner({ authenticator: "slack-webhook", userId: "U_unmatched" })).rejects.toThrow(/authority/i);
  }, 240_000);
});
