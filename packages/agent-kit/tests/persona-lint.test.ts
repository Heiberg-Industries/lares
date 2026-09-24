import { describe, it, expect } from "vitest";
import { lintRole, assertRoleIsGeneric, toolNamesIn, assertRoleToolsAreDeployed } from "../src/persona/lint.js";

describe("lintRole", () => {
  it("passes a generic role", () => {
    expect(lintRole("## Duties\nI run the owner's inbox and calendar and keep the obligations radar honest.")).toEqual([]);
  });
  it("catches a person, a company, a vendor, a place, a language, an address and a URL — each once, with the line", () => {
    const md = ["I work for Bendik.", "at Heiberg Industries", "in Notion", "from Oslo", "in Norwegian", "mail owner@owner.example", "see https://x.y"].join("\n");
    const f = lintRole(md);
    expect(f.map((x) => x.rule).sort()).toEqual(["address", "company", "language", "person", "place", "url", "vendor"].sort());
    expect(f.find((x) => x.rule === "place")?.line).toBe(4);
  });
  it("catches an UNLISTED two-word proper name structurally", () => {
    expect(lintRole("Ask Ola Nordmann first.").some((x) => x.rule === "person" && x.match === "Ola Nordmann")).toBe(true);
  });
  it("allowlists role vocabulary that looks like a name", () => {
    expect(lintRole("I am the Chief Of Staff.")).toEqual([]);
  });
  it("assertRoleIsGeneric throws listing every finding", () => {
    expect(() => assertRoleIsGeneric("Bendik in Oslo", "chief-of-staff")).toThrow(/chief-of-staff[\s\S]*person[\s\S]*place/);
  });
  it("passes ordinary role prose without an ever-growing allowlist", () => {
    expect(lintRole("The Brain is the owner's private store. Every Monday I run the radar.")).toEqual([]);
  });
  it("catches names beginning or ending in Æ/Ø/Å/æ/ø/å — JS's ASCII-only \\b previously missed them entirely", () => {
    // Same "Ask <name> first" shape as the UNLISTED-name test above, so it also surfaces "Ask
    // Øystein" as a second, spurious candidate pair (neither word is a stopword) — asserted with
    // `.some()` for that reason, exactly as the ASCII case above is, not because these two matches
    // are in doubt.
    const f = lintRole("Ask Øystein Berg first, then Åse Solberg.");
    expect(f.some((x) => x.rule === "person" && x.match === "Øystein Berg")).toBe(true);
    expect(f.some((x) => x.rule === "person" && x.match === "Åse Solberg")).toBe(true);
  });
  it("returns no findings for an empty role", () => {
    expect(lintRole("")).toEqual([]);
  });
  it("orders multiple findings on the same line by rule order — vendor before place", () => {
    const f = lintRole("in Notion from Oslo");
    expect(f.map((x) => x.rule)).toEqual(["vendor", "place"]);
  });

  // ORB-210 item 5, both halves of one word. "Orakel" is in COMPANY_NAMES and is also an
  // adapter's vendor, and every pattern is case-insensitive, so one mention used to surface up to
  // four findings: company + vendor, each again for a second spelling.
  it("reports a word that is BOTH a company and a vendor exactly once", () => {
    expect(lintRole("We look it up in Orakel.").map((x) => [x.rule, x.match])).toEqual([["company", "Orakel"]]);
  });
  it("dedups case-insensitively — one word on one line is one finding", () => {
    const f = lintRole("Notion and notion and NOTION are the same product.");
    expect(f).toHaveLength(1);
    expect(f[0].match).toBe("Notion");
  });
  it("still reports the same word again on a DIFFERENT line", () => {
    expect(lintRole("in Notion\nand Notion again").map((x) => x.line)).toEqual([1, 2]);
  });
});

// ORB-210 item 3, first half. `strava_routes` passed the vendor rule only because WORD_END counts
// `_` as a word character — an accident that would have reversed itself the day someone changed
// that class. Tool names are now an exemption class ON PURPOSE, claimed before any rule and
// matched as whole identifiers, and these cases pin both directions of it.
describe("lintRole — tool names are an exemption class", () => {
  it("exempts a tool name, whole identifier, prefix and all", () => {
    expect(lintRole("I ALWAYS call `strava_routes` first.")).toEqual([]);
    expect(lintRole("Ground it with `agent-kit__orakel_search` every time.")).toEqual([]);
    expect(lintRole("I read the page with `read_url`, never a browser.")).toEqual([]);
  });
  it("still catches the bare vendor word beside the exempt tool name", () => {
    const f = lintRole("Call `strava_routes`; Strava is the source.");
    expect(f.map((x) => [x.rule, x.match])).toEqual([["vendor", "Strava"]]);
  });
  it("exempts only the WHOLE identifier — a near-miss is not licensed by the real tool", () => {
    // `read_urls` is not a tool; the exemption must not stretch over it. Nothing in the vocabulary
    // matches inside it either, so what this pins is that the SPAN is not reserved — proved via
    // toolNamesIn, which is the same reservation seen from the other side.
    expect(toolNamesIn("call `read_urls`")).toEqual(["read_urls"]);
    expect(toolNamesIn("call `read_url`")).toEqual(["read_url"]);
  });
});

// ORB-210 item 3, second half. templates/README.md said in prose that dropping a grant means
// editing role.md in the same change, and nothing enforced it: the generated section would stop
// naming the tool while the role text kept instructing the agent to call it. This is the check
// bin/assemble-instructions.ts now runs before it writes anything.
describe("assertRoleToolsAreDeployed", () => {
  const ROLE = "I fetch the link with `place_link`.\nI never invent a `[Name](mapsUrl)`.\nI file it under `inspiration/`.\nEvery line carries `id:...`.";

  it("reads tool references out of backticks and leaves every other backticked span alone", () => {
    expect(toolNamesIn(ROLE)).toEqual(["place_link"]);
    expect(toolNamesIn("it arrives as `[Attachment: …]`, marked as approved")).toEqual([]);
  });

  it("treats a bare lowercase word as a tool only when a capability doc declares it", () => {
    expect(toolNamesIn("the emergency numbers from `info`")).toEqual(["info"]);
    expect(toolNamesIn("I report it as `done` and stop")).toEqual([]);
  });

  it("passes when every named tool ships here", () => {
    expect(() => assertRoleToolsAreDeployed(ROLE, ["place_link", "nearby_places"], "travel/role.md")).not.toThrow();
  });

  it("FAILS naming the tool and the file when the grant behind it was dropped", () => {
    expect(() => assertRoleToolsAreDeployed(ROLE, ["nearby_places"], "travel/role.md")).toThrow(
      /travel\/role\.md: this role instructs the agent to call `place_link`, which this agent does not ship/,
    );
  });

  it("names every missing tool at once, not just the first", () => {
    const role = "call `place_link`, then `strava_routes`, then `shopping_add`";
    expect(() => assertRoleToolsAreDeployed(role, ["shopping_add"], "travel/role.md")).toThrow(/`place_link`, `strava_routes`/);
  });
});
