/**
 * The one-time markdown-corpus importer (W3B-s8, `bin/import-conversation-logs.ts`). This file
 * is the ONLY place that ever runs the importer — always against a disposable testcontainers
 * Postgres, never a real installation's database (the importer itself is hand-run; see its own
 * header). Coverage: parsing a pre-ADR log into an entry, the origin rule for each of the three
 * shapes a legacy file can take, idempotency on a second run, and that an unparseable file is
 * reported by name rather than silently dropped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";

import { makeConversationRecord } from "@lares/agent-kit/conversation-record";
import { importConversationLogs, deriveImportKey } from "../bin/import-conversation-logs.js";

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "box", "sql");
const migration = readFileSync(join(sqlDir, "060_conversation_entries.sql"), "utf8");

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(migration);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query("TRUNCATE conversation_entries");
});

// The two fixtures are the exact bytes `lib/conversation-log.ts` used to write, pre-ADR — the
// writer's hardcoded reply label is "Saga", so that is the `agentLabel` these fixtures parse
// under (a fixture concession to frozen history, not a name the importer itself knows — see
// dream-modules.test.ts's own note on the same point).
const AGENT_LABEL = "Saga";

const HUMAN = [
  "---", "at: 2026-08-19T10:00:00.000Z", "door: slack", "principal: bendik",
  "proposals: calendar.create_event", "---", "", "**Bendik:** book the 16:30", "",
  "**Saga:** done — 16:30 on Tuesday", "",
].join("\n");
const LANED = [
  "---", "at: 2026-08-19T06:00:00.000Z", "door: telegram", "principal: bendik",
  "lane: morning-brief", "proposals: ", "---", "",
  "**morning-brief (scheduled):** Write the morning brief for today.", "",
  "**Saga:** Here is your brief.", "",
].join("\n");

const files: Record<string, string> = {
  "_meta/conversations/2026-08-19/2026-08-19T10-00-00-000Z-slack.md": HUMAN,
  "_meta/conversations/2026-08-19/2026-08-19T06-00-00-000Z-telegram.md": LANED,
};
const brain = {
  list: async () => Object.keys(files),
  read: async (p: string) => {
    const content = files[p];
    if (content === undefined) throw new Error(`ENOENT: ${p}`);
    return content;
  },
};
const deps = () => ({
  brain,
  record: makeConversationRecord(pool),
  agent: "canary",
  agentLabel: AGENT_LABEL,
  personKey: "fixture-owner",
  alreadyImported: new Set<string>(),
});
const importedRows = async () =>
  (await pool.query("SELECT turn_id, origin, lane FROM conversation_entries ORDER BY at")).rows;

describe("importing the old corpus", () => {
  it("parses a pre-ADR log into an entry, keeping the words and the proposals", async () => {
    await importConversationLogs(deps());
    const { rows } = await pool.query("SELECT * FROM conversation_entries WHERE door = 'slack'");
    expect(rows[0]).toMatchObject({
      input: "book the 16:30",
      reply: "done — 16:30 on Tuesday",
      proposals: ["calendar.create_event"],
      person_key: "fixture-owner",
      session_id: "imported",
    });
    expect(rows[0].at.toISOString()).toBe("2026-08-19T10:00:00.000Z");
  });

  // W3B-s8's correction to the plan: origin is the LEAST TRUSTED class that is honest for
  // legacy data. A scheduled lane's prompt is `system`; an exchange that has a reply is
  // `third_party` — never `agent` — because nothing records whether that reply read outside
  // content; an exchange with no reply at all is `owner`, since there is nothing else in it.
  it("stamps a laned prompt system, and a human exchange WITH a reply third_party — never agent", async () => {
    await importConversationLogs(deps());
    const { rows } = await pool.query("SELECT lane, origin FROM conversation_entries ORDER BY at");
    expect(rows).toEqual([
      { lane: "morning-brief", origin: "system" },
      { lane: null, origin: "third_party" },
    ]);
  });

  it("stamps a human exchange with NO reply owner — nothing unverifiable is in that row", async () => {
    files["_meta/conversations/2026-08-19/gated.md"] = [
      "---", "at: 2026-08-19T11:00:00.000Z", "door: slack", "principal: bendik",
      "proposals: calendar.create_event", "---", "", "**Bendik:** book the flight to NYC", "",
    ].join("\n");
    try {
      await importConversationLogs(deps());
      const { rows } = await pool.query(
        "SELECT origin FROM conversation_entries WHERE input = 'book the flight to NYC'",
      );
      expect(rows).toEqual([{ origin: "owner" }]);
    } finally {
      delete files["_meta/conversations/2026-08-19/gated.md"];
    }
  });

  it("derives a stable key from agent, timestamp and text — not the file name — so a re-run imports nothing twice", async () => {
    const first = await importConversationLogs(deps());
    const rowsAfterFirst = await importedRows();
    const second = await importConversationLogs({
      ...deps(),
      alreadyImported: new Set(rowsAfterFirst.map((r) => r.turn_id as string)),
    });
    expect(first.imported).toBe(2);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);
    expect(await importedRows()).toHaveLength(2);
  });

  it("the derived key is a pure function of agent, timestamp and text", () => {
    const a = deriveImportKey("canary", "2026-08-19T10:00:00.000Z", "hello", "hi");
    const b = deriveImportKey("canary", "2026-08-19T10:00:00.000Z", "hello", "hi");
    const c = deriveImportKey("canary", "2026-08-19T10:00:00.000Z", "hello", "different reply");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("reports an unparseable file by name instead of dropping it silently", async () => {
    files["_meta/conversations/2026-08-19/broken.md"] = "not a log";
    try {
      const r = await importConversationLogs(deps());
      expect(r.unparseable).toEqual(["_meta/conversations/2026-08-19/broken.md"]);
      expect(r.imported).toBe(2);
    } finally {
      delete files["_meta/conversations/2026-08-19/broken.md"];
    }
  });

  it("ignores anything outside _meta/conversations", async () => {
    files["_inbox/a-note.md"] = HUMAN;
    try {
      expect((await importConversationLogs(deps())).imported).toBe(2);
    } finally {
      delete files["_inbox/a-note.md"];
    }
  });

  it("--dry-run writes nothing", async () => {
    const r = await importConversationLogs({ ...deps(), dryRun: true });
    expect(r.imported).toBe(2);
    expect(await importedRows()).toEqual([]);
  });
});
