// services/atlas/tests/run.test.ts
// The tick, assembled — and the ORDER, which is load-bearing (apply → mechanical →
// narrative; see lib/run.ts's own header for why). Real Postgres via the house
// testcontainer harness, the fake AtlasWriter from tests/helpers/fake-writer.ts, and the
// TickDeps builder from tests/helpers/tick-deps.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";
import {
  getOpenAtlasProposals, insertAtlasProposal, resolveAtlasProposal, upsertAtlasNote,
  type AtlasProposalInput,
} from "@lares/agent-box";
import { startTestDb, type TestDb } from "@lares/agent-box/tests/helpers/pg.js";
import { runMechanical, runTick } from "../lib/run.js";
import { SECTIONS, type DraftModel, type Draft } from "../lib/narrative.js";
import type { ReaderMap, SourceReader } from "../lib/resolve.js";
import { parseNote } from "../lib/frontmatter.js";
import { bodyHash, sourcesHash } from "../lib/fingerprint.js";
import { fakeWriter } from "./helpers/fake-writer.js";
import { makeTickDeps, stubReaders, stubModel } from "./helpers/tick-deps.js";

let tdb: TestDb;
let db: Pool;
beforeAll(async () => { tdb = await startTestDb(); db = tdb.pool; }, 180_000);
afterAll(async () => { await tdb?.stop(); });
beforeEach(async () => { await db.query("TRUNCATE atlas_proposals, atlas_notes"); });

const PORTFOLIO_RAW = `---
type: index
---

# Portfolio

<!-- BEGIN GENERATED -->

<!-- END GENERATED -->
`;

/** A fully OKF-conformant venture note — mechanical is a no-op against this fixture. */
const noteRaw = (brand: string, body = "Old text.") => `---
type: venture
brand: ${brand}
status: active
one_liner: A thing.
codebase: /workspace/${brand}/
canonical_sources: ["repo:README.md"]
---

## What it is

${body}

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

## Canonical links

- Spec: \`docs/DESIGN_SPEC.md\`
`;

/** Legacy shape mechanicalRefresh actually rewrites: no `type:`, a bare canonical source. */
const legacyNoteRaw = (brand: string) => `---
brand: ${brand}
status: exploration
one_liner: A thing.
codebase: /workspace/${brand}/
canonical_sources: [README.md]
---

## What it is

Old text.

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

## Canonical links

- Spec: \`docs/DESIGN_SPEC.md\`
`;

const draftModel = (): DraftModel => ({
  draft: async (): Promise<Draft> => ({
    sections: Object.fromEntries(SECTIONS.map((s) => [s, `New ${s}.`])),
  }),
});

function fixedRepoReaders(content: string): ReaderMap {
  const repo: SourceReader = { id: "repo", read: async (ref) => ({ ref, outcome: "found", content }) };
  return { ...stubReaders(), repo };
}

function failingRepoReaders(message: string): ReaderMap {
  const repo: SourceReader = { id: "repo", read: async () => { throw new Error(message); } };
  return { ...stubReaders(), repo };
}

const proposalInput = (over: Partial<AtlasProposalInput> = {}): AtlasProposalInput => ({
  notePath: "_projects/soma.md",
  proposedNote: noteRaw("soma", "irrelevant prior draft"),
  baseBodyHash: bodyHash(parseNote(noteRaw("soma")).body),
  sourcesHash: "src-1",
  diffPreview: "x",
  ...over,
});

describe("runMechanical", () => {
  it("isolates a path okfTypeFor cannot map — every other note still refreshes and gets written", async () => {
    const w = fakeWriter({
      "orphan/mystery.md": "# mystery\n", // no okfTypeFor rule for "orphan/"
      "_projects/healthy.md": legacyNoteRaw("healthy"),
      "_portfolio.md": PORTFOLIO_RAW,
    });
    const res = await runMechanical(makeTickDeps(db, w));

    expect(res.failures).toEqual([
      { path: "orphan/mystery.md", error: expect.stringContaining("no OKF type is defined") },
    ]);
    expect(res.changed).toContain("_projects/healthy.md");
    expect(w.files["_projects/healthy.md"]).toContain("type: venture");
    expect(w.files["_projects/healthy.md"]).toContain('canonical_sources: ["repo:README.md"]');
    expect(w.files["orphan/mystery.md"]).toBe("# mystery\n"); // left untouched
  });

  it("isolates a venture note with a bare legacy source and codebase: — — every other note still refreshes", async () => {
    const noCodebase = `---
brand: nocodebase
status: exploration
one_liner: A thing.
codebase: —
canonical_sources: [README.md]
---

## What it is

Body.
`;
    const w = fakeWriter({
      "_projects/nocodebase.md": noCodebase,
      "_projects/healthy.md": legacyNoteRaw("healthy"),
      "_portfolio.md": PORTFOLIO_RAW,
    });
    const res = await runMechanical(makeTickDeps(db, w));

    expect(res.failures).toEqual([
      { path: "_projects/nocodebase.md", error: expect.stringContaining("no store prefix") },
    ]);
    expect(res.changed).toContain("_projects/healthy.md");
    expect(w.files["_projects/nocodebase.md"]).toBe(noCodebase); // left untouched
  });

  it("a venture note whose frontmatter cannot be re-parsed for its portfolio card doesn't stop the batch write for its healthy neighbours", async () => {
    // Starts with "---\n" (so ensureFrontmatter never prepends a second block) but has no
    // closing fence at all — mechanicalRefresh's own parseNote(raw) throws here too, so
    // this note is caught by BOTH the main loop and (defensively) the card-building loop.
    const unterminated = "---\ntype: venture\nbrand: broken\n\n## What it is\n\nNo closing fence, ever.\n";
    const w = fakeWriter({
      "_projects/broken.md": unterminated,
      "_projects/healthy.md": legacyNoteRaw("healthy"),
      "_portfolio.md": PORTFOLIO_RAW,
    });
    const res = await runMechanical(makeTickDeps(db, w));

    // Recorded once, not twice, even though both the refresh loop and the card loop would
    // otherwise hit the same throw.
    expect(res.failures.filter((f) => f.path === "_projects/broken.md").length).toBe(1);
    expect(res.changed).toContain("_projects/healthy.md");
    expect(w.files["_projects/healthy.md"]).toContain("type: venture");
    expect(w.files["_projects/broken.md"]).toBe(unterminated); // left untouched
  });

  it("SKIPS an unmarked _portfolio.md QUIETLY — hand-written by choice is not a failure", async () => {
    // Bendik's call, 2026-08-12, made against the real rendered output: the map stays
    // hand-written, because generating it would flatten four meaningful sections into one
    // alphabetical list, drop the Lares line, and write brand slugs over real names.
    // The markers are the opt-in, so their ABSENCE must be silent — a "failure" reported on
    // every tick for a file nobody intends to generate is noise that trains a human to skim
    // past the tick where something is genuinely wrong.
    const w = fakeWriter({
      "_projects/healthy.md": legacyNoteRaw("healthy"),
      "_portfolio.md": "---\ntype: index\n---\n\n# Portfolio\n\nNo generated markers here.\n",
    });
    const res = await runMechanical(makeTickDeps(db, w));

    expect(res.failures).toEqual([]);
    expect(res.changed).not.toContain("_portfolio.md");
    expect(w.files["_portfolio.md"]).toContain("No generated markers here.");   // untouched
    expect(res.changed).toContain("_projects/healthy.md");                      // neighbours still refresh
    expect(w.files["_projects/healthy.md"]).toContain("type: venture");
  });

  it("STILL fails loudly on HALF a marker pair — that is damage, not a decision", async () => {
    // An opening marker with no closing one is a file someone edited badly, not a file
    // someone chose to own. Silence is right for the first and wrong for the second, so the
    // two must not be collapsed into one behaviour.
    const w = fakeWriter({
      "_projects/healthy.md": legacyNoteRaw("healthy"),
      "_portfolio.md": "---\ntype: index\n---\n\n<!-- BEGIN GENERATED -->\n- orphaned\n",
    });
    const res = await runMechanical(makeTickDeps(db, w));

    expect(res.failures).toEqual([
      { path: "_portfolio.md", error: expect.stringContaining("BEGIN GENERATED") },
    ]);
    expect(res.changed).toContain("_projects/healthy.md");   // isolated, as before
  });

  it("is a no-op (no write, nothing changed) over an already-conformant bundle", async () => {
    const w = fakeWriter({
      "_projects/soma.md": noteRaw("soma"),
      "_portfolio.md": `---\ntype: index\n---\n\n<!-- BEGIN GENERATED -->\n\n- **soma** — A thing. **active.** → \`_projects/soma.md\`\n\n<!-- END GENERATED -->\n`,
    });
    const res = await runMechanical(makeTickDeps(db, w));
    expect(res).toEqual({ changed: [], failures: [] });
    expect(w.commits.length).toBe(0);
  });
});

describe("runTick — pass order", () => {
  it("applies BEFORE it proposes — a rejected decision recorded THIS tick stops narrative re-proposing it immediately", async () => {
    // atlas_proposals_open deliberately excludes 'rejected', so if narrative ran before
    // apply had a chance to record the accounted-for fingerprint, it would see "sources
    // changed since last accounted" (the accounted hash still predates the rejection) and
    // raise the identical proposal again — the exact defect apply-first exists to close.
    const raw = noteRaw("soma");
    const w = fakeWriter({ "_projects/soma.md": raw, "_portfolio.md": PORTFOLIO_RAW });

    const resolvedRef = { prefix: "repo" as const, locator: "README.md", declared: "repo:README.md" };
    const expectedHash = sourcesHash([{ ref: resolvedRef, outcome: "found", content: "SAME CONTENT" }]);

    await upsertAtlasNote(db, { notePath: "_projects/soma.md", brand: "soma", bodyHash: bodyHash(parseNote(raw).body) });
    const proposalId = await insertAtlasProposal(db, proposalInput({
      baseBodyHash: bodyHash(parseNote(raw).body),
      sourcesHash: expectedHash,
    }));
    await resolveAtlasProposal(db, proposalId, "reject");

    const deps = makeTickDeps(db, w, { readers: fixedRepoReaders("SAME CONTENT"), model: stubModel });
    const result = await runTick(deps);

    expect(result.apply.rejected).toBe(1);
    expect(result.narrative.proposed).toBe(0);
    // Specifically the "unchanged" skip, not some other reason: `model` is a stub that
    // THROWS if narrative ever gets as far as drafting. Were apply to run after narrative,
    // narrative would see the still-stale accounted hash, decide the sources genuinely
    // changed, and reach the model — turning this into a caught throw instead of a clean
    // skip. Asserting the reason, not just the count, is what makes this discriminate the
    // two orderings rather than passing either way.
    expect(result.narrative.skipped.find((s) => s.path === "_projects/soma.md")?.reason).toMatch(/unchanged/i);
    const stillOpenForSoma = (await getOpenAtlasProposals(db)).filter((p) => p.notePath === "_projects/soma.md");
    expect(stillOpenForSoma).toEqual([]);
  });

  it("runs the mechanical pass BEFORE the narrative pass — an approval two ticks later is applied, never superseded", async () => {
    // Seed a legacy note (bare canonical_sources, no type:). Tick 1: mechanical refreshes
    // its frontmatter, then narrative proposes from the (already-refreshed) note. Approve,
    // then run a second tick: apply must APPLY the proposal, never supersede it — which it
    // would if narrative's base_body_hash had been taken against a body mechanical was
    // still about to rewrite out from under it.
    const raw = legacyNoteRaw("soma");
    const w = fakeWriter({ "_projects/soma.md": raw, "_portfolio.md": PORTFOLIO_RAW });
    const deps1 = makeTickDeps(db, w, { readers: fixedRepoReaders("NEW CONTENT"), model: draftModel() });

    const tick1 = await runTick(deps1);
    expect(tick1.mechanical.changed).toContain("_projects/soma.md");
    expect(tick1.narrative.proposed).toBe(1);

    const open = await getOpenAtlasProposals(db);
    const proposal = open.find((p) => p.notePath === "_projects/soma.md");
    expect(proposal).toBeDefined();
    await resolveAtlasProposal(db, proposal!.id, "approve");

    const deps2 = makeTickDeps(db, w, { readers: fixedRepoReaders("NEW CONTENT"), model: draftModel() });
    const tick2 = await runTick(deps2);

    expect(tick2.apply.applied).toBe(1);
    expect(tick2.apply.superseded).toBe(0);
    expect(w.files["_projects/soma.md"]).toContain("New ## What it is.");
    // The order matters exactly here: the proposal's frontmatter is carried over verbatim
    // from whatever narrative read at propose time (decideNote only rewrites the body). If
    // narrative had run BEFORE mechanical, the applied file would silently REVERT tick 1's
    // frontmatter fix back to the legacy, unrefreshed shape — applied successfully (body
    // hash still matches either way, since mechanical never touches the body), but wrong.
    expect(w.files["_projects/soma.md"]).toContain("type: venture");
    expect(w.files["_projects/soma.md"]).toContain('canonical_sources: ["repo:README.md"]');
  });

  it("keeps going when one note throws — the healthy note still gets proposed, the broken one is skipped with a reason", async () => {
    const unterminated = "---\ntype: venture\nbrand: broken\n\n## What it is\n\nNo closing fence, ever.\n";
    const w = fakeWriter({
      "_projects/broken.md": unterminated,
      "_projects/healthy.md": noteRaw("healthy"),
      "_portfolio.md": PORTFOLIO_RAW,
    });
    const deps = makeTickDeps(db, w, { readers: fixedRepoReaders("NEW CONTENT"), model: draftModel() });
    const result = await runTick(deps);

    expect(result.mechanical.failures.some((f) => f.path === "_projects/broken.md")).toBe(true);
    expect(result.narrative.skipped.some((s) => s.path === "_projects/broken.md")).toBe(true);
    expect(result.narrative.proposed).toBe(1);

    const open = await getOpenAtlasProposals(db);
    expect(open.map((p) => p.notePath)).toEqual(["_projects/healthy.md"]);
  });

  it("pings on a source-health TRANSITION and stays quiet while the state holds", async () => {
    const raw = noteRaw("soma");
    const w = fakeWriter({ "_projects/soma.md": raw, "_portfolio.md": PORTFOLIO_RAW });
    const readers = failingRepoReaders("ECONNREFUSED");

    const deps1 = makeTickDeps(db, w, { readers, model: stubModel });
    await runTick(deps1);
    const deps2 = makeTickDeps(db, w, { readers, model: stubModel });
    await runTick(deps2);

    const healthPings = [...deps1.notifications, ...deps2.notifications]
      .filter((m) => /flagged/i.test(m));
    expect(healthPings.length).toBe(1);

    // Task 15: a source-health transition must carry key: "source-health" — that is what
    // makes notify send severity "warn" (data-quality/warn has a spine route; the "info" it
    // shipped as before this task never did, which is how the first live SOMA alert vanished).
    const healthCalls = [...deps1.notifyCalls, ...deps2.notifyCalls]
      .filter((c) => /flagged/i.test(c.message));
    expect(healthCalls).toHaveLength(1);
    expect(healthCalls[0]?.opts).toEqual({ key: "source-health" });
  });
});
