// `agent/persona.md` is an ASSEMBLED artefact, not a hand-written one.
//
// `pnpm run assemble` turns three inputs — this service's own `agent.json`, the SHARED
// `chief-of-staff` role template, and this service's own `agent/voice.md` — into the single
// file eve boots the persona from, and `pnpm build` runs it before `eve build`. The Dockerfile
// does NOT: it runs `pnpm exec eve build` directly, so the COMMITTED persona.md is what
// actually ships. The drift test below is therefore the guard that the committed file is the
// one the assembler would produce — regenerate and commit, or the build ships stale text.
//
// It replaces a byte-for-byte "persona contained verbatim behind a hand-written preamble" check.
// That preamble is what the assembler exists to end: it was hand-written text about the tools, and it once made the chief of staff
// DENY capabilities it actually held. The "where I run" section is now GENERATED from the
// declaration, so it cannot say the agent lacks something the declaration grants — the assertion at
// the bottom of this file is that property, pinned for the agent's current grants specifically.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { denylistPatterns } from "./helpers/denylist";

import { parseManifest } from "@lares/agent-kit/manifest";
import { assemblePersona, deployedToolsFor } from "@lares/agent-kit/persona";

import manifest from "../agent.json";

describe("chief-of-staff instructions", () => {
  // Both paths come from the agent declaration, not from literals here. That is what keeps
  // `persona` and `role` load-bearing rather than decorative: point either at the wrong file
  // and the drift test below goes red. `persona` is relative to the agent folder (the
  // directory agent.json lives in), the same way the loader resolves it.
  const agentDir = dirname(resolve(__dirname, "../agent.json"));
  const instructionsPath = resolve(agentDir, manifest.persona);
  const rolePath = resolve(__dirname, "../../../packages/agent-kit/templates", manifest.role, "role.md");
  const voicePath = resolve(agentDir, "agent/voice.md");

  const content = readFileSync(instructionsPath, "utf8");
  const section = (heading: string): string => {
    const start = content.indexOf(heading);
    expect(start, `missing section: ${heading}`).toBeGreaterThanOrEqual(0);
    const rest = content.slice(start + heading.length);
    const next = rest.indexOf("\n# Chief of Staff — ");
    return next === -1 ? rest : rest.slice(0, next);
  };
  const environment = section("# Chief of Staff — where I run");
  const role = section("# Chief of Staff — role");

  it("instructions.md file exists", () => {
    expect(content).toBeDefined();
    expect(content.length).toBeGreaterThan(0);
  });

  it("is byte-for-byte what the assembler produces from agent.json + role + voice", () => {
    // The drift guard. `assemblePersona` is deterministic (pinned in agent-kit's own suite),
    // so a red here means exactly one thing: someone edited persona.md, agent.json, the
    // role template or voice.md and did not re-run `pnpm run assemble`.
    const expected = assemblePersona({
      manifest: parseManifest(manifest),
      roleMd: readFileSync(rolePath, "utf8"),
      voiceMd: readFileSync(voicePath, "utf8"),
      displayName: "Chief of Staff",
      // The fourth input, and the one that matters most: which tools this agent actually
      // ships. A capability doc's `tools` is the fleet-wide union, so without this the section
      // names tools that are not here. Derived from the agent folder by the same function the
      // assemble script calls, so this test and the build cannot disagree about it.
      deployedTools: deployedToolsFor(agentDir),
    });
    expect(content).toBe(expected);
  });

  it("the parallel-run markers are GONE", () => {
    // chief-of-staff IS the chief of staff: the markers and the parallel-running framing are
    // retired. If the markers ever come back, something re-introduced a parallel-run posture
    // that no longer has a counterpart to run beside.
    expect(content).not.toContain("<!-- shadow-phase-start -->");
    expect(content).not.toContain("<!-- shadow-phase-end -->");
    expect(content).not.toMatch(/read-only mode/i);
    expect(content).not.toMatch(/staged, not broken/i);
    expect(content).not.toMatch(/running in parallel|shadow/i);
  });

  it("the generated environment states the sandbox posture, the seal, and the approval gate", () => {
    // The load-bearing claims the retired preamble used to make by hand. They survive, but
    // they are now GENERATED from the declaration — `egress.sealed` and each capability's
    // scope decide the wording, so none of it can drift from what the agent actually holds.
    expect(environment).toMatch(/no shell/i);
    expect(environment).toMatch(/sealed/i);
    expect(environment).toMatch(/approval card/i);
    expect(environment).toMatch(/cannot search the web/i);
    // The gate's original proof tool, named by the `echo` capability rather than by hand.
    expect(environment).toContain("echo_note");
  });

  it("the role says schedules are live and an absence is never explained away", () => {
    // This REPLACED a preamble sentence that told the agent a missing brief meant "schedules are
    // staged, not broken". Schedules are live, so that
    // sentence had become an instruction to explain away a real outage — exactly what hid a
    // ten-day digest gap. It lives in the role template now, because it is
    // discipline about the agent's own output rather than a fact about any one capability.
    expect(role).toMatch(/schedules are live/i);
    expect(role).toMatch(/never explain an absence away/i);
    // The rule in the role's §Never: try the tool before claiming you cannot.
    expect(role).toMatch(/claim I lack access before trying the relevant tool/i);
  });

  it("the five sections come in order — who I am, where I run, memory precedence, role, voice", () => {
    const i = (s: string) => content.indexOf(s);
    expect(content.startsWith("# Chief of Staff — who I am")).toBe(true);
    expect(i("# Chief of Staff — where I run")).toBeGreaterThan(i("# Chief of Staff — who I am"));
    expect(i("# Chief of Staff — how I use what I remember")).toBeGreaterThan(i("# Chief of Staff — where I run"));
    expect(i("# Chief of Staff — role")).toBeGreaterThan(i("# Chief of Staff — how I use what I remember"));
    expect(i("# Chief of Staff — voice")).toBeGreaterThan(i("# Chief of Staff — role"));
  });

  it("names every capability the declaration grants", () => {
    // A hand-written environment section once listed eight capabilities
    // while the declaration granted far more, so the agent denied the rest. Generation makes the
    // two the same list by construction; this pins it for the agent's actual grants.
    const granted = parseManifest(manifest).grants.filter((g) => g.scope !== "none");
    // The neutral default's grants: `vault` carries the brain, atlas and memory areas as one grant,
    // and the optional `transit` grant is not part of the neutral default.
    expect(granted.length).toBe(17); // includes the read-only operational signal spine
    for (const g of granted) expect(environment, `ungenerated capability: ${g.capability}`).toContain(`**${g.capability}**`);
  });

  // The tool's own description is what a model reads at call time (capability-docs.ts's
  // own header names it "the most authoritative single source"); it named the owner by name.
  it("the send tool's description names no person", () => {
    const src = readFileSync(resolve(__dirname, "../catalogue/gmail_send.ts"), "utf8");
    for (const re of denylistPatterns()) expect(src).not.toMatch(re);
    expect(src).toMatch(/the owner/);
  });
});
