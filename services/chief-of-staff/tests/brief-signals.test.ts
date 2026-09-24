import { describe, expect, it } from "vitest";
import type { SignalRow } from "@lares/agent-kit/signals-client";
import { buildMorningBrief, signalsBlock, signalsClause, type BriefContent } from "../lib/brief-content.js";
import { buildMorningPrompt } from "../agent/schedules/morning-brief.js";

function signal(severity: SignalRow["severity"], n: number, overrides: Partial<SignalRow> = {}): SignalRow {
  return { fingerprint: `s-${n}`, occurrence: 1, kind: "alert", severity, state: "open", title: `Signal ${n}`,
    project: "orakel", source: "inngest", type: "job", description: null, url: null,
    firstSeen: "2026-09-16T06:00:00Z", lastSeen: `2026-09-16T07:0${n}:00Z`, count: 1, linearRef: null, ...overrides };
}

describe("Signals since last brief", () => {
  it("renders every error, a warning count, and only the top three warnings", () => {
    const rows = [signal("error", 1), signal("error", 2), ...[3, 4, 5, 6].map((n) => signal("warn", n))];
    const block = signalsBlock(rows);
    expect(block).toContain("## Signals since last brief");
    expect(block).toContain("Signal 1"); expect(block).toContain("Signal 2");
    expect(block).toContain("4 warnings since last brief");
    expect(block).toContain("Signal 3"); expect(block).toContain("Signal 5"); expect(block).not.toContain("Signal 6");
  });

  it("drops the block and clause entirely when empty", () => {
    expect(signalsBlock([])).toBe(""); expect(signalsClause([])).toEqual([]);
    const prompt = buildMorningPrompt({ meetings: [], obligations: [], picks: [] });
    expect(prompt).not.toContain("Signals since last brief");
  });

  it("makes errors alone sufficient reason for a morning brief", () => {
    const result = buildMorningBrief({ meetings: [], obligations: [], deliveredLastNight: new Set(), picks: [], signals: [signal("error", 1)] });
    expect(result?.signals).toHaveLength(1);
    expect(buildMorningPrompt(result as BriefContent)).toContain("Signals since last brief");
  });
});
