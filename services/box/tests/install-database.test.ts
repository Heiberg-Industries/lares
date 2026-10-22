// The database is created and migrated, or the install stops. The hard part (the
// runner and its exit codes) exists and is proven (services/box/migrate.ts); this proves only
// install.sh's own wiring onto it: bring the database container up, create the database once,
// then hand off to `pnpm -C services/box migrate` and stop on anything but 0 or a dry-run's 2.
//
// NOTHING HERE TOUCHES A REAL MACHINE OR A REAL DATABASE. Every run installs into a temp
// `--prefix`, `docker` and `pnpm` are logging stubs on PATH ahead of everything else, and
// `lares-doctor` (the model-key proof, which every completed wizard run reaches first) is
// stubbed green so this file is about the database step alone. Following
// install-model-test.test.ts's harness shape: every call here bakes in `--yes`, since this file
// is not about screen one's fresh-or-restore prompt.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_IMAGE, engineDockerPrelude } from "./helpers/engine-docker.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "install.sh");

let dir: string, binDir: string, prefix: string, log: string, composeFile: string, releaseFile: string;

/** A release with one digest-named image — enough to get past the release rules; the renderer
 *  itself is stubbed here (see RENDER_STACK). */
const RELEASE = JSON.stringify({
  release: "2026-10-01",
  images: {
    db: `example.invalid/lares-db@sha256:${"a".repeat(64)}`,
    creative: `example.invalid/lares-creative@sha256:${"b".repeat(64)}`,
    console: `example.invalid/lares-console@sha256:${"c".repeat(64)}`,
    "lares-gateway": `example.invalid/lares-gateway@sha256:${"d".repeat(64)}`,
    caddy: `example.invalid/caddy@sha256:${"e".repeat(64)}`,
    "lares-keeper": `example.invalid/lares-keeper@sha256:${"f".repeat(64)}`,
    "lares-egress-proxy": `example.invalid/lares-egress-proxy@sha256:${"1".repeat(64)}`,
    "lares-firewall-helper": `example.invalid/lares-firewall-helper@sha256:${"2".repeat(64)}`,
    "chief-of-staff": `example.invalid/chief-of-staff@sha256:${"3".repeat(64)}`,
  },
  migrations: { box: "001_baseline.sql" },
  breaking: [],
});

/** run_stack renders the stack file through
 *  `pnpm -C <box> render-stack <release> <out> …` one step before this file's subject, and
 *  refuses if nothing lands at <out>. Every `pnpm` stub here therefore answers that one call
 *  with a placeholder stack file — a test whose own body mentions render-stack is taking the
 *  call over and gets no prelude. The same prelude answers run_keeper's
 *  `render-keeper-config` call at the end, for the same reason.
 *  tests/install-stack.test.ts is where the real renderer runs. */
const RENDER_STACK = `case "$3" in render-stack) printf 'services:\\n  db: {}\\n' > "$5"; exit 0 ;; render-database-bootstrap) printf 'services:\\n  db: {}\\n' > "$5"; exit 0 ;; render-keeper-config) printf '{}\\n' > "$5"; printf 'LARES_KEEPER_IMAGE=placeholder\\n' > "$6"; exit 0 ;; esac`;

/** A stub that logs its own name and argv, and exits 0 unless `body` says otherwise. */
function stub(name: string, body = "exit 0") {
  const p = join(binDir, name);
  const prelude = name === "pnpm" && !body.includes("render-stack") ? `${RENDER_STACK}\n` : "";
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_LOG"\n${name === "docker" ? engineDockerPrelude() : ""}${prelude}${body}\n`);
  chmodSync(p, 0o755);
}

/** Same shape as install-model-test.test.ts's runWithStdin: every call bakes in `--yes` — this
 *  file is about the database step alone, never screen one's own fresh-or-restore prompt. */
/** An installer run must have succeeded; the failure message carries the installer's own stderr. */
function okRun<T extends { code: number | null; stderr: string }>(r: T): T {
  expect(r.code, `install.sh exited ${r.code}; stderr:\n${r.stderr}`).toBe(0);
  return r;
}

function runWithStdin(args: string[], input: string, env: Record<string, string> = {}) {
  try {
    // `--release` is load-bearing: a fresh install given none refuses with
    // EX_USAGE before it writes anything. tests/install-stack.test.ts owns the flag itself.
    const stdout = execFileSync("/bin/bash", [SCRIPT, "--yes", "--release", releaseFile, ...args], {
      input,
      encoding: "utf8",
      env: { LARES_ENGINE_IMAGE: ENGINE_IMAGE, PATH: `${binDir}:/usr/bin:/bin`, STUB_LOG: log, LARES_PREFIX: prefix, HOME: dir, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const answers = ["lares.example.invalid", "owner@example.invalid", "A Name", "sk-disposable-fixture-only"].join("\n") + "\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-install-database-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  prefix = join(dir, "root"); mkdirSync(prefix);
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  for (const name of ["systemctl", "useradd", "groupadd", "chown", "chmod", "ufw", "curl", "node", "openssl"]) stub(name);
  stub("stat", 'case "$*" in *database-password*) echo 0:600 ;; *) echo 0:700 ;; esac');
  // `docker` also logs whatever was piped to its stdin, but ONLY for the one invocation that
  // ever receives anything there (`exec ... psql`, matched by argv containing "psql"): every
  // other docker call here (compose version, up -d db, pg_isready) inherits the SAME stdin this
  // whole script's four questions are still going to read from, and must never drain it. CREATE
  // DATABASE travels to psql on stdin, never as an argument — that is where a password would
  // leak — so a test can only see it this way, exactly the shape ops/backup-verify.sh uses.
  stub("docker", 'case "$*" in *"ps -q db"*) case "$*" in *compose.bootstrap*) echo bootstrap-container ;; *) echo normal-container ;; esac ;; *"inspect -f"*) exit 0 ;; *"inspect bootstrap-container"*) exit 1 ;; *psql*) cat >> "$STUB_LOG" 2>/dev/null ;; esac; exit 0');
  stub("pnpm");
  // `lares-doctor`: every completed wizard run proves the model key through it, so a
  // run that is not about that proof stubs it silently green.
  stub("lares-doctor");
  stub("id", "echo 0");                                   // running as root
  stub("uname", "echo Linux");
  stub("free", 'echo "Mem: 8192 1024 7168"');
  stub("df", 'echo "/dev/x 100000000 1000000 99000000 1% /"');
  stub("ss", "exit 1");                                   // nothing listening on 80/443
  stub("lsb_release", "echo 24.04");
  // DNS: getent and hostname agree, so the fixture domain resolves here —
  // this file is not about DNS, so it is fixed to "always fine" and never varied.
  stub("getent", 'if [ "$1" = "hosts" ]; then echo "203.0.113.10 $2"; fi');
  stub("hostname", 'if [ "$1" = "-I" ]; then echo "203.0.113.10"; fi');
  // The stack file is no longer placed here by hand. run_stack renders it from the
  // release this run is given, one step before the database step this file is about; the one
  // test below that is about its absence takes the render call over instead.
  releaseFile = join(dir, "release.json"); writeFileSync(releaseFile, RELEASE);
  composeFile = join(prefix, "opt", "lares", "compose.yaml");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the database the installer creates", () => {
  it("prepares roles and workflow template offline before starting online services", () => {
    stub("pnpm", 'printf "%s %s\\n" "pnpm" "$*" >> "$STUB_LOG"; exit 0');
    okRun(runWithStdin([], answers));
    const calls = readFileSync(log, "utf8");
    expect(calls).toMatch(/docker .*compose .*compose\.bootstrap\.yaml up -d db/);
    expect(calls).toContain("bin/database-setup.ts");
    expect(calls).toContain("bin/workflow-template.ts apply");
    expect(calls).toContain("setupDatabase()");
    expect(calls).not.toContain("001-eve-workflow.sql");
    expect(calls).not.toContain("CREATE SCHEMA IF NOT EXISTS workflow;");
    const bootstrapDown = calls.indexOf("compose.bootstrap.yaml down");
    const normalDatabase = calls.indexOf("compose.yaml up -d db");
    expect(bootstrapDown, "the operator-secret bootstrap container was not removed").toBeGreaterThan(-1);
    expect(normalDatabase, "the normal database did not start after bootstrap removal").toBeGreaterThan(bootstrapDown);
    expect(calls).toMatch(/pnpm -C .*database-setup/);
    expect(calls).toMatch(/pnpm -C .*migrate --schema-owner/);
    expect(calls).toContain("PGUSER=lares_operator");
    expect(calls).toMatch(/docker compose -f .*compose\.yaml up -d console lares-gateway caddy/);
    expect(calls).toMatch(/pnpm -C .*services\/box installation-settings/);
    expect(calls.indexOf("bin/database-setup.ts")).toBeLessThan(calls.indexOf("migrate.ts --schema-owner"));
    expect(calls.indexOf("migrate.ts --schema-owner")).toBeLessThan(calls.indexOf("installation-settings"));
    expect(calls.indexOf("installation-settings")).toBeLessThan(calls.indexOf("first-owner"));
    expect(calls.indexOf("first-owner")).toBeLessThan(calls.indexOf("first-organisation"));
    expect(calls.indexOf("first-organisation")).toBeLessThan(calls.indexOf("render-keeper-config"));
  });

  it("stops when the runner refuses, repeats its sentence, and applies nothing else", () => {
    stub("pnpm", 'case "$*" in *"migrate --schema-owner"*) echo "migrations: 052 is out of order" >&2; exit 1 ;; esac; exit 0');
    const r = runWithStdin([], answers);
    expect(r.code).toBe(78);
    expect(r.stderr).toContain("out of order");
    expect(r.stdout).not.toMatch(/web chat/i);
  });

  it("treats a dry run's exit 2 as work to do, not as a failure", () => {
    stub("pnpm", 'if printf "%s" "$*" | grep -q -- --dry-run; then exit 2; fi; exit 0');
    okRun(runWithStdin(["--dry-run"], answers));
  });

  it("never passes the database password as an argument", () => {
    stub("pnpm", "exit 0");
    okRun(runWithStdin([], answers));
    const password = readFileSync(join(prefix, "etc/lares/secrets/database-password"), "utf8").trim();
    expect(readFileSync(log, "utf8")).not.toContain(password);
  });

  it("stops before owner and keeper setup when the first-agent settings are refused", () => {
    stub(
      "pnpm",
      'case "$3" in installation-settings) echo "settings are invalid" >&2; exit 1 ;; esac\nexit 0',
    );
    const r = runWithStdin([], answers);
    expect(r.code).toBe(78);
    expect(r.stderr).toContain("settings are invalid");
    expect(r.stderr).toMatch(/first-agent settings/i);
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toMatch(/first-owner/);
    expect(calls).not.toMatch(/render-keeper-config/);
  });

  it("does not start the keeper when organisation enrolment refuses", () => {
    stub("pnpm", 'case "$3" in first-organisation) echo "membership conflict" >&2; exit 1 ;; esac\nexit 0');
    const r = runWithStdin([], answers);
    expect(r.code).toBe(78);
    expect(r.stderr).toContain("membership conflict");
    const calls = readFileSync(log, "utf8");
    expect(calls).toMatch(/first-owner/);
    expect(calls).toMatch(/first-organisation/);
    expect(calls).not.toMatch(/render-keeper-config/);
  });

  it("is safe to run twice: the second run applies nothing and says so", () => {
    stub("pnpm", "exit 0");
    okRun(runWithStdin([], answers));
    writeFileSync(log, "");
    const second = runWithStdin([], "");
    expect(second.code, second.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).not.toMatch(/CREATE DATABASE/);
  });

  // --- A refusal that names
  // the path when there is no stack file to create a database against.
  //
  // This used to delete a hand-placed fixture, because nothing in the
  // installer wrote one. run_stack now does, one step earlier — so the way this installation
  // ends up with no stack file is that the render did not produce one, and that is where the
  // refusal now happens. Both refusals still exist (run_database keeps its own guard, for a
  // file moved between two runs); this asserts the one a real install can actually reach.
  it("refuses, naming the path, when no stack file was written", () => {
    stub("pnpm", 'case "$3" in render-stack) exit 0 ;; esac\nexit 0');  // renders nothing
    const r = runWithStdin([], answers);
    expect(r.code).toBe(78);
    expect(r.stderr).toContain(composeFile);
    expect(r.stderr).toMatch(/stack file/i);
    expect(readFileSync(log, "utf8")).not.toMatch(/pnpm -C .*migrate/);
  });
});
