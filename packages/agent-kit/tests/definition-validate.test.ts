import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { definitionSchema, parseDefinition } from "../src/definition.js";
import { assertDefinitionValid, doorSecretName, toolNameCollisions, toolSourcesFor, validateDefinition } from "../src/definition-validate.js";
import { manifestSchema } from "../src/manifest.js";

const ROLE = "I keep the books. I use `gmail_send` when asked.\n";
const TOOLS = ["gmail_send", "gmail_draft"];

const base = (over: Record<string, unknown> = {}) =>
  parseDefinition({
    name: "bookkeeper", display: "Bookkeeper", model: "lares-utility", persona: "agent/instructions.md",
    role: "chief-of-staff",
    grants: [{ capability: "gmail", scope: "write-with-confirm" }, { capability: "read_url", scope: "read" }],
    autonomy: { gmail: "gated", read_url: "gated" },
    ...over,
  });

const opts = (over: Record<string, unknown> = {}) =>
  ({ definition: base(over), roleMd: ROLE, deployedTools: TOOLS, secretExists: () => true });

describe("validateDefinition", () => {
  it("passes a definition that is within its grants", () => {
    expect(validateDefinition(opts())).toEqual([]);
  });

  it("refuses a skill that widens access — the never-widen rule", () => {
    const f = validateDefinition(opts({
      skills: [{ name: "commercial", requires: [{ capability: "twenty", scope: "read" }, { capability: "read_url", scope: "read" }] }],
    }));
    expect(f.map((x) => x.check)).toContain("skills-within-grants");
    expect(f.map((x) => x.message).join(" ")).toMatch(/twenty/);
  });

  it("refuses a model that is not a purpose alias", () => {
    expect(validateDefinition(opts({ model: "claude-opus-5" })).map((x) => x.check)).toContain("model-alias");
    expect(validateDefinition(opts({ model: "anthropic/claude-sonnet-5" })).map((x) => x.check)).toContain("model-alias");
    expect(validateDefinition(opts({ model: "lares-brain" }))).toEqual([]);
    expect(validateDefinition(opts({ model: "lares-gate" }))).toEqual([]);
  });

  it("refuses a role text naming a tool this definition does not hold", () => {
    const f = validateDefinition({ ...opts(), deployedTools: ["gmail_draft"] });
    expect(f.map((x) => x.check)).toContain("role-tools-present");
    expect(f.map((x) => x.message).join(" ")).toMatch(/gmail_send/);
  });

  it("lets a door be SAVED while its setup is pending", () => {
    expect(validateDefinition({
      ...opts({ doors: [{ kind: "telegram", enabled: false }] }),
      secretExists: () => false,
    })).toEqual([]);
  });

  it("refuses a door switched ON before its secret exists", () => {
    const f = validateDefinition({
      ...opts({ doors: [{ kind: "telegram", enabled: true }] }),
      secretExists: () => false,
    });
    expect(f.map((x) => x.check)).toContain("door-secret");
    expect(f.map((x) => x.message).join(" ")).toMatch(/bookkeeper-telegram-token/);
  });

  it("refuses autonomy over a capability with no grant", () => {
    expect(validateDefinition(opts({ autonomy: { gmail: "gated", read_url: "gated", atlas: "autonomous" } }))
      .map((x) => x.check)).toContain("declaration-integrity");
  });

  it("returns EVERY finding, so a save shows them all at once", () => {
    const f = validateDefinition(opts({ model: "gpt-5", autonomy: { gmail: "gated", read_url: "gated", atlas: "never" } }));
    expect(f.length).toBeGreaterThan(1);
  });

  it("assertDefinitionValid throws with every reason joined", () => {
    expect(() => assertDefinitionValid(opts({ model: "gpt-5" }))).toThrow(/model-alias/);
  });

  it("names a door's secret the way the keeper writes it", () => {
    expect(doorSecretName("coordinator", "telegram")).toBe("coordinator-telegram-token");
  });

  // The manifest-view strip must not name the definition-only fields by hand. This pins the set
  // those fields actually are, against the schemas themselves rather than a second hand-written list — a definition-only field added to
  // `definitionSchema.extend({...})` without being added here (or removed from manifestSchema)
  // fails this test, forcing whoever adds it to look at `definition-validate.ts`'s
  // `MANIFEST_KEYS` derivation rather than silently trusting it.
  it("keeps the definition-only fields — the ones stripped before assertDeclarationIntegrity — a known, closed set", () => {
    const manifestKeys = new Set(Object.keys(manifestSchema.shape));
    const extraKeys = Object.keys(definitionSchema.shape).filter((k) => !manifestKeys.has(k));
    expect(new Set(extraKeys)).toEqual(new Set(["gender", "description", "language", "duties", "schedules", "doors", "outsideTools", "delivery"]));
  });

  // A throwing `secretExists` (a real filesystem permission error, say) used to
  // propagate out of `validateDefinition` uncaught — the one check not wrapped in `capture()`.
  // That crashes the save instead of refusing it, which is exactly the outcome this module
  // exists to prevent.
  it("refuses a door check that itself throws, instead of crashing the save", () => {
    const f = validateDefinition({
      ...opts({ doors: [{ kind: "telegram", enabled: true }] }),
      secretExists: () => {
        throw new Error("EACCES: permission denied, stat '/etc/lares/secrets/bookkeeper-telegram-token'");
      },
    });
    expect(f.map((x) => x.check)).toContain("door-secret");
    expect(f.map((x) => x.message).join(" ")).toMatch(/permission denied/);
  });

  // The write-shape check (behind `if (opts.serviceDir)`) needs its own case. `toolNames` (forwarded to `assertNoUngatedWrites`) lets a test drive it
  // without a real service tree on disk: an empty list is the clean pass, and a tool name no
  // capability doc maps is the smallest failing case `lintWriteShape` has — it does not need a
  // real source file, only a name `capabilitiesForTool` does not recognise.
  it("runs the write-shape lint when serviceDir is given, and passes cleanly with no deployed tools", () => {
    expect(validateDefinition({ ...opts(), serviceDir: "/nonexistent-service-dir-for-tests", toolNames: [] })).toEqual([]);
  });

  it("refuses, via the write-shape lint, a deployed tool no capability doc maps", () => {
    const f = validateDefinition({
      ...opts(),
      serviceDir: "/nonexistent-service-dir-for-tests",
      toolNames: ["definitely_not_a_real_tool"],
    });
    expect(f.map((x) => x.check)).toContain("write-shape");
    expect(f.map((x) => x.message).join(" ")).toMatch(/no capability doc lists this tool/);
  });
});

// eve 1.0 keeps the first of two tools with the same name and only writes an error line for the
// other. Here that is an invalid definition, refused on save and at every session start.
describe("one tool per name", () => {
  const AUTHORED = "a tool file of that name (agent/tools/ or the agent-kit mount)";
  const POOL = "the role's tool pool (catalogue/)";
  const named = (f: { check: string; message: string }[]) => f.filter((x) => x.check === "tool-names").map((x) => x.message);

  it("finds nothing when every name has one source", () => {
    expect(toolNameCollisions(["public_doc"], { pool: ["gmail_send"], outside: ["crm__lookup"] })).toEqual([]);
  });

  it("names the tool and both sources: a tool file against a resolved source, and two resolved sources", () => {
    expect(toolNameCollisions(["vault_write"], { pool: ["vault_write", "gmail_send"], outside: ["gmail_send"] })).toEqual([
      { name: "vault_write", sources: [AUTHORED, "pool"] },
      { name: "gmail_send", sources: ["pool", "outside"] },
    ]);
  });

  it("refuses a definition when a tool file and the pool share a name", () => {
    const f = validateDefinition({ ...opts(), toolSources: { authored: ["gmail_send"], catalogue: ["gmail_send", "gmail_draft"] } });
    expect(named(f)).toHaveLength(1);
    expect(named(f)[0]).toContain('"gmail_send"');
    expect(named(f)[0]).toContain(AUTHORED);
    expect(named(f)[0]).toContain(POOL);
    expect(() => assertDefinitionValid({ ...opts(), toolSources: { authored: ["gmail_send"], catalogue: ["gmail_send"] } })).toThrow(/tool-names/);
  });

  it("refuses an outside tool whose name lands on a pool tool, and passes once it is renamed", () => {
    const withOutside = (name: string) => ({
      ...opts({
        grants: [{ capability: "gmail", scope: "write-with-confirm" }, { capability: "read_url", scope: "read" }, { capability: "outside", scope: "write-with-confirm" }],
        autonomy: { gmail: "gated", read_url: "gated", outside: "gated" },
        outsideTools: [{ name, url: "https://tools.example.org/mcp", description: "Notes.", tools: { allow: ["vault_write"], read: [] } }],
      }),
      toolSources: { authored: [], catalogue: ["agent-kit__vault_write"] },
    });
    const f = validateDefinition(withOutside("agent-kit"));
    expect(named(f)).toHaveLength(1);
    expect(named(f)[0]).toContain('"agent-kit__vault_write"');
    expect(named(f)[0]).toContain(POOL);
    expect(named(f)[0]).toContain('the outside tool "agent-kit" in this definition');
    expect(validateDefinition(withOutside("notes"))).toEqual([]);
  });

  it("is skipped when no tool sources are given", () => {
    expect(validateDefinition(opts())).toEqual([]);
  });

  // The folder reader. A role keeps a `disableTool()` stub at a path its pool has taken over;
  // that stub is the one thing that does not count.
  const STUB = 'import { disableTool } from "eve/tools";\n// export default defineTool({}) in a comment changes nothing\nexport default disableTool();\n';
  const LIVE = 'import { defineTool } from "eve/tools";\nexport default defineTool({ description: "x" });\n';
  function role(files: Record<string, string>): { dir: string; kit: string; done: () => void } {
    const root = mkdtempSync(join(tmpdir(), "tool-sources-"));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return { dir: join(root, "role"), kit: join(root, "kit"), done: () => rmSync(root, { recursive: true, force: true }) };
  }

  it("leaves out a disabled stub and counts every other tool file", () => {
    const r = role({
      "role/agent/tools/vault_write.ts": STUB,
      "role/agent/tools/public_doc.ts": LIVE,
      "role/catalogue/vault_write.ts": LIVE,
      "role/catalogue/index.ts": "export const CATALOGUE = {};\n",
    });
    try {
      const sources = toolSourcesFor(r.dir, r.kit);
      expect(sources).toEqual({ authored: ["public_doc"], catalogue: ["vault_write"] });
      expect(toolNameCollisions(sources.authored, { pool: sources.catalogue })).toEqual([]);
    } finally { r.done(); }
  });

  it("counts a tool file that is live again under a name the pool holds", () => {
    const r = role({ "role/agent/tools/vault_write.ts": LIVE, "role/catalogue/vault_write.ts": LIVE });
    try {
      const sources = toolSourcesFor(r.dir, r.kit);
      expect(toolNameCollisions(sources.authored, { pool: sources.catalogue }).map((c) => c.name)).toEqual(["vault_write"]);
    } finally { r.done(); }
  });

  it("counts a tool the mounted extension ships unless the role's mount has a stub for it", () => {
    const r = role({
      "kit/extension/tools/vault_write.ts": LIVE,
      "kit/extension/tools/vault_read.ts": LIVE,
      "kit/extension/tools/vault_list.ts": LIVE,
      "role/agent/extensions/agent-kit/extension.ts": "export default {};\n",
      "role/agent/extensions/agent-kit/tools/vault_write.ts": STUB, // switched off: no name
      "role/agent/extensions/agent-kit/tools/vault_read.ts": LIVE, // overridden and live
      // vault_list has no file in the mount: the extension's own copy is live
      "role/catalogue/agent-kit__vault_write.ts": LIVE,
      "role/catalogue/agent-kit__vault_list.ts": LIVE,
    });
    try {
      const sources = toolSourcesFor(r.dir, r.kit);
      expect(sources.authored).toEqual(["agent-kit__vault_list", "agent-kit__vault_read"]);
      expect(toolNameCollisions(sources.authored, { pool: sources.catalogue }).map((c) => c.name)).toEqual(["agent-kit__vault_list"]);
    } finally { r.done(); }
  });

  it("counts nothing from the extension when the role does not mount it, and nothing from a missing folder", () => {
    const r = role({ "kit/extension/tools/vault_write.ts": LIVE, "role/catalogue/agent-kit__vault_write.ts": LIVE });
    try {
      expect(toolSourcesFor(r.dir, r.kit)).toEqual({ authored: [], catalogue: ["agent-kit__vault_write"] });
      expect(toolSourcesFor(join(r.dir, "absent"), r.kit)).toEqual({ authored: [], catalogue: [] });
    } finally { r.done(); }
  });
});
