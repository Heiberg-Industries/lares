import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("existing Keychain labels during the naming upgrade", () => {
  it("uses explicitly configured labels without reading or copying a secret", async () => {
    vi.stubEnv("LARES_TWENTY_KEYCHAIN_SERVICE", "existing-crm-service");
    vi.stubEnv("LARES_SLACK_KEYCHAIN_SERVICE", "existing-bot-service");
    vi.stubEnv("LARES_SLACK_USER_KEYCHAIN_SERVICE", "existing-user-service");
    vi.resetModules();
    const config = await import("../lib/config.js");
    expect(config.TWENTY_KEYCHAIN_SERVICE).toBe("existing-crm-service");
    expect(config.SLACK_KEYCHAIN_SERVICE).toBe("existing-bot-service");
    expect(config.SLACK_USER_KEYCHAIN_SERVICE).toBe("existing-user-service");
  });
});
