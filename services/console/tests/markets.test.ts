import { describe, it, expect } from "vitest";
import { formatTimestamp, MARKETS_ENGINE } from "../lib/markets";

describe("MARKETS_ENGINE", () => {
  it("matches the mirrored eve-saga values", () => {
    expect(MARKETS_ENGINE).toEqual({ watchlistMax: 150, watchlistDefault: 100 });
  });
});

describe("formatTimestamp", () => {
  it("renders 'never' for null — the branch both /markets timestamps share when nothing has run yet", () => {
    expect(formatTimestamp(null)).toBe("never");
  });

  it("renders a UTC 'YYYY-MM-DD HH:MM' for a real instant", () => {
    expect(formatTimestamp(new Date("2026-09-08T14:32:07.123Z"))).toBe("2026-09-08 14:32");
  });

  it("truncates seconds rather than rounding", () => {
    expect(formatTimestamp(new Date("2026-01-01T00:00:59.999Z"))).toBe("2026-01-01 00:00");
  });
});
