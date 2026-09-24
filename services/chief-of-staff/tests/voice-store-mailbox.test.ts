import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadVoiceExemplars, makeDbVoiceAccess, VoiceRetrievalUnavailableError } from "../lib/voice-store.js";

/** Real Postgres, real SQL — a fake Pool never executes the migration, and the migration IS
 *  most of what is under test here (the ORB-45 "built + tested + non-functional" lesson). */
describe("voice corpus is scoped per mailbox", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    for (const file of ["../../box/sql/013_voice.sql", "../../box/sql/026_voice_per_mailbox.sql"]) {
      await pool.query(readFileSync(join(import.meta.dirname, file), "utf8"));
    }
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM voice_exemplar`);
  });

  const insert = (mailbox: string, id: string, lang: "en" | "no", text: string, included = true) =>
    pool.query(
      `INSERT INTO voice_exemplar (id, mailbox, lang, text, vector, source_message_id, included)
       VALUES ($1,$2,$3,$4,$5,$1,$6)`,
      [id, mailbox, lang, text, JSON.stringify([1, 0]), included],
    );

  it("returns only the asked-for mailbox's exemplars", async () => {
    await insert("owner@owner.example", "h1", "no", "heiberg one");
    await insert("owner@project.example", "z1", "en", "zero7 one");

    expect((await loadVoiceExemplars(pool, "owner@owner.example")).map((e) => e.text)).toEqual(["heiberg one"]);
    expect((await loadVoiceExemplars(pool, "owner@project.example")).map((e) => e.text)).toEqual(["zero7 one"]);
  });

  it("lets the same Gmail message id exist in two mailboxes without collision", async () => {
    // Gmail ids are unique only WITHIN an account. Before (mailbox, id) was the key, the
    // second upsert would have overwritten the first — one mailbox silently inheriting the
    // other's text.
    await insert("owner@owner.example", "same-id", "no", "heiberg text");
    await insert("owner@project.example", "same-id", "en", "zero7 text");

    expect((await loadVoiceExemplars(pool, "owner@owner.example"))[0]!.text).toBe("heiberg text");
    expect((await loadVoiceExemplars(pool, "owner@project.example"))[0]!.text).toBe("zero7 text");
  });

  it("keeps the retired blended corpus out of every mailbox, without deleting it", async () => {
    // The migration's own default marks pre-existing rows; assert both halves: invisible to
    // retrieval, still present on disk.
    await pool.query(
      `INSERT INTO voice_exemplar (id, lang, text, vector, source_message_id) VALUES ('legacy1','no','old blend',$1,'legacy1')`,
      [JSON.stringify([1, 0])],
    );
    await pool.query(`UPDATE voice_exemplar SET included = false WHERE mailbox = 'legacy:blended'`);

    expect(await loadVoiceExemplars(pool, "legacy:blended")).toEqual([]);
    expect(await loadVoiceExemplars(pool, "owner@owner.example")).toEqual([]);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM voice_exemplar WHERE mailbox = 'legacy:blended'`);
    expect(rows[0]!.n).toBe(1);
  });

  it("excludes rows a human switched off", async () => {
    await insert("owner@owner.example", "off", "no", "rejected", false);
    expect(await loadVoiceExemplars(pool, "owner@owner.example")).toEqual([]);
  });

  describe("failure is distinguishable from empty (ORB-119)", () => {
    it("returns [] for a mailbox with no corpus, WITHOUT billing an embedding call", async () => {
      let embedCalls = 0;
      const voice = makeDbVoiceAccess({
        db: pool, mailbox: "owner@project.example",
        embedder: { embed: async (t) => { embedCalls++; return t.map(() => [1, 0]); } },
      });
      expect(await voice.retrieve("anything", 3, "en")).toEqual([]);
      expect(embedCalls).toBe(0);
    });

    it("THROWS when the corpus exists but cannot be searched — never a silent []", async () => {
      // This is the exact shape of the six-week outage: a 401 from the embedding model
      // turning into "no similar emails found" at every call site.
      await insert("owner@owner.example", "h1", "en", "some english prose");
      const voice = makeDbVoiceAccess({
        db: pool, mailbox: "owner@owner.example",
        embedder: { embed: async () => { throw new Error("401 key not allowed to access model"); } },
      });
      await expect(voice.retrieve("anything", 3, "en")).rejects.toBeInstanceOf(VoiceRetrievalUnavailableError);
      await expect(voice.retrieve("anything", 3, "en")).rejects.toThrow(/owner@owner\.example/);
    });
  });
});
