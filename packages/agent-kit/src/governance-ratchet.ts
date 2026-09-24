/** A capability/action's autonomy level — the trust-ratchet dial (ADR-0009 §Decision 1).
 *  3-way: never (hard deny) · gated (👍) · autonomous (act + summary). */
export type AutonomyLevel = "autonomous" | "gated" | "never";

/** Stores the per-(agent, capability[, action]) autonomy level.
 *  Resolution: an action-specific level overrides the capability default;
 *  the capability default overrides the safe baseline "gated". */
export interface RatchetStore {
  /** Resolve the level. `action` omitted → the capability-wide default. Defaults to "gated". */
  level(agent: string, capability: string, action?: string): Promise<AutonomyLevel>;
  /** Set a level. `action` omitted → set the capability-wide default. Reversible. */
  setLevel(agent: string, capability: string, level: AutonomyLevel, action?: string): Promise<void>;
}

export class InMemoryRatchet implements RatchetStore {
  private readonly levels = new Map<string, AutonomyLevel>();
  private key(agent: string, capability: string, action?: string): string {
    return `${agent}:${capability}:${action ?? ""}`;
  }
  async level(agent: string, capability: string, action?: string): Promise<AutonomyLevel> {
    if (action) {
      const exact = this.levels.get(this.key(agent, capability, action));
      if (exact) return exact;
    }
    return this.levels.get(this.key(agent, capability)) ?? "gated";
  }
  async setLevel(agent: string, capability: string, level: AutonomyLevel, action?: string): Promise<void> {
    this.levels.set(this.key(agent, capability, action), level);
  }
}
