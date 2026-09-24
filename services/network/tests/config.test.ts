import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveTwentyApiKey, resolveSlackToken, resolveSlackUserToken, SLACK_KEYCHAIN_SERVICE, SLACK_USER_KEYCHAIN_SERVICE } from "../lib/config.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tempConfig(json: object): string {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  dirs.push(dir);
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(json));
  return p;
}

describe("config twenty settings", () => {
  it("defaults: twentyBaseUrl null", () => {
    expect(loadConfig("/nonexistent/config.json").twentyBaseUrl).toBeNull();
  });
  it("reads twentyBaseUrl from file", () => {
    const c = loadConfig(tempConfig({ twentyBaseUrl: "https://crm.owner.example" }));
    expect(c.twentyBaseUrl).toBe("https://crm.owner.example");
  });
});

describe("resolveTwentyApiKey", () => {
  it("prefers the config override (for tests/dev)", () => {
    expect(resolveTwentyApiKey({ twentyApiKey: "from-config" } as any)).toBe("from-config");
  });
  it("falls back to the keychain reader", () => {
    expect(resolveTwentyApiKey({ twentyApiKey: null } as any, () => "from-keychain")).toBe("from-keychain");
  });
  it("throws a setup-instruction error when neither config nor keychain has a key", () => {
    expect(() =>
      resolveTwentyApiKey({ twentyApiKey: null } as any, () => { throw new Error("not found"); }),
    ).toThrow(/security add-generic-password/);
  });
});

describe("resolveSlackToken", () => {
  it("prefers the config override", () => {
    const config = { ...loadConfig("/nonexistent"), slackBotToken: "xoxb-test" };
    expect(resolveSlackToken(config, () => { throw new Error("keychain should not be read"); })).toBe("xoxb-test");
  });

  it("falls back to the keychain", () => {
    const config = loadConfig("/nonexistent");
    expect(resolveSlackToken(config, () => "xoxb-keychain")).toBe("xoxb-keychain");
  });

  it("throws with setup instructions when absent", () => {
    const config = loadConfig("/nonexistent");
    expect(() => resolveSlackToken(config, () => { throw new Error("not found"); }))
      .toThrow(SLACK_KEYCHAIN_SERVICE);
  });
});

describe("resolveSlackUserToken", () => {
  it("prefers the config override", () => {
    const config = { ...loadConfig("/nonexistent"), slackUserToken: "xoxp-test" };
    expect(resolveSlackUserToken(config, () => { throw new Error("keychain should not be read"); })).toBe("xoxp-test");
  });

  it("falls back to the keychain", () => {
    const config = loadConfig("/nonexistent");
    expect(resolveSlackUserToken(config, () => "xoxp-keychain")).toBe("xoxp-keychain");
  });

  it("throws with setup instructions when absent — never silently no-ops without a token", () => {
    const config = loadConfig("/nonexistent");
    expect(() => resolveSlackUserToken(config, () => { throw new Error("not found"); }))
      .toThrow(SLACK_USER_KEYCHAIN_SERVICE);
  });

  it("is a separate token/service from the bot token (D1: distinct stores)", () => {
    expect(SLACK_USER_KEYCHAIN_SERVICE).not.toBe(SLACK_KEYCHAIN_SERVICE);
    expect(SLACK_USER_KEYCHAIN_SERVICE).toBe("lares-network-slack-user");
  });
});

describe("digestSlackChannel", () => {
  it("defaults to null (digest disabled)", () => {
    expect(loadConfig("/nonexistent").digestSlackChannel).toBeNull();
  });
});

describe("config brain vault", () => {
  it("defaults: brainVaultPath null", () => {
    expect(loadConfig("/nonexistent/config.json").brainVaultPath).toBeNull();
  });
  it("reads brainVaultPath from file", () => {
    const c = loadConfig(tempConfig({ brainVaultPath: "/tmp/vault" }));
    expect(c.brainVaultPath).toBe("/tmp/vault");
  });
});

describe("config ownMetaName", () => {
  it("does not assume an installation identity", () => {
    const cfg = loadConfig("/nonexistent/path/config.json");
    expect(cfg.ownMetaName).toBe("");
    expect(cfg.ownLinkedInUrl).toBe("");
  });
});
