import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * fix round 1 (controller ruling) — `learnAllMailboxes` is not a pure factory over
 * injected deps like the other schedules' `makeXTick`, so its dependencies (Postgres,
 * `listEnrolledMailboxes`, `runVoiceLearn`) are stubbed the same way
 * `tests/meeting-followup-auto.test.ts` stubs `@lares/agent-kit/db`: hoisted `vi.mock`s, so the
 * function under test runs for real against fakes instead of live infrastructure.
 *
 * The rule under test: `learnAllMailboxes()` resolves `true` for a completed pass — zero
 * enrolled mailboxes, or at least one mailbox succeeding — and `false` only when EVERY enrolled
 * mailbox failed. A per-mailbox failure alone (one of two) still counts as completed.
 */
let listEnrolledMailboxesMock: ReturnType<typeof vi.fn>;
let runVoiceLearnMock: ReturnType<typeof vi.fn>;

const poolQueries: Array<{ sql: string; params: unknown[] | undefined }> = [];
vi.mock("@lares/agent-kit/db", () => ({
  getPool: () => ({
    query: async (sql: string, params?: unknown[]) => {
      poolQueries.push({ sql, params });
      return { rows: [{ learn_lookback_days: 365, learn_cap: 300 }] };
    },
  }),
}));
vi.mock("../lib/google.js", () => ({
  listEnrolledMailboxes: (...args: unknown[]) => listEnrolledMailboxesMock(...args),
  googleClients: () => ({ gmail: async () => ({ search: async () => [], read: async () => null }) }),
}));
vi.mock("../lib/voice-learn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/voice-learn.js")>();
  return { ...actual, runVoiceLearn: (...args: unknown[]) => runVoiceLearnMock(...args) };
});
vi.mock("../lib/gateway-provider.js", () => ({ gatewayUrl: () => "http://gateway.test", gatewayKey: () => "k" }));
let embedMock: ReturnType<typeof vi.fn>;
vi.mock("../lib/embeddings-gateway.js", () => ({ makeGatewayEmbedder: (deps: { model: string }) => ({ embed: (t: string[]) => embedMock(deps.model, t) }) }));
const gatewayCompleteMock = vi.fn(async (..._args: unknown[]) => "");
vi.mock("../lib/llm-complete.js", () => ({ gatewayComplete: (...args: unknown[]) => gatewayCompleteMock(...args) }));

const { learnAllMailboxes, setProposedFor, setStatusFor } = await import("../agent/schedules/voice-learn.js");

beforeEach(() => {
  process.env["LARES_MODEL_PREFIX"] = "lares";
  delete process.env["EMBED_MODEL"];
  embedMock = vi.fn(async () => [[0]]);
  listEnrolledMailboxesMock = vi.fn(async () => ["owner@project.example"]);
  runVoiceLearnMock = vi.fn(async () => ({ kept: 1, dropped: 0 }));
});

describe("learnAllMailboxes ( fix round 1)", () => {
  it("resolves true when zero mailboxes are enrolled — a quiet pass is a completed pass", async () => {
    listEnrolledMailboxesMock = vi.fn(async () => []);
    await expect(learnAllMailboxes()).resolves.toBe(true);
    expect(runVoiceLearnMock).not.toHaveBeenCalled();
  });

  it("resolves true when at least one enrolled mailbox succeeds, even if another fails", async () => {
    listEnrolledMailboxesMock = vi.fn(async () => ["ok@x.com", "bad@x.com"]);
    runVoiceLearnMock = vi.fn(async (deps: { mailbox: string }) => {
      if (deps.mailbox === "bad@x.com") throw new Error("gateway 500");
      return { kept: 1, dropped: 0 };
    });
    await expect(learnAllMailboxes()).resolves.toBe(true);
  });

  it("resolves false when EVERY enrolled mailbox fails — a swallowed total failure must not stamp the heartbeat", async () => {
    listEnrolledMailboxesMock = vi.fn(async () => ["bad1@x.com", "bad2@x.com"]);
    runVoiceLearnMock = vi.fn(async () => { throw new Error("gateway 500"); });
    await expect(learnAllMailboxes()).resolves.toBe(false);
  });

  it("skips plainly, once, and returns false when the gateway cannot embed — no mailbox is marked errored", async () => {
    embedMock = vi.fn(async () => { throw new Error("gateway embeddings → 400 no such model"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(learnAllMailboxes()).resolves.toBe(false);
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock.mock.calls[0]![0]).toBe("lares-embed");
    expect(runVoiceLearnMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(
      "voice-learn: the gateway did not answer for lares-embed (gateway embeddings → 400 no such model); this installation may have no embedding model yet — skipping voice learning this pass",
    );
    warn.mockRestore();
  });

  it("distils the card with the writer model", async () => {
    runVoiceLearnMock = vi.fn(async (deps: { think: (p: string) => Promise<string> }) => { await deps.think("distil prompt"); return { kept: 1, dropped: 0 }; });
    await learnAllMailboxes();
    expect(gatewayCompleteMock).toHaveBeenCalledWith("distil prompt", expect.objectContaining({ purpose: "writer" }));
  });

  it("probes with the explicit EMBED_MODEL when one is set, and with the prefix otherwise", async () => {
    process.env["LARES_MODEL_PREFIX"] = "home";
    await learnAllMailboxes();
    expect(embedMock.mock.calls[0]![0]).toBe("home-embed");
    process.env["EMBED_MODEL"] = "custom-embed";
    await learnAllMailboxes();
    expect(embedMock.mock.calls[1]![0]).toBe("custom-embed");
  });
});

// (sql/001_baseline.sql): a card per mailbox. The proposal and the learn status land on the
// MAILBOX's own voice_profile row (upserted, so a mailbox enrolled after the migration still
// gets one), never on `default` — the singleton write is how one mailbox's register became
// every mailbox's card.
describe("per-mailbox proposals and status", () => {
  beforeEach(() => { poolQueries.length = 0; });

  it("setProposedFor upserts the proposal onto the mailbox's row", async () => {
    const card = { core: "c", english: "e", norsk: "n", learnedAt: "2026-09-08T02:00:00.000Z", sampleSize: 12 };
    await setProposedFor("owner@project.example", card);
    const q = poolQueries.at(-1)!;
    expect(q.sql).toMatch(/INSERT INTO voice_profile \(id, proposed\)/);
    expect(q.sql).toMatch(/ON CONFLICT \(id\) DO UPDATE SET proposed = EXCLUDED\.proposed/);
    expect(q.sql).not.toContain("'default'");
    expect(q.params?.[0]).toBe("owner@project.example");
    expect(JSON.parse(String(q.params?.[1]))).toMatchObject({ core: "c", sampleSize: 12 });
  });

  it("setStatusFor writes the mailbox's own learn status, never default's", async () => {
    await setStatusFor("owner@owner.example", "error", "gateway down");
    const q = poolQueries.at(-1)!;
    expect(q.sql).toMatch(/INSERT INTO voice_profile \(id, learn_status, learn_message\)/);
    expect(q.sql).not.toContain("'default'");
    expect(q.params).toEqual(["owner@owner.example", "error", "gateway down"]);
  });
});

/**
 *-s4 — PIN, asserted against the source: `LEARN_HOUR` is gone (the hour is a setting now,
 * `packages/agent-kit/src/schedule-settings.ts`'s `voice-learn` key, default 4), and the live
 * tick asks `scheduleHours` before computing the slot.
 */
describe("voice-learn.ts reads its hour from the setting (-s4)", () => {
  it("carries no LEARN_HOUR, and asks scheduleHours before slotIn", async () => {
    const src = await (await import("node:fs/promises")).readFile(
      new URL("../agent/schedules/voice-learn.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("LEARN_HOUR");
    expect(src.indexOf('scheduleHours("voice-learn")')).toBeGreaterThan(-1);
    expect(src.indexOf('scheduleHours("voice-learn")')).toBeLessThan(src.lastIndexOf("slotIn("));
  });
});
