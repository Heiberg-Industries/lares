// W8C-s4 — four questions, asked once, written down (owner decisions C4 "what the wizard
// asks", C5 "the domain and the certificate", C6 "where the model key goes", A1 "secrets are
// files, never shown back").
//
// NOTHING HERE TOUCHES A REAL MACHINE OR A REAL NAME SERVER. Every run installs into a temp
// --prefix, every host command the script could call (including the two this slice adds —
// getent and hostname, the DNS seam) is a logging stub on PATH ahead of everything else, and
// answers are delivered on stdin exactly the way a person's keyboard would deliver them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "install.sh");

let dir: string, binDir: string, prefix: string, log: string, secretsDir: string, installEnv: string;
let releaseFile: string;

/** A release with one digest-named image — enough to get past the release rules; the renderer
 *  itself is stubbed here (see RENDER_STACK). */
const RELEASE = JSON.stringify({
  release: "2026-10-01",
  images: { db: `example.invalid/lares-db@sha256:${"a".repeat(64)}` },
  migrations: { box: "087_update_history.sql" },
  breaking: [],
});

/** W8F-F7a: run_stack renders the stack file through
 *  `pnpm -C <box> render-stack <release> <out> …` and refuses if nothing lands at <out>, so
 *  every `pnpm` stub in an installer test has to answer that one call — and, since W8F-F7b,
 *  the `render-keeper-config` call run_keeper makes at the end. This file is about the
 *  four questions, so a placeholder stack file is enough; tests/install-stack.test.ts is where
 *  the real renderer runs. */
const RENDER_STACK = `case "$3" in render-stack) printf 'services:\\n  db: {}\\n' > "$5"; exit 0 ;; render-keeper-config) printf '{}\\n' > "$5"; printf 'LARES_KEEPER_IMAGE=placeholder\\n' > "$6"; exit 0 ;; esac`;

/** A stub that logs its own name and argv, and exits 0. */
function stub(name: string, body = "exit 0") {
  const p = join(binDir, name);
  const prelude = name === "pnpm" && !body.includes("render-stack") ? `${RENDER_STACK}\n` : "";
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_LOG"\n${prelude}${body}\n`);
  chmodSync(p, 0o755);
}

/** Like install-secrets.test.ts's `run`, but delivers `input` on stdin — a person's typed
 *  answers, one per line, exactly as execFileSync's own `input` option feeds a child process. */
function runWithStdin(args: string[], input: string, env: Record<string, string> = {}) {
  try {
    // `--release` is load-bearing since W8F-F7a: a fresh install given none refuses with
    // EX_USAGE before it writes anything. Every run here is given the fixture written in
    // beforeEach; tests/install-stack.test.ts is where the flag itself is the subject.
    const stdout = execFileSync("/bin/bash", [SCRIPT, "--release", releaseFile, ...args], {
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
  dir = mkdtempSync(join(tmpdir(), "lares-install-wizard-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  prefix = join(dir, "root"); mkdirSync(prefix);
  secretsDir = join(prefix, "etc", "lares", "secrets");
  installEnv = join(prefix, "etc", "lares", "installation.env");
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  // `lares-doctor` (W8C-s5): every completed wizard run proves the model key through it, so a
  // run that is not about that proof stubs it silently green.
  for (const name of ["docker", "systemctl", "useradd", "groupadd", "chown", "chmod", "ufw", "curl", "pnpm", "openssl", "lares-doctor"]) stub(name);
  // CREATE DATABASE is sent on stdin; consume it before exiting so pipefail
  // does not race the fake Docker process under CI load.
  stub("docker", 'case "$*" in *"exec -T db psql"*) cat >/dev/null ;; esac\nexit 0');
  stub("id", "echo 0");                                   // running as root
  stub("uname", "echo Linux");
  stub("free", 'echo "Mem: 8192 1024 7168"');
  stub("df", 'echo "/dev/x 100000000 1000000 99000000 1% /"');
  stub("ss", "exit 1");                                   // nothing listening on 80/443
  stub("lsb_release", "echo 24.04");
  // DNS (owner decision C5): getent and hostname agree on one address by default, so the
  // fixture domain "lares.example.invalid" resolves to this server; individual tests below
  // override one or the other to prove the mismatch and no-answer refusals.
  stub("getent", 'if [ "$1" = "hosts" ]; then echo "203.0.113.10 $2"; fi');
  stub("hostname", 'if [ "$1" = "-I" ]; then echo "203.0.113.10"; fi');
  // W8F-F7a: the installer renders its own stack file from the release it was given, one step
  // after these questions. This file is not about that step, so it gets a minimal release and
  // a stubbed renderer (above) rather than a hand-placed compose fixture.
  releaseFile = join(dir, "release.json"); writeFileSync(releaseFile, RELEASE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("what the installer asks", () => {
  it("asks four things, and no more", () => {
    const r = runWithStdin(["--yes"], answers);
    const questions = r.stdout.split("\n").filter((l) => l.trim().endsWith("?"));
    expect(questions.length).toBeLessThanOrEqual(4);
    expect(r.stdout).toMatch(/domain/i);
    expect(r.stdout).toMatch(/e-?mail/i);
    expect(r.stdout).toMatch(/model/i);
  });

  it("writes the answers where the console and the agents will read them", () => {
    runWithStdin(["--yes"], answers);
    const env = readFileSync(installEnv, "utf8");
    expect(env).toContain("CONSOLE_ALLOWED_EMAILS=owner@example.invalid");
    expect(env).toContain("CONSOLE_OAUTH_REDIRECT=https://lares.example.invalid/api/auth/callback");
    expect(env).toContain("OWNER_HOME_TZ=");
    expect(env).not.toContain("sk-disposable-fixture-only");
  });

  it("keeps the model key out of the settings file and out of every log", () => {
    const r = runWithStdin(["--yes"], answers);
    expect(readFileSync(join(secretsDir, "model-provider-key"), "utf8").trim())
      .toBe("sk-disposable-fixture-only");
    expect(r.stdout).not.toContain("sk-disposable-fixture-only");
    expect(readFileSync(log, "utf8")).not.toContain("sk-disposable-fixture-only");
  });

  it("does not ask again on a re-run", () => {
    runWithStdin(["--yes"], answers);
    const second = runWithStdin(["--yes"], "");
    expect(second.code).toBe(0);
    expect(second.stdout.split("\n").filter((l) => l.trim().endsWith("?")).length).toBe(0);
  });

  it("refuses a domain or an address it cannot use, and asks again rather than saving it", () => {
    const r = runWithStdin(
      ["--yes"],
      ["not a domain", "lares.example.invalid", "not an address", "owner@example.invalid", "A Name", "sk-x"].join("\n") + "\n",
    );
    expect(readFileSync(installEnv, "utf8")).toContain("LARES_DOMAIN=lares.example.invalid");
    expect(r.stdout).toMatch(/does not look like/i);
  });

  it("never assumes one person — the allow-list is a list, and the file says so", () => {
    runWithStdin(["--yes"], answers);
    expect(readFileSync(installEnv, "utf8")).toMatch(/# .*comma-separated/i);
  });

  // --- Added beyond the plan's own snippet ----------------------------------------------

  it("does not ask or write anything on a dry run", () => {
    const r = runWithStdin(["--dry-run", "--yes"], "");
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").filter((l) => l.trim().endsWith("?")).length).toBe(0);
    expect(existsSync(installEnv)).toBe(false);
    expect(existsSync(join(secretsDir, "model-provider-key"))).toBe(false);
  });

  it("resolves the domain against this server (owner decision C5), and refuses with the exact record on a mismatch", () => {
    stub("getent", 'if [ "$1" = "hosts" ]; then echo "198.51.100.9 $2"; fi');
    const r = runWithStdin(["--yes"], answers);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/resolves to/i);
    expect(r.stderr).toMatch(/A\s+lares\.example\.invalid\s+203\.0\.113\.10/);
    expect(existsSync(installEnv)).toBe(false);
  });

  it("refuses, naming the DNS record to create, when the domain does not resolve anywhere yet", () => {
    stub("getent", "exit 2");
    const r = runWithStdin(["--yes"], answers);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/does not resolve/i);
    expect(r.stderr).toContain("lares.example.invalid");
    expect(r.stderr).toMatch(/A\s+lares\.example\.invalid\s+203\.0\.113\.10/);
    expect(existsSync(installEnv)).toBe(false);
  });

  it("never puts the model key on a command line or lets any called command see it", () => {
    runWithStdin(["--yes"], answers);
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("sk-disposable-fixture-only");
  });

  it("takes the model key from a named file instead of the keyboard, and never asks for it", () => {
    const keyFile = join(dir, "key.txt");
    writeFileSync(keyFile, "sk-disposable-fixture-only\n");
    const r = runWithStdin(
      ["--yes", "--model-key-file", keyFile],
      ["lares.example.invalid", "owner@example.invalid", "A Name"].join("\n") + "\n",
    );
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/paste your/i);
    expect(readFileSync(join(secretsDir, "model-provider-key"), "utf8").trim())
      .toBe("sk-disposable-fixture-only");
  });

  it("refuses, naming the flag, rather than hanging when there is no terminal and an answer runs out", () => {
    const r = runWithStdin(["--yes"], "lares.example.invalid\nowner@example.invalid\n");
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/--name/);
  });

  it("refuses a name that is too long instead of truncating it silently", () => {
    const longName = "x".repeat(250);
    const r = runWithStdin(
      ["--yes"],
      ["lares.example.invalid", "owner@example.invalid", longName, "second try name", "sk-x"].join("\n") + "\n",
    );
    expect(r.code).toBe(0);
    expect(readFileSync(installEnv, "utf8")).toContain("second try name");
  });

  it("keeps hostile characters in a name inert — never executed, even by something that mistakenly sources the file", () => {
    const pwned1 = join(dir, "pwned1");
    const pwned2 = join(dir, "pwned2");
    const hostileName = `O'Brien\`touch ${pwned1}\`;$(touch ${pwned2})|Name`;
    const r = runWithStdin(
      ["--yes"],
      ["lares.example.invalid", "owner@example.invalid", hostileName, "sk-disposable-fixture-only"].join("\n") + "\n",
    );
    expect(r.code).toBe(0);
    // Never executed while THIS script processed it.
    expect(existsSync(pwned1)).toBe(false);
    expect(existsSync(pwned2)).toBe(false);
    // The sharpest proof of inertness: even a deliberate, mistaken `source` of the file does
    // not run anything embedded in the name. The file's own header says never to do this.
    execFileSync("/bin/bash", ["-c", ". \"$1\"", "bash", installEnv]);
    expect(existsSync(pwned1)).toBe(false);
    expect(existsSync(pwned2)).toBe(false);
  });
});
