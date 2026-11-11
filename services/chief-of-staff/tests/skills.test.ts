/**
 * chief-of-staff's INSTRUCTION skills — the files under `agent/skills/` that eve loads by name
 * (its own `eve__skill` loader since eve 1.0; which skills exist in a conversation is pinned in
 * tests/skill-availability.test.ts).
 *
 * These are a different layer from the `skills` array in `agent.json`, and deliberately so.
 * `agent.json` declares what the chief of staff is ALLOWED to reach (a code skill over granted capabilities,
 * enforced by `resolveSkillTool` at build time). A file here is the conversational loop the agent runs
 * when the agent reaches it — the shape of the answer, the order of the calls, the sentence the agent says
 * when the feed is dark. Neither substitutes for the other: a declaration with no instruction
 * file gives the agent a tool and no method, and an instruction file with no declaration is prose
 * about a tool that does not exist.
 *
 * Three properties are pinned here, all of which fail silently otherwise:
 *
 *  1. A skill file with no `description` frontmatter is INVISIBLE. eve's skill loader matches on
 *     the description, so a file missing it is never selected — the skill simply never fires, and
 *     nothing anywhere reports that. This is the check that says so.
 *  2. A skill whose loop is grounded in a tool must NAME that tool. `signals`' first rule is
 *     "ground first, every time" — if the file stopped naming `agent-kit__signals_recent`, the
 *     rule would read as advice with no call attached to it, and the model would answer from
 *     memory.
 *  3. A skill is as GENERIC as the role template it travels with. These files
 *     are the loop of a retired agent, extracted the same way a role template is, and until now
 *     nothing held them to the role's bar: `sales-outreach.md` hard-coded two mailbox addresses
 *     and named the owner five times. Owner-specific facts belong in `agent/voice.md`, the one
 *     hand-written file allowed to carry them, or in a runtime lookup.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { lintInstructionSkill, assertSkillIsGeneric } from "@lares/agent-kit/persona";
import { grantedToolNames, type Catalogue } from "@lares/agent-kit/catalogue";
import { parseDefinition, manifestViewOf } from "@lares/agent-kit/definition";
import { INSTRUCTION_SKILLS, instructionSkillsAllowedBy, scopeAtLeast } from "@lares/agent-kit/manifest";
import manifest from "../agent.json";
import { denylistPatterns } from "./helpers/denylist";

const skillsDir = join(import.meta.dirname, "..", "agent", "skills");
const skillDefinitions = {
  signals: (await import('../agent/skills/signals.js')).default,
  'sales-outreach': (await import('../agent/skills/sales-outreach.js')).default,
};
const skills = Object.keys(skillDefinitions).sort();
// eve 1.0: a dynamic skill is ONE function of the conversation, kept under this symbol by
// `defineDynamic`. Called here with an ordinary (not private console) conversation and a memo that
// simply runs, against this service's own committed agent.json, which allows both skills.
interface ResolvedSkill { description: string; content: string }
const evaluate = (d: unknown) => (d as Record<symbol, (ctx: unknown) => Promise<ResolvedSkill | null>>)[Symbol.for("eve.dynamic")]!;
const ordinary = (id: string) => ({ session: { id, auth: { current: null, initiator: null } }, memo: async (_key: unknown, fn: () => unknown) => fn() });
const resolved = Object.fromEntries(await Promise.all(Object.entries(skillDefinitions).map(async ([name, d]) =>
  [name, await evaluate(d)(ordinary(`skills-test-${name}`))]))) as Record<string, ResolvedSkill | null>;
const bodyOf = (name: string) => resolved[name]!.content;
const descriptionOf = (md: string) => Object.values(resolved).find(s => s?.content === md)?.description;

describe("chief-of-staff agent/skills", () => {
  it("ships conditional skills with no static copies", () => {
    expect(skills).toEqual(["sales-outreach", "signals"]);
    for (const s of skills) {
      expect(existsSync(join(skillsDir, `${s}.ts`))).toBe(true);
      expect(existsSync(join(skillsDir, s, "SKILL.md"))).toBe(false);
    }
  });

  it("leaves no flat .md behind — eve would load it as a SECOND skill of the same name", () => {
    const flat = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name);
    expect(flat).toEqual([]);
  });

  it("keeps every description, which is what eve matches on", () => {
    for (const s of skills) {
      const d = descriptionOf(bodyOf(s));
      expect(d, `${s} has no description — eve would never select it`).toBeDefined();
      expect(d!.length).toBeGreaterThan(0);
    }
  });

  it("moves the bodies unchanged — the same bytes below the frontmatter", () => {
    // Pinned so a "small improvement" cannot ride along in a move.
    expect(bodyOf("signals")).toMatch(/signal/i);
    for (const re of denylistPatterns()) expect(bodyOf("sales-outreach")).not.toMatch(re);
  });

  it("signals.md requires a fresh spine read and preserves unavailable versus empty", () => {
    const md = bodyOf("signals");
    expect(md).toContain("agent-kit__signals_recent");
    expect(md).toMatch(/never answer all-clear from memory/iu);
    expect(md).toMatch(/spine could not be read/iu);
  });

  for (const s of skills) {
    it(`${s} is as generic as a role template — the owner's world lives in voice.md`, () => {
      const md = bodyOf(s);
      // Both halves: the finding list (so a failure names the word and the line) and the
      // assertion the kit exposes for a build hook to call.
      expect(lintInstructionSkill(md).map((f) => `line ${f.line}: ${f.rule} "${f.match}"`)).toEqual([]);
      expect(() => assertSkillIsGeneric(md, s)).not.toThrow();
    });
  }

  it("sales-outreach still tells the agent HOW to resolve a mailbox after the addresses moved", () => {
    // The mailbox addresses and the per-company tone note live in agent/voice.md, which is assembled into persona.md and so is in context on
    // every turn. The skill must still say what to do — otherwise "which mailbox" became a
    // question with no answer, which is worse than a stale hard-coded list.
    const md = bodyOf("sales-outreach");
    expect(md).toMatch(/identity_my_addresses/u);
    expect(md).toMatch(/`account`/u);
    // The addresses themselves live in the installation's agent/voice.md (the engine ships a
    // neutral voice with none). What the ENGINE guards is
    // the half that makes the move real: the skill carries no mailbox address of its own.
    expect(md).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/iu);
  });

  it("no shipped skill pre-approves a tool — requirements live in agent.json", () => {
    for (const s of skills) {
      expect(bodyOf(s), s).not.toMatch(/^allowed-tools:/mu);
      expect(lintInstructionSkill(bodyOf(s), s), s).toEqual([]);
    }
  });
});

// The never-widen rule for instruction text. A skill's requirements are the ENGINE's list
// (INSTRUCTION_SKILLS, @lares/agent-kit/skill-grants), not the definition's, and these cases are
// what stop that list drifting from the text it describes.
//
// They read this agent's tool pool, which is loaded inside the block rather than at the top of
// the file: the pool imports the kit's BUILT tools, and the properties above must stay checkable
// where the kit has not been built.
describe("chief-of-staff agent/skills against the tool pool", () => {
  let CATALOGUE: Catalogue;
  beforeAll(async () => { ({ CATALOGUE } = await import("../catalogue/index.js")); });

  /** The tools a skill's text names: every backticked word that is a tool in this agent's pool. */
  const namedTools = (md: string) => [...new Set([...md.matchAll(/`([A-Za-z0-9_-]+)`/gu)].map((m) => m[1]!))].filter((name) => Object.hasOwn(CATALOGUE, name)).sort();
  /** The lowest scope at which the tool list hands `name` over (`grantedToolNames`): a tool that
   *  raises its own approval card needs write-with-confirm, any other is reachable at read. */
  const scopeNeededBy = (name: string) => {
    const entry = CATALOGUE[name]!;
    return entry.tool.approval !== undefined && entry.asksWithoutWriting !== true ? "write-with-confirm" as const : "read" as const;
  };

  for (const s of skills) {
    it(`${s}: the engine's requirements cover every tool the text names, and nothing else`, () => {
      const rule = INSTRUCTION_SKILLS[s as keyof typeof INSTRUCTION_SKILLS];
      const tools = namedTools(bodyOf(s));
      expect(tools.length, `${s} names no tool of this agent`).toBeGreaterThan(0);
      for (const tool of tools) {
        const capability = CATALOGUE[tool]!.capability;
        const req = rule.requires.find((r) => r.capability === capability);
        expect(req, `${s} names \`${tool}\` but does not require "${capability}"`).toBeDefined();
        expect(scopeAtLeast(req!.scope, scopeNeededBy(tool)), `${s} requires "${capability}" at "${req!.scope}", too low for \`${tool}\``).toBe(true);
      }
      // Nothing spurious: a requirement no named tool stands behind would take the skill away
      // from an agent for no reason.
      expect(rule.requires.map((r) => r.capability).sort()).toEqual([...new Set(tools.map((t) => CATALOGUE[t]!.capability))].sort());
    });

    it(`${s}: wherever a definition allows it, every tool it names is in that conversation's tool list`, () => {
      const base = parseDefinition(manifest);
      const variants = [
        base,
        // Each grant dropped in turn, each narrowed to read, each switched off with never, and
        // the skills list emptied.
        ...base.grants.map((g) => ({ ...base, grants: base.grants.filter((x) => x !== g), autonomy: Object.fromEntries(Object.entries(base.autonomy).filter(([k]) => k !== g.capability)), skills: base.skills.filter((k) => !k.requires.some((r) => r.capability === g.capability)) })),
        ...base.grants.map((g) => ({ ...base, grants: base.grants.map((x) => x === g ? { ...x, scope: "read" as const } : x) })),
        ...base.grants.map((g) => ({ ...base, autonomy: { ...base.autonomy, [g.capability]: "never" as const } })),
        { ...base, skills: [] },
      ];
      let allowedSomewhere = 0;
      let refusedSomewhere = 0;
      for (const definition of variants) {
        const allowed = instructionSkillsAllowedBy(manifestViewOf(definition)).includes(s as never);
        if (!allowed) { refusedSomewhere += 1; continue; }
        allowedSomewhere += 1;
        const present = new Set(grantedToolNames(CATALOGUE, definition));
        expect(namedTools(bodyOf(s)).filter((tool) => !present.has(tool)), `${s} is offered without these tools`).toEqual([]);
      }
      // The loop above proves nothing if it never took either branch.
      expect(allowedSomewhere).toBeGreaterThan(0);
      expect(refusedSomewhere).toBeGreaterThan(0);
    });
  }

  it("lares-docs names no tool of the granted pool — which is why it needs no grant", async () => {
    const docs = await evaluate((await import("../agent/skills/lares-docs.js")).default)(ordinary("skills-test-lares-docs"));
    expect(docs!.description.length).toBeGreaterThan(0);
    expect(docs!.content).toContain("lares_read_public_doc");
    expect(namedTools(docs!.content)).toEqual([]);
    expect(Object.hasOwn(CATALOGUE, "lares_read_public_doc")).toBe(false);
    expect(INSTRUCTION_SKILLS["lares-docs"].requires).toEqual([]);
  });
});
