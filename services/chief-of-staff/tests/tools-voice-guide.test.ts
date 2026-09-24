import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "eve/tools";

import voiceGuide from "../catalogue/voice_guide.js";
import { getPool, closePool } from "@lares/agent-kit/db";

const ctx = {} as ToolContext;

/**
 * voice_guide never calls the embedder when there are no exemplar rows for the (filtered)
 * language — see lib/embeddings-gateway.ts's makeVoiceStore, which short-circuits before
 * ever reaching a real gateway call. That's what makes these tests safe to run without
 * network access: nothing here seeds a voice_exemplar row.
 */
describe("voice_guide", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    process.env["DATABASE_URL"] = container.getConnectionUri();
    const migration = readFileSync(join(import.meta.dirname, "../../box/sql/013_voice.sql"), "utf8");
    await getPool().query(migration);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  beforeEach(async () => {
    await getPool().query("UPDATE voice_profile SET core='', english='', norsk='', model_en=NULL, model_no=NULL WHERE id='default'");
  });

  it("is not gated — no approval config on the tool", () => {
    expect((voiceGuide as unknown as { approval?: unknown }).approval).toBeUndefined();
  });

  it("returns null voiceGuide and [] examples when no profile/exemplars are set up", async () => {
    const result = await voiceGuide.execute({ topic: "following up with a prospect", account: "owner@owner.example" }, ctx);
    // examplesUnavailable distinguishes "this mailbox has no corpus" (false, here)
    // from "the corpus could not be searched" (ORB-119).
    expect(result).toEqual({ voiceGuide: null, exampleEmails: [], examplesUnavailable: false });
  });

  it("returns the built voice block for the detected language", async () => {
    await getPool().query(
      `UPDATE voice_profile SET core='Warm, brief.', english='Sign off Best.', norsk='Avslutt Hilsen.' WHERE id='default'`,
    );
    const en = await voiceGuide.execute({ topic: "Hi there, thanks for the note", account: "owner@owner.example" }, ctx);
    expect(en.voiceGuide).toContain("Warm, brief.");
    expect(en.voiceGuide).toContain("Sign off Best.");

    const no = await voiceGuide.execute({ topic: "Hei, takk for sist", account: "owner@owner.example" }, ctx);
    expect(no.voiceGuide).toContain("Avslutt Hilsen.");
  });

  it("an explicit lang overrides detection", async () => {
    await getPool().query(`UPDATE voice_profile SET core='C', norsk='NO-only'`);
    const result = await voiceGuide.execute({ topic: "Hi there, thanks", account: "owner@owner.example", lang: "no" }, ctx);
    expect(result.voiceGuide).toContain("NO-only");
  });

  // ORB-95 — suggestedModel dropped: nothing consumed it (an agent can't switch its own
  // model mid-turn based on a tool result), so it was advice nobody could act on.
  it("does not return suggestedModel", async () => {
    await getPool().query(`UPDATE voice_profile SET model_no = 'borealis-no'`);
    const result = await voiceGuide.execute({ topic: "hei", lang: "no" }, ctx);
    expect(result).not.toHaveProperty("suggestedModel");
  });
});
