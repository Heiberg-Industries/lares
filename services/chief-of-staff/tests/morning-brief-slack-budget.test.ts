import { describe, it, expect, vi, afterEach } from "vitest";

import type { SlackSourceDeps, SlackScanOptions } from "../lib/brief-content-slack.js";
import type { ThreadMessage } from "../lib/google.js";
import type { GatherObligationsDeps } from "../lib/obligation-pipeline.js";
import { buildMorningBrief } from "../lib/brief-content.js";
import { gatherOpenObligations } from "../lib/obligation-pipeline.js";
import {
  SLACK_DROPPED_SOURCE_LINE,
  buildMorningPrompt,
  newSlackScanStatus,
  scanSlackWithBudget,
} from "../agent/schedules/morning-brief.js";

/**
 * ORB-164 — the Slack obligation scan's budget, its cancellation, and the brief's refusal to
 * hide a dropped source.
 *
 * MEASURED, not guessed (this is the ticket's whole point): three consecutive runs of the real
 * scan inside `agent-box-eve-saga-1` on 2026-08-25, at the live `SLACK_MAX_CONVERSATIONS` of
 * 40, took 8671 / 8405 / 8343 ms — reliably ~5% OVER the 8000 ms budget shipped with ORB-149,
 * which is why the first real morning fell back to Gmail-only. The tests here use tiny
 * millisecond budgets because the BEHAVIOUR (bound, cancel, disclose) is what they pin; the
 * production number lives in `SLACK_SCAN_TIMEOUT_MS` with the measurement in its docblock.
 */

const NOW = new Date("2026-08-25T06:00:00Z");
const OWN = "U_BENDIK";

const SCAN_OPTS: SlackScanOptions = { ownUserId: OWN, now: () => NOW, maxConversations: 40 };

afterEach(() => {
  vi.restoreAllMocks();
});

/** Silences (and captures) the scan's own duration/failure logging. */
function quietLogs(): void {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

/** A reader whose `readConversation` never settles on its own — it settles only when the
 *  AbortSignal it was handed fires, which is exactly the observation requirement 3 needs. */
function hangingReader(): {
  makeDeps: (signal: AbortSignal) => SlackSourceDeps;
  signals: AbortSignal[];
  abortsObserved: () => number;
} {
  const signals: AbortSignal[] = [];
  const makeDeps = (signal: AbortSignal): SlackSourceDeps => {
    signals.push(signal);
    return {
      listConversations: async () => [{ id: "D1", kind: "im", counterpartyUserId: "U_THEM" }],
      readConversation: () =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("slack read aborted")));
        }),
      getUserInfo: async () => null,
    };
  };
  return { makeDeps, signals, abortsObserved: () => signals.filter((s) => s.aborted).length };
}

/** An hour before NOW — comfortably inside `scanSlackThreads`'s 60-day window, which silently
 *  filters anything older and would otherwise make this reader look like it returned nothing. */
const RECENT_TS = `${Math.floor(NOW.getTime() / 1000) - 3600}.000000`;

/** A reader that answers instantly with one unanswered DM from them. */
function fastReader(): (signal: AbortSignal) => SlackSourceDeps {
  return (signal: AbortSignal): SlackSourceDeps => {
    void signal;
    return {
      listConversations: async () => [{ id: "D1", kind: "im", counterpartyUserId: "U_THEM" }],
      readConversation: async () => [
        { ts: RECENT_TS, userId: "U_THEM", isBot: false, threadTs: RECENT_TS, mentionsOwner: false },
      ],
      getUserInfo: async () => ({ id: "U_THEM", email: "them@partner.example", displayName: "Them" }),
    };
  };
}

function threadMessage(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "m-1",
    threadId: "t-1",
    from: "Lars Eriksen <lars@partner.example>",
    to: ["Bendik <owner@owner.example>"],
    subject: "Re: pilot terms",
    bodyText: "body",
    sentAt: "2026-08-01T09:00:00Z",
    messageId: "<m1@partner.example>",
    references: "",
    isCalendarNotice: false,
    headers: {},
    ...overrides,
  };
}

describe("scanSlackWithBudget — the scan is bounded AND cancelled", () => {
  it("a scan that outruns its budget rejects with the labeled timeout and marks the status failed", async () => {
    quietLogs();
    const { makeDeps } = hangingReader();
    const status = newSlackScanStatus();

    await expect(scanSlackWithBudget(makeDeps, SCAN_OPTS, status, 25)).rejects.toThrow(
      /morning-brief: slack scan timed out after 25ms/,
    );
    expect(status.failed).toBe(true);
  });

  it("ORB-164 requirement 3 — the ABORT IS OBSERVED BY THE SCAN: the timeout cancels the read instead of leaving it running", async () => {
    quietLogs();
    const { makeDeps, signals, abortsObserved } = hangingReader();
    const status = newSlackScanStatus();

    await expect(scanSlackWithBudget(makeDeps, SCAN_OPTS, status, 25)).rejects.toThrow(/timed out/);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(abortsObserved()).toBe(1);
  });

  it("a scan inside its budget returns its snapshots, leaves the status clean, and never aborts the reader", async () => {
    quietLogs();
    let handed: AbortSignal | undefined;
    const makeDeps = (signal: AbortSignal): SlackSourceDeps => {
      handed = signal;
      return fastReader()(signal);
    };
    const status = newSlackScanStatus();

    const snapshots = await scanSlackWithBudget(makeDeps, SCAN_OPTS, status, 5_000);

    expect(snapshots).toHaveLength(1);
    expect(status.failed).toBe(false);
    expect(handed!.aborted).toBe(false);
  });

  /**
   * FIX ROUND 1, finding 1 — an earlier version of this test PRESET
   * `status.conversationsScanned = 40` and then asserted the log said 40, which proved only that
   * a number can be interpolated into a string. The count is now driven all the way through the
   * production path: three conversations offered, three `readConversation` calls made, three
   * reported. Drop the `countingDeps` wrapping inside `scanSlackWithBudget` and this fails,
   * which is the whole point — the instrument that tells tomorrow's acceptance log "40
   * conversations" must itself be instrumented, or a silently-degraded zero looks like a real
   * one all over again.
   */
  it("logs the measured duration and the conversations it ACTUALLY read — counted through the real path, never preset", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const status = newSlackScanStatus();
    let readCalls = 0;
    const makeDeps = (): SlackSourceDeps => ({
      listConversations: async () => [
        { id: "D1", kind: "im", counterpartyUserId: "U_A" },
        { id: "D2", kind: "im", counterpartyUserId: "U_B" },
        { id: "D3", kind: "im", counterpartyUserId: "U_C" },
      ],
      readConversation: async () => {
        readCalls++;
        return [{ ts: RECENT_TS, userId: "U_THEM", isBot: false, threadTs: RECENT_TS, mentionsOwner: false }];
      },
      getUserInfo: async () => null,
    });

    await scanSlackWithBudget(makeDeps, SCAN_OPTS, status, 5_000);

    expect(readCalls).toBe(3);
    expect(status.conversationsScanned).toBe(3);
    expect(logs.join("\n")).toMatch(/morning-brief: slack scan — \d+ms, 3 conversation\(s\) scanned/);
  });

  it("counts what the reader was ASKED for, not what the cap allows — a workspace under the cap must not report the cap", async () => {
    quietLogs();
    const status = newSlackScanStatus();

    await scanSlackWithBudget(fastReader(), SCAN_OPTS, status, 5_000);

    expect(status.conversationsScanned).toBe(1);
    expect(status.conversationsScanned).not.toBe(SCAN_OPTS.maxConversations);
  });
});

describe("the morning brief names a dropped Slack source", () => {
  /** Gmail half: one thread, last message from them, comfortably past the 48h gate. */
  function gmailOnlyDeps(slack: GatherObligationsDeps["slack"]): GatherObligationsDeps {
    return {
      myAddresses: async () => ["owner@owner.example"],
      gmail: {
        searchThreadIds: async () => ["t-1"],
        readThread: async () => [threadMessage()],
      },
      dismissed: async () => new Set(),
      upsertSeen: async () => {},
      slack,
    };
  }

  it("a Slack source that exceeds the budget → the prompt carries the dropped-source line AND the Gmail obligations", async () => {
    quietLogs();
    const { makeDeps } = hangingReader();
    const status = newSlackScanStatus();

    const obligations = await gatherOpenObligations(
      gmailOnlyDeps(() => scanSlackWithBudget(makeDeps, SCAN_OPTS, status, 25)),
      NOW,
    );
    const content = buildMorningBrief({
      meetings: [],
      obligations,
      deliveredLastNight: new Set(),
      picks: [],
      slackUnavailable: status.failed,
    });

    expect(content).not.toBeNull();
    const prompt = buildMorningPrompt(content!);
    expect(prompt).toContain(SLACK_DROPPED_SOURCE_LINE);
    // The Gmail half survived the Slack failure — the whole point of the best-effort catch.
    expect(prompt).toContain("Lars Eriksen");
  });

  it("a Slack source within its budget → NO dropped-source line", async () => {
    quietLogs();
    const status = newSlackScanStatus();

    const obligations = await gatherOpenObligations(
      gmailOnlyDeps(() => scanSlackWithBudget(fastReader(), SCAN_OPTS, status, 5_000)),
      NOW,
    );
    const content = buildMorningBrief({
      meetings: [],
      obligations,
      deliveredLastNight: new Set(),
      picks: [],
      slackUnavailable: status.failed,
    });

    expect(content).not.toBeNull();
    const prompt = buildMorningPrompt(content!);
    expect(prompt).not.toContain(SLACK_DROPPED_SOURCE_LINE);
    expect(prompt).toContain("Lars Eriksen");
  });

  it("absent ≠ empty: a dropped Slack source alone still produces a brief — silence would claim a completeness the gather never had", () => {
    const content = buildMorningBrief({
      meetings: [],
      obligations: [],
      deliveredLastNight: new Set(),
      picks: [],
      slackUnavailable: true,
    });

    expect(content).not.toBeNull();
    const prompt = buildMorningPrompt(content!);
    expect(prompt).toContain(SLACK_DROPPED_SOURCE_LINE);
    // FIX ROUND 1, finding 3 — and the list above it must NOT claim a bare "(none)". "none" is a
    // factual claim (ContextBlock's own docblock, @lares/compose-contract) and a source that
    // never answered has not earned it: "none" is true of Gmail and unknown of Slack.
    expect(prompt).toContain("New or changed since last night's evening pass — owed a reply:\n(none from Gmail)");
    expect(prompt).not.toContain("owed a reply:\n(none)\n");
  });

  it("an ordinary empty morning is still silent — the dropped-source path must not turn every quiet day into a message", () => {
    expect(
      buildMorningBrief({
        meetings: [],
        obligations: [],
        deliveredLastNight: new Set(),
        picks: [],
        slackUnavailable: false,
      }),
    ).toBeNull();
  });
});
