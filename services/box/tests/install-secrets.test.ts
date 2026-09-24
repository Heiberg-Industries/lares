// W8C-s2 — the credentials the installer creates, and the two promises that make a failed
// install safe to re-run: a secret that already exists is NEVER regenerated, and no secret's
// value ever leaves the file it was written into.
//
// NOTHING HERE TOUCHES A REAL MACHINE. Every run installs into a temp `--prefix`, every host
// command the script could call is a logging stub on PATH ahead of everything else, and the
// only real entropy source is /dev/urandom (which is a read, not a write). The tests below
// assert on what the stubs were asked to do — never on this machine's /etc.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, readdirSync, rmSync,
  statSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "install.sh");

/** The six the installer is responsible for. The model PROVIDER key is deliberately NOT here:
 *  it is ASKED for in a later slice, and a generated placeholder would be indistinguishable
 *  from a real key to every check that comes after. */
const EXPECTED = [
  "console-session-secret", "database-password", "eve-route-password",
  "gateway-key", "gateway-master-key", "token-enc-key",
].sort();

let dir: string, binDir: string, prefix: string, log: string, secretsDir: string;
let keyFile: string, releaseFile: string;

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
 *  secrets, so a placeholder stack file is enough; tests/install-stack.test.ts is where the
 *  real renderer runs. */
const RENDER_STACK = `case "$3" in render-stack) printf 'services:\\n  db: {}\\n' > "$5"; exit 0 ;; render-keeper-config) printf '{}\\n' > "$5"; printf 'LARES_KEEPER_IMAGE=placeholder\\n' > "$6"; exit 0 ;; esac`;

/** A stub that logs its own name and argv, and exits 0. */
function stub(name: string, body = "exit 0") {
  const p = join(binDir, name);
  // Real psql consumes piped SQL. Exiting early can SIGPIPE the producer under pipefail.
  // Query-mode calls use -tAc and must not consume the installer's prompt input.
  if (name === "docker") {
    body = `case "$*" in *" -tAc "*) ;; *" psql "*) cat >/dev/null ;; esac\n${body}`;
  }
  const prelude = name === "pnpm" && !body.includes("render-stack") ? `${RENDER_STACK}\n` : "";
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_LOG"\n${prelude}${body}\n`);
  chmodSync(p, 0o755);
}

function run(args: string[], env: Record<string, string> = {}, opts: { giveModelKey?: boolean } = {}) {
  try {
    // Since W8C-s4 the installer asks its four questions right after the secrets. These tests
    // are about the secrets, so every run answers by flag (a dry run skips the questions anyway).
    // `--release` is load-bearing since W8F-F7a: a fresh install given none refuses with
    // EX_USAGE before it writes anything, which is before this file's subject even begins.
    const answered = ["--release", releaseFile, ...args,
      "--domain", "lares.example.invalid", "--email", "owner@example.invalid",
      "--name", "A Name", ...(opts.giveModelKey === false ? [] : ["--model-key-file", keyFile])];
    const stdout = execFileSync("/bin/bash", [SCRIPT, ...answered], {
      encoding: "utf8",
      env: { PATH: `${binDir}:/usr/bin:/bin`, STUB_LOG: log, LARES_PREFIX: prefix, HOME: dir, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** Every file under `root` that is NOT inside the secrets directory, as text. A secret's value
 *  must not appear in any of them. */
function filesOutsideSecrets(root: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (p === secretsDir) continue;
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push({ path: p, text: readFileSync(p, "latin1") });
    }
  };
  walk(root);
  return out;
}

function generatedValues(): { name: string; value: string }[] {
  return readdirSync(secretsDir).map((name) => ({
    name,
    value: readFileSync(join(secretsDir, name), "utf8").trim(),
  }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-install-secrets-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  prefix = join(dir, "root"); mkdirSync(prefix);
  secretsDir = join(prefix, "etc", "lares", "secrets");
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  // Everything that would touch a host. `chown` and `chmod` are stubs so the permissions the
  // installer ASKS for are assertable without this test needing to be root; `openssl` is a stub
  // that is expected never to be called at all (the entropy comes from /dev/urandom).
  // `lares-doctor` (W8C-s5): every completed wizard run proves the model key through it, so a
  // run that is not about that proof stubs it silently green.
  for (const name of ["docker", "systemctl", "useradd", "groupadd", "chown", "chmod", "ufw", "curl", "pnpm", "openssl", "getent", "lares-doctor"]) stub(name);
  // The only `getent` the installer may run is the DNS lookup for the domain (W8C-s4); both
  // seams agree on one address so that check passes. It must never look up a GROUP.
  stub("getent", 'if [ "$1" = "hosts" ]; then echo "203.0.113.10 $2"; else exit 2; fi');
  stub("hostname", 'if [ "$1" = "-I" ]; then echo "203.0.113.10"; fi');
  keyFile = join(dir, "model-key-input"); writeFileSync(keyFile, "sk-disposable-fixture-only\n");
  releaseFile = join(dir, "release.json"); writeFileSync(releaseFile, RELEASE);
  stub("id", "echo 0");                                   // running as root
  stub("uname", "echo Linux");
  stub("free", 'echo "Mem: 8192 1024 7168"');
  stub("df", 'echo "/dev/x 100000000 1000000 99000000 1% /"');
  stub("ss", "exit 1");                                   // nothing listening on 80/443
  stub("lsb_release", "echo 24.04");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the secrets the installer generates", () => {
  it("passes a syntax check under this machine's bash", () => {
    expect(() => execFileSync("/bin/bash", ["-n", SCRIPT])).not.toThrow();
  });

  it("refuses a runtime gid that the shipped images cannot read before writing a secret", () => {
    const r = run(["--yes"], { LARES_RUNTIME_GID: "10002" });
    expect(r.code).toBe(78);
    expect(r.stderr).toContain("every shipped runtime image uses gid 10001");
    expect(existsSync(secretsDir)).toBe(false);
  });

  it("writes one file per secret, numerically owned and group-readable, and nothing else", () => {
    // W8F-F7a: a completed run now also renders the stack file and brings it up before the
    // database step, from the release fixture every run here is given — so nothing has to be
    // placed under $PREFIX by hand any more.
    expect(run(["--yes"]).code).toBe(0);
    // `model-provider-key` is the one file here the installer did not generate: the owner gave it.
    expect(readdirSync(secretsDir).filter((n) => n !== "model-provider-key").sort()).toEqual(EXPECTED);
    const asked = readFileSync(log, "utf8").split("\n");
    const chowns = asked.filter((l) => l.startsWith("chown "));
    const chmods = asked.filter((l) => l.startsWith("chmod "));
    // Numeric, not a named group (controller ruling W8C-s2b/a): every runtime image runs
    // USER 10001:10001, and compose bind-mounts secrets with the host's ownership — a name
    // resolves to whatever gid happens to have it on THIS box, which does not have to be 10001.
    // The OWNER ARGUMENT (the second word of the logged argv) is what must be numeric — the
    // path after it legitimately contains "etc/lares/secrets" and must not trip this up.
    const ownerArgs = chowns
      .filter((l) => l.includes("/etc/lares/secrets"))
      .map((l) => l.split(" ")[1]);
    expect(ownerArgs.every((o) => o === "0:10001")).toBe(true);
    expect(ownerArgs.some((o) => /root|lares/.test(o!))).toBe(false);
    // Owner decision A1: files under /etc/lares/secrets are 0:10001 0440. Every secret file is
    // asked for exactly that mode, and the directory is never world-anything.
    for (const name of EXPECTED) {
      expect(chmods.some((l) => l.startsWith("chmod 0440 ") && l.includes(name)), name).toBe(true);
    }
    expect(chmods.some((l) => l.startsWith("chmod 0750 ") && l.trimEnd().endsWith("etc/lares/secrets"))).toBe(true);
  });

  it("never creates or references a named host group", () => {
    // W8C-s6: see the fixture note on the test above — this needs a full run to succeed too.
    mkdirSync(join(prefix, "opt", "lares"), { recursive: true });
    writeFileSync(join(prefix, "opt", "lares", "compose.yaml"), "services:\n  db: {}\n");
    expect(run(["--yes"]).code).toBe(0);
    const asked = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
    expect(asked.filter((l) => l.startsWith("groupadd "))).toEqual([]);
    expect(asked.filter((l) => l.startsWith("getent ") && !l.startsWith("getent hosts "))).toEqual([]);
  });

  it("gives the token encryption key the exact shape the code demands", () => {
    run(["--yes"]);
    const key = readFileSync(join(secretsDir, "token-enc-key"), "utf8").trim();
    // services/box/lib/crypto.ts keyBuf/keyFromEnv and services/console/lib/accounts.ts
    // tokenEncKeyHex — "must be a 64-char hex string".
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives every other secret the shape its own reader can use", () => {
    run(["--yes"]);
    const read = (n: string) => readFileSync(join(secretsDir, n), "utf8").trim();
    // base64url: safe inside an HTTP Basic credential (no colon), a URL, and a shell value.
    for (const name of ["console-session-secret", "database-password", "eve-route-password"]) {
      expect(read(name), name).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    // LiteLLM refuses a key that does not begin sk- (docs/research/2026-09-18-prelaunch/08-litellm-okf.md).
    for (const name of ["gateway-key", "gateway-master-key"]) {
      expect(read(name), name).toMatch(/^sk-[A-Za-z0-9_-]{43}$/);
    }
  });

  it("never regenerates a secret that already exists", () => {
    // W8C-s6: see the fixture note above — this needs two full runs to succeed.
    mkdirSync(join(prefix, "opt", "lares"), { recursive: true });
    writeFileSync(join(prefix, "opt", "lares", "compose.yaml"), "services:\n  db: {}\n");
    expect(run(["--yes"]).code).toBe(0);
    const before = generatedValues();
    const mtimes = before.map((s) => statSync(join(secretsDir, s.name), { bigint: true }).mtimeNs);
    expect(run(["--yes"]).code).toBe(0);
    // Byte-identical, and not even touched: regenerating token-enc-key would make every saved
    // sign-in unreadable, and regenerating database-password would lock the agents out.
    for (const [i, s] of before.entries()) {
      expect(readFileSync(join(secretsDir, s.name), "utf8").trim(), s.name).toBe(s.value);
      expect(statSync(join(secretsDir, s.name), { bigint: true }).mtimeNs, s.name).toBe(mtimes[i]);
    }
    // …and it does not re-permission them either: a running service must never lose access
    // halfway through a repair run.
    const second = readFileSync(log, "utf8");
    expect(second.split("\n").filter((l) => l.startsWith("chmod 0440 ") && !l.includes("model-provider-key")).length).toBe(EXPECTED.length);
  });

  it("says which secrets it left alone rather than silently skipping them", () => {
    run(["--yes"]);
    const r = run(["--yes"]);
    expect(r.stdout).toMatch(/already/i);
    expect(r.stdout).toContain("token-enc-key");
  });

  it("does not leave a half-written secret behind to be reused", () => {
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, "token-enc-key.partial"), "");
    run(["--yes"]);
    expect(readdirSync(secretsDir).filter((f) => f.endsWith(".partial"))).toEqual([]);
    expect(readFileSync(join(secretsDir, "token-enc-key"), "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("prints no secret, anywhere, on either stream or in any other file", () => {
    const r = run(["--yes"]);
    const outside = filesOutsideSecrets(prefix);
    for (const { name, value } of generatedValues()) {
      expect(value.length, name).toBeGreaterThan(20);
      expect(r.stdout, name).not.toContain(value);
      expect(r.stderr, name).not.toContain(value);
      expect(readFileSync(log, "utf8"), name).not.toContain(value);
      // Not a prefix of it either — a "first eight characters" hint is still a leak.
      expect(r.stdout, name).not.toContain(value.slice(0, 12));
      for (const f of outside) expect(f.text, `${name} in ${f.path}`).not.toContain(value);
    }
  });

  it("a secret never becomes an argument to anything", () => {
    run(["--yes"]);
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toMatch(/--password|--secret|-p\s+\S{20,}/);
    // Every logged argv is a path, a mode or an owner — nothing long and random.
    for (const value of generatedValues()) expect(calls).not.toContain(value.value);
  });

  it("takes its entropy from the operating system, not from a tool that may not be there", () => {
    run(["--yes"]);
    expect(readFileSync(log, "utf8")).not.toMatch(/^openssl /m);
  });

  it("names what it would create on a dry run, and creates nothing", () => {
    const r = run(["--dry-run", "--yes"]);
    expect(r.code).toBe(0);
    for (const name of EXPECTED) expect(r.stdout, name).toContain(name);
    expect(r.stdout).toMatch(/would/i);
    expect(existsSync(secretsDir)).toBe(false);
    expect(readdirSync(prefix)).toEqual([]);
  });

  it("on a dry run over an existing installation, says which already exist and touches none", () => {
    run(["--yes"]);
    const before = generatedValues();
    const r = run(["--dry-run", "--yes"]);
    expect(r.stdout).toMatch(/already/i);
    for (const { name, value } of before) {
      expect(readFileSync(join(secretsDir, name), "utf8").trim(), name).toBe(value);
      expect(r.stdout, name).not.toContain(value);
    }
  });

  it("does not invent the model provider key — that is asked for, not generated", () => {
    // No key file is given and there is nobody to ask: the installer refuses at that question —
    // after the generated secrets exist, and WITHOUT making up a key of its own.
    const r = run(["--yes"], {}, { giveModelKey: false });
    expect(r.code).toBe(64);
    expect(readdirSync(secretsDir)).not.toContain("model-provider-key");
  });
});
