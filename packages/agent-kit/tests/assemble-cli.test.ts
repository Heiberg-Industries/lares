// bin/assemble-instructions.ts — the build hook (ORB-145 Phase 2, Task 7). Spawned for real,
// the same way notion-sync's entrypoint test spawns bin/notion-sync.ts: this is the file three
// Phase-3 services actually run before `eve build`, so a mistake in its argv wiring or its
// success/failure contract would be invisible to every test that only imports lib/ functions.
//
// The two properties under test:
//   1. On a clean role template, the written file is BYTE-IDENTICAL to calling
//      `assemblePersona` in-process with the same inputs — the CLI adds no behaviour of its
//      own beyond reading argv, loading the manifest and writing the result.
//   2. On a role template that fails `lintRole` (or a manifest that fails
//      `assertDeclarationIntegrity`), the process exits non-zero, explains why on stderr, and
//      — the property that matters most for a build hook — writes NOTHING, so a half-generic
//      template can never ship as a real agent's instructions by accident.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "../src/manifest.js";
import { assemblePersona } from "../src/persona/index.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..");
const SCRIPT = "bin/assemble-instructions.ts";

// The Task 5 manifest fixture (tests/persona-assemble.test.ts), verbatim, with `persona`
// pointed at a real file the fixture dir below creates — assemble-instructions.ts never reads
// that file itself, but assertDeclarationIntegrity is read fresh for this task per the brief,
// and a fixture that assumes nothing about whether it checks the path is the safer one to ship.
const FIXTURE_MANIFEST = {
  name: "t", model: "m", persona: "persona.md", channels: ["slack"], egress: { sealed: true },
  grants: [
    { capability: "vault", scope: "write-with-confirm" as const, areas: ["private"] as const },
    { capability: "orakel", scope: "read" as const },
    { capability: "remind", scope: "write" as const },
  ],
  autonomy: { vault: "gated" as const },
  skills: [{ name: "commercial", requires: [{ capability: "orakel", scope: "read" as const }] }],
};

// Proven generic by persona-lint.test.ts ("passes a generic role").
const CLEAN_ROLE = "## Duties\nI run the owner's inbox and calendar and keep the obligations radar honest.\n";
// Proven to catch a `person` finding by persona-lint.test.ts ("I work for Bendik." there).
const BENDIK_ROLE = "I work for Bendik.\n";
const VOICE = "Plain and dry. Short sentences. No exclamation marks.\n";

interface Fixture { agentDir: string; rolePath: string; voicePath: string; outPath: string }

/** The tool FILES the fixture agent ships — a deliberate SUBSET of what its three capabilities'
 *  docs name between them, so the CLI's filtering has something to prove. `remind` deploys two
 *  of its three (`remind_cancel` has no file); `vault` deploys one of seven; `orakel` one of
 *  three. Names only: the files' contents are never imported (deployed-tools.ts reads the
 *  directory, it does not load the modules), so a comment line is a complete fixture. */
const FIXTURE_AUTHORED_TOOLS = ["remind_set", "remind_list"];
const FIXTURE_EXTENSION_TOOLS = ["vault_search", "orakel_search"];
const FIXTURE_DEPLOYED_TOOLS = [
  ...FIXTURE_AUTHORED_TOOLS,
  ...FIXTURE_EXTENSION_TOOLS.map((n) => `agent-kit__${n}`),
].sort();

/** Every temp dir this file has made, removed in afterAll — as every sibling test that calls
 *  mkdtempSync does (vault-raw, langfuse-otel, gateway-provider, manifest). Each fixture here is
 *  a whole agent folder, and eight of them per run left behind adds up on a machine that runs
 *  the suite all day. */
const FIXTURE_DIRS: string[] = [];
afterAll(() => {
  for (const dir of FIXTURE_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** A temp dir with everything the CLI needs — agent.json (+ the persona file it points to),
 *  role.md, voice.md, and the two tool directories eve loads from — so each test only has to
 *  vary the one input it means to test. */
function makeFixture(roleMd: string, manifest: object = FIXTURE_MANIFEST): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "assemble-instructions-"));
  FIXTURE_DIRS.push(dir);
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "agent.json"), JSON.stringify(manifest));
  writeFileSync(join(agentDir, "persona.md"), "placeholder — never read by assemble-instructions.ts itself.\n");
  const toolsDir = join(agentDir, "agent", "tools");
  mkdirSync(toolsDir, { recursive: true });
  for (const name of FIXTURE_AUTHORED_TOOLS) writeFileSync(join(toolsDir, `${name}.ts`), "// fixture — never imported\n");
  const extensionDir = join(agentDir, "agent", "extensions", "agent-kit", "tools");
  mkdirSync(extensionDir, { recursive: true });
  for (const name of FIXTURE_EXTENSION_TOOLS) writeFileSync(join(extensionDir, `${name}.ts`), "// fixture — never imported\n");
  const rolePath = join(dir, "role.md");
  writeFileSync(rolePath, roleMd);
  const voicePath = join(dir, "voice.md");
  writeFileSync(voicePath, VOICE);
  return { agentDir, rolePath, voicePath, outPath: join(dir, "instructions.md") };
}

/** Spawns the real CLI exactly as a Phase-3 service's build step would: `pnpm exec tsx` from
 *  inside packages/agent-kit, with exactly `args`. Never throws — a non-zero exit is a
 *  first-class result the failure-path tests need to inspect, not an exceptional one. */
function runRaw(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("pnpm", ["exec", "tsx", SCRIPT, ...args], {
      cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** The common case: all five flags, from a fixture. */
function run(f: Fixture, display = "Tess"): { status: number; stdout: string; stderr: string } {
  return runRaw([
    "--agent", f.agentDir, "--role", f.rolePath, "--voice", f.voicePath,
    "--display", display, "--out", f.outPath,
  ]);
}

/** The same five flags plus --check: assemble in memory and compare, never write. */
function check(f: Fixture, display = "Tess"): { status: number; stdout: string; stderr: string } {
  return runRaw([
    "--agent", f.agentDir, "--role", f.rolePath, "--voice", f.voicePath,
    "--display", display, "--out", f.outPath, "--check",
  ]);
}

describe("bin/assemble-instructions.ts — the build hook (ORB-145 Phase 2, Task 7)", () => {
  it("writes an instructions.md byte-identical to assemblePersona() in-process, and reports bytes/capabilities/skills", () => {
    const f = makeFixture(CLEAN_ROLE);
    const { status, stdout, stderr } = run(f);
    expect(stderr, `unexpected stderr: ${stderr}`).toBe("");
    expect(status).toBe(0);

    const expected = assemblePersona({
      manifest: parseManifest(FIXTURE_MANIFEST),
      roleMd: CLEAN_ROLE,
      voiceMd: VOICE,
      displayName: "Tess",
      // The CLI derives this from the agent folder; in-process we hand it the same list. That
      // the two agree IS the property — the CLI adds no rendering behaviour of its own.
      deployedTools: FIXTURE_DEPLOYED_TOOLS,
    });
    expect(readFileSync(f.outPath, "utf8")).toBe(expected);

    // 3 grants, none at scope "none"; 4 tool files on disk; 1 declared skill. "tool FILES" is
    // the CLI's own word: the count is deployedToolsFor's naive filesystem view, sentinels and all.
    const bytes = Buffer.byteLength(expected, "utf8");
    expect(stdout.trim()).toBe(`assembled ${f.outPath} (${bytes} bytes, 3 capabilities, 4 tool files, 1 skills)`);
  });

  it("names only the tools the agent folder actually holds, not the capability docs' unions", () => {
    // The Task 9 review finding, end to end through the real CLI: `remind`'s doc names three
    // tools and this agent ships two of them, so the written file must name exactly those two.
    const f = makeFixture(CLEAN_ROLE);
    expect(run(f).status).toBe(0);
    const written = readFileSync(f.outPath, "utf8");
    expect(written).toContain("`remind_set`");
    expect(written).toContain("`remind_list`");
    expect(written).not.toContain("`remind_cancel`");
    expect(written).toContain("`agent-kit__vault_search`");
    expect(written).not.toContain("`agent-kit__vault_write`");
  });

  it("is deterministic — running it twice on the same inputs writes the same bytes", () => {
    const f = makeFixture(CLEAN_ROLE);
    run(f);
    const first = readFileSync(f.outPath, "utf8");
    run(f, "Tess");
    expect(readFileSync(f.outPath, "utf8")).toBe(first);
  });

  it("refuses a role template that isn't generic — exits non-zero, names the person on stderr, writes nothing", () => {
    const f = makeFixture(BENDIK_ROLE);
    const { status, stdout, stderr } = run(f);
    expect(status).not.toBe(0);
    expect(stderr).toContain("person");
    expect(stdout).toBe("");
    expect(existsSync(f.outPath)).toBe(false);
  });

  // --check is what the image build runs (services/chief-of-staff/Dockerfile, immediately before
  // `eve build`). That build never assembles — it compiles the COMMITTED instructions.md — so
  // these two outcomes are the only thing standing between an un-reassembled commit and an
  // image that ships stale instructions. "Writes nothing" is asserted in BOTH failure cases,
  // because a check mode that repaired the file would turn a red build green and hide the very
  // drift it exists to catch.
  it("--check exits 0 and says so when the out file is already what the assembler would write", () => {
    const f = makeFixture(CLEAN_ROLE);
    expect(run(f).status).toBe(0);
    const { status, stdout, stderr } = check(f);
    expect(stderr, `unexpected stderr: ${stderr}`).toBe("");
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(`assemble-instructions: ${f.outPath} is up to date`);
  });

  it("--check exits 1 naming the stale file, and leaves it exactly as it was", () => {
    const f = makeFixture(CLEAN_ROLE);
    run(f);
    // Exactly the drift the guard is for: the file on disk no longer matches its inputs.
    const stale = `${readFileSync(f.outPath, "utf8")}\nan edit nobody re-assembled\n`;
    writeFileSync(f.outPath, stale);

    const { status, stdout, stderr } = check(f);
    expect(status).toBe(1);
    expect(stderr).toContain(f.outPath);
    expect(stderr).toContain("STALE");
    expect(stdout).toBe("");
    expect(readFileSync(f.outPath, "utf8")).toBe(stale);
  });

  it("--check exits 1 when the out file does not exist at all, and does not create it", () => {
    const f = makeFixture(CLEAN_ROLE);
    expect(existsSync(f.outPath)).toBe(false);
    const { status, stderr } = check(f);
    expect(status).toBe(1);
    expect(stderr).toContain(f.outPath);
    expect(stderr).toMatch(/does not exist/);
    expect(existsSync(f.outPath)).toBe(false);
  });

  it("a missing required flag is a usage error on stderr, exit 2, and writes nothing", () => {
    const f = makeFixture(CLEAN_ROLE);
    // --agent omitted on purpose.
    const { status, stderr } = runRaw([
      "--role", f.rolePath, "--voice", f.voicePath, "--display", "Tess", "--out", f.outPath,
    ]);
    expect(status).toBe(2);
    expect(stderr).toContain("--agent");
    expect(existsSync(f.outPath)).toBe(false);
  });

  // ORB-210 item 5. The success line's capability count and the number of bullets in the written
  // file are DIFFERENT numbers on purpose: the line reports what the declaration GRANTS (scope
  // not "none"), while renderEnvironment also drops a capability whose autonomy is "never". The
  // source says so in a comment; nothing said it in a test, so the day someone "fixed" the
  // mismatch there would have been nothing to argue with. Both halves are pinned here.
  it("the reported capability count is what the DECLARATION grants, not what one render shows", () => {
    const f = makeFixture(CLEAN_ROLE, {
      ...FIXTURE_MANIFEST,
      autonomy: { ...FIXTURE_MANIFEST.autonomy, remind: "never" as const },
    });
    const { status, stdout } = run(f);
    expect(status).toBe(0);
    // Three grants, none at "none" — the count is unchanged by the autonomy level.
    expect(stdout).toContain("3 capabilities");
    // ...and the render is down to two bullets, `remind` being switched off entirely.
    const written = readFileSync(f.outPath, "utf8");
    expect(written).toContain("- **vault**");
    expect(written).toContain("- **orakel**");
    expect(written).not.toContain("- **remind**");
  });

  it("refuses a role that names a tool this agent does not ship, and writes nothing", () => {
    // ORB-210 item 3, through the real CLI. `place_link` is a documented tool of `places`, which
    // this fixture neither grants nor ships a file for.
    const f = makeFixture("## Duties\nI fetch the link with `place_link`.\n");
    const { status, stderr } = run(f);
    expect(status).toBe(1);
    expect(stderr).toContain(f.rolePath);
    expect(stderr).toContain("`place_link`");
    expect(stderr).toMatch(/does not ship/);
    expect(existsSync(f.outPath)).toBe(false);
  });
});

// Lares repo split (ORB-262): the display name left the services' package.json scripts. With no
// `--display`, the assembler reads agent.json's own `display`, and without one uses `name`.
describe("bin/assemble-instructions.ts — display default (lares split, hook 30)", () => {
  function runWithoutDisplay(f: Fixture): { status: number; stdout: string; stderr: string } {
    return runRaw(["--agent", f.agentDir, "--role", f.rolePath, "--voice", f.voicePath, "--out", f.outPath]);
  }

  it("uses agent.json's display when --display is not passed", () => {
    const f = makeFixture(CLEAN_ROLE, { ...FIXTURE_MANIFEST, display: "Tess" });
    const { status, stderr } = runWithoutDisplay(f);
    expect(stderr, `unexpected stderr: ${stderr}`).toBe("");
    expect(status).toBe(0);
    expect(readFileSync(f.outPath, "utf8")).toContain("# Tess — who I am");
  });

  it("falls back to the agent's name when neither --display nor agent.json's display is set", () => {
    const f = makeFixture(CLEAN_ROLE);
    expect(runWithoutDisplay(f).status).toBe(0);
    expect(readFileSync(f.outPath, "utf8")).toContain(`# ${FIXTURE_MANIFEST.name} — who I am`);
  });

  it("--display still wins over agent.json's display", () => {
    const f = makeFixture(CLEAN_ROLE, { ...FIXTURE_MANIFEST, display: "Tess" });
    expect(run(f, "Ruth").status).toBe(0);
    const written = readFileSync(f.outPath, "utf8");
    expect(written).toContain("# Ruth — who I am");
    expect(written).not.toContain("# Tess —");
  });
});
