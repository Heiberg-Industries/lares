/**
 * WHICH INSTRUCTION SKILLS EXIST IN A CONVERSATION.
 *
 * Since eve 1.0 the framework adds its own skill loader (`eve__skill`) to every conversation that
 * has a skill, and that loader loads ANY skill the conversation has. No authored tool can replace
 * it or stand in front of it. So the rule this agent used to enforce in its own loader ("who may
 * load which skill") can only hold one way now: a skill the conversation is not allowed is NOT
 * THERE. Each file under `agent/skills/` is a function of the conversation that returns the skill
 * or `null`, and this suite calls every one of those functions the way eve does.
 *
 * What is real here and what is a stand-in:
 *
 *  - The skill files, the kit's decision (`instructionSkillOffered`) and the private console
 *    verification (`verifyPrivateConsoleSession`) are the real code.
 *  - The definition is read through the real loader and the real fail-closed fallback
 *    (`resolveDefinition`); only its Postgres pool and the definition folder are fixtures.
 *  - One thing is replaced: the database lookup that says whether a console conversation is
 *    bound to this member. It answers "bound" or throws, per case.
 *
 * The context each function receives is a plain object with the three things the skill files
 * read off eve's dynamic context: `session.id`, `session.auth`, and `memo`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fake = vi.hoisted(() => ({
  /** The console binding lookup: resolves when the conversation is bound to the member. */
  binding: vi.fn(),
  /** Rows the fake `agent_definitions` table holds, by agent name. */
  remembered: new Map<string, { definition: unknown; duties: string; voice: string; hash: string }>(),
  queries: [] as string[],
}));

vi.mock("../../../packages/agent-kit/src/console-turn-authority.js", async (original) => ({
  ...(await original<typeof import("../../../packages/agent-kit/src/console-turn-authority.js")>()),
  requireConsoleSessionBinding: fake.binding,
}));
// The last valid definition lives in Postgres. A fixture pool with just the three statements
// `definition-cache.ts` issues, so the REAL fallback logic runs without a database.
vi.mock("../../../packages/agent-kit/src/db.js", async (original) => ({
  ...(await original<typeof import("../../../packages/agent-kit/src/db.js")>()),
  getPool: () => ({
    query: async (sql: string, params: unknown[] = []) => {
      fake.queries.push(sql.trim().split(/\s+/u).slice(0, 2).join(" "));
      const name = String(params[0]);
      if (sql.includes("SELECT definition")) {
        const row = fake.remembered.get(name);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("INSERT INTO agent_definitions")) {
        fake.remembered.set(name, { definition: JSON.parse(String(params[1])), duties: String(params[2]), voice: String(params[3]), hash: String(params[4]) });
      }
      return { rows: [] };
    },
  }),
}));

import { INSTRUCTION_SKILLS, INSTRUCTION_SKILLS_MEMO_KEY, KNOWN_CAPABILITIES } from "@lares/agent-kit/manifest";
import { CONSOLE_AUTHORITY_REFUSED } from "@lares/agent-kit/console-turn-authority";

import neutral from "../agent.json";

// ---------------------------------------------------------------------------
// The skill files, all of them
// ---------------------------------------------------------------------------

interface ResolvedSkill { description: string; content: string }
type SkillFunction = (ctx: unknown) => Promise<ResolvedSkill | null>;

const skillsDir = join(import.meta.dirname, "..", "agent", "skills");
/** Read off disk, not listed by hand: a skill file added later cannot stay outside this suite. */
const SKILL_NAMES = readdirSync(skillsDir).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3)).sort();
const SKILLS: Record<string, SkillFunction> = Object.fromEntries(await Promise.all(SKILL_NAMES.map(async (name) => {
  const module = (await import(`../agent/skills/${name}.ts`)) as { default: Record<symbol, SkillFunction> };
  // eve 1.0: `defineDynamic(fn)` keeps the one function under this symbol.
  const fn = module.default[Symbol.for("eve.dynamic")];
  if (typeof fn !== "function") throw new Error(`agent/skills/${name}.ts is not a defineDynamic(fn) value`);
  return [name, fn] as const;
})));

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

const NONCE = "a".repeat(43);
const member = (id: string, extra: Record<string, unknown> = {}) => ({
  authenticator: "lares-console", principalType: "user", principalId: id,
  attributes: { lares_member_id: id, lares_admission_nonce: NONCE, lares_purpose: "human", ...extra },
});

let seq = 0;
/** One conversation: a fresh session id and a memo of its own, like the framework's (runs a key
 *  once, keeps the JSON it returned, keeps nothing when the function throws). */
function conversation(auth: { current: unknown; initiator: unknown } | null) {
  const kept = new Map<string, string>();
  return {
    kept,
    ctx: {
      session: { id: `skill-availability-${seq += 1}`, auth },
      memo: async <T>(key: unknown, fn: () => T | Promise<T>): Promise<T> => {
        const k = JSON.stringify(key ?? null);
        if (!kept.has(k)) kept.set(k, JSON.stringify(await fn()));
        return JSON.parse(kept.get(k)!) as T;
      },
    },
  };
}
/** Slack, Telegram and web chat conversations carry no console admission at all. */
const ordinary = () => conversation({ current: null, initiator: null });
const privateConsole = (who = member("member-one")) => conversation({ current: who, initiator: who });

/** What the conversation ends up with: each skill file's own answer, and the names that exist.
 *  A skill file that throws has refused the turn; it is recorded as such and it yields nothing. */
async function skillsOf(c: ReturnType<typeof conversation>) {
  const present: string[] = [];
  const refused: string[] = [];
  const text: string[] = [];
  for (const name of SKILL_NAMES) {
    try {
      const skill = await SKILLS[name]!(c.ctx);
      if (skill === null) continue;
      present.push(name);
      text.push(skill.description, skill.content);
    } catch (err) {
      refused.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { present, refused, text: text.join("\n") };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const AGENT = (neutral as { name: string }).name;
let dir: string | undefined;

/** Mount a definition folder holding `agentJson` (an object, or raw text for a broken file). */
function mount(agentJson: unknown): void {
  dir ??= mkdtempSync(join(tmpdir(), "skill-availability-"));
  writeFileSync(join(dir, "agent.json"), typeof agentJson === "string" ? agentJson : JSON.stringify(agentJson));
  writeFileSync(join(dir, "voice.md"), "Plain and brief.\n");
  writeFileSync(join(dir, "duties.md"), "");
  vi.stubEnv("LARES_DEFINITION_DIR", dir);
}
const withoutGrant = (capability: string) => {
  const { autonomy, grants, ...rest } = neutral as { autonomy: Record<string, string>; grants: { capability: string }[] } & Record<string, unknown>;
  return {
    ...rest,
    grants: grants.filter((g) => g.capability !== capability),
    autonomy: Object.fromEntries(Object.entries(autonomy).filter(([k]) => k !== capability)),
  };
};
const withoutSkill = (name: string) => ({ ...neutral, skills: neutral.skills.filter((s) => s.name !== name) });

beforeEach(() => {
  // A managed agent: the private console check refuses an agent with no identity of its own.
  vi.stubEnv("LARES_AGENT_NAME", AGENT);
  vi.stubEnv("LARES_AGENT_INCARNATION", "11111111-1111-4111-8111-111111111111");
  fake.binding.mockResolvedValue({});
  fake.remembered.clear();
  fake.queries.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fake.binding.mockReset();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// ---------------------------------------------------------------------------

describe("the skill files this suite covers", () => {
  it("is every file under agent/skills, and each has a rule in the engine's table", () => {
    expect(SKILL_NAMES).toEqual(["lares-docs", "sales-outreach", "signals"]);
    for (const name of SKILL_NAMES) {
      expect(Object.hasOwn(INSTRUCTION_SKILLS, name), `agent/skills/${name}.ts has no rule in INSTRUCTION_SKILLS, so it would never be offered`).toBe(true);
    }
  });

  it("keeps no authored skill loader: eve's own is the only one", () => {
    const tools = readdirSync(join(skillsDir, "..", "tools"));
    expect(tools).not.toContain("load_skill.ts");
    expect(tools.filter((f) => /skill/iu.test(f))).toEqual([]);
  });

  it("names every skill the way eve requires, and never in eve's reserved namespace", () => {
    for (const name of SKILL_NAMES) {
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
      expect(name.startsWith("eve")).toBe(false);
    }
  });
});

describe("an ordinary conversation (Slack, Telegram, web chat)", () => {
  it("gets exactly the skills the neutral definition allows", async () => {
    const got = await skillsOf(ordinary());
    expect(got.refused).toEqual([]);
    expect(got.present).toEqual(["lares-docs", "sales-outreach", "signals"]);
  });

  it("resolves each skill to a description and its text, in eve 1.0's field names", async () => {
    const c = ordinary();
    for (const name of SKILL_NAMES) {
      const skill = await SKILLS[name]!(c.ctx);
      expect(skill!.description.length, name).toBeGreaterThan(0);
      expect(skill!.content.length, name).toBeGreaterThan(20);
      expect(Object.keys(skill!).sort(), name).toEqual(["content", "description"]);
    }
  });

  it("reads the definition once per skill file for the whole conversation, not before every model call", async () => {
    mount(neutral);
    const c = ordinary();
    await skillsOf(c);
    const afterFirst = fake.queries.length;
    expect(afterFirst).toBeGreaterThan(0);
    for (let call = 0; call < 5; call += 1) expect((await skillsOf(c)).present).toEqual(["lares-docs", "sales-outreach", "signals"]);
    expect(fake.queries.length).toBe(afterFirst);
    // What is kept is the list of allowed names, never the skill text and never who is asking.
    expect([...c.kept.entries()]).toEqual([[JSON.stringify(INSTRUCTION_SKILLS_MEMO_KEY), JSON.stringify(["lares-docs", "sales-outreach", "signals"])]]);
  });

  it("a definition that drops the signals skill: signals is absent in the next conversation", async () => {
    mount(neutral);
    const first = ordinary();
    expect((await skillsOf(first)).present).toContain("signals");

    mount(withoutSkill("signals"));
    expect((await skillsOf(ordinary())).present).toEqual(["lares-docs", "sales-outreach"]);
    // The conversation already under way keeps the list it started with (ADR-0015).
    expect((await skillsOf(first)).present).toContain("signals");
  });

  it("a definition that drops the mail grant: sales-outreach is absent in the next conversation", async () => {
    mount(withoutGrant("gmail"));
    const got = await skillsOf(ordinary());
    expect(got.present).toEqual(["lares-docs", "signals"]);
    expect(got.text).not.toContain("gmail_send");
  });

  it("a definition that drops the signals grant and skill: no signals", async () => {
    mount({ ...withoutGrant("signals"), skills: neutral.skills.filter((s) => s.name !== "signals") });
    expect((await skillsOf(ordinary())).present).toEqual(["lares-docs", "sales-outreach"]);
  });

  it("a definition with no grants at all gets the public documentation skill and nothing else", async () => {
    mount({ name: AGENT, model: neutral.model, role: neutral.role });
    expect((await skillsOf(ordinary())).present).toEqual(["lares-docs"]);
  });
});

describe("a private console conversation", () => {
  it("gets lares-docs and nothing else", async () => {
    const c = privateConsole();
    const got = await skillsOf(c);
    expect(got.refused).toEqual([]);
    expect(got.present).toEqual(["lares-docs"]);
    expect(got.text).not.toContain("agent-kit__signals_recent");
    expect(got.text).not.toContain("gmail_send");
    // Verified against the binding for THIS conversation and THIS member, by every skill file.
    expect(fake.binding).toHaveBeenCalledTimes(SKILL_NAMES.length);
    for (const [input] of fake.binding.mock.calls) {
      expect(input).toMatchObject({ agent: AGENT, sessionId: c.ctx.session.id, memberId: "member-one", admissionNonce: NONCE });
    }
    // The restricted two, named: each resolves to nothing here.
    expect(await SKILLS["signals"]!(c.ctx)).toBeNull();
    expect(await SKILLS["sales-outreach"]!(c.ctx)).toBeNull();
  });

  it("gets nothing more when the definition allows everything, and does not read the definition", async () => {
    mount(neutral);
    const c = privateConsole();
    expect((await skillsOf(c)).present).toEqual(["lares-docs"]);
    expect(fake.queries).toEqual([]);
    expect(c.kept.size).toBe(0);
  });

  it("is verified again before every model call: nothing about who is asking is kept", async () => {
    const c = privateConsole();
    expect((await skillsOf(c)).present).toEqual(["lares-docs"]);
    // Access is withdrawn mid-conversation. The very next evaluation refuses.
    fake.binding.mockRejectedValue(new Error(CONSOLE_AUTHORITY_REFUSED));
    const after = await skillsOf(c);
    expect(after.present).toEqual([]);
    expect(after.refused).toHaveLength(SKILL_NAMES.length);
  });
});

describe("a caller who claims a private console conversation but is not verified", () => {
  const unverified: Record<string, () => ReturnType<typeof conversation>> = {
    "the conversation is not bound to this member (the lookup refuses)": () => {
      fake.binding.mockRejectedValue(new Error(CONSOLE_AUTHORITY_REFUSED));
      return privateConsole();
    },
    "the lookup itself fails": () => {
      fake.binding.mockRejectedValue(new Error("connection terminated unexpectedly"));
      return privateConsole();
    },
    "the person now speaking is not the person who opened it": () => conversation({ current: member("member-two"), initiator: member("member-one") }),
    "the admission was reissued since the conversation opened": () => conversation({ current: member("member-one", { lares_admission_nonce: "b".repeat(43) }), initiator: member("member-one") }),
    "the admission did not come from the console": () => {
      const forged = { ...member("member-one"), authenticator: "somewhere-else" };
      return conversation({ current: forged, initiator: forged });
    },
    "only a bare member id is presented": () => conversation({ current: { attributes: { lares_member_id: "member-one" } }, initiator: null }),
    "only the initiator carries the tag": () => conversation({ current: null, initiator: member("member-one") }),
    "the agent has no identity of its own to check against": () => {
      vi.stubEnv("LARES_AGENT_NAME", "");
      vi.stubEnv("LARES_AGENT_INCARNATION", "");
      return privateConsole();
    },
  };

  for (const [why, make] of Object.entries(unverified)) {
    it(`is refused when ${why}: no skill, and no skill text`, async () => {
      mount(neutral);
      const c = make();
      const got = await skillsOf(c);
      // Every skill file refuses the turn (eve fails it before any model call), so the
      // conversation would get no skills at all, and with none, no `eve__skill` loader.
      expect(got.present).toEqual([]);
      expect(got.text).toBe("");
      expect(got.refused).toHaveLength(SKILL_NAMES.length);
      // The restricted two, named: neither resolves to its text on this path.
      await expect(SKILLS["signals"]!(c.ctx)).rejects.toThrow();
      await expect(SKILLS["sales-outreach"]!(c.ctx)).rejects.toThrow();
      // And the refusal comes before the definition is consulted or anything is kept.
      expect(fake.queries).toEqual([]);
      expect(c.kept.size).toBe(0);
    });
  }

  it("never falls back to treating the conversation as an ordinary one", async () => {
    // The dangerous reading of a failed check would be "not private, so offer everything".
    fake.binding.mockRejectedValue(new Error(CONSOLE_AUTHORITY_REFUSED));
    const got = await skillsOf(privateConsole());
    expect(got.present).not.toContain("signals");
    expect(got.present).not.toContain("sales-outreach");
    expect(got.refused.join("\n")).toContain(CONSOLE_AUTHORITY_REFUSED);
  });
});

describe("an invalid or unreadable definition fails closed", () => {
  const broken: Record<string, unknown> = {
    "is not JSON": "{ this is not json",
    "has a misspelled field": { ...neutral, grant: [] },
    "has a skill that asks for more than its grant (never widen)": { ...neutral, skills: [{ name: "signals", requires: [{ capability: "signals", scope: "write" }] }] },
    "names a skill the engine does not know": { ...neutral, skills: [...neutral.skills, { name: "sales-outreach", requires: [] }] },
    "declares a different agent": { ...neutral, name: "someone-else" },
  };

  for (const [why, agentJson] of Object.entries(broken)) {
    it(`with no last valid definition, when agent.json ${why}: every restricted skill is absent and nothing throws`, async () => {
      mount(agentJson);
      const c = ordinary();
      const got = await skillsOf(c);
      expect(got.refused).toEqual([]);
      expect(await SKILLS["signals"]!(c.ctx)).toBeNull();
      expect(await SKILLS["sales-outreach"]!(c.ctx)).toBeNull();
      expect(got.present).toEqual(["lares-docs"]);
      expect(got.text).not.toContain("agent-kit__signals_recent");
      expect(got.text).not.toContain("gmail_send");
      // The failure is not kept: a repaired definition is picked up by the next model call.
      expect(c.kept.size).toBe(0);
      mount(neutral);
      expect((await skillsOf(c)).present).toEqual(["lares-docs", "sales-outreach", "signals"]);
    });

    it(`with a last valid definition, when agent.json ${why}: the agent keeps the last valid one's skills, not the broken edit's`, async () => {
      // The last valid definition allowed signals but not sales-outreach (no mail grant).
      mount(withoutGrant("gmail"));
      expect((await skillsOf(ordinary())).present).toEqual(["lares-docs", "signals"]);
      expect(fake.remembered.has(AGENT)).toBe(true);

      mount(agentJson);
      const got = await skillsOf(ordinary());
      expect(got.refused).toEqual([]);
      expect(got.present).toEqual(["lares-docs", "signals"]);
      expect(got.text).not.toContain("gmail_send");
    });
  }

  it("when the last valid definition no longer passes today's checks either: every restricted skill is absent", async () => {
    // A row an older engine stored as valid: it carries a grant for a capability this engine
    // does not know. Any unknown name makes the point, so a made-up one is used; the names the
    // vault rename retired may not be spelled as a capability anywhere in the tree.
    const unknownToThisEngine = { capability: "retired_capability", scope: "read" };
    expect(KNOWN_CAPABILITIES as readonly string[]).not.toContain(unknownToThisEngine.capability);
    const remember = (definition: unknown) => fake.remembered.set(AGENT, { definition, duties: "", voice: "", hash: "0".repeat(64) });

    remember({ ...neutral, grants: [...neutral.grants, unknownToThisEngine] });
    mount("{ this is not json");
    const got = await skillsOf(ordinary());
    expect(got.refused).toEqual([]);
    expect(got.present).toEqual(["lares-docs"]);

    // Control: the same row without that one grant is a usable last valid definition, so the
    // grant the engine no longer knows is what closed the case above, not the broken folder.
    remember(neutral);
    expect((await skillsOf(ordinary())).present).toEqual(["lares-docs", "sales-outreach", "signals"]);
  });

  it("when the definition store cannot be reached at all: every restricted skill is absent", async () => {
    mount(neutral);
    fake.remembered.clear();
    const c = ordinary();
    // The folder is fine but remembering it fails, so the read as a whole rejects.
    const failing = vi.spyOn(fake.remembered, "set").mockImplementation(() => { throw new Error("connection refused"); });
    const got = await skillsOf(c);
    expect(got.refused).toEqual([]);
    expect(got.present).toEqual(["lares-docs"]);
    failing.mockRestore();
  });

  it("when the framework's memo fails: every restricted skill is absent", async () => {
    const c = ordinary();
    c.ctx.memo = async () => { throw new Error("memo unavailable"); };
    const got = await skillsOf(c);
    expect(got.refused).toEqual([]);
    expect(got.present).toEqual(["lares-docs"]);
  });
});

describe("a conversation in which no skill resolves", () => {
  it("has no skills, so eve adds no skill loader to it", async () => {
    // eve adds `eve__skill` only when a conversation has a skill (built-in-tools.md). This agent
    // always offers the public documentation skill to a conversation it accepts, so the only
    // conversation with none is one it refuses outright; that is the case asserted here. The
    // real tool list is checked by the agent-definition packet's allow-list test.
    fake.binding.mockRejectedValue(new Error(CONSOLE_AUTHORITY_REFUSED));
    const got = await skillsOf(privateConsole());
    expect(got.present).toEqual([]);
    expect(got.text).toBe("");
  });
});

describe("the skill files' own source", () => {
  it("each verifies the private console claim before anything else and lets a failure through", () => {
    for (const name of SKILL_NAMES) {
      const source = readFileSync(join(skillsDir, `${name}.ts`), "utf8");
      const body = source.slice(source.indexOf("export default defineDynamic("));
      expect(body, name).toContain("const privateConsole = await verifyPrivateConsoleSession(ctx);");
      expect(body.indexOf("verifyPrivateConsoleSession(ctx)"), name).toBeLessThan(body.indexOf("instructionSkillOffered("));
      // No catch around the verification: swallowing it could only ever turn a refusal into an offer.
      expect(body, name).not.toMatch(/\bcatch\b/u);
      expect(body, name).toContain(`instructionSkillOffered("${name}"`);
      // Still on the pre-1.0 form would mean the framework never calls it.
      expect(source, name).not.toMatch(/session\.started|markdown:/u);
    }
  });
});
