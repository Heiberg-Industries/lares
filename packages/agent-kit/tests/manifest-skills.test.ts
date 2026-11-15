import { describe, it, expect } from "vitest";
import { disableTool } from "eve/tools";
import { parseManifest, assertSkillsWithinGrants, skillFor, scopeAtLeast, KNOWN_SKILLS, KNOWN_SKILL_TOOLS, skillToolsFor, resolveSkillTool, grantsCover, instructionSkillsAllowedBy, instructionSkillOffered, INSTRUCTION_SKILLS, INSTRUCTION_SKILL_NAMES, INSTRUCTION_SKILLS_MEMO_KEY, KNOWN_CAPABILITIES, SCOPES } from "../src/manifest.js";

// eve 1.0 no longer exports a recogniser for `disableTool()`'s value, which is an opaque
// `{ [Symbol.for("eve.disabled-tool")]: true }`. One local line, on purpose not a shared helper.
const isDisabledToolSentinel = (v: unknown): boolean => typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[Symbol.for("eve.disabled-tool")] === true;

const base = {
  name: "t", model: "m", persona: "p.md",
  grants: [
    { capability: "twenty", scope: "write-with-confirm" },
    { capability: "read_url", scope: "read" },
  ],
};

describe("the local disabled-tool recogniser", () => {
  // Every "disables the tool" case below leans on it, so it is held against the framework's own
  // value: if eve changes what `disableTool()` returns, this fails rather than those passing blind.
  it("recognises eve's disableTool() value and nothing else", () => {
    expect(isDisabledToolSentinel(disableTool())).toBe(true);
    expect(isDisabledToolSentinel({ description: "a tool" })).toBe(false);
    expect(isDisabledToolSentinel(null)).toBe(false);
  });
});

describe("skills declaration", () => {
  it("parses a skills array beside grants, defaulting to []", () => {
    expect(parseManifest(base).skills).toEqual([]);
    const m = parseManifest({ ...base, skills: [{ name: "commercial", requires: [{ capability: "twenty", scope: "read" }, { capability: "read_url", scope: "read" }] }] });
    expect(skillFor(m, "commercial")?.requires).toHaveLength(2);
  });

  it("is strict: an unknown key inside a skill fails parsing", () => {
    expect(() => parseManifest({ ...base, skills: [{ name: "commercial", require: [] }] })).toThrow(/skills/);
  });

  it("a skill whose requirement exceeds the grants FAILS (never-widen)", () => {
    const m = parseManifest({ ...base, skills: [{ name: "commercial", requires: [{ capability: "read_url", scope: "write" }] }] });
    expect(() => assertSkillsWithinGrants(m)).toThrow(/commercial.*read_url.*write.*read/);
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

  it("assertSkillsWithinGrants passes on the model case: commercial over twenty:read + read_url:read", () => {
    const m = parseManifest({ ...base, skills: [{ name: "commercial", requires: [{ capability: "twenty", scope: "read" }, { capability: "read_url", scope: "read" }] }] });
    expect(() => assertSkillsWithinGrants(m)).not.toThrow();
  });

  // `requires` defaults to [], and the never-widen check is a loop over it — so
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

// whole-branch review, Critical #1. The type says every KNOWN_SKILLS name has an entry
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
  const declared = { ...base, skills: [{ name: "commercial", requires: [{ capability: "twenty", scope: "read" }, { capability: "read_url", scope: "read" }] }] };

  it("returns the tool when the skill is declared and within grants", () => {
    expect(resolveSkillTool(declared, "commercial", tool)).toBe(tool);
  });
  it("disables the tool when the skill is not declared", () => {
    const r = resolveSkillTool(base, "commercial", tool);
    expect(r).not.toBe(tool);
    expect(isDisabledToolSentinel(r)).toBe(true);
  });
  it("disables the tool when ANY required capability is at autonomy never", () => {
    const r = resolveSkillTool({ ...declared, autonomy: { read_url: "never" } }, "commercial", tool);
    expect(isDisabledToolSentinel(r)).toBe(true);
  });
  it("THROWS (build fails) when the declaration widens access", () => {
    const widened = { ...base, skills: [{ name: "commercial", requires: [{ capability: "read_url", scope: "write" }] }] };
    expect(() => resolveSkillTool(widened, "commercial", tool)).toThrow(/never widen/);
  });
});

// The `signals` skill composes one adapter-free capability: a skill and not a capability, because
// what it adds is POLICY over a feed the `signals` grant already gives.
describe("signals", () => {
  const withSignals = { ...base, grants: [...base.grants, { capability: "signals", scope: "read" }] };
  const declared = { name: "signals", requires: [{ capability: "signals", scope: "read" }] };

  it("passes assertSkillsWithinGrants over signals:read", () => {
    const m = parseManifest({ ...withSignals, skills: [declared] });
    expect(() => assertSkillsWithinGrants(m)).not.toThrow();
  });

  it("FAILS when signals is not granted — the never-widen property, named", () => {
    const m = parseManifest({ ...base, skills: [declared] });
    expect(() => assertSkillsWithinGrants(m)).toThrow(/signals.*signals.*not granted/);
  });

  it("is backed by the one tool the capability doc names", () => {
    expect(KNOWN_SKILLS).toContain("signals");
    expect(skillToolsFor("signals")).toEqual(["agent-kit__signals_recent"]);
  });

  it("resolves to the tool when declared, and to a disable sentinel when not", () => {
    const tool = { description: "recent signals" };
    expect(resolveSkillTool({ ...withSignals, skills: [declared] }, "signals", tool)).toBe(tool);
    expect(isDisabledToolSentinel(resolveSkillTool(withSignals, "signals", tool))).toBe(true);
  });
});

// ADR-0017 (the Vault, one name). A skill can require a specific AREA of the `vault`
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

// ---------------------------------------------------------------------------
// Instruction skills: which ones exist in a conversation.
//
// Since eve 1.0 the framework's own loader loads any skill a conversation has, so the rule is
// which skills EXIST. These cases pin the decision itself; each service's
// tests/skill-availability.test.ts pins that its skill files actually ask it.
// ---------------------------------------------------------------------------

/** A declaration that allows every instruction skill the engine knows. */
const everything = {
  name: "t", model: "m", persona: "p.md",
  grants: [
    { capability: "gmail", scope: "write-with-confirm" },
    { capability: "identity", scope: "read" },
    { capability: "outreach", scope: "write" },
    { capability: "read_url", scope: "read" },
    { capability: "signals", scope: "read" },
    { capability: "twenty", scope: "write-with-confirm" },
    { capability: "voice", scope: "read" },
  ],
  skills: [{ name: "signals", requires: [{ capability: "signals", scope: "read" }] }],
};
const without = (capability: string) => ({ ...everything, grants: everything.grants.filter((g) => g.capability !== capability) });
const withScope = (capability: string, scope: string) => ({ ...everything, grants: everything.grants.map((g) => g.capability === capability ? { ...g, scope } : g) });

describe("INSTRUCTION_SKILLS", () => {
  it("names only capabilities the engine knows, and is kept sorted by name", () => {
    expect(INSTRUCTION_SKILL_NAMES).toEqual(["lares-docs", "sales-outreach", "signals"]);
    for (const name of INSTRUCTION_SKILL_NAMES) {
      for (const req of INSTRUCTION_SKILLS[name].requires) {
        expect(KNOWN_CAPABILITIES as readonly string[], `${name} requires ${req.capability}`).toContain(req.capability);
      }
    }
  });

  it("lets a private console conversation have lares-docs and nothing else", () => {
    expect(INSTRUCTION_SKILL_NAMES.filter((name) => INSTRUCTION_SKILLS[name].privateConsole)).toEqual(["lares-docs"]);
  });

  it("gives the private-console skill no requirement at all: it reads nothing of the installation", () => {
    // The two halves of one decision. A skill offered in a private console conversation is
    // offered WITHOUT the definition being read, so it must be one that needs nothing from it.
    for (const name of INSTRUCTION_SKILL_NAMES) {
      const rule: { declaredAs?: string; requires: readonly unknown[]; privateConsole: boolean } = INSTRUCTION_SKILLS[name];
      if (rule.privateConsole) {
        expect(rule.requires, name).toEqual([]);
        expect(rule.declaredAs, name).toBeUndefined();
      } else {
        // And the reverse: every other skill is checked against something. An entry with no
        // requirement and no declaration would be a skill nothing governs.
        expect(rule.requires.length + (rule.declaredAs === undefined ? 0 : 1), name).toBeGreaterThan(0);
      }
    }
  });
});

describe("grantsCover", () => {
  it("agrees with assertSkillsWithinGrants on every pair of scopes", () => {
    // The yes/no form must never say yes where the throwing form says no, or the conversation
    // check would be weaker than the save check.
    for (const granted of SCOPES) {
      for (const required of SCOPES) {
        const m = parseManifest({ ...base, grants: [{ capability: "twenty", scope: granted }], skills: [{ name: "commercial", requires: [{ capability: "twenty", scope: required }] }] });
        let passes = true;
        try { assertSkillsWithinGrants(m); } catch { passes = false; }
        expect(grantsCover(m.grants, [{ capability: "twenty", scope: required }]), `${granted} over ${required}`).toBe(passes);
      }
    }
  });
  it("says no for an ungranted capability and for one the engine does not know", () => {
    expect(grantsCover([], [{ capability: "twenty", scope: "read" }])).toBe(false);
    expect(grantsCover([{ capability: "made_up", scope: "write" }], [{ capability: "made_up", scope: "read" }])).toBe(false);
  });
  it("says yes when nothing is required", () => {
    expect(grantsCover([], [])).toBe(true);
  });
});

describe("instructionSkillsAllowedBy", () => {
  it("allows every skill when the declaration grants what each one uses", () => {
    expect(instructionSkillsAllowedBy(everything)).toEqual(["lares-docs", "sales-outreach", "signals"]);
  });

  it("allows only lares-docs on a declaration with no grants and no skills", () => {
    expect(instructionSkillsAllowedBy({ name: "t", model: "m" })).toEqual(["lares-docs"]);
  });

  // sales-outreach was loadable before this with no check at all. Now it exists only where the
  // grants reach every tool its text names.
  for (const capability of INSTRUCTION_SKILLS["sales-outreach"].requires.map((r) => r.capability)) {
    it(`drops sales-outreach when "${capability}" is not granted`, () => {
      expect(instructionSkillsAllowedBy(without(capability))).not.toContain("sales-outreach");
    });
    it(`drops sales-outreach when "${capability}" is granted at none, or switched off with never`, () => {
      expect(instructionSkillsAllowedBy(withScope(capability, "none"))).not.toContain("sales-outreach");
      expect(instructionSkillsAllowedBy({ ...everything, autonomy: { [capability]: "never" } })).not.toContain("sales-outreach");
    });
  }

  it("drops sales-outreach when a grant is too narrow for the tool the text names", () => {
    // `gmail_send` and `twenty_comm_state` raise their own approval card, so a read grant does
    // not reach them.
    expect(instructionSkillsAllowedBy(withScope("gmail", "read"))).not.toContain("sales-outreach");
    expect(instructionSkillsAllowedBy(withScope("twenty", "read"))).not.toContain("sales-outreach");
    // A wider grant than required is still inside it.
    expect(instructionSkillsAllowedBy(withScope("gmail", "write"))).toContain("sales-outreach");
  });

  it("drops signals when the definition no longer declares the signals skill", () => {
    expect(instructionSkillsAllowedBy({ ...everything, skills: [] })).toEqual(["lares-docs", "sales-outreach"]);
  });

  it("drops signals when the feed is switched off with never", () => {
    expect(instructionSkillsAllowedBy({ ...everything, autonomy: { signals: "never" } })).not.toContain("signals");
  });

  it("drops signals when the skill is declared with no requirement but the feed is not granted", () => {
    // An empty `requires` passes the save check (it asks for nothing). The text still names the
    // feed's tool, so the engine's own requirement is what keeps it out.
    expect(instructionSkillsAllowedBy({ ...without("signals"), skills: [{ name: "signals" }] })).not.toContain("signals");
  });

  it("THROWS on a declaration that widens, exactly as resolveSkillTool does", () => {
    const widened = { ...everything, skills: [{ name: "signals", requires: [{ capability: "signals", scope: "write" }] }] };
    expect(() => instructionSkillsAllowedBy(widened)).toThrow(/never widen/);
    expect(() => resolveSkillTool(widened, "signals", {})).toThrow(/never widen/);
  });

  it("THROWS on a declaration that does not parse, or that names a skill the engine does not know", () => {
    expect(() => instructionSkillsAllowedBy({ ...everything, grant: [] })).toThrow(/invalid agent manifest/);
    expect(() => instructionSkillsAllowedBy(null)).toThrow(/invalid agent manifest/);
    // An instruction skill's name is never valid in a definition: nothing can declare its way in.
    expect(() => instructionSkillsAllowedBy({ ...everything, skills: [{ name: "sales-outreach" }] })).toThrow(/unknown skill "sales-outreach"/);
    expect(() => instructionSkillsAllowedBy({ ...everything, skills: [{ name: "lares-docs" }] })).toThrow(/unknown skill "lares-docs"/);
  });
});

describe("instructionSkillOffered", () => {
  /** A per-conversation memo like the framework's: runs once per key, keeps nothing on a throw. */
  function conversation(definition: () => Promise<unknown>, privateConsole = false) {
    const kept = new Map<string, unknown>();
    let reads = 0;
    return {
      get reads() { return reads; },
      kept,
      privateConsole,
      memo: async <T>(key: unknown, fn: () => T | Promise<T>): Promise<T> => {
        const k = JSON.stringify(key);
        if (kept.has(k)) return kept.get(k) as T;
        const value = await fn();
        kept.set(k, value);
        return value;
      },
      definition: async () => { reads += 1; return definition(); },
    };
  }
  const offeredIn = async (c: ReturnType<typeof conversation>) => {
    const out: string[] = [];
    for (const name of INSTRUCTION_SKILL_NAMES) if (await instructionSkillOffered(name, c)) out.push(name);
    return out;
  };

  it("offers what the definition allows, reading the definition once for the conversation", async () => {
    const c = conversation(async () => everything);
    expect(await offeredIn(c)).toEqual(["lares-docs", "sales-outreach", "signals"]);
    expect(await offeredIn(c)).toEqual(["lares-docs", "sales-outreach", "signals"]);
    expect(c.reads).toBe(1);
    expect([...c.kept.keys()]).toEqual([JSON.stringify(INSTRUCTION_SKILLS_MEMO_KEY)]);
  });

  it("offers a private console conversation lares-docs and nothing else, without reading the definition", async () => {
    const c = conversation(async () => everything, true);
    expect(await offeredIn(c)).toEqual(["lares-docs"]);
    expect(c.reads).toBe(0);
  });

  it("treats anything but an exact false as a private console conversation", async () => {
    for (const claim of [undefined, null, "false", 0, 1]) {
      const c = { ...conversation(async () => everything), privateConsole: claim as unknown as boolean };
      expect(await instructionSkillOffered("signals", c), String(claim)).toBe(false);
      expect(await instructionSkillOffered("sales-outreach", c), String(claim)).toBe(false);
    }
  });

  it("FAILS CLOSED when the definition cannot be read: no restricted skill, nothing thrown, nothing kept", async () => {
    const c = conversation(async () => { throw new Error("definition is unusable and there is no last valid one"); });
    expect(await offeredIn(c)).toEqual(["lares-docs"]);
    // Not kept: the next model call asks again, so a repaired definition is picked up.
    expect(c.kept.size).toBe(0);
    expect(await offeredIn(c)).toEqual(["lares-docs"]);
    expect(c.reads).toBe(4);
  });

  it("FAILS CLOSED when the definition does not validate or widens", async () => {
    const widened = { ...everything, skills: [{ name: "signals", requires: [{ capability: "signals", scope: "write" }] }] };
    for (const bad of [null, "not a definition", { ...everything, grant: [] }, widened, { ...everything, skills: [{ name: "sales-outreach" }] }]) {
      expect(await offeredIn(conversation(async () => bad))).toEqual(["lares-docs"]);
    }
  });

  it("FAILS CLOSED when the memo throws or hands back something that is not a list of names", async () => {
    const broken = { privateConsole: false, definition: async () => everything, memo: async () => { throw new Error("memo unavailable"); } };
    expect(await instructionSkillOffered("signals", broken)).toBe(false);
    for (const kept of [true, "signals", { signals: true }, null, undefined]) {
      const odd = { privateConsole: false, definition: async () => everything, memo: (async () => kept) as never };
      expect(await instructionSkillOffered("signals", odd), JSON.stringify(kept)).toBe(false);
    }
  });

  it("refuses a name the engine does not know, including names off Object.prototype", async () => {
    const c = conversation(async () => everything);
    for (const name of ["commercial", "toString", "constructor", "__proto__", ""]) {
      expect(await instructionSkillOffered(name, c), name).toBe(false);
    }
  });

  it("a definition that drops a skill: absent in the NEXT conversation, unchanged in this one", async () => {
    let current: unknown = everything;
    const first = conversation(async () => current);
    expect(await offeredIn(first)).toContain("signals");
    current = { ...everything, skills: [] };
    // The conversation that already started keeps what it was given (ADR-0015).
    expect(await offeredIn(first)).toContain("signals");
    expect(await offeredIn(conversation(async () => current))).toEqual(["lares-docs", "sales-outreach"]);
  });
});
