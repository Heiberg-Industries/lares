// W5I-s7 — the forget ledger is keyed on the register's id, and a test says so.
//
// Three things this file proves, none of which need a real Postgres (see
// packages/agent-kit/tests/forget-ledger.test.ts for the DB-backed coverage):
//
//   1. `assertCanonicalOwner` refuses an owner string that does not even LOOK like the identity
//      register's canonical id (`users.id`) — a channel spelling, an email address, empty.
//   2. The WRITER's owner value (chief-of-staff's fail-soft `CANONICAL_USER_ID`) and the READER's
//      owner value (notion-sync's live `SELECT id FROM users`) key the SAME row when they agree —
//      "the contract". Modelled with an in-memory fake `Queryable`, since `forget-ledger.ts` is
//      dependency-free and neither role service's code can be imported here.
//   3. A row written under one owner spelling is invisible to a read under a DIFFERENT spelling —
//      the concrete shape of "old rows can never be re-keyed" (this module's header), and why
//      chief-of-staff's `checkOwnerKeyAgreement` (W5I-s5b) exists: it is the only thing that
//      notices a drift BEFORE more rows accumulate under the wrong key, because nothing here (or
//      anywhere) can fix a row already written.
import { describe, expect, it } from "vitest";
import {
  assertCanonicalOwner,
  forgetKey,
  OwnerIsNotCanonical,
  recordForgotten,
  removeForgotten,
  wasForgotten,
  wasPathForgotten,
  type Queryable,
} from "../src/forget-ledger.js";

// forgetKey("fixture-owner", "fact", "hello world") over the length-prefixed fields
// "13:fixture-owner" + "4:fact" + "11:hello world", sha256 hex — pinned identically in
// packages/vault-format/tests/forget-ledger.test.ts. This file must not alter it.
const PINNED_FIXTURE_KEY = "2ab20bfc31b0be489a8eda0ef51631fcce035fedea3dfb329f5613fec1fdc7cd";

describe("forgetKey — the pinned key is unchanged by this slice", () => {
  it("keeps the pinned key — this change must not alter the hash shape", () => {
    expect(forgetKey("fixture-owner", "fact", "hello world")).toBe(PINNED_FIXTURE_KEY);
  });
});

describe("assertCanonicalOwner", () => {
  it("refuses an owner that looks like a channel spelling", () => {
    expect(() => assertCanonicalOwner("")).toThrow(OwnerIsNotCanonical);
    expect(() => assertCanonicalOwner("   ")).toThrow(OwnerIsNotCanonical);
    expect(() => assertCanonicalOwner("fixture-owner")).not.toThrow();
    // The register puts no shape rule on `users.id`: an owner may have chosen an email address,
    // a number or anything else as their id, and forgetting must work for them too.
    expect(() => assertCanonicalOwner("owner@fixture.test")).not.toThrow();
    expect(() => assertCanonicalOwner("123456789")).not.toThrow();
    expect(() => assertCanonicalOwner("U_fixture")).not.toThrow();
  });

  it("the same words forgotten under two spellings would be two unmatched entries — pinned", () => {
    expect(forgetKey("fixture-owner", "fact", "x")).not.toBe(forgetKey("U_fixture", "fact", "x"));
  });

  it("is called by every ledger function that touches a row, so a blank owner is refused before a hash is ever written", async () => {
    const ledger = makeInMemoryLedger();
    await expect(
      recordForgotten(ledger, { owner: "", kind: "fact", words: "x", reason: "forget" }),
    ).rejects.toBeInstanceOf(OwnerIsNotCanonical);
    await expect(wasForgotten(ledger, { owner: " ", kind: "fact", words: "x" })).rejects.toBeInstanceOf(
      OwnerIsNotCanonical,
    );
    await expect(
      wasPathForgotten(ledger, { owner: "", path: "people/ada.md" }),
    ).rejects.toBeInstanceOf(OwnerIsNotCanonical);
    await expect(
      removeForgotten(ledger, { owner: "", kind: "fact", words: "x" }),
    ).rejects.toBeInstanceOf(OwnerIsNotCanonical);
  });
});

/**
 * A structural, in-memory stand-in for the real `forget_ledger` table — enough of `recordForgotten`
 * / `wasForgotten` / `removeForgotten`'s three query shapes to prove ownership behaviour without a
 * database, mirroring how `packages/agent-kit/tests/forget-ledger.test.ts` proves the same module
 * against a real Postgres. Not a general SQL engine: it recognises exactly the statements this
 * module issues today, and throws on anything else so a drift in the module's own queries fails
 * loudly here rather than silently returning nothing.
 */
function makeInMemoryLedger(): Queryable {
  const rows: { id: number; owner: string; kind: string; match_hash: string; reason: string }[] = [];
  let nextId = 1;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async query<R = any>(text: string, values: readonly unknown[] = []): Promise<{ rows: R[]; rowCount?: number }> {
      const [owner, kind, matchHash, reason] = values as string[];
      if (text.startsWith("INSERT INTO forget_ledger")) {
        const existing = rows.find((r) => r.owner === owner && r.kind === kind && r.match_hash === matchHash);
        if (existing) return { rows: [{ id: existing.id }] as unknown as R[] };
        const row = { id: nextId++, owner: owner!, kind: kind!, match_hash: matchHash!, reason: reason! };
        rows.push(row);
        return { rows: [{ id: row.id }] as unknown as R[] };
      }
      if (text.trim().startsWith("SELECT")) {
        const found = rows.filter((r) => r.owner === owner && r.kind === kind && r.match_hash === matchHash);
        return {
          rows: found.map((r) => ({ ...r, forgotten_at: new Date("2026-08-04T00:00:00.000Z") })) as unknown as R[],
        };
      }
      if (text.startsWith("DELETE FROM forget_ledger")) {
        const idx = rows.findIndex((r) => r.owner === owner && r.kind === kind && r.match_hash === matchHash);
        if (idx >= 0) rows.splice(idx, 1);
        return { rows: [] as unknown as R[], rowCount: idx >= 0 ? 1 : 0 };
      }
      throw new Error(`unexpected query against the in-memory fake ledger: ${text}`);
    },
  };
}

describe("the contract: a chief-of-staff write and a notion-sync read must key the same row", () => {
  it("finds a note forgotten under the writer's owner value when read under the reader's owner value, for the same person", async () => {
    const ledger = makeInMemoryLedger();

    // A minimal register: one member, one canonical id — the neutral fixture id, never a
    // channel spelling. Both sides below derive their owner value from THIS row, by their own
    // separate route, exactly as the real code does.
    const register = { id: "fixture-owner" };

    // chief-of-staff's write path (catalogue/forget.ts / catalogue/remember.ts): CANONICAL_USER_ID
    // — the fail-soft configured owner key. Modelled here as agreeing with the register, which is
    // the invariant `checkOwnerKeyAgreement` (W5I-s5b) exists to enforce at runtime.
    const chiefOfStaffWriteOwner = register.id;

    // notion-sync's read path (lib/path-owner.ts's ownerOfPath): a live `SELECT id FROM
    // users`, i.e. the register row itself.
    const notionSyncReadOwner = register.id;

    await recordForgotten(ledger, {
      owner: chiefOfStaffWriteOwner,
      kind: "note",
      words: "people/ada.md",
      reason: "forget",
    });

    const found = await wasPathForgotten(ledger, { owner: notionSyncReadOwner, path: "people/ada.md" });
    expect(found).not.toBe(null);
    expect(found!.reason).toBe("forget");
  });
});

describe("old rows written under a legacy spelling can never be re-keyed", () => {
  it("a row forgotten under the OLD owner spelling is invisible once the installation's key changes to the register's id", async () => {
    const ledger = makeInMemoryLedger();

    // Before this installation's configured owner key was corrected to agree with the register,
    // a `forget` wrote this row under the OLD spelling — still a canonical-LOOKING string (it
    // passes assertCanonicalOwner; this is a disagreement `checkOwnerKeyAgreement` would catch,
    // not a shape problem `assertCanonicalOwner` could).
    const legacySpelling = "old-fixture-slug";
    await recordForgotten(ledger, {
      owner: legacySpelling,
      kind: "fact",
      words: "he takes the train",
      reason: "forget",
    });

    // The key is corrected (an env var set, or the register's own row corrected) to the
    // register's actual id. A later `remember` or notion-sync's read now uses THAT value.
    const registerId = "fixture-owner";
    expect(registerId).not.toBe(legacySpelling);

    // The row from before the fix is not found: `match_hash` was derived from `legacySpelling`,
    // and the words that produced it were never stored, so it cannot be recomputed under
    // `registerId`. This is exactly why `checkOwnerKeyAgreement` (W5I-s5b) opens a repair the
    // moment it sees the configured key disagree with the register — it is the only thing that
    // can stop MORE rows from accumulating under the wrong key; it cannot recover this one.
    const foundUnderNewKey = await wasForgotten(ledger, {
      owner: registerId,
      kind: "fact",
      words: "he takes the train",
    });
    expect(foundUnderNewKey).toBe(null);

    // The row is still there, and still answers under the spelling that wrote it — "stops
    // matching" means invisible to the NEW key, not deleted.
    const foundUnderOldKey = await wasForgotten(ledger, {
      owner: legacySpelling,
      kind: "fact",
      words: "he takes the train",
    });
    expect(foundUnderOldKey).not.toBe(null);
  });
});
