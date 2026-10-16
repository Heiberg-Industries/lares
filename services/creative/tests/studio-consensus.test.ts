/**
 * The Atlas → consensus seam (`lib/studio/atlas-consensus.ts`).
 *
 * This is the ONE piece of genuinely new code in the studio port: `consensus.ts` came over
 * verbatim, but the shapes it is fed changed. The old runtime handed it `agent-box`'s
 * `makeBrainDeps(atlasPath)`, whose `search`/`read` were already `Promise<string[]>` /
 * `Promise<string>`. `@lares/agent-kit/notes-store` is a different engine with different
 * shapes — `searchNotes(q, root)` is SYNCHRONOUS and returns `{hits, files}`, `readNote(p, root)`
 * is SYNCHRONOUS and returns `{path, content, lines}` — so the ranking behaviour the creative agent
 * depends on is only as good as this adapter. That is what these tests exercise: the real kit
 * against a real temp directory, no fakes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorePathNotConfiguredError, StoreUnhealthyError } from "@lares/agent-kit/notes-store";
import { makeAtlasConsensus } from "../lib/studio/atlas-consensus.js";

const ORG_TWO = "Org Two is an agentic AI consultancy for regional enterprises.";
// Deliberately carries the generic word "market" so a second company brief has a decoy to grab: this is
// the live failure the ported consensus.ts guards against (a second brief grounded on a different brand note).
const ANOTHER_PRODUCT = "Another Product turns meetings into structured notes. Its market is regional consultancies.";
const SAVED_SPREAD = "Saved spread for org-two: ten wedges we already generated for org-two.";

const roots: string[] = [];

function makeAtlas(): string {
  const root = mkdtempSync(join(tmpdir(), "creative-agent-atlas-"));
  roots.push(root);
  mkdirSync(join(root, "_brands"), { recursive: true });
  mkdirSync(join(root, "_inbox"), { recursive: true });
  writeFileSync(join(root, "_brands", "org-two.md"), `# Org Two\n${ORG_TWO}\n`);
  writeFileSync(join(root, "_brands", "another-product.md"), `# Another Product\n${ANOTHER_PRODUCT}\n`);
  writeFileSync(join(root, "_inbox", "saved-spread.md"), `# Spread\n${SAVED_SPREAD}\n`);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("makeAtlasConsensus", () => {
  /**
   * The supplement's acceptance test: a real Atlas, and the consensus text names what it found.
   * The ordering assertion is the part that matters — the BRAND note must lead, because the
   * consensus is truncated at `maxChars` and fed to the proposers as "what is already known
   * here". A run that leads with the wrong brand's note produces confidently off-brief ideas.
   */
  it("reads real notes from a store root and puts the brand note first", async () => {
    const consensus = makeAtlasConsensus({ root: makeAtlas() });
    const out = await consensus("three go-to-market wedges for Org Two");

    expect(out).toContain(ORG_TWO);
    expect(out).toContain(ANOTHER_PRODUCT); // topN defaults to 3, so the decoy is included…
    expect(out.indexOf(ORG_TWO)).toBeLessThan(out.indexOf(ANOTHER_PRODUCT)); // …but never leads
  });

  /**
   * `_inbox/` is where her own gated proposals land. Feeding them back as consensus would make
   * the studio diverge from its OWN past ideas — an echo chamber — which is why `consensus.ts`
   * excludes the prefix. The exclusion is a string test against the path shape, so it is exactly
   * the kind of guard a change of search engine can silently break: the kit returns
   * store-relative POSIX paths (`_inbox/saved-spread.md`), and this proves the prefix still matches.
   */
  it("never grounds on her own saved spreads in _inbox/", async () => {
    const consensus = makeAtlasConsensus({ root: makeAtlas() });
    const out = await consensus("wedges for org-two");

    expect(out).toContain(ORG_TWO);
    expect(out).not.toContain(SAVED_SPREAD);
  });

  /**
   * The one branch that still degrades quietly, and the reason the two below must not: a HEALTHY
   * store where the brief simply matched nothing is a real answer about a real Atlas, and her
   * persona's job is to relay it. `renderSpread` decides the grounding line from this exact
   * sentinel — the coupling is pinned in studio-render.test.ts.
   */
  it("returns the no-material sentinel when a healthy Atlas matches nothing", async () => {
    const consensus = makeAtlasConsensus({ root: makeAtlas() });
    expect(await consensus("quantum submarine liturgy")).toMatch(/^\(no prior/);
  });

  /**
   * The deploy bug, made loud. An unset ATLAS_PATH would otherwise be swallowed by
   * makeBrainConsensus's `.catch(() => [])` and read as "no Atlas note matched this brief" —
   * she would run ungrounded forever while sounding perfectly reasonable. Both halves are
   * asserted: constructing the factory is safe (`eve build` evaluates module scope with no env),
   * and only the CALL throws.
   */
  it("throws on an unset ATLAS_PATH at call time, not at construction", async () => {
    const consensus = makeAtlasConsensus({ env: {} }); // must not throw here
    await expect(consensus("anything")).rejects.toBeInstanceOf(StorePathNotConfiguredError);
  });

  /**
   * The fault the deploy cannot cause and the reviewer was right to insist on: `ATLAS_PATH` is
   * set correctly, the container starts fine, and the volume is simply not mounted. Without the
   * explicit health check this is swallowed into the sentinel and she reports, confidently, that
   * no Atlas note matched — the failure class, and the same shape as the chief of staff-dream
   * incident where a green "0 results" meant the input had died. Both sick-store shapes the kit
   * distinguishes are covered, because they arrive by different routes (a walk that raises
   * ENOENT, and a walk that succeeds but finds no markdown).
   */
  it("throws on a MISSING store directory rather than reporting no match", async () => {
    const parent = mkdtempSync(join(tmpdir(), "creative-agent-atlas-gone-"));
    roots.push(parent);
    const gone = join(parent, "not-mounted"); // the mount point that never got a volume
    await expect(makeAtlasConsensus({ root: gone })("wedges for org-two"))
      .rejects.toBeInstanceOf(StoreUnhealthyError);
  });

  it("throws on a store directory containing no markdown at all", async () => {
    const empty = mkdtempSync(join(tmpdir(), "creative-agent-atlas-empty-"));
    roots.push(empty);
    await expect(makeAtlasConsensus({ root: empty })("wedges for org-two"))
      .rejects.toBeInstanceOf(StoreUnhealthyError);
  });
});
