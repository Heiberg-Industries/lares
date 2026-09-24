import { KNOWN_SKILLS, KNOWN_CAPABILITIES, VAULT_AREAS, assertSkillsWithinGrants, isVaultArea, scopeAtLeast, type KnownSkill, type VaultArea } from "./skill-grants.js";
export { KNOWN_SKILLS, KNOWN_CAPABILITIES, VAULT_AREAS, assertSkillsWithinGrants, isVaultArea, scopeAtLeast, type KnownSkill, type VaultArea } from "./skill-grants.js";
const KNOWN_CAPABILITY_SET: ReadonlySet<string> = new Set(KNOWN_CAPABILITIES);
// The agent declaration — `agent.json` — and the boot-time seam that turns it into a toolset
// (ORB-144).
//
// PORTED, NOT INVENTED. The schema is `services/agent-runtime/lib/adapters/loader.ts`'s
// `manifestSchema` (loader.ts:7-19), field for field. The one deliberate change: the autonomy
// level enum is widened from the old loader's two-way `gated | autonomous` (loader.ts:8) to
// the three-way `never | gated | autonomous` that the old runtime's OWN governance module
// already used (`lib/governance/ratchet.ts:3`). The loader was narrower than the semantics it
// fed; the governance module is the one that matters, so it wins.
//
// The autonomy semantics are `lib/governance/decide.ts`'s `decideAction` (decide.ts:17-43):
//
//   - The scope matrix answers FIRST (`lib/capabilities.ts:28-40`): ungranted or `none` →
//     deny; a read, or a plain `write` scope → allow; `write-with-confirm` → confirm.
//   - `never` is a hard deny that overrides the grant, for reads and writes alike
//     (decide.ts:29-31).
//   - Autonomy otherwise bites ONLY on the `confirm` class (decide.ts:33-39): `gated` → ask
//     for the 👍, `autonomous` → execute and summarise. It never reaches a read.
//   - An unset level defaults to the safe baseline `"gated"` (ratchet.ts:9, ratchet.ts:25).
//
// That last-but-one point is load-bearing on Bendik's daily driver. Saga's manifest says
// `orakel: read` AND `orakel: gated`; the three deployed `agent-kit__orakel_*` tools carry no
// `approval`. Reading `autonomy: gated` as "gate everything" would put a thumbs-up in front of
// a read-only company search. It does not, and `tests/manifest.test.ts` pins that.
//
// A tool's own `approval` field IS the declaration of its action class, so the resolver never
// has to infer read-from-write — it reads what the tool already says, and
// `assertClassMatchesScope` fails the BUILD when the tool and the declaration disagree.
//
// No credential reads at module scope: `eve build` evaluates this module with no secrets.
import { readFileSync } from "node:fs";

import { defineTool, disableTool, type DisabledToolSentinel, type ToolDefinition } from "eve/tools";
import { z } from "zod";

import { boardApproval } from "./board-approval.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** The registry's scope matrix, verbatim from `loader.ts:7` / `lib/capabilities.ts:1`. */
export const SCOPES = ["none", "read", "write", "write-with-confirm"] as const;
export type Scope = (typeof SCOPES)[number];

/** The trust-ratchet dial, verbatim from `governance/ratchet.ts:3` (ADR-0009 §Decision 1).
 *  Wider than `loader.ts:8`'s two-way enum on purpose — see this file's header. */
export const AUTONOMY_LEVELS = ["never", "gated", "autonomous"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** `ratchet.ts:9` / `ratchet.ts:25`: an unset level resolves to the safe baseline. */
export const DEFAULT_AUTONOMY: AutonomyLevel = "gated";

const scope = z.enum(SCOPES);
const level = z.enum(AUTONOMY_LEVELS);

// ---------------------------------------------------------------------------
// Skills (skills-layer spec, 2026-09-01). A skill composes capabilities the agent ALREADY
// holds; it can sequence, constrain and add policy — it can never widen access. The `requires`
// list is what the build checks against `grants`; a skill asking for more than the grants give
// fails the build, which is the never-widen property made structural.
// ---------------------------------------------------------------------------

/** Every CODE skill the fleet knows — a tool whose implementation composes other capabilities'
 *  libraries under an ENFORCED policy (the skills spec's second altitude). Instruction skills
 *  (`agent/skills/*.md`) are eve-native and are not listed here. */
/** Which TOOL each code skill is served by — the skills-layer counterpart of a capability doc's
 *  `tools` list, and the reason it exists here rather than in a persona doc.
 *
 *  A skill is not a capability: `renderEnvironment` names tools only through `capability-docs`,
 *  and a skill has no doc, so before this table the generated "where I run" section rendered
 *  `- **commercial** — composes twenty:read, orakel:read.` and stopped. Under that section's own
 *  heading — **"My only capabilities are the tools below."** — that made Saga's instructions.md
 *  the Wave-1 bug in its purest form: `commercial_who_to_contact` is compiled, callable, and
 *  named NOWHERE in the file that claims to be the whole truth about her tools (whole-branch
 *  review of ORB-145, Critical #1).
 *
 *  `Record<KnownSkill, …>` is load-bearing: adding a name to KNOWN_SKILLS without adding its
 *  tools here is a TYPE error, not a silently under-claiming persona. `tests/manifest-skills.ts`
 *  adds the runtime half (no entry may be empty), and each service's agent-declaration test
 *  asserts its own SKILL_TOOLS table equals this one, so the fleet cannot drift from the kit. */
export const KNOWN_SKILL_TOOLS: Record<KnownSkill, readonly string[]> = {
  commercial: ["commercial_who_to_contact"],
  // ORB-189: Tyche's engine, folded in. ONE tool over the `markets` capability, carrying the
  // policy a persona could only request — the required caveat, the computed edge, no stake
  // advice anywhere. The `agent-kit__` prefix because it is contributed by this package's
  // extension rather than authored in a service, the same as every other kit tool.
  "market-edge": ["agent-kit__market_edge"],
  signals: ["agent-kit__signals_recent"],
};

/** The tools of `name`, or `[]` when the name is not a known skill. A string accessor because
 *  `agent.json` carries plain strings — `assertSkillsWithinGrants` is what rejects an unknown
 *  one, and a renderer must not throw on a manifest that never went through it. */
export function skillToolsFor(name: string): readonly string[] {
  return Object.hasOwn(KNOWN_SKILL_TOOLS, name) ? KNOWN_SKILL_TOOLS[name as KnownSkill] : [];
}

/** A Vault area, with a custom error naming the bad value — the default zod enum message names
 *  only the legal values, and `assertDeclarationIntegrity`'s callers want to see what was typed. */
const vaultAreaSchema = z.enum(VAULT_AREAS, {
  error: (issue) => `"${String(issue.input)}" is not a known Vault area — expected one of ${VAULT_AREAS.join(", ")}`,
});

/** A capability grant. `areas` is meaningful ONLY on the `vault` capability (ADR-0017 rule 1) —
 *  every other capability names one thing, and an `areas` key there is a mistake, not a
 *  narrower grant, so it is rejected rather than silently ignored. */
const grantSchema = z
  .strictObject({ capability: z.string().min(1), scope, areas: z.array(vaultAreaSchema).optional() })
  .superRefine((grant, ctx) => {
    if (grant.areas === undefined) return;
    if (grant.capability !== "vault") {
      ctx.addIssue({
        code: "custom",
        message: `agent.json: "areas" is only valid on the "vault" capability grant, not "${grant.capability}"`,
        path: ["areas"],
      });
      return;
    }
    if (grant.areas.length === 0) {
      ctx.addIssue({ code: "custom", message: `agent.json: "areas" must not be an empty array`, path: ["areas"] });
    }
  });

const skillRequirementSchema = z.strictObject({ capability: z.string().min(1), scope, areas: z.array(vaultAreaSchema).optional() });
const skillSchema = z.strictObject({
  name: z.string().min(1),
  requires: z.array(skillRequirementSchema).default([]),
});
export type SkillRequirement = z.infer<typeof skillRequirementSchema>;
export type SkillDeclaration = z.infer<typeof skillSchema>;

// STRICT, where `loader.ts:10` was not. The one deliberate deviation from port fidelity, and
// port fidelity is about field names and semantics, not about tolerating unknown keys.
//
// The reason is that the consequence of a typo is NEW here. Misspell "grants" as "grant" and a
// non-strict schema parses happily, `grants` takes its `[]` default, every
// `resolveExtensionTool` returns `disableTool()`, `assertDeclarationIntegrity` passes — and
// Saga boots with its ten extension tools silently gone, no error anywhere. Under the old
// runtime the same empty list only produced per-call denials at runtime, which were at least
// visible. Here it removes tools at build time.
//
// Strictness rejects no manifest that is valid today.
export const manifestSchema = z.strictObject({
  name: z.string().min(1),
  // The name the assembled persona speaks as ("I am Saga"). Optional: without it the
  // assembler (bin/assemble-instructions.ts) uses `name`. It moved here from each service's
  // package.json `--display` flag so an overlay's agent.json carries its own (ORB-262).
  display: z.string().min(1).optional(),
  model: z.string().min(1),
  // Path to a persona file, relative to the agent folder. Optional since ORB-278 step 2: a
  // definition folder (`/srv/lares/agents/<name>/`) has no `agent/persona.md` — the persona is
  // ASSEMBLED at session start from the role template + duties + voice and never written to
  // disk there. The default matches what every service's own committed `agent.json` already
  // names (Task 5 renamed `agent/instructions.md` to `agent/persona.md` across all three
  // services and role templates), so a definition that says nothing keeps today's meaning.
  // `assertDeclarationIntegrity`'s `persona.trim() === ""` check still holds — the default is
  // non-empty, so only an explicit empty string in a hand-edited definition can trip it.
  persona: z.string().min(1).default("agent/persona.md"),
  // Which role template under `packages/agent-kit/templates/<role>/` this agent's assembled
  // instructions are built from (ORB-145 Phase 3). Declarative only — the build hook is told
  // the role path on its command line — but it is what makes the agent say, in its own
  // declaration, which shared role it wears.
  role: z.string().optional(),
  // Whose agent is this? A personal agent's stores resolve to the SPEAKING user's (Saga —
  // one chief of staff per member); an org agent is one shared instance that knows which
  // member is talking (Calliope). Spec: Lares org/multi-user design, Part 3. Store binding
  // by this field lands with config-driven agents; declaring it now is what lets that land.
  scope: z.enum(["personal", "org"]).default("personal"),
  channels: z.array(z.string()).default([]),
  // eve FRAMEWORK tools this agent keeps enabled. These are NOT capabilities and NOT grants:
  // they are eve's own built-ins, which `agent.json` does not govern — an agent enables one by
  // authoring `agent/tools/<name>.ts` (Marcel's `web_search.ts`) and disables it with a
  // `disableTool()` sentinel (Saga's and Calliope's). Declaring one here changes nothing at
  // runtime; it exists so the GENERATED "where I run" section can tell the truth about it
  // (ORB-145 Phase 3). Marcel is the only agent in the fleet with web search live, and without
  // this field his assembled persona would have said "I cannot search the web" — the Wave-1
  // bug the whole plan exists to end, in generated text this time.
  //
  // It must match what `eve build` actually compiled, or it is just a hand-set flag that drifts:
  // each service's tests/agent-declaration.test.ts asserts this list against its OWN
  // .output/.eve/compile/compiled-agent-manifest.json (`webSearchProvider` set AND `web_search`
  // absent from `disabledFrameworkTools`). The enum is deliberately closed — a name eve does not
  // have is a typo, and a typo here would quietly re-introduce the false denial.
  framework_tools: z.array(z.enum(["web_search"])).default([]),
  grants: z.array(grantSchema).default([]),
  autonomy: z.record(z.string(), level).default({}),
  // Code skills this agent carries, each naming the capabilities it composes. Checked by
  // `assertSkillsWithinGrants` at build time: a requirement the grants do not cover FAILS.
  skills: z.array(skillSchema).default([]),
  // Strict here too: `{"seald": true}` would otherwise fall through to `sealed: false` and
  // quietly unseal the agent's egress.
  egress: z.strictObject({ sealed: z.boolean().default(false) }).default({ sealed: false }),
});

export type AgentManifest = z.infer<typeof manifestSchema>;
export type CapabilityGrant = AgentManifest["grants"][number];

/** Every capability name the fleet knows. The first fifteen are the old runtime's registered
 *  hands, read from `services/agent-runtime/lib/adapters/hands/*.ts`'s `name:` fields — a
 *  superset of the fifteen Saga's `agents/saga/agent.json` declares, which omits `studio` and
 *  includes `read_url`. The old runtime's `probability` hand (Tyche) is NOT carried forward
 *  here: no eve agent grants it and no tool serves it — its successor arrives as `markets`
 *  with ORB-189. The last three name Saga tools that the old declaration never gave a
 *  capability at all (`echo_note`, `outreach_track`, `voice_guide` — ORB-144 Ruling 3). Task 3
 *  appends Marcel's names to this list. */
// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Validate an already-loaded declaration. Throws an Error naming the offending field —
 *  the whole point is that a typo in `agent.json` fails the build loudly, not at 07:00 in
 *  front of a schedule. */
export function parseManifest(raw: unknown): AgentManifest {
  const result = manifestSchema.safeParse(raw);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
  throw new Error(`invalid agent manifest — ${detail}`);
}

/** Read + parse an `agent.json` from disk. For tests and tooling; agents import their own
 *  declaration as a JSON module instead (a bundled module has no reliable
 *  `import.meta.dirname` at the agent root). */
export function loadManifest(path: string): AgentManifest {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`loadManifest: cannot read ${path}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`loadManifest: ${path} is not valid JSON: ${(err as Error).message}`);
  }
  try {
    return parseManifest(raw);
  } catch (err) {
    throw new Error(`loadManifest: ${path} — ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/** The grant for `capability`, or `undefined` when the declaration is silent about it. With
 *  `area` given, the grant is returned only when it lists that area — meaningful for `vault`
 *  today; a grant that carries no `areas` at all (every non-`vault` capability) never matches
 *  an area-qualified lookup. */
export function grantFor(manifest: AgentManifest, capability: string, area?: VaultArea): CapabilityGrant | undefined {
  const grant = manifest.grants.find((g) => g.capability === capability);
  if (!grant) return undefined;
  if (area === undefined) return grant;
  return grant.areas?.includes(area) ? grant : undefined;
}

/** The autonomy level for `capability`, defaulting to `ratchet.ts`'s safe baseline. */
export function autonomyOf(manifest: AgentManifest, capability: string): AutonomyLevel {
  return manifest.autonomy[capability] ?? DEFAULT_AUTONOMY;
}

/** Whether the agent holds `capability` at all. A `none` scope is a declared non-grant
 *  (`lib/capabilities.ts:32`), not a grant. */
export function isGranted(manifest: AgentManifest, capability: string): boolean {
  const grant = grantFor(manifest, capability);
  return grant !== undefined && grant.scope !== "none";
}

/**
 * THE AREAS THIS DECLARATION MAY OPEN — the one derivation, used both by the session seam
 * (`catalogue.ts`) and by the note tools themselves, so the tool list and the tool's own
 * refusal can never disagree.
 *
 * NEVER WIDEN. An area is in the answer only because the declaration's `vault` grant names it
 * in `areas`. `brain`, `atlas` and `memory` are not aliased to an area — they left
 * `KNOWN_CAPABILITIES` at W5C-s5/s6, so a definition that still spells one of them fails
 * `assertDeclarationIntegrity` before this function ever runs (W5C-s9). A `none` scope is a
 * declared NON-grant and a `never` autonomy is a hard deny (`decide.ts:31`), so both give the
 * area nothing — the same two tests `grantedToolNames` makes before it hands a tool over.
 *
 * The result is ordered by `VAULT_AREAS`, never by the order the grants happen to be written
 * in, so the same declaration always reads the same way.
 */
export function grantedVaultAreas(manifest: AgentManifest): VaultArea[] {
  const open = new Set<VaultArea>();
  const grant = grantFor(manifest, "vault");
  if (grant !== undefined && grant.scope !== "none" && autonomyOf(manifest, "vault") !== "never") {
    for (const area of grant.areas ?? []) open.add(area);
  }
  return VAULT_AREAS.filter((area) => open.has(area));
}

/** Permissiveness order for the never-widen check. `write` outranks `write-with-confirm`
 *  because a plain write grant runs the same action WITHOUT a card — it is the more permissive
 *  grant, so it satisfies a skill that only asked for the gated form. `read` satisfies nothing
 *  above it; `none` satisfies nothing at all. */
export function skillFor(manifest: AgentManifest, name: string): SkillDeclaration | undefined {
  return manifest.skills.find((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// The boot seam
// ---------------------------------------------------------------------------

/** The two fields the resolver reads off a tool.
 *
 *  Structural on purpose, and NOT `ToolDefinition<any, any>`: eve types `approval` as
 *  `Approval<ApprovalContextInput<TInput>>`, a property-position function that is invariant in
 *  the tool's input type under `strictFunctionTypes` — and `ApprovalContextInput<any>`
 *  collapses to `Record<string, unknown>` (`unknown extends any` is true), so even the `any`
 *  form rejects every concretely-typed tool. Verified by `pnpm --filter @lares/agent-kit
 *  typecheck`, not assumed. */
export interface ResolvableTool {
  readonly description?: unknown;
  readonly approval?: unknown;
}

/** Fail the build when a tool claims more power than the declaration grants it.
 *
 *  ONE DIRECTION ONLY, and deliberately so. A tool carrying an `approval` under a grant whose
 *  scope is not `write-with-confirm` throws: the tool's own gate declares it a confirm-class
 *  action, so the declaration would be understating what the agent can do — and the dangerous
 *  reading of an understated declaration is a silently ungated write.
 *
 *  The reverse — "a `write-with-confirm` grant over a tool carrying no approval" — is NOT an
 *  error, because a capability spans both action classes. `lib/capabilities.ts:33-34` is
 *  explicit: `isWrite = cap.writes.includes(action)`, and a non-write action under a
 *  `write-with-confirm` capability returns `allow`. Deployed proof: `brain` is
 *  `write-with-confirm`, its three `brain_*` tools carry `always()`, and its four `vault_*`
 *  tools (`readTool("brain")` and friends, `src/note-tools.ts`) carry no approval at all. A
 *  per-tool assertion in that direction would refuse `vault_read` and kill eve-saga's build.
 *
 *  The aggregate truth that direction was reaching for — "a `write-with-confirm` capability has
 *  at least one gated tool" — needs to see all of a capability's tools at once, so it belongs in
 *  each agent's conformance test, not here. */
export function assertClassMatchesScope(tool: ResolvableTool, grant: CapabilityGrant): void {
  if (tool.approval !== undefined && grant.scope !== "write-with-confirm") {
    throw new Error(
      `agent.json declares "${grant.capability}" at scope "${grant.scope}", but the tool ` +
        `carries an approval gate, which declares it a write-with-confirm action ` +
        `(tool: "${describe(tool)}"). Fix whichever file is wrong.`,
    );
  }
}

function describe(tool: ResolvableTool): string {
  const text = typeof tool.description === "string" ? tool.description : "";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** Resolve one extension tool against the agent's declaration.
 *
 *  This is the third of the three seams eve gives us (agent config, extension config, per-tool
 *  override) and the load-bearing one: both agents carry the same ten override files, and what
 *  each agent ends up with is decided by its `agent.json`. To give Marcel Brain you add a
 *  grant; you do not write or delete code.
 *
 *  `manifest` is `unknown` so the JSON-module import at the call site type-checks — TypeScript
 *  widens `agent.json`'s `scope` to `string`, which no hand-written union would accept. It is
 *  validated here instead, at build time. */
export function resolveExtensionTool<T extends ResolvableTool>(
  manifest: unknown,
  capability: string,
  tool: T,
  toolName?: string,
): T | DisabledToolSentinel {
  const m = parseManifest(manifest);
  const grant = grantFor(m, capability);

  // The scope matrix answers first (lib/capabilities.ts:32).
  if (!grant || grant.scope === "none") return disableTool();

  // `never` is a hard deny that overrides the grant, for reads and writes alike (decide.ts:31).
  const level = autonomyOf(m, capability);
  if (level === "never") return disableTool();

  assertClassMatchesScope(tool, grant);

  // ORB-278 step 1: autonomy is decided PER CALL by the permissions board (board-approval.ts), with this
  // declaration's level as the fallback — no longer frozen here at build. A tool without an approval is
  // a read (assertClassMatchesScope guarantees it) and is returned unchanged.
  if (tool.approval !== undefined) {
    const withBoard = { ...tool, approval: boardApproval(manifest, `agent-kit__${toolName ?? "unnamed"}`) } as unknown as ToolDefinition<unknown, unknown>;
    return defineTool<unknown, unknown>(withBoard) as unknown as T;
  }

  return tool;
}

/** Resolve a CODE SKILL's tool against the declaration. Same seam as `resolveExtensionTool`,
 *  one altitude up: the skill must be declared, its requirements must sit inside the grants
 *  (checked — a widening declaration fails the build), and a `never` on any required
 *  capability switches the skill off, because a skill cannot outlive the access it composes. */
export function resolveSkillTool<T extends ResolvableTool>(
  manifest: unknown,
  skill: string,
  tool: T,
): T | DisabledToolSentinel {
  const m = parseManifest(manifest);
  assertSkillsWithinGrants(m);
  const decl = skillFor(m, skill);
  if (!decl) return disableTool();
  for (const req of decl.requires) {
    if (autonomyOf(m, req.capability) === "never") return disableTool();
  }
  return tool;
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

/** Cross-field checks the schema cannot express. Returns the parsed manifest so a caller can
 *  use it directly. Accepts `unknown` for the same reason `resolveExtensionTool` does. */
export function assertDeclarationIntegrity(manifest: unknown): AgentManifest {
  const m = parseManifest(manifest);

  if (m.persona.trim() === "") {
    throw new Error(`agent.json: "persona" must name a persona file, not an empty string`);
  }

  assertSkillsWithinGrants(m);

  const seen = new Set<string>();
  for (const grant of m.grants) {
    if (seen.has(grant.capability)) {
      throw new Error(`agent.json: capability "${grant.capability}" is granted more than once`);
    }
    seen.add(grant.capability);
    if (!KNOWN_CAPABILITY_SET.has(grant.capability)) {
      throw new Error(
        `agent.json: capability "${grant.capability}" is not in KNOWN_CAPABILITIES ` +
          `(@lares/agent-kit/manifest). Add it there if it is real.`,
      );
    }
  }

  for (const capability of Object.keys(m.autonomy)) {
    if (!seen.has(capability)) {
      throw new Error(
        `agent.json: autonomy is set for "${capability}", which has no matching grant — ` +
          `an autonomy level over an ungranted capability is decorative.`,
      );
    }
  }

  return m;
}
