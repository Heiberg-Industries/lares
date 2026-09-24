import { describe, it, expect, vi, afterEach } from "vitest";
import { getRecentSignals, getConsumers } from "../lib/signals";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("getRecentSignals", () => {
  it("unavailable without url/token; parses rows with them; unavailable on non-200", async () => {
    expect(await getRecentSignals({})).toEqual({ unavailable: true });
    vi.stubEnv("SIGNAL_SPINE_URL", "https://spine"); vi.stubEnv("SIGNAL_READ_TOKEN", "R");
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ signals: [{ fingerprint: "f", occurrence: 1, kind: "alert", severity: "error", state: "open", title: "t", project: "p", source: "s", type: "disk", description: null, url: null, firstSeen: "2026-09-04T08:00:00Z", lastSeen: "2026-09-04T08:00:00Z", count: 1, linearRef: null }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await getRecentSignals({ severity: "error" });
    expect("signals" in r && r.signals[0].title).toBe("t");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://spine/signals?severity=error");
    vi.stubGlobal("fetch", async () => ({ ok: false }));
    expect(await getRecentSignals({})).toEqual({ unavailable: true });
  });

  // A 200 with no `signals` array (e.g. `{}`) must degrade, not crash the page's
  // `r.signals.length` read.
  it("unavailable on a 200 with no signals array", async () => {
    vi.stubEnv("SIGNAL_SPINE_URL", "https://spine"); vi.stubEnv("SIGNAL_READ_TOKEN", "R");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    expect(await getRecentSignals({})).toEqual({ unavailable: true });
  });

  // Any bad row degrades the WHOLE response — never silently drop just that row.
  it("unavailable when one row is malformed", async () => {
    vi.stubEnv("SIGNAL_SPINE_URL", "https://spine"); vi.stubEnv("SIGNAL_READ_TOKEN", "R");
    const goodRow = { fingerprint: "f", occurrence: 1, kind: "alert", severity: "error", state: "open", title: "t", project: "p", source: "s", type: "disk", description: null, url: null, firstSeen: "2026-09-04T08:00:00Z", lastSeen: "2026-09-04T08:00:00Z", count: 1, linearRef: null };
    const badRow = { ...goodRow, severity: "critical" }; // not in the error|warn|info enum
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ signals: [goodRow, badRow] }) })));
    expect(await getRecentSignals({})).toEqual({ unavailable: true });
  });
});

// ── ORB-240: the delivery kill switches ─────────────────────────────────────────────────────
describe("getConsumers", () => {
  it("unavailable without url/token; parses both switches with them", async () => {
    expect(await getConsumers()).toEqual({ unavailable: true });
    vi.stubEnv("SIGNAL_SPINE_URL", "https://spine"); vi.stubEnv("SIGNAL_ADMIN_TOKEN", "A");
    // The url parameter is declared so `mock.calls[0][0]` is typed — same as getRecentSignals above.
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ consumers: [{ name: "slack", enabled: false }, { name: "linear", enabled: true }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getConsumers()).toEqual({ consumers: [{ name: "slack", enabled: false }, { name: "linear", enabled: true }] });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://spine/admin/consumers");
  });

  // Showing one switch and silently dropping the other would let someone believe they had muted
  // something they had not — the one page where a half-rendered answer costs alerts.
  it("unavailable when any row is malformed, not just the good ones", async () => {
    vi.stubEnv("SIGNAL_SPINE_URL", "https://spine"); vi.stubEnv("SIGNAL_ADMIN_TOKEN", "A");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ consumers: [{ name: "slack", enabled: true }, { name: "telegram", enabled: true }] }) })));
    expect(await getConsumers()).toEqual({ unavailable: true });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ consumers: [{ name: "slack", enabled: "off" }] }) })));
    expect(await getConsumers()).toEqual({ unavailable: true });
  });

  it("unavailable on a 200 with no consumers array, and on a non-200", async () => {
    vi.stubEnv("SIGNAL_SPINE_URL", "https://spine"); vi.stubEnv("SIGNAL_ADMIN_TOKEN", "A");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    expect(await getConsumers()).toEqual({ unavailable: true });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    expect(await getConsumers()).toEqual({ unavailable: true });
  });
});
