// lares-split hook 30: neutral fixture (ORB-262) — installation-only assertions retargeted; see the lares split plan.
// `agent/instructions.md` is an ASSEMBLED artefact, not a hand-written one (ORB-145 Phase 3).
//
// `pnpm run assemble` turns three inputs — this service's own `agent.json`, the SHARED `creative`
// role template, and this service's own `agent/voice.md` — into the persona eve boots from, and
// `pnpm build` runs it before `eve build`.
//
// It replaces a 40-line file that shipped BYTE-IDENTICAL to
// `services/agent-runtime/agents/calliope/persona.md` — this file used to hash both and compare.
// The copy was faithful and still wrong in one place: the persona told her to run "the
// `studio.ideate` tool", which is the RETIRED runtime's hand name. Her eve tool is
// `studio_ideate`. A hand-written tool name in a persona is exactly the drift the generated
// "where I run" section exists to end, and generation fixed it here without anyone noticing it
// was broken. So the hash test is gone and two guards stand in its place: the drift check below
// (instructions.md is byte-for-byte what the assembler produces), and — in
// tests/agent-declaration.test.ts — every backticked name in "where I run" held against the tool
// list `eve build` actually compiled.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { parseManifest } from "@lares/agent-kit/manifest";
import { assemblePersona, deployedToolsFor } from "@lares/agent-kit/persona";

import manifest from "../agent.json";

describe("eve-calliope instructions", () => {
  // Both paths come from the agent declaration, not from literals here — that is what keeps
  // `persona` and `role` load-bearing rather than decorative, the same property the retired hash
  // test had. `persona` is relative to the agent folder (the directory agent.json lives in),
  // matching the old runtime's adapters/loader.ts.
  const agentDir = dirname(resolve(import.meta.dirname, "../agent.json"));
  const instructionsPath = resolve(agentDir, manifest.persona);
  const rolePath = resolve(import.meta.dirname, "../../../packages/agent-kit/templates", manifest.role, "role.md");
  const voicePath = resolve(agentDir, "agent/voice.md");

  const content = readFileSync(instructionsPath, "utf8");
  const section = (heading: string): string => {
    const start = content.indexOf(heading);
    expect(start, `missing section: ${heading}`).toBeGreaterThanOrEqual(0);
    const rest = content.slice(start + heading.length);
    const next = rest.indexOf("\n# Creative — ");
    return next === -1 ? rest : rest.slice(0, next);
  };
  const environment = section("# Creative — where I run");
  const role = section("# Creative — role");
  const voice = section("# Creative — voice");

  it("instructions.md file exists", () => {
    expect(content).toBeDefined();
    expect(content.length).toBeGreaterThan(0);
  });

  it("is byte-for-byte what the assembler produces from agent.json + role + voice", () => {
    // The drift guard, and the direct replacement for the persona hash. `assemblePersona` is
    // deterministic (pinned in agent-kit's own suite), so a red here means exactly one thing:
    // someone edited instructions.md, agent.json, the role template or voice.md and did not
    // re-run `pnpm run assemble`. The Dockerfile's `assemble:check` is the same guard one layer
    // out, on the image build.
    //
    // IF THIS GOES RED, DO NOT HAND-EDIT instructions.md TO MAKE IT PASS — it is a build
    // artefact. Change whichever of the three inputs was meant to change, re-run the assembler,
    // and commit the result.
    const expected = assemblePersona({
      manifest: parseManifest(manifest),
      roleMd: readFileSync(rolePath, "utf8"),
      voiceMd: readFileSync(voicePath, "utf8"),
      displayName: "Creative",
      // The fourth input: which tools this agent actually ships. A capability doc's `tools` is
      // the fleet-wide union, so without this the section names tools that are not here — the
      // `atlas` doc alone would hand her `atlas_proposals` and `atlas_resolve_proposal`, neither
      // of which she has a file for. Derived from the agent folder by the same function the
      // assemble script calls, so this test and the build cannot disagree about it.
      deployedTools: deployedToolsFor(agentDir),
    });
    expect(content).toBe(expected);
  });

  it("the five sections come in order — who I am, where I run, memory precedence, role, voice", () => {
    const i = (s: string) => content.indexOf(s);
    expect(content.startsWith("# Creative — who I am")).toBe(true);
    expect(i("# Creative — where I run")).toBeGreaterThan(i("# Creative — who I am"));
    expect(i("# Creative — how I use what I remember")).toBeGreaterThan(i("# Creative — where I run"));
    expect(i("# Creative — role")).toBeGreaterThan(i("# Creative — how I use what I remember"));
    expect(i("# Creative — voice")).toBeGreaterThan(i("# Creative — role"));
  });

  it("names both capabilities the declaration grants, and nothing she does not hold", () => {
    // The retired persona named exactly one tool, by hand, and named it wrongly. Generation
    // makes the persona's tool list and the declaration the same list by construction.
    const granted = parseManifest(manifest).grants.filter((g) => g.scope !== "none");
    expect(granted.length).toBe(2);
    for (const g of granted) expect(environment, `ungenerated capability: ${g.capability}`).toContain(`**${g.capability}**`);
    // The two capabilities she pointedly does NOT grant — the absences
    // tests/agent-declaration.test.ts proves disable all eleven extension tools.
    for (const absent of ["orakel", "transit"]) {
      expect(environment, `names an ungranted capability: ${absent}`).not.toContain(`**${absent}**`);
    }
    // Under the Vault rename "brain" is no longer a capability name to check for — she is
    // granted `vault` (for the `shared` area), so the check that matters now is that her one
    // vault bullet never claims the `private` area: an ideation agent inside the owner's own
    // personal notes is the one that matters.
    const vaultStart = environment.indexOf("- **vault**");
    expect(vaultStart, "missing the vault bullet").toBeGreaterThanOrEqual(0);
    const vaultRest = environment.slice(vaultStart);
    const nextBullet = vaultRest.indexOf("\n- **", 1);
    const vaultBullet = nextBullet === -1 ? vaultRest : vaultRest.slice(0, nextBullet);
    expect(vaultBullet, "claims the owner's private area").not.toMatch(/\bprivate\b/);
  });

  it("says she CANNOT search the web — she disables eve's web_search with a sentinel", () => {
    // The mirror of Marcel's assertion, and the reason `framework_tools` exists at all: the
    // sentence is generated per agent from the declaration. Hers is empty, and
    // agent/tools/web_search.ts is a disable sentinel, so this is the true half of the pair.
    expect(parseManifest(manifest).framework_tools).toEqual([]);
    expect(environment).toMatch(/I cannot search the web/);
    expect(environment).not.toMatch(/I can search the web with the framework's web search tool/);
  });

  it("the generated environment states the sandbox posture, the seal and her one door", () => {
    expect(environment).toMatch(/no shell/i);
    expect(environment).toMatch(/sealed/i);
    expect(environment).toMatch(/^Doors: none configured\.$/mu);
  });

  it("still carries the behaviours that ARE her", () => {
    // The four the retired hash test named, retargeted at the assembled text — so a deliberate
    // edit that drops one fails with a message saying what was lost, not merely that two files
    // differ. Each is asserted in the section that now owns it, which is itself the check that
    // the split went the right way.

    // Her role. Everything else reads as instructions to a generic assistant without it.
    expect(role).toContain("creative director");
    // The don't-gatekeep default: run the studio on a terse brief with a stated assumption
    // rather than interrogating first.
    expect(role).toContain("Run first");
    // The anti-hardcoded-list rule, in full rather than a bare word that would survive almost
    // any mangling. A hardcoded brand list previously made her confident about three ventures
    // and blank about the rest. The store is named generically in the role — "the Atlas" was the
    // installation's word for it and could not travel into a shared template.
    expect(role).toContain("Assume every venture has a note in the business knowledge store");
    expect(role).not.toMatch(/\bAtlas\b/u);
    // The rename fact. Without it she treats CHIBOU-era material as a different venture from
    // SOMA, and there is nowhere else in the service that knows this. It is a fact about the
    // owner's own ventures, so it lives in the voice overlay — a shared role template naming it
    // would fail the genericness lint, which is precisely why the split puts it here.
    // The other owner-specific fact from the same paragraph, and the one that is easiest to lose
    // silently: without it she looks for a note that does not exist.
    // (Both owner facts — the CHIBOU->SOMA rename and the Lares exception — live in the
    // installation's voice.md, the overlay's since the lares split; the engine's is neutral.)
    // ...and none of the owner's world leaked into the engine text.
    expect(role).not.toMatch(/Bendik|SOMA|CHIBOU|Lares/u);
  });

  it("the role keeps the two rules that decide what she DOES with a studio run", () => {
    // These are the substance of "curation, never a single answer", and neither had a named
    // guard until this review. The drift test above would catch their removal, but only as
    // "two files differ" — these say which rule was lost.

    // Curating is presenting the WHOLE spread. Without this she quietly becomes a picker: she
    // summarises the run, drops the weird outliers, and hands back one favourite — which is the
    // single failure mode the whole role exists to prevent.
    expect(role).toContain("I present the tool result **verbatim**");
    expect(role).toContain("summarise, reorder, drop items, or pick a favourite");

    // She cannot see the store search — the studio does it. So her only honest source on
    // whether the store had context is the run's own grounding line. Lose this and she starts
    // reporting an empty store from her own inference, over proposers that DID ground on a
    // brand note she never saw.
    expect(role).toContain('Never claim the store "came up empty" unless the grounding line says so');
  });

  it("the voice section is this service's own voice.md — the neutral default in the engine", () => {
    // The line the split exists to draw: the character stayed with the agent, the rules went to
    // the shared template, and neither leaked into the other.
    expect(voice).toContain("Plain, quiet, direct.");
    expect(voice).toMatch(/I ask first and say why/);
  });
});
