/**
 * What a fresh install (web chat and Telegram only, no Google, no Slack, no vault) must do
 * quietly and honestly: skip the schedules that have nothing to work with, and tell the model what
 * is actually connected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectionsMarkdown, readConnections, type ConnectionProbes } from "../lib/connections.js";
import { logSlackNotConnected } from "../lib/slack-allowlist.js";

vi.mock("../lib/definition.js", () => ({
  thisAgent: async () => ({ loaded: { definition: { schedules: {} } } }),
}));
vi.mock("@lares/agent-kit/schedule-switch", () => ({ scheduleEnabled: () => true }));
vi.mock("@lares/agent-kit/schedule-gate", () => ({ scheduleGate: () => true }));
vi.mock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["VAULT_PATH"];
  delete process.env["SLACK_ALLOWED_USER_IDS"];
});

describe("clipping-requests without a vault", () => {
  it("skips with one log line, however many minutes pass, and never errors", async () => {
    delete process.env["VAULT_PATH"];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { default: schedule } = await import("../agent/schedules/clipping-requests.js");
    await schedule.run!({} as never);
    await schedule.run!({} as never);
    await schedule.run!({} as never);
    expect(error).not.toHaveBeenCalled();
    expect(log.mock.calls.filter((c) => String(c[0]).includes("no vault is set up"))).toHaveLength(1);
  });
});

describe("Slack-only schedules without Slack", () => {
  it("say so once per schedule", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logSlackNotConnected("example-schedule");
    logSlackNotConnected("example-schedule");
    logSlackNotConnected("another-schedule");
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0]![0])).toMatch(/example-schedule: skipping, Slack is not connected/);
  });

  it("owner-clock logs the line instead of skipping silently", async () => {
    delete process.env["SLACK_ALLOWED_USER_IDS"];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { default: schedule } = await import("../agent/schedules/owner-clock.js");
    await schedule.run!({} as never);
    expect(log.mock.calls.some((c) => String(c[0]).startsWith("owner-clock: skipping, Slack is not connected"))).toBe(true);
  });
});

describe("what is connected", () => {
  const none: ConnectionProbes = {
    google: async () => false,
    env: {},
    fileExists: () => false,
    slackUsers: () => [],
  };

  it("a fresh install has nothing connected, and the block says so", async () => {
    const state = await readConnections(none);
    expect(Object.values(state).every((v) => v === false)).toBe(true);
    const text = connectionsMarkdown(state);
    expect(text).toContain("Connected: none of them yet.");
    expect(text).toMatch(/Not connected: Google[^.]*; the CRM[^.]*; Notion/);
    expect(text).toMatch(/never call a missing connection a setup fault/);
  });

  it("moves each service to the connected list when its real signal is there", async () => {
    const state = await readConnections({
      google: async () => true,
      env: { TWENTY_BASE_URL: "https://crm.example.invalid", NOTION_TOKEN_FILE: "/x", VAULT_PATH: "/v" },
      fileExists: () => true,
      slackUsers: () => ["U1"],
    });
    expect(state).toEqual({ google: true, crm: true, notion: true, vault: true, atlas: false, slack: true });
    const text = connectionsMarkdown(state);
    expect(text).toMatch(/Connected: Google[^.]*; the CRM/);
    expect(text).toMatch(/Not connected: the shared business vault/);
  });

  it("a CRM address without its key counts as not connected", async () => {
    const state = await readConnections({ ...none, env: { TWENTY_BASE_URL: "https://crm.example.invalid" } });
    expect(state.crm).toBe(false);
  });

  it("a Google lookup that fails counts as not connected, not as an error", async () => {
    const state = await readConnections({ ...none, google: async () => { throw new Error("db down"); } });
    expect(state.google).toBe(false);
  });
});
