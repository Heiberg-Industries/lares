// lares-split hook 30: neutral fixture (ORB-262) — installation-only assertions retargeted; see the lares split plan.
/**
 * eve-saga's INSTRUCTION skills — the `agent/skills/*.md` files eve loads by name.
 *
 * These are a different layer from the `skills` array in `agent.json`, and deliberately so.
 * `agent.json` declares what Saga is ALLOWED to reach (a code skill over granted capabilities,
 * enforced by `resolveSkillTool` at build time). A file here is the conversational loop she runs
 * when she reaches it — the shape of the answer, the order of the calls, the sentence she says
 * when the feed is dark. Neither substitutes for the other: a declaration with no instruction
 * file gives her a tool and no method, and an instruction file with no declaration is prose
 * about a tool that does not exist.
 *
 * Three properties are pinned here, all of which fail silently otherwise:
 *
 *  1. A skill file with no `description` frontmatter is INVISIBLE. eve's skill loader matches on
 *     the description, so a file missing it is never selected — the skill simply never fires, and
 *     nothing anywhere reports that. This is the check that says so.
 *  2. A skill whose loop is grounded in a tool must NAME that tool. `market-edge`'s whole first
 *     rule is "ground first, every time" — if the file stopped naming `agent-kit__market_edge`,
 *     the rule would read as advice with no call attached to it, and the model would answer a
 *     price from memory, which is the one thing Tyche's persona never did.
 *  3. A skill is as GENERIC as the role template it travels with (ORB-210 item 7). These files
 *     are the loop of a retired agent, extracted the same way a role template is, and until now
 *     nothing held them to the role's bar: `sales-outreach.md` hard-coded two mailbox addresses
 *     and named the owner five times. Owner-specific facts belong in `agent/voice.md`, the one
 *     hand-written file allowed to carry them, or in a runtime lookup.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { lintInstructionSkill, assertSkillIsGeneric } from "@lares/agent-kit/persona";

const skillsDir = join(import.meta.dirname, "..", "agent", "skills");
const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const bodyOf = (name: string) => readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");

/** The `description:` line of a `---`-delimited YAML frontmatter block, or undefined when there
 *  is no frontmatter at all. Deliberately a small reader rather than a YAML dependency: the
 *  frontmatter here is one key, and the assertion is about presence and non-emptiness. */
function descriptionOf(md: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(md);
  if (!m) return undefined;
  const line = /^description:\s*(.*)$/mu.exec(m[1]!);
  return line?.[1]?.trim();
}

describe("eve-saga agent/skills", () => {
  it("ships the three skills as skill packages, the way the open format names them", () => {
    expect(skills).toEqual(["market-edge", "sales-outreach", "signals"]);
    for (const s of skills) {
      expect(existsSync(join(skillsDir, s, "SKILL.md")), `${s}/SKILL.md`).toBe(true);
    }
  });

  it("leaves no flat .md behind — eve would load it as a SECOND skill of the same name", () => {
    const flat = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name);
    expect(flat).toEqual([]);
  });

  it("each names itself in its frontmatter, matching its directory", () => {
    for (const s of skills) {
      expect(/^name:\s*(.+)$/mu.exec(bodyOf(s))?.[1]?.trim(), s).toBe(s);
    }
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
    expect(bodyOf("market-edge")).toContain("agent-kit__market_edge");
    expect(bodyOf("signals")).toMatch(/signal/i);
    expect(bodyOf("sales-outreach")).not.toMatch(/bendik|heiberg/i);
  });

  it("market-edge.md names the tool its every answer is grounded in", () => {
    const md = bodyOf("market-edge");
    expect(md).toContain("agent-kit__market_edge");
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
    // ORB-210 item 7 moved `owner@owner.example` / `owner@project.example` and the Heiberg-vs-Zero7 tone
    // note into agent/voice.md, which is assembled into instructions.md and so is in context on
    // every turn. The skill must still say what to do — otherwise "which mailbox" became a
    // question with no answer, which is worse than a stale hard-coded list.
    const md = bodyOf("sales-outreach");
    expect(md).toMatch(/identity_my_addresses/u);
    expect(md).toMatch(/`account`/u);
    // The addresses themselves live in the installation's agent/voice.md (the overlay's, since
    // the lares split — the engine ships a neutral voice with none). What the ENGINE guards is
    // the half that makes the move real: the skill carries no mailbox address of its own.
    expect(md).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/iu);
  });

  it("market-edge keeps the three hard limits and the proactive-OFF posture", () => {
    // The policy half. The tool enforces the caveat and the computed edge in code; these are the
    // parts only the instructions can carry — what she must REFUSE, and the fact that saying
    // nothing about a market is the designed behaviour rather than a broken feed (ORB-193 is
    // what would change that, and it does not exist yet).
    const md = bodyOf("market-edge");
    expect(md).toMatch(/never a stake size/iu);
    expect(md).toMatch(/never place or suggest placing a bet/iu);
    expect(md).toMatch(/never a number the tool did not return/iu);
    expect(md).toMatch(/proactive alerts are OFF/iu);
    expect(md).toMatch(/could not be read/iu);
  });

  it("no shipped skill pre-approves a tool — requirements live in agent.json", () => {
    for (const s of skills) {
      expect(bodyOf(s), s).not.toMatch(/^allowed-tools:/mu);
      expect(lintInstructionSkill(bodyOf(s), s), s).toEqual([]);
    }
  });
});
