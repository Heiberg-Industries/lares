import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const SCRIPT = join(REPO, "images/gateway-runtime/start.sh");

let dir: string, binDir: string, log: string, providerKeyFile: string, masterKeyFile: string, databasePasswordFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gateway-start-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  providerKeyFile = join(dir, "model-provider-key");
  writeFileSync(providerKeyFile, "sk-fixture-provider-only\n");
  masterKeyFile = join(dir, "gateway-master-key");
  writeFileSync(masterKeyFile, "sk-fixture-master-only\n");
  databasePasswordFile = join(dir, "database-password");
  writeFileSync(databasePasswordFile, "fixture_database-password_123\n");
  log = join(dir, "litellm.log");
  // Stand in for `litellm --config …`: a fake `litellm` on PATH prints its env and args,
  // following start-script.test.ts's own eve-stub convention (mirrored by
  // console-start-script.test.ts's fake `node`).
  const litellm = join(binDir, "litellm");
  writeFileSync(
    litellm,
    `#!/bin/sh\nprintf 'LARES_MODEL_PROVIDER_KEY=%s\\n' "$LARES_MODEL_PROVIDER_KEY" >> "${log}"\nprintf 'LARES_GATEWAY_MASTER_KEY=%s\\n' "$LARES_GATEWAY_MASTER_KEY" >> "${log}"\nprintf 'args=%s\\n' "$*" >> "${log}"\n`,
  );
  chmodSync(litellm, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(env: Record<string, string>) {
  try {
    const stdout = execFileSync("/bin/sh", [SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        DATABASE_PASSWORD_FILE: databasePasswordFile,
        PGHOST: "db",
        PGPORT: "5432",
        PGDATABASE: "litellm",
        PGUSER: "lares",
        ...env,
      },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("the gateway runtime's start script", () => {
  it("exports both secret files' contents as env vars before exec'ing litellm with the config flag", () => {
    const r = run({ MODEL_PROVIDER_KEY_FILE: providerKeyFile, GATEWAY_MASTER_KEY_FILE: masterKeyFile });
    expect(r.code).toBe(0);
    const contents = readFileSync(log, "utf8");
    expect(contents).toContain("LARES_MODEL_PROVIDER_KEY=sk-fixture-provider-only");
    expect(contents).toContain("LARES_GATEWAY_MASTER_KEY=sk-fixture-master-only");
    expect(contents).toContain("args=--config /etc/litellm/config.yaml");
  });

  it("constructs LiteLLM's database URL from a password file, never Compose or argv", () => {
    // Add the value to the child-only fixture log: the production script itself prints nothing.
    const litellm = join(binDir, "litellm");
    writeFileSync(litellm, `#!/bin/sh\nprintf 'DATABASE_URL=%s\\n' "$DATABASE_URL" >> "${log}"\n`);
    chmodSync(litellm, 0o755);
    const r = run({ MODEL_PROVIDER_KEY_FILE: providerKeyFile, GATEWAY_MASTER_KEY_FILE: masterKeyFile });
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain(
      "DATABASE_URL=postgresql://lares:fixture_database-password_123@db:5432/litellm",
    );
    expect(r.stdout).not.toContain("fixture_database-password_123");
    expect(r.stderr).not.toContain("fixture_database-password_123");
  });

  it("never echoes any secret's value to stdout or stderr", () => {
    const r = run({ MODEL_PROVIDER_KEY_FILE: providerKeyFile, GATEWAY_MASTER_KEY_FILE: masterKeyFile });
    expect(r.stdout).not.toContain("sk-fixture-provider-only");
    expect(r.stdout).not.toContain("sk-fixture-master-only");
    expect(r.stderr).not.toContain("sk-fixture-provider-only");
    expect(r.stderr).not.toContain("sk-fixture-master-only");
    expect(r.stdout).not.toContain("fixture_database-password_123");
    expect(r.stderr).not.toContain("fixture_database-password_123");
  });

  it("refuses with a plain sentence when the model-provider-key file is unreadable, and starts nothing", () => {
    const r = run({ MODEL_PROVIDER_KEY_FILE: join(dir, "missing"), GATEWAY_MASTER_KEY_FILE: masterKeyFile });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/MODEL_PROVIDER_KEY_FILE/);
  });

  it("refuses with a plain sentence when the gateway-master-key file is unreadable, and starts nothing", () => {
    const r = run({ MODEL_PROVIDER_KEY_FILE: providerKeyFile, GATEWAY_MASTER_KEY_FILE: join(dir, "missing") });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/GATEWAY_MASTER_KEY_FILE/);
  });

  it("refuses with a plain sentence when the database-password file is unreadable, and starts nothing", () => {
    const r = run({
      MODEL_PROVIDER_KEY_FILE: providerKeyFile,
      GATEWAY_MASTER_KEY_FILE: masterKeyFile,
      DATABASE_PASSWORD_FILE: join(dir, "missing"),
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/DATABASE_PASSWORD_FILE/);
  });

  it("is POSIX sh", () => {
    expect(() => execFileSync("/bin/sh", ["-n", SCRIPT])).not.toThrow();
  });
});
