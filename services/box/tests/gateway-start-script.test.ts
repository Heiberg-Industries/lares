import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const SCRIPT = join(REPO, "images/gateway-runtime/start.sh");
const ADMISSION_HELPER = join(REPO, "images/gateway-runtime/gateway_admission.py");

let dir: string, binDir: string, log: string, providerKeyFile: string, masterKeyFile: string, databasePasswordFile: string;
const ADMISSION_DIR = "/run/lares-maintenance/admission";
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const EPOCH = "7";
let admissionParentCreated = false;

function rootCommand(args: string[]) {
  return process.getuid?.() === 0
    ? execFileSync(args[0], args.slice(1), { encoding: "utf8", stdio: "pipe" })
    : execFileSync("sudo", ["-n", ...args], { encoding: "utf8", stdio: "pipe" });
}

function prepareAdmissionFixture() {
  const fixture = `import os, pathlib, stat\np=pathlib.Path(${JSON.stringify(ADMISSION_DIR)})\nparent=p.parent\nif p.exists() or p.is_symlink(): raise SystemExit(9)\ncreated=not parent.exists()\nif created: parent.mkdir(mode=0o755)\ninfo=parent.lstat()\nif not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o755: raise SystemExit(10)\np.mkdir(mode=0o755)\n(p/'service-gate.lock').write_bytes(b'')\n(p/'service-gate.lock').chmod(0o444)\n(p/'intent.json').write_bytes(b'{"epoch":${EPOCH},"installationId":"${INSTALLATION_ID}","state":"normal","version":1}\\n')\n(p/'intent.json').chmod(0o444)\nprint('created' if created else 'existing')\n`;
  try {
    admissionParentCreated = rootCommand(["python3", "-I", "-c", fixture]).trim() === "created";
    return true;
  } catch {
    return false;
  }
}

const admissionFixtureReady = prepareAdmissionFixture();
if (!admissionFixtureReady && process.env.CI) {
  throw new Error("Required Gateway admission fixture could not be prepared in CI");
}

afterAll(() => {
  if (!admissionFixtureReady) return;
  const cleanup = `import pathlib, shutil\np=pathlib.Path(${JSON.stringify(ADMISSION_DIR)})\nif p.is_dir() and not p.is_symlink():\n  expected={'intent.json','service-gate.lock'}\n  if {x.name for x in p.iterdir()}==expected: shutil.rmtree(p)\n  else: raise SystemExit(11)\n${admissionParentCreated ? `parent=p.parent\ntry: parent.rmdir()\nexcept OSError: pass\n` : ""}`;
  try { rootCommand(["python3", "-I", "-c", cleanup]); } catch { /* Preserve the test result; only remove the fixture we created. */ }
});

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
  writeFileSync(log, "");
  // Stand in for `litellm --config …`: a fake `litellm` on PATH prints its env and args,
  // following start-script.test.ts's own eve-stub convention (mirrored by
  // console-start-script.test.ts's fake `node`).
  const litellm = join(binDir, "litellm");
  writeFileSync(
    litellm,
    `#!/bin/sh\nprintf 'LARES_MODEL_PROVIDER_KEY=%s\\n' "$LARES_MODEL_PROVIDER_KEY" >> "${log}"\nprintf 'LARES_GATEWAY_MASTER_KEY=%s\\n' "$LARES_GATEWAY_MASTER_KEY" >> "${log}"\nprintf 'args=%s\\n' "$*" >> "${log}"\n`,
  );
  chmodSync(litellm, 0o755);
  const python = join(binDir, "python");
  writeFileSync(python, `#!/bin/sh
if [ "$1" = "-I" ] && [ "$2" = "/opt/lares-gateway/gateway_admission.py" ] && [ "$3" = "verify" ]; then
  exec python3 -I "${ADMISSION_HELPER}" verify
fi
printf 'python=%s\\n' "$*" >> "${log}"
`);
  chmodSync(python, 0o755);
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
        LARES_GATEWAY_ADMISSION_URL: "https://admission.example.invalid",
        LARES_GATEWAY_SERVICE_KEY_FILE: "/run/secrets/admission-service-key",
        LARES_GATEWAY_ENDPOINT_HASH: "0".repeat(64),
        LARES_GATEWAY_PROFILE_FILE: "/etc/litellm/profile.json",
        ...env,
      },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

function runAdmitted(env: Record<string, string>) {
  const runner = join(dir, "admitted-start.py");
  writeFileSync(runner, `import fcntl,os,sys\nfd=os.open(${JSON.stringify(`${ADMISSION_DIR}/service-gate.lock`)},os.O_RDONLY)\nfcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)\nif fd!=9: os.dup2(fd,9,inheritable=True)\nelse: os.set_inheritable(9,True)\nos.execv('/bin/sh',['/bin/sh',sys.argv[1]])\n`);
  const childEnv = {
    PATH: `${binDir}:${process.env.PATH}`,
    DATABASE_PASSWORD_FILE: databasePasswordFile,
    PGHOST: "db", PGPORT: "5432", PGDATABASE: "litellm", PGUSER: "lares",
    LARES_GATEWAY_ADMISSION_URL: "https://admission.example.invalid",
    LARES_GATEWAY_SERVICE_KEY_FILE: "/run/secrets/admission-service-key",
    LARES_GATEWAY_ENDPOINT_HASH: "0".repeat(64),
    LARES_GATEWAY_PROFILE_FILE: "/etc/litellm/profile.json",
    LARES_MAINTENANCE_ADMISSION_DIR: ADMISSION_DIR,
    LARES_MAINTENANCE_INSTALLATION_ID: INSTALLATION_ID,
    LARES_MAINTENANCE_EPOCH: EPOCH,
    ...env,
  };
  const envArgs = Object.entries(childEnv).map(([key, value]) => `${key}=${value}`);
  try {
    const stdout = rootCommand(["/usr/bin/env", ...envArgs, "python3", "-I", runner, SCRIPT]);
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

describe("the gateway runtime's start script", () => {
  it("runs the committed guard first and refuses a direct start without a real held descriptor", () => {
    const r = run({
      MODEL_PROVIDER_KEY_FILE: providerKeyFile,
      GATEWAY_MASTER_KEY_FILE: masterKeyFile,
      LARES_MAINTENANCE_ADMISSION_DIR: "/run/lares-maintenance/admission",
      LARES_MAINTENANCE_INSTALLATION_ID: "11111111-1111-4111-8111-111111111111",
      LARES_MAINTENANCE_EPOCH: "7",
    });
    expect(r.code).toBe(78);
    expect(r.stderr).toContain("lares: gateway maintenance admission refused");
    expect(readFileSync(log, "utf8")).toBe("");
    const script = readFileSync(SCRIPT, "utf8");
    expect(script.indexOf("gateway_admission.py verify")).toBeLessThan(script.indexOf('MODEL_PROVIDER_KEY_FILE:?'));
    expect(script.indexOf("gateway_admission.py verify")).toBeLessThan(script.indexOf("cat \"$MODEL_PROVIDER_KEY_FILE\""));
    expect(script.indexOf("gateway_admission.py verify")).toBeLessThan(script.indexOf("--check"));
    expect(script.indexOf("--check")).toBeLessThan(script.indexOf("--enforce_prisma_migration_check"));
    expect(script).toContain("exec python /opt/lares-gateway/lares_gateway.py");
  });

  it("does not expose secret values on an admission refusal", () => {
    const r = run({ MODEL_PROVIDER_KEY_FILE: providerKeyFile, GATEWAY_MASTER_KEY_FILE: masterKeyFile });
    expect(r.stdout).not.toContain("sk-fixture-provider-only");
    expect(r.stdout).not.toContain("sk-fixture-master-only");
    expect(r.stderr).not.toContain("sk-fixture-provider-only");
    expect(r.stderr).not.toContain("sk-fixture-master-only");
    expect(r.stdout).not.toContain("fixture_database-password_123");
    expect(r.stderr).not.toContain("fixture_database-password_123");
  });

  it.skipIf(!admissionFixtureReady)("exports both secret files and runs preflight, migration, and LiteLLM in order after real admission", () => {
    const r = runAdmitted({ MODEL_PROVIDER_KEY_FILE: providerKeyFile, GATEWAY_MASTER_KEY_FILE: masterKeyFile });
    expect(r.code).toBe(0);
    const contents = readFileSync(log, "utf8");
    expect(contents).toContain("LARES_MODEL_PROVIDER_KEY=sk-fixture-provider-only");
    expect(contents).toContain("LARES_GATEWAY_MASTER_KEY=sk-fixture-master-only");
    expect(contents).toContain("args=--config /etc/litellm/config.yaml --skip_server_startup --enforce_prisma_migration_check");
    expect(contents.indexOf("python=/opt/lares-gateway/lares_gateway.py --check")).toBeLessThan(contents.indexOf("args=--config"));
    expect(contents.lastIndexOf("python=/opt/lares-gateway/lares_gateway.py")).toBeGreaterThan(contents.indexOf("args=--config"));
    expect(r.stdout).not.toContain("sk-fixture-provider-only");
    expect(r.stdout).not.toContain("sk-fixture-master-only");
    expect(r.stderr).not.toContain("sk-fixture-provider-only");
    expect(r.stderr).not.toContain("sk-fixture-master-only");
    expect(r.stdout).not.toContain("fixture_database-password_123");
    expect(r.stderr).not.toContain("fixture_database-password_123");
  });

  it.skipIf(!admissionFixtureReady)("constructs DATABASE_URL from the password file without printing the password", () => {
    writeFileSync(join(binDir, "litellm"), `#!/bin/sh\nprintf 'DATABASE_URL=%s\\n' "$DATABASE_URL" >> "${log}"\n`);
    chmodSync(join(binDir, "litellm"), 0o755);
    const r = runAdmitted({ MODEL_PROVIDER_KEY_FILE: providerKeyFile, GATEWAY_MASTER_KEY_FILE: masterKeyFile });
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("DATABASE_URL=postgresql://lares:fixture_database-password_123@db:5432/litellm");
    expect(r.stdout).not.toContain("fixture_database-password_123");
    expect(r.stderr).not.toContain("fixture_database-password_123");
  });

  it.skipIf(!admissionFixtureReady)("refuses each unreadable credential before starting preflight or LiteLLM", () => {
    for (const [variable, value, message] of [
      ["MODEL_PROVIDER_KEY_FILE", join(dir, "missing-provider"), "MODEL_PROVIDER_KEY_FILE"],
      ["GATEWAY_MASTER_KEY_FILE", join(dir, "missing-master"), "GATEWAY_MASTER_KEY_FILE"],
      ["DATABASE_PASSWORD_FILE", join(dir, "missing-password"), "DATABASE_PASSWORD_FILE"],
    ] as const) {
      writeFileSync(log, "");
      const r = runAdmitted({ MODEL_PROVIDER_KEY_FILE: providerKeyFile, GATEWAY_MASTER_KEY_FILE: masterKeyFile,
        [variable]: value });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(message);
      expect(readFileSync(log, "utf8")).toBe("");
    }
  });

  it.skipIf(!admissionFixtureReady)("checks later authority requirements after real admission", () => {
    const r = runAdmitted({ MODEL_PROVIDER_KEY_FILE: providerKeyFile, GATEWAY_MASTER_KEY_FILE: masterKeyFile,
      LARES_GATEWAY_ADMISSION_URL: "" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("LARES_GATEWAY_ADMISSION_URL");
    expect(r.stderr).not.toContain("lares: gateway maintenance admission refused");
    expect(readFileSync(log, "utf8")).toBe("");
  });

  it("is POSIX sh", () => {
    expect(() => execFileSync("/bin/sh", ["-n", SCRIPT])).not.toThrow();
  });

  it("checks admission before the later authority requirement", () => {
    const r = run({MODEL_PROVIDER_KEY_FILE: providerKeyFile, GATEWAY_MASTER_KEY_FILE: masterKeyFile, LARES_GATEWAY_ADMISSION_URL: ""});
    expect(r.code).toBe(78);
    expect(r.stderr).toContain("lares: gateway maintenance admission refused");
    expect(r.stderr).not.toContain("LARES_GATEWAY_ADMISSION_URL");
    expect(readFileSync(log, "utf8")).toBe("");
  });
});
