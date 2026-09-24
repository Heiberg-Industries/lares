import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  deriveState,
  needsHuman,
  buildCopyPrompt,
  getCrmStatus,
  type CrmChannelDTO,
} from "../lib/crm-status";

const NOW = new Date("2026-08-10T10:14:00.000Z");

function channel(over: Partial<CrmChannelDTO> = {}): CrmChannelDTO {
  return {
    handle: "owner@owner.example",
    isSyncEnabled: true,
    syncStatus: "ACTIVE",
    syncStage: null,
    syncStageStartedAt: null,
    throttleFailureCount: 0,
    throttleRetryAfter: null,
    syncedAt: "2026-08-10T10:10:00.000Z",
    authFailedAt: null,
    ...over,
  };
}

describe("deriveState", () => {
  it("reports a healthy channel as syncing", () => {
    expect(deriveState(channel(), NOW)).toBe("syncing");
  });

  // THE trap this whole section exists for. The guard sets isSyncEnabled = false; Twenty's
  // MessagingRelaunchFailedMessageChannelJob independently resets syncStatus to ACTIVE every
  // 30 minutes. A paused, dead mailbox therefore reads perfectly healthy to anything that
  // trusts the enum. Ordering by isSyncEnabled FIRST is what makes the section true.
  it("reports paused even when Twenty says ACTIVE", () => {
    expect(deriveState(channel({ isSyncEnabled: false, syncStatus: "ACTIVE" }), NOW)).toBe("paused");
  });

  it("reports paused ahead of a failed auth", () => {
    const c = channel({ isSyncEnabled: false, authFailedAt: "2026-08-09T00:00:00.000Z" });
    expect(deriveState(c, NOW)).toBe("paused");
  });

  it("reports a broken token ahead of a FAILED_ status", () => {
    const c = channel({ authFailedAt: "2026-08-09T00:00:00.000Z", syncStatus: "FAILED_UNKNOWN" });
    expect(deriveState(c, NOW)).toBe("token expired");
  });

  it("reports any FAILED_ status as failing", () => {
    expect(deriveState(channel({ syncStatus: "FAILED_UNKNOWN" }), NOW)).toBe("failing");
    expect(deriveState(channel({ syncStatus: "FAILED_INSUFFICIENT_PERMISSIONS" }), NOW)).toBe("failing");
  });

  it("reports throttled only while the retry time is still in the future", () => {
    expect(deriveState(channel({ throttleRetryAfter: "2026-08-10T11:00:00.000Z" }), NOW)).toBe("throttled");
    // Already elapsed — no longer throttled, so it falls through to healthy.
    expect(deriveState(channel({ throttleRetryAfter: "2026-08-10T09:00:00.000Z" }), NOW)).toBe("syncing");
  });

  it("reports a never-synced channel as not yet synced", () => {
    expect(deriveState(channel({ syncedAt: null }), NOW)).toBe("not yet synced");
  });
});

describe("needsHuman", () => {
  it("is true for every state a person has to act on", () => {
    expect(needsHuman("paused")).toBe(true);
    expect(needsHuman("token expired")).toBe(true);
    expect(needsHuman("failing")).toBe(true);
    expect(needsHuman("throttled")).toBe(true);
  });

  it("is false for states that need nothing", () => {
    expect(needsHuman("syncing")).toBe(false);
    expect(needsHuman("not yet synced")).toBe(false);
  });
});

describe("buildCopyPrompt", () => {
  const paused = channel({
    handle: "post@project.example",
    isSyncEnabled: false,
    syncStatus: "FAILED_UNKNOWN",
    throttleFailureCount: 12,
    syncedAt: "2026-08-04T09:12:00.000Z",
  });

  it("names the mailbox and the situation", () => {
    const p = buildCopyPrompt(paused, "paused");
    expect(p).toContain("post@project.example");
    expect(p).toContain("isSyncEnabled = false");
    expect(p).toContain("FAILED_UNKNOWN");
    expect(p).toContain("12 throttle failures");
    expect(p).toContain("2026-08-04T09:12:00.000Z");
  });

  // The resume UPDATE is deliberately absent from the prompt and from the page. Pasting it
  // before the cause is fixed is exactly how the July doom loop would restart.
  it("never contains a write statement", () => {
    for (const state of ["paused", "token expired", "failing", "throttled"] as const) {
      const p = buildCopyPrompt(paused, state);
      expect(p).not.toMatch(/UPDATE/i);
      expect(p).not.toMatch(/isSyncEnabled"?\s*=\s*true/);
    }
  });

  it("instructs diagnosis and points at the background", () => {
    const p = buildCopyPrompt(paused, "paused");
    expect(p).toContain("Diagnose the cause before re-enabling");
    expect(p).toContain("services/crm/crm-sync-guard.sh");
    expect(p).toContain("2026-07-20-gmail-user-rate-limit-no-backoff.md");
    expect(p).toContain("100.91.129.38");
  });

  // Built only from facts already on the row: no invented state, no guessed cause.
  it("omits facts the row does not carry", () => {
    const bare = channel({ throttleFailureCount: 0, syncedAt: null, syncStage: null });
    const p = buildCopyPrompt(bare, "failing");
    expect(p).not.toContain("throttle failures");
    expect(p).not.toContain("sync stage");
    expect(p).toContain("no successful sync on record");
  });

  it("says plainly when the token has not failed auth", () => {
    expect(buildCopyPrompt(paused, "paused")).toContain("token has not failed auth");
  });
});

describe("getCrmStatus", () => {
  beforeEach(() => {
    process.env["CRM_STATUS_URL"] = "http://crm-status:8080/crm/sync-status";
    process.env["CRM_STATUS_TOKEN"] = "test-token";
  });
  afterEach(() => {
    delete process.env["CRM_STATUS_URL"];
    delete process.env["CRM_STATUS_TOKEN"];
    vi.unstubAllGlobals();
  });

  it("returns the payload and sends the bearer", async () => {
    const spy = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ at: "2026-08-10T10:14:00.000Z", channels: [channel()] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", spy);
    const dto = await getCrmStatus();
    expect(dto.unavailable).toBeUndefined();
    expect(dto.channels).toHaveLength(1);
    expect(dto.at).toBe("2026-08-10T10:14:00.000Z");
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer test-token");
  });

  // An ops-1 outage must not take /integrations down, and it must never render as an empty
  // table — an empty table reads as "no problems".
  it("degrades instead of throwing on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await expect(getCrmStatus()).resolves.toEqual({ at: "", channels: [], unavailable: true });
  });

  it("degrades on a non-200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(getCrmStatus()).resolves.toEqual({ at: "", channels: [], unavailable: true });
  });

  it("degrades on malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    await expect(getCrmStatus()).resolves.toEqual({ at: "", channels: [], unavailable: true });
  });

  it("degrades on a well-formed body with no channels array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ at: "x" }), { status: 200 })));
    await expect(getCrmStatus()).resolves.toEqual({ at: "", channels: [], unavailable: true });
  });

  it("degrades when it is not configured at all", async () => {
    delete process.env["CRM_STATUS_URL"];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("must not be called"); }));
    await expect(getCrmStatus()).resolves.toEqual({ at: "", channels: [], unavailable: true });
  });

  // The service and the console deploy independently, so a field rename on one side is invisible
  // to the other's tsc. A row missing isSyncEnabled must never reach the renderer: `!undefined`
  // is `true`, which deriveState would read as "paused" — a healthy mailbox painted red.
  it("degrades when a row is missing isSyncEnabled, rather than rendering it paused", async () => {
    const badRow = { handle: "owner@owner.example", syncStatus: "ACTIVE" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ at: "2026-08-10T10:14:00.000Z", channels: [badRow] }), {
          status: 200,
        }),
      ),
    );
    const dto = await getCrmStatus();
    expect(dto).toEqual({ at: "", channels: [], unavailable: true });
    // Confirm the trap this test exists for: the bad row is NOT present as a channel that
    // deriveState would call "paused" — it must not be there at all.
    expect(dto.channels.find((c) => (c as CrmChannelDTO).handle === "owner@owner.example")).toBeUndefined();
  });

  // A row missing syncStatus would otherwise throw inside the server component (c.syncStatus
  // .startsWith(...)) rather than degrading inside getCrmStatus — defeating the "never throws"
  // promise that keeps an ops-1 problem from taking the whole /integrations route down.
  it("degrades when a row is missing syncStatus, and does not throw", async () => {
    const badRow = { handle: "owner@owner.example", isSyncEnabled: true };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ at: "2026-08-10T10:14:00.000Z", channels: [badRow] }), {
          status: 200,
        }),
      ),
    );
    await expect(getCrmStatus()).resolves.toEqual({ at: "", channels: [], unavailable: true });
  });

  // Proves normalisation, not just rejection: the three required fields are enough to accept a
  // row, and the optional fields default sensibly rather than making the validator needlessly
  // strict.
  it("accepts a row with only the three required fields, normalising the rest", async () => {
    const minimalRow = { handle: "owner@owner.example", isSyncEnabled: true, syncStatus: "ACTIVE" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ at: "2026-08-10T10:14:00.000Z", channels: [minimalRow] }), {
          status: 200,
        }),
      ),
    );
    const dto = await getCrmStatus();
    expect(dto.unavailable).toBeUndefined();
    expect(dto.channels).toEqual([
      {
        handle: "owner@owner.example",
        isSyncEnabled: true,
        syncStatus: "ACTIVE",
        syncStage: null,
        syncStageStartedAt: null,
        throttleFailureCount: 0,
        throttleRetryAfter: null,
        syncedAt: null,
        authFailedAt: null,
      },
    ]);
  });
});
