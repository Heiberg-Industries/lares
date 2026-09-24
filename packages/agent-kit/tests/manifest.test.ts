import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import { defineTool, isDisabledToolSentinel } from "eve/tools";
import { always, type Approval, type ApprovalPolicy } from "eve/tools/approval";
import { z } from "zod";

import { clearBoardCache, setBoardDeps } from "../src/board-approval.js";
import {
  KNOWN_CAPABILITIES,
  assertClassMatchesScope,
  assertDeclarationIntegrity,
  assertSkillsWithinGrants,
  autonomyOf,
  grantFor,
  isGranted,
  loadManifest,
  manifestSchema,
  parseManifest,
  resolveExtensionTool,
} from "../src/manifest.js";
import { docFor } from "../src/persona/capability-docs.js";

/**
 * The agent-declaration module (ORB-144 Task 1).
 *
 * The manifest format is PORTED from `services/agent-runtime/lib/adapters/loader.ts`
 * (`manifestSchema`, loader.ts:7-19); the autonomy semantics are ported from
 * `services/agent-runtime/lib/governance/decide.ts` (`decideAction`, decide.ts:17-43) and
 * `governance/ratchet.ts` (`AutonomyLevel`, ratchet.ts:3; the "gated" safe baseline,
 * ratchet.ts:25).
 *
 * The load-bearing case is the last one in the "autonomy only bites on the confirm class"
 * block: a `read` grant carrying `autonomy: gated` must come back UNGATED. That is the
 * deployed reality for orakel on Bendik's daily driver — its three tools carry no
 * `approval` — and reading `autonomy: gated` as "gate everything" would put a thumbs-up in
 * front of a read-only company search.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A read tool: no `approval`, exactly like the three `agent-kit__orakel_*` tools. */
function makeReadTool() {
  return defineTool({
    description: "ORB-144 fixture: a read-only lookup that carries no approval gate.",
    inputSchema: z.object({ query: z.string() }),
    async execute({ query }: { query: string }) {
      return { echoed: query };
    },
  });
}

/** A gated-write tool: carries `always()`, exactly like the three `agent-kit__vault_*` writes. */
function makeConfirmTool() {
  return defineTool({
    description: "ORB-144 fixture: a mutating write that carries an always() approval gate.",
    inputSchema: z.object({ body: z.string() }),
    approval: always(),
    async execute({ body }: { body: string }) {
      return { wrote: body };
    },
  });
}

/** A READ tool living under a WRITE-WITH-CONFIRM capability: no `approval`, shaped like the
 *  four real `vault_*` tools (`readTool` bound to the private area and friends, `src/note-tools.ts`), which are
 *  contributed under the same `vault` capability as the three gated vault writes. Its
 *  existence is why `assertClassMatchesScope` runs in one direction only. */
function makeVaultReadTool() {
  return defineTool({
    description: "ORB-144 fixture: read one note from the Brain vault by its store-relative path.",
    inputSchema: z.object({ path: z.string() }),
    async execute({ path }: { path: string }) {
      return { read: path };
    },
  });
}

/** Minimal ApprovalContext stand-in — the helpers from `eve/tools/approval` read nothing
 *  but `approvedTools`/`toolName`, and `never()` reads neither. */
function approvalCtx(toolName = "agent-kit__fixture") {
  return { approvedTools: new Set<string>(), callId: "c1", toolName } as never;
}

/** A tool's `approval` is no longer necessarily callable. Since eve 0.60.x it is
 *  `Approval<T> = ApprovalPolicy<T> | ApprovalConfiguration<T>`, and the configuration shape
 *  carries the request-time policy on `.request`
 *  (`node_modules/eve/dist/src/approval/definition.d.ts`). eve's own accessor for this is
 *  `resolveApprovalPolicy` — `typeof e === "function" ? e : e.request`,
 *  `node_modules/eve/dist/src/approval/definition.js` — but it is not re-exported from any
 *  public `eve/*` subpath, so the same two-line narrowing lives here. Undefined stays
 *  undefined, so the call sites below keep their original optional-call semantics. */
function approvalPolicy<TInput>(approval: Approval<TInput> | undefined): ApprovalPolicy<TInput> | undefined {
  if (approval === undefined || typeof approval === "function") return approval;
  return approval.request;
}

const VALID = {
  name: "saga",
  model: "claude-opus-4-8",
  // ORB-210 item 5: was "../agent-runtime/agents/saga/persona.md", a path abandoned when Phase 3
  // moved every agent to an assembled `agent/instructions.md`. Nothing reads this string (the
  // schema only requires it to be a non-empty string), so it was pure documentation — and it
  // documented a layout that no longer exists. This is what the three live agent.json files say.
  persona: "agent/instructions.md",
  channels: ["slack", "telegram", "email"],
  egress: { sealed: true },
  grants: [
    { capability: "orakel", scope: "read" },
    { capability: "vault", scope: "write-with-confirm" },
  ],
  autonomy: { orakel: "gated", vault: "gated" },
} as const;

function manifestWith(over: Record<string, unknown>) {
  return { ...structuredClone(VALID as unknown as Record<string, unknown>), ...over };
}

// ---------------------------------------------------------------------------
// Schema — ported, not invented
// ---------------------------------------------------------------------------

describe("manifestSchema / parseManifest", () => {
  it("parses a valid manifest and round-trips every field", () => {
    const m = parseManifest(VALID);
    expect(m.name).toBe("saga");
    expect(m.model).toBe("claude-opus-4-8");
    expect(m.persona).toBe("agent/instructions.md");
    expect(m.channels).toEqual(["slack", "telegram", "email"]);
    expect(m.egress).toEqual({ sealed: true });
    expect(m.grants).toEqual([
      { capability: "orakel", scope: "read" },
      { capability: "vault", scope: "write-with-confirm" },
    ]);
    expect(m.autonomy).toEqual({ orakel: "gated", vault: "gated" });
  });

  it("round-trips the optional role, and leaves it undefined when unset (ORB-145 Phase 3)", () => {
    // `role` names the shared template under packages/agent-kit/templates/ that an agent's
    // assembled instructions are built from. Optional on purpose: an agent that has not been
    // moved onto a template yet is still a valid declaration, and a strictObject schema would
    // otherwise reject the field outright the moment one is added.
    expect(parseManifest(manifestWith({ role: "chief-of-staff" })).role).toBe("chief-of-staff");
    expect(parseManifest(VALID).role).toBeUndefined();
  });

  it("round-trips framework_tools, defaults it empty, and rejects a name eve does not have", () => {
    // eve's own built-ins are not capabilities and not grants — `agent.json` does not govern
    // them. The field exists so the generated environment section can say truthfully whether
    // the agent can search the web (ORB-145 Phase 3); the enum is closed so a typo fails here
    // rather than silently restoring the false "I cannot search the web".
    expect(parseManifest(manifestWith({ framework_tools: ["web_search"] })).framework_tools).toEqual(["web_search"]);
    expect(parseManifest(VALID).framework_tools).toEqual([]);
    expect(() => parseManifest(manifestWith({ framework_tools: ["web_serch"] }))).toThrow(/framework_tools/);
  });

  it("applies loader.ts's defaults for the optional fields", () => {
    const m = parseManifest({ name: "x", model: "m", persona: "p.md" });
    expect(m.channels).toEqual([]);
    expect(m.framework_tools).toEqual([]);
    expect(m.grants).toEqual([]);
    expect(m.autonomy).toEqual({});
    expect(m.egress).toEqual({ sealed: false });
  });

  it("accepts all four scopes from loader.ts:7", () => {
    for (const scope of ["none", "read", "write", "write-with-confirm"]) {
      const m = parseManifest(manifestWith({ grants: [{ capability: "vault", scope }], autonomy: {} }));
      expect(m.grants[0]?.scope).toBe(scope);
    }
  });

  it("accepts all three autonomy levels from ratchet.ts:3 — the widened enum", () => {
    for (const level of ["never", "gated", "autonomous"]) {
      const m = parseManifest(manifestWith({ autonomy: { orakel: level, vault: level } }));
      expect(m.autonomy["orakel"]).toBe(level);
    }
  });

  it("rejects an unknown scope, naming the bad field", () => {
    expect(() =>
      parseManifest(manifestWith({ grants: [{ capability: "vault", scope: "write-ish" }], autonomy: {} })),
    ).toThrow(/grants\.0\.scope/);
  });

  it("rejects a missing model, naming the bad field", () => {
    const { model: _drop, ...withoutModel } = structuredClone(VALID as unknown as Record<string, unknown>);
    expect(() => parseManifest(withoutModel)).toThrow(/model/);
  });

  it("rejects an empty persona and an empty name", () => {
    expect(() => parseManifest(manifestWith({ persona: "" }))).toThrow(/persona/);
    expect(() => parseManifest(manifestWith({ name: "" }))).toThrow(/name/);
  });

  it("rejects an unknown autonomy level", () => {
    expect(() => parseManifest(manifestWith({ autonomy: { orakel: "sometimes" } }))).toThrow(
      /autonomy\.orakel/,
    );
  });

  it("exposes the schema itself so tooling can reuse it", () => {
    expect(manifestSchema.safeParse(VALID).success).toBe(true);
  });

  // The schema is STRICT where loader.ts was not. Without this, misspelling "grants" leaves
  // `grants` at its `[]` default, every resolveExtensionTool returns disableTool(), and Saga
  // boots with its ten extension tools silently gone.
  it("rejects a misspelled top-level key rather than silently dropping every grant", () => {
    const { grants, ...rest } = structuredClone(VALID as unknown as Record<string, unknown>);
    expect(() => parseManifest({ ...rest, grant: grants, autonomy: {} })).toThrow(/grant/);
  });

  it("rejects any unrecognised top-level key", () => {
    expect(() => parseManifest(manifestWith({ personas: "typo.md" }))).toThrow(/personas/);
  });

  it("rejects an unrecognised key inside a grant", () => {
    expect(() =>
      parseManifest(manifestWith({ grants: [{ capability: "vault", scope: "read", note: "why" }], autonomy: {} })),
    ).toThrow(/note/);
  });

  it("rejects a misspelled egress key rather than quietly unsealing the agent", () => {
    expect(() => parseManifest(manifestWith({ egress: { seald: true } }))).toThrow(/seald/);
  });

  it("carries the agent scope — personal or org, defaulting personal (multi-user substrate)", () => {
    const base = { name: "x", model: "m", persona: "p.md" };
    expect(manifestSchema.parse(base).scope).toBe("personal");
    expect(manifestSchema.parse({ ...base, scope: "org" }).scope).toBe("org");
    expect(() => manifestSchema.parse({ ...base, scope: "shared" })).toThrow();
  });
});

describe("loadManifest", () => {
  it("reads and parses a manifest file", () => {
    const dir = mkdtempSync(join(tmpdir(), "orb144-"));
    try {
      const path = join(dir, "agent.json");
      writeFileSync(path, JSON.stringify(VALID), "utf8");
      expect(loadManifest(path).name).toBe("saga");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the file when it is missing", () => {
    const path = join(tmpdir(), "orb144-does-not-exist", "agent.json");
    expect(() => loadManifest(path)).toThrow(/orb144-does-not-exist/);
  });

  it("names the file and the bad field when the contents are invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "orb144-"));
    try {
      const path = join(dir, "agent.json");
      writeFileSync(path, JSON.stringify(manifestWith({ model: "" })), "utf8");
      expect(() => loadManifest(path)).toThrow(/agent\.json/);
      expect(() => loadManifest(path)).toThrow(/model/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

describe("grantFor / autonomyOf / isGranted", () => {
  const m = parseManifest(VALID);

  it("finds a declared grant and returns undefined for an undeclared one", () => {
    expect(grantFor(m, "orakel")).toEqual({ capability: "orakel", scope: "read" });
    expect(grantFor(m, "twenty")).toBeUndefined();
  });

  it("defaults an undeclared capability's autonomy to ratchet.ts's safe baseline 'gated'", () => {
    expect(autonomyOf(m, "orakel")).toBe("gated");
    expect(autonomyOf(m, "twenty")).toBe("gated");
    expect(autonomyOf(parseManifest(manifestWith({ autonomy: { orakel: "autonomous" } })), "orakel")).toBe(
      "autonomous",
    );
  });

  it("treats a scope of 'none' as ungranted", () => {
    expect(isGranted(m, "orakel")).toBe(true);
    expect(isGranted(m, "twenty")).toBe(false);
    const none = parseManifest(manifestWith({ grants: [{ capability: "orakel", scope: "none" }], autonomy: {} }));
    expect(isGranted(none, "orakel")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveExtensionTool — the seam the override files use
// ---------------------------------------------------------------------------

describe("resolveExtensionTool — disable paths", () => {
  it("disables a tool whose capability is not granted at all (Marcel's ten)", () => {
    const resolved = resolveExtensionTool(manifestWith({ grants: [], autonomy: {} }), "orakel", makeReadTool());
    expect(isDisabledToolSentinel(resolved)).toBe(true);
  });

  it("disables a tool whose grant scope is 'none'", () => {
    const m = manifestWith({ grants: [{ capability: "orakel", scope: "none" }], autonomy: {} });
    expect(isDisabledToolSentinel(resolveExtensionTool(m, "orakel", makeReadTool()))).toBe(true);
  });

  it("disables a granted READ tool when autonomy is 'never' — the hard deny of decide.ts:31", () => {
    const m = manifestWith({
      grants: [{ capability: "orakel", scope: "read" }],
      autonomy: { orakel: "never" },
    });
    expect(isDisabledToolSentinel(resolveExtensionTool(m, "orakel", makeReadTool()))).toBe(true);
  });

  it("disables a granted WRITE-WITH-CONFIRM tool when autonomy is 'never'", () => {
    const m = manifestWith({
      grants: [{ capability: "vault", scope: "write-with-confirm" }],
      autonomy: { vault: "never" },
    });
    expect(isDisabledToolSentinel(resolveExtensionTool(m, "vault", makeConfirmTool()))).toBe(true);
  });
});

describe("resolveExtensionTool — autonomy only bites on the confirm class", () => {
  it("returns a granted write-with-confirm + gated tool wrapped with the board's check", async () => {
    setBoardDeps({ explicitLevel: async () => null, record: async () => {}, now: () => 0 });
    const tool = makeConfirmTool();
    const m = manifestWith({
      grants: [{ capability: "vault", scope: "write-with-confirm" }],
      autonomy: { vault: "gated" },
    });
    const resolved = resolveExtensionTool(m, "vault", tool, "vault_write");
    expect(isDisabledToolSentinel(resolved)).toBe(false);
    const toolWithApproval = resolved as unknown as { approval?: (ctx?: { toolInput?: unknown }) => Promise<unknown> };
    expect(typeof toolWithApproval.approval).toBe("function");
    expect(await toolWithApproval.approval?.()).toBe("user-approval"); // gated → ask
    clearBoardCache();
    setBoardDeps(null);
  });

  it("returns a granted read tool with no approval UNCHANGED even under autonomy 'gated' — the orakel case", async () => {
    const tool = makeReadTool();
    const m = manifestWith({
      grants: [{ capability: "orakel", scope: "read" }],
      autonomy: { orakel: "gated" },
    });
    const resolved = resolveExtensionTool(m, "orakel", tool);
    expect(resolved).toBe(tool);
    expect((resolved as typeof tool).approval).toBeUndefined();
    expect(await (resolved as typeof tool).execute({ query: "hi" }, approvalCtx())).toEqual({ echoed: "hi" });
  });

  it("returns a granted read tool unchanged when autonomy is absent entirely (defaults to gated)", () => {
    const tool = makeReadTool();
    const m = manifestWith({ grants: [{ capability: "orakel", scope: "read" }], autonomy: {} });
    expect(resolveExtensionTool(m, "orakel", tool)).toBe(tool);
  });

  it("returns an ungated tool under a write-with-confirm grant UNCHANGED — the real vault_read case", async () => {
    const tool = makeVaultReadTool();
    const m = manifestWith({
      grants: [{ capability: "vault", scope: "write-with-confirm" }],
      autonomy: { vault: "gated" },
    });
    const resolved = resolveExtensionTool(m, "vault", tool);
    expect(isDisabledToolSentinel(resolved)).toBe(false);
    expect(resolved).toBe(tool);
    expect((resolved as typeof tool).approval).toBeUndefined();
    expect(await (resolved as typeof tool).execute({ path: "ventures/soma.md" }, approvalCtx())).toEqual({
      read: "ventures/soma.md",
    });
  });

  it("leaves an ungated tool under a write-with-confirm + autonomous grant alone — no gate to strip", () => {
    const tool = makeVaultReadTool();
    const m = manifestWith({
      grants: [{ capability: "vault", scope: "write-with-confirm" }],
      autonomy: { vault: "autonomous" },
    });
    expect(resolveExtensionTool(m, "vault", tool)).toBe(tool);
  });

  it("wraps a granted write-with-confirm + autonomous tool with the board's check, leaving it WORKING", async () => {
    setBoardDeps({ explicitLevel: async () => null, record: async () => {}, now: () => 0 });
    const tool = makeConfirmTool();
    const m = manifestWith({
      grants: [{ capability: "vault", scope: "write-with-confirm" }],
      autonomy: { vault: "autonomous" },
    });
    const resolved = resolveExtensionTool(m, "vault", tool, "vault_write") as typeof tool;

    expect(isDisabledToolSentinel(resolved)).toBe(false);
    expect(resolved).not.toBe(tool);
    // The approval is now wrapped with boardApproval: with board deps injected and the
    // manifest level as autonomous, it answers "not-applicable" instead of the original
    // "user-approval".
    expect(await approvalPolicy(resolved.approval)?.(approvalCtx())).toBe("not-applicable");
    // ...and the original is untouched (defineTool mutates its argument, so the spread
    // must be a fresh object).
    expect(await approvalPolicy(tool.approval)?.(approvalCtx())).toBe("user-approval");

    // ⛔ The brief's stop-and-report condition: `defineTool({ ...tool, approval: boardApproval(...) })`
    // must produce a WORKING tool. Description, schema, execute, and both of eve's stamps
    // survive the spread.
    expect(resolved.description).toBe(tool.description);
    expect(resolved.inputSchema).toBe(tool.inputSchema);
    expect(await resolved.execute({ body: "note" }, approvalCtx())).toEqual({ wrote: "note" });
    expect(Reflect.get(resolved, Symbol.for("eve:tool-brand"))).toBe(true);
    expect(Reflect.get(resolved, Symbol.for("eve.definition-source-key"))).toBe(
      Reflect.get(tool, Symbol.for("eve.definition-source-key")),
    );
    clearBoardCache();
    setBoardDeps(null);
  });

  it("a 'never' level still removes the tool at build", () => {
    const off = { ...VALID, grants: [{ capability: "vault", scope: "write-with-confirm" }], autonomy: { vault: "never" } };
    expect(isDisabledToolSentinel(resolveExtensionTool(off, "vault", { description: "x", approval: () => "user-approval" }, "vault_write"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assertClassMatchesScope — the declaration is not decorative
// ---------------------------------------------------------------------------

describe("assertClassMatchesScope", () => {
  it("throws when a tool carrying an approval is granted under 'read'", () => {
    expect(() => assertClassMatchesScope(makeConfirmTool(), { capability: "vault", scope: "read" })).toThrow(
      /vault/,
    );
    expect(() => assertClassMatchesScope(makeConfirmTool(), { capability: "vault", scope: "read" })).toThrow(
      /approval/,
    );
  });

  it("throws when a tool carrying an approval is granted under plain 'write'", () => {
    expect(() => assertClassMatchesScope(makeConfirmTool(), { capability: "vault", scope: "write" })).toThrow(
      /vault/,
    );
  });

  it("does NOT throw when a 'write-with-confirm' grant covers a tool with no approval — the vault_read case", () => {
    // A capability spans both action classes: lib/capabilities.ts:33-34 returns `allow` for a
    // non-write action under a write-with-confirm capability. `vault` is write-with-confirm and
    // contributes four ungated `vault_*` reads alongside three gated vault writes. Asserting
    // the reverse direction per-tool would kill eve-saga's build on vault_read.
    expect(() =>
      assertClassMatchesScope(makeVaultReadTool(), { capability: "vault", scope: "write-with-confirm" }),
    ).not.toThrow();
  });

  it("passes on the three shapes deployed today", () => {
    expect(() => assertClassMatchesScope(makeReadTool(), { capability: "orakel", scope: "read" })).not.toThrow();
    expect(() =>
      assertClassMatchesScope(makeConfirmTool(), { capability: "vault", scope: "write-with-confirm" }),
    ).not.toThrow();
    expect(() =>
      assertClassMatchesScope(makeVaultReadTool(), { capability: "vault", scope: "write-with-confirm" }),
    ).not.toThrow();
  });

  it("is enforced by resolveExtensionTool, so a mismatch fails the build rather than shipping", () => {
    const m = manifestWith({ grants: [{ capability: "vault", scope: "read" }], autonomy: {} });
    expect(() => resolveExtensionTool(m, "vault", makeConfirmTool())).toThrow(/vault/);
  });

  it("is NOT reached for an ungranted or 'never' capability — Marcel's disables need no scope truth", () => {
    const ungranted = manifestWith({ grants: [], autonomy: {} });
    expect(isDisabledToolSentinel(resolveExtensionTool(ungranted, "vault", makeConfirmTool()))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// KNOWN_CAPABILITIES + assertDeclarationIntegrity
// ---------------------------------------------------------------------------

describe("KNOWN_CAPABILITIES", () => {
  it("carries every capability the old runtime's hands registered", () => {
    for (const name of [
      "calendar", "digest", "gmail", "identity", "network",
      "notion", "obligation", "orakel", "person", "read_url", "remind",
      "studio", "twenty",
    ]) {
      expect(KNOWN_CAPABILITIES).toContain(name);
    }
    // The old runtime's `brain` and `atlas` hands are carried forward too, but under ONE name
    // and as two AREAS of it (ADR-0017 rule 1, W5C-s5/s6) — see the `vault` block below.
    expect(KNOWN_CAPABILITIES).toContain("vault");
  });

  it("carries `markets` — Tyche's engine folded in as an adapter capability (ORB-189)", () => {
    // The old runtime's `probability` hand is NOT carried forward under its old name; `markets`
    // is its successor, and it is a CAPABILITY (two external venues = a new thing to touch)
    // rather than a skill. `market-edge` is the skill that composes it.
    expect(KNOWN_CAPABILITIES).toContain("markets");
    expect(KNOWN_CAPABILITIES).not.toContain("probability");
    expect(KNOWN_CAPABILITIES).not.toContain("tyche");
  });

  it("carries the three Saga tools the old declaration missed (Ruling 3)", () => {
    expect(KNOWN_CAPABILITIES).toContain("echo");
    expect(KNOWN_CAPABILITIES).toContain("outreach");
    expect(KNOWN_CAPABILITIES).toContain("voice");
  });

  it("carries Marcel's nine domains (Task 3)", () => {
    // `calendar` is shared with Saga and already asserted above — Marcel's eight NEW names
    // plus that one make up the nine capabilities services/travel/agent.json declares.
    for (const name of ["travel", "places", "strava", "shopping", "vault", "persona", "currency", "admin"]) {
      expect(KNOWN_CAPABILITIES).toContain(name);
    }
    expect(KNOWN_CAPABILITIES).toContain("calendar");
  });

  it("keeps standing facts one name — and that name is now an AREA, not a capability", () => {
    // ORB-183 collapsed `facts` into `memory`, one name fleet-wide; ADR-0017 rule 1 finished the
    // job in the other direction. `memory` is gone as a capability too: what an agent has been
    // told is the `facts` AREA of the one `vault` capability, which is what lets a trip agent
    // hold standing facts without being handed a note store (owner decision C1).
    expect(KNOWN_CAPABILITIES).toContain("vault");
    for (const gone of ["brain", "atlas", "memory", "facts"]) {
      expect(KNOWN_CAPABILITIES, gone).not.toContain(gone);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(KNOWN_CAPABILITIES).size).toBe(KNOWN_CAPABILITIES.length);
  });
});

// ADR-0017 (the Vault, one name). W5C-s1 added `vault` beside `brain`, `atlas` and `memory`;
// W5C-s5/s6 merged the three into it and took their names out of KNOWN_CAPABILITIES.
describe("vault (ADR-0017)", () => {
  it("knows vault, and still refuses a capability nobody declared", () => {
    expect(KNOWN_CAPABILITIES).toContain("vault");
    expect(() =>
      assertDeclarationIntegrity(manifestWith({ grants: [{ capability: "vaults", scope: "read" }], autonomy: {} })),
    ).toThrow(/not in KNOWN_CAPABILITIES/);
  });

  it("takes areas on a vault grant and refuses them anywhere else", () => {
    const m = parseManifest(
      manifestWith({ grants: [{ capability: "vault", scope: "read", areas: ["private", "facts"] }], autonomy: { vault: "gated" } }),
    );
    expect(grantFor(m, "vault", "private")).toBeDefined();
    expect(grantFor(m, "vault", "shared")).toBeUndefined();
    expect(grantFor(m, "vault")).toBeDefined();
    expect(() => parseManifest(manifestWith({ grants: [{ capability: "gmail", scope: "read", areas: ["private"] }] })))
      .toThrow(/areas/);
  });

  it("refuses an area nobody has heard of", () => {
    expect(() =>
      parseManifest(manifestWith({ grants: [{ capability: "vault", scope: "read", areas: ["everything"] }] })),
    ).toThrow(/everything/);
  });

  it("never widens: a skill may not require an area its agent was not granted", () => {
    expect(() =>
      assertSkillsWithinGrants({
        grants: [{ capability: "vault", scope: "read", areas: ["private"] }],
        skills: [{ name: "commercial", requires: [{ capability: "vault", scope: "read", areas: ["shared"] }] }],
      }),
    ).toThrow(/shared/);
  });

  it("documents vault, so docFor covers every known capability", () => {
    for (const c of KNOWN_CAPABILITIES) expect(() => docFor(c)).not.toThrow();
  });
});

describe("assertDeclarationIntegrity", () => {
  it("passes on a well-formed declaration and returns the parsed manifest", () => {
    const m = assertDeclarationIntegrity(VALID);
    expect(m.name).toBe("saga");
  });

  it("rejects an autonomy key with no matching grant", () => {
    expect(() => assertDeclarationIntegrity(manifestWith({ autonomy: { orakel: "gated", twenty: "gated" } }))).toThrow(
      /twenty/,
    );
  });

  it("rejects a duplicate capability", () => {
    expect(() =>
      assertDeclarationIntegrity(
        manifestWith({
          grants: [
            { capability: "orakel", scope: "read" },
            { capability: "orakel", scope: "write" },
          ],
          autonomy: {},
        }),
      ),
    ).toThrow(/orakel/);
  });

  it("rejects a capability that is not in KNOWN_CAPABILITIES", () => {
    expect(() =>
      assertDeclarationIntegrity(
        manifestWith({ grants: [{ capability: "teleport", scope: "read" }], autonomy: {} }),
      ),
    ).toThrow(/teleport/);
  });

  it("rejects an empty persona", () => {
    expect(() => assertDeclarationIntegrity(manifestWith({ persona: "" }))).toThrow(/persona/);
  });
});

// Lares repo split (ORB-262): the display name moved out of each service's package.json
// `assemble` script and into agent.json, so the engine's neutral default and an overlay's
// persona can each carry their own. Optional — an agent without one displays as its `name`.
describe("agent.json display (lares split, hook 30)", () => {
  const base = {
    name: "chief-of-staff", model: "x", persona: "agent/instructions.md", role: "chief-of-staff",
    scope: "personal", channels: [], egress: { sealed: true }, grants: [], autonomy: {},
  };

  it("accepts an optional display string and keeps it", () => {
    const parsed = manifestSchema.safeParse({ ...base, display: "Saga" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.display).toBe("Saga");
  });

  it("still accepts a declaration with no display at all", () => {
    expect(manifestSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a display that is not a non-empty string", () => {
    expect(manifestSchema.safeParse({ ...base, display: 42 }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, display: "" }).success).toBe(false);
  });
});
