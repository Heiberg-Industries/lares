import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  runArchiveExcluded, EXCLUDED_REASON,
  type ArchiveExcludedDeps, type ArchiveExcludedOptions,
} from "../lib/archive-excluded.js";
import { makeDeskExclusion } from "../lib/desk-scope.js";
import type { DeskRow } from "../lib/store.js";
import type { DesksConfig } from "../lib/types.js";

const SYNCED = (pageId: string): DeskRow => ({
  pageId, mdHash: "h", notionHash: "n", notionLastEdited: "2026-08-01T00:00:00.000Z",
  state: "synced", direction: "md_to_notion",
});

// Mirrors the T3 brief's verified ground truth: `exclude: ["transcripts"]` under
// a couple of desk dirs, one with a nested match two deep and one whose vault
// paths carry spaces, "&", an em dash and non-ASCII — the exact shapes the brief
// warns are real on the box. `orakel` has NO exclude at all, so its rows must
// never be in scope regardless of what they're named.
const DESKS: DesksConfig = {
  deskDirs: [
    { dir: "zero7", project: "Zero7", exclude: ["transcripts"] },
    { dir: "Heiberg Industries", project: "Heiberg Industries", exclude: ["transcripts"] },
    { dir: "orakel", project: "Orakel" },
  ],
  twoWayDirs: [],
  mirrorFilePrefixes: [],
};
const isExcluded = makeDeskExclusion(DESKS);
const OPTS = (dryRun: boolean): ArchiveExcludedOptions => ({ dryRun, isExcluded });

function makeDeps(cfg: {
  rows: Array<[string, DeskRow]>;
  /** pageId → what trashPage does. Default: succeeds, alreadyDone: false. */
  trashOutcomes?: Record<string, { alreadyDone: boolean } | Error>;
  /** vaultPaths whose markDocOrphaned call should throw (an UPDATE matching zero rows, say). */
  orphanFails?: Set<string>;
}) {
  const trashCalls: string[] = [];
  const orphanCalls: Array<{ vaultPath: string; reason: string }> = [];
  const callOrder: string[] = [];
  const impl: ArchiveExcludedDeps = {
    getDeskRows: async () => new Map(cfg.rows),
    trashPage: async (pageId) => {
      trashCalls.push(pageId);
      callOrder.push(`trash:${pageId}`);
      const outcome = cfg.trashOutcomes?.[pageId];
      if (outcome instanceof Error) throw outcome;
      return outcome ?? { alreadyDone: false };
    },
    markDocOrphaned: async (vaultPath, reason) => {
      callOrder.push(`orphan:${vaultPath}`);
      if (cfg.orphanFails?.has(vaultPath)) {
        throw new Error(`update matched zero rows: ${vaultPath}`);
      }
      orphanCalls.push({ vaultPath, reason });
    },
  };
  return { impl, trashCalls, orphanCalls, callOrder };
}

describe("runArchiveExcluded — T3 (Phase 4): retiring the Docs rows config carved out of desk scope", () => {
  it("dry-run: zero trash calls, zero store writes, reports every in-scope row — nested and unicode paths included", async () => {
    const rows: Array<[string, DeskRow]> = [
      ["zero7/transcripts/2026-08-01-call.md", SYNCED("p1")],
      // Nested two deep — T2's exclusion is anchored at the desk root and covers
      // the whole subtree; this pins that the archive command agrees with it.
      ["zero7/transcripts/analysis/analysis.md", SYNCED("p2")],
      // Spaces, "&", an em dash, non-ASCII — the brief's own warning about tidy slugs.
      ["Heiberg Industries/transcripts/2026-08-02 — Ole & Åse.md", SYNCED("p3")],
      // NOT excluded — same desk dir, a different sub-path. Must never appear
      // anywhere in the result: this is what the negative test below pins hard.
      ["zero7/note.md", SYNCED("p-untouched")],
    ];
    const d = makeDeps({ rows });
    const result = await runArchiveExcluded(OPTS(true), d.impl);

    expect(d.trashCalls).toEqual([]);
    expect(d.orphanCalls).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.trashed.map((r) => r.vaultPath).sort()).toEqual([
      "Heiberg Industries/transcripts/2026-08-02 — Ole & Åse.md",
      "zero7/transcripts/2026-08-01-call.md",
      "zero7/transcripts/analysis/analysis.md",
    ]);
    // "with its page id" (T3 brief) — the plan must carry enough to act on later.
    expect(result.trashed.find((r) => r.vaultPath === "zero7/transcripts/analysis/analysis.md")?.pageId)
      .toBe("p2");
    expect(result.alreadyDone).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.orphanFailed).toEqual([]);
    // Fix round 1, Important 2: unmistakable preview wording — a leading
    // DRY-RUN tag, and "would be trashed" rather than past-tense "trashed" —
    // so this string can never be confused with a real run's summary.
    expect(result.summary).toMatch(/^DRY-RUN \(nothing written\): /);
    expect(result.summary).toContain("3 would be trashed");
    expect(result.summary).not.toMatch(/\b3 trashed\b/);
    expect(result.summary).toContain("3 in scope");
  });

  it("live run: trashes each in-scope row exactly once, then marks it orphaned exactly once, trash before orphan", async () => {
    const rows: Array<[string, DeskRow]> = [
      ["zero7/transcripts/a.md", SYNCED("p1")],
      ["zero7/transcripts/b.md", SYNCED("p2")],
      ["zero7/note.md", SYNCED("p-control")], // not excluded — a real row set always has one
    ];
    const d = makeDeps({ rows });
    const result = await runArchiveExcluded(OPTS(false), d.impl);

    expect(d.trashCalls.sort()).toEqual(["p1", "p2"]);
    expect(d.orphanCalls).toEqual([
      { vaultPath: "zero7/transcripts/a.md", reason: EXCLUDED_REASON },
      { vaultPath: "zero7/transcripts/b.md", reason: EXCLUDED_REASON },
    ]);
    expect(result.dryRun).toBe(false);
    expect(result.trashed.map((r) => r.vaultPath).sort())
      .toEqual(["zero7/transcripts/a.md", "zero7/transcripts/b.md"]);
    // Per-row order is load-bearing (T3 brief): trash the page FIRST, orphan the
    // row SECOND — never interleaved across rows in a way that would let an
    // orphan land ahead of ITS OWN trash.
    expect(d.callOrder).toEqual([
      "trash:p1", "orphan:zero7/transcripts/a.md",
      "trash:p2", "orphan:zero7/transcripts/b.md",
    ]);
    // A live summary must never read like a preview (Important 2's converse).
    expect(result.summary).not.toContain("DRY-RUN");
    expect(result.summary).toContain("2 trashed");
  });

  it("a row NOT excluded by config is never touched — the critical negative test", async () => {
    // A bug in the exclusion wiring here would trash a real desk page — the one
    // failure mode the whole command exists to avoid.
    const rows: Array<[string, DeskRow]> = [
      ["zero7/transcripts/a.md", SYNCED("p-excluded")],
      ["zero7/note.md", SYNCED("p-real-work")], // same desk dir, outside "transcripts"
      ["orakel/anything.md", SYNCED("p-orakel")], // desk dir with no exclude at all
    ];
    const d = makeDeps({ rows });
    const result = await runArchiveExcluded(OPTS(false), d.impl);

    expect(d.trashCalls).toEqual(["p-excluded"]);
    expect(d.trashCalls).not.toContain("p-real-work");
    expect(d.trashCalls).not.toContain("p-orakel");
    expect(d.orphanCalls.map((o) => o.vaultPath)).toEqual(["zero7/transcripts/a.md"]);

    const everyReportedPath = [
      ...result.trashed, ...result.alreadyDone, ...result.skipped,
      ...result.failed, ...result.orphanFailed,
    ].map((r) => r.vaultPath);
    expect(everyReportedPath).not.toContain("zero7/note.md");
    expect(everyReportedPath).not.toContain("orakel/anything.md");
  });

  it("refuses to run when isExcluded matches EVERY row — defence in depth against a mis-wired predicate (fix round 1)", async () => {
    // The mutation the reviewer's testing surfaced: `isExcluded: () => true`
    // compiles, wires cleanly, and would otherwise trash the wiki mirror and
    // every desk row alongside the real 32. No real config excludes 100% of
    // the store, so this is refused outright rather than executed.
    const rows: Array<[string, DeskRow]> = [
      ["zero7/transcripts/a.md", SYNCED("p1")],
      ["wiki/some-page.md", SYNCED("p-wiki")], // no desk dir at all — a real predicate must leave this
    ];
    const d = makeDeps({ rows });
    const mutant: ArchiveExcludedOptions = { dryRun: true, isExcluded: () => true };

    await expect(runArchiveExcluded(mutant, d.impl)).rejects.toThrow(/matched EVERY row/);
    expect(d.trashCalls).toEqual([]);
    expect(d.orphanCalls).toEqual([]);
  });

  // THE destructive one (fix round 3). This command retires the Notion pages of rows
  // config has carved out of the desk scope — sound when the vault authored the page,
  // and the exact opposite when NOTION did: the page IS the document and trashing it
  // throws away the original, not a projection.
  //
  // Reachable by construction, not by accident: makeCreateScope deliberately allows
  // creates into the `transcripts` carve-out (that is where T4's transcripts live) and
  // upsertDocSynced inserts them as target='docs' with direction 'notion_to_md'. So a
  // created transcript row is BOTH excluded and Notion-owned, and lands squarely in
  // this loop's sights on the next run.
  it("NEVER trashes a Notion-owned page, even when config has excluded it", async () => {
    const notionOwned = (pageId: string): DeskRow => ({ ...SYNCED(pageId), direction: "notion_to_md" });
    const rows: Array<[string, DeskRow]> = [
      // A transcript created by T3b's create path: excluded AND Notion-owned.
      ["zero7/transcripts/2026-08-05-standup.md", notionOwned("p-transcript")],
      // An ordinary excluded mirror row — the real target of this command.
      ["zero7/transcripts/old-mirror.md", SYNCED("p-mirror")],
      // Not excluded at all, so the 100%-match guard above cannot fire instead.
      ["zero7/note.md", SYNCED("p-real-work")],
    ];
    const d = makeDeps({ rows });
    const result = await runArchiveExcluded(OPTS(false), d.impl);

    // The mirror is retired; the Notion-owned page is never touched.
    expect(d.trashCalls).toEqual(["p-mirror"]);
    expect(d.trashCalls).not.toContain("p-transcript");
    // …and its state row is left alone too — not flagged orphaned.
    expect(d.orphanCalls.map((o) => o.vaultPath)).toEqual(["zero7/transcripts/old-mirror.md"]);

    // Reported, not silently dropped: an operator must be able to see WHY a row in
    // scope was passed over.
    const skipped = result.skipped.find((r) => r.pageId === "p-transcript");
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toMatch(/notion owns this document/i);
  });

  it("does NOT refuse when every row happens to be excluded but the store is empty — nothing to protect", async () => {
    // The guard is keyed on `allRows.size > 0`: an empty store trivially has
    // "0 of 0" excluded, which must not be confused with the mutant case above.
    const d = makeDeps({ rows: [] });
    const result = await runArchiveExcluded(OPTS(true), d.impl);
    expect(result.summary).toContain("0 in scope");
  });

  it("a row already 'unmatched' is skipped, not re-trashed — the idempotent re-run case", async () => {
    const rows: Array<[string, DeskRow]> = [
      ["zero7/transcripts/a.md", { ...SYNCED("p1"), state: "unmatched" }],
      ["zero7/note.md", SYNCED("p-control")], // not excluded — a real row set always has one
    ];
    const d = makeDeps({ rows });
    const result = await runArchiveExcluded(OPTS(false), d.impl);

    expect(d.trashCalls).toEqual([]);
    expect(d.orphanCalls).toEqual([]);
    expect(result.skipped).toEqual([
      { vaultPath: "zero7/transcripts/a.md", pageId: "p1", reason: "row state is 'unmatched', not 'synced'" },
    ]);
  });

  it("skips a row in any other non-synced state too — frozen, error, retrying — never silently included", async () => {
    const rows: Array<[string, DeskRow]> = [
      ["zero7/transcripts/frozen.md", { ...SYNCED("p1"), state: "frozen" }],
      ["zero7/transcripts/error.md", { ...SYNCED("p2"), state: "error" }],
      ["zero7/transcripts/retrying.md", { ...SYNCED("p3"), state: "retrying" }],
      ["zero7/note.md", SYNCED("p-control")], // not excluded — a real row set always has one
    ];
    const d = makeDeps({ rows });
    const result = await runArchiveExcluded(OPTS(false), d.impl);

    expect(d.trashCalls).toEqual([]);
    expect(result.skipped.map((s) => s.vaultPath).sort()).toEqual([
      "zero7/transcripts/error.md", "zero7/transcripts/frozen.md", "zero7/transcripts/retrying.md",
    ]);
  });

  it("a trash call that fails leaves that row untouched, and the other rows are still processed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rows: Array<[string, DeskRow]> = [
        ["zero7/transcripts/fails.md", SYNCED("p-fails")],
        ["zero7/transcripts/ok.md", SYNCED("p-ok")],
        ["zero7/note.md", SYNCED("p-control")], // not excluded — a real row set always has one
      ];
      const d = makeDeps({ rows, trashOutcomes: { "p-fails": new Error("notion 500") } });
      const result = await runArchiveExcluded(OPTS(false), d.impl);

      expect(d.trashCalls.sort()).toEqual(["p-fails", "p-ok"]);
      // The failed row's markDocOrphaned is never called, so its store state is
      // exactly what it was before this run — a re-run retries it from the top.
      expect(d.orphanCalls.map((o) => o.vaultPath)).toEqual(["zero7/transcripts/ok.md"]);
      expect(result.failed).toEqual([
        { vaultPath: "zero7/transcripts/fails.md", pageId: "p-fails", reason: "trash failed: notion 500" },
      ]);
      expect(result.trashed.map((r) => r.vaultPath)).toEqual(["zero7/transcripts/ok.md"]);
      expect(spy.mock.calls.flat().map(String).join("\n")).toContain("trash failed");
    } finally {
      spy.mockRestore();
    }
  });

  it("a page that needs no fresh trash write (trashPage: alreadyDone) is classified as already-done, not a failure — and is still orphaned", async () => {
    // Covers BOTH real shapes trashPage's alreadyDone can mean (genuinely gone,
    // 404; or already trashed by an earlier call, 400) — this engine treats
    // them identically, which is the whole point of the adapter-level
    // classification (see notion-client.ts's trashPage, fix round 1).
    const rows: Array<[string, DeskRow]> = [
      ["zero7/transcripts/gone.md", SYNCED("p-gone")],
      ["zero7/note.md", SYNCED("p-control")], // not excluded — a real row set always has one
    ];
    const d = makeDeps({ rows, trashOutcomes: { "p-gone": { alreadyDone: true } } });
    const result = await runArchiveExcluded(OPTS(false), d.impl);

    expect(result.failed).toEqual([]);
    expect(result.alreadyDone).toEqual([{ vaultPath: "zero7/transcripts/gone.md", pageId: "p-gone" }]);
    expect(result.trashed).toEqual([]);
    // Notion has nothing left to do, but the store still owes the row an orphan —
    // "already done" is success-already-done, not "nothing to do here".
    expect(d.orphanCalls).toEqual([{ vaultPath: "zero7/transcripts/gone.md", reason: EXCLUDED_REASON }]);
  });

  it("an orphan-write failure after a successful trash is reported loudly, tells the operator to re-run (not hand-edit), and does not stop the rest", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rows: Array<[string, DeskRow]> = [
        ["zero7/transcripts/a.md", SYNCED("p1")],
        ["zero7/transcripts/b.md", SYNCED("p2")],
        ["zero7/note.md", SYNCED("p-control")], // not excluded — a real row set always has one
      ];
      const d = makeDeps({ rows, orphanFails: new Set(["zero7/transcripts/a.md"]) });
      const result = await runArchiveExcluded(OPTS(false), d.impl);

      expect(result.orphanFailed).toEqual([
        {
          vaultPath: "zero7/transcripts/a.md", pageId: "p1",
          reason: "update matched zero rows: zero7/transcripts/a.md",
        },
      ]);
      expect(result.trashed.map((r) => r.vaultPath)).toEqual(["zero7/transcripts/b.md"]);
      const logged = spy.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("could not be marked orphaned");
      // Fix round 1, Important 3: the message must point at the safe, correct
      // fix (re-run) and must NOT tell the operator to hand-edit the database
      // — the row is still 'synced', so a re-run genuinely retries it.
      expect(logged).toContain("re-running this command retries it");
      expect(logged).not.toContain("fix the database by hand");
    } finally {
      spy.mockRestore();
    }
  });

  it("re-running after an orphan-write failure actually heals the row — proves the claim in the error message", async () => {
    // Not just a message check: this drives the SAME scenario a second time,
    // with the orphan write now succeeding (as it would on a real re-run),
    // and confirms the row reaches 'orphaned' — the row's DB state was never
    // touched by the failed attempt, so nothing here is special-cased for a
    // second run; it is just an ordinary synced row again.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rows: Array<[string, DeskRow]> = [
        ["zero7/transcripts/a.md", SYNCED("p1")],
        ["zero7/note.md", SYNCED("p-control")], // not excluded — a real row set always has one
      ];
      const failingDeps = makeDeps({ rows, orphanFails: new Set(["zero7/transcripts/a.md"]) });
      const first = await runArchiveExcluded(OPTS(false), failingDeps.impl);
      expect(first.orphanFailed).toHaveLength(1);

      // Re-run: same row (still 'synced' — the failed attempt never wrote it),
      // this time markDocOrphaned succeeds.
      const healingDeps = makeDeps({ rows });
      const second = await runArchiveExcluded(OPTS(false), healingDeps.impl);
      expect(second.orphanFailed).toEqual([]);
      expect(second.trashed.map((r) => r.vaultPath)).toEqual(["zero7/transcripts/a.md"]);
      expect(healingDeps.orphanCalls).toEqual([{ vaultPath: "zero7/transcripts/a.md", reason: EXCLUDED_REASON }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("has no filesystem capability at all — the ENGINE (not the whole command; see cli.ts's wrapper test) survives untouched", () => {
    // vi.spyOn on node:fs's own exports throws ("Cannot redefine property") in
    // this runtime: Node's native ESM loader hands back a non-configurable
    // namespace object for a real builtin, so a live call-count spy is not
    // available here. What IS provable, and just as decisive: this engine's own
    // source never mentions a filesystem module, a shell/git escape hatch, or a
    // vault adapter anywhere, so there is no code path — reachable by any
    // input, dry-run or live — that could touch a vault file. Same technique
    // tests/neutrality.test.ts already uses for its own "this file must never
    // reference X" invariants.
    //
    // Scope note (fix round 1, Minor 2): this checks lib/archive-excluded.ts
    // ONLY. `syncArchiveExcludedOnce` (lib/cli.ts) is a different file that DOES
    // import writeFileSync and the vault writer — for OTHER commands' sake —
    // so scanning cli.ts this way would be meaningless. The wrapper's own lack
    // of vault access is proven instead, dynamically, by
    // tests/cli.test.ts's "syncArchiveExcludedOnce ... never touches the
    // filesystem" case (a vaultPath pointed at a directory that does not
    // exist, which a real vault touch would fail loudly against).
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "lib", "archive-excluded.ts"), "utf8");
    const forbidden = [
      "node:fs", "from \"fs\"", "vault-writer", "vault-files", "vault-walk",
      "readFileSync", "writeFileSync", "child_process", "execSync", "spawn",
    ];
    for (const name of forbidden) {
      expect(src.includes(name), `archive-excluded.ts must not reference ${name}`).toBe(false);
    }
  });
});
