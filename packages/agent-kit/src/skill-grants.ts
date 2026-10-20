// Browser-safe authorization predicate shared by the builder and manifest validation.
// Keep this module free of runtime/Node imports.
type Scope = "none" | "read" | "write-with-confirm" | "write";
export interface SkillGrantDeclaration {
  grants: readonly { capability: string; scope: Scope; areas?: readonly VaultArea[] }[];
  skills: readonly {
    name: string;
    requires: readonly { capability: string; scope: Scope; areas?: readonly VaultArea[] }[];
  }[];
}
export const KNOWN_SKILLS = ["commercial", "signals"] as const satisfies readonly string[];
export type KnownSkill = (typeof KNOWN_SKILLS)[number];
const KNOWN_SKILL_SET: ReadonlySet<string> = new Set<string>(KNOWN_SKILLS);

export const KNOWN_CAPABILITIES = [
  // Governs changing a capability's or a
  // meeting series' autonomy level (meeting_followup_auto). Alphabetized into this block on
  // position, not on origin.
  "autonomy",
  "calendar",
  // The owner's deadlines to institutions — tax and
  // filing terms, annual accounts, renewals — distinct from `obligation` (a person waiting) and
  // `remind` (a time the owner chose). Alphabetized into this block on position, not on origin,
  // exactly as `autonomy` is.
  "deadline",
  "digest",
  "gmail",
  "identity",
  "notion",
  "obligation",
  // Governs the outside (MCP) tool servers an agent's definition lists under
  // `outsideTools`. No tools of its own and no static hosts: each server's host comes from the
  // definition.
  "outside",
  "person",
  "read_url",
  "remind",
  // Read-only access to the persisted operational
  // signal spine. The endpoint already exists; this capability governs which agents may see it.
  "signals",
  "studio",
  // Governs `agent-kit__transit_plan`: real
  // Norwegian public-transport journeys from Entur (train, bus, tram, metro, ferry), a pure
  // read of a free, unbilled public API. Granted at `read` by the chief-of-staff service —
  // like `calendar` above, it is a fleet capability rather than one agent's domain. The
  // creative service grants it nowhere, which is what keeps its copy of the override file a
  // disable sentinel.
  // Alphabetized into this block on position, not on origin, exactly as `autonomy` and `facts`
  // above are.
  "transit",
  "twenty",
  // Capabilities for chief of staff tools that would otherwise have no capability at all
  "echo",
  "outreach",
  "voice",
  // ADR-0017 (the Vault, one name). `vault` REPLACES `brain`, `atlas` and `memory`, which left
  // this array along with the three capability docs they had. One capability over
  // three stores, narrowed a second time by the `areas` a grant names — which is why the three
  // names could go rather than be aliased: an area says what a capability name used to say, and
  // says it in a place a grant can be narrowed on. `facts` and `memory`
  // must not be two names for one concept: `facts` is now an
  // AREA, and the only one, of the standing facts these tools write.
  //
  // An `agent.json` still carrying one of the three is not aliased and not tolerated: the
  // membership check in `assertDeclarationIntegrity` rejects it, the definition fails closed,
  // and the agent keeps its last valid one.
  "vault",
] as const satisfies readonly string[];

const KNOWN_CAPABILITY_SET: ReadonlySet<string> = new Set<string>(KNOWN_CAPABILITIES);

/** The Vault's areas (ADR-0017 rule 1). `facts` names the TABLES — standing facts, the agent's
 *  own notes, standing preferences and the changes waiting on the owner — because "memory stops
 *  naming a store; it names the act". `_meta` is deliberately not grantable: the agents write it
 *  through their own schedules and it is excluded from search (`notes-store.ts:30`). */
export const VAULT_AREAS = ["private", "shared", "taste", "facts"] as const satisfies readonly string[];
export type VaultArea = (typeof VAULT_AREAS)[number];
const VAULT_AREA_SET: ReadonlySet<string> = new Set<string>(VAULT_AREAS);

export function isVaultArea(s: string): s is VaultArea {
  return VAULT_AREA_SET.has(s);
}

const SCOPE_RANK: Record<Scope, number> = { none: 0, read: 1, "write-with-confirm": 2, write: 3 };

export function scopeAtLeast(granted: Scope, required: Scope): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[required];
}

/** The never-widen property, enforced. Throws naming the skill, the capability and both scopes,
 *  so the fix is obvious from the message alone. */
export function assertSkillsWithinGrants(manifest: SkillGrantDeclaration): void {
  for (const skill of manifest.skills) {
    if (!KNOWN_SKILL_SET.has(skill.name)) {
      throw new Error(`agent.json: unknown skill "${skill.name}" — add it to KNOWN_SKILLS in @lares/agent-kit/manifest or fix the typo`);
    }
    for (const req of skill.requires) {
      if (!KNOWN_CAPABILITY_SET.has(req.capability)) {
        throw new Error(`agent.json: skill "${skill.name}" requires unknown capability "${req.capability}"`);
      }
      const grant = manifest.grants.find(g => g.capability === req.capability);
      if (!grant || grant.scope === "none") {
        throw new Error(`agent.json: skill "${skill.name}" requires "${req.capability}" at "${req.scope}", but that capability is not granted — a skill can never widen access`);
      }
      if (!scopeAtLeast(grant.scope, req.scope)) {
        throw new Error(`agent.json: skill "${skill.name}" requires "${req.capability}" at "${req.scope}", but the grant is only "${grant.scope}" — a skill can never widen access`);
      }
      // Areas, compared only when the skill actually names one — a skill silent about areas
      // widens nothing (same rule an empty `requires` already gets).
      if (req.areas && req.areas.length > 0) {
        const grantedAreas = new Set<VaultArea>(grant.areas ?? []);
        for (const area of req.areas) {
          if (!grantedAreas.has(area)) {
            throw new Error(`agent.json: skill "${skill.name}" requires "${req.capability}" area "${area}", but that area is not granted — a skill can never widen access`);
          }
        }
      }
    }
  }
}
