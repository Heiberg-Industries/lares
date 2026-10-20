import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintRole, assertRoleIsGeneric, toolNamesIn, assertRoleToolsAreDeployed } from "../src/persona/lint.js";

// A deny-list the test writes itself, with made-up words: the repository names no real ones.
let denyDir: string | undefined;
function useDenylist(lines: string[]): void {
  denyDir = mkdtempSync(join(tmpdir(), "denylist-"));
  const file = join(denyDir, "deny.txt");
  writeFileSync(file, lines.join("\n"));
  process.env["LARES_DENYLIST_FILE"] = file;
}
beforeEach(() => { delete process.env["LARES_DENYLIST_FILE"]; });
afterEach(() => {
  delete process.env["LARES_DENYLIST_FILE"];
  if (denyDir) rmSync(denyDir, { recursive: true, force: true });
  denyDir = undefined;
});

describe("lintRole", () => {
  it("passes a generic role", () => {
    expect(lintRole("## Duties\nI run the owner's inbox and calendar and keep the obligations radar honest.")).toEqual([]);
  });
  it("catches a vendor, a place, a language, an address and a URL — each once, with the line", () => {
    const md = ["at the office", "in Notion", "from Norway", "in Norwegian", "mail owner@owner.example", "see https://x.y"].join("\n");
    const f = lintRole(md);
    expect(f.map((x) => x.rule).sort()).toEqual(["address", "language", "place", "url", "vendor"].sort());
    expect(f.find((x) => x.rule === "place")?.line).toBe(3);
  });
  it("applies only the generic rules when no deny-list is configured", () => {
    expect(lintRole("Zorblax runs the Quillmoor desk.")).toEqual([]);
  });
  it("reports every deny-list match, whole-word and case-insensitive, with its line", () => {
    useDenylist(["# made-up words", "zorblax", "quill(?:moor|haven)", ""]);
    const f = lintRole("fine line\nZORBLAX runs the Quillmoor desk.\nQuillhaven too, but not Zorblaxes.");
    expect(f.map((x) => [x.rule, x.match, x.line])).toEqual([
      ["denied", "Quillmoor", 2],
      ["denied", "ZORBLAX", 2],
      ["denied", "Quillhaven", 3],
    ]);
  });
  it("reports a denied word once, not again as an unlisted person", () => {
    useDenylist(["Zorblax Quillmoor"]);
    expect(lintRole("Ask Zorblax Quillmoor first.").map((x) => [x.rule, x.match])).toEqual([["denied", "Zorblax Quillmoor"]]);
  });
  it("fails loudly when the named deny-list file cannot be read", () => {
    process.env["LARES_DENYLIST_FILE"] = join(tmpdir(), "no-such-denylist-file.txt");
    expect(() => lintRole("anything")).toThrow();
  });
  it("catches an UNLISTED two-word proper name structurally", () => {
    expect(lintRole("Ask Ola Nordmann first.").some((x) => x.rule === "person" && x.match === "Ola Nordmann")).toBe(true);
  });
  it("allowlists role vocabulary that looks like a name", () => {
    expect(lintRole("I am the Chief Of Staff.")).toEqual([]);
  });
  it("assertRoleIsGeneric throws listing every finding", () => {
    expect(() => assertRoleIsGeneric("Ask Ola Nordmann in Norway", "chief-of-staff")).toThrow(/chief-of-staff[\s\S]*person[\s\S]*place/);
  });
  it("passes ordinary role prose without an ever-growing allowlist", () => {
    expect(lintRole("The Brain is the owner's private store. Every Monday I run the radar.")).toEqual([]);
  });
  it("catches names beginning or ending in Æ/Ø/Å/æ/ø/å — JS's ASCII-only \\b previously missed them entirely", () => {
    // Same "Ask <name> first" shape as the UNLISTED-name test above, so it also surfaces "Ask
    // Ørnulf" as a second, spurious candidate pair (neither word is a stopword) — asserted with
    // `.some()` for that reason, exactly as the ASCII case above is, not because these two matches
    // are in doubt.
    const f = lintRole("Ask Ørnulf Nordmann first, then Åshild Holm.");
    expect(f.some((x) => x.rule === "person" && x.match === "Ørnulf Nordmann")).toBe(true);
    expect(f.some((x) => x.rule === "person" && x.match === "Åshild Holm")).toBe(true);
  });
  it("returns no findings for an empty role", () => {
    expect(lintRole("")).toEqual([]);
  });
  it("orders multiple findings on the same line by rule order — vendor before place", () => {
    const f = lintRole("in Notion from Norway");
    expect(f.map((x) => x.rule)).toEqual(["vendor", "place"]);
  });

  // One mention is one finding, however many rules could read it.
  it("dedups case-insensitively — one word on one line is one finding", () => {
    const f = lintRole("Notion and notion and NOTION are the same product.");
    expect(f).toHaveLength(1);
    expect(f[0].match).toBe("Notion");
  });
  it("still reports the same word again on a DIFFERENT line", () => {
    expect(lintRole("in Notion\nand Notion again").map((x) => x.line)).toEqual([1, 2]);
  });
});

// `notion_proposals` passed the vendor rule only because WORD_END counts
// `_` as a word character — an accident that would have reversed itself the day someone changed
// that class. Tool names are now an exemption class ON PURPOSE, claimed before any rule and
// matched as whole identifiers, and these cases pin both directions of it.
describe("lintRole — tool names are an exemption class", () => {
  it("exempts a tool name, whole identifier, prefix and all", () => {
    expect(lintRole("I ALWAYS call `notion_proposals` first.")).toEqual([]);
    expect(lintRole("Ground it with `agent-kit__signals_recent` every time.")).toEqual([]);
    expect(lintRole("I read the page with `read_url`, never a browser.")).toEqual([]);
  });
  it("still catches the bare vendor word beside the exempt tool name", () => {
    const f = lintRole("Call `notion_proposals`; Notion is the source.");
    expect(f.map((x) => [x.rule, x.match])).toEqual([["vendor", "Notion"]]);
  });
  it("exempts only the WHOLE identifier — a near-miss is not licensed by the real tool", () => {
    // `read_urls` is not a tool; the exemption must not stretch over it. Nothing in the vocabulary
    // matches inside it either, so what this pins is that the SPAN is not reserved — proved via
    // toolNamesIn, which is the same reservation seen from the other side.
    expect(toolNamesIn("call `read_urls`")).toEqual(["read_urls"]);
    expect(toolNamesIn("call `read_url`")).toEqual(["read_url"]);
  });
});

// templates/README.md says in prose that dropping a grant means
// editing role.md in the same change, and without a check the generated section would stop
// naming the tool while the role text kept instructing the agent to call it. This is the check
// bin/assemble-instructions.ts now runs before it writes anything.
describe("assertRoleToolsAreDeployed", () => {
  const ROLE = "I fetch the link with `read_url`.\nI never invent a `[Name](mapsUrl)`.\nI file it under `inspiration/`.\nEvery line carries `id:...`.";

  it("reads tool references out of backticks and leaves every other backticked span alone", () => {
    expect(toolNamesIn(ROLE)).toEqual(["read_url"]);
    expect(toolNamesIn("it arrives as `[Attachment: …]`, marked as approved")).toEqual([]);
  });

  it("treats a bare lowercase word as a tool only when a capability doc declares it", () => {
    expect(toolNamesIn("what I was told, from `remember`")).toEqual(["remember"]);
    expect(toolNamesIn("I report it as `done` and stop")).toEqual([]);
  });

  it("passes when every named tool ships here", () => {
    expect(() => assertRoleToolsAreDeployed(ROLE, ["read_url", "remind_set"], "chief-of-staff/role.md")).not.toThrow();
  });

  it("FAILS naming the tool and the file when the grant behind it was dropped", () => {
    expect(() => assertRoleToolsAreDeployed(ROLE, ["remind_set"], "chief-of-staff/role.md")).toThrow(
      /chief-of-staff\/role\.md: this role instructs the agent to call `read_url`, which this agent does not ship/,
    );
  });

  it("names every missing tool at once, not just the first", () => {
    const role = "call `read_url`, then `remind_set`, then `person_lookup`";
    expect(() => assertRoleToolsAreDeployed(role, ["person_lookup"], "chief-of-staff/role.md")).toThrow(/`read_url`, `remind_set`/);
  });
});
