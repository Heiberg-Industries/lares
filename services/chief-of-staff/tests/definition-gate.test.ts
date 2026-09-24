// THE GATE (ORB-278 step 2, Task 5, step 9).
//
// This agent's instructions are now resolved at session start from its DEFINITION rather than
// compiled from a file baked into its image. The whole plan rests on that being a change of
// WHERE the persona comes from and not of WHAT it says: what `agent/instructions/aa-definition.ts`
// hands the model must be byte-for-byte the committed `agent/persona.md`.
//
// Same code path either way. With LARES_DEFINITION_DIR unset — which is every test, every CI
// build and every `eve build` — `thisAgent` loads this service's own committed agent.json and
// agent/voice.md with no duties, so a green here is a real comparison and not a tautology: the
// assembled side goes through `resolveDefinition` -> `loadDefinition` -> `assemblePersona`, and
// the expected side is the artefact `assemble:check` independently pins.
//
// IF THIS GOES RED, DO NOT EDIT agent/persona.md TO MATCH. It is a build artefact; the fault is
// in the definition pipeline or the assembler, and adjusting what the gate compares would hide
// exactly the drift this exists to catch.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDisabledToolSentinel } from "eve/tools";

import { assemblePersona, deployedToolsFor } from "@lares/agent-kit/persona";

import manifest from "../agent.json";
import { roleMdPath, thisAgent } from "../lib/definition.js";

describe("the definition gate", () => {
  /** Read through the declaration's own `persona` field, never a literal — the same property the
   *  service's other drift tests rely on. */
  const committed = () =>
    readFileSync(`${process.cwd()}/${(manifest as { persona: string }).persona}`, "utf8");

  it("assembles byte-for-byte what the committed persona file holds", async () => {
    const serviceDir = process.cwd();
    const { loaded, usedFallback } = await thisAgent("gate-assemble");
    expect(usedFallback).toBe(false);
    // No LARES_DEFINITION_DIR in the suite, so this must be the image's own neutral files.
    expect(loaded.source).toBe("service");

    const out = assemblePersona({
      manifest: loaded.definition,
      roleMd: readFileSync(roleMdPath(serviceDir), "utf8"),
      voiceMd: loaded.voiceMd,
      dutiesMd: loaded.dutiesMd,
      displayName: loaded.definition.display ?? loaded.definition.name,
      deployedTools: deployedToolsFor(serviceDir),
    });

    expect(out).toBe(committed());
  });

  // The assertion above proves the PIECES compose correctly; this one proves the module eve
  // actually calls is wired to them. Without it a typo inside aa-definition.ts — the wrong role
  // path, voiceMd and dutiesMd swapped, a forgotten deployedTools — would ship green.
  it("is what agent/instructions/aa-definition.ts hands the model at session start", async () => {
    const resolver = (await import("../agent/instructions/aa-definition.js")).default as {
      events: { "session.started": (event: unknown, ctx: unknown) => Promise<{ markdown: string }> };
    };
    const { markdown } = await resolver.events["session.started"](undefined, { session: { id: "gate-session" } });
    expect(markdown).toBe(committed());
  });

  // eve reads a root agent/instructions.md AND agent/instructions/ together, so the persona must
  // not live in both: agent/persona.md is the artefact assemble:check pins, and nothing else.
  it("the persona is not also sitting where eve would read it a second time", () => {
    expect(existsSync(`${process.cwd()}/agent/instructions.md`)).toBe(false);
    expect((manifest as { persona: string }).persona).toBe("agent/persona.md");
  });

  it("resolves with no duties and no language, which is what keeps the bytes identical", async () => {
    const { loaded } = await thisAgent("gate-neutral");
    expect(loaded.dutiesMd).toBe("");
    expect((loaded.definition as { language?: string }).language).toBeUndefined();
  });
});

// ORB-278 step 2 review, finding 3. The spec's Part 3 resolves instructions, model, tools and
// skills AT SESSION START, and ADR-0015 promises the owner that a definition edited on the box
// "applies at the next conversation" with nothing rebuilt and nothing restarted. A
// process-lifetime memo silently broke that — `resolveDefinition` re-reads the folder every call
// (the "cache" in its name is the Postgres last-valid row), so pinning its promise forever meant
// an edit landed only at the next CONTAINER.
//
// This drives the real `thisAgent` against a throwaway copy of this service's own tree. No
// database and no mounted folder are involved: `process.chdir` moves the app root, which is what
// `thisAgent` resolves everything from, so the edit is picked up through exactly the code path
// production uses.
describe("a definition edited on the box reaches the next conversation, with no restart", () => {
  let previousCwd: string;
  let root: string;
  let agentJson: string;

  /** A throwaway <root>/services/<svc> + <root>/packages/agent-kit/templates/<role>, mirroring
   *  the real workspace layout `roleMdPath` walks. */
  beforeEach(() => {
    previousCwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), "definition-edit-"));

    const service = join(root, "services", "agent-under-test");
    mkdirSync(join(service, "agent"), { recursive: true });
    copyFileSync(join(previousCwd, "agent", "voice.md"), join(service, "agent", "voice.md"));

    const roleMd = roleMdPath(previousCwd);
    const roleDir = dirname(roleMdPath(service));
    mkdirSync(roleDir, { recursive: true });
    copyFileSync(roleMd, join(roleDir, "role.md"));

    agentJson = join(service, "agent.json");
    writeFileSync(agentJson, JSON.stringify({ ...(manifest as object), model: "heiberg-brain" }, null, 2));

    process.chdir(service);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });

  const edit = (patch: Record<string, unknown>) => {
    const current = JSON.parse(readFileSync(agentJson, "utf8")) as Record<string, unknown>;
    writeFileSync(agentJson, JSON.stringify({ ...current, ...patch }, null, 2));
  };

  it("the NEXT session sees the edit; the one already running does not", async () => {
    const before = await thisAgent("session-a");
    expect(before.loaded.definition.model).toBe("heiberg-brain");

    edit({ model: "heiberg-writer", language: "no" });

    // The conversation already under way keeps the definition it started on. This is the memo's
    // whole purpose: the persona the model was given and the model it runs on cannot disagree
    // half way through a conversation.
    const sameSession = await thisAgent("session-a");
    expect(sameSession.loaded.definition.model).toBe("heiberg-brain");
    expect(sameSession.loaded.hash).toBe(before.loaded.hash);

    // The next conversation — same process, same container, nothing restarted — sees the edit.
    const next = await thisAgent("session-b");
    expect(next.loaded.definition.model).toBe("heiberg-writer");
    expect((next.loaded.definition as { language?: string }).language).toBe("no");
    expect(next.loaded.hash).not.toBe(before.loaded.hash);
  });

  it("a duties file written on the box reaches the next conversation's persona", async () => {
    expect((await thisAgent("duties-before")).loaded.dutiesMd).toBe("");

    writeFileSync(join(process.cwd(), "agent", "duties.md"), "Keep the books.\n");

    const after = await thisAgent("duties-after");
    expect(after.loaded.dutiesMd).toBe("Keep the books.\n");
    // And it lands in the instruction stack, between the role and the voice.
    const out = assemblePersona({
      manifest: after.loaded.definition,
      roleMd: readFileSync(roleMdPath(process.cwd()), "utf8"),
      voiceMd: after.loaded.voiceMd,
      dutiesMd: after.loaded.dutiesMd,
      displayName: after.loaded.definition.display ?? after.loaded.definition.name,
      deployedTools: [],
    });
    expect(out).toMatch(/— role\n[\s\S]*\n\n# .+ — duties\nKeep the books\.\n\n# .+ — voice/u);
  });

  it("an empty or missing session id reads fresh and pins nothing", async () => {
    // eve builds its resolver context as `session: { id: get(SessionIdKey) ?? "" }`, and "" is
    // not nullish. Collapsing that onto one shared key would hand every conversation in the
    // process the same definition forever, with no signal — the bug this change removed, wearing
    // a different hat. Distinct objects prove nothing was shared.
    const first = await thisAgent("");
    edit({ model: "heiberg-writer" });
    const second = await thisAgent("");
    const third = await thisAgent(undefined);
    expect(first.loaded.definition.model).toBe("heiberg-brain");
    expect(second.loaded.definition.model).toBe("heiberg-writer");
    expect(third.loaded.definition.model).toBe("heiberg-writer");
  });

  it("every consumer of one session shares a single read", async () => {
    const [a, b, c] = await Promise.all([
      thisAgent("one-session"), thisAgent("one-session"), thisAgent("one-session"),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("a failed read is never pinned — the next consumer retries instead of inheriting it", async () => {
    rmSync(join(process.cwd(), "agent.json"));
    await expect(thisAgent("recovering")).rejects.toThrow();

    // One transient failure used to wedge the agent until restart, because the rejected promise
    // stayed in the memo forever.
    writeFileSync(agentJson, JSON.stringify({ ...(manifest as object), model: "heiberg-brain" }, null, 2));
    const recovered = await thisAgent("recovering");
    expect(recovered.loaded.definition.model).toBe("heiberg-brain");
  });
});

// ORB-278 step 2, Task 6 — the tool-count/tool-list assertion this task would otherwise put in
// `tests/agent-declaration.test.ts`, alongside the sibling changes in creative's and travel's
// copies of that file. That file does not exist yet for this service: it is LAR-41's (the
// 2026-09-16 SDD ledger's frozen list — `packages/agent-kit/src/manifest.ts`,
// `packages/agent-kit/extension/**`, and this service's own `agent.json`, `agent/extensions/
// agent-kit/**`, `agent/skills/**`, `lib/brief-content.ts`, `agent/schedules/morning-brief.ts`,
// `tests/agent-declaration.test.ts` and `tests/skills.test.ts`). Landing this assertion there
// would race LAR-41's own edits to the same file; it lives here instead, in a file this task
// already owns.
describe("set_language ships as this service's one new tool", () => {
  // ORB-278 step 2, Task 9: set_language moved from agent/tools/ into catalogue/ along with
  // every other local tool — it is ALWAYS_PRESENT there (Ruling R2), not a disabled sentinel,
  // and the catalogue resolver (agent/tools/catalogue.ts) hands it over unconditionally.
  it("catalogue/set_language.ts is a real, always-present tool — not a disabled sentinel", async () => {
    const mod = (await import("../catalogue/set_language.js")) as { default: unknown };
    expect(isDisabledToolSentinel(mod.default)).toBe(false);
  });

  it("is on disk beside every other authored tool file, once", () => {
    const names = readdirSync(join(process.cwd(), "catalogue"))
      .filter((f) => f.endsWith(".ts") && f !== "index.ts")
      .map((f) => f.replace(/\.ts$/u, ""));
    expect(names.filter((n) => n === "set_language")).toEqual(["set_language"]);
  });

  it("is in the deployed tool list eve build reads off disk (the +1 in the fleet's 70 -> 71)", () => {
    // `deployedToolsFor` is a FILE count (this file's own header, `packages/agent-kit/src/
    // persona/deployed-tools.ts`) — the authority on what actually shipped is the compiled
    // manifest, which needs a real `eve build` this suite does not run. What this assertion
    // pins is narrower and still load-bearing: the file exists where eve looks for it, so it is
    // not merely present under some other name or in the wrong directory.
    expect(deployedToolsFor(process.cwd())).toContain("set_language");
  });
});
