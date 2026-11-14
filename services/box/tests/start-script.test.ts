import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const SCRIPT = join(REPO, "images/agent-runtime/start.sh");
const FRAGMENT = join(REPO, "images/agent-runtime/required-settings.sh");

let dir: string, binDir: string, serverLog: string, eveMarker: string, secrets: string;

const FULL = () => ({
  DATABASE_URL: "postgres://proof@db/proof",
  WORKFLOW_POSTGRES_URL: "postgres://proof@db/proof",
  DATABASE_PASSWORD_FILE: join(secrets, "database-password"),
  WORKFLOW_POSTGRES_PASSWORD_FILE: join(secrets, "workflow-password"),
  GATEWAY_URL: "http://gateway:4000",
  GATEWAY_KEY_FILE: join(secrets, "gateway-key"),
  LARES_AGENT_NAME: "helper",
  LARES_DEFINITION_DIR: join(dir, "definition"),
});

function run(env: Record<string, string>) {
  try {
    const stdout = execFileSync("/bin/sh", [SCRIPT], {
      cwd: dir, encoding: "utf8",
      env: { PATH: `${binDir}:${process.env.PATH}`, LARES_REQUIRED_SETTINGS: FRAGMENT, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-start-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  secrets = join(dir, "secrets"); mkdirSync(secrets);
  mkdirSync(join(dir, "definition"));
  writeFileSync(join(secrets, "database-password"), "app-fixture-password\n");
  writeFileSync(join(secrets, "workflow-password"), "workflow-fixture-password\n");
  writeFileSync(join(secrets, "gateway-key"), "gateway-fixture-key\n");
  // The script runs the built server itself, `exec node ./.output/server/index.mjs`, with no eve
  // launcher in between. This stub stands where the built server would and records what it was
  // started with; the stub `eve` only leaves a marker, so a start through the launcher is caught.
  serverLog = join(dir, "server.log");
  mkdirSync(join(dir, ".output", "server"), { recursive: true });
  writeFileSync(join(dir, ".output", "server", "index.mjs"), `import { appendFileSync } from "node:fs";
const e = process.env;
appendFileSync(${JSON.stringify(serverLog)}, [
  "PGPASSWORD=" + e.PGPASSWORD,
  "WORKFLOW_POSTGRES_URL=" + e.WORKFLOW_POSTGRES_URL,
  "LISTEN=" + [e.HOST, e.NITRO_HOST, e.PORT, e.NITRO_PORT].join(","),
  "STRIPPED=" + ["CI", "TEST", "SERVER_SHUTDOWN_TIMEOUT", "NITRO_UNIX_SOCKET"].filter((name) => name in e).join(","),
  "ARGS=" + process.argv.slice(2).join(","),
  "",
].join("\\n"));
`);
  eveMarker = join(dir, "eve-ran");
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  const eve = join(dir, "node_modules", ".bin", "eve");
  writeFileSync(eve, `#!/bin/sh\nprintf ran > "${eveMarker}"\n`);
  chmodSync(eve, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the runtime image's start script", () => {
  it("starts the built server directly when every required setting is there", () => {
    // A caller's environment may carry these in; the server must not see the first four, and
    // must listen where the image says, not where the caller's HOST or PORT point.
    const r = run({ ...FULL(), CI: "true", TEST: "1", SERVER_SHUTDOWN_TIMEOUT: "1", NITRO_UNIX_SOCKET: "/tmp/never.sock", HOST: "127.0.0.1", PORT: "9" });
    expect(r.code).toBe(0);
    const log = readFileSync(serverLog, "utf8");
    expect(log).toContain("PGPASSWORD=app-fixture-password");
    expect(log).toContain("WORKFLOW_POSTGRES_URL=postgres://proof:workflow-fixture-password@db/proof");
    expect(log).toContain("LISTEN=0.0.0.0,0.0.0.0,3000,3000\n");
    expect(log).toContain("STRIPPED=\n");
    expect(log).toContain("ARGS=\n");
    expect(log).not.toContain("gateway-fixture-key");
    expect(existsSync(eveMarker)).toBe(false);
  });

  it("refuses with 78 and one line per missing setting, naming no value", () => {
    const env = FULL();
    delete (env as Record<string, string>).GATEWAY_URL;
    delete (env as Record<string, string>).LARES_AGENT_NAME;
    const r = run(env);
    expect(r.code).toBe(78);
    expect(existsSync(serverLog)).toBe(false);
    expect(existsSync(eveMarker)).toBe(false);
    expect(r.stderr).toContain("GATEWAY_URL");
    expect(r.stderr).toContain("LARES_AGENT_NAME");
    expect(r.stderr).not.toContain("postgres://proof@db/proof");
    expect(r.stderr).not.toContain("app-fixture-password");
    expect(r.stderr).not.toContain("workflow-fixture-password");
  });

  it("still refuses when a secret file is unreadable, and says which PATH, not its contents", () => {
    const env = { ...FULL(), GATEWAY_KEY_FILE: join(secrets, "missing-key") };
    const r = run(env);
    expect(r.code).not.toBe(0);
    expect(existsSync(serverLog)).toBe(false);
    expect(existsSync(eveMarker)).toBe(false);
    expect(r.stderr).toContain("missing-key");
  });

  it("is POSIX sh and passes a syntax check", () => {
    expect(() => execFileSync("/bin/sh", ["-n", SCRIPT])).not.toThrow();
    expect(() => execFileSync("/bin/sh", ["-n", FRAGMENT])).not.toThrow();
  });

  // An EMPTY secret file is a
  // refusal too (a readable but empty gateway key means every model call comes back
  // unauthenticated — half-working, which is exactly what this guard exists to prevent), and it
  // names "no secret bytes, not even a secret's length" as the thing the refusal must not print.
  it("refuses when a secret file exists but is empty, and prints neither its bytes nor its length", () => {
    const empty = join(secrets, "empty-key");
    writeFileSync(empty, "");
    const r = run({ ...FULL(), GATEWAY_KEY_FILE: empty });
    expect(r.code).toBe(78);
    expect(existsSync(serverLog)).toBe(false);
    expect(existsSync(eveMarker)).toBe(false);
    expect(r.stderr).toContain("empty-key");
    expect(r.stderr).not.toContain("app-fixture-password");
    expect(r.stderr).not.toContain("workflow-fixture-password");
    expect(r.stderr).not.toMatch(/\b(23|24) bytes\b/);
  });

  // The runtime image is node:24-bookworm-slim, where /bin/sh is dash — so "it works in bash's
  // sh mode" is not the question. Skipped where dash is not installed rather than failing there.
  it.skipIf(!existsSync("/bin/dash"))("also refuses under dash, the image's real /bin/sh, when a setting is blank", () => {
    const env = { ...FULL(), LARES_AGENT_NAME: "   " };
    let code = 0, stderr = "";
    try {
      execFileSync("/bin/dash", [SCRIPT], {
        cwd: dir, encoding: "utf8",
        env: { PATH: `${binDir}:${process.env.PATH}`, LARES_REQUIRED_SETTINGS: FRAGMENT, ...env },
      });
    } catch (e) {
      const err = e as { status: number; stderr: string };
      code = err.status; stderr = err.stderr;
    }
    expect(code).toBe(78);
    expect(existsSync(serverLog)).toBe(false);
    expect(existsSync(eveMarker)).toBe(false);
    expect(stderr).toContain("LARES_AGENT_NAME");
  });
});
