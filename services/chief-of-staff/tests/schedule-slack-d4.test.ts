import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, it, expect } from "vitest";

/**
 * ORB-149 review round 2, Minor 2 — makes D4 self-defending rather than relying solely on the
 * loud comments at each `gatherOpenObligations` call site
 * (agent/schedules/evening-brief.ts, agent/schedules/reping.ts). D4
 * (docs/superpowers/specs/2026-08-24-orb-149-saga-reads-slack-design.md): Slack obligations
 * reach the morning brief ONLY — proactive delivery stays paused fleet-wide.
 *
 * A STATIC (source-text) check, not a runtime one: `evening-brief.ts` and `reping.ts` have real
 * side effects (Telegram sends, Postgres, Google clients) that a runtime call here would need
 * to fully mock for no extra safety — the property this test actually needs to pin is "this
 * file never imports or references the Slack machinery at all", which text-matching the source
 * proves directly and cheaply. If a future edit ever adds `slack:` to either schedule's
 * `gatherOpenObligations` deps, it will need one of these imports/symbols to build that value,
 * and this test breaks the moment it does — before the schedule ever runs against a real
 * account.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Anything that indicates Slack-obligation-source machinery is in play. */
const SLACK_SOURCE_MARKERS = [
  "slack-source.js",
  "brief-content-slack.js",
  "scanSlackThreads",
  "createSlackSourceDeps",
  "resolveSlackToken",
  "buildSlackObligationSource",
  // ORB-164 — the Slack scan's budget/cancellation wrapper. Newly exported, and exported
  // symbols are exactly how a Slack source would reach another schedule cheaply; the marker
  // list has to grow with the surface or the guard quietly loosens as the module gains API.
  "scanSlackWithBudget",
];

function readSchedule(name: string): string {
  return readFileSync(join(HERE, "..", "agent", "schedules", name), "utf8");
}

describe("ORB-149 D4 — evening-brief and reping never wire a Slack obligation source", () => {
  it("evening-brief.ts references none of the Slack-source machinery", () => {
    const src = readSchedule("evening-brief.ts");
    for (const marker of SLACK_SOURCE_MARKERS) {
      expect(src, `evening-brief.ts unexpectedly references "${marker}" — D4 requires Slack obligations reach the morning brief only`).not.toContain(marker);
    }
  });

  it("reping.ts references none of the Slack-source machinery", () => {
    const src = readSchedule("reping.ts");
    for (const marker of SLACK_SOURCE_MARKERS) {
      expect(src, `reping.ts unexpectedly references "${marker}" — D4 requires Slack obligations reach the morning brief only`).not.toContain(marker);
    }
  });

  it("morning-brief.ts DOES reference the Slack-source machinery — sanity check that the markers above are real, not stale", () => {
    const src = readSchedule("morning-brief.ts");
    expect(src).toContain("scanSlackThreads");
    expect(src).toContain("createSlackSourceDeps");
  });

  // ORB-149 review round 3, Minor — nothing else asserted that the Slack scan stays wrapped in
  // its own sub-timeout; a future edit deleting `withTimeout(...)` around it would keep the
  // rest of the suite green while reintroducing the round-2 CRITICAL (a slow Slack scan riding
  // the shared gather budget to "no brief at all"). Static, same reasoning as the D4 checks
  // above: cheaper and more direct than a runtime timing test for a "this wrapping still
  // exists" property.
  it("morning-brief.ts still wraps the Slack scan in its own withTimeout — the sub-timeout must not be quietly deleted", () => {
    const src = readSchedule("morning-brief.ts");
    // ORB-170 loosened this from `\s*` to also admit comment lines between the two calls —
    // the wrapper gained an explanatory comment; the property guarded (the scan lives
    // INSIDE withTimeout) is unchanged and still what the regex requires.
    // ORB-45 Task 10 (B5): the scan is now `scanSlackThreadsWithOwnActivity` (the same walk,
    // also returning "when did he last write to this person"), so the name matches a prefix.
    expect(src).toMatch(/withTimeout\(\s*(?:\/\/[^\n]*\n\s*)*scanSlackThreads\w*\(/);
    expect(src).toContain("SLACK_SCAN_TIMEOUT_MS");
  });
});
