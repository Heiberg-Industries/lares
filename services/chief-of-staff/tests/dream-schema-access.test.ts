import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { quiet } from "./helpers/quiet-pool.js";

import { ensureDreamTables, makeDreamStore } from "../lib/dream/store.js";
import type { Observation } from "../lib/dream/reflect.js";

const DREAM_SCHEMA_SQL = readFileSync(new URL("../../box/sql/026_dream_schema.sql", import.meta.url), "utf8");

describe("dream schema access for a non-owner login", () => {
  let container: StartedPostgreSqlContainer;
  let schemaOwner: Pool;
  let app: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    schemaOwner = quiet(new Pool({ connectionString: container.getConnectionUri() }));

    // This login owns the schema objects. The application login receives ordinary DML grants only.
    await schemaOwner.query(DREAM_SCHEMA_SQL);
    await schemaOwner.query("CREATE ROLE dream_app LOGIN PASSWORD 'fixture-only-password'");
    await schemaOwner.query("GRANT USAGE ON SCHEMA public TO dream_app");
    await schemaOwner.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dream_observations, public.dream_preferences TO dream_app",
    );

    const appUri = new URL(container.getConnectionUri());
    appUri.username = "dream_app";
    appUri.password = "fixture-only-password";
    app = quiet(new Pool({ connectionString: appUri.toString() }));
  }, 120_000);

  afterAll(async () => {
    await app?.end();
    await schemaOwner?.end();
    await container?.stop();
  });

  it("runs readiness and store CRUD with ordinary grants while rejecting schema changes", async () => {
    const { rows } = await app.query("SELECT current_user AS user");
    expect(rows[0].user).toBe("dream_app");
    await ensureDreamTables(app);

    const store = makeDreamStore(app, "fixture-owner");
    const observation: Observation = {
      text: "uses concise updates",
      kind: "preference",
      subject: "communication",
      confidence: 0.5,
      evidenceRefs: [],
      origin: "owner",
    };
    const recorded = await store.record(observation, "schema-access-test", "owner");
    expect(recorded.owner).toBe("fixture-owner");

    const oldPreference = await store.addPreference({
      text: "prefers weekly updates",
      kind: "preference",
      subject: "communication",
      confidence: 0.6,
      origin: "owner",
    });
    const currentPreference = await store.addPreference({
      text: "prefers brief weekly updates",
      kind: "preference",
      subject: "communication",
      confidence: 0.8,
      origin: "owner",
    });
    await store.supersede(oldPreference.id, currentPreference.id);
    expect((await store.activePreferences()).map((row) => row.id)).toEqual([currentPreference.id]);

    // The role can remove its disposable fixture row as part of ordinary DML.
    const deleted = await app.query("DELETE FROM dream_observations WHERE id = $1", [recorded.id]);
    expect(deleted.rowCount).toBe(1);

    const { rows: owners } = await schemaOwner.query(
      "SELECT relowner::regrole::text AS owner FROM pg_class WHERE oid = 'public.dream_observations'::regclass",
    );
    expect(owners[0].owner).not.toBe("dream_app");
    await expect(app.query("CREATE TABLE public.dream_app_ddl_probe (id integer)"))
      .rejects.toThrow(/permission denied/i);
    await expect(app.query("ALTER TABLE public.dream_observations ADD COLUMN ddl_probe integer"))
      .rejects.toThrow(/must be owner/i);
  });
});
