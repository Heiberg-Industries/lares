import { describe, it, expect, vi } from "vitest";
import { SECTIONS, renderBody, diffPreview, decideNote, type RenderResult } from "../lib/narrative.js";
import { parseNote } from "../lib/frontmatter.js";
import { bodyHash, sourcesHash } from "../lib/fingerprint.js";
import type { ResolvedSource } from "../lib/resolve.js";

/** Unwraps a RenderResult expected to have SUCCEEDED — throws loudly (not silently) if a
 *  test that assumed a clean render actually got a refusal, naming the reason. */
const rendered = (r: RenderResult): string => {
  if (!r.ok) throw new Error(`expected a successful render, got a refusal instead: ${r.reason}`);
  return r.body;
};

const src = (locator: string, content: string): ResolvedSource =>
  ({ ref: { prefix: "repo", locator, declared: `repo:${locator}` }, outcome: "found", content });
const failed = (locator: string): ResolvedSource =>
  ({ ref: { prefix: "repo", locator, declared: `repo:${locator}` }, outcome: "failed", reason: "timeout" });
const missing = (locator: string): ResolvedSource =>
  ({ ref: { prefix: "repo", locator, declared: `repo:${locator}` }, outcome: "missing", reason: "404" });

const NOTE_RAW = `---
type: venture
brand: murmur
status: active
one_liner: Local-first transcription.
public_url: —
codebase: /workspace/murmur/
canonical_sources: ["repo:README.md"]
last_synced: 2026-08-12
tags: [product]
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

// ── Round-2 property corpus: an EVEN count of fence-looking lines is not the same thing
// as a BALANCED, trustworthy pair. Each of these has exactly two, and each hides a real
// heading ("## Positioning / wedge") between them under fence-aware detection alone. ────

const TWO_UNPAIRED_FENCES_RAW = `---
type: venture
brand: murmur
canonical_sources: ["repo:README.md"]
---

## What it is

Some text.

\`\`\`bash
echo one, never closed by this line

## Positioning / wedge

Real wedge content, hand-written.

\`\`\`python
echo two — a SEPARATE stray marker, not this one's partner

## Target

Real target content.

## Stage / current state

Old stage.

## Load-bearing strategy calls

- Old call.

## Brand voice

Old voice.

## Canonical links

- kept
`;

const TWO_INDENTED_FENCE_LINES_RAW = `---
type: venture
brand: murmur
canonical_sources: ["repo:README.md"]
---

## What it is

An indented example:

    some code
    \`\`\`
    more indented code

## Positioning / wedge

Real wedge content, hand-written.

    another indented example
    \`\`\`
    more indented code

## Target

Real target content.

## Stage / current state

Old stage.

## Load-bearing strategy calls

- Old call.

## Brand voice

Old voice.

## Canonical links

- kept
`;

const MIXED_FENCE_CHARS_RAW = `---
type: venture
brand: murmur
canonical_sources: ["repo:README.md"]
---

## What it is

Some text.

\`\`\`bash
echo one

## Positioning / wedge

Real wedge content, hand-written.

~~~
echo two — a DIFFERENT fence character, no real relationship to the \`\`\` above

## Target

Real target content.

## Stage / current state

Old stage.

## Load-bearing strategy calls

- Old call.

## Brand voice

Old voice.

## Canonical links

- kept
`;

// Round-4 (A6): two stray, unpaired ``` markers bracket a REAL "## Target" section — but
// unlike the three above, "## Target" ALSO appears a second time, later, unfenced. A
// heading-TEXT subset check (round 3's mistake) is fooled by this: "## Target" IS visible
// to fence-aware detection somewhere, so the check never notices the FIRST occurrence went
// missing. The hidden occurrence's prose must never be silently dropped — either it
// survives in a successful render, or the note is safely refused; it must never disappear.
const A6_RAW = `---
type: venture
brand: murmur
canonical_sources: ["repo:README.md"]
---

## What it is

Some intro text.

\`\`\`bash
stray one, never closed by this specific fence pairing

## Target

REAL hidden Target content that must survive.

\`\`\`python
stray two, a SEPARATE marker

## Positioning / wedge

Old wedge.

## Target

SECOND Target occurrence text, further down, unfenced.

## Stage / current state

Old stage.

## Load-bearing strategy calls

- Old call.

## Brand voice

Old voice.

## Canonical links

- kept
`;

const draftModel = (sections: Partial<Record<string, string>> = {}) => ({
  draft: async () => ({
    sections: Object.fromEntries(SECTIONS.map((s) => [s, sections[s] ?? `New ${s}.`])),
  }),
});

const base = {
  notePath: "_projects/murmur.md",
  note: parseNote(NOTE_RAW),
  raw: NOTE_RAW,
  model: draftModel(),
  openProposalPaths: new Set<string>(),
};

describe("renderBody", () => {
  it("replaces the six drafted sections and KEEPS the rest of the body", () => {
    const out = rendered(renderBody({ sections: Object.fromEntries(SECTIONS.map((s) => [s, `New ${s}.`])) }, parseNote(NOTE_RAW).body));
    expect(out).toContain("New ## What it is.");
    expect(out).toContain("## Canonical links");
    expect(out).toContain("- Spec: `docs/DESIGN_SPEC.md`");   // NOT a drafted section
    expect(out).not.toContain("Old text.");
  });

  it("keeps the SCHEMA.md section order", () => {
    const out = rendered(renderBody({ sections: Object.fromEntries(SECTIONS.map((s) => [s, "x"])) }, parseNote(NOTE_RAW).body));
    const order = SECTIONS.map((s) => out.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  // ── Scrutiny: the splicing must not be fooled by a `## ` line that is not really a
  // section boundary, and must not drop or duplicate a region when it isn't. ──────────

  it("round 4: a fenced pseudo-heading whose text COINCIDES with a later real heading is safely REFUSED, not corrupted", () => {
    // This fixture predates the min-bound fix (round 1) and originally asserted a CLEAN
    // render: the fenced "## Positioning / wedge" correctly excluded, the real one drafted,
    // no leftovers. Under min-bound that clean outcome is no longer achievable for THIS
    // specific shape — and here is exactly why, worth stating precisely rather than papering
    // over: fence-BLIND next-boundary detection (needed to stop "## What it is" before the
    // real, later "## Target" et al., regardless of whether ITS OWN fences are balanced) also
    // stops "## What it is" right at the FENCED, fake "## Positioning / wedge" line — the
    // min-bound cannot distinguish "a real heading fence tracking wrongly hid" from "a fake
    // heading genuinely inside a well-formed fence"; both are just "the next `## ` line" to
    // it, by design (that is what makes the bound safe against arbitrary fence damage).
    // The fake heading line then survives as literal, undrafted text — and because its TEXT
    // happens to be the same as a REAL, later "## Positioning / wedge" that DOES get
    // drafted, the output ends up with that heading twice: once leaked, once genuine. The
    // exactly-once sanity check catches exactly that and refuses — safely: nothing is lost,
    // the note is simply left alone this tick, and a line is logged. See the "renders (does
    // not refuse)" tests below for the common case — a fenced pseudo-heading whose text does
    // NOT collide with anything real — which still renders cleanly.
    const withFence = `---
type: venture
---

## What it is

Before the fence.

\`\`\`md
## Positioning / wedge
This is example markdown text INSIDE a code fence, not a real heading.
\`\`\`

After the fence, still part of "What it is".

## Positioning / wedge

Real wedge text.

## Canonical links

- kept
`;
    const note = parseNote(withFence);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, "Drafted content, no heading text embedded."])) };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = renderBody(draft, note.body, "_projects/test.md");
    // Refused — nothing lost, nothing corrupted — and the reason names what actually
    // happened (a duplicated heading), not a lie about the draft being "identical".
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/## Positioning \/ wedge/);
    expect(note.body).toContain("Before the fence.");
    expect(note.body).toContain("Real wedge text.");
    expect(note.body).toContain("## Canonical links");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain("_projects/test.md");
    spy.mockRestore();
  });

  it("does NOT mistake a heading string appearing mid-sentence in prose for the heading itself", () => {
    const withEcho = `---
type: venture
---

## What it is

The section below explains our ## Positioning / wedge before the real heading appears.

## Positioning / wedge

Real wedge text.

## Canonical links

- kept
`;
    const note = parseNote(withEcho);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted ${s}.`])) };
    const out = rendered(renderBody(draft, note.body));
    expect(out).not.toContain("The section below explains");
    expect(out).not.toContain("Real wedge text.");
    expect(out).toContain("Drafted ## What it is.");
    expect(out).toContain("Drafted ## Positioning / wedge.");
  });

  it("puts the heading back for a body-only drafted value (does not silently strip headings)", () => {
    // The drafting adapter's contract hands back a section's PROSE without repeating its
    // own heading (draft-model.ts's prompt is the contract). A renderer that inserted that
    // verbatim, with no heading of its own, would delete "## What it is" etc. from the note
    // on every applied proposal. This is the ONLY convention renderBody understands — see
    // the next test for why a "does it already start with the heading?" sniff is unsafe.
    const note = parseNote(NOTE_RAW);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, "Body-only prose, no heading line."])) };
    const out = rendered(renderBody(draft, note.body));
    expect(out).toContain("## What it is\n\nBody-only prose, no heading line.");
  });

  it("ALWAYS prepends the schema heading, even when the drafted prose starts with a LONGER heading of its own", () => {
    // A model that opens its "## Target" prose with its own sub-heading ("## Target
    // audience") is not offering the section a substitute — it is BUSINESS PROSE, plain
    // text. A `startsWith` sniff would misread this text as "already heading-inclusive,
    // use verbatim" and the required "## Target" heading — the one Atlas's schema and
    // every other tool that reads this note expects to find — silently never gets written.
    const note = parseNote(NOTE_RAW);
    const draft = {
      sections: Object.fromEntries(SECTIONS.map((s) =>
        [s, s === "## Target" ? "## Target audience\n\nWe serve SMBs." : "Drafted content, unrelated to the heading text."])),
    };
    const out = rendered(renderBody(draft, note.body));
    expect(out).toContain("## Target audience");
    expect(out).toContain("We serve SMBs.");
    // Not just "contains the substring ## Target" (true of "## Target audience" too) — a
    // LINE that is exactly the schema heading must exist on its own.
    expect(out.split("\n")).toContain("## Target");
  });

  it("matches a heading by WHOLE-LINE equality, not by substring containment", () => {
    // A heading line that merely CONTAINS "## What it is" as a prefix — a human's own
    // "## What it is, revisited" — must never be mistaken for the schema heading itself.
    // A substring match would pick this one (it comes first in document order), splice
    // drafted content in starting here, and silently swallow this heading plus its own
    // paragraph into "## What it is"'s span.
    const withPrefixHeading = `---
type: venture
---

## What it is, revisited

Some unrelated preamble that must not be treated as "## What it is"'s content.

## What it is

Real content.

## Positioning / wedge

Real wedge.

## Canonical links

- kept
`;
    const note = parseNote(withPrefixHeading);
    const draft = {
      sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted content for ${s}, no heading text embedded.`])),
    };
    const out = rendered(renderBody(draft, note.body));
    expect(out).toContain("## What it is, revisited");
    expect(out).toContain("Some unrelated preamble");
  });

  // ── CRITICAL: fence tracking that goes unbalanced must never cost the rest of the note.
  // The invariant: renderBody must never return a body shorter than the sum of the regions
  // it was not asked to touch. ─────────────────────────────────────────────────────────

  it("does NOT delete the tail of the note when a fence is UNPAIRED (an ordinary hand-editing typo)", () => {
    const strayFence = `---
type: venture
---

## What it is

Old text.

\`\`\`bash
echo "one stray opening fence, never closed"

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

- kept

## Notes Bendik wrote by hand

- DO NOT DELETE ME
`;
    const note = parseNote(strayFence);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted content for ${s}.`])) };
    const out = rendered(renderBody(draft, note.body));
    expect(out).toContain("## Canonical links");
    expect(out).toContain("- kept");
    expect(out).toContain("## Notes Bendik wrote by hand");
    expect(out).toContain("- DO NOT DELETE ME");
  });

  it("does NOT delete the tail when a 4-space-INDENTED block merely contains something that LOOKS like a fence line", () => {
    const indentedFence = `---
type: venture
---

## What it is

Here is an indented example a human pasted:

    some code
    \`\`\`
    more code, still indented — this is CommonMark's OTHER code-block syntax, not a fence

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

- kept
`;
    const note = parseNote(indentedFence);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted content for ${s}.`])) };
    const out = rendered(renderBody(draft, note.body));
    expect(out).toContain("## Canonical links");
    expect(out).toContain("- kept");
  });

  // ── CRITICAL, round 4: verifying the OUTPUT (round 3) has the wrong shape. Checking
  // "is every heading TEXT that exists somewhere also visible somewhere" is a set-of-texts
  // check, not a per-occurrence one — a heading hidden by bad fence tracking is masked
  // whenever the SAME TEXT also happens to appear a second time, visibly, elsewhere (see
  // the A6 fixture below). It also refuses FOREVER on totally safe input: any well-formed,
  // correctly-PAIRED fence containing a `## `-looking line whose text isn't duplicated
  // unfenced trips the same check, because fence-blind sees that line as "existing" and
  // fence-aware correctly never does.
  //
  // The fix bounds each drafted span directly instead of verifying after the fact: `next`
  // is the MINIMUM of the fence-aware next heading and the fence-BLIND next heading (both
  // starting strictly after `at`, falling back to `currentBody.length`). A replaced span can
  // only swallow a heading by extending past it — bounding by the smaller of two scans, one
  // of which (fence-blind) sees every `## ` line completely unconditionally, means no
  // heading visible to EITHER scan can ever be absorbed, regardless of why fence-aware
  // missed it. The only remaining check is the cheap one: every heading actually spliced in
  // must appear in the output exactly once — if not, refuse and log, same as before. ───────

  it("renders (does not silently truncate) when TWO unpaired ``` markers, in different sections, bracket a real heading", () => {
    const note = parseNote(TWO_UNPAIRED_FENCES_RAW);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted content for ${s}.`])) };
    const out = rendered(renderBody(draft, note.body));
    // "## Positioning / wedge" never becomes a mark (still invisible to fence-aware
    // detection) so it is never freshly drafted — but the min-bound bounds "## What it
    // is"'s span to stop right before it, so it survives verbatim rather than being
    // swallowed. That is the QUALITY cost the fix accepts: a stale, undrafted heading
    // instead of either a clean re-draft (round 1) or a total refusal (round 3).
    expect(out).toContain("## Positioning / wedge");
    expect(out).toContain("Real wedge content, hand-written.");
    expect(out).toContain("## Canonical links");
    expect(out).toContain("- kept");
  });

  it("renders (does not silently truncate) when TWO indented blocks each contain a fence-looking line", () => {
    const note = parseNote(TWO_INDENTED_FENCE_LINES_RAW);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted content for ${s}.`])) };
    const out = rendered(renderBody(draft, note.body));
    expect(out).toContain("## Positioning / wedge");
    expect(out).toContain("Real wedge content, hand-written.");
    expect(out).toContain("## Canonical links");
    expect(out).toContain("- kept");
  });

  it("renders (does not silently truncate) on a MIXED ``` + ~~~ pair — different fence characters, same parity", () => {
    const note = parseNote(MIXED_FENCE_CHARS_RAW);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted content for ${s}.`])) };
    const out = rendered(renderBody(draft, note.body));
    expect(out).toContain("## Positioning / wedge");
    expect(out).toContain("Real wedge content, hand-written.");
    expect(out).toContain("## Canonical links");
    expect(out).toContain("- kept");
  });

  it("A6: a heading text that is BOTH hidden (bad fence tracking) AND duplicated (a second, visible occurrence) never loses the hidden copy's prose", () => {
    const note = parseNote(A6_RAW);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted content for ${s}.`])) };
    const result = renderBody(draft, note.body);
    // Whatever the outcome — a successful render or a safe refusal — the hidden
    // occurrence's own prose must never silently vanish. (In practice this fixture safely
    // REFUSES: the visible "## Target" gets freshly drafted while the hidden one survives
    // untouched, so "## Target" ends up appearing twice in the candidate output, and the
    // exactly-once sanity net catches exactly that and reports a refusal rather than
    // returning a body with the duplicate silently baked in.)
    if (result.ok) {
      expect(result.body).toContain("REAL hidden Target content that must survive.");
    } else {
      // A refusal means nothing was touched at all — the hidden prose trivially survives
      // in the (untouched) input, and the refusal REASON must name what actually happened,
      // not invent an unrelated one.
      expect(note.body).toContain("REAL hidden Target content that must survive.");
      expect(result.reason).toMatch(/## Target/);
    }
  });

  it("A6, end to end: decideNote never silently PROPOSES a note missing the hidden section's prose", async () => {
    const note = parseNote(A6_RAW);
    const d = await decideNote({
      notePath: "_projects/murmur.md", note, raw: A6_RAW,
      sources: [src("README.md", "NEW CONTENT")], accountedSourcesHash: "old",
      openProposalPaths: new Set<string>(), model: draftModel(),
    });
    if (d.action === "propose") {
      expect(d.proposal!.proposedNote).toContain("REAL hidden Target content that must survive.");
    }
    // action === "skip" is equally acceptable here — the failure this guards against is a
    // SILENT loss, not a refusal.
  });

  it("logs a line NAMING THE NOTE when it refuses, AND reports why in the result — a silent refusal is as bad as a silent deletion", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const note = parseNote(A6_RAW);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted content for ${s}.`])) };
    const result = renderBody(draft, note.body, "_projects/murmur.md");
    expect(result.ok).toBe(false); // confirms this fixture DOES take the refusal path
    if (!result.ok) expect(result.reason).not.toBe("");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain("_projects/murmur.md");
    spy.mockRestore();
  });

  // ── The other direction: a well-formed, correctly-PAIRED fence containing a `## `-
  // looking line must never be refused forever just because that line's text happens not
  // to be duplicated anywhere unfenced. Each of these regressed under round 3's check. ───

  it("renders (does not refuse) a paired ``` fence containing a unique `## Example` line", () => {
    const raw = `---
type: venture
---

## What it is

Some intro.

\`\`\`md
## Example
Not a real heading, inside a well-formed paired fence.
\`\`\`

More text, still part of What it is.

## Canonical links

- kept
`;
    const note = parseNote(raw);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted content for ${s}.`])) };
    const result = renderBody(draft, note.body);
    expect(result.ok).toBe(true); // it actually rendered, rather than refusing
    const out = rendered(result);
    expect(out).toContain("## Example"); // fenced content intact — never touched, never lost
    expect(out).toContain("## Canonical links");
    expect(out).toContain("- kept");
  });

  it("renders (does not refuse) a paired ~~~ fence containing a unique `## Notes` line", () => {
    const raw = `---
type: venture
---

## What it is

Some intro.

~~~
## Notes
Not a real heading, inside a well-formed paired tilde fence.
~~~

More text, still part of What it is.

## Canonical links

- kept
`;
    const note = parseNote(raw);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted content for ${s}.`])) };
    const result = renderBody(draft, note.body);
    expect(result.ok).toBe(true);
    const out = rendered(result);
    expect(out).toContain("## Notes");
    expect(out).toContain("## Canonical links");
    expect(out).toContain("- kept");
  });

  it("renders (does not refuse) a fence whose marker lines have trailing spaces", () => {
    const raw = `---
type: venture
---

## What it is

Some intro.

\`\`\`
## TrailingSpaceExample
Fence markers on this block have trailing spaces after the backticks.
\`\`\`

More text, still part of What it is.

## Canonical links

- kept
`;
    const note = parseNote(raw);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted content for ${s}.`])) };
    const result = renderBody(draft, note.body);
    expect(result.ok).toBe(true);
    const out = rendered(result);
    expect(out).toContain("## TrailingSpaceExample");
    expect(out).toContain("## Canonical links");
    expect(out).toContain("- kept");
  });

  it("renders (does not refuse) a fence containing a unique non-schema heading", () => {
    const raw = `---
type: venture
---

## What it is

Some intro.

\`\`\`text
## Some Random Unique Note
Not one of SECTIONS, not duplicated anywhere else in the note.
\`\`\`

More text, still part of What it is.

## Canonical links

- kept
`;
    const note = parseNote(raw);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted content for ${s}.`])) };
    const result = renderBody(draft, note.body);
    expect(result.ok).toBe(true);
    const out = rendered(result);
    expect(out).toContain("## Some Random Unique Note");
    expect(out).toContain("## Canonical links");
    expect(out).toContain("- kept");
  });

  it("de-duplicates a drafted value that repeats the EXACT schema heading as its own leading line", () => {
    // The reverse-direction cost of always prepending the heading (round 2, item I2's
    // follow-on): a draft that happens to open with "## Target" verbatim would otherwise
    // render it TWICE. Stripping a leading exact-heading line before prepending fixes the
    // common case; the safety net above still refuses anything this can't cleanly resolve
    // (e.g. a section that is ONLY the heading, nothing else).
    const note = parseNote(NOTE_RAW);
    const draft = {
      sections: Object.fromEntries(SECTIONS.map((s) =>
        [s, s === "## Target" ? "## Target\n\nWe serve SMBs." : "Drafted content, unrelated to the heading text."])),
    };
    const out = rendered(renderBody(draft, note.body));
    expect(out).toContain("We serve SMBs.");
    const occurrences = out.split("\n").filter((l) => l === "## Target").length;
    expect(occurrences).toBe(1);
  });

  it("a heading indented 1-3 spaces (CommonMark-legal) is still visible to both scans and survives", () => {
    // Round 4's min-bound guarantee is stated unqualified: "no heading visible to either
    // scan can be absorbed". `line.startsWith("## ")` with no leading-whitespace tolerance
    // is the one gap in that sentence — a 1-3-space-indented heading (still a real heading
    // per CommonMark; 4+ spaces would make it an indented code block instead) is invisible
    // to BOTH the fence-aware and fence-blind scans, so nothing bounds a neighbouring
    // drafted span before it and it can be silently absorbed.
    const raw = `---
type: venture
---

## What it is

Old text.

## Positioning / wedge

Old wedge.

  ## Notes

Some hand-written notes, indented by 2 spaces — still a real CommonMark heading.

## Target

Old target.

## Stage / current state

Old stage.

## Load-bearing strategy calls

- Old call.

## Brand voice

Old voice.

## Canonical links

- kept
`;
    const note = parseNote(raw);
    const draft = { sections: Object.fromEntries(SECTIONS.map((s) => [s, `Drafted content for ${s}.`])) };
    const out = rendered(renderBody(draft, note.body));
    expect(out).toContain("## Notes");
    expect(out).toContain("Some hand-written notes, indented by 2 spaces");
  });
});

describe("diffPreview", () => {
  it("shows changed lines with markers and truncates loudly", () => {
    const p = diffPreview("a\nb\nc\n", "a\nB\nc\n");
    expect(p).toContain("- b");
    expect(p).toContain("+ B");
    const long = diffPreview("", Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"), 10);
    expect(long).toMatch(/truncated/i);
  });
});

describe("decideNote", () => {
  it("proposes when the source fingerprint moved", async () => {
    const sources = [src("README.md", "NEW CONTENT")];
    const d = await decideNote({ ...base, sources, accountedSourcesHash: "old-hash" });
    expect(d.action).toBe("propose");
    expect(d.proposal!.notePath).toBe("_projects/murmur.md");
    expect(d.proposal!.sourcesHash).toBe(sourcesHash(sources));
    expect(d.proposal!.proposedNote).toContain("type: venture");     // frontmatter preserved
    expect(d.proposal!.proposedNote).toContain("New ## What it is.");
    expect(d.proposal!.diffPreview).not.toBe("");
  });

  it("SKIPS when the fingerprint matches what the note already accounted for", async () => {
    const sources = [src("README.md", "SAME")];
    const d = await decideNote({ ...base, sources, accountedSourcesHash: sourcesHash(sources) });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/unchanged/i);
  });

  it("SKIPS while an open proposal already exists for the note — never stack two claims", async () => {
    const d = await decideNote({
      ...base, sources: [src("README.md", "NEW")], accountedSourcesHash: "old",
      openProposalPaths: new Set(["_projects/murmur.md"]),
    });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/already open/i);
  });

  it("SKIPS — and never drafts — when a source FAILED to resolve", async () => {
    const d = await decideNote({ ...base, sources: [src("README.md", "NEW"), failed("docs/X.md")], accountedSourcesHash: "old" });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/could not read/i);
  });

  it("SKIPS — and never drafts — when a source is MISSING", async () => {
    const d = await decideNote({ ...base, sources: [src("README.md", "NEW"), missing("docs/X.md")], accountedSourcesHash: "old" });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/gone/i);
  });

  it("SKIPS when a note declares no sources at all — there is nothing to derive from", async () => {
    const d = await decideNote({ ...base, sources: [], accountedSourcesHash: null });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/no canonical sources/i);
  });

  it("SKIPS when the model returns a section that is empty or whitespace", async () => {
    // An empty section is the fabrication vector: it would silently DELETE prose that a
    // human wrote, dressed as an improvement.
    const d = await decideNote({
      ...base, sources: [src("README.md", "NEW")], accountedSourcesHash: "old",
      model: draftModel({ "## Target": "   " }),
    });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/empty section/i);
  });

  it("SKIPS when the draft is byte-identical to what is already there", async () => {
    const note = parseNote(NOTE_RAW);
    const identical = {
      draft: async () => ({
        sections: Object.fromEntries(SECTIONS.map((s) => {
          // HEADING-FREE, matching the one convention renderBody understands (and the
          // gateway adapter's prompt actually asks for) — the value is everything AFTER
          // the heading line, not the heading itself.
          const headingStart = note.body.indexOf(s);
          const contentStart = headingStart + s.length;
          // Bounded by the next markdown heading OF ANY KIND — not just the next
          // SECTIONS heading. Bounding only by SECTIONS would let the LAST section's
          // slice run past "## Canonical links" (which is never one of SECTIONS) and
          // swallow it whole; renderBody must never drop that heading, so a value built
          // that way could never round-trip byte-identical against a correct
          // implementation — it would always show up as a genuine, if accidental, change.
          const headingStarts = [...note.body.matchAll(/^## .*$/gm)]
            .map((m) => m.index!)
            .filter((i) => i > headingStart);
          const end = headingStarts.length > 0 ? Math.min(...headingStarts) : note.body.length;
          return [s, note.body.slice(contentStart, end).trim()];
        })),
      }),
    };
    const d = await decideNote({ ...base, model: identical, sources: [src("README.md", "NEW")], accountedSourcesHash: "old" });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/identical/i);
  });

  it("SKIPS with the REFUSAL reason when renderBody could not safely rewrite the note — never the identical-draft lie", async () => {
    // Before this fix, decideNote treated ANY renderBody refusal as if the sentinel
    // (currentBody returned unchanged) were a genuinely identical draft, so this case
    // reported "the draft is identical to the note as it stands" on every tick — untrue
    // across five consecutive ticks with CHANGING sources, since the draft was never even
    // compared; it was refused before comparison was meaningful. Task 9 surfaces this
    // reason directly to Bendik, so it has to say what actually happened.
    const note = parseNote(A6_RAW);
    const d = await decideNote({
      notePath: "_projects/murmur.md", note, raw: A6_RAW,
      sources: [src("README.md", "NEW CONTENT")], accountedSourcesHash: "old",
      openProposalPaths: new Set<string>(), model: draftModel(),
    });
    expect(d.action).toBe("skip");
    expect(d.reason).not.toMatch(/identical/i);
    expect(d.reason).toMatch(/could not safely rewrite/i);
    expect(d.reason).toContain("_projects/murmur.md");
  });

  it("baseBodyHash is the hash of the BODY the proposal was drafted from, never the hash it produces", async () => {
    // This is the stale-approve guard: the apply pass compares baseBodyHash against the
    // note's CURRENT body hash at approval time, to refuse applying a proposal drafted
    // against prose that has since moved underneath it. Stamping the hash of the
    // NEW/proposed body instead would make that check a no-op — every approval would
    // "match" whatever it is about to overwrite, by construction.
    const sources = [src("README.md", "NEW CONTENT")];
    const d = await decideNote({ ...base, sources, accountedSourcesHash: "old-hash" });
    expect(d.action).toBe("propose");
    const newBody = parseNote(d.proposal!.proposedNote).body;
    expect(d.proposal!.baseBodyHash).toBe(bodyHash(base.note.body));
    expect(d.proposal!.baseBodyHash).not.toBe(bodyHash(newBody));
  });

  // ── Scrutiny: the frontmatter/body split must not be fooled by a `\n---\n` that shows
  // up in the BODY (a markdown horizontal rule is exactly that string), and must handle
  // legal fence spacing other than the fixture's one-blank-line convention. ─────────────

  it("does not truncate the note when the BODY contains a markdown horizontal rule", async () => {
    const withRule = `---
type: venture
brand: murmur
canonical_sources: ["repo:README.md"]
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

- kept

---

Some text after a horizontal rule, which is exactly the same 5-character sequence
("\\n---\\n") as the frontmatter's own closing fence — and lives in UNTOUCHED, non-drafted
territory, past the last section the model was ever asked about.
`;
    const note = parseNote(withRule);
    const d = await decideNote({
      notePath: "_projects/murmur.md", note, raw: withRule,
      sources: [src("README.md", "NEW CONTENT")], accountedSourcesHash: "old",
      openProposalPaths: new Set<string>(), model: draftModel(),
    });
    expect(d.action).toBe("propose");
    expect(d.proposal!.proposedNote).toContain("type: venture");
    expect(d.proposal!.proposedNote).toContain("brand: murmur");
    // The horizontal rule and the paragraph that follows it are untouched body content —
    // neither drafted nor adjacent to the FRONTMATTER's fence — and must survive the
    // splice intact, not get mistaken for the frontmatter's closing fence nor dropped.
    expect(d.proposal!.proposedNote).toContain("Some text after a horizontal rule");
    expect(d.proposal!.proposedNote).toContain("## Canonical links");
    expect(d.proposal!.proposedNote).toContain("- kept");
  });

  it("does not truncate a note whose fence uses different but legal spacing (no blank line before the body)", async () => {
    const tight = `---
type: venture
brand: murmur
canonical_sources: ["repo:README.md"]
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

- kept
`;
    const note = parseNote(tight);
    const d = await decideNote({
      notePath: "_projects/murmur.md", note, raw: tight,
      sources: [src("README.md", "NEW CONTENT")], accountedSourcesHash: "old",
      openProposalPaths: new Set<string>(), model: draftModel(),
    });
    expect(d.action).toBe("propose");
    expect(d.proposal!.proposedNote).toContain("type: venture");
    expect(d.proposal!.proposedNote).toContain("brand: murmur");
    expect(d.proposal!.proposedNote).toContain("## Canonical links");
    expect(d.proposal!.proposedNote).toContain("- kept");
  });

  it("THROWS rather than splice a proposal when `raw` and `note.body` have diverged", async () => {
    // The frontmatter/body split point is derived from `raw.length - note.body.length`, on
    // the assumption that `note` was actually parsed FROM `raw`. If a caller ever passes a
    // mismatched pair, computing the split point without checking this would silently slice
    // at the wrong offset — a truncated or malformed proposal that only proves out under
    // scrutiny far from the actual mistake.
    const staleNote = parseNote(NOTE_RAW.replace("Old text.", "Something else entirely."));
    await expect(decideNote({
      ...base, note: staleNote, sources: [src("README.md", "NEW")], accountedSourcesHash: "old",
    })).rejects.toThrow(/diverged/i);
  });

  // ── Round-4 property corpus, end to end: under the min-bound fix these three now RENDER
  // successfully (min-bound stops the drafted span before the hidden heading rather than
  // refusing the whole note) — asserting nothing is lost, whichever outcome results. ────

  for (const [label, raw] of [
    ["two unpaired ``` markers in different sections", TWO_UNPAIRED_FENCES_RAW],
    ["two indented blocks each containing a fence-looking line", TWO_INDENTED_FENCE_LINES_RAW],
    ["a mixed ``` + ~~~ pair", MIXED_FENCE_CHARS_RAW],
  ] as const) {
    it(`proposes (does not silently drop content) when the body has ${label}`, async () => {
      const note = parseNote(raw);
      const d = await decideNote({
        notePath: "_projects/murmur.md", note, raw,
        sources: [src("README.md", "NEW CONTENT")], accountedSourcesHash: "old",
        openProposalPaths: new Set<string>(), model: draftModel(),
      });
      expect(d.action).toBe("propose");
      expect(d.proposal!.proposedNote).toContain("## Positioning / wedge");
      expect(d.proposal!.proposedNote).toContain("Real wedge content, hand-written.");
      expect(d.proposal!.proposedNote).toContain("## Canonical links");
      expect(d.proposal!.proposedNote).toContain("- kept");
    });
  }
});
