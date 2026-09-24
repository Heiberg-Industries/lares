import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  initializeInstallationSettings,
  INSTALLATION_AGENT_CEILING,
  INSTALLATION_ALIAS_PREFIX,
} from "../lib/installation-settings.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(readFileSync(new URL("../sql/040_keeper.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE settings, settings_audit RESTART IDENTITY");
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

it("initializes both missing values once and records the installer in the audit", async () => {
  const first = await initializeInstallationSettings(pool);
  expect(first).toEqual({
    aliasPrefix: INSTALLATION_ALIAS_PREFIX,
    agentCeiling: INSTALLATION_AGENT_CEILING,
    initialized: ["agents.ceiling", "models.alias_prefix"],
  });

  const second = await initializeInstallationSettings(pool);
  expect(second).toEqual({
    aliasPrefix: INSTALLATION_ALIAS_PREFIX,
    agentCeiling: INSTALLATION_AGENT_CEILING,
    initialized: [],
  });
  expect(
    (await pool.query("SELECT key, changed_by FROM settings_audit ORDER BY key")).rows,
  ).toEqual([
    { key: "agents.ceiling", changed_by: "installer" },
    { key: "models.alias_prefix", changed_by: "installer" },
  ]);
});

it("preserves an explicit lockout and an installation-specific alias prefix", async () => {
  await pool.query(
    `INSERT INTO settings (key, value, updated_by) VALUES
       ('models.alias_prefix', '"home"', 'owner'),
       ('agents.ceiling', '0', 'owner')`,
  );
  const before = await pool.query("SELECT count(*)::int AS n FROM settings_audit");

  expect(await initializeInstallationSettings(pool)).toEqual({
    aliasPrefix: "home",
    agentCeiling: 0,
    initialized: [],
  });
  expect((await pool.query("SELECT count(*)::int AS n FROM settings_audit")).rows).toEqual(
    before.rows,
  );
});

it("refuses a malformed existing value instead of disguising it with a default", async () => {
  await pool.query(
    `INSERT INTO settings (key, value, updated_by) VALUES
       ('models.alias_prefix', '"installation"', 'owner'),
       ('agents.ceiling', '1', 'owner')`,
  );
  await expect(initializeInstallationSettings(pool)).rejects.toThrow(
    "models.alias_prefix is missing or invalid",
  );
  expect(
    (await pool.query("SELECT key FROM settings WHERE key='agents.ceiling'")).rows,
  ).toEqual([{ key: "agents.ceiling" }]);
});

it("rolls back a missing default when another existing value is malformed", async () => {
  await pool.query(
    `INSERT INTO settings (key, value, updated_by)
     VALUES ('models.alias_prefix', '"installation"', 'owner')`,
  );
  await expect(initializeInstallationSettings(pool)).rejects.toThrow(
    "models.alias_prefix is missing or invalid",
  );
  expect(
    (await pool.query("SELECT key FROM settings WHERE key='agents.ceiling'")).rows,
  ).toEqual([]);
});
