import { describe, it, expect } from "vitest";
import { parseManifest, assertSkillsWithinGrants, skillFor, scopeAtLeast, KNOWN_SKILLS, KNOWN_SKILL_TOOLS, skillToolsFor, resolveSkillTool } from "../src/manifest.js";
import { isDisabledToolSentinel } from "eve/tools";

const base = {
  name: "t", model: "m", persona: "p.md",
  grants: [
    { capability: "twenty", scope: "write-with-confirm" },
    { capability: "orakel", scope: "read" },
  ],
};

describe("skills declaration", () => {
  it("parses a skills array beside grants, defaulting to []", () => {
    expect(parseManifest(base).skills).toEqual([]);
    const m = parseManifest({ ...base, skills: [{ name: "commercial", requires: [{ capability: "twenty", scope: "read" }, { capability: "orakel", scope: "read" }] }] });
    expect(skillFor(m, "commercial")?.requires).toHaveLength(2);
  });

  it("is strict: an unknown key inside a skill fails parsing", () => {
    expect(() => parseManifest({ ...base, skills: [{ name: "commercial", require: [] }] })).toThrow(/skills/);
  });

  it("a skill whose requirement exceeds the grants FAILS (never-widen)", () => {
    const m = parseManifest({ ...base, skills: [{ name: "commercial", requires: [{ capability: "orakel", scope: "write" }] }] });
    expect(() => assertSkillsWithinGrants(m)).toThrow(/commercial.*orakel.*write.*read/);
  });

  it("a skill requiring an UNGRANTED capability fails, naming it", () => {
    const m = parseManifest({ ...base, skills: [{ name: "commercial", requires: [{ capability: "gmail", scope: "read" }] }] });
    expect(() => assertSkillsWithinGrants(m)).toThrow(/commercial.*gmail.*not granted/);
  });

  it("an unknown skill name fails (typo protection, same reason KNOWN_CAPABILITIES exists)", () => {
    const m = parseManifest({ ...base, skills: [{ name: "comercial", requires: [] }] });
    expect(() => assertSkillsWithinGrants(m)).toThrow(/unknown skill "comercial"/);
    expect(KNOWN_SKILLS).toContain("commercial");
  });

  it("scopeAtLeast: write satisfies write-with-confirm; read does not satisfy write-with-confirm; none satisfies nothing", () => {
    expect(scopeAtLeast("write", "write-with-confirm")).toBe(true);
    expect(scopeAtLeast("write-with-confirm", "write-with-confirm")).toBe(true);
    expect(scopeAtLeast("read", "write-with-confirm")).toBe(false);
    expect(scopeAtLeast("none", "read")).toBe(false);
    expect(scopeAtLeast("write", "read")).toBe(true);
  });

  it("assertSkillsWithinGrants passes on the model case: commercial over twenty:read + orakel:read", () => {
    const m = parseManifest({ ...base, skills: [{ name: "commercial", requires: [{ capability: "twenty", scope: "read" }, { capability: "orakel", scope: "read" }] }] });
    expect(() => assertSkillsWithinGrants(m)).not.toThrow();
  });

  // ORB-210 item 5. `requires` defaults to [], and the never-widen check is a loop over it — so
  // an empty list asks for nothing and passes whatever the grants are. That is CORRECT (a skill
  // can never widen access, and one requiring nothing widens nothing), but it was the untested
  // corner of the check that fails a build, and "requires nothing" reads close enough to
  // "requires everything" to be worth pinning. What it must NOT do is buy the skill any access:
  // `resolveSkillTool` still gates on the declared requirements, so an empty list is not a way
  // past a missing grant either.
  it("a skill with an EMPTY requires passes whatever the grants are — it asks for nothing", () => {
    const omitted = parseManifest({ ...base, skills: [{ name: "commercial" }] });
    expect(skillFor(omitted, "commercial")?.requires).toEqual([]);
    expect(() => assertSkillsWithinGrants(omitted)).not.toThrow();

    const explicit = parseManifest({ ...base, grants: [], skills: [{ name: "commercial", requires: [] }] });
    expect(() => assertSkillsWithinGrants(explicit)).not.toThrow();
    // The unknown-name check is NOT skipped by an empty requires — a typo still fails.
    expect(() => assertSkillsWithinGrants(parseManifest({ ...base, skills: [{ name: "comercial" }] }))).toThrow(/unknown skill/);
  });
});

// ORB-145 whole-branch review, Critical #1. The type says every KNOWN_SKILLS name has an entry
// (`Record<KnownSkill, …>` will not compile without one); this says none of those entries is
// EMPTY, which the type cannot. An empty list would put a skill back where `commercial` was —
// declared, compiled, callable, and named nowhere in the persona that claims to list every tool.
describe("KNOWN_SKILL_TOOLS", () => {
  it("gives every known skill at least one tool", () => {
    for (const skill of KNOWN_SKILLS) {
      expect(KNOWN_SKILL_TOOLS[skill], `skill "${skill}" has no entry in KNOWN_SKILL_TOOLS`).toBeDefined();
      expect(KNOWN_SKILL_TOOLS[skill].length, `skill "${skill}" is known but backed by no tool`).toBeGreaterThan(0);
    }
  });
  it("skillToolsFor answers for a known name and returns [] for anything else", () => {
    expect(skillToolsFor("commercial")).toEqual(["commercial_who_to_contact"]);
    expect(skillToolsFor("comercial")).toEqual([]);
    // Not a prototype walk: a Record lookup must not answer for "toString" or "constructor".
    expect(skillToolsFor("toString")).toEqual([]);
  });
});

describe("resolveSkillTool", () => {
  const tool = { description: "who to contact" };
  const declared = { ...base, skills: [{ name: "commercial", requires: [{ capability: "twenty", scope: "read" }, { capability: "orakel", scope: "read" }] }] };

  it("returns the tool when the skill is declared and within grants", () => {
    expect(resolveSkillTool(declared, "commercial", tool)).toBe(tool);
  });
  it("disables the tool when the skill is not declared", () => {
    const r = resolveSkillTool(base, "commercial", tool);
    expect(r).not.toBe(tool);
    expect(isDisabledToolSentinel(r)).toBe(true);
  });
  it("disables the tool when ANY required capability is at autonomy never", () => {
    const r = resolveSkillTool({ ...declared, autonomy: { orakel: "never" } }, "commercial", tool);
    expect(isDisabledToolSentinel(r)).toBe(true);
  });
  it("THROWS (build fails) when the declaration widens access", () => {
    const widened = { ...base, skills: [{ name: "commercial", requires: [{ capability: "orakel", scope: "write" }] }] };
    expect(() => resolveSkillTool(widened, "commercial", tool)).toThrow(/never widen/);
  });
});

// ORB-189 Task 2: the fleet's SECOND code skill, and the first one over an adapter capability.
// `commercial` composes two capabilities the agent already holds; `market-edge` composes one —
// which is still a skill and not a capability, because what it adds is POLICY (a required
// caveat, a computed edge, no stake advice) over a feed the `markets` grant already gives.
describe("market-edge", () => {
  const withMarkets = { ...base, grants: [...base.grants, { capability: "markets", scope: "read" }] };
  const declared = { name: "market-edge", requires: [{ capability: "markets", scope: "read" }] };

  it("passes assertSkillsWithinGrants over markets:read", () => {
    const m = parseManifest({ ...withMarkets, skills: [declared] });
    expect(() => assertSkillsWithinGrants(m)).not.toThrow();
  });

  it("FAILS when markets is not granted — the never-widen property, named", () => {
    const m = parseManifest({ ...base, skills: [declared] });
    expect(() => assertSkillsWithinGrants(m)).toThrow(/market-edge.*markets.*not granted/);
  });

  it("is backed by the one tool the capability doc names", () => {
    expect(KNOWN_SKILLS).toContain("market-edge");
    expect(skillToolsFor("market-edge")).toEqual(["agent-kit__market_edge"]);
  });

  it("resolves to the tool when declared, and to a disable sentinel when not", () => {
    const tool = { description: "market edge" };
    expect(resolveSkillTool({ ...withMarkets, skills: [declared] }, "market-edge", tool)).toBe(tool);
    expect(isDisabledToolSentinel(resolveSkillTool(withMarkets, "market-edge", tool))).toBe(true);
  });
});

// ADR-0017 (the Vault, one name), W5C-s1. A skill can require a specific AREA of the `vault`
// capability, and the never-widen check compares area sets exactly as it compares scopes —
// requiring an area the grant does not list is a widening, whether or not the capability itself
// is granted.
describe("skills over an area-scoped capability (ADR-0017)", () => {
  const withVault = { ...base, grants: [...base.grants, { capability: "vault", scope: "read", areas: ["private"] }] };

  it("passes when the skill requires an area the grant lists", () => {
    const m = parseManifest({
      ...withVault,
      skills: [{ name: "commercial", requires: [{ capability: "vault", scope: "read", areas: ["private"] }] }],
    });
    expect(() => assertSkillsWithinGrants(m)).not.toThrow();
  });

  it("FAILS when the skill requires an area the grant does not list — never-widen over areas", () => {
    const m = parseManifest({
      ...withVault,
      skills: [{ name: "commercial", requires: [{ capability: "vault", scope: "read", areas: ["shared"] }] }],
    });
    expect(() => assertSkillsWithinGrants(m)).toThrow(/commercial.*vault.*shared/);
  });

  it("a skill silent about areas widens nothing, exactly like an empty requires", () => {
    const m = parseManifest({
      ...withVault,
      skills: [{ name: "commercial", requires: [{ capability: "vault", scope: "read" }] }],
    });
    expect(() => assertSkillsWithinGrants(m)).not.toThrow();
  });
});
