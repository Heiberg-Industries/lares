import { describe, it, expect } from "vitest";
import { STATE_COLOURS } from "../lib/state-colours";

describe("StatePill vocabulary", () => {
  // "done" is job vocabulary. A credential is not "done" — it is live. This only checks the
  // vocabulary data itself — that credential states own their own labels, distinct from the
  // job-status words. It does NOT prove ConnectionsTable renders them untranslated; that
  // render-path guarantee (the live→done mislabel this task fixed) is covered by
  // tests/connections-table.test.tsx, which renders the real table.
  it("gives credential statuses their own labels, never job vocabulary", () => {
    expect(STATE_COLOURS["live"]).toEqual({ c: "var(--ok)", label: "live" });
    expect(STATE_COLOURS["partial"]).toEqual({ c: "var(--warn)", label: "partial" });
    expect(STATE_COLOURS["missing"]).toEqual({ c: "var(--bad)", label: "missing" });
  });

  // The console does not mount host secrets, so it cannot tell a healthy host-custody
  // credential from a broken one. It must stay grey with its raw label rather than borrow
  // "never" (a deliberate revoke on the autonomy dial) or any other word.
  it("leaves unknown unmapped so the grey fallback renders it", () => {
    expect(STATE_COLOURS["unknown"]).toBeUndefined();
  });

  it("carries the CRM sync states with the colours the spec assigns", () => {
    expect(STATE_COLOURS["paused"]!.c).toBe("var(--bad)");
    expect(STATE_COLOURS["token expired"]!.c).toBe("var(--bad)");
    expect(STATE_COLOURS["failing"]!.c).toBe("var(--bad)");
    expect(STATE_COLOURS["throttled"]!.c).toBe("var(--warn)");
    expect(STATE_COLOURS["not yet synced"]!.c).toBe("var(--warn)");
    expect(STATE_COLOURS["syncing"]!.c).toBe("var(--ok)");
  });

  it("labels every mapped state with its own name", () => {
    for (const [state, m] of Object.entries(STATE_COLOURS)) expect(m.label).toBe(state);
  });
});
