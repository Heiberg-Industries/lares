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

  describe("--test-model on an installation with the built-in gateway", () => {
    const KEY = "sk-fixture-provider-key-never-print";
    const db = () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })), end: vi.fn() } as unknown as Pool);
    function withProfile(profile: unknown, run: (profileFile: string) => Promise<void>) {
      const dir = mkdtempSync(join(tmpdir(), "doctor-gateway-profile-"));
      const profileFile = join(dir, "litellm-config.yaml.profile.json");
      writeFileSync(profileFile, typeof profile === "string" ? profile : JSON.stringify(profile));
      return run(profileFile).finally(() => rmSync(dir, { recursive: true, force: true }));
    }
    const anthropic = { version: 1, provider: "anthropic", model: "claude-x", providerBaseUrl: "https://api.anthropic.com", aliases: ["lares-brain"] };
    const modelLine = (out: string[]) => out.join("\n").split("\n").filter((line) => line.includes("Model provider key") || line.includes("Model connection"));

    it("needs no gateway flags: it asks the provider the gateway pays, with the provider key, and says when the key is refused", async () => {
      await withProfile(anthropic, async (profileFile) => {
        const out: string[] = [];
        const fetch = vi.fn(async () => new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 }));
        const code = await main(["--test-model", "--gateway-profile-file", profileFile, "--provider-key-file", "/fixture/model-provider-key"], {
          db: db(), env: {}, out: (line) => out.push(line), readKeyFile: (path) => { expect(path).toBe("/fixture/model-provider-key"); return KEY; },
          fetch: fetch as typeof globalThis.fetch,
        });
        expect(code).toBe(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://api.anthropic.com/v1/models");
        expect(modelLine(out)).toEqual([expect.stringMatching(/^FAIL {2}Model provider key — The provider key was refused: the model provider answered HTTP 401/)]);
        expect(out.join("\n")).toContain("sudo lares provider-key set --key-file <path>");
        expect(out.join("\n")).not.toContain(KEY);
      });
    });

    it("says PASS for a key the provider accepts, and that no completion was sent", async () => {
      await withProfile(anthropic, async (profileFile) => {
        const out: string[] = [];
        const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "claude-x", type: "model" }] }), { status: 200 }));
        await main(["--test-model", "--gateway-profile-file", profileFile, "--provider-key-file", "/fixture/key"], {
          db: db(), env: {}, out: (line) => out.push(line), readKeyFile: () => KEY, fetch: fetch as typeof globalThis.fetch,
        });
        expect(modelLine(out)).toEqual([expect.stringMatching(/^PASS {2}Model provider key — The model provider accepted this installation's provider key\. This checks the key only/)]);
      });
    });

    it("makes no outside call without --test-model, and says how to ask for one", async () => {
      await withProfile(anthropic, async (profileFile) => {
        const out: string[] = [];
        const fetch = vi.fn();
        await main(["--gateway-profile-file", profileFile], { db: db(), env: {}, out: (line) => out.push(line), fetch: fetch as unknown as typeof globalThis.fetch });
        expect(fetch).not.toHaveBeenCalled();
        expect(modelLine(out)).toEqual([expect.stringMatching(/^UNKNOWN {2}Model provider key — The model provider key has not been tested/)]);
        expect(out.join("\n")).toContain("    sudo lares doctor --test-model");
      });
    });

    it("stops with one plain line when the provider settings or the key cannot be read", async () => {
      await withProfile("{not json", async (profileFile) => {
        const out: string[] = [];
        expect(await main(["--test-model", "--gateway-profile-file", profileFile, "--provider-key-file", "/k"], { db: db(), out: (line) => out.push(line), readKeyFile: () => KEY })).toBe(1);
        expect(out).toEqual([`doctor: the gateway's provider settings at "${profileFile}" could not be read, so the provider key cannot be tested.`]);
      });
      await withProfile({ ...anthropic, providerBaseUrl: "http://plain.example" }, async (profileFile) => {
        expect(await main(["--test-model", "--gateway-profile-file", profileFile, "--provider-key-file", "/k"], { db: db(), out: () => undefined, readKeyFile: () => KEY })).toBe(1);
      });
      await withProfile(anthropic, async (profileFile) => {
        const out: string[] = [];
        expect(await main(["--test-model", "--gateway-profile-file", profileFile], { db: db(), out: (line) => out.push(line) })).toBe(1);
        expect(out).toEqual(["doctor: the provider key file could not be read, so the provider key cannot be tested."]);
      });
    });

    it("still tests an explicit gateway as asked, and reads the built-in gateway's refusal of it plainly", async () => {
      await withProfile(anthropic, async (profileFile) => {
        const out: string[] = [];
        const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { type: "budget_admission_refused", code: "budget_admission_refused", message: "x" } }), { status: 400 }));
        const code = await main(["--test-model", "--gateway-profile-file", profileFile, "--gateway", "http://127.0.0.1:4000", "--alias", "lares-brain", "--key-file", "/k"], {
          db: db(), env: {}, out: (line) => out.push(line), readKeyFile: () => KEY, fetch: fetch as typeof globalThis.fetch,
        });
        expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("http://127.0.0.1:4000/v1/messages");
        expect(modelLine(out)).toEqual([expect.stringMatching(/^UNKNOWN {2}Model connection — The gateway refused the test call because the spending limits had not approved it/)]);
        expect(code).toBe(1); // the empty owner register still fails; the refused call itself is not a failure.
      });
    });
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
