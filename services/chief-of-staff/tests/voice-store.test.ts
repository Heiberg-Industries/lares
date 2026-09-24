import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadVoiceProfile, loadVoiceExemplars, makeDbVoiceAccess } from "../lib/voice-store.js";

/** Real, disposable Postgres — the house pattern (ORB-45 lesson): reads the SAME migrations
 *  the box runs (services/box/sql/013_voice.sql + 026_voice_per_mailbox.sql), not a
 *  hand-rolled schema guess. */
const MAILBOX = "owner@owner.example";

describe("voice-store", () => {
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
    await pool.query("TRUNCATE voice_exemplar");
    await pool.query("UPDATE voice_profile SET core='', english='', norsk='', model_en=NULL, model_no=NULL WHERE id='default'");
  });

  describe("loadVoiceProfile", () => {
    it("returns the singleton row's fields", async () => {
      await pool.query(
        `UPDATE voice_profile SET core=$1, english=$2, norsk=$3, model_en=$4, model_no=$5 WHERE id='default'`,
        ["Core.", "En.", "No.", null, "borealis-no"],
      );
      await expect(loadVoiceProfile(pool)).resolves.toEqual({
        core: "Core.", english: "En.", norsk: "No.", modelEn: null, modelNo: "borealis-no",
      });
    });
  });

  describe("loadVoiceExemplars", () => {
    it("returns only included=true rows, with vectors parsed to number[]", async () => {
      await pool.query(
        `INSERT INTO voice_exemplar (id, mailbox, lang, text, vector, included) VALUES
           ('m1',$1,'en','hello world','[1,2,3]',true),
           ('m2',$1,'no','hei der','[4,5,6]',false)`,
        [MAILBOX],
      );
      const rows = await loadVoiceExemplars(pool, MAILBOX);
      expect(rows).toEqual([{ id: "m1", text: "hello world", lang: "en", vector: [1, 2, 3] }]);
    });
  });

  describe("makeDbVoiceAccess", () => {
    const fakeEmbedder = { embed: async (t: string[]) => t.map(() => [1, 0]) };

    it("getProfile reads through to the real table", async () => {
      await pool.query(`UPDATE voice_profile SET core='C' WHERE id='default'`);
      const v = makeDbVoiceAccess({ db: pool, mailbox: MAILBOX, embedder: fakeEmbedder });
      await expect(v.getProfile()).resolves.toMatchObject({ core: "C" });
    });

    it("retrieve reads real exemplar rows and ranks with the injected embedder", async () => {
      await pool.query(
        `INSERT INTO voice_exemplar (id, mailbox, lang, text, vector) VALUES
           ('a',$1,'no','far','[0,1]'),
           ('b',$1,'no','near','[1,0]')`,
        [MAILBOX],
      );
      const v = makeDbVoiceAccess({ db: pool, mailbox: MAILBOX, embedder: fakeEmbedder });
      await expect(v.retrieve("q", 1, "no")).resolves.toEqual(["near"]);
    });
  });
});
