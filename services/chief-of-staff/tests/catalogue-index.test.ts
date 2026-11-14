// The catalogue index is GENERATED and then hand-corrected, which is exactly the shape that rots:
// a tool added to catalogue/ with no entry here is a tool no session can ever be given, and it
// fails nowhere else. Both directions are asserted, and every capability is held against the
// fleet's own `capabilityOfTool` rather than against a second list written in this file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { areaOfTool, capabilityOfTool } from "@lares/agent-kit/always-ask";
import { ALWAYS_PRESENT, ALWAYS_PRESENT_CAPABILITY, grantedToolNames } from "@lares/agent-kit/catalogue";
import { parseDefinition } from "@lares/agent-kit/definition";
import { toolSourcesFor, validateDefinition, type ToolSources } from "@lares/agent-kit/definition-validate";
import { deployedToolsFor } from "@lares/agent-kit/persona";
import { roleMdPath } from "../lib/definition.js";
import { CATALOGUE } from "../catalogue/index.js";
import declaration from "../agent.json";

describe("the catalogue index", () => {
  it("names every tool's real capability — a new tool without one fails here", () => {
    // An always-present tool has no capability to name. `capabilityOfTool` returns
    // undefined for it by design, so it is exempt here and carries ALWAYS_PRESENT_CAPABILITY.
    for (const [name, entry] of Object.entries(CATALOGUE)) {
      if (ALWAYS_PRESENT.includes(name)) {
        expect(entry.capability, name).toBe(ALWAYS_PRESENT_CAPABILITY);
        continue;
      }
      expect(entry.capability, name).toBe(capabilityOfTool(name));
    }
  });

  // The second narrowing `vault` needs. `capabilityOfTool` above no longer separates
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

  it("never carries commercial_who_to_contact — it is skill-gated, not capability-gated", () => {
    // resolveSkillTool (agent/tools/commercial_who_to_contact.ts) checks a SKILL declaration, not a capability
    // grant. grantedToolNames only ever asks a capability's grant, so putting this tool in the
    // pool would silently swap what gates it. See this file's own header, catalogue/index.ts's.
    expect(CATALOGUE["commercial_who_to_contact"]).toBeUndefined();
  });
});

/** The areas this role's committed `agent.json` grants, and the vault tools it was
 *  offered before one `vault` grant replaced the separate area grants — literals, not recomputed. */
const GRANTED_AREAS: readonly string[] = ["private", "shared", "facts"];
const VAULT_TOOLS_EXPECTED = ["agent-kit__vault_backlinks", "agent-kit__vault_drop", "agent-kit__vault_file", "agent-kit__vault_list", "agent-kit__vault_read", "agent-kit__vault_search", "agent-kit__vault_write", "atlas_proposals", "atlas_resolve_proposal", "facts_list", "forget", "memory_proposals", "memory_resolve_proposal", "memory_used", "remember", "save_note", "track_add_item", "track_create", "track_items", "track_move_item", "track_set_steps", "tracks_list"];

// THE CLAIM, FOR THIS ROLE: one capability doc and one grant replaced
// three, and NOBODY'S TOOL LIST CHANGED. Asserted against the committed declaration and the real
// pool, as a literal set — not recomputed from the code
// this test is watching.
describe("the vault tools this role is offered", () => {
  const offered = grantedToolNames(CATALOGUE, parseDefinition(declaration));
  const vaultTools = offered.filter((n) => CATALOGUE[n]!.capability === "vault");

  it("is exactly the set it was offered under brain/atlas/memory", () => {
    expect(vaultTools).toEqual(VAULT_TOOLS_EXPECTED);
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

  // eve keeps the first of two tools with the same name and only writes an error line for the
  // other. For a role that is an invalid definition: refused on save, and at session start.
  it("gives every tool name one source today, and refuses a duplicate", () => {
    const serviceDir = join(import.meta.dirname, "..");
    const roleMd = readFileSync(roleMdPath(serviceDir), "utf8");
    const deployedTools = deployedToolsFor(serviceDir);
    const refusals = (toolSources: ToolSources) =>
      validateDefinition({ definition: parseDefinition(declaration), roleMd, deployedTools, toolSources }).filter((f) => f.check === "tool-names");

    const real = toolSourcesFor(serviceDir);
    // The folder view is the real pool, and every agent-kit mount file is a disabled stub.
    expect(real.catalogue).toEqual(Object.keys(CATALOGUE).sort());
    expect(real.authored.filter((n) => n.startsWith("agent-kit__"))).toEqual([]);
    expect(refusals(real)).toEqual([]);

    // The mount's stub for a tool the pool has taken over, live again.
    const duplicate = refusals({ ...real, authored: [...real.authored, "agent-kit__vault_write"] });
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]!.message).toContain('"agent-kit__vault_write"');
    expect(duplicate[0]!.message).toContain("a tool file of that name");
    expect(duplicate[0]!.message).toContain("the role's tool pool (catalogue/)");

    // An outside tool the owner connects under a name that lands on a pool tool.
    const outside = parseDefinition({
      ...declaration,
      grants: [...declaration.grants, { capability: "outside", scope: "write-with-confirm" }],
      autonomy: { ...declaration.autonomy, outside: "gated" },
      outsideTools: [{ name: "agent-kit", url: "https://tools.example.org/mcp", description: "Notes.", tools: { allow: ["vault_write"], read: [] } }],
    });
    const viaOutside = validateDefinition({ definition: outside, roleMd, deployedTools, toolSources: real }).filter((f) => f.check === "tool-names");
    expect(viaOutside).toHaveLength(1);
    expect(viaOutside[0]!.message).toContain('"agent-kit__vault_write"');
    expect(viaOutside[0]!.message).toContain('the outside tool "agent-kit" in this definition');
  });
});
