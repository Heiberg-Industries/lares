// install.sh is the install command's preflight (W8C-s1, LAR-7 shortened —
// docs/decisions/0022-the-tested-install-path.md). It is the ONLY part of the installer
// built so far: it checks this box against the tested install path (a fresh Ubuntu
// server) and refuses, in one pass, before writing a single file, directory, user or
// container, if anything is wrong. Every problem is printed together, each with a
// paste-ready fix. Later slices (the secrets, the four questions, the database, the
// owner, the finish line) plug their own writes in behind this same discipline.
//
// Every external command this script calls (id, uname, lsb_release, free, df, docker,
// ss) is resolved from PATH, so these tests put a logging stub for each one ahead of
// everything else on PATH and drive the real script end to end — the pattern
// tests/restore-drill.test.ts and tests/vault-purge-script.test.ts already use. No real
// system file, package or container is ever touched.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync, statSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "install.sh");
let dir: string, binDir: string, prefix: string, log: string;

/** A stub that logs its own name and argv, and exits 0. */
function stub(name: string, body = 'exit 0') {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(p, 0o755);
}
function run(args: string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync("/bin/bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { PATH: `${binDir}:/usr/bin:/bin`, STUB_LOG: log, LARES_PREFIX: prefix, HOME: dir, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** A recursive, sorted (relative path, kind, content) snapshot of a directory tree —
 *  used to prove the preflight leaves a directory byte-identical, not just top-level
 *  empty. Content is only read for files (a directory's own bytes are not meaningful). */
function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dirPath: string) => {
    for (const name of readdirSync(dirPath).sort()) {
      const full = join(dirPath, name);
      const rel = relative(root, full);
      const st = statSync(full);
      if (st.isDirectory()) {
        out.push(`dir:${rel}`);
        walk(full);
      } else {
        out.push(`file:${rel}:${readFileSync(full, "utf8")}`);
      }
    }
  };
  walk(root);
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-install-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  prefix = join(dir, "root"); mkdirSync(prefix);
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  for (const name of ["docker", "systemctl", "useradd", "groupadd", "chown", "ufw", "curl", "pnpm", "openssl"]) stub(name);
  stub("id", 'echo 0');                                   // running as root
  stub("uname", 'echo Linux');
  stub("free", 'echo "Mem: 8192 1024 7168"');
  stub("df", 'echo "/dev/x 100000000 1000000 99000000 1% /"');
  stub("ss", 'exit 1');                                   // nothing listening on 80/443
  stub("lsb_release", 'echo 24.04');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the installer, before it writes anything", () => {
  it("passes a syntax check under this machine's bash", () => {
    expect(() => execFileSync("/bin/bash", ["-n", SCRIPT])).not.toThrow();
  });

  it("prints what it would do and touches nothing", () => {
    const r = run(["--dry-run", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/would/i);
    expect(readdirSync(prefix)).toEqual([]);
  });

  it("refuses when it is not root, and says so in one sentence", () => {
    stub("id", 'echo 1000');
    const r = run(["--yes"]);
    expect(r.code).toBe(77);
    expect(r.stderr).toMatch(/as root/i);
    expect(readdirSync(prefix)).toEqual([]);
  });

  it("refuses a box that is too small, naming the number it found and the number it needs", () => {
    stub("free", 'echo "Mem: 1024 512 512"');
    const r = run(["--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/memory/i);
    expect(r.stderr).toMatch(/1024|1 ?G/);
    expect(readdirSync(prefix)).toEqual([]);
  });

  it("refuses when something is already listening on the public ports", () => {
    stub("ss", 'echo "LISTEN 0 511 *:443 *:*"');
    expect(run(["--yes"]).code).toBe(78);
  });

  it("refuses when Docker is not installed, rather than installing it silently", () => {
    rmSync(join(binDir, "docker"));
    // Removing the stub is not enough where the HOST has Docker in /usr/bin (a GitHub runner
    // does): the script would find the real one, pass this check — and run it. So this case gets
    // a PATH made of the stubs plus links to every system tool EXCEPT anything named docker*.
    const clean = join(dir, "bin-without-docker");
    mkdirSync(clean);
    for (const from of ["/bin", "/usr/bin"]) {
      for (const name of readdirSync(from)) {
        if (name.startsWith("docker")) continue;
        try { symlinkSync(join(from, name), join(clean, name)); } catch { /* same name in both: first wins */ }
      }
    }
    const r = run(["--yes"], { PATH: `${binDir}:${clean}` });
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/docker/i);
  });

  it("rejects an unknown flag instead of reading it as no flags", () => {
    expect(run(["--wat"]).code).toBe(64);
  });

  it("finds an existing installation and repairs rather than starting over", () => {
    mkdirSync(join(prefix, "srv", "lares"), { recursive: true });
    const r = run(["--dry-run", "--yes"]);
    expect(r.stdout).toMatch(/repair/i);
    expect(r.stdout).not.toMatch(/start(ing)? fresh/i);
  });

  // Added beyond the plan's own snippet: the plan's cases only ever assert the target
  // directory is EMPTY (there was nothing to disturb). This proves the stronger claim
  // the task actually requires — a directory that already holds files from a previous
  // partial run comes back byte-identical — and that the run touched no stub except
  // the read-only probes (id, uname, lsb_release, free, df, ss, docker's own presence
  // check): never useradd, groupadd, chown, ufw, curl, pnpm, openssl or systemctl,
  // which this slice has no business calling at all.
  it("leaves an existing tree byte-identical, and calls no stub but a read-only probe", () => {
    mkdirSync(join(prefix, "srv", "lares", "agents"), { recursive: true });
    writeFileSync(join(prefix, "srv", "lares", "agents", "keep.txt"), "already here\n");
    writeFileSync(join(prefix, "etc-lares-placeholder.txt"), "untouched\n");
    const before = snapshotTree(prefix);

    const r = run(["--dry-run", "--yes"]);
    expect(r.code).toBe(0);
    expect(snapshotTree(prefix)).toEqual(before);

    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => l.split(" ")[0]);
    const writeCapableStubs = ["useradd", "groupadd", "chown", "ufw", "curl", "pnpm", "openssl", "systemctl"];
    expect(calls.filter((c) => writeCapableStubs.includes(c!))).toEqual([]);
  });
});
