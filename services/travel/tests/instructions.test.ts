// lares-split hook 30: neutral fixture (ORB-262) — installation-only assertions retargeted; see the lares split plan.
// `agent/instructions.md` is an ASSEMBLED artefact, not a hand-written one (ORB-145 Phase 3).
//
// `pnpm run assemble` turns three inputs — this service's own `agent.json`, the SHARED `travel`
// role template, and this service's own `agent/voice.md` — into the STATIC half of the persona
// eve boots from, and `pnpm build` runs it before `eve build`. The DYNAMIC half is untouched by
// any of this: eve reads `agent/instructions.md` (root) and then `agent/instructions/` (the
// per-turn trip-context resolver), and only the root file is generated here.
//
// It replaces 199 hand-written lines whose first half was a tool-name mapping table from the
// 2026-08-17 port — text that had already gone stale twice (Fix Wave B found it telling the
// model the shopping tools did not exist while they did). The "where I run" section is now
// GENERATED from the declaration, so it cannot say Marcel lacks something the declaration
// grants; the assertions at the bottom pin that property for his eleven grants and for the one
// framework tool he keeps enabled.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { parseManifest } from "@lares/agent-kit/manifest";
import { assemblePersona, deployedToolsFor } from "@lares/agent-kit/persona";

import manifest from "../agent.json";

describe("eve-marcel instructions", () => {
  // Both paths come from the agent declaration, not from literals here — that is what keeps
  // `persona` and `role` load-bearing rather than decorative. `persona` is relative to the agent
  // folder (the directory agent.json lives in), matching the old runtime's adapters/loader.ts.
  const agentDir = dirname(resolve(__dirname, "../agent.json"));
  const instructionsPath = resolve(agentDir, manifest.persona);
  const rolePath = resolve(__dirname, "../../../packages/agent-kit/templates", manifest.role, "role.md");
  const voicePath = resolve(agentDir, "agent/voice.md");

  const content = readFileSync(instructionsPath, "utf8");
  const section = (heading: string): string => {
    const start = content.indexOf(heading);
    expect(start, `missing section: ${heading}`).toBeGreaterThanOrEqual(0);
    const rest = content.slice(start + heading.length);
    const next = rest.indexOf("\n# Travel — ");
    return next === -1 ? rest : rest.slice(0, next);
  };
  const environment = section("# Travel — where I run");
  const role = section("# Travel — role");
  const voice = section("# Travel — voice");

  it("instructions.md file exists", () => {
    expect(content).toBeDefined();
    expect(content.length).toBeGreaterThan(0);
  });

  it("is byte-for-byte what the assembler produces from agent.json + role + voice", () => {
    // The drift guard. `assemblePersona` is deterministic (pinned in agent-kit's own suite), so
    // a red here means exactly one thing: someone edited instructions.md, agent.json, the role
    // template or voice.md and did not re-run `pnpm run assemble`. The Dockerfile's
    // `assemble:check` is the same guard one layer out, on the image build.
    const expected = assemblePersona({
      manifest: parseManifest(manifest),
      roleMd: readFileSync(rolePath, "utf8"),
      voiceMd: readFileSync(voicePath, "utf8"),
      displayName: "Travel",
      // The fourth input, and the one the Task 9 review added: which tools this agent actually
      // ships. A capability doc's `tools` is the fleet-wide union, so without this the section
      // names tools that are not here. Derived from the agent folder by the same function the
      // assemble script calls, so this test and the build cannot disagree about it.
      deployedTools: deployedToolsFor(agentDir),
    });
    expect(content).toBe(expected);
  });

  it("the five sections come in order — who I am, where I run, memory precedence, role, voice", () => {
    const i = (s: string) => content.indexOf(s);
    expect(content.startsWith("# Travel — who I am")).toBe(true);
    expect(i("# Travel — where I run")).toBeGreaterThan(i("# Travel — who I am"));
    expect(i("# Travel — how I use what I remember")).toBeGreaterThan(i("# Travel — where I run"));
    expect(i("# Travel — role")).toBeGreaterThan(i("# Travel — how I use what I remember"));
    expect(i("# Travel — voice")).toBeGreaterThan(i("# Travel — role"));
  });

  it("names every capability the declaration grants — the Wave-1 bug made structural", () => {
    // The retired preamble listed tools by hand in a mapping table, which is precisely how a
    // persona drifts from the toolset. Generation makes the two the same list by construction.
    const granted = parseManifest(manifest).grants.filter((g) => g.scope !== "none");
    expect(granted.length).toBe(11);
    for (const g of granted) expect(environment, `ungenerated capability: ${g.capability}`).toContain(`**${g.capability}**`);
  });

  it("says he CAN search the web — the one claim the shared capability docs used to get wrong", () => {
    // Marcel is the only agent in the fleet that keeps eve's `web_search` enabled
    // (agent/tools/web_search.ts re-enables it; Saga's and Calliope's are disable sentinels).
    // The web-access sentence used to live inside read_url's capability doc as a flat "I cannot
    // search the web", which would have denied him a live tool AND contradicted his own role
    // text two screens below. It is generated from `framework_tools` now.
    expect(environment).toMatch(/I can search the web with the framework's web search tool/);
    expect(environment).not.toMatch(/cannot search the web/i);
    expect(role).toMatch(/I search the web when the tools allow it/);
  });

  it("the generated environment states the sandbox posture, the seal and the drift guard", () => {
    // The load-bearing claims the retired preamble made by hand. They survive, but they are
    // GENERATED — `egress.sealed` and each capability's scope decide the wording.
    expect(environment).toMatch(/no shell/i);
    expect(environment).toMatch(/sealed/i);
    // §"Capability-drift guard — keep this line, it is load-bearing" of the retired file. Its
    // substance is now the `travel` capability doc's own rule, so it travels with the
    // capability rather than with this one agent's prose.
    expect(environment).toMatch(/My tools may be upgraded mid-conversation/);
    expect(environment).toMatch(/try the matching tool again before repeating an old limitation/);
  });

  it("the role keeps the rules the retired preamble carried that were not about tool names", () => {
    // §"What else old Marcel's per-turn prompt carried" — the half that is a standing rule:
    // the per-turn trip context is already in front of him, so he never asks for it.
    expect(role).toMatch(/I never ask for something that is\s+already in front of me/);
    expect(role).toMatch(/never say I cannot see it/);
  });

  it("says exactly which area it has, and denies the ones it does not", () => {
    // Under the Vault rename this stops being a claim of having no store at all — this role IS
    // granted one area (`facts`) — and becomes an area-exact claim, checkable against the
    // grant: it has no `private` notes of the owner's own and no `shared` business knowledge,
    // and the generated environment names only the area it actually holds.
    expect(role).toMatch(/I have no notes of (?:the owner's|their) own and no shared business knowledge/i);
    expect(environment).toContain("**vault**");
    // Scoped to the vault bullet itself, not the whole environment block — "private admin
    // channel" (the `admin` capability) and "shared readability worker" (`read_url`) use the
    // plain English words for something that has nothing to do with vault areas, and a blunter
    // check would fail on those unrelated capabilities regardless of what the vault bullet says.
    const vaultStart = environment.indexOf("- **vault**");
    expect(vaultStart, "missing the vault bullet").toBeGreaterThanOrEqual(0);
    const vaultRest = environment.slice(vaultStart);
    const nextBullet = vaultRest.indexOf("\n- **", 1);
    const vaultBullet = nextBullet === -1 ? vaultRest : vaultRest.slice(0, nextBullet);
    expect(vaultBullet).not.toMatch(/\bprivate\b/);
    expect(vaultBullet).not.toMatch(/\bshared\b/);
  });

  it("no persona names a capability that no longer exists", () => {
    // Cross-service: the rename must hold for all three neutral personas, not just this one's.
    const cosPersona = readFileSync(resolve(__dirname, "../../chief-of-staff/agent/persona.md"), "utf8");
    const creativePersona = readFileSync(resolve(__dirname, "../../creative/agent/persona.md"), "utf8");
    for (const p of [cosPersona, creativePersona, content])
      for (const gone of ["**brain**", "**atlas**", "**memory**"]) expect(p).not.toContain(gone);
  });

  it("the voice section is this service's own voice.md — the neutral default in the engine", () => {
    // The overlay may name a language and a person; the role may not. This is the line the
    // split exists to draw — the character stayed with the agent, the rules went to the shared
    // template, and neither leaked into the other.
    // (The installation's own voice — Marcel's Norwegian with French quirks — is the overlay's.)
    expect(voice).toContain("Plain, quiet, direct.");
    expect(voice).toContain("I never claim to have done something I have not.");
    expect(voice).toMatch(/I ask first and say why/);
    // ...and none of it leaked into the engine text.
    expect(role).not.toMatch(/Marcel|fransk|norsk/i);
  });
});
