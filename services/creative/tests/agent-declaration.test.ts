// lares-split hook 30: neutral fixture (ORB-262) — installation-only assertions retargeted; see the lares split plan.
/**
 * eve-calliope's agent declaration (ORB-135 Task 5) — the conformance test for `agent.json`.
 *
 * Ported from `services/travel/tests/agent-declaration.test.ts`, which is the ORB-144
 * template. Three of its checks exist because nowhere else in the codebase can run them:
 *
 *  1. `assertDeclarationIntegrity` is OPT-IN — the kit cannot force a call, so without a caller
 *     it enforces nothing. It is called for real from `agent/agent.ts` AND from
 *     `agent/extensions/agent-kit/extension.ts`, both of which `eve build` evaluates once per
 *     build, and asserted here so a broken declaration fails BOTH the build and the suite.
 *  2. BOTH halves of the class check. The aggregate half — "a `write-with-confirm` capability
 *     has at least one gated tool" — cannot live in the kit's per-tool resolver, because a
 *     capability spans both action classes; this file is the only place all of a capability's
 *     tools are visible at once. The per-tool half — a gated tool under a grant that is NOT
 *     write-with-confirm, i.e. a declaration understating the agent's power — IS the kit's
 *     `assertClassMatchesScope`, but the kit only ever sees extension tools; this file runs it
 *     across her five LOCAL tools too, which nothing else enforces.
 *  3. The twelve extension tools resolving DISABLED under her manifest. She grants none of
 *     `brain`, `orakel` or `transit`, and for her the `brain` half is the load-bearing one: a
 *     Brain write reaching an ideation agent would put her inside Bendik's personal vault,
 *     which this service must never touch.
 *
 * TWO DIFFERENCES FROM MARCEL'S VERSION, both deliberate:
 *
 *  - His asserts a hardcoded authored-tool COUNT (18), taken from the ORB-144 baseline off his
 *    deployed container. Calliope has no deployed eve baseline yet, so a count would be a
 *    number invented in this file and then asserted against itself. Her real set is asserted
 *    by NAME instead, which is strictly stronger: it catches a rename, not merely an addition.
 *  - He has a second file, `tests/agent-kit-tools-disabled.test.ts`, that overlaps the third
 *    block below. Calliope has ONE file. The overlap is near-total — both assert "one override
 *    file per contributed tool, and every one resolves to a sentinel" — and the single thing
 *    his second file does that his first does not is anchor the comparison on the extension's
 *    SOURCE directory (`packages/agent-kit/extension/tools/`) rather than on the built
 *    `@lares/agent-kit/tools` barrel. That distinction is worth keeping (a stale `dist/` would
 *    otherwise make both sides of a barrel-only comparison agree), so it is folded in below as
 *    one extra assertion rather than as a second file with its own header, imports and
 *    directory walk. Two files that must be edited together, and whose relationship needs a
 *    paragraph to explain, are a worse guard than one file that checks both anchors.
 *
 * CAPABILITY_TOOLS below is deliberately written here and not in the kit (ORB-144 Ruling 2):
 * a full capability→tool registry for the whole fleet is Phase-2 work, and a half-registry in
 * the shared package would be a second, non-authoritative copy of the truth.
 */
import { describe, it, expect, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDisabledToolSentinel } from "eve/tools";
import {
  assertClassMatchesScope,
  assertDeclarationIntegrity,
  grantedVaultAreas,
  grantFor,
  isGranted,
  KNOWN_CAPABILITIES,
} from "@lares/agent-kit/manifest";
import { assertNoUngatedWrites } from "@lares/agent-kit/write-shape-lint";
// The kit's own barrel of everything its extension contributes — imported so the "exactly
// twelve" check below asks the KIT what must be overridden, instead of comparing this file's
// map against a directory this file also owns. A thirteenth kit tool with no override file would
// otherwise mount un-resolved, governed by no agent.json at all. (ORB-168 was the
// eleventh-tool case: it turned this assertion red in all three agents at once, as designed.)
import * as kitTools from "@lares/agent-kit/tools";
// ORB-278 step 2, Task 7: what a session is actually given out of the `catalogue/` pool. Imported
// rather than re-listed so this file cannot drift from the resolver it is checking.
import { grantedToolNames } from "@lares/agent-kit/catalogue";
import { parseDefinition } from "@lares/agent-kit/definition";
import { CATALOGUE } from "../catalogue/index.js";

import manifest from "../agent.json";

// The raw JSON module widens `scope` to `string`; the typed accessors want the parsed form.
// This is also the assertion of check (1) above — a bad declaration throws right here, at
// import time, and takes every test in this file with it.
const declaration = assertDeclarationIntegrity(manifest);

/** The folder holding agent.json — what the write-shape lint (ORB-199) walks. */
const AGENT_DIR = resolve(import.meta.dirname, "..");

// Static importers, not a template-literal `import()` — Vite cannot resolve a fully dynamic
// specifier, and a test that cannot import the thing it guards guards nothing.
const EXTENSION_TOOLS: Record<string, () => Promise<{ default: unknown }>> = {
  vault_drop: () => import("../agent/extensions/agent-kit/tools/vault_drop.js"),
  vault_file: () => import("../agent/extensions/agent-kit/tools/vault_file.js"),
  vault_write: () => import("../agent/extensions/agent-kit/tools/vault_write.js"),
  market_edge: () => import("../agent/extensions/agent-kit/tools/market_edge.js"),
  orakel_enrich_domain: () => import("../agent/extensions/agent-kit/tools/orakel_enrich_domain.js"),
  orakel_enrich_org: () => import("../agent/extensions/agent-kit/tools/orakel_enrich_org.js"),
  orakel_search: () => import("../agent/extensions/agent-kit/tools/orakel_search.js"),
  signals_recent: () => import("../agent/extensions/agent-kit/tools/signals_recent.js"),
  transit_plan: () => import("../agent/extensions/agent-kit/tools/transit_plan.js"),
  vault_backlinks: () => import("../agent/extensions/agent-kit/tools/vault_backlinks.js"),
  vault_list: () => import("../agent/extensions/agent-kit/tools/vault_list.js"),
  vault_read: () => import("../agent/extensions/agent-kit/tools/vault_read.js"),
  vault_search: () => import("../agent/extensions/agent-kit/tools/vault_search.js"),
};

/** Every capability Calliope declares, mapped to the authored tools that back it.
 *
 *  `vault` holds three reads and one gated write, which is the point `@lares/agent-kit/manifest`'s
 *  header makes about `lib/capabilities.ts:33-34`: a capability is a DOMAIN spanning both action
 *  classes, and its scope names the strongest action it permits — not a claim about every tool
 *  under it. That is why `vault_search` carrying no approval under a `write-with-confirm` grant
 *  is correct rather than a mismatch.
 *
 *  W5C-s3 folded the three `atlas_*` reads into the one area-taking set, and W5C-s5/s6 folded
 *  the capability itself into `vault`. What used to be said by the capability NAME — which store
 *  these four touch — is said by the grant's `areas` now, which is `["shared"]` and nothing
 *  else. So the guarantee below, that this role never reaches the personal store, is enforced
 *  twice against her declaration: the session seam never offers her a private-area tool
 *  (`grantedToolNames`), and the tools themselves refuse the area (`lib/vault-areas.ts`).
 *
 *  Note what is NOT here: the private area, and `orakel`. She is an ideation agent grounded on
 *  the business store; she has no business in the owner's personal vault or in company data.
 *  That omission is the whole mechanism by which the ten extension tools disappear. */
const CAPABILITY_TOOLS: Record<string, readonly string[]> = {
  studio: ["studio_ideate"],
  vault: ["vault_search", "vault_read", "vault_list", "vault_write"],
};

/** `set_language` (ORB-278 step 2, Task 6) is deliberately absent from `CAPABILITY_TOOLS`: it is
 *  ALWAYS present, carries no grant and is not a capability — an owner must always be able to
 *  switch a conversation's language whatever the agent's declaration says. It is exempted BY
 *  NAME below, everywhere this file otherwise demands "every authored tool maps to a
 *  capability" — the same shape Ruling R2 (2026-09-16 SDD ledger) records for the plan's later
 *  catalogue move. */
const ALWAYS_PRESENT_TOOLS = new Set(["set_language"]);

/** Her real authored surface, by name. Deliberately a NAME list and not a count — see this
 *  file's header. A rename, an addition, or a deletion all land here. */
const AUTHORED_TOOLS = [
  "vault_write",
  "set_language",
  "studio_ideate",
  "vault_list",
  "vault_read",
  "vault_search",
] as const;

/** Load every authored tool in the `catalogue/` pool, keyed by slug.
 *
 *  THE DIRECTORY MOVED, THE CHECK DID NOT (ORB-278 step 2, Task 7 — ADR-0015 rule 3). Her tools
 *  used to be files under agent/tools/ and were therefore always present; they are now a POOL that
 *  agent/tools/catalogue.ts picks from at session start against the resolved definition. What is
 *  left under agent/tools/ is the eight `disableTool()` sentinels plus that one resolver, which is
 *  a seam and not a tool — `tests/tool-harness.test.ts` is what guards that directory now, and
 *  `tests/catalogue-index.test.ts` holds the pool against catalogue/index.ts in both directions.
 *
 *  The sentinel drop below is kept even though the pool holds no sentinels: a `disableTool()` file
 *  appearing in catalogue/ would be a tool nothing can ever hand over, and it must not be able to
 *  satisfy `CAPABILITY_TOOLS` by merely existing.
 *
 *  A disable sentinel is dropped because of what it IS, not because of its name — so the day
 *  one of the eight framework disables stops being a sentinel it arrives here as an authored
 *  tool and the checks below turn red. That is the guard that matters: `agent/tools/bash.ts`
 *  edited back into eve's real `bash` would hand her unsandboxed shell inside a container with
 *  the Atlas mounted.
 *
 *  Marcel's version of this loader carries a second, name-based skip for framework defaults he
 *  RE-ENABLES with an authored file (`web_search`). Calliope re-enables none — her three
 *  surviving defaults (`ask_question`, `todo`, `load_skill`) have no file under `agent/tools/`
 *  at all, enabled by absence, and `tests/tool-harness.test.ts` guards that trio — so the skip
 *  is deliberately absent rather than present-and-empty. Whoever re-enables a default here
 *  adds it back, and its absence today means nothing is exempt from the inspection above. */
async function loadLocalTools(): Promise<Map<string, { approval?: unknown }>> {
  const dir = join(import.meta.dirname, "..", "catalogue");
  const out = new Map<string, { approval?: unknown }>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
    const mod = (await import(join(dir, file))) as { default: unknown };
    if (isDisabledToolSentinel(mod.default)) continue;
    out.set(file.replace(/\.ts$/u, ""), mod.default as { approval?: unknown });
  }
  return out;
}

describe("eve-calliope agent.json", () => {
  it("passes assertDeclarationIntegrity", () => {
    expect(() => assertDeclarationIntegrity(manifest)).not.toThrow();
  });

  it("names the agent and declares sealed egress (the neutral default opens no door)", () => {
    expect(declaration.name).toBe("creative");
    expect(declaration.egress.sealed).toBe(true);
    expect(declaration.channels).toEqual([]);
  });

  it("points `persona` at a real, non-empty file", () => {
    // Resolved, not re-spelled: point `persona` at a file that is not there and this goes red.
    // Resolution is relative to the directory agent.json lives in, matching the old runtime's
    // adapters/loader.ts — so "agent/instructions.md" resolves to
    // services/creative/agent/instructions.md.
    //
    // Until ORB-145 Phase 3 Task 10 this field pointed OUT of the service, at
    // ../agent-runtime/agents/calliope/persona.md, and tests/instructions.test.ts hashed the two
    // files to prove the shipped copy had not drifted from that canonical one. There is no copy
    // any more: instructions.md is ASSEMBLED from agent.json + the shared `creative` role
    // template + agent/voice.md, so `persona` names a file this service owns and builds, and the
    // drift guard is the assembler comparison in that same test file.
    const personaPath = resolve(dirname(resolve(import.meta.dirname, "../agent.json")), declaration.persona);
    expect(existsSync(personaPath), `agent.json persona "${declaration.persona}" → ${personaPath}`).toBe(true);
    expect(readFileSync(personaPath, "utf8").trim().length).toBeGreaterThan(0);
  });

  it("declares only known capabilities, each exactly once", () => {
    const names = declaration.grants.map((g) => g.capability);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(KNOWN_CAPABILITIES).toContain(name);
  });

  it("scopes `vault` write-with-confirm and `studio` a plain write — one gate, and it means something", () => {
    // Both capabilities were write-with-confirm for one day (controller Ruling 1, on the
    // ticket's stated intent that an expensive run deserves a confirmation). Bendik's call on
    // 2026-08-24, after seeing the first live card, moved `studio` down: the gate had no
    // decision content — he is the only principal who can reach her and had asked for the run
    // in the message directly above — and it devalued the `vault_write` gate beside it.
    //
    // The scope, not just the autonomy dial, is what carries that. Under the ported governance
    // semantics (@lares/agent-kit/manifest's header, from agent-runtime's governance/decide.ts)
    // the scope matrix answers FIRST: a plain `write` is allowed outright and autonomy bites
    // only on the confirm class. So `write` + `autonomous` says "runs without asking" twice
    // over, and the old `read` + `gated` in the pre-port declaration said no gate at all while
    // looking like it said the opposite — which is the misreading this assertion exists to stop
    // in either direction.
    expect(grantFor(declaration, "studio")?.scope).toBe("write");
    expect(grantFor(declaration, "vault")?.scope).toBe("write-with-confirm");
    // W5C-s6: and the areas are what the capability name used to carry — the shared store only.
    expect(grantFor(declaration, "vault")?.areas).toEqual(["shared"]);
    // The template ships every grant `gated`; walking `studio` to autonomous is an installation's
    // own later decision (Calliope's, 2026-08-24 — see templates/creative/README.md).
    expect(declaration.autonomy).toEqual({ studio: "gated", vault: "gated" });
  });

  it("is resolved from the definition at one scope only — the step", async () => {
    // ORB-278 step 2: `model` is a dynamic resolver — the definition picks the model per
    // conversation, and there is no compiled fallback carrying a build-time alias any more
    // (eve 0.33.0 removed it). Since eve 0.60 the only scope that may return a constructed
    // provider is `step.started`; `session.started` and `turn.started` are resolved durably and
    // would accept only a model-id STRING, which eve routes through the Vercel AI Gateway
    // instead of the LiteLLM one. The alias is pinned on the first step, so this is still one
    // model per conversation — the system prompt and the model are what the prompt cache keys
    // on, and re-picking per turn re-bills the whole conversation.
    //
    // That the alias actually is `declaration.model` is asserted in tests/boot.test.ts, which
    // stands in for eve session state so the real resolver can run.
    const agent = (await import("../agent/agent.js")).default as {
      model?: { fallback?: unknown; events?: Record<string, unknown> };
    };
    expect(Object.keys(agent.model?.events ?? {})).toEqual(["step.started"]);
    expect(agent.model?.fallback).toBeUndefined();
  });
});

describe("eve-calliope extension tools resolve under the declaration", () => {
  it("grants none of `brain`, `orakel` or `transit` — the reason all twelve disappear", () => {
    // Not "declares them at scope none", not "sets autonomy never": SILENT. The strongest form
    // of least privilege the schema allows, and the one a reader of agent.json can see at a
    // glance. Every assertion below this one is downstream of these three absences.
    //
    // `transit` (ORB-168) is the one that makes Calliope's role in this proof visible. eve-saga
    // and eve-marcel BOTH grant it, so the byte-identical `transit_plan.ts` resolves live in
    // both of them; she is the only agent left where it is still a sentinel, which is what
    // keeps the "the declaration, not the code, is the difference" claim falsifiable. An
    // ideation agent has no business planning Bendik's train journeys.
    // W5C-s6: the personal store is no longer a capability to withhold, it is an AREA — so the
    // same guarantee is now stated on the grant this role DOES hold, which is a finer check
    // than the absent-capability one it replaces.
    expect(grantFor(declaration, "vault", "private")).toBeUndefined();
    expect(grantFor(declaration, "vault", "facts")).toBeUndefined();
    expect(grantedVaultAreas(declaration)).toEqual(["shared"]);
    expect(grantFor(declaration, "orakel")).toBeUndefined();
    expect(grantFor(declaration, "transit")).toBeUndefined();
    expect(isGranted(declaration, "orakel")).toBe(false);
    expect(isGranted(declaration, "transit")).toBe(false);
  });

  // The whole point of ORB-144: these twelve files are IDENTICAL to eve-saga's and
  // eve-marcel's — `diff -r` across all three directories is empty. In eve-saga every one of
  // them resolves to a live tool, and in eve-marcel one of them does (ORB-168's `transit_plan`,
  // which he grants); here every one must be a disable sentinel. A green test in eve-saga's
  // matching block plus a green test here is the proof that the DECLARATION, not the code, is
  // what differs between the agents.
  for (const [slug, load] of Object.entries(EXTENSION_TOOLS)) {
    it(`keeps agent-kit__${slug} disabled`, async () => {
      expect(isDisabledToolSentinel((await load()).default)).toBe(true);
    });
  }

  it("overrides exactly what @lares/agent-kit contributes — no more, no less", () => {
    // THE KIT IS THE SOURCE OF TRUTH HERE, not this file and not the override directory.
    // Comparing the directory against EXTENSION_TOOLS alone would compare this test file to
    // itself: the kit could gain a twelfth tool, no override file would exist for it, eve
    // would mount it un-resolved — ungoverned by any agent.json — and both sides of that
    // comparison would still agree.
    //
    // TWO ANCHORS, because they can disagree. `@lares/agent-kit/tools` is the BUILT barrel
    // (`dist/tools/index.mjs`, produced by `eve extension build`); `extension/tools/*.ts` is
    // the SOURCE eve actually mounts. A stale dist would let a barrel-only comparison pass
    // while an unoverridden tool mounted for real. This is the assertion eve-marcel keeps in a
    // separate file (tests/agent-kit-tools-disabled.test.ts) — see this file's header for why
    // it is folded in here instead.
    const contributed = Object.keys(kitTools).sort();
    const dir = join(import.meta.dirname, "..", "agent", "extensions", "agent-kit", "tools");
    const overrideFiles = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/u, ""))
      .sort();
    const extensionSource = readdirSync(
      join(import.meta.dirname, "..", "..", "..", "packages", "agent-kit", "extension", "tools"),
    )
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/u, ""))
      .sort();

    // Sanity: a comparison against an empty set would be vacuously true.
    expect(extensionSource.length).toBeGreaterThan(0);
    expect(contributed).toEqual(extensionSource);
    expect(contributed).toEqual(overrideFiles);
    expect(contributed).toEqual(Object.keys(EXTENSION_TOOLS).sort());
  });
});

describe("eve-calliope declaration ↔ authored tools", () => {
  it(
    "has exactly the five authored tools this port gives her, by name",
    async () => {
      // By NAME, not by count (see the header). The five are her whole surface: one gated
      // studio run, three ungated Atlas reads, one gated Atlas write. A sixth file, a rename,
      // or one of the eight framework disables being edited back into a real tool all land
      // here first.
      const local = await loadLocalTools();
      expect([...local.keys()].sort()).toEqual([...AUTHORED_TOOLS].sort());
    },
    30_000,
  );

  it(
    "maps every declared capability to at least one authored tool, and every authored tool to a capability",
    async () => {
      const local = await loadLocalTools();
      const authored = new Set<string>(local.keys());

      const mapped = new Set<string>();
      for (const grant of declaration.grants) {
        const tools = CAPABILITY_TOOLS[grant.capability];
        expect(tools, `capability "${grant.capability}" has no entry in CAPABILITY_TOOLS`).toBeDefined();
        expect(tools!.length, `capability "${grant.capability}" is declared but backed by no tool`).toBeGreaterThan(0);
        for (const slug of tools!) {
          expect(authored.has(slug), `CAPABILITY_TOOLS lists "${slug}", which no agent tool file provides`).toBe(true);
          mapped.add(slug);
        }
      }

      // The other direction: a new tool added without a grant would otherwise be invisible in
      // the declaration. `set_language` is the one deliberate exception — see
      // ALWAYS_PRESENT_TOOLS above.
      expect(
        [...authored].filter((s) => !mapped.has(s) && !ALWAYS_PRESENT_TOOLS.has(s)).sort(),
      ).toEqual([]);
    },
    30_000,
  );

  it(
    "gives every `write-with-confirm` capability at least one gated tool",
    async () => {
      // The aggregate half of the class check: it needs every one of a capability's tools in
      // view at once, which is why it cannot live in the kit's per-tool resolver. The
      // complementary per-tool half is the test immediately below.
      //
      // Unlike Marcel's, this loop actually RUNS — `atlas` is write-with-confirm — and it is
      // the check that would have caught the pre-port `studio: read` declaration from the other
      // side: a `read` scope would have been skipped by the `continue` below while
      // `studio_ideate` still carried `always()`, and the per-tool check beneath would then
      // have failed on the mismatch. `studio` is now a plain `write` and is skipped here by
      // design, which is why the derivation below pins the gated set absolutely rather than
      // leaning on this loop alone.
      const local = await loadLocalTools();
      // Local tools only: `CAPABILITY_TOOLS` maps none of the ten extension tools, because she
      // grants neither capability that would make one of them live. Marcel's version carries an
      // extension-tool fallback here; for her it could not execute, so it is left out until a
      // task actually maps an extension tool to one of her capabilities.
      const approvalOf = (slug: string): unknown => {
        const tool = local.get(slug);
        if (!tool) throw new Error(`no authored tool file for "${slug}"`);
        return tool.approval;
      };

      for (const grant of declaration.grants) {
        if (grant.scope !== "write-with-confirm") continue;
        const slugs = CAPABILITY_TOOLS[grant.capability] ?? [];
        expect(
          slugs.map(approvalOf).some((a) => a !== undefined),
          `agent.json declares "${grant.capability}" at write-with-confirm, but none of its ` +
            `tools (${slugs.join(", ")}) carries an approval gate`,
        ).toBe(true);
      }

      // The derivation, stated absolutely so the two halves cannot drift apart. This is the
      // assertion that bites if `approval: always()` is ever re-added to `studio_ideate`
      // without moving `studio` back to write-with-confirm — and, because it is an exact set
      // equality rather than a `some`, it also bites if the gate is re-added WITH the scope
      // change. Re-gating her studio is a decision, not a refactor; it must edit this line.
      const gated = [...local].filter(([, tool]) => tool.approval !== undefined).map(([slug]) => slug).sort();
      expect(gated, "exactly one gated tool: the Atlas write, which commits and pushes").toEqual(["vault_write"]);
      const ungated = [...local].filter(([, tool]) => tool.approval === undefined).map(([slug]) => slug).sort();
      expect(
        ungated,
        "a gate on something harmless trains you to tap without reading, which is what would " +
          "cost the vault_write gate its meaning — the three reads, the studio run and the " +
          "always-present set_language stay ungated",
      ).toEqual(["set_language", "studio_ideate", "vault_list", "vault_read", "vault_search"]);
    },
    30_000,
  );

  it(
    "declares no local tool's gate away — every gated tool sits under a write-with-confirm grant",
    async () => {
      // The direction the aggregate check above cannot see, and the one that actually catches a
      // FALSE declaration: a tool carrying an `approval` under a grant scoped anything other
      // than write-with-confirm means agent.json is understating what Calliope can do.
      //
      // The kit's `assertClassMatchesScope` already enforces this at BUILD time — but only over
      // the ten extension tools, because those are the only ones `resolveExtensionTool` ever
      // sees, and here all ten are disabled so it never runs at all. Her five are local;
      // nothing enforces it but this test.
      //
      // There is deliberately NO exemption list. If this goes red, the tool is not the problem
      // — its capability's scope in agent.json is.
      const slugToCapability = new Map<string, string>();
      for (const [capability, slugs] of Object.entries(CAPABILITY_TOOLS)) {
        for (const slug of slugs) slugToCapability.set(slug, capability);
      }

      for (const [slug, tool] of await loadLocalTools()) {
        if (ALWAYS_PRESENT_TOOLS.has(slug)) continue;
        const capability = slugToCapability.get(slug);
        expect(capability, `tool "${slug}" is not mapped to any capability`).toBeDefined();
        const grant = grantFor(declaration, capability!);
        expect(grant, `capability "${capability}" has no grant in agent.json`).toBeDefined();
        expect(
          () => assertClassMatchesScope(tool, grant!),
          `tool "${slug}" (capability "${capability}", scope "${grant!.scope}")`,
        ).not.toThrow();
      }
    },
    30_000,
  );

  it("ships no write-shaped tool under a read grant (ORB-199)", () => {
    // The other half of the check above. `assertClassMatchesScope` catches a tool that CARRIES
    // an approval gate under a grant that is not write-with-confirm — a declaration understating
    // the agent. This catches the case ORB-144 left standing and the 2026-09-01 sweep
    // re-confirmed (docs/research/2026-09-01-engine-security-sweep.md, layer 4): a tool with NO
    // gate whose code mutates anyway, under a grant of `read`. The sweep found no live instance
    // and said plainly that nothing would catch the next one. This is that catch.
    //
    // It reads the real agent.json and the real tool files. What counts as write-shape, which
    // read-that-POSTs are exempt and why, and the one-hop depth rule are all documented in
    // packages/agent-kit/src/write-shape-lint.ts's header — that header is the contributed-
    // adapter checklist, and a contributed adapter that turns this red should be read against it
    // rather than exempted here.
    //
    // `set_language` is skipped BY NAME, not because its write-shape was inspected and cleared:
    // the lint's real complaint (`lintWriteShape`'s "unmapped-tool" kind) is that it maps to no
    // capability at all — true, and deliberate (ALWAYS_PRESENT_TOOLS above). Its only write is
    // `defineState(...).update()` on the session's own language slot, never a third party.
    expect(() =>
      assertNoUngatedWrites({
        agentDir: AGENT_DIR,
        manifest: declaration,
        label: "eve-calliope",
        skip: { set_language: "ALWAYS_PRESENT, no capability, writes only its own session's language slot" },
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// framework_tools ↔ what `eve build` actually compiled (ORB-145 Phase 3, Task 9)
// ---------------------------------------------------------------------------
//
// `framework_tools` names eve's OWN built-ins this agent keeps enabled. They are not
// capabilities and not grants — `agent.json` does not govern them; an agent enables one by
// authoring `agent/tools/<name>.ts` and disables it with a `disableTool()` sentinel. The field
// exists only so the GENERATED "where I run" section can tell the truth about web search, which
// differs across the fleet: Marcel keeps `web_search` enabled, Saga and Calliope disable it. Left to itself that is a hand-set
// flag, and a hand-set flag about a capability is exactly what produced the 2026-08-14 Wave-1
// bug. So it is asserted against the compiled manifest `eve build` writes, which is eve's own
// answer rather than ours.
//
// The compiled manifest is a build artefact under .output/ (gitignored), so this is skipped
// rather than failed when there is no build to check — visibly, as a named skip, never as a
// silent pass. `pnpm build` before `pnpm test` is what makes it run.
// Read once for both checks below. `tools` is the compiled AUTHORED tool list — the same array
// the plan's baselines count.
//
// eve 0.60.1 (W2-s8b): `webSearchProvider`/`disabledFrameworkTools` are GONE — neither name
// appears anywhere in the installed package any more. Confirmed empirically too: they were
// always `undefined`/`[]` even with disable sentinels present, which made the check below pass
// VACUOUSLY for Calliope (framework_tools correctly omits web_search, and the always-`false`
// computation from the dead fields agreed by coincidence — it would have stayed silently wrong
// had she ever declared web_search). A disabled framework tool now shows up only as a
// `kind: "disabled"` audit entry in `sourceComposition`, never in `tools` — the same unified
// model every other framework tool (task_cancel, glob, grep) already uses. So "is web_search
// live" is read off `tools` directly, like everything else.
const compiledPath = join(import.meta.dirname, "..", ".output", ".eve", "compile", "compiled-agent-manifest.json");
const compiled = existsSync(compiledPath)
  ? (JSON.parse(readFileSync(compiledPath, "utf8")) as {
      tools?: Array<{ name: string }>;
    })
  : undefined;
// `persona` is relative to the agent folder — the directory agent.json lives in, one above tests/.
const personaPath = join(import.meta.dirname, "..", declaration.persona);

describe("eve-calliope framework_tools matches the compiled manifest", () => {
  it.skipIf(compiled === undefined)("declares web_search if and only if the build left it enabled", () => {
    const declared = declaration.framework_tools.includes("web_search");
    const compiledTools = compiled!.tools ?? [];
    const compiledHasWebSearch = compiledTools.some((t) => t.name === "web_search");
    expect(
      declared,
      `agent.json framework_tools=${JSON.stringify(declaration.framework_tools)} but the compiled ` +
        `manifest's tools=${JSON.stringify(compiledTools.map((t) => t.name))} ` +
        `${compiledHasWebSearch ? "includes" : "does not include"} web_search — re-run \`pnpm build\` or fix the declaration`,
    ).toBe(compiledHasWebSearch);
  });
});

// eve FRAMEWORK built-ins that may appear in the compiled tool list without being named in the
// generated section: the section describes what the DECLARATION grants, and eve's own built-ins
// are not capabilities (the `framework_tools` field and its own conformance test above are how
// those are told the truth about).
//
// `set_language` (ORB-278 step 2, Task 6) joins it for the same reason from a different origin:
// it is OURS, not eve's, but it is likewise ALWAYS present, carries no grant and is not a
// capability — the generated section correctly says nothing about it, and the model is told
// about it by its own tool description, not by this text. See ALWAYS_PRESENT_TOOLS above.
//
// `ask_question`, `todo` and `load_skill` join it under W2-s8b, once a real build first ran this
// check (before eve 0.60.1 the branch's CI blocker meant `.output` never existed, so this whole
// describe block was always skipped, never actually exercised). All three are eve's own framework
// built-ins Calliope keeps with no sentinel of her own — see tests/tool-harness.test.ts's header
// for why each stays enabled — so none of them belong in a capability doc.
const FRAMEWORK_BUILTIN_TOOLS: ReadonlySet<string> = new Set<string>([
  "set_language",
  "ask_question",
  "todo",
  "load_skill",
]);

// The post-build truth check for the same section (ORB-145 Phase 3, Task 9 review). The
// assembler filters each capability doc's fleet-wide tool union down to the FILES this agent
// ships, which is cheap and runs inside the build — but a file can be present and still not
// ship: a `disableTool()` sentinel, or an extension tool the declaration's own scope check
// disables at build time. Only the compiled manifest knows. So the committed instructions.md is
// held against it: every backticked name in "where I run" must be a tool `eve build` actually
// compiled, or the persona is naming something the model cannot call.
//
// Skipped, by name, when there is no build to check against or the persona has not been
// assembled yet — never silently passed.
describe("eve-calliope instructions.md names only tools the build compiled", () => {
  const persona = existsSync(personaPath) ? readFileSync(personaPath, "utf8") : "";
  const start = persona.search(/^# .+ — where I run$/mu);
  const environment = ((): string | undefined => {
    if (start < 0) return undefined;
    const rest = persona.slice(start).split("\n").slice(1).join("\n");
    const next = rest.search(/^# .+ — /mu);
    return next < 0 ? rest : rest.slice(0, next);
  })();
  // WHAT "COMPILED" MEANS AFTER ORB-278 step 2 (Task 7). eve records a dynamic resolver, never its
  // entries — `dynamicTools: [{ slug: "catalogue" }]` and `tools: []` — because deciding the
  // entries at session start is the whole point of the move. So the authoritative post-build tool
  // set is what eve compiled statically PLUS what this declaration grants out of the pool,
  // computed by the same `grantedToolNames` the resolver itself calls (agent/tools/catalogue.ts)
  // and the registry reports (agent/instrumentation.ts). Reading `compiled.tools` alone would
  // leave this set empty and both directions below vacuously green.
  const compiledTools = compiled
    ? new Set([...(compiled.tools ?? []).map((t) => t.name), ...grantedToolNames(CATALOGUE, parseDefinition(manifest))])
    : undefined;

  it.skipIf(compiledTools === undefined || environment === undefined)(
    "every backticked name in the where-I-run section is in the compiled tool list",
    () => {
      const named = [...environment!.matchAll(/`([^`]+)`/gu)].map((m) => m[1]);
      expect(named.length, "no tools named at all — the section did not render").toBeGreaterThan(0);
      for (const name of named) {
        expect(
          compiledTools!.has(name),
          `instructions.md names \`${name}\`, which eve build did not compile — re-run \`pnpm run assemble\` and \`pnpm build\``,
        ).toBe(true);
      }
    },
  );

  // THE OTHER DIRECTION (ORB-145 whole-branch review, Important #2). The assertion above catches
  // over-claiming only — a persona naming a tool that isn't there. The under-claim is the worse
  // half and the one that actually shipped: `commercial_who_to_contact` was compiled, callable,
  // and named nowhere, because a skill has no capability doc and the skills block printed no
  // tool names. Under "**My only capabilities are the tools below.**" a missing name is an
  // instruction not to use the tool. Both directions together are what make that heading true.
  it.skipIf(compiledTools === undefined || environment === undefined)(
    "every tool the build compiled is named in the where-I-run section",
    () => {
      const named = new Set([...environment!.matchAll(/`([^`]+)`/gu)].map((m) => m[1]));
      const missing = [...compiledTools!].filter((n) => !named.has(n) && !FRAMEWORK_BUILTIN_TOOLS.has(n)).sort();
      expect(
        missing,
        `eve build compiled ${missing.length} tool(s) the persona never names: ${missing.join(", ")} — ` +
          `add them to the capability doc (or KNOWN_SKILL_TOOLS) they belong to and re-run ` +
          `\`pnpm run assemble\`, or exempt them in FRAMEWORK_BUILTIN_TOOLS if they are eve's own`,
      ).toEqual([]);
    },
  );
});
