// W8C-s5 — the model key is tested with a real completion, before anything is built on it. The
// live call and its parsing were built and probed in W8A-s7 (`services/box/bin/doctor.ts
// --test-model`); this only proves that install.sh WIRES it correctly. `lares-doctor` is a
// command resolved from PATH, exactly like docker/chown/ufw elsewhere in this script, so it is
// stubbed here the same way — NOTHING in this file makes a real network call.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "install.sh");

let dir: string, binDir: string, prefix: string, log: string, secretsDir: string, releaseFile: string;

/** A release with one digest-named image — enough to get past the release rules; the renderer
 *  itself is stubbed in this file (see RENDER_STACK). */
const RELEASE = JSON.stringify({
  release: "2026-10-01",
  images: { db: `example.invalid/lares-db@sha256:${"a".repeat(64)}` },
  migrations: { box: "087_update_history.sql" },
  breaking: [],
});

/** W8F-F7a: run_stack renders the installation's stack file through
 *  `pnpm -C <box> render-stack <release> <out> …` and refuses if nothing lands at <out>, so
 *  every `pnpm` stub in an installer test has to answer that one call — and, since W8F-F7b,
 *  the `render-keeper-config` call run_keeper makes at the end for the same reason. A placeholder stack file
 *  is enough here — this file is about the model check, not about what the stack contains.
 *  tests/install-stack.test.ts is where the REAL renderer runs. */
const RENDER_STACK = `case "$3" in render-stack) printf 'services:\\n  db: {}\\n' > "$5"; exit 0 ;; render-keeper-config) printf '{}\\n' > "$5"; printf 'LARES_KEEPER_IMAGE=placeholder\\n' > "$6"; exit 0 ;; esac`;

/** A stub that logs its own name and argv, and exits 0 unless `body` says otherwise. */
function stub(name: string, body = "exit 0") {
  const p = join(binDir, name);
  const prelude = name === "pnpm" && !body.includes("render-stack") ? `${RENDER_STACK}\n` : "";
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_LOG"\n${prelude}${body}\n`);
  chmodSync(p, 0o755);
}

/** Same shape as install-wizard.test.ts's runWithStdin: delivers `input` on stdin, one answer
 *  per line, exactly as a person's keyboard would. Unlike that file, every call here bakes in
 *  `--yes`: this file is about one thing only — proving install.sh's wiring to `lares-doctor`
 *  after the four questions — never about screen one's own fresh-or-restore prompt, which this
 *  script would otherwise ask first (and, over a piped, non-tty stdin, refuse for lack of an
 *  answer) on every single case below. */
function runWithStdin(args: string[], input: string, env: Record<string, string> = {}) {
  try {
    // `--release` is load-bearing since W8F-F7a: a fresh install given none refuses with
    // EX_USAGE before it writes anything. Every run here is given the fixture written in
    // beforeEach; tests/install-stack.test.ts is where the flag itself is the subject.
    const stdout = execFileSync("/bin/bash", [SCRIPT, "--yes", "--release", releaseFile, ...args], {
      input,
      encoding: "utf8",
      env: { PATH: `${binDir}:/usr/bin:/bin`, STUB_LOG: log, LARES_PREFIX: prefix, HOME: dir, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const answers = ["lares.example.invalid", "owner@example.invalid", "A Name", "sk-disposable-fixture-only"].join("\n") + "\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-install-model-test-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  prefix = join(dir, "root"); mkdirSync(prefix);
  secretsDir = join(prefix, "etc", "lares", "secrets");
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  for (const name of ["docker", "systemctl", "useradd", "groupadd", "chown", "chmod", "ufw", "curl", "pnpm", "openssl"]) stub(name);
  stub("id", "echo 0");                                   // running as root
  stub("uname", "echo Linux");
  stub("free", 'echo "Mem: 8192 1024 7168"');
  stub("df", 'echo "/dev/x 100000000 1000000 99000000 1% /"');
  stub("ss", "exit 1");                                   // nothing listening on 80/443
  stub("lsb_release", "echo 24.04");
  // DNS (owner decision C5): getent and hostname agree, so the fixture domain resolves here —
  // this file is not about DNS, so it is fixed to "always fine" and never varied.
  stub("getent", 'if [ "$1" = "hosts" ]; then echo "203.0.113.10 $2"; fi');
  stub("hostname", 'if [ "$1" = "-I" ]; then echo "203.0.113.10"; fi');
  // W8F-F7a: the installer renders its own stack file from the release it was given, one step
  // before the model check. This file is not about that step, so it gets a minimal release and
  // a stubbed renderer (above) rather than a hand-placed compose fixture.
  releaseFile = join(dir, "release.json"); writeFileSync(releaseFile, RELEASE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("proving the model key before going further", () => {
  it("asks the model one real question and reports that it answered", () => {
    stub("lares-doctor", 'printf "%s\\n" "the model answered"; exit 0');
    const r = runWithStdin([], answers);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/the model answered/);
    expect(readFileSync(log, "utf8")).toMatch(/lares-doctor .*--test-model/);
  });

  it("stops when the key does not work, and says what to change, keeping everything already done", () => {
    stub("lares-doctor", 'echo "the gateway refused the key (GATEWAY_KEY_FILE)" >&2; exit 1');
    const r = runWithStdin([], answers);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/refused the key/);
    // Everything generated before this point survives, so a re-run resumes rather than restarts.
    expect(readdirSync(join(prefix, "etc/lares/secrets"))).toContain("token-enc-key");
  });

  it("never puts the key on a command line", () => {
    stub("lares-doctor", "exit 0");
    runWithStdin([], answers);
    expect(readFileSync(log, "utf8")).not.toContain("sk-disposable-fixture-only");
  });

  it("skips the call entirely on a dry run", () => {
    stub("lares-doctor", "exit 0");
    runWithStdin(["--dry-run"], answers);
    expect(readFileSync(log, "utf8")).not.toMatch(/--test-model/);
  });
});
