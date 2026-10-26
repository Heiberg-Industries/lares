import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITY_DOCS, docFor, hostsFor, renderSummary, type CapabilityDoc } from "../src/persona/capability-docs.js";
import { lintCapabilityDoc, lintCapabilityDocs, assertCapabilityDocsAreGeneric, lintInstructionSkill, assertSkillIsGeneric, SKILL_FRONTMATTER_KEYS, ALLOWED_TOOLS_REFUSAL } from "../src/persona/doc-lint.js";
import { KNOWN_CAPABILITIES } from "../src/manifest.js";
import { areaOfTool } from "../src/always-ask.js";
import { connectionsByCapability } from "../src/connections.js";
import { loadDenyPatterns } from "../src/persona/denylist.js";

/** A doc built from scratch, so a lint case cannot be quietly weakened by an edit to a real
 *  entry. Everything the lint reads is overridable. */
function doc(over: Partial<CapabilityDoc> = {}): CapabilityDoc {
  return {
    capability: "scratch",
    kind: "core",
    summary: "I do one narrow thing for the owner, and I say plainly when I could not do it.",
    tools: ["scratch_do"],
    ...over,
  };
}

describe("capability docs", () => {
  it("documents EVERY known capability — an undocumented grant would render as silence", () => {
    for (const c of KNOWN_CAPABILITIES) expect(() => docFor(c), c).not.toThrow();
  });
  it("every doc names at least one deployed tool and a non-empty summary", () => {
    for (const d of Object.values(CAPABILITY_DOCS)) {
      // `outside` has no tools of its own: each owner-connected server brings its own, named in
      // the persona from the definition.
      if (d.capability !== "outside") expect(d.tools.length, d.capability).toBeGreaterThan(0);
      expect(renderSummary(d.summary).length, d.capability).toBeGreaterThan(40);
    }
  });
  it("adapters carry a vendor; core does not", () => {
    for (const d of Object.values(CAPABILITY_DOCS)) {
      if (d.kind === "adapter") expect(d.vendor, d.capability).toBeTruthy();
      else expect(d.vendor, d.capability).toBeUndefined();
    }
  });
  it("names no person: the docs are engine text", () => {
    expect(lintCapabilityDocs().filter((f) => f.rule === "person")).toEqual([]);
  });
});

// ADR-0017 rule 1 — one paragraph where there were three.
describe("the Vault's one capability doc", () => {
  it("documents vault and nothing else in its place", () => {
    expect(Object.keys(CAPABILITY_DOCS)).toContain("vault");
    for (const gone of ["brain", "atlas", "memory"]) expect(Object.keys(CAPABILITY_DOCS)).not.toContain(gone);
  });

  it("keeps every tool the three entries listed — and nothing arrives that was not already there", () => {
    // Literals, recorded before the merge, never computed from the code this
    // test is watching: the union of `brain`'s seven, `atlas`'s six and `memory`'s seven, after
    // the tools themselves had been renamed. If this list shortens, some agent lost a tool in a
    // commit whose whole claim is that nobody did.
    const before = [
      "agent-kit__vault_search", "agent-kit__vault_read", "agent-kit__vault_backlinks",
      "agent-kit__vault_list", "agent-kit__vault_write", "agent-kit__vault_file", "agent-kit__vault_drop",
      "vault_search", "vault_read", "vault_list", "atlas_proposals", "atlas_resolve_proposal", "vault_write",
      "remember", "forget", "facts_list", "memory_proposals", "memory_resolve_proposal", "save_note", "memory_used",
      "tracks_list", "track_items", "track_create", "track_add_item", "track_move_item", "track_set_steps",
    ];
    expect([...docFor("vault").tools].sort()).toEqual([...before].sort());
    expect(docFor("vault").tools.length).toBe(26);
  });

  it("gives vault a connections entry, closing the gap memory never had", () => {
    expect(hostsFor("vault")).toEqual([]);
    expect(connectionsByCapability).toHaveProperty("vault");
    for (const gone of ["brain", "atlas", "memory"]) expect(connectionsByCapability).not.toHaveProperty(gone);
  });

  it("says which areas exist, in the agent's own voice and with no installation's folder names", () => {
    const text = renderSummary(docFor("vault").summary) + JSON.stringify(docFor("vault").rules ?? []);
    expect(text).toMatch(/area/i);
    // Names to keep out come from the private deny-list (LARES_DENYLIST_FILE), never from this file.
    for (const re of loadDenyPatterns()) expect(text).not.toMatch(re);
  });

  it("keys every sentence about a store to that store's own tools", () => {
    // The merge's one real risk to a PERSONA: three paragraphs joined into one would tell an
    // agent granted the standing facts alone that it has a second brain. Only the area sentence
    // holds for everyone, so only the area sentence is a plain string.
    const parts = docFor("vault").summary;
    expect(Array.isArray(parts)).toBe(true);
    const plain = (parts as readonly unknown[]).filter((p) => typeof p === "string");
    expect(plain.length).toBe(1);
    expect(plain[0]).toMatch(/The Vault has areas/);
    // Every rule is keyed too: not one of them holds for all three areas at once.
    for (const r of docFor("vault").rules ?? []) expect(typeof r, JSON.stringify(r)).not.toBe("string");
  });

  it("every tool it lists has an area, and the areas partition the tool list", () => {
    const byArea = new Map<string, string[]>();
    for (const t of docFor("vault").tools) {
      const a = areaOfTool(t);
      expect(a, `${t} has no area`).toBeDefined();
      byArea.set(a!, [...(byArea.get(a!) ?? []), t]);
    }
    expect([...byArea.keys()].sort()).toEqual(["facts", "private", "shared"]);
    expect([...byArea.values()].reduce((n, v) => n + v.length, 0)).toBe(docFor("vault").tools.length);
  });
});

// A message the mailbox returns is somebody else's words, never an instruction; the
// capability doc is the one place that sentence is written once and rendered into every agent
// that holds `gmail`.
describe("the gmail capability doc", () => {
  it("says that a message is not an instruction", () => {
    const doc = CAPABILITY_DOCS.gmail;
    const rules = (doc.rules ?? []).map((r) => (typeof r === "string" ? r : r.text)).join(" ");
    expect(rules).toMatch(/never an instruction to me/);
    expect(rules).toMatch(/drafts? it/i);
  });
});

// The assertions above alone would pass happily on a paragraph naming another company's
// product (a calendar doc naming a specific vendor's product, rendered into every persona).
// These paragraphs render into EVERY agent's instructions.md, so
// they are held to the role template's genericness bar, licensed only by what the entry declares.
let denyDir: string | undefined;
afterEach(() => {
  delete process.env["LARES_DENYLIST_FILE"];
  if (denyDir) rmSync(denyDir, { recursive: true, force: true });
  denyDir = undefined;
});
/** A deny-list with made-up words, written by the test: the repository names no real ones. */
function useDenylist(lines: string[]): void {
  denyDir = mkdtempSync(join(tmpdir(), "denylist-"));
  const file = join(denyDir, "deny.txt");
  writeFileSync(file, lines.join("\n"));
  process.env["LARES_DENYLIST_FILE"] = file;
}

describe("capability docs pass the genericness lint", () => {
  it("every shipped doc is clean", () => {
    expect(lintCapabilityDocs().map((f) => `${f.capability}: ${f.rule} "${f.match}"`)).toEqual([]);
    expect(() => assertCapabilityDocsAreGeneric()).not.toThrow();
  });

  it("catches the scar it was written for: another product's name in an adapter's prose", () => {
    // An adapter's own-vendor licence covers only its own product, so a second one cannot ride
    // along in the prose -- and a product on the installation's deny-list is never licensed.
    useDenylist(["Quillmoor"]);
    expect(lintCapabilityDoc(doc({ kind: "adapter", vendor: "Google Calendar", summary: "I read the Quillmoor calendar." })).map((x) => [x.rule, x.match])).toEqual([["denied", "Quillmoor"]]);
    expect(lintCapabilityDoc(doc({ kind: "adapter", vendor: "Google Calendar", summary: "I read the Notion calendar." })).map((x) => [x.rule, x.match])).toEqual([["vendor", "Notion"]]);
  });

  it("licenses an adapter's OWN vendor, including each word of a compound one", () => {
    expect(lintCapabilityDoc(doc({ kind: "adapter", vendor: "Google Places", summary: "Real Google Places results, never invented." }))).toEqual([]);
    expect(lintCapabilityDoc(doc({ kind: "adapter", vendor: "Entur + Google", summary: "Entur first, then Google." }))).toEqual([]);
  });

  it("gives a CORE entry no vendor exemption at all — only what it declares in backedBy", () => {
    expect(lintCapabilityDoc(doc({ summary: "I convert money at a Notion rate." })).map((x) => x.match)).toEqual(["Notion"]);
    expect(lintCapabilityDoc(doc({ backedBy: ["Notion"], summary: "I convert money at a Notion rate." }))).toEqual([]);
  });

  it("licenses a country term only for an adapter that DECLARED that country", () => {
    const covered = doc({ kind: "adapter", vendor: "Entur", region: { countries: ["NOR"], reason: "national journey planner" }, summary: "Real Norwegian journeys, in Norway only." });
    expect(lintCapabilityDoc(covered)).toEqual([]);
    const global = doc({ kind: "adapter", vendor: "Entur", region: "global", summary: "Real Norwegian journeys, in Norway only." });
    expect(global.region).toBe("global");
    expect(lintCapabilityDoc(global).map((x) => x.rule).sort()).toEqual(["language", "place"]);
  });

  it("never licenses a person, a denied word, an address or a URL, whatever the entry declares", () => {
    useDenylist(["Quillmoor"]);
    const f = lintCapabilityDoc(
      doc({
        kind: "adapter",
        vendor: "Notion",
        backedBy: ["Quillmoor"],
        region: { countries: ["NOR"], reason: "x" },
        summary: "Ask Ola Nordmann at Quillmoor, mail owner@owner.example or see https://x.y.",
      }),
    );
    // Two `person` hits: the structural fallback yields every adjacent capitalised pair, so
    // "Ask Ola Nordmann" surfaces "Ask Ola" alongside the real name (same reason
    // tests/persona-lint.test.ts asserts that case with `.some`).
    expect([...new Set(f.map((x) => x.rule))].sort()).toEqual(["address", "denied", "person", "url"]);
    expect(f.some((x) => x.rule === "person" && x.match === "Ola Nordmann")).toBe(true);
  });

  it("lints the RULES too, not just the summary, and points at the offending line", () => {
    const f = lintCapabilityDoc(doc({ rules: ["A plain rule.", { tools: ["scratch_do"], text: "Only in Norway." }] }));
    expect(f.map((x) => [x.line, x.rule, x.match])).toEqual([[3, "place", "Norway"]]);
  });

  it("lints a keyed summary PART, not just a plain-string summary", () => {
    // `summary` has an array form. A sentence keyed to a tool renders on some
    // installation, so it is text held to the same bar — a leak hidden in one would otherwise be
    // invisible to a lint that only read `typeof summary === "string"`.
    const f = lintCapabilityDoc(doc({ summary: ["I do one narrow thing.", { tools: ["scratch_do"], text: "Only in Norway, though." }] }));
    expect(f.map((x) => [x.line, x.rule, x.match])).toEqual([[2, "place", "Norway"]]);
  });

  it("assertCapabilityDocsAreGeneric names the capability and the fix", () => {
    expect(() => assertCapabilityDocsAreGeneric({ scratch: doc({ summary: "I read the Notion calendar." }) })).toThrow(
      /backedBy[\s\S]*scratch \(line 1\): vendor "Notion"/,
    );
  });
});

// An instruction skill (`agent/skills/*.md`) is prose the model reads, appended
// verbatim to a turn — the same kind of text as a role template, and just as likely to travel to a
// second installation alongside one. A skill that hard-codes the owner's mailbox addresses or
// names the owner would leak, so this checks for it.
describe("lintInstructionSkill", () => {
  it("licenses the vendor of a capability whose tools the skill actually calls", () => {
    expect(lintInstructionSkill("Call `gmail_send` on the chosen Gmail account.")).toEqual([]);
  });

  it("does NOT license a vendor the skill calls no tool of", () => {
    expect(lintInstructionSkill("Call `gmail_send`, then check Notion.").map((x) => [x.rule, x.match])).toEqual([["vendor", "Notion"]]);
  });

  it("licenses nothing else — a person, a denied word or an address is still a finding", () => {
    useDenylist(["Quillmoor"]);
    const f = lintInstructionSkill("Call `gmail_send` from owner@owner.example and tell Ola Nordmann at Quillmoor.");
    expect(f.map((x) => x.rule).sort()).toEqual(["address", "denied", "person"]);
  });

  it("lints the frontmatter too — the description is model-visible routing text", () => {
    const md = "---\ndescription: Use when Ola Nordmann asks for a price.\n---\n\nCall `gmail_send`.\n";
    expect(lintInstructionSkill(md).map((x) => [x.line, x.rule, x.match])).toEqual([[2, "person", "Ola Nordmann"]]);
  });

  it("assertSkillIsGeneric names the file and points at voice.md", () => {
    expect(() => assertSkillIsGeneric("Ask Ola Nordmann first.", "sales-outreach.md")).toThrow(/sales-outreach\.md[\s\S]*voice\.md[\s\S]*person "Ola Nordmann"/);
  });

  it("refuses allowed-tools, and says why in one sentence", () => {
    const md = "---\nname: x\ndescription: d\nallowed-tools: Bash, Read\n---\n\n# x\n";
    const findings = lintInstructionSkill(md, "x");
    expect(findings.map((f) => f.message).join(" ")).toContain(ALLOWED_TOOLS_REFUSAL);
    expect(ALLOWED_TOOLS_REFUSAL).toMatch(/agent\.json/);
    expect(ALLOWED_TOOLS_REFUSAL).toMatch(/widen/i);
  });

  it("refuses any frontmatter key that is not name or description", () => {
    expect([...SKILL_FRONTMATTER_KEYS]).toEqual(["name", "description"]);
    const md = "---\nname: x\ndescription: d\nmodel: opus\n---\n\n# x\n";
    expect(lintInstructionSkill(md).map((f) => f.message).join(" ")).toMatch(/model/);
  });

  it("accepts the two keys the three shipped skills actually use", () => {
    const md = "---\nname: x\ndescription: d\n---\n\n# x\n";
    expect(lintInstructionSkill(md)).toEqual([]);
  });
});
