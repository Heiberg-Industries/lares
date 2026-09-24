// lares-split hook 30: neutral fixture (ORB-262) — installation-only assertions retargeted; see the lares split plan.
// `agent/instructions.md` is an ASSEMBLED artefact, not a hand-written one (ORB-145 Phase 3).
//
// `pnpm run assemble` turns three inputs — this service's own `agent.json`, the SHARED
// `chief-of-staff` role template, and this service's own `agent/voice.md` — into the single
// file eve boots the persona from, and `pnpm build` runs it before `eve build`. The Dockerfile
// does NOT: it runs `pnpm exec eve build` directly, so the COMMITTED instructions.md is what
// actually ships. The drift test below is therefore the guard that the committed file is the
// one the assembler would produce — regenerate and commit, or the build ships stale text.
//
// It replaces the byte-for-byte "instructions.md contains persona.md verbatim behind a
// hand-written preamble" test that stood here until the split. That preamble is what the whole
// plan exists to end: it was hand-written text about the tools, and on 2026-08-14 it made Saga
// DENY capabilities she actually held. The "where I run" section is now GENERATED from the
// declaration, so it cannot say she lacks something the declaration grants — the assertion at
// the bottom of this file is that property, pinned for her current grants specifically.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { parseManifest } from "@lares/agent-kit/manifest";
import { assemblePersona, deployedToolsFor } from "@lares/agent-kit/persona";

import manifest from "../agent.json";

describe("eve-saga instructions", () => {
  // Both paths come from the agent declaration, not from literals here. That is what keeps
  // `persona` and `role` load-bearing rather than decorative: point either at the wrong file
  // and the drift test below goes red. `persona` is relative to the agent folder (the
  // directory agent.json lives in), matching the old runtime's adapters/loader.ts.
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
    // so a red here means exactly one thing: someone edited instructions.md, agent.json, the
    // role template or voice.md and did not re-run `pnpm run assemble`.
    const expected = assemblePersona({
      manifest: parseManifest(manifest),
      roleMd: readFileSync(rolePath, "utf8"),
      voiceMd: readFileSync(voicePath, "utf8"),
      displayName: "Chief of Staff",
      // The fourth input, and the one the Task 9 review added: which tools this agent actually
      // ships. A capability doc's `tools` is the fleet-wide union, so without this the section
      // names tools that are not here. Derived from the agent folder by the same function the
      // assemble script calls, so this test and the build cannot disagree about it.
      deployedTools: deployedToolsFor(agentDir),
    });
    expect(content).toBe(expected);
  });

  it("the shadow-phase markers are GONE — the cutover is complete", () => {
    // ORB-72 (2026-08-31): eve-saga IS Saga. The shadow phase ended at the 2026-08-16
    // cutover; the markers and the parallel-running framing were retired with the old
    // runtime. This assertion is deliberately the INVERSE of the one it replaces — if the
    // markers ever come back, something re-introduced a shadow posture that no longer has
    // a counterpart to shadow.
    expect(content).not.toContain("<!-- shadow-phase-start -->");
    expect(content).not.toContain("<!-- shadow-phase-end -->");
    expect(content).not.toMatch(/read-only mode/i);
    expect(content).not.toMatch(/staged, not broken/i);
    expect(content).not.toMatch(/running in parallel|shadow/i);
  });

  it("the generated environment states the sandbox posture, the seal, and the approval gate", () => {
    // The load-bearing claims the retired preamble used to make by hand. They survive, but
    // they are now GENERATED from the declaration — `egress.sealed` and each capability's
    // scope decide the wording, so none of it can drift from what she actually holds.
    expect(environment).toMatch(/no shell/i);
    expect(environment).toMatch(/sealed/i);
    expect(environment).toMatch(/approval card/i);
    expect(environment).toMatch(/cannot search the web/i);
    // The gate's original proof tool, named by the `echo` capability rather than by hand.
    expect(environment).toContain("echo_note");
  });

  it("the role says schedules are live and an absence is never explained away", () => {
    // This REPLACED a preamble sentence that told her a missing brief meant "schedules are
    // staged, not broken". Schedules have been live since the 2026-08-16 cutover, so that
    // sentence had become an instruction to explain away a real outage — exactly what hid the
    // ten-day digest gap found on 2026-08-31. It lives in the role template now, because it is
    // discipline about her own output rather than a fact about any one capability.
    expect(role).toMatch(/schedules are live/i);
    expect(role).toMatch(/never explain an absence away/i);
    // The Wave-1 rule, in the role's §Never: try the tool before claiming you cannot.
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

  it("names every capability the declaration grants — the Wave-1 bug made structural", () => {
    // The 2026-08-14 failure was a hand-written environment section that listed eight hands
    // while the declaration granted far more, so she denied the rest. Generation makes the
    // two the same list by construction; this pins it for her actual grants.
    const granted = parseManifest(manifest).grants.filter((g) => g.scope !== "none");
    // 23 before W5C-s6, which replaced `brain` + `atlas` + `memory` with one `vault` grant
    // carrying all three as areas — three bullets became one, and no tool moved.
    expect(granted.length).toBe(21); // includes the read-only operational signal spine (LAR-41)
    for (const g of granted) expect(environment, `ungenerated capability: ${g.capability}`).toContain(`**${g.capability}**`);
  });

  // W7D-s4 — the tool's own description is what a model reads at call time (capability-docs.ts's
  // own header names it "the most authoritative single source"); it named the owner by name.
  it("the send tool's description names no person", () => {
    const src = readFileSync(resolve(__dirname, "../catalogue/gmail_send.ts"), "utf8");
    expect(src).not.toMatch(/Bendik/);
    expect(src).toMatch(/the owner/);
  });
});
