import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const SCRIPT = join(REPO, "images/console-runtime/start.sh");

let dir: string, binDir: string, log: string, secretFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "console-start-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  secretFile = join(dir, "console-session-secret");
  writeFileSync(secretFile, "disposable-fixture-only\n");
  log = join(dir, "server.log");
  // Stand in for `node services/console/server.js`: this repo already has no `node` stub
  // pattern for this, so a fake `node` on PATH prints its env and args, following
  // start-script.test.ts's own eve-stub convention.
  const node = join(binDir, "node");
  writeFileSync(node, `#!/bin/sh\nprintf 'CONSOLE_SESSION_SECRET=%s\\n' "$CONSOLE_SESSION_SECRET" >> "${log}"\nprintf 'args=%s\\n' "$*" >> "${log}"\n`);
  chmodSync(node, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(env: Record<string, string>) {
  try {
    const stdout = execFileSync("/bin/sh", [SCRIPT], { cwd: dir, encoding: "utf8", env: { PATH: `${binDir}:${process.env.PATH}`, ...env } });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("the console runtime's start script", () => {
  it("exports the session secret's file contents as CONSOLE_SESSION_SECRET before exec'ing the server", () => {
    const r = run({ CONSOLE_SESSION_SECRET_FILE: secretFile });
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("CONSOLE_SESSION_SECRET=disposable-fixture-only");
  });

  it("trims a trailing newline, and never echoes the value itself to stdout or stderr", () => {
    const r = run({ CONSOLE_SESSION_SECRET_FILE: secretFile });
    expect(r.stdout).not.toContain("disposable-fixture-only");
    expect(r.stderr).not.toContain("disposable-fixture-only");
  });

  it("refuses with a plain sentence when the file is unreadable, and starts nothing", () => {
    const r = run({ CONSOLE_SESSION_SECRET_FILE: join(dir, "missing") });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/CONSOLE_SESSION_SECRET_FILE/);
  });

  it("is POSIX sh", () => {
    expect(() => execFileSync("/bin/sh", ["-n", SCRIPT])).not.toThrow();
  });
});
