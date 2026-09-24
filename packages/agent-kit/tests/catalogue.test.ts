import { describe, expect, it } from "vitest";
import { ALWAYS_PRESENT, grantedToolNames } from "../src/catalogue.js";
import { parseDefinition } from "../src/definition.js";

const CATALOGUE = {
  vault_read: { capability: "vault", tool: { description: "read" } },
  vault_write: { capability: "vault", tool: { description: "write", approval: () => "user-approval" } },
  studio_ideate: { capability: "studio", tool: { description: "ideate" } },
  gmail_send: { capability: "gmail", tool: { description: "send", approval: () => "user-approval" } },
  set_language: { capability: "language", tool: { description: "switch" } },
  // Skill-gated (LAR-5-s1): mirrors the real market_edge shape (LAR-5-s2) without moving it.
  market_edge: { capability: "markets", skill: "market-edge", tool: { description: "market edge" } },
};

const def = (over: Record<string, unknown> = {}) =>
  parseDefinition({
    name: "calliope", display: "Calliope", model: "heiberg-brain", persona: "agent/instructions.md",
    role: "creative",
    grants: [{ capability: "studio", scope: "write" }, { capability: "vault", scope: "write-with-confirm", areas: ["shared"] }],
    autonomy: { studio: "gated", vault: "gated" },
    ...over,
  });

describe("the catalogue resolver", () => {
  it("hands over exactly the granted subset — an ungranted tool never appears", () => {
    expect(grantedToolNames(CATALOGUE, def()).sort())
      .toEqual(["set_language", "studio_ideate", "vault_read", "vault_write"]);
  });

  it("a `none` scope is a declared non-grant, not a grant", () => {
    const names = grantedToolNames(CATALOGUE, def({
      grants: [{ capability: "studio", scope: "none" }, { capability: "vault", scope: "read", areas: ["shared"] }],
      autonomy: { studio: "gated", vault: "gated" },
    }));
    expect(names).not.toContain("studio_ideate");
  });

  it("`never` is a hard deny that overrides the grant, for reads as well as writes", () => {
    const names = grantedToolNames(CATALOGUE, def({ autonomy: { studio: "never", vault: "gated" } }));
    expect(names).not.toContain("studio_ideate");
    expect(names).toContain("vault_read");
  });

  it("keeps the always-present tools whatever the definition says", () => {
    expect(ALWAYS_PRESENT).toEqual(["set_language"]);
    expect(grantedToolNames(CATALOGUE, def({ grants: [], autonomy: {} }))).toEqual(["set_language"]);
  });

  it("an always-present tool is kept even where its pseudo-capability is set to never (R2)", () => {
    // Nothing can grant "language", so nothing can revoke it either — but prove the short-circuit
    // really does run before the grant lookup rather than relying on the lookup failing.
    const names = grantedToolNames(CATALOGUE, def({
      grants: [{ capability: "vault", scope: "read", areas: ["shared"] }], autonomy: { vault: "never" },
    }));
    expect(names).toEqual(["set_language"]);
  });

  // ---------------------------------------------------------------------------
  // THE TWO POLARITIES OF THE CLASS/SCOPE CHECK, and why they differ (controller ruling,
  // 2026-09-16). A gated tool — one carrying its own approval — is a write-with-confirm-class
  // action. What the grant does about that depends on WHICH WAY the two disagree:
  //
  //   scope `read`  + gated tool -> DROP, silently. The grant is merely NARROW. `read` does not
  //                                 cover a confirm-class action, so the tool is not handed over,
  //                                 and a tool that is absent cannot run ungated. Fail-closed.
  //   scope `write` + gated tool -> THROW. The grant and the tool CONTRADICT each other: `write`
  //                                 says the action runs with no card, the tool's own gate says it
  //                                 needs one. Whichever file is wrong, one of them is lying about
  //                                 what the agent can do, and the dangerous reading of that is a
  //                                 silently ungated write.
  //
  // The asymmetry also buys something these two cases cannot show on their own: this code now runs
  // at SESSION START, not at build. A throw here takes a live agent's conversation down, so it is
  // spent only on the contradiction, never on the narrowness. `none` has always been dropped
  // rather than thrown for exactly this reason; `read` over a write-class tool is the same shape.
  // ---------------------------------------------------------------------------

  it("NARROW: a `read` grant hands over the capability's reads and drops its gated write, without throwing", () => {
    // A capability is a DOMAIN spanning both action classes (manifest.ts's own docblock, from
    // `lib/capabilities.ts:33-34`), so a narrower scope is a narrower tool list. This is the case
    // the build-time `resolveExtensionTool` could only answer with a throw, because it saw one
    // tool at a time against one grant and had no "hand over the other three" to offer.
    expect(grantedToolNames(CATALOGUE, def({
      grants: [{ capability: "vault", scope: "read", areas: ["shared"] }], autonomy: { vault: "gated" },
    }))).toEqual(["set_language", "vault_read"]);
  });

  it("CONTRADICTORY: a plain `write` grant over a gated tool THROWS — it is not narrowness, it is a false declaration", () => {
    // The opposite polarity to the case above, and deliberately NOT dropped. Dropping here would
    // hide a declaration that understates the agent: `write` outranks `write-with-confirm` in
    // `SCOPE_RANK`, so the tool would be reachable, and the only question is whether the card
    // survives. Silence would answer that question the wrong way round.
    expect(() => grantedToolNames(CATALOGUE, def({
      grants: [{ capability: "vault", scope: "write", areas: ["shared"] }], autonomy: { vault: "gated" },
    }))).toThrow(/write-with-confirm/);
  });

  // W7D-s3 — the third case the two polarities above did not have: a READ that asks first.
  //
  // `read_url` fetches and returns text and writes nothing, but since W7D-s3 it carries an
  // approval, because a link met in a turn that has already read somebody else's words is the
  // cheapest outbound request an attacker can buy. Read as "write class" it vanished from a
  // `read`-scoped installation — silently, with every unit test green; only the tool-list
  // snapshot saw it (75 → 74). `asksWithoutWriting` is the entry saying which of the two it is.
  const READS_BUT_ASKS = {
    ...CATALOGUE,
    link_open: {
      capability: "studio",
      asksWithoutWriting: true as const,
      tool: { description: "open a link", approval: () => "user-approval" },
    },
  };

  it("A READ THAT ASKS: a `read` grant still hands it over — the gate is not a write", () => {
    expect(grantedToolNames(READS_BUT_ASKS, def({
      grants: [{ capability: "studio", scope: "read" }], autonomy: { studio: "gated" },
    }))).toEqual(["link_open", "set_language", "studio_ideate"]);
  });

  it("…and a plain `write` grant over it does not throw either — it makes no confirm-class claim", () => {
    expect(() => grantedToolNames(READS_BUT_ASKS, def({
      grants: [{ capability: "studio", scope: "write" }], autonomy: { studio: "gated" },
    }))).not.toThrow();
  });

  it("the marker takes nothing else out: a gated WRITE on the same capability still drops under `read`", () => {
    // The exemption is per ENTRY, never per capability — `studio_ideate` and `link_open` share
    // `studio`, and a gated write added there tomorrow must still be unreachable at `read`.
    const withWrite = {
      ...READS_BUT_ASKS,
      studio_publish: { capability: "studio", tool: { description: "publish", approval: () => "user-approval" } },
    };
    expect(grantedToolNames(withWrite, def({
      grants: [{ capability: "studio", scope: "read" }], autonomy: { studio: "gated" },
    }))).not.toContain("studio_publish");
  });

  it("`never` still wins over it — a read that asks is still a read the owner can switch off", () => {
    expect(grantedToolNames(READS_BUT_ASKS, def({
      grants: [{ capability: "studio", scope: "read" }], autonomy: { studio: "never" },
    }))).toEqual(["set_language"]);
  });

  it("a granted capability with no tool in this catalogue is not an error — the pool may be narrower", () => {
    expect(() => grantedToolNames(CATALOGUE, def({
      grants: [{ capability: "vault", scope: "read", areas: ["shared"] }, { capability: "transit", scope: "read" }],
      autonomy: { vault: "gated", transit: "gated" },
    }))).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // LAR-5-s1: an entry can also be gated on a SKILL, not just a capability. This is the
  // catalogue-side half of the fix — taking a skill away in the console must really take its
  // tool away, which the capability grant alone cannot express (LAR-5's diagnosis: a dynamic
  // `defineDynamic` override returning `null` does not remove the kit extension's own static
  // tool, because eve dedupes static and dynamic tool lists separately). The gate reuses
  // `resolveSkillTool`'s own view (manifest.ts:345-358) rather than re-deriving it.
  // ---------------------------------------------------------------------------

  describe("an entry gated on a skill (LAR-5-s1)", () => {
    it("is absent when the skill is undeclared, even though the capability is granted", () => {
      const names = grantedToolNames(CATALOGUE, def({
        grants: [
          { capability: "studio", scope: "write" }, { capability: "vault", scope: "write-with-confirm", areas: ["shared"] },
          { capability: "markets", scope: "read" },
        ],
        autonomy: { studio: "gated", vault: "gated", markets: "gated" },
        // no `skills` — market-edge is not declared.
      }));
      expect(names).not.toContain("market_edge");
    });

    it("is present when the skill is declared and its required capability is granted", () => {
      const names = grantedToolNames(CATALOGUE, def({
        grants: [
          { capability: "studio", scope: "write" }, { capability: "vault", scope: "write-with-confirm", areas: ["shared"] },
          { capability: "markets", scope: "read" },
        ],
        autonomy: { studio: "gated", vault: "gated", markets: "gated" },
        skills: [{ name: "market-edge", requires: [{ capability: "markets", scope: "read" }] }],
      }));
      expect(names).toContain("market_edge");
    });

    it("is absent when a capability the skill composes is `never`, even though the skill is declared and its own capability is fine", () => {
      // Deliberately a DIFFERENT capability from the entry's own ("markets" stays gated) — this
      // proves the check walks the skill's whole `requires` list, not just the entry's capability.
      const names = grantedToolNames(CATALOGUE, def({
        grants: [
          { capability: "studio", scope: "write" }, { capability: "vault", scope: "write-with-confirm", areas: ["shared"] },
          { capability: "markets", scope: "read" }, { capability: "signals", scope: "read" },
        ],
        autonomy: { studio: "gated", vault: "gated", markets: "gated", signals: "never" },
        skills: [{
          name: "market-edge",
          requires: [{ capability: "markets", scope: "read" }, { capability: "signals", scope: "read" }],
        }],
      }));
      expect(names).not.toContain("market_edge");
    });

    it("throws when the skill declaration widens the grants", () => {
      expect(() => grantedToolNames(CATALOGUE, def({
        grants: [
          { capability: "studio", scope: "write" }, { capability: "vault", scope: "write-with-confirm", areas: ["shared"] },
          { capability: "markets", scope: "read" },
        ],
        autonomy: { studio: "gated", vault: "gated", markets: "gated" },
        skills: [{ name: "market-edge", requires: [{ capability: "markets", scope: "write" }] }],
      }))).toThrow(/never widen/);
    });

    it("an entry with no `skill` is unaffected by an unrelated skill declaration", () => {
      const names = grantedToolNames(CATALOGUE, def({
        skills: [{ name: "market-edge", requires: [{ capability: "vault", scope: "write-with-confirm", areas: ["shared"] }] }],
      }));
      expect(names).toContain("vault_read");
      expect(names).toContain("studio_ideate");
      // "markets" is still ungranted by the base `def()`, so market_edge stays absent here too.
      expect(names).not.toContain("market_edge");
    });
  });
});

// ---------------------------------------------------------------------------
// THE AREA GATE (ADR-0017 rule 1, W5C-s5/s6). One `vault` capability spans three stores that
// used to be three capabilities, so the grant alone stopped being enough to decide a vault
// tool: a role granted `vault` for the standing facts must not thereby be handed the owner's
// personal note tools. The area each tool touches is required against the areas the
// declaration actually names, and it can only ever take a tool away.
// ---------------------------------------------------------------------------

/** Real tool names on purpose: the engine's own tool→area table (`areaOfTool`) is what decides
 *  these, and a made-up name would test the catalogue's fallback instead of the table. One tool
 *  per area, plus one vault entry the engine table does not know. */
const AREAS_CATALOGUE = {
  "agent-kit__vault_read": { capability: "vault", tool: { description: "private read" } },
  vault_read: { capability: "vault", tool: { description: "shared read" } },
  remember: { capability: "vault", tool: { description: "keep a fact" } },
  undocumented_vault_tool: { capability: "vault", tool: { description: "no doc, no area" } },
  studio_ideate: { capability: "studio", tool: { description: "ideate" } },
  set_language: { capability: "language", tool: { description: "switch" } },
};

const areaDef = (areas: string[]) =>
  parseDefinition({
    name: "role", display: "Role", model: "installation-brain", persona: "agent/persona.md",
    role: "creative",
    grants: [{ capability: "vault", scope: "write-with-confirm", areas }],
    autonomy: { vault: "gated" },
  });

describe("grantedToolNames — the vault area gate", () => {
  it("offers only the tools of the areas the declaration names", () => {
    expect(grantedToolNames(AREAS_CATALOGUE, areaDef(["private"])))
      .toEqual(["agent-kit__vault_read", "set_language"]);
    expect(grantedToolNames(AREAS_CATALOGUE, areaDef(["shared"])))
      .toEqual(["set_language", "vault_read"]);
    expect(grantedToolNames(AREAS_CATALOGUE, areaDef(["facts"])))
      .toEqual(["remember", "set_language"]);
  });

  it("a facts-only grant is offered NO note tool — the case owner decision C1 exists for", () => {
    // A trip agent holds standing facts and no note store. Before the merge that was the
    // absence of a `brain`/`atlas` grant; one capability over three stores would have handed it
    // both note areas on the strength of the one grant it does need.
    const names = grantedToolNames(AREAS_CATALOGUE, areaDef(["facts"]));
    expect(names).not.toContain("agent-kit__vault_read");
    expect(names).not.toContain("vault_read");
  });

  it("a note-area grant is offered no fact tool either — the gate cuts both ways", () => {
    for (const area of ["private", "shared"]) {
      expect(grantedToolNames(AREAS_CATALOGUE, areaDef([area])), area).not.toContain("remember");
    }
  });

  it("adds areas additively, and never more than were named", () => {
    expect(grantedToolNames(AREAS_CATALOGUE, areaDef(["private", "shared", "facts"])))
      .toEqual(["agent-kit__vault_read", "remember", "set_language", "vault_read"]);
  });

  it("a vault tool whose area nothing declares is FAIL-CLOSED, not offered", () => {
    // Neither the engine table nor the entry names an area for it, so there is no area to hold
    // the grant against — and the answer to "which area is this?" is never "any of them".
    for (const areas of [["private"], ["shared"], ["facts"], ["private", "shared", "facts"]]) {
      expect(grantedToolNames(AREAS_CATALOGUE, areaDef(areas)), areas.join("+"))
        .not.toContain("undocumented_vault_tool");
    }
  });

  it("the entry's own `area` covers a tool the engine documents nowhere — and only that case", () => {
    // The permissions-eval pool's fixture tool is the real instance of this: no capability doc,
    // so no entry in the engine table. The catalogue may name its area; it may NOT relabel a
    // tool the engine table already knows, which is what the next assertion holds.
    const declared = {
      ...AREAS_CATALOGUE,
      undocumented_vault_tool: { capability: "vault", area: "shared" as const, tool: { description: "no doc" } },
      // A lie: this tool reads the PRIVATE store, whatever the catalogue says here.
      "agent-kit__vault_read": { capability: "vault", area: "shared" as const, tool: { description: "private read" } },
    };
    expect(grantedToolNames(declared, areaDef(["shared"]))).toContain("undocumented_vault_tool");
    expect(grantedToolNames(declared, areaDef(["shared"]))).not.toContain("agent-kit__vault_read");
    expect(grantedToolNames(declared, areaDef(["private"]))).toContain("agent-kit__vault_read");
  });

  it("leaves every other capability alone — the second narrowing is the vault's alone", () => {
    const names = grantedToolNames(AREAS_CATALOGUE, parseDefinition({
      name: "role", display: "Role", model: "installation-brain", persona: "agent/persona.md",
      role: "creative",
      grants: [{ capability: "studio", scope: "write" }],
      autonomy: { studio: "gated" },
    }));
    expect(names).toEqual(["set_language", "studio_ideate"]);
  });
});
