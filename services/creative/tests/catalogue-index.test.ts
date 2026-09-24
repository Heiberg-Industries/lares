// The catalogue index is GENERATED and then hand-corrected, which is exactly the shape that rots:
// a tool added to catalogue/ with no entry here is a tool no session can ever be given, and it
// fails nowhere else. Both directions are asserted, and every capability is held against the
// fleet's own `capabilityOfTool` rather than against a second list written in this file.
import { describe, expect, it } from "vitest";
import { areaOfTool, capabilityOfTool } from "@lares/agent-kit/always-ask";
import { ALWAYS_PRESENT, ALWAYS_PRESENT_CAPABILITY, grantedToolNames } from "@lares/agent-kit/catalogue";
import { parseDefinition } from "@lares/agent-kit/definition";
import { CATALOGUE } from "../catalogue/index.js";
import declaration from "../agent.json";

describe("the catalogue index", () => {
  it("names every tool's real capability — a new tool without one fails here", () => {
    // Ruling R2: an always-present tool has no capability to name. `capabilityOfTool` returns
    // undefined for it by design, so it is exempt here and carries ALWAYS_PRESENT_CAPABILITY.
    for (const [name, entry] of Object.entries(CATALOGUE)) {
      if (ALWAYS_PRESENT.includes(name)) {
        expect(entry.capability, name).toBe(ALWAYS_PRESENT_CAPABILITY);
        continue;
      }
      expect(entry.capability, name).toBe(capabilityOfTool(name));
    }
  });

  // W5C-s5/s6 — the second narrowing `vault` needs. `capabilityOfTool` above no longer separates
  // the personal store from the shared one from the standing facts: all three answer `vault`.
  // `areaOfTool` is what does, and it is what `grantedToolNames` refuses a tool on, so it gets
  // the same both-directions check the capability does.
  it("every vault entry declares no area the engine does not already know", () => {
    for (const [name, entry] of Object.entries(CATALOGUE)) {
      if (entry.capability !== "vault") {
        expect(entry.area, name).toBeUndefined();
        continue;
      }
      expect(areaOfTool(name), `${name} has no area in the engine's table`).toBeDefined();
      if (entry.area !== undefined) expect(entry.area, name).toBe(areaOfTool(name));
    }
  });

  it("holds every file in catalogue/ and nothing else", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(new URL("../catalogue", import.meta.url))
      .filter((f) => f.endsWith(".ts") && f !== "index.ts").map((f) => f.replace(/\.ts$/, ""));
    expect(Object.keys(CATALOGUE).sort()).toEqual(files.sort());
  });

  it("every entry is a real eve tool — description, input schema and an executor", () => {
    // `CatalogueEntry.tool` is the kit's structural `ResolvableTool` (description + approval), so
    // the type system cannot see the two fields the resolver actually reads off it
    // (agent/tools/catalogue.ts). An entry missing either would compile, resolve, and hand the
    // model a tool it cannot call.
    for (const [name, entry] of Object.entries(CATALOGUE)) {
      const tool = entry.tool as { description?: unknown; inputSchema?: unknown; execute?: unknown };
      expect(typeof tool.description, `${name}.description`).toBe("string");
      expect(tool.inputSchema, `${name}.inputSchema`).toBeDefined();
      expect(typeof tool.execute, `${name}.execute`).toBe("function");
    }
  });
});

/** The areas this role's committed `agent.json` grants, and the vault tools it was
 *  offered the day before the merge — literals, read out of the tree at W5C-s4. */
const GRANTED_AREAS: readonly string[] = ["shared"];
const VAULT_TOOLS_BEFORE = ["vault_list", "vault_read", "vault_search", "vault_write"];

// THE COMMIT'S WHOLE CLAIM, FOR THIS ROLE (W5C-s5/s6): one capability doc and one grant replaced
// three, and NOBODY'S TOOL LIST CHANGED. Asserted against the committed declaration and the real
// pool, as a literal set read out of the tree before the merge — not recomputed from the code
// this test is watching.
describe("the vault tools this role is offered", () => {
  const offered = grantedToolNames(CATALOGUE, parseDefinition(declaration));
  const vaultTools = offered.filter((n) => CATALOGUE[n]!.capability === "vault");

  it("is exactly the set it was offered under brain/atlas/memory", () => {
    expect(vaultTools).toEqual(VAULT_TOOLS_BEFORE);
  });

  it("is offered nothing outside the areas its grant names", () => {
    for (const name of vaultTools) expect(GRANTED_AREAS, name).toContain(areaOfTool(name));
  });

  it("is offered no tool of an area its grant withholds", () => {
    const withheld = Object.keys(CATALOGUE)
      .filter((n) => CATALOGUE[n]!.capability === "vault")
      .filter((n) => !GRANTED_AREAS.includes(areaOfTool(n) ?? ""));
    for (const name of withheld) expect(vaultTools, name).not.toContain(name);
  });
});
