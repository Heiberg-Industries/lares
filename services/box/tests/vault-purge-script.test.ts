// vault-purge.sh is the deliberately hard-to-run second half of "erase a person"
// (W5B-s9): rewriting a vault's git history so a removed file's old content no
// longer exists under any commit id. It refuses by default, requires an explicit
// long flag to do anything, requires a clean git work tree, and never sends its
// result anywhere. These tests drive the real script against a REAL disposable git
// repository (no Docker, no Postgres) — `git` itself is used for real, and only
// `git-filter-repo` (which the script dispatches to as a git subcommand) is
// stubbed, the same way other ops-script tests in this package stub the external
// programs they shell out to (see tests/restore-drill.test.ts).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "vault-purge.sh");
const DOC = join(here, "..", "..", "..", "docs", "how-to", "erasing-a-person.md");

let dir: string;
let binDir: string;
let vault: string;

/** A minimal, real git repository with one committed file, used as --vault. */
function initVault() {
  vault = join(dir, "vault");
  mkdirSync(vault);
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(vault, "secret.md"), "old content\n");
  git(["add", "secret.md"]);
  git(["commit", "-q", "-m", "add secret.md"]);
}

function git(args: string[]) {
  execFileSync("git", ["-C", vault, ...args], { encoding: "utf8" });
}

/** A stub `git-filter-repo` on PATH: git dispatches "git filter-repo" to this
 *  binary by name, exactly the way it dispatches any other subcommand. Logs its
 *  argv and exits 0 without touching the repository — the real tool's behaviour
 *  is not what this suite is testing. */
function stageFilterRepoStub() {
  const stub = join(binDir, "git-filter-repo");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "\${FILTER_REPO_LOG}"\nexit 0\n`,
  );
  chmodSync(stub, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vault-purge-"));
  binDir = join(dir, "bin");
  mkdirSync(binDir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], opts: { path?: string; env?: Record<string, string> } = {}) {
  try {
    const stdout = execFileSync("/bin/bash", [SCRIPT, ...args], {
      env: {
        ...process.env,
        PATH: opts.path ?? `${binDir}:${process.env.PATH}`,
        ...opts.env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("vault-purge.sh", () => {
  it("is valid under macOS bash 3.2", () => {
    execFileSync("/bin/bash", ["-n", SCRIPT]);
  });

  it("refuses without the explicit flag, and says what it would do", () => {
    const out = run([]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/rewrites every commit id/i);
    expect(out.stderr).toMatch(/--i-understand-this-rewrites-history/);
  });

  it("refuses when --vault is missing", () => {
    initVault();
    const out = run(["--path", "secret.md", "--i-understand-this-rewrites-history"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/--vault/);
  });

  it("refuses when no --path is given", () => {
    initVault();
    const out = run(["--vault", vault, "--i-understand-this-rewrites-history"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/--path/);
  });

  it("refuses a path starting with '/'", () => {
    initVault();
    const out = run(["--vault", vault, "--path", "/etc/passwd", "--i-understand-this-rewrites-history"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/starts with/);
  });

  it("refuses a path containing '..'", () => {
    initVault();
    const out = run(["--vault", vault, "--path", "../outside.md", "--i-understand-this-rewrites-history"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/\.\./);
  });

  it("refuses a vault that is not a git work tree", () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const out = run(["--vault", plain, "--path", "secret.md", "--i-understand-this-rewrites-history"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/not a git work tree/);
  });

  it("refuses a vault with uncommitted changes", () => {
    initVault();
    writeFileSync(join(vault, "secret.md"), "changed but not committed\n");
    const out = run(["--vault", vault, "--path", "secret.md", "--i-understand-this-rewrites-history"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/uncommitted changes/);
  });

  it("when git filter-repo is not installed, prints the exact install line and exits 2", () => {
    initVault();
    // A narrow PATH that still finds the real `git`, `bash` and coreutils this
    // script needs, but excludes wherever this dev machine's own git-filter-repo
    // (if any) happens to live.
    const out = run(["--vault", vault, "--path", "secret.md", "--i-understand-this-rewrites-history"], {
      path: "/usr/bin:/bin",
    });
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/not installed/);
    expect(out.stderr).toContain("pip install git-filter-repo");
  });

  it("runs git filter-repo only with the flag, on a clean vault, and never pushes", () => {
    initVault();
    stageFilterRepoStub();
    const log = join(dir, "filter-repo.log");
    const out = run(["--vault", vault, "--path", "secret.md", "--i-understand-this-rewrites-history"], {
      env: { FILTER_REPO_LOG: log },
    });
    expect(out.status).toBe(0);
    const invoked = readFileSync(log, "utf8");
    expect(invoked).toContain("--invert-paths");
    expect(invoked).toContain("secret.md");
    expect(invoked).toContain("--force");
  });

  it("without the flag, filter-repo is never invoked even when installed", () => {
    initVault();
    stageFilterRepoStub();
    const log = join(dir, "filter-repo.log");
    const out = run(["--vault", vault, "--path", "secret.md"], { env: { FILTER_REPO_LOG: log } });
    expect(out.status).toBe(2);
    expect(existsSync(log)).toBe(false);
  });

  it("tells the operator plainly what to do next", () => {
    initVault();
    stageFilterRepoStub();
    const out = run(["--vault", vault, "--path", "secret.md", "--i-understand-this-rewrites-history"], {
      env: { FILTER_REPO_LOG: join(dir, "filter-repo.log") },
    });
    expect(out.stdout).toMatch(/re-clone/i);
    expect(out.stdout).toMatch(/invalid/i);
  });

  it("never pushes", () => {
    expect(readFileSync(SCRIPT, "utf8")).not.toMatch(/git\s+(-C\s+\S+\s+)?push/);
  });

  it("names no person, no host and no installation", () => {
    const src = readFileSync(SCRIPT, "utf8") + readFileSync(DOC, "utf8");
    expect(src).not.toMatch(/\b(Saga|Marcel|Calliope|bendik|orbis|heiberg)\b/i);
  });

  it("the how-to states the four things an erase does not reach", () => {
    const doc = readFileSync(DOC, "utf8");
    for (const s of [/git history/i, /backup/i, /open session/i, /separate database/i]) expect(doc).toMatch(s);
  });
});
