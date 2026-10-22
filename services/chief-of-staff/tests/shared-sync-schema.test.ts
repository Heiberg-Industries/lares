import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import { makePgSeenStore } from "../lib/karakeep.js";
import { ensureRouteTables, makeRouteStore } from "../lib/route-store.js";
import { quiet } from "./helpers/quiet-pool.js";

const SHARED_SYNC_SCHEMA_SQL = readFileSync(new URL("../../box/sql/027_shared_sync_schema.sql", import.meta.url), "utf8");
const EXISTING_CURSOR = "2026-08-21T09:00:00.000Z";

describe("offline shared sync and CRM schema", () => {
  let container: StartedPostgreSqlContainer;
  let schemaOwner: Pool;
  let app: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    schemaOwner = quiet(new Pool({ connectionString: container.getConnectionUri() }));
    await schemaOwner.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await schemaOwner.query(SHARED_SYNC_SCHEMA_SQL);
    await schemaOwner.query("INSERT INTO karakeep_seen (id) VALUES ('existing-bookmark')");
    await schemaOwner.query("INSERT INTO route_cursor (id, cursor_at) VALUES (1, $1)", [EXISTING_CURSOR]);
    await schemaOwner.query(
      `INSERT INTO route_proposals (person_id, brand, proposed_stage, signal_ref, confidence, status)
       VALUES ('external-contact-42', 'ALPHA', 'PROPOSAL', 'msg:existing', 0.7, 'skipped')`,
    );

    // Reapplying the offline migration must preserve existing dedup, cursor, and CRM rows.
    await schemaOwner.query(SHARED_SYNC_SCHEMA_SQL);
    await schemaOwner.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await schemaOwner.query("CREATE ROLE shared_sync_app LOGIN PASSWORD 'fixture-only-password'");
    await schemaOwner.query("GRANT USAGE ON SCHEMA public TO shared_sync_app");
    await schemaOwner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
       public.karakeep_seen, public.route_cursor, public.route_proposals TO shared_sync_app`,
    );

    const appUri = new URL(container.getConnectionUri());
    appUri.username = "shared_sync_app";
    appUri.password = "fixture-only-password";
    app = quiet(new Pool({ connectionString: appUri.toString() }));
  }, 120_000);

  afterAll(async () => {
    await app?.end();
    await schemaOwner?.end();
    await container?.stop();
  });

  it("preserves existing rows and supports readiness plus ordinary DML as a non-owner login", async () => {
    const { rows: login } = await app.query("SELECT current_user AS user");
    expect(login[0].user).toBe("shared_sync_app");

    await makePgSeenStore(app).ensure();
    await ensureRouteTables(app);

    const { rows: beforeWrites } = await schemaOwner.query(
      `SELECT s.id AS bookmark, s.at, c.cursor_at, p.status, p.signal_ref
         FROM karakeep_seen s
         CROSS JOIN route_cursor c
         CROSS JOIN route_proposals p
        WHERE s.id = 'existing-bookmark' AND p.signal_ref = 'msg:existing'`,
    );
    expect(beforeWrites).toHaveLength(1);
    expect(beforeWrites[0].bookmark).toBe("existing-bookmark");
    expect(beforeWrites[0].at).toBeInstanceOf(Date);
    expect((beforeWrites[0].cursor_at as Date).toISOString()).toBe(EXISTING_CURSOR);
    expect(beforeWrites[0].status).toBe("skipped");
    expect(beforeWrites[0].signal_ref).toBe("msg:existing");

    const seen = makePgSeenStore(app);
    expect(await seen.isSeen("existing-bookmark")).toBe(true);
    await seen.markSeen("new-bookmark");
    expect(await seen.isSeen("new-bookmark")).toBe(true);
    await seen.markSeen("new-bookmark");
    const { rows: duplicateSeen } = await app.query("SELECT count(*)::int AS n FROM karakeep_seen WHERE id = 'new-bookmark'");
    expect(duplicateSeen[0].n).toBe(1);
    await app.query("DELETE FROM karakeep_seen WHERE id = 'new-bookmark'");
    expect(await seen.isSeen("new-bookmark")).toBe(false);

    const route = makeRouteStore(app);
    expect(await route.getCursor()).toBe(EXISTING_CURSOR);
    await expect(app.query("INSERT INTO route_cursor (id, cursor_at) VALUES (2, now())"))
      .rejects.toThrow(/route_cursor_singleton|check constraint/i);
    await route.setCursor("2026-08-22T10:30:00.000Z");
    expect(await route.getCursor()).toBe("2026-08-22T10:30:00.000Z");
    expect(await route.alreadyProposed({ personId: "external-contact-42", signalRef: "msg:existing" })).toBe(true);
    expect(await route.proposedSince({ personId: "external-contact-42", brand: "ALPHA", sinceIso: "2026-08-20T00:00:00.000Z" })).toBe(true);

    const proposal = await route.recordProposal({
      personId: "external-contact-43",
      brand: "BETA",
      proposedStage: "MEETING",
      signalRef: "msg:new",
      confidence: 0.85,
    });
    expect(await route.alreadyProposed({ personId: "external-contact-43", signalRef: "msg:new" })).toBe(true);
    await route.markResolved(proposal.id, "skipped");
    const { rows: updated } = await app.query("SELECT status FROM route_proposals WHERE id = $1", [proposal.id]);
    expect(updated[0].status).toBe("skipped");
    await app.query("DELETE FROM route_proposals WHERE id = $1", [proposal.id]);
    const { rows: deleted } = await app.query("SELECT 1 FROM route_proposals WHERE id = $1", [proposal.id]);
    expect(deleted).toHaveLength(0);

    const { rows: preserved } = await schemaOwner.query(
      `SELECT s.id AS bookmark, c.cursor_at, p.status, p.signal_ref
         FROM karakeep_seen s
         CROSS JOIN route_cursor c
         CROSS JOIN route_proposals p
        WHERE s.id = 'existing-bookmark' AND p.signal_ref = 'msg:existing'`,
    );
    expect(preserved).toHaveLength(1);
    expect(preserved[0].bookmark).toBe("existing-bookmark");
    expect((preserved[0].cursor_at as Date).toISOString()).toBe("2026-08-22T10:30:00.000Z");
    expect(preserved[0].status).toBe("skipped");
    expect(preserved[0].signal_ref).toBe("msg:existing");

    const { rows: owners } = await schemaOwner.query(
      `SELECT c.relname, c.relowner::regrole::text AS owner
         FROM pg_class c
        WHERE c.oid IN (
          'public.karakeep_seen'::regclass,
          'public.route_cursor'::regclass,
          'public.route_proposals'::regclass
        )`,
    );
    expect(owners).toHaveLength(3);
    expect(owners.every((row) => row.owner !== "shared_sync_app")).toBe(true);

    await expect(app.query("CREATE TABLE public.shared_sync_app_ddl_probe (id integer)"))
      .rejects.toThrow(/permission denied/i);
    for (const table of ["karakeep_seen", "route_cursor", "route_proposals"]) {
      await expect(app.query(`ALTER TABLE public.${table} ADD COLUMN ddl_probe integer`))
        .rejects.toThrow(/must be owner/i);
      await expect(app.query(`TRUNCATE TABLE public.${table}`))
        .rejects.toThrow(/permission denied/i);
    }
  });
});
