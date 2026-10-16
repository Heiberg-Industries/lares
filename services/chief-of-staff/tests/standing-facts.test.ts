/**
 * — the store, the two tools, and the per-turn injection, against a REAL disposable
 * Postgres running the REAL migration file (the house pattern, lesson: a fake Pool that
 * never executes SQL is the "built+tested+non-functional" defect class this project has already
 * been bitten by). `services/box/sql/002_standing_facts.sql` is read from disk, so a migration that does not
 * apply cleanly fails here rather than on the box.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "eve/tools";
import type { DynamicResolveContext } from "eve/instructions";
import { denylistPatterns } from "./helpers/denylist";

import { getPool, closePool } from "@lares/agent-kit/db";
import { quiet } from "./helpers/quiet-pool.js";
import { taintTurn, resetTaintForTests } from "@lares/agent-kit/origin-taint";
import { recordForgotten } from "@lares/agent-kit/forget-ledger";
import { withTimeout } from "../lib/timeout.js";
import { configuredOwnerId } from "../lib/identity-client.js";
import {
  MAX_FACT_LENGTH,
  MAX_STANDING_FACTS,
  RETIRED_FACTS_LIMIT,
  SHELF_OF_CATEGORY,
  STANDING_FACT_CATEGORIES,
  STANDING_FACTS_TIMEOUT_MS,
  UnknownFactError,
  forgetFact,
  listActiveFacts,
  listRetiredFacts,
  rejectFact,
  rememberFact,
  shelfOf,
  standingFactsMarkdown,
  supersedeFact,
} from "../lib/standing-facts.js";
import remember from "../catalogue/remember.js";
import forget from "../catalogue/forget.js";
import standingFactsInstructions from "../agent/instructions/standing-facts.js";

/** `services/box/sql/001_baseline.sql`, verbatim in shape (id, owner, kind, match_hash,
 *  forgotten_at, reason; the same CHECK constraints and the same unique index) — mirrored inline
 *  the way `packages/agent-kit/tests/forget-ledger.test.ts` does, so this file needs no dependency
 *  on `services/box`. `forgetFact`'s ledger writer needs the real table to write into. */
const FORGET_LEDGER_SQL = `
  CREATE TABLE forget_ledger (
    id           bigserial   PRIMARY KEY,
    owner        text        NOT NULL,
    kind         text        NOT NULL,
    match_hash   text        NOT NULL,
    forgotten_at timestamptz NOT NULL DEFAULT now(),
    reason       text        NOT NULL,
    CONSTRAINT forget_ledger_kind_check CHECK (kind IN ('fact', 'note', 'preference')),
    CONSTRAINT forget_ledger_reason_check CHECK (reason IN ('forget', 'erase-person')),
    CONSTRAINT forget_ledger_match_hash_check CHECK (match_hash ~ '^[0-9a-f]{64}$')
  );
  CREATE UNIQUE INDEX forget_ledger_one_per_thing_idx ON forget_ledger (owner, kind, match_hash);
`;

/**
 * WHO is in the turn. Both tools now require an allowlisted HUMAN on `ctx.session.auth.current`
 * (review fix, Finding 1) — the same allowlist `lib/approvals.ts` checks for a gated write — so
 * every context here has to declare one, and the ones that must NOT be able to write declare
 * theirs too.
 */
const OWNER_SLACK = "U_EXAMPLE_OWNER";
const OWNER_TELEGRAM = "42424242";

function slackAuth(userId: string) {
  return {
    attributes: { user_id: userId, channel_id: "D123", thread_ts: "1.0" },
    authenticator: "slack-webhook",
    principalId: `slack:T1:${userId}`,
    principalType: "user",
  };
}

function telegramAuth(userId: string) {
  return { attributes: { user_id: Number(userId) }, authenticator: "telegram-webhook", principalType: "user" };
}

/** eve's own schedule-dispatch principal, verbatim (node_modules/eve/docs/tools/
 *  human-in-the-loop.md) — what BOTH brief turns run as. Nothing it says is the owner's words. */
const APP_AUTH = { authenticator: "app", principalId: "eve:app", principalType: "runtime" };

function ctxFor(auth: unknown): ToolContext {
  return {
    session: { id: "wrun_test", turn: { id: "turn_42", sequence: 1 }, auth: { current: auth, initiator: auth } },
  } as unknown as ToolContext;
}

/** The normal case: the owner, on Slack, having just said something. Carries the turn id that
 *  `remember` stamps as the fact's provenance. */
const ctx = ctxFor(slackAuth(OWNER_SLACK));

/** Matches `ctx.session.id` / `ctx.session.turn.id` exactly — `turnKeyFrom(ctx)` inside
 *  `remember.ts` reads those same two fields, so a taint set under any other pair of ids
 *  would never be seen by the tool under test. */
const CTX_TURN_KEY = { sessionId: "wrun_test", turnId: "turn_42" };

/**
 * What eve calls when a conversation STARTS (W4B-s2 — the block is built once per session and
 * then held byte-stable for it, because eve merges every dynamic instruction into one cached
 * system message). Every call here therefore uses a FRESH session id: each assertion below is
 * about what a new conversation is given, which is exactly what the resolver answers. Holding
 * one id across calls would return the first block forever, which is the behaviour
 * `tests/memory-core.test.ts` pins on purpose.
 *
 * Loosely typed on purpose: the point of the call is the RUNTIME behaviour of the resolver (it
 * must resolve, and it must never throw), and pinning the framework's exact handler arity in a
 * cast here would break on an eve upgrade for no gain.
 */
let sessionSeq = 0;
async function injected(): Promise<string> {
  const handler = standingFactsInstructions.events["session.started"] as unknown as
    | ((event: unknown, ctx: unknown) => Promise<{ markdown: string }>)
    | undefined;
  if (!handler) throw new Error("session.started handler missing");
  const resolveCtx = {
    session: { id: `wrun_test_${++sessionSeq}` },
    channel: {},
    messages: [],
  } as unknown as DynamicResolveContext;
  return (await handler(undefined, resolveCtx)).markdown;
}

describe("standing facts", () => {
  let container: StartedPostgreSqlContainer;
  let dbUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    dbUrl = container.getConnectionUri();
    process.env["DATABASE_URL"] = dbUrl;
    process.env["SLACK_ALLOWED_USER_IDS"] = OWNER_SLACK;
    process.env["TELEGRAM_PRINCIPAL_ID"] = OWNER_TELEGRAM;
    await quiet(getPool()).query(readFileSync(join(import.meta.dirname, "../../box/sql/002_standing_facts.sql"), "utf8"));
    await getPool().query(FORGET_LEDGER_SQL);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  beforeEach(async () => {
    process.env["DATABASE_URL"] = dbUrl;
    await getPool().query("TRUNCATE standing_facts RESTART IDENTITY");
    // A missing-table test drops this table; recreate it unconditionally so every test starts
    // with the ledger present, whether or not the previous one dropped it.
    await getPool().query("DROP TABLE IF EXISTS forget_ledger");
    await getPool().query(FORGET_LEDGER_SQL);
    resetTaintForTests();
  });

  // ── the store ────────────────────────────────────────────────────────────────

  describe("the store", () => {
    it("remembers a fact and lists it back", async () => {
      const stored = await rememberFact(getPool(), {
        fact: "jeg tar alltid bussen til Eksempelbyen",
        category: "travel",
        sourceTurn: "turn_1",
        userId: configuredOwnerId(),
      });
      expect(stored.id).toBeGreaterThan(0);
      expect(stored.retiredAt).toBeNull();
      expect(stored.userId).toBe(configuredOwnerId());

      const active = await listActiveFacts(getPool(), configuredOwnerId());
      expect(active.map((f) => f.fact)).toEqual(["jeg tar alltid bussen til Eksempelbyen"]);
      expect(active[0]!.sourceTurn).toBe("turn_1");
      expect(active[0]!.category).toBe("travel");
    });

    it("orders newest first", async () => {
      for (const [fact, day] of [["oldest", "2026-08-01"], ["middle", "2026-08-10"], ["newest", "2026-08-20"]] as const) {
        await rememberFact(getPool(), {
          fact,
          category: "preference",
          sourceTurn: "t",
          userId: configuredOwnerId(),
          statedAt: new Date(`${day}T09:00:00Z`),
        });
      }
      expect((await listActiveFacts(getPool(), configuredOwnerId())).map((f) => f.fact)).toEqual(["newest", "middle", "oldest"]);
    });

    it("a retired fact drops out of the active list but is NOT deleted", async () => {
      const stored = await rememberFact(getPool(), {
        fact: "I take the car",
        category: "travel",
        sourceTurn: "t",
        userId: configuredOwnerId(),
      });
      const retired = await forgetFact(getPool(), stored.id, configuredOwnerId());

      expect(retired?.fact).toBe("I take the car");
      expect(retired?.retiredAt).toBeInstanceOf(Date);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toEqual([]);

      const { rows } = await getPool().query("SELECT count(*)::int AS n FROM standing_facts");
      expect(rows[0]!.n).toBe(1);
    });

    it("forgetting an unknown or already-retired id changes nothing and says so", async () => {
      expect(await forgetFact(getPool(), 9999, configuredOwnerId())).toBeNull();
      const stored = await rememberFact(getPool(), {
        fact: "en ting",
        category: "preference",
        sourceTurn: "t",
        userId: configuredOwnerId(),
      });
      expect(await forgetFact(getPool(), stored.id, configuredOwnerId())).not.toBeNull();
      expect(await forgetFact(getPool(), stored.id, configuredOwnerId())).toBeNull();
    });

    it(`caps the list at ${MAX_STANDING_FACTS}, keeping the newest — with ties broken deterministically`, async () => {
      // Every row shares one `stated_at` on purpose: that is what a hand-applied seed batch
      // looks like, and a cap over `stated_at` alone would then drop an ARBITRARY half.
      const statedAt = new Date("2026-08-25T06:00:00Z");
      for (let i = 1; i <= MAX_STANDING_FACTS + 5; i++) {
        await rememberFact(getPool(), {
          fact: `fact ${i}`,
          category: "preference",
          sourceTurn: "t",
          userId: configuredOwnerId(),
          statedAt,
        });
      }
      const active = await listActiveFacts(getPool(), configuredOwnerId());
      expect(active).toHaveLength(MAX_STANDING_FACTS);
      expect(active[0]!.fact).toBe(`fact ${MAX_STANDING_FACTS + 5}`);
      expect(active.at(-1)!.fact).toBe("fact 6");
      // Deterministic: the same query twice returns the same window, not a different half.
      expect((await listActiveFacts(getPool(), configuredOwnerId())).map((f) => f.id)).toEqual(active.map((f) => f.id));
    });

    it("honours an explicit smaller limit", async () => {
      for (const fact of ["a", "b", "c"]) {
        await rememberFact(getPool(), { fact, category: "preference", sourceTurn: "t", userId: configuredOwnerId() });
      }
      expect(await listActiveFacts(getPool(), configuredOwnerId(), 2)).toHaveLength(2);
    });

    it("scopes reads by owner — another member's facts are not his", async () => {
      await rememberFact(getPool(), { fact: "I take the train", category: "travel", sourceTurn: "t1", userId: "owner-1" });
      await rememberFact(getPool(), { fact: "I drive", category: "travel", sourceTurn: "t2", userId: "henrik" });
      const ownerFacts = await listActiveFacts(getPool(), "owner-1");
      expect(ownerFacts.map((f) => f.fact)).toContain("I take the train");
      expect(ownerFacts.map((f) => f.fact)).not.toContain("I drive");
    });

    it("forget refuses to retire another user's fact", async () => {
      const mine = await rememberFact(getPool(), { fact: "gluten free", category: "preference", sourceTurn: "t3", userId: "owner-1" });
      expect(await forgetFact(getPool(), mine.id, "henrik")).toBeNull();
      expect(await forgetFact(getPool(), mine.id, "owner-1")).not.toBeNull();
    });
  });

  // ── forgetFact and the ledger — one transaction, never one without the other ───

  describe("forgetFact writes the ledger in the same transaction", () => {
    it("retires the row and writes the ledger entry in one transaction", async () => {
      const stored = await rememberFact(getPool(), {
        fact: "He takes the train.", category: "travel", sourceTurn: "t", userId: "fixture-owner",
      });
      await forgetFact(getPool(), stored.id, "fixture-owner", undefined, async (client, f) => {
        await recordForgotten(client, { owner: f.userId, kind: "fact", words: f.fact, reason: "forget" });
      });
      const { rows } = await getPool().query("SELECT 1 FROM forget_ledger");
      expect(rows).toHaveLength(1);
    });

    it("writes no ledger entry when the fact was not retired", async () => {
      let called = false;
      const out = await forgetFact(getPool(), 999_999, "fixture-owner", undefined, async () => {
        called = true;
      });
      expect(out).toBe(null);
      expect(called).toBe(false);
    });

    it("retires nothing if the ledger write fails — the retirement rolls back with it", async () => {
      const stored = await rememberFact(getPool(), {
        fact: "He takes the bus.", category: "travel", sourceTurn: "t", userId: "fixture-owner",
      });
      await expect(
        forgetFact(getPool(), stored.id, "fixture-owner", undefined, async () => {
          throw new Error("ledger down");
        }),
      ).rejects.toThrow(/ledger down/);
      const { rows } = await getPool().query<{ retired_at: Date | null }>(
        "SELECT retired_at FROM standing_facts WHERE id = $1",
        [stored.id],
      );
      expect(rows[0]!.retired_at).toBeNull();
    });
  });

  // ── what may be remembered ───────────────────────────────────────────────────

  describe("rejectFact", () => {
    it("accepts a fact stated in his own words", () => {
      expect(rejectFact("jeg tar alltid bussen til Eksempelbyen")).toBeNull();
      expect(rejectFact("an intro call with no venue is remote")).toBeNull();
    });

    it("refuses an empty or whitespace-only fact — nothing was quoted", () => {
      expect(rejectFact("")).toMatch(/own words/i);
      expect(rejectFact("   \n ")).toMatch(/own words/i);
    });

    it("refuses a fact that is true only today — the counter-example", () => {
      // Said alongside durable corrections. Storing it would make every
      // brief after that day wrong, silently.
      expect(rejectFact("I'm in the city office until 14:00 today")).toMatch(/one day/i);
      expect(rejectFact("jeg er på kontoret til 14:00 i dag")).toMatch(/one day/i);
      expect(rejectFact("han er i Eksempelbyen i morgen")).toMatch(/one day/i);
    });

    it("refuses a hedged fact — that is the chief of staff's inference, not his words", () => {
      expect(rejectFact("he probably prefers the train")).toMatch(/inference/i);
      expect(rejectFact("jeg tror han tar bussen")).toMatch(/inference/i);
    });

    it("refuses a fact longer than one sentence's worth", () => {
      expect(rejectFact("x".repeat(MAX_FACT_LENGTH + 1))).toMatch(/at most/i);
    });
  });

  // ── who may write to the store ───────────────────────────────────────────────

  /**
   * Review fix, Finding 1. Ungated is not unattributed. Both brief turns run as eve's app
   * principal, carry the standing-facts block plus "apply these / call `forget` if he supersedes
   * one", and contain NO utterance of his — so a model reading tomorrow's Travel row beside the
   * train fact has everything it needs to write a sentence in AGENT_A's voice into a table whose
   * whole contract is "his own words". `rejectFact` cannot catch that; only the principal can.
   *
   * Both directions are tested: the app and a stranger are refused with nothing written, and
   * both real channels' allowlisted humans still work — a gate that refuses everyone would pass
   * the first half of this suite and quietly cost him the feature.
   */
  describe("the principal check", () => {
    const appCtx = ctxFor(APP_AUTH);

    it("the app principal — a brief turn — cannot remember, and NOTHING is written", async () => {
      // The exact failure from the review: an inference off tomorrow's calendar, phrased as his
      // words. `rejectFact` passes it (standing, unhedged, no day-word), so only the gate stops it.
      const result = await remember.execute(
        { fact: "he stays at Hotel A before early flights", category: "places" },
        appCtx,
      );
      expect(result.remembered).toBe(false);
      expect(result.message).toMatch(/running as app/i);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toEqual([]);
    });

    it("the app principal cannot forget either — the fact survives the brief turn", async () => {
      const stored = await rememberFact(getPool(), {
        fact: "jeg tar alltid bussen til Eksempelbyen", category: "travel", sourceTurn: "t", userId: configuredOwnerId(),
      });
      const result = await forget.execute({ id: stored.id }, appCtx);
      expect(result.forgotten).toBe(false);
      expect(result.message).toMatch(/running as app/i);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toHaveLength(1);
    });

    it("a turn with no auth at all is refused too — fail-closed, not fail-quiet", async () => {
      const result = await remember.execute({ fact: "en ting", category: "preference" }, ctxFor(undefined));
      expect(result.remembered).toBe(false);
      expect(result.message).toMatch(/no identity at all/i);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toEqual([]);
    });

    it("a human on the WRONG channel's allowlist is refused — the id is checked against its own channel", async () => {
      // the owner's SLACK id presented with the TELEGRAM authenticator: `isAllowedPrincipal` checks
      // it against the Telegram list, where it does not appear, so it refuses even though that
      // exact string is allowlisted on the other channel.
      const result = await remember.execute(
        { fact: "en ting", category: "preference" },
        ctxFor({ attributes: { user_id: OWNER_SLACK }, authenticator: "telegram-webhook", principalType: "user" }),
      );
      expect(result.remembered).toBe(false);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toEqual([]);
    });

    it("an allowlisted TELEGRAM human may remember — the gate is the allowlist, not one channel", async () => {
      const result = await remember.execute(
        { fact: "jeg tar alltid bussen til Eksempelbyen", category: "travel" },
        ctxFor(telegramAuth(OWNER_TELEGRAM)),
      );
      expect(result.remembered).toBe(true);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toHaveLength(1);
    });

    it("an allowlisted human may forget", async () => {
      const stored = await rememberFact(getPool(), {
        fact: "I take the car", category: "travel", sourceTurn: "t", userId: configuredOwnerId(),
      });
      const result = await forget.execute({ id: stored.id }, ctxFor(telegramAuth(OWNER_TELEGRAM)));
      expect(result.forgotten).toBe(true);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toEqual([]);
    });
  });

  // ── the tools ────────────────────────────────────────────────────────────────

  describe("remember", () => {
    it("remember is ungated — a note-to-self is not an external action", () => {
      expect((remember as unknown as { approval?: unknown }).approval).toBeUndefined();
    });

    it("forget is gated — retiring a fact is a delete, and the board always asks first ( step 1)", () => {
      expect((forget as unknown as { approval?: unknown }).approval).toBeTypeOf("function");
      // Named by its OWN tool — board-wiring.test.ts enforces this fleet-wide; this pins it for
      // the one tool this file is specifically about.
      const src = readFileSync(join(import.meta.dirname, "../catalogue/forget.ts"), "utf8");
      expect(src).toContain('approvalFor("forget")');
    });

    it("stores the fact with the turn it was said in", async () => {
      const result = await remember.execute(
        { fact: "jeg tar alltid bussen til Eksempelbyen", category: "travel" },
        ctx,
      );
      expect(result.remembered).toBe(true);

      const active = await listActiveFacts(getPool(), configuredOwnerId());
      expect(active).toHaveLength(1);
      expect(active[0]!.fact).toBe("jeg tar alltid bussen til Eksempelbyen");
      expect(active[0]!.sourceTurn).toBe("turn_42");
    });

    it("refuses a fact with no quoted utterance, and stores NOTHING", async () => {
      const result = await remember.execute({ fact: "   ", category: "preference" }, ctx);
      expect(result.remembered).toBe(false);
      expect(result.message).toMatch(/own words/i);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toEqual([]);
    });

    it("refuses a one-day fact, and stores NOTHING", async () => {
      const result = await remember.execute({ fact: "I'm at the office until 14:00 today", category: "schedule" }, ctx);
      expect(result.remembered).toBe(false);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toEqual([]);
    });

    it("tells the model the rules it cannot enforce: his words, and standing ≠ one day", () => {
      // The two contract halves no code can check. If someone rewrites this description, these
      // are the sentences that must survive the rewrite.
      const d = remember.description!;
      expect(d).toMatch(/their own words/i);
      expect(d).toMatch(/never your summary|never a paraphrase/i);
      expect(d).toMatch(/inferred/i);
      expect(d).toMatch(/standing/i);
      // The distinction, named with the very example that provoked the ticket.
      expect(d).toMatch(/true for one day is NOT a standing fact/i);
      expect(d).toContain("I'm in the city office until 14:00 today");
      // And the categories, so the model has the vocabulary the store expects.
      for (const c of ["travel", "schedule", "preference", "people", "places"]) expect(d).toContain(c);
    });

    it("refuses to write a standing fact on a turn that has read somebody else's words", async () => {
      taintTurn(CTX_TURN_KEY, "third_party");
      const res = await remember.execute({ fact: "I take the train", category: "travel" }, ctx);
      expect(res.remembered).toBe(false);
      expect(res.message).toMatch(/read something written by someone else/i);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toEqual([]);
    });
  });

  describe("forget", () => {
    it("retires a fact he has superseded", async () => {
      const stored = await rememberFact(getPool(), {
        fact: "I take the train", category: "travel", sourceTurn: "t", userId: configuredOwnerId(),
      });
      const result = await forget.execute({ id: stored.id }, ctx);
      expect(result.forgotten).toBe(true);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toEqual([]);
    });

    it("reports honestly when the id matches nothing", async () => {
      const result = await forget.execute({ id: 4242 }, ctx);
      expect(result.forgotten).toBe(false);
      expect(result.message).toMatch(/nothing changed/i);
    });

    it("writes the fact down in the ledger, and says a re-import cannot bring it back", async () => {
      const stored = await rememberFact(getPool(), {
        fact: "I take the train", category: "travel", sourceTurn: "t", userId: configuredOwnerId(),
      });
      const result = await forget.execute({ id: stored.id }, ctx);
      expect(result.forgotten).toBe(true);
      expect(result.message).toMatch(/re-import|re-sync/i);
      const { rows } = await getPool().query("SELECT 1 FROM forget_ledger");
      expect(rows).toHaveLength(1);
    });

    it("still retires on a box with no ledger table, and says the limit out loud", async () => {
      const stored = await rememberFact(getPool(), {
        fact: "I take the ferry", category: "travel", sourceTurn: "t", userId: configuredOwnerId(),
      });
      await getPool().query("DROP TABLE forget_ledger");
      const result = await forget.execute({ id: stored.id }, ctx);
      expect(result.forgotten).toBe(true);
      expect(result.message).toContain("latest database update");
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toEqual([]);
    });

    it("names nobody", () => {
      const src = readFileSync(join(import.meta.dirname, "../catalogue/forget.ts"), "utf8");
      // Not "lares": this file legitimately imports from the `@lares/agent-kit` package scope,
      // which the programme's own rule ("the existing @lares/ package scope is fine") allows.
      for (const re of denylistPatterns()) expect(src).not.toMatch(re);
    });
  });

  // ── remember refuses to re-add a forgotten fact (W5B-s3) ─────────────────────

  describe("remember refuses to re-add a forgotten fact", () => {
    it("will not silently re-add something the owner asked to forget", async () => {
      await recordForgotten(getPool(), {
        owner: configuredOwnerId(), kind: "fact", words: "He takes the train.", reason: "forget",
      });
      const out = await remember.execute({ fact: "he takes the TRAIN", category: "travel" }, ctx);
      expect(out.remembered).toBe(false);
      expect((out as { reason?: string }).reason).toBe("forgotten");
      expect(out.message).toMatch(/asked me to forget/i);
      expect(out.message).toMatch(/remember it anyway/i);
      // The owner reads this sentence: it must not name a tool input.
      expect(out.message).not.toMatch(/evenThoughForgotten/);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toEqual([]);
    });

    it("does add it when the owner overrides, and clears the ledger row in the same write", async () => {
      await recordForgotten(getPool(), {
        owner: configuredOwnerId(), kind: "fact", words: "He takes the train.", reason: "forget",
      });
      const out = await remember.execute(
        { fact: "he takes the TRAIN", category: "travel", evenThoughForgotten: true },
        ctx,
      );
      expect(out.remembered).toBe(true);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toHaveLength(1);
      // The ledger can never go on contradicting a standing fact it just wrote: the row for
      // these exact words is gone, so asking again — without the override — is no longer refused.
      const { rows } = await getPool().query("SELECT 1 FROM forget_ledger");
      expect(rows).toHaveLength(0);
    });

    it("adds normally on a box with no ledger table", async () => {
      await getPool().query("DROP TABLE forget_ledger");
      const out = await remember.execute({ fact: "he takes the train", category: "travel" }, ctx);
      expect(out.remembered).toBe(true);
    });

    it("overriding on a box with no ledger table still adds the fact", async () => {
      await getPool().query("DROP TABLE forget_ledger");
      const out = await remember.execute(
        { fact: "he takes the TRAIN", category: "travel", evenThoughForgotten: true },
        ctx,
      );
      expect(out.remembered).toBe(true);
    });

    it("leaves the supersedes path alone — replacing is not re-adding", async () => {
      const old = await rememberFact(getPool(), {
        fact: "He takes the train.", category: "travel", sourceTurn: "t", userId: configuredOwnerId(),
      });
      await recordForgotten(getPool(), {
        owner: configuredOwnerId(), kind: "fact", words: "He takes the train.", reason: "forget",
      });
      const out = await remember.execute(
        { fact: "he takes the TRAIN", category: "travel", supersedes: old.id },
        ctx,
      );
      expect(out.remembered).toBe(true);
    });
  });

  // ── the per-session injection (per-turn until W4B-s2) ────────────────────────

  describe("the instructions block", () => {
    it("a stored fact appears in the NEXT session's instructions", async () => {
      await remember.execute({ fact: "jeg tar alltid bussen til Eksempelbyen", category: "travel" }, ctx);
      const markdown = await injected();
      expect(markdown).toContain("## What I have been told");
      expect(markdown).toContain("jeg tar alltid bussen til Eksempelbyen");
      expect(markdown).toMatch(/apply them without being/i);
    });

    it("a retired fact does NOT", async () => {
      const stored = await rememberFact(getPool(), {
        fact: "I take the car", category: "travel", sourceTurn: "t", userId: configuredOwnerId(),
      });
      await rememberFact(getPool(), {
        fact: "I take the train", category: "travel", sourceTurn: "t", userId: configuredOwnerId(),
      });
      await forget.execute({ id: stored.id }, ctx);

      const markdown = await injected();
      expect(markdown).toContain("I take the train");
      expect(markdown).not.toContain("I take the car");
    });

    it("carries each fact's id, so the model can name one to `forget`", async () => {
      const stored = await rememberFact(getPool(), {
        fact: "en ting", category: "preference", sourceTurn: "t", userId: configuredOwnerId(),
      });
      expect(await injected()).toContain(`[${stored.id}]`);
    });

    it("injects NOTHING when he has told her nothing — no empty heading", async () => {
      expect(await injected()).toBe("");
      expect(standingFactsMarkdown([])).toBe("");
    });

    it("a STALLED database costs the facts, never the turn — within the budget", async () => {
      // Fix round 1. The failure this box actually produces is not a throw: `db` up but
      // unresponsive (full disk, exhausted connections). `pool.query` then neither resolves nor
      // rejects, and eve applies no timeout of its own to a dynamic-instruction resolver — so
      // unbounded, this is not "she forgot", it is "the owner's message got no reply".
      const pool = getPool();
      const realQuery = pool.query.bind(pool);
      (pool as unknown as { query: () => Promise<never> }).query = () => new Promise<never>(() => {});
      const startedAt = Date.now();
      try {
        await expect(injected()).resolves.toBe("");
      } finally {
        (pool as unknown as { query: unknown }).query = realQuery;
      }
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(STANDING_FACTS_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(STANDING_FACTS_TIMEOUT_MS + 2_000);
    });

    it("the same bound is what both briefs apply to their own read", async () => {
      // The two brief schedules read standing facts inside `defineSchedule.run`, which no test
      // can call. This asserts the EXPRESSION they both use, against the same stalled pool:
      // withTimeout(listActiveFacts(pool), STANDING_FACTS_TIMEOUT_MS, …).catch(() => []).
      const pool = getPool();
      const realQuery = pool.query.bind(pool);
      (pool as unknown as { query: () => Promise<never> }).query = () => new Promise<never>(() => {});
      try {
        const facts = await withTimeout(
          listActiveFacts(pool),
          STANDING_FACTS_TIMEOUT_MS,
          "test: standing facts",
        ).catch(() => []);
        expect(facts).toEqual([]);
      } finally {
        (pool as unknown as { query: unknown }).query = realQuery;
      }
    });

    it("a database failure costs the facts, never the turn", async () => {
      // eve takes a turn's whole instruction set down with a throwing resolver, so this is the
      // difference between "she forgot for one turn" and "the owner's message got no reply".
      await closePool();
      delete process.env["DATABASE_URL"];
      try {
        await expect(injected()).resolves.toBe("");
      } finally {
        process.env["DATABASE_URL"] = dbUrl;
      }
    });
  });

  // ── origin (W3A-s7) ──────────────────────────────────────────────────────────

  describe("origin on a standing fact", () => {
    it("refuses any class but owner", async () => {
      await expect(
        getPool().query(
          "INSERT INTO standing_facts (fact, category, source_turn, user_id, origin) VALUES ('x','travel','t','fixture-owner','third_party')",
        ),
      ).rejects.toThrow(/standing_facts_origin_check/);
    });

    it("rememberFact stores and returns it", async () => {
      const f = await rememberFact(getPool(), {
        fact: "I take the train",
        category: "travel",
        sourceTurn: "t1",
        userId: configuredOwnerId(),
      });
      expect(f.origin).toBe("owner");
    });
  });

  // ── the dated-facts field set (W4A-s1) ───────────────────────────────────────

  describe("the dated-facts field set", () => {
    it("carries recorded_at, source and superseded_by, and no second valid_from/valid_to pair", async () => {
      const { rows } = await getPool().query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'standing_facts'",
      );
      const cols = rows.map((r) => r.column_name).sort();
      expect(cols).toContain("recorded_at");
      expect(cols).toContain("source");
      expect(cols).toContain("superseded_by");
      // The reconciliation, pinned: stated_at IS valid_from and retired_at IS valid_to.
      expect(cols).not.toContain("valid_from");
      expect(cols).not.toContain("valid_to");
    });

    it("backfills an existing row rather than leaving it null", async () => {
      await getPool().query(
        "INSERT INTO standing_facts (fact, category, source_turn, user_id) VALUES ('x','travel','t','fixture-owner')",
      );
      const { rows } = await getPool().query<{ recorded_at: Date; stated_at: Date; source: string }>(
        "SELECT recorded_at, stated_at, source FROM standing_facts ORDER BY id DESC LIMIT 1",
      );
      expect(rows[0]!.source).toBe("remember");
      expect(rows[0]!.recorded_at.getTime()).toBeGreaterThan(0);
    });

    it("refuses a row that names itself as its replacement", async () => {
      const { rows } = await getPool().query<{ id: string }>(
        "INSERT INTO standing_facts (fact, category, source_turn, user_id) VALUES ('y','travel','t','fixture-owner') RETURNING id",
      );
      const id = rows[0]!.id;
      await expect(
        getPool().query("UPDATE standing_facts SET retired_at = now(), superseded_by = $1 WHERE id = $1", [id]),
      ).rejects.toThrow(/standing_facts_supersede_shape_check/);
    });

    it("refuses a link from a row that is still standing", async () => {
      const a = (
        await getPool().query<{ id: string }>(
          "INSERT INTO standing_facts (fact, category, source_turn, user_id) VALUES ('a','travel','t','fixture-owner') RETURNING id",
        )
      ).rows[0]!.id;
      const b = (
        await getPool().query<{ id: string }>(
          "INSERT INTO standing_facts (fact, category, source_turn, user_id) VALUES ('b','travel','t','fixture-owner') RETURNING id",
        )
      ).rows[0]!.id;
      await expect(
        getPool().query("UPDATE standing_facts SET superseded_by = $2 WHERE id = $1", [a, b]),
      ).rejects.toThrow(/standing_facts_supersede_shape_check/);
    });

    it("listActiveFacts returns the three new fields", async () => {
      await getPool().query(
        "INSERT INTO standing_facts (fact, category, source_turn, user_id) VALUES ('z','travel','t','fixture-owner')",
      );
      const [f] = await listActiveFacts(getPool(), "fixture-owner");
      expect(f!.source).toBe("remember");
      expect(f!.supersededBy).toBeNull();
      expect(f!.recordedAt).toBeInstanceOf(Date);
    });
  });

  // ── a change closes the old row and links it (W4A-s2) ────────────────────────

  describe("supersedeFact — a change closes the old row and links it", () => {
    async function seed(fact: string) {
      return rememberFact(getPool(), { fact, category: "travel", sourceTurn: "t1", userId: "fixture-owner" });
    }

    async function countRows(where = "TRUE"): Promise<number> {
      const { rows } = await getPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM standing_facts WHERE ${where}`,
      );
      return Number(rows[0]!.n);
    }

    it("keeps both rows, closes only the old one, and records the link", async () => {
      const old = await seed("I take the train to the coast");
      const { retired, stored } = await supersedeFact(getPool(), old.id, {
        fact: "I drive to the coast now",
        category: "travel",
        sourceTurn: "t2",
        userId: "fixture-owner",
      });

      expect(retired.id).toBe(old.id);
      expect(retired.retiredAt).toBeInstanceOf(Date);
      expect(retired.supersededBy).toBe(stored.id);
      expect(stored.retiredAt).toBeNull();
      expect(stored.supersededBy).toBeNull();

      // Nothing is deleted: both rows are still there, one of them standing.
      expect(await countRows()).toBe(2);
      expect((await listActiveFacts(getPool(), "fixture-owner")).map((f) => f.id)).toEqual([stored.id]);
    });

    it("refuses an id that is not a standing fact of this user, and writes nothing", async () => {
      const mine = await seed("mine");
      await expect(
        supersedeFact(getPool(), mine.id + 999, {
          fact: "theirs", category: "travel", sourceTurn: "t", userId: "fixture-owner",
        }),
      ).rejects.toBeInstanceOf(UnknownFactError);
      expect(await countRows()).toBe(1);
    });

    it("refuses another user's fact, and writes nothing", async () => {
      const theirs = await rememberFact(getPool(), {
        fact: "theirs", category: "travel", sourceTurn: "t", userId: "other-owner",
      });
      await expect(
        supersedeFact(getPool(), theirs.id, {
          fact: "mine now", category: "travel", sourceTurn: "t", userId: "fixture-owner",
        }),
      ).rejects.toBeInstanceOf(UnknownFactError);
      expect((await listActiveFacts(getPool(), "other-owner")).map((f) => f.fact)).toEqual(["theirs"]);
      expect(await countRows()).toBe(1);
    });

    it("leaves no half-written state when the insert is refused", async () => {
      const old = await seed("standing");
      await expect(
        supersedeFact(getPool(), old.id, {
          fact: "x".repeat(400), // the column is unbounded; this is refused by the CALLER, not here
          category: "travel", sourceTurn: "t", userId: "fixture-owner",
        }),
      ).resolves.toBeDefined(); // the store writes what it is given — rejectFact is remember.ts's job
      // …and the old row is closed exactly once.
      expect(await countRows("retired_at IS NOT NULL")).toBe(1);
    });

    /**
     * THE ONE THAT MATTERS: a failure BETWEEN the two statements. The new row is inserted first
     * (the link is a foreign key to it) and the old row is closed second — so if that second
     * statement can fail on its own, the window it opens is a standing fact with a duplicate
     * beside it, or an owner whose correction was recorded twice. This forces exactly that
     * failure and proves the transaction takes the insert back out with it.
     */
    it("a failure between the insert and the close leaves BOTH rows exactly as they were", async () => {
      const old = await seed("I take the train");
      const before = await getPool().query<{ id: string; retired_at: Date | null }>(
        "SELECT id, retired_at FROM standing_facts ORDER BY id",
      );

      const pool = getPool();
      const realConnect = pool.connect.bind(pool);
      (pool as unknown as { connect: () => Promise<unknown> }).connect = async () => {
        const client = await realConnect();
        const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        // Fails once, on the UPDATE that closes the old row, then puts itself back so the
        // ROLLBACK goes through and the client returns to the pool unpatched.
        (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
          const text = typeof args[0] === "string" ? args[0] : "";
          if (text.trimStart().toUpperCase().startsWith("UPDATE")) {
            (client as unknown as { query: unknown }).query = realQuery;
            return Promise.reject(new Error("forced failure between the insert and the close"));
          }
          return realQuery(...args);
        };
        return client;
      };

      try {
        await expect(
          supersedeFact(getPool(), old.id, {
            fact: "I drive now", category: "travel", sourceTurn: "t2", userId: "fixture-owner",
          }),
        ).rejects.toThrow(/forced failure/);
      } finally {
        (pool as unknown as { connect: unknown }).connect = realConnect;
      }

      // No new row, and the old one is untouched — still standing, still the owner's answer.
      const after = await getPool().query<{ id: string; retired_at: Date | null }>(
        "SELECT id, retired_at FROM standing_facts ORDER BY id",
      );
      expect(after.rows).toEqual(before.rows);
      expect(await countRows()).toBe(1);
      expect((await listActiveFacts(getPool(), "fixture-owner")).map((f) => f.fact)).toEqual([
        "I take the train",
      ]);
      // The pool is usable afterwards: the patched client went back unpatched.
      expect(await seed("and the pool still works")).toBeDefined();
    });

    it("cannot close a fact twice — a closed row is never superseded again, so the chain cannot fork", async () => {
      const old = await seed("first");
      const { stored } = await supersedeFact(getPool(), old.id, {
        fact: "second", category: "travel", sourceTurn: "t2", userId: "fixture-owner",
      });
      await expect(
        supersedeFact(getPool(), old.id, {
          fact: "a second replacement for the same row", category: "travel", sourceTurn: "t3", userId: "fixture-owner",
        }),
      ).rejects.toBeInstanceOf(UnknownFactError);
      expect(await countRows()).toBe(2);
      const { rows } = await getPool().query<{ superseded_by: string | null }>(
        "SELECT superseded_by FROM standing_facts WHERE id = $1",
        [old.id],
      );
      expect(Number(rows[0]!.superseded_by)).toBe(stored.id);
    });

    it("two doors racing on one fact: exactly one supersede wins, the other gets a sentence", async () => {
      // `FOR UPDATE` is what makes this a refusal rather than a fork or a constraint name the
      // model cannot act on: the second transaction blocks on the lock BEFORE it inserts
      // anything, and when it wakes the row is closed and no longer matches.
      const old = await seed("the contested fact");
      const results = await Promise.allSettled([
        supersedeFact(getPool(), old.id, { fact: "left", category: "travel", sourceTurn: "a", userId: "fixture-owner" }),
        supersedeFact(getPool(), old.id, { fact: "right", category: "travel", sourceTurn: "b", userId: "fixture-owner" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(UnknownFactError);
      // Two rows, not three: the loser wrote nothing at all.
      expect(await countRows()).toBe(2);
      expect(await listActiveFacts(getPool(), "fixture-owner")).toHaveLength(1);
    });

    it("the old fact stops being true exactly when the new one starts — no gap, no overlap", async () => {
      const old = await seed("I take the train");
      const { retired, stored } = await supersedeFact(getPool(), old.id, {
        fact: "I drive now", category: "travel", sourceTurn: "t2", userId: "fixture-owner",
      });
      expect(retired.retiredAt!.getTime()).toBe(stored.statedAt.getTime());
    });

    it("a closed fact stays readable with its whole history: its words, its dates, and what replaced it", async () => {
      const old = await seed("I take the train to the coast");
      const { stored } = await supersedeFact(getPool(), old.id, {
        fact: "I drive to the coast now", category: "travel", sourceTurn: "t2", userId: "fixture-owner",
      });
      const { rows } = await getPool().query<{
        fact: string; user_id: string; origin: string; source: string;
        stated_at: Date; recorded_at: Date; retired_at: Date | null; superseded_by: string | null;
      }>("SELECT * FROM standing_facts WHERE id = $1", [old.id]);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.fact).toBe("I take the train to the coast");
      expect(rows[0]!.source).toBe("remember");
      expect(rows[0]!.origin).toBe("owner");
      expect(rows[0]!.stated_at).toEqual(old.statedAt);
      expect(rows[0]!.recorded_at).toBeInstanceOf(Date);
      expect(rows[0]!.retired_at).toBeInstanceOf(Date);
      expect(Number(rows[0]!.superseded_by)).toBe(stored.id);
      // The link never crosses owners: both ends are the same member's row.
      expect(rows[0]!.user_id).toBe("fixture-owner");
      const { rows: replacement } = await getPool().query<{ user_id: string }>(
        "SELECT user_id FROM standing_facts WHERE id = $1",
        [stored.id],
      );
      expect(replacement[0]!.user_id).toBe(rows[0]!.user_id);
    });
  });

  describe("replacing a fact through the tool", () => {
    async function seedOwned(fact: string) {
      return rememberFact(getPool(), { fact, category: "travel", sourceTurn: "t", userId: configuredOwnerId() });
    }

    it("the id comes from the model as an argument, never from a text match in code", () => {
      // The whole judgement — "this new sentence replaces THAT old one" — is the model's, and it
      // is expressed as an id it was shown in the facts block. Nothing here compares strings.
      const src = readFileSync(join(import.meta.dirname, "../catalogue/remember.ts"), "utf8");
      expect(src).toMatch(/supersedes:\s*z\s*[\s\S]{0,40}\.number\(\)/);
      expect(src).not.toMatch(/levenshtein|similarity|fuzzy|matchFact/i);
    });

    it("replaces the fact, links the rows, and the next turn shows only the new one", async () => {
      const old = await seedOwned("I take the train to the coast");
      const result = await remember.execute(
        { fact: "I drive to the coast now", category: "travel", supersedes: old.id },
        ctx,
      );
      expect(result.remembered).toBe(true);
      expect((result as { linked?: boolean }).linked).toBe(true);

      const active = await listActiveFacts(getPool(), configuredOwnerId());
      expect(active.map((f) => f.fact)).toEqual(["I drive to the coast now"]);
      const markdown = await injected();
      expect(markdown).toContain("I drive to the coast now");
      expect(markdown).not.toContain("I take the train to the coast");

      const { rows } = await getPool().query<{ superseded_by: string | null }>(
        "SELECT superseded_by FROM standing_facts WHERE id = $1",
        [old.id],
      );
      expect(Number(rows[0]!.superseded_by)).toBe((result as { id: number }).id);
    });

    it("an id that names nothing is one plain sentence, and nothing is written", async () => {
      const result = await remember.execute(
        { fact: "I drive now", category: "travel", supersedes: 4242 },
        ctx,
      );
      expect(result.remembered).toBe(false);
      expect(result.message).toMatch(/no standing fact with id 4242/i);
      expect(result.message).toMatch(/nothing was written/i);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toEqual([]);
    });

    it("a fact belonging to another member cannot be replaced from this turn", async () => {
      const theirs = await rememberFact(getPool(), {
        fact: "theirs", category: "travel", sourceTurn: "t", userId: "other-owner",
      });
      const result = await remember.execute(
        { fact: "mine now", category: "travel", supersedes: theirs.id },
        ctx,
      );
      expect(result.remembered).toBe(false);
      expect((await listActiveFacts(getPool(), "other-owner")).map((f) => f.fact)).toEqual(["theirs"]);
      expect(await listActiveFacts(getPool(), configuredOwnerId())).toEqual([]);
    });

    it("a tainted turn cannot replace a fact either — the same refusal `remember` already gives", async () => {
      const old = await seedOwned("I take the train to the coast");
      taintTurn(CTX_TURN_KEY, "third_party");
      const result = await remember.execute(
        { fact: "I drive to the coast now", category: "travel", supersedes: old.id },
        ctx,
      );
      expect(result.remembered).toBe(false);
      expect(result.message).toMatch(/read something written by someone else/i);
      // The old fact is untouched: a turn that has read a stranger's words cannot close one.
      const still = await listActiveFacts(getPool(), configuredOwnerId());
      expect(still.map((f) => f.fact)).toEqual(["I take the train to the coast"]);
      expect(still[0]!.retiredAt).toBeNull();
    });

    it("an unattended turn — a brief, a schedule — cannot replace a fact", async () => {
      const old = await seedOwned("I take the train to the coast");
      const result = await remember.execute(
        { fact: "I drive to the coast now", category: "travel", supersedes: old.id },
        ctxFor(APP_AUTH),
      );
      expect(result.remembered).toBe(false);
      expect(result.message).toMatch(/running as app/i);
      expect((await listActiveFacts(getPool(), configuredOwnerId())).map((f) => f.id)).toEqual([old.id]);
    });

    it("no unattended code path can reach the write at all: `remember` is its only caller", () => {
      // The gate above is a runtime check on one tool. This is the structural half of the same
      // claim — the dream cycle, the schedules, the hooks and every other library in this service
      // do not name `supersedeFact`, so there is no second door for that check to be missing from.
      const root = join(import.meta.dirname, "..");
      const callers: string[] = [];
      for (const dir of ["agent", "catalogue", "lib"]) {
        for (const entry of readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })) {
          if (!entry.endsWith(".ts")) continue;
          const rel = `${dir}/${entry}`;
          if (readFileSync(join(root, rel), "utf8").includes("supersedeFact")) callers.push(rel);
        }
      }
      expect(callers.sort()).toEqual(["catalogue/remember.ts", "lib/standing-facts.ts"]);
    });

  });

  describe("the two shelves (ADR-0018 rule 7)", () => {
    it("classes every category, and only in the two ways", () => {
      for (const c of STANDING_FACT_CATEGORIES) {
        expect(["world", "conduct"]).toContain(shelfOf(c));
      }
      expect(Object.keys(SHELF_OF_CATEGORY).sort()).toEqual([...STANDING_FACT_CATEGORIES].sort());
    });

    it("puts a fact about a person or a place on the world shelf", () => {
      expect(shelfOf("people")).toBe("world");
      expect(shelfOf("places")).toBe("world");
    });

    it("puts a standing instruction on the conduct shelf", () => {
      expect(shelfOf("travel")).toBe("conduct");
      expect(shelfOf("schedule")).toBe("conduct");
      expect(shelfOf("preference")).toBe("conduct");
    });

    it("a stored fact carries its shelf without a column for it", async () => {
      const f = await rememberFact(getPool(), {
        fact: "an intro call with no venue is remote",
        category: "schedule",
        sourceTurn: "t",
        userId: "fixture-owner",
      });
      expect(f.shelf).toBe("conduct");
      const { rows } = await getPool().query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name='standing_facts' AND column_name IN ('shelf','kind')",
      );
      // Derived, never stored: a column would let the two disagree after a category is re-classed.
      expect(rows).toEqual([]);
    });

    // Hold: no existing standing fact changes meaning, moves, or disappears from the block the
    // agent is shown as a result of this split. The split is read-only and total over `category`
    // — it adds a `shelf` label to what `listActiveFacts` already returns, and touches neither
    // the SELECT nor `standingFactsMarkdown`'s own filter (there isn't one). Proven here over one
    // fact per existing category — a realistic spread of what this table has actually held since
    // the first migration — rather than trusted from reading the diff.
    it("the facts block still shows every category, world and conduct alike — the shelf split filters nothing", async () => {
      const oneOfEach = [
        { fact: "he takes the train Alpha to Beta", category: "travel" as const },
        { fact: "a venue-less intro call is remote", category: "schedule" as const },
        { fact: "he prefers window seats", category: "preference" as const },
        { fact: "Vera runs the north site", category: "people" as const },
        { fact: "the Example Town office is the summer base", category: "places" as const },
      ];
      for (const f of oneOfEach) {
        await rememberFact(getPool(), { ...f, sourceTurn: "t", userId: configuredOwnerId() });
      }

      const active = await listActiveFacts(getPool(), configuredOwnerId());
      expect(active).toHaveLength(oneOfEach.length);
      // Both shelves are actually represented, or the test would pass vacuously.
      expect(active.map((f) => f.shelf).sort()).toEqual(["conduct", "conduct", "conduct", "world", "world"]);

      const markdown = await injected();
      for (const f of oneOfEach) {
        expect(markdown).toContain(f.fact);
      }
      // Exactly this many fact lines — one per row, none dropped and none duplicated by shelf.
      expect(markdown.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(oneOfEach.length);
    });
  });

  // ── "what have I retired?" (owner ruling) ─────────────

  describe("listRetiredFacts", () => {
    it("lists a retired fact, newest RETIREMENT first — not newest stated", async () => {
      const older = await rememberFact(getPool(), {
        fact: "gluten free",
        category: "preference",
        sourceTurn: "t",
        userId: "fixture-owner",
        statedAt: new Date("2026-01-01T09:00:00Z"),
      });
      const newer = await rememberFact(getPool(), {
        fact: "I take the car",
        category: "travel",
        sourceTurn: "t",
        userId: "fixture-owner",
        statedAt: new Date("2026-08-01T09:00:00Z"),
      });
      // Retired in the OPPOSITE order they were stated, so the ordering assertion below only
      // passes if the function really sorts by retirement, not by the statedAt it also carries.
      await forgetFact(getPool(), newer.id, "fixture-owner", new Date("2026-09-01T09:00:00Z"));
      await forgetFact(getPool(), older.id, "fixture-owner", new Date("2026-09-10T09:00:00Z"));

      const { facts, cut } = await listRetiredFacts(getPool(), "fixture-owner");
      expect(facts.map((f) => f.fact)).toEqual(["gluten free", "I take the car"]);
      expect(cut).toBe(false);
      expect(facts[0]!.retiredAt).toEqual(new Date("2026-09-10T09:00:00Z"));
      expect(facts[0]!.statedAt).toEqual(new Date("2026-01-01T09:00:00Z"));
    });

    it("never lists a still-active fact", async () => {
      await rememberFact(getPool(), {
        fact: "still true", category: "preference", sourceTurn: "t", userId: "fixture-owner",
      });
      expect((await listRetiredFacts(getPool(), "fixture-owner")).facts).toEqual([]);
    });

    it("scopes by owner, the same as listActiveFacts", async () => {
      const mine = await rememberFact(getPool(), {
        fact: "mine", category: "preference", sourceTurn: "t", userId: "fixture-owner",
      });
      const theirs = await rememberFact(getPool(), {
        fact: "theirs", category: "preference", sourceTurn: "t", userId: "other-owner",
      });
      await forgetFact(getPool(), mine.id, "fixture-owner");
      await forgetFact(getPool(), theirs.id, "other-owner");
      expect((await listRetiredFacts(getPool(), "fixture-owner")).facts.map((f) => f.fact)).toEqual(["mine"]);
    });

    it("reports what superseded a retired fact, when one did", async () => {
      const old = await rememberFact(getPool(), {
        fact: "train", category: "travel", sourceTurn: "t", userId: "fixture-owner",
      });
      const { retired, stored } = await supersedeFact(getPool(), old.id, {
        fact: "car", category: "travel", sourceTurn: "t", userId: "fixture-owner",
      });
      const { facts } = await listRetiredFacts(getPool(), "fixture-owner");
      const row = facts.find((f) => f.id === retired.id);
      expect(row?.supersededBy).toBe(stored.id);
    });

    it("a plain retirement (no supersede) reports supersededBy as null, not absent", async () => {
      const f = await rememberFact(getPool(), {
        fact: "en ting", category: "preference", sourceTurn: "t", userId: "fixture-owner",
      });
      await forgetFact(getPool(), f.id, "fixture-owner");
      const { facts } = await listRetiredFacts(getPool(), "fixture-owner");
      expect(facts[0]!.supersededBy).toBeNull();
    });

    it(`caps at ${RETIRED_FACTS_LIMIT} and says when the list was cut`, async () => {
      const statedAt = new Date("2026-08-25T06:00:00Z");
      for (let i = 1; i <= RETIRED_FACTS_LIMIT + 3; i++) {
        const f = await rememberFact(getPool(), {
          fact: `fact ${i}`, category: "preference", sourceTurn: "t", userId: "fixture-owner", statedAt,
        });
        await forgetFact(getPool(), f.id, "fixture-owner", statedAt);
      }
      const { facts, cut } = await listRetiredFacts(getPool(), "fixture-owner");
      expect(facts).toHaveLength(RETIRED_FACTS_LIMIT);
      expect(cut).toBe(true);
    });

    it("honours an explicit smaller limit and reports cut correctly against it", async () => {
      for (const fact of ["a", "b", "c"]) {
        const f = await rememberFact(getPool(), {
          fact, category: "preference", sourceTurn: "t", userId: "fixture-owner",
        });
        await forgetFact(getPool(), f.id, "fixture-owner");
      }
      const page = await listRetiredFacts(getPool(), "fixture-owner", 2);
      expect(page.facts).toHaveLength(2);
      expect(page.cut).toBe(true);
    });
  });
});
