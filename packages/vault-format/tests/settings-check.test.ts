import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import {
  checkSettings,
  settingsReport,
  requiredSettingsShell,
  type FileProbe,
  type ProbeFile,
} from "../src/settings-check.js";

// `checkSettings` takes a third, injected argument besides `(reader, env)`: secrets are FILES,
// and a `*_FILE` check reads only exists/readable/empty, never the value, so a probe is
// injected and no real file ever has to exist for a test.

const FULL: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://proof@db/proof",
  WORKFLOW_POSTGRES_URL: "postgres://proof@db/proof",
  DATABASE_PASSWORD_FILE: "/run/secrets/database-password",
  WORKFLOW_POSTGRES_PASSWORD_FILE: "/run/secrets/workflow-password",
  GATEWAY_URL: "http://gateway:4000",
  GATEWAY_KEY_FILE: "/run/secrets/gateway-key",
  LARES_AGENT_NAME: "helper",
  LARES_DEFINITION_DIR: "/definition",
};

const GOOD_FILES = new Set(["/run/secrets/database-password", "/run/secrets/workflow-password", "/run/secrets/gateway-key"]);
const CHIEF_GUARD = join(import.meta.dirname, "../../../images/agent-runtime/required-settings-chief-of-staff.sh");

/** A file probe with no real files: everything named in FULL is present, readable and non-empty;
 *  anything else does not exist. */
const probeOk: ProbeFile = (path) =>
  GOOD_FILES.has(path)
    ? { exists: true, readable: true, empty: false }
    : { exists: false, readable: false, empty: true };

const MANAGED_ENV = {
  ...Object.fromEntries(Object.entries(FULL).filter(([name]) => name !== "GATEWAY_KEY_FILE")),
  LARES_AGENT_INCARNATION: "22222222-2222-4222-8222-222222222222",
  LARES_RUNTIME_CONTROL_SECRET_FILE: "/run/secrets/runtime-control",
  LARES_MODEL_PURPOSE_RUNTIME_SOCKET: "/run/lares/model-purpose/model-purpose.sock",
};
const managedProbe: ProbeFile = (path) => {
  if (path === "/run/lares/model-purpose/model-purpose.sock" || path === "/run/lares/model-purpose/gateway.sock")
    return { exists: true, readable: true, empty: false, isSocket: true };
  if (path === "/run/secrets/runtime-control")
    return { exists: true, readable: true, empty: false, isFile: true };
  return probeOk(path);
};

describe("what a missing setting says", () => {
  it("says nothing at all when everything required is there", () => {
    expect(checkSettings("chief-of-staff", FULL, probeOk)).toEqual([]);
    expect(settingsReport([])).toBe("");
  });

  it("names the setting, says what breaks, and never prints a value", () => {
    const { GATEWAY_KEY_FILE: _drop, ...without } = FULL;
    const problems = checkSettings("chief-of-staff", without, probeOk);
    expect(problems.map((p) => p.name)).toEqual(["GATEWAY_KEY_FILE"]);
    expect(problems[0]!.kind).toBe("missing");
    const report = settingsReport(problems);
    expect(report).toContain("GATEWAY_KEY_FILE");
    expect(report).toMatch(/is not set/);
    expect(report).not.toContain("postgres://proof@db/proof");
  });

  it("treats an empty or blank value as missing, not as set", () => {
    const problems = checkSettings("chief-of-staff", { ...FULL, LARES_AGENT_NAME: "   " }, probeOk);
    expect(problems.map((p) => [p.name, p.kind])).toEqual([["LARES_AGENT_NAME", "blank"]]);
  });

  it("reports every problem at once, in declaration order, one line each", () => {
    const dummyProbe: ProbeFile = () => ({ exists: false, readable: false, empty: true });
    const report = settingsReport(checkSettings("chief-of-staff", {}, dummyProbe));
    const lines = report.split("\n").filter((l) => l.startsWith("  - "));
    expect(lines.length).toBe(8);
    expect(lines[0]).toContain("DATABASE_URL");
  });

  it("flags a secret file that does not exist or cannot be read — never the raw env word", () => {
    const problems = checkSettings(
      "chief-of-staff",
      { ...FULL, GATEWAY_KEY_FILE: "/run/secrets/does-not-exist" },
      probeOk,
    );
    expect(problems.map((p) => [p.name, p.kind])).toEqual([["GATEWAY_KEY_FILE", "unreadable"]]);
    expect(problems[0]!.say).not.toMatch(/\benv var\b/i);
    expect(settingsReport(problems)).toContain("cannot be read");
  });

  it("flags a secret file that exists, is readable, but is empty", () => {
    const probeEmptyGateway: ProbeFile = (path) =>
      path === "/run/secrets/gateway-key"
        ? { exists: true, readable: true, empty: true }
        : probeOk(path);
    const problems = checkSettings("chief-of-staff", FULL, probeEmptyGateway);
    expect(problems.map((p) => [p.name, p.kind])).toEqual([["GATEWAY_KEY_FILE", "empty"]]);
    expect(settingsReport(problems)).toMatch(/exists but is empty/);
  });

  it("accepts only the exact chief managed transport when its two sockets and control file are verified", () => {
    expect(checkSettings("chief-of-staff", MANAGED_ENV, managedProbe)).toEqual([]);
    expect(checkSettings("creative", MANAGED_ENV, managedProbe).map((p) => p.name)).toContain("GATEWAY_KEY_FILE");
    expect(checkSettings("chief-of-staff", { ...MANAGED_ENV, LARES_MODEL_PURPOSE_RUNTIME_SOCKET: "/tmp/arbitrary.sock" }, managedProbe).map((p) => p.name)).toContain("GATEWAY_KEY_FILE");
    expect(checkSettings("chief-of-staff", { ...MANAGED_ENV, LARES_AGENT_INCARNATION: "not-an-incarnation" }, managedProbe).map((p) => p.name)).toContain("GATEWAY_KEY_FILE");
    expect(checkSettings("chief-of-staff", { ...MANAGED_ENV, LARES_AGENT_INCARNATION: "2222222--2222-4222-8222-222222222222" }, managedProbe).map((p) => p.name)).toContain("GATEWAY_KEY_FILE");
    expect(checkSettings("chief-of-staff", { ...MANAGED_ENV, LARES_RUNTIME_CONTROL_SECRET_FILE: "/tmp/control" }, managedProbe).map((p) => p.name)).toContain("GATEWAY_KEY_FILE");
    expect(checkSettings("chief-of-staff", MANAGED_ENV, (path) => path === "/run/secrets/runtime-control" ? { exists: true, readable: true, empty: false } : managedProbe(path)).map((p) => p.name)).toContain("GATEWAY_KEY_FILE");
    expect(checkSettings("chief-of-staff", MANAGED_ENV, (path) => path === "/run/lares/model-purpose/gateway.sock" ? { exists: true, readable: true, empty: false, isSocket: false } : managedProbe(path)).map((p) => p.name)).toContain("GATEWAY_KEY_FILE");
    expect(checkSettings("chief-of-staff", { ...MANAGED_ENV, GATEWAY_KEY_FILE: "" }, managedProbe).map((p) => p.name)).toContain("GATEWAY_KEY_FILE");
  });

  it("never lets a secret file's bytes into a sentence, even when the probe itself reads them", () => {
    const dir = mkdtempSync(join(tmpdir(), "settings-check-"));
    try {
      const secretPath = join(dir, "gateway-key");
      const otherFilePath = join(dir, "database-password"); // a stand-in for another *_FILE
      const workflowFilePath = join(dir, "workflow-password");
      const secretBytes = "disposable-fixture-only";
      writeFileSync(secretPath, secretBytes);
      writeFileSync(otherFilePath, "also-disposable");
      writeFileSync(workflowFilePath, "distinctly-disposable");

      // A "real" probe: it reads the file to decide exists/readable/empty, exactly like a real
      // caller (startup, doctor) would — but it only ever RETURNS the three booleans.
      const realProbe: ProbeFile = (path): FileProbe => {
        try {
          const stat = statSync(path);
          readFileSync(path); // proves readability without handing the bytes anywhere
          return { exists: true, readable: true, empty: stat.size === 0 };
        } catch {
          return { exists: false, readable: false, empty: true };
        }
      };
      const env = { ...FULL, GATEWAY_KEY_FILE: secretPath, DATABASE_PASSWORD_FILE: otherFilePath, WORKFLOW_POSTGRES_PASSWORD_FILE: workflowFilePath };

      const fine = checkSettings("chief-of-staff", env, realProbe);
      expect(fine).toEqual([]);

      writeFileSync(secretPath, ""); // now empty
      const problems = checkSettings("chief-of-staff", env, realProbe);
      expect(problems.map((p) => p.kind)).toEqual(["empty"]);
      for (const p of problems) expect(p.say).not.toContain(secretBytes);
      expect(settingsReport(problems)).not.toContain(secretBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the shell fragment is pure bash 3.2 and quotes every value it reads", () => {
    const body = requiredSettingsShell(["chief-of-staff", "creative"]);
    expect(body).toMatch(/^#!\/bin\/sh\n/);
    expect(body).toContain('lares_require DATABASE_URL "');
    expect(body).not.toMatch(/declare -A|\$\{[A-Za-z_]+\^\^\}|mapfile/);
    // No value is ever echoed — only the NAME and the sentence.
    expect(body).not.toMatch(/echo .*\$\{?[A-Z_]+\}?"?\s*$/m);
  });

  it("the chief shell guard accepts real fixed-contract sockets and rejects a missing endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "settings-managed-shell-"));
    const runtimeSocket = join(dir, "model-purpose.sock"), gatewaySocket = join(dir, "gateway.sock");
    const controlFile = join(dir, "runtime-control"), databasePassword = join(dir, "database-password"), workflowPassword = join(dir, "workflow-password"), gatewayKey = join(dir, "gateway-key"), script = join(dir, "guard.sh");
    const runtimeServer = createServer(), gatewayServer = createServer();
    try {
      await new Promise<void>((resolve, reject) => runtimeServer.listen(runtimeSocket, resolve).once("error", reject));
      await new Promise<void>((resolve, reject) => gatewayServer.listen(gatewaySocket, resolve).once("error", reject));
      writeFileSync(controlFile, "control-fixture-only");
      writeFileSync(databasePassword, "database-fixture-only");
      writeFileSync(workflowPassword, "workflow-fixture-only");
      writeFileSync(gatewayKey, "gateway-key-fixture-only");
      const source = readFileSync(CHIEF_GUARD, "utf8")
        .replaceAll("/run/lares/model-purpose/model-purpose.sock", runtimeSocket)
        .replaceAll("/run/lares/model-purpose/gateway.sock", gatewaySocket)
        .replaceAll("/run/secrets/runtime-control", controlFile)
        .replaceAll("/run/secrets/database-password", databasePassword)
        .replaceAll("/run/secrets/workflow-password", workflowPassword);
      writeFileSync(script, source);
      const env: NodeJS.ProcessEnv = { ...process.env, ...MANAGED_ENV, ...Object.fromEntries(Object.entries(FULL).filter(([name]) => name !== "GATEWAY_KEY_FILE")), DATABASE_PASSWORD_FILE: databasePassword, WORKFLOW_POSTGRES_PASSWORD_FILE: workflowPassword, LARES_MODEL_PURPOSE_RUNTIME_SOCKET: runtimeSocket, LARES_RUNTIME_CONTROL_SECRET_FILE: controlFile };
      delete env.GATEWAY_KEY_FILE;
      expect(execFileSync("/bin/sh", [script], { env, encoding: "utf8" })).toBe("");
      expect(execFileSync("/bin/sh", [script], { env: { ...env, GATEWAY_KEY_FILE: gatewayKey }, encoding: "utf8" })).toBe("");
      expect(() => execFileSync("/bin/sh", [script], { env: { ...env, LARES_MODEL_PURPOSE_RUNTIME_SOCKET: "/tmp/arbitrary.sock" }, encoding: "utf8", stdio: "pipe" })).toThrow();
      expect(() => execFileSync("/bin/sh", [script], { env: { ...env, LARES_AGENT_INCARNATION: "22222222-0222-0222-0222-222222222222" }, encoding: "utf8", stdio: "pipe" })).toThrow();
      expect(() => execFileSync("/bin/sh", [script], { env: { ...env, LARES_AGENT_INCARNATION: "2222222--2222-4222-8222-222222222222" }, encoding: "utf8", stdio: "pipe" })).toThrow();
      writeFileSync(controlFile, "");
      expect(() => execFileSync("/bin/sh", [script], { env, encoding: "utf8", stdio: "pipe" })).toThrow();
      writeFileSync(controlFile, "control-fixture-only");
      await new Promise<void>((resolve, reject) => gatewayServer.close((error) => error ? reject(error) : resolve()));
      expect(() => execFileSync("/bin/sh", [script], { env, encoding: "utf8", stdio: "pipe" })).toThrow();
    } finally {
      await new Promise<void>((resolve) => runtimeServer.close(() => resolve()));
      await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
