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
  "personal_mailbox",
  "personal_calendar",
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

// ---------------------------------------------------------------------------
// Instruction skills
// ---------------------------------------------------------------------------
//
// An INSTRUCTION skill is text: a procedure under `agent/skills/` that the model pulls into a
// conversation with the framework's own loader (`eve__skill` since eve 1.0). That loader loads any
// skill the conversation has and no authored file can replace or gate it, so the only place the
// rule can live is WHICH SKILLS EXIST in a conversation. This table is that rule's data; the
// decision is `instructionSkillsAllowedBy` / `instructionSkillOffered` in `./manifest.ts`.
//
// It is a different list from KNOWN_SKILLS on purpose. KNOWN_SKILLS are CODE skills an owner
// declares in `agent.json` (and the console lists); a name here is never written in a definition.
// The requirements below are the ENGINE's statement of what each text tells the agent to use, so
// no definition can understate them, and none of this adds a field to the definition format.

/** One instruction skill's rule. Loading a skill adds text and never a tool, so a skill cannot
 *  widen access by itself; what this closes is the other half of never-widen: a procedure must
 *  not be offered to an agent whose grants do not reach the tools the procedure names. */
export interface InstructionSkillRule {
  /** The CODE skill this text is the method for, when it is one. The text then exists only where
   *  the definition declares that skill (and that declaration is inside the grants). */
  readonly declaredAs?: KnownSkill;
  /** Every capability whose tools the text tells the agent to call, at the lowest scope at which
   *  those tools are handed over: `write-with-confirm` for a tool that raises its own approval
   *  card, `read` for any other. Each service's skills test holds this list against the text. */
  readonly requires: readonly { capability: string; scope: Scope }[];
  /** Whether a private console conversation gets this skill. Only text that reads nothing of the
   *  installation may say `true`. */
  readonly privateConsole: boolean;
}

export const INSTRUCTION_SKILLS = {
  // NEEDS NO GRANT, AND THAT IS A DECISION. The text is an index of the public, reviewed
  // documentation fixed into the release, and the one tool it names (`lares_read_public_doc`)
  // reads only those baked pages by a listed id. Nothing it says or reaches belongs to an
  // installation, so there is no capability for a grant to cover and no definition can narrow
  // or widen it. It is also the only skill a private console conversation gets.
  "lares-docs": { requires: [], privateConsole: true },
  // The whole outreach loop: who to write as, the do-not-contact check, research, the voice
  // guide, the gated send, and tracking the thread for a reply.
  "sales-outreach": {
    requires: [
      { capability: "gmail", scope: "write-with-confirm" },
      { capability: "identity", scope: "read" },
      { capability: "outreach", scope: "read" },
      { capability: "read_url", scope: "read" },
      { capability: "twenty", scope: "write-with-confirm" },
      { capability: "voice", scope: "read" },
    ],
    privateConsole: false,
  },
  // The method for the `signals` code skill: declared in the definition, over the signal feed.
  signals: {
    declaredAs: "signals",
    requires: [{ capability: "signals", scope: "read" }],
    privateConsole: false,
  },
} as const satisfies Record<string, InstructionSkillRule>;

export type InstructionSkillName = keyof typeof INSTRUCTION_SKILLS;
export const INSTRUCTION_SKILL_NAMES = Object.keys(INSTRUCTION_SKILLS).sort() as InstructionSkillName[];

export function isInstructionSkill(name: string): name is InstructionSkillName {
  return Object.hasOwn(INSTRUCTION_SKILLS, name);
}

/** Whether `grants` reach every requirement: the capability is granted, not at `none`, and at
 *  least at the required scope. The same comparison `assertSkillsWithinGrants` makes, as a
 *  yes/no instead of a throw, because the caller's answer to "no" is that the skill is absent.
 *  An unknown capability is a "no": nothing can be granted that the engine does not know. */
export function grantsCover(
  grants: SkillGrantDeclaration["grants"],
  requires: readonly { capability: string; scope: Scope }[],
): boolean {
  return requires.every((req) => {
    if (!KNOWN_CAPABILITY_SET.has(req.capability)) return false;
    const grant = grants.find((g) => g.capability === req.capability);
    return grant !== undefined && grant.scope !== "none" && scopeAtLeast(grant.scope, req.scope);
  });
}
