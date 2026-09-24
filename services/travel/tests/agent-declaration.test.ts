// lares-split hook 30: neutral fixture (ORB-262) — installation-only assertions retargeted; see the lares split plan.
/**
 * eve-marcel's agent declaration (ORB-144 Task 3) — the conformance test for `agent.json`.
 *
 * Marcel is the negative half of ORB-144's proof. eve-saga carries twelve
 * `agent/extensions/agent-kit/tools/*.ts` override files; Marcel carries the SAME TWELVE
 * FILES, byte for byte except one (see below), and — since ORB-278 step 2 Task 8 — every one of
 * them resolves to a disable sentinel, unconditionally. That was not always true: from ORB-168
 * until this task, `transit_plan.ts` resolved LIVE here because his declaration grants `transit`.
 * It still does; what changed is WHERE that grant now takes effect. `agent-kit__transit_plan` is
 * emitted from Marcel's OWN catalogue (`catalogue/agent-kit__transit_plan.ts`, through
 * `agent/tools/catalogue.ts`) instead of from this extension mount, because a resolver-emitted
 * tool REPLACES an authored/mounted tool of the same name completely (Task 1, Q1c) — both trying
 * to answer the same prefixed key at once would collide. So `transit_plan.ts` here diverges from
 * Saga's byte-identical copy on purpose (her tools are not a catalogue yet — that is Task 9).
 *
 * Three of its checks exist because nowhere else in the codebase can run them (same three as
 * eve-saga's own tests/agent-declaration.test.ts — this file mirrors it deliberately):
 *
 *  1. `assertDeclarationIntegrity` is OPT-IN — the kit cannot force a call. It is called for
 *     real from `agent/extensions/agent-kit/extension.ts` (which `eve build` evaluates once
 *     per build) and asserted here, so a broken declaration fails BOTH the build and the
 *     suite. Without a caller it would enforce nothing.
 *  2. BOTH halves of the class check. The aggregate half — "a `write-with-confirm`
 *     capability has at least one gated tool" — cannot live in the kit's per-tool resolver,
 *     because a capability spans both action classes; this file is the only place all of a
 *     capability's tools are visible at once. The per-tool half — a gated tool under a grant
 *     that is NOT write-with-confirm, i.e. a declaration understating the agent's power — IS
 *     the kit's `assertClassMatchesScope`, but the kit only ever sees the twelve extension
 *     tools (and, since Task 8, all twelve of THOSE are dead sentinels); this file runs it
 *     across Marcel's twenty-one catalogue tools too, which nothing else enforced before.
 *  3. ALL TWELVE of the twelve extension tools resolving DISABLED under this manifest is the
 *     concrete assertion that this mount contributes nothing to Marcel any more — his one kit
 *     tool comes from his own catalogue now, checked separately below.
 *
 * CAPABILITY_TOOLS below is deliberately written here and not in the kit (ORB-144 Ruling 2):
 * a full capability→tool registry for the whole fleet is Phase-2 work, and a half-registry in
 * the shared package would be a second, non-authoritative copy of the truth.
 */
import { describe, it, expect } from "vitest";
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
// map against a directory this file also owns. A thirteenth kit tool with no override file
// would otherwise mount un-resolved, governed by no agent.json at all — and for Marcel that
// means a Brain write reaching an agent that grants no `brain`. This is the exact drift
// ORB-144 exists to stop, and ORB-168 is the eleventh-tool case that proved it bites.
import * as kitTools from "@lares/agent-kit/tools";
// ORB-278 step 2, Task 8: what a session is actually given out of the `catalogue/` pool. Imported
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
// specifier, and a test that cannot import the thing it guards guards nothing (same reason
// tests/agent-kit-tools-disabled.test.ts and eve-saga's tool-harness test spell their maps
// out).
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

/** Every capability Marcel declares, mapped to the tools that back it. The union of these lists
 *  is asserted below to equal his real authored+catalogued surface, so adding a tool without
 *  giving it a capability, or declaring a capability nothing backs, goes red.
 *
 *  Note what is NOT here: `orakel` and `brain`. Marcel is a travel concierge; he has no
 *  business in Bendik's second brain or in company data. That omission is the whole
 *  mechanism by which eleven of the twelve extension tools stay dead.
 *
 *  `transit` is the one entry backed by a tool this service does not itself author — the kit's
 *  own `transit_plan` body — but which now lives in Marcel's OWN catalogue under its
 *  `agent-kit__` key rather than being reached through the extension mount (ORB-278 step 2,
 *  Task 8; ORB-168 for the grant itself). */
const CAPABILITY_TOOLS: Record<string, readonly string[]> = {
  calendar: ["calendar_list_events"],
  // Trip lifecycle. `flight_status` is a pure read and sits here anyway, for the same reason
  // eve-saga's `calendar` (write-with-confirm) contains `calendar_list_events` and
  // `calendar_free_busy`: a capability is a DOMAIN and spans both action classes — its scope
  // is the strongest action it permits, not a claim about every tool under it
  // (lib/capabilities.ts:33-34, quoted in @lares/agent-kit/manifest's own header).
  travel: ["flight_status", "link_group", "nytur", "predeparture_pack", "sveip", "trip_status"],
  places: ["nearby_places", "place_link", "transit_directions", "weather_forecast"],
  strava: ["strava_routes"],
  shopping: ["shopping_add", "shopping_remove"],
  // W5C-s5/s6: `memory` is one AREA of one `vault` capability now — `facts`, the standing
  // facts. This role is granted that area and neither note area, which is what lets it hold
  // standing facts while its own role text (W5C-s8) claims exactly that one area and no other —
  // it no longer says it has no knowledge vault at all, because it has one area of it.
  vault: ["remember"],
  persona: ["persona_overlay"],
  currency: ["currency_convert"],
  // ORB-158: the same fleet capability eve-saga already declares for its own read_url —
  // pasted links read via the sealed readability worker, a pure read.
  read_url: ["read_url"],
  admin: ["info", "toggle_kill_switch"],
  // ORB-168, and the only entry here backed by a tool this service's own catalogue holds under
  // the kit's prefixed key rather than one of its plain-named files — see this file's header.
  transit: ["agent-kit__transit_plan"],
};

/** The ONE eve default Marcel leaves enabled: `agent/tools/web_search.ts` re-enables it
 *  (old Marcel's own `webSearch_20250305` capability). It is eve's tool, not Marcel's — it
 *  does not appear in the compiled manifest's authored list, so agent.json does not govern
 *  it, and it has no place in the `catalogue/` pool (`tests/catalogue-index.test.ts` pins its
 *  absence from `CATALOGUE` directly).
 *
 *  Deliberately ONE entry, not ten. Marcel's other `agent/tools/` framework overrides are
 *  `disableTool()` sentinels, and `loadLocalTools` drops those by INSPECTING them — a name here
 *  would exempt them from that inspection whatever they later became. Concretely: edit
 *  `agent/tools/bash.ts` back to eve's real `bash` so Marcel can run a script mid-trip, and he
 *  gains unsandboxed shell inside a sealed, read-only container. With `bash` on this list
 *  nothing would notice. */
const ENABLED_FRAMEWORK_DEFAULTS: ReadonlySet<string> = new Set(["web_search"]);

/** `set_language` (ORB-278 step 2, Task 6) is deliberately absent from `CAPABILITY_TOOLS`: it
 *  is ALWAYS present, carries no grant and is not a capability — an owner must always be able
 *  to switch a conversation's language whatever the agent's declaration says. Exempted BY NAME
 *  everywhere below that otherwise demands "every authored tool maps to a capability" (the same
 *  shape Ruling R2, 2026-09-16 SDD ledger, records for the plan's later catalogue move). */
const ALWAYS_PRESENT_TOOLS: ReadonlySet<string> = new Set(["set_language"]);

/** Load every AUTHORED tool Marcel's own code backs, keyed by slug — his `catalogue/` pool plus
 *  whatever survives inspection under `agent/tools/`.
 *
 *  THE DIRECTORY SPLIT, ORB-278 STEP 2 TASK 8 (ADR-0015 rule 3). His tools used to be files
 *  under `agent/tools/`, always present; twenty-one of them are now a POOL that
 *  `agent/tools/catalogue.ts` picks from at session start against the resolved definition. What
 *  is LEFT under `agent/tools/` is the nine `disableTool()` framework sentinels, the one
 *  `web_search` framework enable, and that one resolver — none of which back any capability, so
 *  scanning both directories and excluding those three kinds of file by what they ARE (a
 *  sentinel) or by name (`web_search`, `catalogue`) yields the same authored surface as before
 *  the move, just relocated.
 *
 *  `agent-kit__transit_plan.ts` sits physically in `catalogue/` too (it has to, for
 *  `catalogue/index.ts` to import it statically) but is excluded here BY NAME, on purpose: it is
 *  a thin re-export of kit-owned logic, not something this service authored, and the ORB-144
 *  baseline's count has always tracked Marcel's OWN code surface separately from what the kit
 *  contributes. It is checked on its own terms further down.
 *
 *  A disable sentinel is dropped because of what it IS, not because of its name — so the day
 *  one of the nine framework disables stops being a sentinel it arrives here as an authored
 *  tool and the checks below turn red. That is the guard that matters: `agent/tools/bash.ts`
 *  edited back into eve's real `bash` would hand Marcel unsandboxed shell inside a sealed,
 *  read-only container. */
async function loadLocalTools(): Promise<Map<string, { approval?: unknown }>> {
  const dirs = [
    { dir: join(import.meta.dirname, "..", "agent", "tools"), skipByName: new Set([...ENABLED_FRAMEWORK_DEFAULTS, "catalogue"]) },
    { dir: join(import.meta.dirname, "..", "catalogue"), skipByName: new Set(["index", "agent-kit__transit_plan"]) },
  ];
  const out = new Map<string, { approval?: unknown }>();
  for (const { dir, skipByName } of dirs) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const slug = file.replace(/\.ts$/u, "");
      if (skipByName.has(slug)) continue;
      const mod = (await import(join(dir, file))) as { default: unknown };
      if (isDisabledToolSentinel(mod.default)) continue;
      out.set(slug, mod.default as { approval?: unknown });
    }
  }
  return out;
}

describe("eve-marcel agent.json", () => {
  it("passes assertDeclarationIntegrity", () => {
    expect(() => assertDeclarationIntegrity(manifest)).not.toThrow();
  });

  it("names the agent and declares sealed egress (the neutral default opens no door)", () => {
    expect(declaration.name).toBe("travel");
    expect(declaration.egress.sealed).toBe(true);
    expect(declaration.channels).toEqual([]);
  });

  it("points `persona` at a real, non-empty file — Marcel's instructions ARE his persona", () => {
    // Marcel has no separate source persona file the way Saga does
    // (../agent-runtime/agents/saga/persona.md), so there is nothing to hash his instructions
    // AGAINST. Existence + non-empty is the honest ceiling here: hashing the file against
    // itself would prove nothing, and neither did this test's first form, which compared
    // `declaration.persona` to a string literal copy of the same JSON field.
    //
    // What makes the field load-bearing is that the path is RESOLVED, not spelled out again:
    // point `persona` at a file that is not there and this goes red. That is eve-saga's
    // tests/instructions.test.ts mechanism, minus the hash it has a second file for.
    // Resolution is relative to the agent folder — the directory agent.json lives in —
    // matching the old runtime's adapters/loader.ts.
    const personaPath = resolve(dirname(resolve(import.meta.dirname, "../agent.json")), declaration.persona);
    expect(existsSync(personaPath), `agent.json persona "${declaration.persona}" → ${personaPath}`).toBe(true);
    expect(readFileSync(personaPath, "utf8").trim().length).toBeGreaterThan(0);
  });

  it("declares only known capabilities, each exactly once", () => {
    const names = declaration.grants.map((g) => g.capability);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(KNOWN_CAPABILITIES).toContain(name);
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
    // That the alias actually is `declaration.model` is asserted in tests/agent-config.test.ts,
    // which stands in for eve session state so the real resolver can run.
    const agent = (await import("../agent/agent.js")).default as {
      model?: { fallback?: unknown; events?: Record<string, unknown> };
    };
    expect(Object.keys(agent.model?.events ?? {})).toEqual(["step.started"]);
    expect(agent.model?.fallback).toBeUndefined();
  });
});

describe("eve-marcel extension tools resolve under the declaration", () => {
  it("grants neither `orakel` nor the private vault area — half of why all twelve mounts are dead", () => {
    // Not "declares them at scope none", not "sets autonomy never": SILENT. The strongest form
    // of least privilege the schema allows, and the one a reader of agent.json can see at a
    // glance. `brain` itself is stronger still since W5C-s5/s6: it left `KNOWN_CAPABILITIES`, so
    // no definition can grant it AT ALL — the check that matters for Marcel's private-area
    // access is `grantedVaultAreas`, the same derivation the mounted `vault_*` extension tools
    // and his own catalogue both read.
    expect(grantFor(declaration, "orakel")).toBeUndefined();
    expect(isGranted(declaration, "orakel")).toBe(false);
    expect(grantedVaultAreas(declaration)).not.toContain("private");
  });

  // Since ORB-278 step 2 Task 8, ALL TWELVE of these files are dead — eleven because Marcel
  // grants neither `orakel` nor the private vault area, and the twelfth (`transit_plan`)
  // because that prefixed key is now emitted from his OWN catalogue instead of from this mount,
  // unconditionally, whatever agent.json says. See this file's header and
  // agent/extensions/agent-kit/tools/transit_plan.ts's own header.
  for (const [slug, load] of Object.entries(EXTENSION_TOOLS)) {
    it(`keeps agent-kit__${slug} disabled at this mount`, async () => {
      expect(isDisabledToolSentinel((await load()).default)).toBe(true);
    });
  }

  it("overrides exactly what @lares/agent-kit contributes — no more, no less", () => {
    // THE KIT IS THE SOURCE OF TRUTH HERE, not this file and not the override directory.
    // Comparing the directory against EXTENSION_TOOLS alone would compare this test file to
    // itself: the kit could gain a thirteenth tool, no override file would exist for it, eve
    // would mount it un-resolved — ungoverned by any agent.json — and both sides of that
    // comparison would still agree. Anchoring on the kit's own `./tools` barrel is what
    // makes the check bite, and Marcel is the reason it matters: an unoverridden Brain write
    // would reach an agent that grants no `brain` at all.
    const contributed = Object.keys(kitTools).sort();
    const dir = join(import.meta.dirname, "..", "agent", "extensions", "agent-kit", "tools");
    const overrideFiles = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/u, ""))
      .sort();

    expect(contributed).toEqual(overrideFiles);
    expect(contributed).toEqual(Object.keys(EXTENSION_TOOLS).sort());
  });
});

describe("eve-marcel's one kit contribution resolves through his own catalogue now", () => {
  it("agent-kit__transit_plan is granted, ungated, and correctly scoped", () => {
    // ORB-168: a journey lookup is a pure read of a free, unbilled public API, so `read` scope +
    // `gated` autonomy must NOT produce an approval card — unchanged in substance by the move,
    // only in WHERE it is resolved (catalogue/agent-kit__transit_plan.ts, not the extension
    // mount).
    const granted = grantedToolNames(CATALOGUE, parseDefinition(manifest));
    expect(granted).toContain("agent-kit__transit_plan");
    const grant = grantFor(declaration, "transit");
    expect(grant?.scope).toBe("read");
    const tool = CATALOGUE["agent-kit__transit_plan"]!.tool as { approval?: unknown };
    expect(tool.approval).toBeUndefined();
    expect(() => assertClassMatchesScope(tool, grant!)).not.toThrow();
  });
});

describe("eve-marcel declaration ↔ authored tools", () => {
  it(
    "maps every declared capability to at least one authored (or catalogued kit) tool, and every authored tool to a capability",
    async () => {
      const local = await loadLocalTools();
      const authored = new Set<string>(local.keys());
      // ORB-168: `transit` is backed by `agent-kit__transit_plan`, which lives in Marcel's own
      // catalogue under the kit's prefixed key rather than in his authored surface — a
      // legitimate provider for the forward direction below, but not one of his OWN tools,
      // whose count is what the ORB-144 baseline (and its successors) tracks.
      const provided = new Set<string>([...authored, "agent-kit__transit_plan"]);

      const declared = declaration.grants.map((g) => g.capability);
      const mapped = new Set<string>();
      for (const capability of declared) {
        const tools = CAPABILITY_TOOLS[capability];
        expect(tools, `capability "${capability}" has no entry in CAPABILITY_TOOLS`).toBeDefined();
        expect(tools!.length, `capability "${capability}" is declared but backed by no tool`).toBeGreaterThan(0);
        for (const slug of tools!) {
          expect(
            provided.has(slug),
            `CAPABILITY_TOOLS lists "${slug}", which neither an agent tool file nor the catalogue provides`,
          ).toBe(true);
          mapped.add(slug);
        }
      }

      // The other direction: a new tool added without a grant would otherwise be invisible
      // in the declaration. `set_language` is the one deliberate exception — see
      // ALWAYS_PRESENT_TOOLS above.
      expect(
        [...authored].filter((s) => !mapped.has(s) && !ALWAYS_PRESENT_TOOLS.has(s)).sort(),
      ).toEqual([]);
      // The ORB-144 baseline's original eighteen, off the deployed container, plus ORB-158's
      // `read_url`, the ORB-157 follow-up's `trip_status`, and ORB-278 step 2 Task 6's
      // `set_language` (ALWAYS_PRESENT, no capability) — relocated by Task 8 from agent/tools/
      // into catalogue/, but the same twenty-one files. A twenty-second here means either a
      // genuinely new tool (give it a capability) or a framework default that has been
      // re-enabled — including one of the nine that are `disableTool()` today.
      //
      // Deliberately NOT counted here: `agent-kit__transit_plan`. It is a catalogued kit tool,
      // not one of Marcel's own — see `provided` above.
      expect(authored.size).toBe(21);
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
      // Marcel declares NO write-with-confirm capability today, so the loop body does not
      // run — which is why the assertion after it exists: it pins the DERIVATION rather than
      // the current answer. Not one of Marcel's twenty-one authored tools carries an
      // `approval` (he has no HITL tool surface at all — his Telegram approval cards live in
      // schedules, not in tools), and `agent-kit__transit_plan` carries none either. The day
      // someone adds a gated tool, the per-tool check below turns red until its capability's
      // scope is raised, and this loop starts biting.
      const local = await loadLocalTools();
      const approvalOf = (slug: string): unknown => {
        if (slug === "agent-kit__transit_plan") return CATALOGUE[slug]!.tool.approval;
        const tool = local.get(slug);
        if (!tool) throw new Error(`no tool file for "${slug}"`);
        return tool.approval;
      };

      for (const grant of declaration.grants) {
        if (grant.scope !== "write-with-confirm") continue;
        const slugs = CAPABILITY_TOOLS[grant.capability] ?? [];
        const approvals = slugs.map(approvalOf);
        expect(
          approvals.some((a) => a !== undefined),
          `agent.json declares "${grant.capability}" at write-with-confirm, but none of its ` +
            `tools (${slugs.join(", ")}) carries an approval gate`,
        ).toBe(true);
      }

      // The derivation, stated as an assertion so the two halves cannot drift apart.
      const gated = [...local].filter(([, tool]) => tool.approval !== undefined).map(([slug]) => slug);
      const confirmScoped = declaration.grants.filter((g) => g.scope === "write-with-confirm");
      expect(
        gated,
        "a Marcel tool has grown an approval gate — raise its capability's scope to write-with-confirm",
      ).toEqual([]);
      expect(
        confirmScoped,
        "a capability is scoped write-with-confirm while no Marcel tool carries an approval " +
          "gate — if you just added a gated tool, this assertion is the one to update, not the " +
          "scope you correctly raised",
      ).toEqual([]);
    },
    30_000,
  );

  it(
    "declares no local tool's gate away — every gated tool sits under a write-with-confirm grant",
    async () => {
      // The direction the aggregate check above cannot see, and the one that actually catches
      // a FALSE declaration: a tool carrying an `approval` under a grant scoped anything other
      // than write-with-confirm means agent.json is understating what Marcel can do.
      //
      // The kit's `assertClassMatchesScope` already enforces this at BUILD time for the twelve
      // extension tools — but all twelve are dead sentinels now (see the block above), so it
      // never runs there. Marcel's twenty-one are checked here, and `agent-kit__transit_plan`
      // is checked separately, in "eve-marcel's one kit contribution resolves through his own
      // catalogue now" above.
      //
      // There is deliberately NO exemption list. If this goes red, the tool is not the
      // problem — its capability's scope in agent.json is.
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

  it("scopes the read-only capabilities `read` and the mutating ones `write`", () => {
    // The scope of every capability is derived from what its tools actually do — see
    // .superpowers/sdd/2026-08-23-orb-144-agent-declarations/task-3-report.md for the
    // file:line citation behind each one. `read` where nothing under the capability changes
    // state anywhere; `write` where something does and no approval gates it.
    // `transit` (ORB-168) joins the read list: Entur's journey planner is a free public API
    // and `transit_plan` has no write path at all — the scope is derived from what the tool
    // does, not from which agent holds it (eve-saga derives the same `read` independently).
    for (const capability of ["calendar", "places", "strava", "currency", "transit"]) {
      expect(grantFor(declaration, capability)?.scope, capability).toBe("read");
    }
    for (const capability of ["travel", "shopping", "vault", "persona", "admin"]) {
      expect(grantFor(declaration, capability)?.scope, capability).toBe("write");
    }
  });

  it("ships no write-shaped tool under a read grant (ORB-199)", () => {
    // The check above records a DERIVATION — someone read each tool once and wrote down the
    // scope. This one re-derives it from the source on every run, in the one direction nothing
    // else covers: a tool with NO approval gate whose code mutates anyway, under a `read` grant.
    // ORB-144 left that standing and the 2026-09-01 sweep re-confirmed it
    // (docs/research/2026-09-01-engine-security-sweep.md, layer 4) — no live instance, and
    // nothing structural to catch the next one.
    //
    // Marcel is the agent the sweep's own false positives came from, and the exemptions that
    // keep this green are his: Telegram channel sends are the agent's own door, not external
    // mutations (the sweep's exact wording); his trip store and his rotated Strava token cache
    // are container-local files, not third parties; Google Places, Overpass, Entur's GraphQL
    // journey planner and Strava's token refresh are all reads that happen to be POSTs. Each is
    // documented with its file:line in packages/agent-kit/src/write-shape-lint.ts's header,
    // which is the contributed-adapter checklist an adapter turning this red should be read
    // against rather than exempted here.
    //
    // `set_language` is skipped BY NAME, not because its write-shape was inspected and cleared:
    // the lint's real complaint (`lintWriteShape`'s "unmapped-tool" kind) is that it maps to no
    // capability at all — true, and deliberate (ALWAYS_PRESENT_TOOLS above). Its only write is
    // `defineState(...).update()` on the session's own language slot, never a third party.
    expect(() =>
      assertNoUngatedWrites({
        agentDir: AGENT_DIR,
        manifest: declaration,
        label: "eve-marcel",
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
// computation from the dead fields agreed by coincidence) while failing loudly for Marcel
// (framework_tools correctly includes it, and the dead fields disagreed for real). A disabled
// framework tool now shows up only as a `kind: "disabled"` audit entry in `sourceComposition`,
// never in `tools` — the same unified model every other framework tool (task_cancel, glob, grep)
// already uses. So "is web_search live" is read off `tools` directly, like everything else.
const compiledPath = join(import.meta.dirname, "..", ".output", ".eve", "compile", "compiled-agent-manifest.json");
const compiled = existsSync(compiledPath)
  ? (JSON.parse(readFileSync(compiledPath, "utf8")) as {
      tools?: Array<{ name: string }>;
    })
  : undefined;
// `persona` is relative to the agent folder — the directory agent.json lives in, one above tests/.
const personaPath = join(import.meta.dirname, "..", declaration.persona);

describe("eve-marcel framework_tools matches the compiled manifest", () => {
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
// `load_skill` and `web_search` join it under W2-s8b, once a real build first ran this check
// (before eve 0.60.1 the branch's CI blocker meant `.output` never existed, so this whole
// describe block was always skipped, never actually exercised). Both are eve's own framework
// built-ins with no sentinel here, so eve grants them without agent.json's involvement.
// `load_skill` needs no mention: it adds no execution surface of its own (behaviour still comes
// from tools Marcel already has) and eve only registers it when the agent declares skills, which
// he does not. `web_search` genuinely IS in the persona's "where I run" text — "I can search the
// web with the framework's web search tool" — just never inside backticks, because that
// conformance is `framework_tools`'s job (the describe block above), not a capability-derived
// tool name.
const FRAMEWORK_BUILTIN_TOOLS: ReadonlySet<string> = new Set<string>(["set_language", "load_skill", "web_search"]);

// The post-build truth check for the same section (ORB-145 Phase 3, Task 9 review). The
// assembler filters each capability doc's fleet-wide tool union down to the FILES this agent
// ships, which is cheap and runs inside the build — but a file can be present and still not
// ship: a `disableTool()` sentinel, or an extension tool the declaration's own scope check
// disables at build time. Only the compiled manifest knows. So the committed instructions.md is
// held against it: every backticked name in "where I run" must be a tool `eve build` actually
// compiled, or the persona is naming something the model cannot call.
//
// WHAT "COMPILED" MEANS AFTER ORB-278 step 2 (Task 8). eve records a dynamic resolver, never its
// entries — `dynamicTools: [{ slug: "catalogue" }]` and `tools: []` — because deciding the
// entries at session start is the whole point of the move. So the authoritative post-build tool
// set is what eve compiled statically (the `web_search` framework case and, historically, the
// authored files) PLUS what this declaration grants out of the pool, computed by the same
// `grantedToolNames` the resolver itself calls (agent/tools/catalogue.ts) and the registry
// reports (agent/instrumentation.ts). Reading `compiled.tools` alone would leave the catalogued
// twenty-two out and both directions below vacuously green for them.
//
// Skipped, by name, when there is no build to check against or the persona has not been
// assembled yet — never silently passed.
describe("eve-marcel instructions.md names only tools the build compiled", () => {
  const persona = existsSync(personaPath) ? readFileSync(personaPath, "utf8") : "";
  const start = persona.search(/^# .+ — where I run$/mu);
  const environment = ((): string | undefined => {
    if (start < 0) return undefined;
    const rest = persona.slice(start).split("\n").slice(1).join("\n");
    const next = rest.search(/^# .+ — /mu);
    return next < 0 ? rest : rest.slice(0, next);
  })();
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
