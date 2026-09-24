import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  runVoiceLearn, selectExemplars, stripQuoted, parseProposedCard,
  type LearnExemplar, type SentMessage, readPaced } from "../lib/voice-learn.js";

const msg = (over: Partial<SentMessage> = {}): SentMessage => ({
  id: "m1",
  subject: "Re: pricing",
  bodyText: "Hei Jonas, takk for sist. Jeg har ordnet en ny uke med tilgang til deg, si fra hvis du trenger mer.",
  ...over,
});

describe("selectExemplars — only what Bendik actually wrote", () => {
  it("drops forwards, by subject and by body marker", () => {
    const { kept, dropped } = selectExemplars([
      msg({ id: "a", subject: "Fwd: something" }),
      msg({ id: "b", subject: "Videresendt", bodyText: "--- Forwarded message ---\nblah blah blah blah blah blah blah blah" }),
      msg({ id: "c" }),
    ]);
    expect(kept.map((m) => m.id)).toEqual(["c"]);
    expect(dropped.map((d) => d.reason)).toEqual(["forward", "forward"]);
  });

  it("drops a reply that is nothing but quoted text — otherwise the corpus learns the OTHER person's voice", () => {
    const { kept, dropped } = selectExemplars([
      msg({ id: "q", bodyText: "On Tue, 12 Aug 2026 at 09:00, Someone wrote:\n> their whole email\n> more of it" }),
    ]);
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.reason).toBe("quoted_only");
  });

  it("drops one-liners and essays — neither is his everyday email voice", () => {
    const { dropped } = selectExemplars([
      msg({ id: "s", bodyText: "Takk!" }),
      msg({ id: "l", bodyText: "word ".repeat(500) }),
    ]);
    expect(dropped.map((d) => d.reason)).toEqual(["too_short", "too_long"]);
  });

  it("keeps the prose with the quoted tail stripped, not the raw body", () => {
    const { kept } = selectExemplars([
      msg({ bodyText: "Hei! Dette er svaret mitt, og det er langt nok til aa telle skikkelig.\n\nOn Tue, Someone wrote:\n> old stuff" }),
    ]);
    expect(kept[0]!.bodyText).not.toContain("old stuff");
    expect(kept[0]!.bodyText).toContain("Dette er svaret mitt");
  });
});

describe("stripQuoted / parseProposedCard", () => {
  it("removes >-prefixed lines anywhere, not just the tail", () => {
    expect(stripQuoted("mine\n> theirs\nmine again")).toBe("mine\nmine again");
  });

  it("tolerates a ```json fence around the distilled card", () => {
    expect(parseProposedCard('```json\n{"core":"c","english":"e","norsk":"n"}\n```'))
      .toEqual({ core: "c", english: "e", norsk: "n" });
  });
});

// 2026-09-08: the owner.example relearn failed twice on Gmail's "Units per minute per user" quota —
// `listSentMessages` read up to 300 messages in a tight sequential loop. Reads are now paced in
// batches with a pause, and a quota error backs off ONCE and retries that id; a second failure
// propagates (the run is recorded as `error` on the mailbox's card, the human re-presses Relearn).
describe("readPaced — sent-mail reads that respect Gmail's per-minute quota", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  beforeEach(() => { sleeps.length = 0; });

  it("pauses after every batch, not after every read", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => `m${i}`);
    const out = await readPaced(ids, async (id) => ({ id }), { batch: 20, pauseMs: 2000, backoffMs: 60000, sleep });
    expect(out.map((m) => m.id)).toEqual(ids);
    // 45 reads in batches of 20 → pauses after read 20 and read 40, none after the last partial batch.
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("backs off once on a quota error and retries the same id", async () => {
    let calls = 0;
    const read = async (id: string) => {
      calls += 1;
      if (id === "m1" && calls === 2) throw new Error("Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'");
      return { id };
    };
    const out = await readPaced(["m0", "m1", "m2"], read, { batch: 20, pauseMs: 2000, backoffMs: 60000, sleep });
    expect(out.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
    expect(sleeps).toEqual([60000]);
  });

  it("propagates a second quota failure and any non-quota error unchanged", async () => {
    const quota = async () => { throw new Error("Quota exceeded for quota metric 'Total Query Cost'"); };
    await expect(readPaced(["m0"], quota, { batch: 20, pauseMs: 1, backoffMs: 1, sleep })).rejects.toThrow(/Quota exceeded/);
    expect(sleeps).toEqual([1]);
    const other = async () => { throw new Error("socket hang up"); };
    await expect(readPaced(["m0"], other, { batch: 20, pauseMs: 1, backoffMs: 1, sleep })).rejects.toThrow("socket hang up");
  });

  it("drops a message the read returns as null", async () => {
    const out = await readPaced(["a", "b"], async (id) => (id === "a" ? null : { id }), { batch: 20, pauseMs: 1, backoffMs: 1, sleep });
    expect(out.map((m) => m.id)).toEqual(["b"]);
  });
});

describe("runVoiceLearn", () => {
  function harness(messages: SentMessage[], over: Partial<Parameters<typeof runVoiceLearn>[0]> = {}) {
    const upserted: LearnExemplar[] = [];
    const statuses: string[] = [];
    const deps = {
      mailbox: "owner@owner.example",
      listSentMessages: async () => messages,
      embedder: { embed: vi.fn(async (t: string[]) => t.map((_, i) => [i, 0.5])) },
      think: vi.fn(async () => '{"core":"c","english":"e","norsk":"n"}'),
      upsertExemplar: async (e: LearnExemplar) => { upserted.push(e); },
      setProposed: vi.fn(async () => {}),
      setStatus: async (s: string) => { statuses.push(s); },
      now: () => new Date("2026-08-18T04:00:00Z"),
      ...over,
    };
    return { deps, upserted, statuses };
  }

  it("stamps every exemplar with its OWN mailbox — the whole point of the split", async () => {
    const { deps, upserted } = harness([msg({ id: "a" }), msg({ id: "b" })], { mailbox: "owner@project.example" });
    await runVoiceLearn(deps as never);
    expect(upserted.map((e) => e.mailbox)).toEqual(["owner@project.example", "owner@project.example"]);
  });

  it("batches the embedding call instead of one billed round trip per email", async () => {
    const many = Array.from({ length: 70 }, (_, i) => msg({ id: `m${i}` }));
    const { deps, upserted } = harness(many);
    await runVoiceLearn(deps as never);
    expect(upserted).toHaveLength(70);
    // 70 emails at a batch of 32 → 3 calls, not 70.
    expect(deps.embedder.embed).toHaveBeenCalledTimes(3);
  });

  it("pairs each email with ITS OWN vector across a batch boundary", async () => {
    // A mis-pairing here would be invisible in production and would retrieve confidently
    // wrong examples, so it is pinned rather than trusted.
    const many = Array.from({ length: 40 }, (_, i) => msg({ id: `m${i}`, bodyText: `Hei dette er epost nummer ${i} og den er lang nok til aa telle med.` }));
    const { deps, upserted } = harness(many, {
      embedder: { embed: async (t: string[]) => t.map((text) => [text.length]) },
    });
    await runVoiceLearn(deps as never);
    for (const e of upserted) expect(e.vector[0]).toBe(e.text.length);
  });

  it("refuses rather than mis-pairs when the embedder returns too few vectors", async () => {
    const { deps, statuses } = harness([msg({ id: "a" }), msg({ id: "b" })], {
      embedder: { embed: async () => [[1, 2]] },   // 1 vector for 2 inputs
    });
    await expect(runVoiceLearn(deps as never)).rejects.toThrow(/returned 1 vectors for 2 inputs/);
    expect(statuses).toEqual(["running", "error"]);
  });

  it("does not ask the model to invent a voice from an empty corpus", async () => {
    const { deps } = harness([msg({ bodyText: "Takk!" })]);   // all dropped as too_short
    const res = await runVoiceLearn(deps as never);
    expect(res.kept).toBe(0);
    expect(deps.think).not.toHaveBeenCalled();
    expect(deps.setProposed).not.toHaveBeenCalled();
  });

  it("records the failure on the profile so the console can show it, then rethrows", async () => {
    const { deps, statuses } = harness([msg()], { think: async () => { throw new Error("gateway down"); } });
    await expect(runVoiceLearn(deps as never)).rejects.toThrow("gateway down");
    expect(statuses).toEqual(["running", "error"]);
  });

  // ORB-176: one card per mailbox. The distillation must describe how Bendik writes FROM THIS
  // mailbox — the old prompt described "his email voice" over whichever mailbox ran last, which
  // is how a project.example sales register ended up as the card for owner.example mail.
  it("asks the model to describe the voice of THIS mailbox, naming it", async () => {
    const { deps } = harness([msg()], { mailbox: "owner@owner.example" });
    await runVoiceLearn(deps as never);
    const prompt = String(deps.think.mock.calls[0]![0]);
    expect(prompt).toContain("owner@owner.example");
    expect(prompt).toMatch(/from this mailbox/i);
  });

  it("proposes the card but NEVER writes the active one — acceptance stays human", async () => {
    const { deps } = harness([msg()]);
    await runVoiceLearn(deps as never);
    expect(deps.setProposed).toHaveBeenCalledWith(
      expect.objectContaining({ core: "c", english: "e", norsk: "n", sampleSize: 1 }),
    );
  });
});

describe("claimRelearnRequest — the console's button must not be decoration", () => {
  // Against real Postgres: the claim is a conditional UPDATE, and a fake Pool would never
  // execute it (ORB-45).
  it("claims a pending request exactly once, and clears it BEFORE the run", async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const { Pool } = await import("pg");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    try {
      await pool.query(readFileSync(join(import.meta.dirname, "../../box/sql/013_voice.sql"), "utf8"));

      const claim = async () => {
        const { rowCount } = await pool.query(
          `UPDATE voice_profile SET relearn_requested_at = NULL
           WHERE id = 'default' AND relearn_requested_at IS NOT NULL`,
        );
        return (rowCount ?? 0) > 0;
      };

      expect(await claim()).toBe(false);                       // nothing pending

      await pool.query(`UPDATE voice_profile SET relearn_requested_at = now() WHERE id = 'default'`);
      expect(await claim()).toBe(true);                        // the console's request
      // Cleared first, so a failing run cannot re-fire every minute against a billed
      // gateway — the Aug-14/15 incident shape.
      expect(await claim()).toBe(false);
    } finally {
      await pool.end();
      await container.stop();
    }
  }, 120_000);
});
