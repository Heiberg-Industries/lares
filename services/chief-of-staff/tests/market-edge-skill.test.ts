// `agent-kit__market_edge`'s skill gate, driven at its real seam (ORB-278 step 2, Task 10 /
// LAR-5-s2). Before this task the gate lived INSIDE the tool's own mount, a `defineDynamic`
// resolver reading the mounted definition and returning `null` when the skill was undeclared —
// and this file drove that resolver directly. That resolver never actually removed the tool: a
// `null` dynamic override does not remove the kit extension's own STATIC contribution of the same
// name (LAR-5's diagnosis; Q6 in docs/research/2026-09-16-eve-0.32-dynamic-seams.md). The gate now
// lives in `grantedToolNames` (LAR-5-s1's `CatalogueEntry.skill`), so this file drives THAT instead
// — the same two cases as before (Saga's real, committed definition; a definition that declares
// the skill), but through the mechanism that actually works.
import { describe, expect, it } from "vitest";
import { isDisabledToolSentinel } from "eve/tools";
import { parseDefinition } from "@lares/agent-kit/definition";
import { grantedToolNames } from "@lares/agent-kit/catalogue";

import manifest from "../agent.json";
import { CATALOGUE } from "../catalogue/index.js";

describe("agent-kit__market_edge's skill gate", () => {
  it("carries `skill: \"market-edge\"` in the catalogue", () => {
    expect(CATALOGUE["agent-kit__market_edge"]?.skill).toBe("market-edge");
    expect(CATALOGUE["agent-kit__market_edge"]?.capability).toBe("markets");
  });

  it("is absent for Saga's real, committed definition — she holds commercial and signals, not market-edge", () => {
    const granted = grantedToolNames(CATALOGUE, parseDefinition(manifest));
    expect(granted).not.toContain("agent-kit__market_edge");
  });

  it("is present for a definition that DOES declare the market-edge skill", () => {
    const base = manifest as { grants: unknown[]; skills: unknown[] };
    const declared = parseDefinition({
      ...(manifest as object),
      // ADDS a grant and a skill; never removes one of Saga's real ones — the never-widen check
      // (`assertSkillsWithinGrants`) must still pass for `commercial` and `signals`.
      grants: [...base.grants, { capability: "markets", scope: "read" }],
      skills: [...base.skills, { name: "market-edge", requires: [{ capability: "markets", scope: "read" }] }],
    });

    const granted = grantedToolNames(CATALOGUE, declared);
    expect(granted).toContain("agent-kit__market_edge");
  });

  // TWO CASES, and the second is what makes the first mean something: a catalogue that always
  // dropped this entry would pass "absent for Saga's real definition" too.
  it("the old mount is now a dead sentinel, and the catalogue's own copy is live", async () => {
    const mountTool = (await import("../agent/extensions/agent-kit/tools/market_edge.js")).default;
    expect(isDisabledToolSentinel(mountTool)).toBe(true);

    const catalogueTool = CATALOGUE["agent-kit__market_edge"]!.tool as { execute?: unknown };
    expect(isDisabledToolSentinel(catalogueTool)).toBe(false);
    expect(typeof catalogueTool.execute).toBe("function");
  });
});
