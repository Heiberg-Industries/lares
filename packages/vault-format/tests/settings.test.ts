import { describe, it, expect } from "vitest";
import {
  SETTINGS, SETTING_NAMES, settingsFor, settingByName, requiredNamesFor,
} from "../src/settings.js";

describe("the settings list", () => {
  it("names every variable the runtime image already refuses to start without", () => {
    // images/agent-runtime/start.sh's own `:?` list, which this registry must contain.
    for (const name of [
      "DATABASE_URL", "WORKFLOW_POSTGRES_URL", "DATABASE_PASSWORD_FILE",
      "GATEWAY_URL", "GATEWAY_KEY_FILE", "LARES_AGENT_NAME", "LARES_DEFINITION_DIR",
    ]) {
      expect(SETTING_NAMES.has(name), `${name} is missing from SETTINGS`).toBe(true);
      expect(requiredNamesFor("chief-of-staff")).toContain(name);
    }
  });

  it("says something useful about every entry, and never twice about one name", () => {
    const seen = new Set<string>();
    for (const s of SETTINGS) {
      expect(/^[A-Z][A-Z0-9_]*$/.test(s.name), s.name).toBe(true);
      expect(seen.has(s.name), `${s.name} declared twice`).toBe(false);
      seen.add(s.name);
      expect(s.readers.length, s.name).toBeGreaterThan(0);
      expect(s.readAt.length, s.name).toBeGreaterThan(0);
      expect(s.breaksWithout.length, s.name).toBeGreaterThan(20);
      expect(s.breaksWithout.endsWith("."), s.name).toBe(true);
      // A required setting cannot also have a fallback: then it is not required.
      if (s.requiredFor.length > 0) expect(s.fallback, s.name).toBeNull();
      // Every reader it is required for must be a reader.
      for (const r of s.requiredFor) expect(s.readers, s.name).toContain(r);
    }
  });

  it("marks the value as secret, never the path", () => {
    expect(settingByName("GATEWAY_KEY_FILE")!.secret).toBe(false);
    expect(settingByName("CONSOLE_SESSION_SECRET")!.secret).toBe(true);
    expect(settingByName("TOKEN_ENC_KEY")!.secret).toBe(true);
    expect(settingByName("NOTION_TOKEN")!.secret).toBe(true);
    for (const s of SETTINGS) if (s.name.endsWith("_FILE")) expect(s.secret, s.name).toBe(false);
  });

  it("records fail-closed identity and console configuration", () => {
    // services/console/lib/auth.ts:152 — the reason `lares doctor` has a check of its own.
    const allowed = settingByName("CONSOLE_ALLOWED_EMAILS")!;
    expect(allowed.readers).toContain("console");
    expect(allowed.source).toBe("owner");
    expect(allowed.fallback).toBeNull();
    expect(allowed.breaksWithout).toMatch(/admits nobody/i);
    expect(settingByName("AGENT_OWNER_USER_ID")!.fallback).toBeNull();
    expect(settingByName("SLACK_TOKEN_PRINCIPAL_ID")!.breaksWithout).toMatch(/refuses before querying/);
  });

  it("every reader has at least one setting", () => {
    for (const r of ["agent-kit","chief-of-staff","travel","creative","console","box","keeper","atlas","notion-sync","readability"] as const) {
      expect(settingsFor(r).length, r).toBeGreaterThan(0);
    }
  });

  it("declares the neutral stack's own settings, under the two new readers", () => {
    for (const r of ["gateway", "caddy"] as const) {
      expect(settingsFor(r).length, r).toBeGreaterThan(0);
    }
    expect(SETTING_NAMES.has("MODEL_PROVIDER_KEY_FILE")).toBe(true);
    expect(SETTING_NAMES.has("GATEWAY_MASTER_KEY_FILE")).toBe(true);
    expect(SETTING_NAMES.has("LARES_DOMAIN")).toBe(true);
    expect(settingByName("MODEL_PROVIDER_KEY_FILE")!.secret).toBe(false); // the path, not the value
    expect(settingByName("DATABASE_PASSWORD_FILE")!.readers).toContain("box"); // F2's fix, now also true of box's own reader, not only the three roles
  });
});
