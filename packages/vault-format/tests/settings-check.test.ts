import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSettings,
  settingsReport,
  requiredSettingsShell,
  type FileProbe,
  type ProbeFile,
} from "../src/settings-check.js";

// Adapted from the plan's snippet: `checkSettings` there took only `(reader, env)`. This slice's
// own bar (secrets are FILES; a `*_FILE` check reads only exists/readable/empty, never the value)
// needs a third, injected argument so no real file ever has to exist for a test. Every call below
// was adapted to pass one. See the builder's report for the full reasoning.

const FULL: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://proof@db/proof",
  WORKFLOW_POSTGRES_URL: "postgres://proof@db/proof",
  DATABASE_PASSWORD_FILE: "/run/secrets/database-password",
  GATEWAY_URL: "http://gateway:4000",
  GATEWAY_KEY_FILE: "/run/secrets/gateway-key",
  LARES_AGENT_NAME: "helper",
  LARES_DEFINITION_DIR: "/definition",
};

const GOOD_FILES = new Set(["/run/secrets/database-password", "/run/secrets/gateway-key"]);

/** A file probe with no real files: everything named in FULL is present, readable and non-empty;
 *  anything else does not exist. */
const probeOk: ProbeFile = (path) =>
  GOOD_FILES.has(path)
    ? { exists: true, readable: true, empty: false }
    : { exists: false, readable: false, empty: true };

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
    expect(lines.length).toBe(7);
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

  it("never lets a secret file's bytes into a sentence, even when the probe itself reads them", () => {
    const dir = mkdtempSync(join(tmpdir(), "settings-check-"));
    try {
      const secretPath = join(dir, "gateway-key");
      const otherFilePath = join(dir, "database-password"); // a stand-in for the other *_FILE
      const secretBytes = "disposable-fixture-only";
      writeFileSync(secretPath, secretBytes);
      writeFileSync(otherFilePath, "also-disposable");

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
      const env = { ...FULL, GATEWAY_KEY_FILE: secretPath, DATABASE_PASSWORD_FILE: otherFilePath };

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
    const body = requiredSettingsShell(["chief-of-staff", "travel", "creative"]);
    expect(body).toMatch(/^#!\/bin\/sh\n/);
    expect(body).toContain('lares_require DATABASE_URL "');
    expect(body).not.toMatch(/declare -A|\$\{[A-Za-z_]+\^\^\}|mapfile/);
    // No value is ever echoed — only the NAME and the sentence.
    expect(body).not.toMatch(/echo .*\$\{?[A-Z_]+\}?"?\s*$/m);
  });
});
