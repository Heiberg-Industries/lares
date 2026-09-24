// W8C-s9 — the installer ends honestly at the console's first-agent setup page.
//
// Nothing here touches a real machine or network. Every host command is a logging stub, every
// write lands below a temporary --prefix, and curl stands in only for the public console readiness
// check. This slice deliberately does not probe an agent: a fresh install has configured the
// keeper's first binding, but no agent definition/runtime or registered gateway key exists yet.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "install.sh");

let dir: string, binDir: string, prefix: string, log: string, releaseFile: string;

const RELEASE = JSON.stringify({
  release: "2026-10-01",
  images: { db: `example.invalid/lares-db@sha256:${"a".repeat(64)}` },
  migrations: { box: "087_update_history.sql" },
  breaking: [],
});

const RENDER_STACK = `case "$3" in render-stack) printf 'services:\\n  db: {}\\n' > "$5"; exit 0 ;; render-keeper-config) printf '{}\\n' > "$5"; printf 'LARES_KEEPER_IMAGE=placeholder\\n' > "$6"; exit 0 ;; esac`;

function stub(name: string, body = "exit 0") {
  const path = join(binDir, name);
  const prelude = name === "pnpm" && !body.includes("render-stack") ? `${RENDER_STACK}\n` : "";
  writeFileSync(path, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_LOG"\n${prelude}${body}\n`);
  chmodSync(path, 0o755);
}

function runWithStdin(args: string[], input: string) {
  try {
    const stdout = execFileSync(
      "/bin/bash",
      [SCRIPT, "--yes", "--release", releaseFile, ...args],
      {
        input,
        encoding: "utf8",
        env: {
          PATH: `${binDir}:/usr/bin:/bin`,
          STUB_LOG: log,
          LARES_PREFIX: prefix,
          HOME: dir,
        },
      },
    );
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { code: failure.status, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const answers = [
  "lares.example.invalid",
  "owner@example.invalid",
  "A Name",
  "sk-disposable-fixture-only",
].join("\n") + "\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-install-finish-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  prefix = join(dir, "root"); mkdirSync(prefix);
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  releaseFile = join(dir, "release.json"); writeFileSync(releaseFile, RELEASE);

  for (const name of [
    "docker", "systemctl", "useradd", "groupadd", "chown", "chmod", "ufw", "curl",
    "pnpm", "openssl", "lares-doctor", "sleep",
  ]) stub(name);
  stub("id", "echo 0");
  stub("uname", "echo Linux");
  stub("free", 'echo "Mem: 8192 1024 7168"');
  stub("df", 'echo "/dev/x 100000000 1000000 99000000 1% /"');
  stub("ss", "exit 1");
  stub("lsb_release", "echo 24.04");
  stub("getent", 'if [ "$1" = "hosts" ]; then echo "203.0.113.10 $2"; fi');
  stub("hostname", 'if [ "$1" = "-I" ]; then echo "203.0.113.10"; fi');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("how the install ends", () => {
  it("waits until the console really answers, then prints one address", () => {
    stub("curl", 'printf "%s %s\\n" "curl" "$*" >> "$STUB_LOG"; exit 0');
    const result = runWithStdin([], answers);
    expect(result.code, result.stderr).toBe(0);
    const printed = result.stdout.trim().split("\n").filter((line) => line.includes("https://"));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("https://lares.example.invalid/agents/new");
    expect(readFileSync(log, "utf8")).toMatch(/curl .*\/api\/auth\/login/);
  }, 20_000);

  it("says what to do when it never comes up, instead of printing an address that does not work", () => {
    stub("curl", "exit 7");
    const result = runWithStdin([], answers);
    expect(result.code, result.stderr).toBe(75);
    expect(result.stderr).toMatch(/did not come up/i);
    expect(result.stderr).toMatch(/docker compose logs/);
    expect(result.stdout).not.toContain("https://lares.example.invalid/agents/new");
  }, 20_000);

  it("says honestly what remains, and does not ask about it now", () => {
    stub("curl", "exit 0");
    const result = runWithStdin([], answers);
    expect(result.stdout).toMatch(/create.*first agent/i);
    expect(result.stdout).toMatch(/no agent.*running|conversation.*not.*ready/i);
    expect(result.stdout).toMatch(/backup/i);
    expect(result.stdout).toMatch(/Slack|Telegram/);
    expect(result.stdout).not.toMatch(/say hello/i);
    const ending = result.stdout.trim().split("\n").slice(-5).join("\n");
    expect(ending).not.toMatch(/\?\s*$/m);
  });

  it("prints nothing that could be a credential", () => {
    stub("curl", "exit 0");
    const result = runWithStdin([], answers);
    expect(result.stdout).not.toMatch(/sk-|xoxb-|[0-9a-f]{64}/);
  });

  it("does not tell an existing installation to create its first agent or set up its first backup", () => {
    mkdirSync(join(prefix, "srv", "lares"), { recursive: true });
    stub("curl", "exit 0");
    const result = runWithStdin([], answers);
    const printed = result.stdout.trim().split("\n").filter((line) => line.includes("https://"));
    expect(result.code).toBe(0);
    expect(printed).toEqual(["install: https://lares.example.invalid/"]);
    expect(result.stdout).toMatch(/repair run is finished/i);
    expect(result.stdout).not.toMatch(/create your first agent|Nothing is backed up yet/i);
  });
});
