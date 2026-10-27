import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs } from "../bin/doctor.js";
import { requiredNamesFor, settingByName } from "@lares/vault-format/settings";

describe("the install-time model-only check", () => {
  it("requires an explicit model test", () => {
    expect(() => parseArgs(["--model-only"])).toThrow(/requires --test-model/);
  });

  it("checks the completion without querying the not-yet-migrated database", async () => {
    const out: string[] = [];
    const db = { query: vi.fn(), end: vi.fn() } as unknown as Pool;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }));
    const code = await main(
      ["--test-model", "--model-only", "--gateway", "http://127.0.0.1:4000", "--alias", "lares-brain", "--key-file", "/fixture/key"],
      { db, out: (line) => out.push(line), readKeyFile: () => "fixture-master-key", fetch: fetch as typeof globalThis.fetch },
    );
    expect(code).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("real completion");
    expect(out.join("\n")).not.toContain("fixture-master-key");
  });

  it("reads installed non-secret settings as data and never echoes a secret-file value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-installed-settings-"));
    const settingsFile = join(dir, "installation.env");
    const secretFile = join(dir, "console-session-secret");
    const payloadFile = join(dir, "should-not-exist");
    const secretValue = "fixture-console-secret-never-print";
    try {
      writeFileSync(settingsFile, [
        "CONSOLE_ALLOWED_EMAILS='owner@example.invalid'",
        `LARES_OWNER_NAME='$(touch ${payloadFile})'`,
      ].join("\n"));
      writeFileSync(secretFile, `  ${secretValue}  \n`);
      const env: NodeJS.ProcessEnv = { CONSOLE_SESSION_SECRET_FILE: secretFile };
      for (const name of new Set([...requiredNamesFor("box"), ...requiredNamesFor("console")])) {
        const def = settingByName(name)!;
        if (name === "CONSOLE_SESSION_SECRET") continue;
        if (name.endsWith("_FILE")) env[name] = secretFile;
        else env[name] = def.secret ? "fixture-plain-secret" : "fixture-setting";
      }
      env.CONSOLE_SESSION_SECRET_FILE = secretFile;

      const out: string[] = [];
      const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), end: vi.fn() } as unknown as Pool;
      const code = await main(["--installed-settings-file", settingsFile], {
        db,
        env,
        out: (line) => out.push(line),
      });

      expect(code).toBe(1); // The deliberately empty owner register is still reported.
      expect(out.join("\n")).toContain("Every setting this installation needs is set.");
      expect(out.join("\n")).not.toContain(secretValue);
      expect(out.join("\n")).not.toContain("$(touch");
      expect(existsSync(payloadFile)).toBe(false);

      chmodSync(secretFile, 0o400);
      const permissionOut: string[] = [];
      await main(["--installed-settings-file", settingsFile], {
        db,
        env,
        out: (line) => permissionOut.push(line),
      });
      expect(permissionOut.join("\n")).toContain("CONSOLE_SESSION_SECRET_FILE");
      expect(permissionOut.join("\n")).toContain("cannot be read");
      expect(permissionOut.join("\n")).not.toContain(secretValue);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing or invalid installed allow-list without exposing its source text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-installed-settings-invalid-"));
    const settingsFile = join(dir, "installation.env");
    try {
      writeFileSync(settingsFile, "CONSOLE_ALLOWED_EMAILS=$(do-not-run)\n");
      const env: NodeJS.ProcessEnv = { CONSOLE_SESSION_SECRET_FILE: join(dir, "missing-secret") };
      const out: string[] = [];
      const db = { query: vi.fn(), end: vi.fn() } as unknown as Pool;
      await main(["--installed-settings-file", settingsFile], { db, env, out: (line) => out.push(line) });
      expect(out.join("\n")).toContain("CONSOLE_ALLOWED_EMAILS");
      expect(out.join("\n")).toContain("CONSOLE_SESSION_SECRET_FILE");
      expect(out.join("\n")).not.toContain("do-not-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
