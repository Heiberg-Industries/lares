// The tool catalogue (ADR-0015 rule 3/4; agent-definitions spec, Part 3).
//
// Until ORB-278 step 2 a role service's tools were files under agent/tools/, always present, and
// what an agent held was decided by which files its image shipped. Now the files are a POOL and
// the definition picks from it at session start: an ungranted tool never reaches the model.
//
// This module is the PURE half — which names a definition grants — so it unit-tests without eve.
// The eve half is one `defineDynamic` in each service's agent/tools/catalogue.ts, and it must
// keep its `execute` INLINE: eve's bundler reconstructs a dynamic tool's execute from stored
// closure variables when a step replays after a crash or an approval pause, and it does NOT
// detect `execute: someFunction` (eve docs, guides/dynamic-capabilities.md).
//
// A CATALOGUE ENTRY CARRIES ITS OWN APPROVAL, and the resolver copies it across. Task 1 measured
// this (docs/research/2026-09-16-eve-0.32-dynamic-seams.md, Q1c): a resolver-emitted tool
// REPLACES an authored `agent/tools/<name>.ts` completely — description, executor and approval.
// In the fixture the catalogue's `atlas_write` answered immediately because the override had
// dropped the authored file's `boardApproval(...)`. Drop the approval here and a gated write
// ships ungated.
//
// The checks that ran at build time still run, here, per session:
//   - the scope matrix answers first (lib/capabilities.ts:32): ungranted or `none` -> not present;
//   - `never` is a hard deny over the grant, reads included (decide.ts:31);
//   - a WRITE-CLASS tool under a grant that does not reach the write class is not present;
//   - assertClassMatchesScope: a tool carrying an approval under a plain `write` grant THROWS.
// "Write-class" means "carries an approval" for every tool but the ones whose entry sets
// `asksWithoutWriting` — see that field. W7D-s3 added the first: a READ that asks first.
import { areaOfTool } from "./always-ask.js";
import {
  assertClassMatchesScope,
  assertSkillsWithinGrants,
  autonomyOf,
  grantedVaultAreas,
  grantFor,
  scopeAtLeast,
  skillFor,
  type ResolvableTool,
  type Scope,
  type VaultArea,
} from "./manifest.js";
import type { AgentDefinition } from "./definition.js";

/** The one capability whose grant is narrowed a second time, by area (ADR-0017 rule 1). */
const VAULT_CAPABILITY = "vault";

export interface CatalogueEntry {
  /** Which capability's grant decides whether this tool is handed over. */
  capability: string;
  /** For a `vault` entry only: the area of the Vault this tool touches, and therefore the area
   *  the declaration must grant before the tool is handed over (W5C-s5/s6).
   *
   *  The ENGINE's own table (`areaOfTool`) wins wherever it knows the tool, so a catalogue
   *  cannot relabel a documented tool into an area its agent happens to hold. This field exists
   *  for the one case the engine table cannot cover — a tool that has no capability doc, which
   *  today is the permissions-eval fixture pool — and it is still only ever a requirement: a
   *  `vault` entry with no area from either source is NOT offered. */
  area?: VaultArea;
  /** The code skill this tool belongs to, if any (LAR-5). When set, the entry additionally
   *  needs the SAME view `resolveSkillTool` (manifest.ts:345-358) uses to gate a skill's own
   *  tool: the skill must be declared, `assertSkillsWithinGrants` must pass (never-widen), and
   *  no capability the skill composes may carry a `never` autonomy. This is what makes removing
   *  a skill in the console really take its tool away, rather than leaving a dynamic override
   *  that eve's extension merge cannot see (docs/research/2026-09-16-eve-0.32-dynamic-seams.md). */
  skill?: string;
  /**
   * This tool's approval gate does NOT make it a write (W7D-s3).
   *
   * Everywhere else in this file, "carries an approval" is read as "is a write-class action",
   * because until now it always was: every gated tool in the fleet sends mail, moves a calendar,
   * writes a note or changes a CRM row, and a `read`-scoped grant must not reach any of them.
   *
   * `read_url` is the first counterexample and the reason this field exists. It fetches and
   * returns text — a read, by any reading of the word — and it asks first only when the TURN has
   * already read somebody else's words (`tainted-approval.ts`), because an address inside
   * someone else's message is the cheapest way to make this box do an attacker's outbound
   * request. Inferring "write" from the gate would have had two owner-visible consequences, both
   * wrong: the tool would silently vanish from a `read`-scoped installation (which is what
   * happened, caught by the tool-list snapshot), and the persona would tell the model it
   * "writes behind a confirmation card" about a tool that writes nothing.
   *
   * IT IS A CLAIM THE ENGINE MAKES, NEVER AN INSTALLATION. This lives on the catalogue ENTRY —
   * engine code, compiled into the image — not in `agent.json`, so no definition can use it to
   * slip a real write under a `read` grant. Set it only on a tool whose entire effect is to
   * return information to the model, and whose gate exists to make a human look first.
   */
  asksWithoutWriting?: true;
  /** The tool value, as authored. `ResolvableTool` is structural for the reason manifest.ts's
   *  own docblock gives: eve's `Approval<…>` is invariant and rejects even the `any` form. */
  tool: ResolvableTool;
}

export type Catalogue = Record<string, CatalogueEntry>;

/** Tools no definition can remove. `set_language` is not a capability and has no grant: an owner
 *  must always be able to say "answer me in English", whatever their agent is set up to speak.
 *
 *  Ruling R2: an always-present tool still needs a `capability` field to sit in a catalogue, so it
 *  carries the pseudo-capability `ALWAYS_PRESENT_CAPABILITY`. Nothing ever grants it and nothing
 *  ever looks it up — the loop below short-circuits these names before any grant lookup — but it
 *  keeps `CatalogueEntry` honest and it is what each service's catalogue-index test exempts. */
export const ALWAYS_PRESENT: readonly string[] = ["set_language"];

/** The capability an always-present tool carries. Deliberately NOT in `KNOWN_CAPABILITIES` and
 *  NOT in `CAPABILITY_DOCS`: it is a placeholder, not a thing an agent can be granted. */
export const ALWAYS_PRESENT_CAPABILITY = "language";

/** The scope at which a write-class tool — one carrying its own approval — becomes reachable.
 *  Below this, the grant simply does not extend to that tool. */
const WRITE_CLASS_SCOPE: Scope = "write-with-confirm";

export function grantedToolNames(
  catalogue: Catalogue,
  d: AgentDefinition,
  opts: { alwaysPresent?: readonly string[] } = {},
): string[] {
  const always = new Set(opts.alwaysPresent ?? ALWAYS_PRESENT);
  const out: string[] = [];
  // ONE derivation of the open areas for the whole resolution, and the SAME one the note tools
  // ask at call time (`grantedVaultAreas`, manifest.ts) — so the list of tools this session was
  // handed and each tool's own refusal can never disagree.
  const openAreas = new Set(grantedVaultAreas(d));

  for (const [name, entry] of Object.entries(catalogue)) {
    if (always.has(name)) { out.push(name); continue; }

    const grant = grantFor(d, entry.capability);
    if (!grant || grant.scope === "none") continue;
    if (autonomyOf(d, entry.capability) === "never") continue;

    // THE AREA CHECK — the second narrowing `vault` needs and no other capability does.
    //
    // Before the merge, a vault tool's capability WAS its area: an agent granted `memory` and
    // not `brain` was offered the fact tools and none of the personal store's. One capability
    // over three stores would have thrown that away — a `vault` grant for the facts alone would
    // have handed over the personal note tools — so the area each tool touches is required
    // here, against the areas the declaration actually names. It only ever takes a tool away:
    // an area the declaration did not grant, or a vault tool whose area nothing declares, is
    // fail-CLOSED and simply not present, the same shape the scope matrix below uses.
    if (entry.capability === VAULT_CAPABILITY) {
      const area = areaOfTool(name) ?? entry.area;
      if (area === undefined || !openAreas.has(area)) continue;
    }

    // A SKILL-GATED ENTRY (LAR-5-s1). Reuses `resolveSkillTool`'s own view rather than
    // re-deriving it: the skill must be declared, its `requires` must sit inside the grants
    // (`assertSkillsWithinGrants` throws on a widening declaration — the never-widen property,
    // enforced here too, not just at build), and no capability it composes may be switched off
    // with a `never` autonomy, because a skill cannot outlive the access it composes.
    if (entry.skill !== undefined) {
      assertSkillsWithinGrants(d);
      const decl = skillFor(d, entry.skill);
      if (!decl) continue;
      if (decl.requires.some((req) => autonomyOf(d, req.capability) === "never")) continue;
    }

    // THE SCOPE MATRIX, WHICH THE BUILD-TIME SEAM COULD NOT EXPRESS. `resolveExtensionTool` saw
    // one tool at a time against one capability's grant, so a gated tool under a `read` grant had
    // nowhere to go but a throw. A catalogue sees the whole pool, and the honest answer is
    // narrower rather than fatal: a capability is a DOMAIN spanning both action classes
    // (`lib/capabilities.ts:33-34`), so `atlas` at `read` hands over the three Atlas reads and
    // simply does not reach `atlas_write`. Dropping is fail-CLOSED — the tool is gone, not
    // ungated — which is why it needs no throw.
    // `asksWithoutWriting` (see the field's own docblock) takes the tool out of BOTH lines: a
    // read that asks first is not reached by the write class at all, so neither the narrowing nor
    // the contradiction below has anything to say about it.
    if (entry.tool.approval !== undefined && entry.asksWithoutWriting !== true) {
      if (!scopeAtLeast(grant.scope, WRITE_CLASS_SCOPE)) continue;

      // Build-time guarantee, kept as a session-time guarantee, for the one case that is a
      // genuine contradiction rather than a narrower grant: a plain `write` says the action runs
      // with NO card while the tool's own gate says it is confirm-class. It THROWS rather than
      // dropping the tool, because a declaration that misstates what its tools can do is a
      // silently ungated write, which is the one failure this check exists to prevent.
      assertClassMatchesScope(entry.tool, grant);
    }

    out.push(name);
  }

  return out.sort();
}
