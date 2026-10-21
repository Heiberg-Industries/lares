/**
 * chief-of-staff's INSTRUCTION skills — the `SKILL.md` files under `agent/skills/` that eve loads by name.
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
import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { lintInstructionSkill, assertSkillIsGeneric } from "@lares/agent-kit/persona";
import { denylistPatterns } from "./helpers/denylist";

const skillsDir = join(import.meta.dirname, "..", "agent", "skills");
const skillDefinitions = {
  signals: (await import('../agent/skills/signals.js')).default,
  'sales-outreach': (await import('../agent/skills/sales-outreach.js')).default,
};
const skills = Object.keys(skillDefinitions).sort();
const resolved = Object.fromEntries(await Promise.all(Object.entries(skillDefinitions).map(async ([name, d]) =>
  [name, await d.events['session.started']!({}, {session:{id:'native',auth:{current:null,initiator:null}}} as never)])));
const bodyOf = (name: string) => (resolved[name] as {markdown:string}).markdown;
const descriptionOf = (md: string) => Object.values(resolved).find(s => (s as {markdown:string}).markdown === md)?.description;

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
