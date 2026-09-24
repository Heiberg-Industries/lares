// services/atlas/tests/steady-state.test.ts
// THE MANDATORY TEST (spec §5). Everything else in this service is a hypothesis until this
// passes.
//
// The hazard is the notion-sync one: "correct for one tick, broken on the next" — eight
// instances in a single phase there, every one invisible in the diff and findable only by
// running several ticks against a real database. A job that re-proposes an already-decided
// refresh every night is not a cosmetic bug; it is the store every business agent grounds on
// churning under a human who has stopped reading the messages.
//
// So this harness is deliberately real where realness is what catches things:
//   - a real Postgres testcontainer with 019_atlas_sync.sql applied;
//   - a real git repo with a real BARE REMOTE, so writeNotes commits AND pushes for real and
//     "no commit" means the git history genuinely did not move;
//   - real fs readers for atlas: and vault:;
//   - scripted readers for repo:/notion: whose content the test controls byte by byte;
//   - a draft model that COUNTS ITS CALLS, because "the model was never asked" is a stronger
//     statement than "nothing was proposed" and catches a tick that drafts and then discards.
// `today`/`now` are pinned per tick and advanced explicitly: nothing here may read the clock.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { getOpenAtlasProposals, resolveAtlasProposal } from "@lares/agent-box";
import { startTestDb, type TestDb } from "@lares/agent-box/tests/helpers/pg.js";
import { makeAtlasWriter, type AtlasWriter } from "../lib/adapters/atlas-writer.js";
import { makeFsReader } from "../lib/adapters/fs-source.js";
import { migrateOkf } from "../lib/migrate-okf.js";
import { okfTypeFor } from "../lib/okf.js";
import { runTick, type TickDeps } from "../lib/run.js";
import type { DraftModel } from "../lib/narrative.js";
import type { ReaderMap, SourceReader, ResolvedSource } from "../lib/resolve.js";

let tdb: TestDb;
let db: Pool;
beforeAll(async () => { tdb = await startTestDb(); db = tdb.pool; }, 120_000);
afterAll(async () => { await tdb?.stop(); });

// ── The miniature store ───────────────────────────────────────────────────────────
// Shaped like the real Atlas on purpose: two venture notes (one repo-backed with LEGACY
// bare sources, one Notion-backed like SOMA), the portfolio map with its generated block,
// the entity map, an ICP profile with no frontmatter at all, and an _inbox note that is
// already conformant. Every OKF migration case the real store contains appears here.
const ALPHA = `---
brand: alpha
status: active
one_liner: A thing that does things.
codebase: /workspace/murmur/
canonical_sources: [docs/CURRENT_STATUS.md]
last_synced: 2026-06-23
---

## What it is

Old alpha text.

## Positioning / wedge

Old wedge.

## Target

Old target.

## Stage / current state

Old stage.

## Load-bearing strategy calls

- Old call.

## Brand voice

Old voice.
`;

const BETA = `---
brand: beta
status: exploration
one_liner: A quieter thing.
codebase: —
canonical_sources: ["notion:2f5cc987-b457-8094-a784-cbcc9b67493f"]
last_synced: 2026-06-23
---

## What it is

Old beta text.

## Positioning / wedge

Old wedge.

## Target

Old target.

## Stage / current state

Old stage.

## Load-bearing strategy calls

- Old call.

## Brand voice

Old voice.

Do not surface publicly.
`;

const PORTFOLIO = `---
type: portfolio-map
last_synced: 2026-06-23
---

# The portfolio

<!-- BEGIN GENERATED -->
<!-- END GENERATED -->

Hand-written footer that the generator must never eat.
`;

const FIXTURE: Record<string, string> = {
  "SCHEMA.md": "# Schema\n\nThe contract every note follows.\n",
  "README.md": "# Atlas\n\nThe business knowledge store.\n",
  "_portfolio.md": PORTFOLIO,
  "_entities.md": "---\ntype: entity-structure\n---\n\n# Entities\n\nHeiberg Industries AS.\n",
  "_projects/alpha.md": ALPHA,
  "_projects/beta.md": BETA,
  "icp/alpha.md": "# Alpha ICP\n\nWho it is for.\n",
  "_inbox/idea.md": "---\ntype: note\n---\n\nAn idea.\n",
};

let atlasPath: string;
let remotePath: string;
let vaultPath: string;
let writer: AtlasWriter;

/** Source bytes the scripted readers hand back. Mutated by tests to simulate real drift. */
let repoContent: Record<string, string>;
let notionContent: Record<string, string>;
/** Swapped by the failure test. */
let repoReader: SourceReader;

let model: { calls: number } & DraftModel;
let notifications: string[];

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: atlasPath, encoding: "utf8" }).trim();

function scriptedReader(id: string, bank: Record<string, string>): SourceReader {
  return {
    id,
    read: async (ref): Promise<ResolvedSource> => {
      const content = bank[ref.locator];
      return content === undefined
        ? { ref, outcome: "missing", reason: `no such fixture source ${ref.declared}` }
        : { ref, outcome: "found", content };
    },
  };
}

function failingReader(message: string): SourceReader {
  // `failed`, not `missing` — the ORB-51 distinction. A dropped call is not a deleted file.
  return { id: "github", read: async (ref) => ({ ref, outcome: "failed", reason: message }) };
}

beforeEach(async () => {
  await db.query("TRUNCATE atlas_proposals, atlas_notes");

  remotePath = mkdtempSync(join(tmpdir(), "atlas-steady-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remotePath });

  atlasPath = mkdtempSync(join(tmpdir(), "atlas-steady-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: atlasPath });
  for (const [k, v] of [
    ["user.email", "t@example.com"], ["user.name", "t"],
    // Isolation from ambient git config: a global commit.gpgsign would hang on a key that
    // does not exist for this identity, and a global core.hooksPath would run someone's
    // real hooks against a throwaway repo.
    ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"],
  ]) execFileSync("git", ["config", k!, v!], { cwd: atlasPath });

  for (const [path, raw] of Object.entries(FIXTURE)) {
    const full = join(atlasPath, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, raw);
  }
  execFileSync("git", ["add", "-A"], { cwd: atlasPath });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: atlasPath });
  execFileSync("git", ["remote", "add", "origin", remotePath], { cwd: atlasPath });
  execFileSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: atlasPath });

  vaultPath = mkdtempSync(join(tmpdir(), "atlas-steady-vault-"));
  writeFileSync(join(vaultPath, "index.md"), "# Vault index\n");

  writer = makeAtlasWriter({ atlasPath });
  repoContent = { "docs/CURRENT_STATUS.md": "# Alpha status\n\nShipping.\n" };
  notionContent = { "2f5cc987-b457-8094-a784-cbcc9b67493f": "# Beta\n\nEarly.\n" };
  repoReader = scriptedReader("github", repoContent);
  notifications = [];

  model = {
    calls: 0,
    // Deterministic: the same sources always yield the same prose, so a second proposal for
    // unchanged sources cannot be blamed on a model that answered differently.
    draft: async (req) => {
      model.calls++;
      return {
        sections: {
          "## What it is": `Derived ${req.brand}.`,
          "## Positioning / wedge": "Derived wedge.",
          "## Target": "Derived target.",
          "## Stage / current state": "Derived stage.",
          "## Load-bearing strategy calls": "- Derived call.",
          "## Brand voice": "Derived voice.",
        },
      };
    },
  };
});

afterEach(() => {
  for (const p of [atlasPath, remotePath, vaultPath]) rmSync(p, { recursive: true, force: true });
});

function readers(): ReaderMap {
  return {
    repo: repoReader,
    notion: scriptedReader("notion", notionContent),
    vault: makeFsReader({ id: "vault", root: vaultPath }),
    atlas: makeFsReader({ id: "atlas", root: atlasPath }),
  };
}

function deps(day: string): TickDeps {
  return {
    db, writer, readers: readers(), model,
    today: day,
    now: new Date(`${day}T09:00:00Z`),
    notify: async (m) => { notifications.push(m); },
    log: () => {},
  };
}

const snapshotFiles = (): Record<string, string> =>
  Object.fromEntries(writer.listNotes().map((p) => [p, readFileSync(join(atlasPath, p), "utf8")]));

describe("steady state — the notion-sync hazard class", () => {
  it("MIGRATES FIRST, then runs 4 more ticks with unchanged sources and proposes NOTHING", async () => {
    await migrateOkf(writer, "2026-08-12");

    // Tick one: the mechanical pass settles, and each venture note gets its first proposal —
    // nothing has been accounted for yet.
    const first = await runTick(deps("2026-08-12"));
    expect(first.narrative.proposed).toBe(2);

    // Decide both, one each way, and let the apply pass execute them.
    const open = await getOpenAtlasProposals(db);
    expect(open).toHaveLength(2);
    await resolveAtlasProposal(db, open[0]!.id, "approve");
    await resolveAtlasProposal(db, open[1]!.id, "reject");
    const second = await runTick(deps("2026-08-13"));
    expect(second.apply).toEqual({ applied: 1, rejected: 1, superseded: 0 });

    // FOUR more ticks on later days, sources untouched. This is the whole test.
    const headBefore = git("rev-parse", "HEAD");
    const modelCallsBefore = model.calls;
    for (const day of ["2026-08-14", "2026-08-15", "2026-09-01", "2027-01-01"]) {
      const t = await runTick(deps(day));
      expect(t.narrative.proposed, `tick ${day} proposed something`).toBe(0);
      expect(t.mechanical.changed, `tick ${day} rewrote files`).toEqual([]);
      expect(t.apply, `tick ${day} applied something`).toEqual({ applied: 0, rejected: 0, superseded: 0 });
    }
    // The git history is the real proof: no commit means no file moved, whatever the
    // summaries claim.
    expect(git("rev-parse", "HEAD")).toBe(headBefore);
    expect(model.calls, "the model was asked about a note that had not changed").toBe(modelCallsBefore);
  });

  it("the OKF `type:` field is never re-proposed on any later run", async () => {
    await migrateOkf(writer, "2026-08-12");
    for (const day of ["2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"]) {
      await runTick(deps(day));
      for (const p of await getOpenAtlasProposals(db)) {
        expect(p.diffPreview, "a proposal mentioned type:").not.toMatch(/type:/);
      }
    }
  });

  it("migrateOkf is a fixed point across ticks — the tick never undoes the migration", async () => {
    await migrateOkf(writer, "2026-08-12");
    await runTick(deps("2026-08-13"));
    const after = snapshotFiles();
    await runTick(deps("2026-08-14"));
    const second = await migrateOkf(writer, "2027-01-01");
    expect(second.changed).toEqual([]);
    expect(snapshotFiles()).toEqual(after);
  });

  it("a REJECTED refresh never comes back until a source actually changes", async () => {
    // The single defect shape this store cannot survive: a daily DM asking the same question
    // Bendik already answered.
    await migrateOkf(writer, "2026-08-12");
    await runTick(deps("2026-08-12"));
    const alpha = (await getOpenAtlasProposals(db)).find((p) => p.notePath === "_projects/alpha.md")!;
    await resolveAtlasProposal(db, alpha.id, "reject");
    await runTick(deps("2026-08-13"));

    for (const day of ["2026-08-14", "2026-08-15", "2026-08-16"]) {
      expect((await runTick(deps(day))).narrative.proposed, `re-asked on ${day}`).toBe(0);
    }

    // …then change one source byte, and it asks again — exactly once.
    repoContent["docs/CURRENT_STATUS.md"] += "\nShipped the thing.\n";
    expect((await runTick(deps("2026-08-17"))).narrative.proposed).toBe(1);
    expect((await runTick(deps("2026-08-18"))).narrative.proposed).toBe(0);
  });

  it("an APPROVED refresh is written once and never re-proposed", async () => {
    await migrateOkf(writer, "2026-08-12");
    await runTick(deps("2026-08-12"));
    const alpha = (await getOpenAtlasProposals(db)).find((p) => p.notePath === "_projects/alpha.md")!;
    await resolveAtlasProposal(db, alpha.id, "approve");
    await runTick(deps("2026-08-13"));

    // The prose actually landed on disk — the decision became a file, not just a row.
    expect(readFileSync(join(atlasPath, "_projects/alpha.md"), "utf8")).toContain("Derived alpha.");

    const head = git("rev-parse", "HEAD");
    for (const day of ["2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17"]) {
      const t = await runTick(deps(day));
      expect(t.narrative.proposed, `re-proposed on ${day}`).toBe(0);
      expect(t.apply.applied).toBe(0);
    }
    expect(git("rev-parse", "HEAD")).toBe(head);
  });

  it("pushes to the real remote, so the box's other containers actually see the change", async () => {
    // The writer commits AND pushes. A test with no remote would pass on a writer that only
    // ever committed locally, and the Atlas would silently stop propagating.
    await migrateOkf(writer, "2026-08-12");
    await runTick(deps("2026-08-12"));
    const localHead = git("rev-parse", "HEAD");
    const remoteHead = execFileSync("git", ["rev-parse", "main"], { cwd: remotePath, encoding: "utf8" }).trim();
    expect(remoteHead).toBe(localHead);
  });

  it("a source that fails to resolve produces NO proposal and NO note change, on every tick", async () => {
    await migrateOkf(writer, "2026-08-12");
    await runTick(deps("2026-08-12"));
    // Clear the queue so what follows is about the failure, not about a pending proposal.
    for (const p of await getOpenAtlasProposals(db)) await resolveAtlasProposal(db, p.id, "reject");
    await runTick(deps("2026-08-13"));

    repoReader = failingReader("network unreachable");
    notifications = [];
    const before = snapshotFiles();
    const callsBefore = model.calls;

    for (const day of ["2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17"]) {
      expect((await runTick(deps(day))).narrative.proposed, `proposed on ${day}`).toBe(0);
    }

    // Nothing was emptied. An unreadable source means "I could not read it", never "there is
    // nothing to say" — the distinction that had Saga fabricate a brief section.
    expect(snapshotFiles()).toEqual(before);
    expect(model.calls, "drafted from a source set with a hole in it").toBe(callsBefore);
    // Transition only: a source unreachable for four days is ONE message, not four.
    expect(notifications.filter((n) => /sources_failed/.test(n))).toHaveLength(1);
  });

  it("case- and NFC-insensitive path handling does not depend on the filesystem", () => {
    // Asserted against okfTypeFor directly, NOT by creating `_Projects/Alpha.md` on disk:
    // no CI job runs `pnpm test`, so a case-gated test silently SKIPS on Bendik's
    // case-insensitive APFS and would prove nothing on the box's case-sensitive ext4.
    expect(okfTypeFor("_PROJECTS/alpha.md")).toBe("venture");
    expect(okfTypeFor("_Projects/Alpha.md")).toBe("venture");
    expect(okfTypeFor("ICP/alpha.md")).toBe("profile");
  });
});
