import { describe, expect, it } from "vitest";
import { definitionSchema, parseDefinition } from "../src/definition.js";
import { assertDefinitionValid, doorSecretName, validateDefinition } from "../src/definition-validate.js";
import { manifestSchema } from "../src/manifest.js";

const ROLE = "I keep the books. I use `gmail_send` when asked.\n";
const TOOLS = ["gmail_send", "gmail_draft"];

const base = (over: Record<string, unknown> = {}) =>
  parseDefinition({
    name: "bookkeeper", display: "Bookkeeper", model: "heiberg-utility", persona: "agent/instructions.md",
    role: "chief-of-staff",
    grants: [{ capability: "gmail", scope: "write-with-confirm" }, { capability: "orakel", scope: "read" }],
    autonomy: { gmail: "gated", orakel: "gated" },
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
      skills: [{ name: "commercial", requires: [{ capability: "twenty", scope: "read" }, { capability: "orakel", scope: "read" }] }],
    }));
    expect(f.map((x) => x.check)).toContain("skills-within-grants");
    expect(f.map((x) => x.message).join(" ")).toMatch(/twenty/);
  });

  it("refuses a model that is not a purpose alias", () => {
    expect(validateDefinition(opts({ model: "claude-opus-5" })).map((x) => x.check)).toContain("model-alias");
    expect(validateDefinition(opts({ model: "anthropic/claude-sonnet-5" })).map((x) => x.check)).toContain("model-alias");
    expect(validateDefinition(opts({ model: "lares-brain" }))).toEqual([]);
    expect(validateDefinition(opts({ model: "heiberg-gate" }))).toEqual([]);
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
    expect(validateDefinition(opts({ autonomy: { gmail: "gated", orakel: "gated", atlas: "autonomous" } }))
      .map((x) => x.check)).toContain("declaration-integrity");
  });

  it("returns EVERY finding, so a save shows them all at once", () => {
    const f = validateDefinition(opts({ model: "gpt-5", autonomy: { gmail: "gated", orakel: "gated", atlas: "never" } }));
    expect(f.length).toBeGreaterThan(1);
  });

  it("assertDefinitionValid throws with every reason joined", () => {
    expect(() => assertDefinitionValid(opts({ model: "gpt-5" }))).toThrow(/model-alias/);
  });

  it("names a door's secret the way the keeper writes it", () => {
    expect(doorSecretName("saga", "telegram")).toBe("saga-telegram-token");
  });

  // Review fix (2026-09-16, Task 3 "needs fixes"): the manifest-view strip used to name the six
  // definition-only fields by hand. This pins the set those fields actually are, against the
  // schemas themselves rather than a second hand-written list — a definition-only field added to
  // `definitionSchema.extend({...})` without being added here (or removed from manifestSchema)
  // fails this test, forcing whoever adds it to look at `definition-validate.ts`'s
  // `MANIFEST_KEYS` derivation rather than silently trusting it.
  it("keeps the definition-only fields — the ones stripped before assertDeclarationIntegrity — a known, closed set", () => {
    const manifestKeys = new Set(Object.keys(manifestSchema.shape));
    const extraKeys = Object.keys(definitionSchema.shape).filter((k) => !manifestKeys.has(k));
    expect(new Set(extraKeys)).toEqual(new Set(["gender", "description", "language", "duties", "schedules", "doors"]));
  });

  // Review fix: a throwing `secretExists` (a real filesystem permission error, say) used to
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

  // Review fix: the write-shape check (behind `if (opts.serviceDir)`) was never exercised by any
  // test in this file. `toolNames` (forwarded to `assertNoUngatedWrites`) lets a test drive it
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
