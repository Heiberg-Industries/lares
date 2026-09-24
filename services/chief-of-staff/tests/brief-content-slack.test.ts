import { describe, it, expect } from "vitest";

import { selectObligations, assignSurfaces } from "../lib/brief-content.js";
import {
  scanSlackThreads,
  scanSlackThreadsWithOwnActivity,
  isScanAborted,
  SlackScanAbortedError,
  DEFAULT_SLACK_WINDOW_DAYS,
  type SlackSourceDeps,
  type SlackConversationRef,
  type SlackThreadMessage,
  type SlackUserIdentity,
} from "../lib/brief-content-slack.js";

/**
 * Task 3 (ORB-149) — a Slack `ThreadSnapshot` source alongside the Gmail one in
 * ../lib/brief-content.ts. Round 2 (fix round): covers the review's six Important findings —
 * (1) the scan window, (2) required relevance flags, (3) DM thread-id scoping /
 * "reopen on new activity", (4) the structural no-interrupt guarantee for Slack (D4), (5)
 * ownUserId validation, (6) subtype/Slackbot filtering — on top of round 1's original contract:
 *   - an unanswered DM past OWED_AFTER_HOURS surfaces as an obligation
 *   - one Bendik answered does not
 *   - an @mention he has not answered surfaces
 *   - an ordinary channel broadcast he is not addressed in does NOT surface
 *   - a thread he has participated in counts
 *   - the scan bound (maxConversations) is honoured
 *
 * Fixtures use a FIXED injected clock (`NOW`) — eve injects no ambient date, and every computed
 * date without one is a guess (see MEMORY: "eve agents need an injected clock").
 */

const OWN = "U_BENDIK";
const NOW = new Date("2026-08-24T08:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function slackTs(date: Date): string {
  return `${Math.floor(date.getTime() / 1000)}.000000`;
}

/** Slack ts for `hoursAgo` hours before NOW, as Slack's own "<unix_seconds>.<fraction>" string. */
function tsHoursAgo(hoursAgo: number): string {
  return slackTs(new Date(NOW.getTime() - hoursAgo * HOUR));
}

function msg(overrides: Partial<SlackThreadMessage> = {}): SlackThreadMessage {
  const ts = overrides.ts ?? slackTs(NOW);
  return {
    ts,
    userId: "U_OTHER",
    threadTs: ts, // own-ts-as-root default — matches "a message that started no thread carries its own ts"
    mentionsOwner: false,
    ...overrides,
  };
}

function fakeDeps(
  overrides: Partial<SlackSourceDeps> & { conversations: SlackConversationRef[]; messagesByConvo: Record<string, SlackThreadMessage[]> },
): SlackSourceDeps & { readConversationCalls: { id: string; oldest: string | undefined; ceiling: number }[] } {
  const readConversationCalls: { id: string; oldest: string | undefined; ceiling: number }[] = [];
  const identities: Record<string, SlackUserIdentity> = {
    U_OTHER: { id: "U_OTHER", displayName: "Lars Eriksen", email: "lars@partner.example" },
    U_SECOND: { id: "U_SECOND", displayName: "Kari Nilsen", email: "kari@example.com" },
  };
  return {
    readConversationCalls,
    listConversations: async () => overrides.conversations,
    readConversation: async (id, oldest, ceiling) => {
      readConversationCalls.push({ id, oldest, ceiling });
      return overrides.messagesByConvo[id] ?? [];
    },
    getUserInfo: async (userId) => identities[userId] ?? { id: userId, displayName: null, email: null },
    ...overrides,
  };
}

describe("scanSlackThreads — DMs", () => {
  it("an unanswered DM past the window surfaces as an obligation", async () => {
    const ts = tsHoursAgo(50);
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts })] },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      threadId: `slack:im:D1:${ts}`,
      counterpartyAddress: "lars@partner.example",
      counterpartyName: "Lars Eriksen",
      lastSpeakerIsThem: true,
      addressedToHim: true,
      isAutomated: false,
      theirUnansweredCount: 1,
    });

    const obligations = selectObligations(snapshots, NOW);
    expect(obligations).toHaveLength(1);
    expect(obligations[0]!.threadId).toBe(`slack:im:D1:${ts}`);
  });

  // ─── ORB-45 Task 10 (B1): lastMessageText / counterpartySlackUserId / source in flight ────

  it("carries the last message's text and the counterparty's Slack user id in flight", async () => {
    const ts = tsHoursAgo(50);
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts, text: "hei" })] },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots[0]!.lastMessageText).toBe("hei");
    expect(snapshots[0]!.counterpartySlackUserId).toBe("U_OTHER");
    expect(snapshots[0]!.source).toBe("slack");
    expect(snapshots[0]!.counterpartyEmails).toEqual(["lars@partner.example"]);
  });

  it("one Bendik answered does not surface", async () => {
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: {
        D1: [
          msg({ userId: "U_OTHER", ts: tsHoursAgo(50) }),
          msg({ userId: OWN, ts: tsHoursAgo(49) }),
        ],
      },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots[0]).toMatchObject({ lastSpeakerIsThem: false, theirUnansweredCount: 0 });

    const obligations = selectObligations(snapshots, NOW);
    expect(obligations).toEqual([]);
  });

  it("a DM younger than OWED_AFTER_HOURS (48h) does not yet surface", async () => {
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts: tsHoursAgo(10) })] },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(selectObligations(snapshots, NOW)).toEqual([]);
  });

  it("resolves the counterparty by email — the join key onto the graph (D3)", async () => {
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts: tsHoursAgo(50) })] },
    });
    const [snap] = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snap!.counterpartyAddress).toBe("lars@partner.example");
  });

  it("falls back to a slack:<id> address (never a bare id masquerading as an email) when Slack has none on file", async () => {
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_NOEMAIL" }],
      messagesByConvo: { D1: [msg({ userId: "U_NOEMAIL", ts: tsHoursAgo(50) })] },
      getUserInfo: async (id) => ({ id, displayName: "Guest", email: null }),
    });
    const [snap] = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snap!.counterpartyAddress).toBe("slack:U_NOEMAIL");
  });

  // ── Important 6, round 3 — allowlist direction: me_message stays a real message ────────────

  it("a /me message from Bendik still counts as his reply — me_message is a real message, not a system event", async () => {
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: {
        D1: [
          msg({ userId: "U_OTHER", ts: tsHoursAgo(50) }),
          // Bendik replies with a `/me` — Slack tags this `subtype: "me_message"`. If it were
          // wrongly dropped (round 2's denylist bug), U_OTHER's earlier message would become
          // "last" again and this conversation would falsely surface as still-unanswered.
          msg({ userId: OWN, ts: tsHoursAgo(49), subtype: "me_message" }),
        ],
      },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots[0]).toMatchObject({ lastSpeakerIsThem: false, theirUnansweredCount: 0 });
    expect(selectObligations(snapshots, NOW)).toEqual([]);
  });
});

describe("scanSlackThreads — channels", () => {
  it("an @mention he has not answered surfaces", async () => {
    const root = tsHoursAgo(50);
    const deps = fakeDeps({
      conversations: [{ id: "C1", kind: "channel" }],
      messagesByConvo: {
        C1: [msg({ userId: "U_OTHER", ts: root, threadTs: root, mentionsOwner: true })],
      },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ addressedToHim: true, lastSpeakerIsThem: true, theirUnansweredCount: 1 });
    // Pins the `slack:channel:…` id form — `slack:im:` (line 96) and `slack:mpim:` (below) were
    // already pinned; this was the one namespaced form review round left unpinned by any test.
    expect(snapshots[0]!.threadId).toBe(`slack:channel:C1:${root}`);
    expect(selectObligations(snapshots, NOW)).toHaveLength(1);
  });

  it("an ordinary channel broadcast he is not addressed in does NOT surface", async () => {
    const root = tsHoursAgo(50);
    const deps = fakeDeps({
      conversations: [{ id: "C1", kind: "channel" }],
      messagesByConvo: {
        C1: [
          msg({ userId: "U_OTHER", ts: root, threadTs: root, mentionsOwner: false }),
          msg({ userId: "U_SECOND", ts: tsHoursAgo(1), threadTs: root, mentionsOwner: false }),
        ],
      },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots).toEqual([]);
  });

  it("a thread he has participated in counts, even without a fresh mention", async () => {
    const root = tsHoursAgo(60);
    const deps = fakeDeps({
      conversations: [{ id: "C1", kind: "channel" }],
      messagesByConvo: {
        C1: [
          msg({ userId: "U_OTHER", ts: root, threadTs: root, mentionsOwner: true }),
          msg({ userId: OWN, ts: tsHoursAgo(55), threadTs: root }),
          // A later reply, no fresh mention — still counts because Bendik already joined this thread.
          msg({ userId: "U_OTHER", ts: tsHoursAgo(50), threadTs: root, mentionsOwner: false }),
        ],
      },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ lastSpeakerIsThem: true, theirUnansweredCount: 1 });
    expect(selectObligations(snapshots, NOW)).toHaveLength(1);
  });

  it("a thread where HE spoke last is not an obligation, even though he participated", async () => {
    const root = tsHoursAgo(60);
    const deps = fakeDeps({
      conversations: [{ id: "C1", kind: "channel" }],
      messagesByConvo: {
        C1: [
          msg({ userId: "U_OTHER", ts: root, threadTs: root, mentionsOwner: true }),
          msg({ userId: OWN, ts: tsHoursAgo(50), threadTs: root }),
        ],
      },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots[0]).toMatchObject({ lastSpeakerIsThem: false, theirUnansweredCount: 0 });
    expect(selectObligations(snapshots, NOW)).toEqual([]);
  });

  it("bot messages (isBot) are dropped before counting", async () => {
    const root = tsHoursAgo(50);
    const deps = fakeDeps({
      conversations: [{ id: "C1", kind: "channel" }],
      messagesByConvo: {
        C1: [
          msg({ userId: "U_OTHER", ts: root, threadTs: root, mentionsOwner: true }),
          msg({ userId: "U_BOT", ts: tsHoursAgo(1), threadTs: root, isBot: true }),
        ],
      },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.lastMessageAt).toEqual(new Date(parseFloat(root) * 1000));
  });

  it("a message with no userId (a system event a reader failed to filter) is dropped before counting", async () => {
    const root = tsHoursAgo(50);
    const deps = fakeDeps({
      conversations: [{ id: "C1", kind: "channel" }],
      messagesByConvo: {
        C1: [
          msg({ userId: "U_OTHER", ts: root, threadTs: root, mentionsOwner: true }),
          msg({ userId: undefined, ts: tsHoursAgo(0.5), threadTs: root }),
        ],
      },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.lastMessageAt).toEqual(new Date(parseFloat(root) * 1000));
  });

  // ── Important 6 — subtype/Slackbot filtering ──────────────────────────────────────────────

  it("a channel_join system message (real userId, no isBot) is dropped, not treated as a reply", async () => {
    const root = tsHoursAgo(50);
    const deps = fakeDeps({
      conversations: [{ id: "C1", kind: "channel" }],
      messagesByConvo: {
        C1: [
          msg({ userId: "U_OTHER", ts: root, threadTs: root, mentionsOwner: true }),
          // A join notice AFTER the mention, authored by Bendik himself (as Slack really emits
          // these — the acting user), with a real userId and no isBot: without subtype-based
          // filtering this would be misread as "Bendik replied", hiding a genuine obligation.
          msg({ userId: OWN, ts: tsHoursAgo(1), threadTs: root, subtype: "channel_join" }),
        ],
      },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ lastSpeakerIsThem: true, theirUnansweredCount: 1 });
    expect(snapshots[0]!.lastMessageAt).toEqual(new Date(parseFloat(root) * 1000));
  });

  it("a Slackbot DM never becomes a permanent obligation, even if the reader forgot to mark it isBot", async () => {
    const deps = fakeDeps({
      conversations: [{ id: "D_SLACKBOT", kind: "im", counterpartyUserId: "USLACKBOT" }],
      messagesByConvo: {
        D_SLACKBOT: [msg({ userId: "USLACKBOT", ts: tsHoursAgo(9000), threadTs: tsHoursAgo(9000) })], // isBot NOT set
      },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW, windowDays: 99999 });
    expect(snapshots).toEqual([]);
  });

  // ── Important 6, round 3 — allowlist direction: fail CLOSED on an unrecognized subtype ──────

  it("an unknown/future subtype (not on the allowlist) is dropped, failing closed", async () => {
    const root = tsHoursAgo(50);
    const deps = fakeDeps({
      conversations: [{ id: "C1", kind: "channel" }],
      messagesByConvo: {
        C1: [
          msg({ userId: "U_OTHER", ts: root, threadTs: root, mentionsOwner: true }),
          // A subtype this file has never heard of — Slack could add this tomorrow. The
          // allowlist must drop it (fail closed), not silently treat it as a real reply.
          msg({ userId: "U_SECOND", ts: tsHoursAgo(1), threadTs: root, subtype: "tombstone" }),
        ],
      },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots).toHaveLength(1);
    // The unknown-subtype message never counted — the mention from U_OTHER is still "last".
    expect(snapshots[0]!.lastMessageAt).toEqual(new Date(parseFloat(root) * 1000));
    expect(snapshots[0]!.theirUnansweredCount).toBe(1);
  });
});

describe("scanSlackThreads — mpim (group DM)", () => {
  it("credits the obligation to whoever spoke last, when unanswered", async () => {
    const ts = tsHoursAgo(50);
    const deps = fakeDeps({
      conversations: [{ id: "G1", kind: "mpim" }],
      messagesByConvo: { G1: [msg({ userId: "U_OTHER", ts })] },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ threadId: `slack:mpim:G1:${ts}`, counterpartyAddress: "lars@partner.example" });
    expect(selectObligations(snapshots, NOW)).toHaveLength(1);
  });
});

// ─── Important 1 — the scan window ─────────────────────────────────────────────────────────

describe("scanSlackThreads — scan window", () => {
  it("passes an `oldest` derived from the injected clock and windowDays to readConversation", async () => {
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts: tsHoursAgo(50) })] },
    });
    await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW, windowDays: 60 });
    expect(deps.readConversationCalls).toHaveLength(1);
    const expectedOldest = slackTs(new Date(NOW.getTime() - 60 * DAY));
    expect(deps.readConversationCalls[0]!.oldest).toBe(expectedOldest);
  });

  it("defaults the window to DEFAULT_SLACK_WINDOW_DAYS when windowDays is omitted", async () => {
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts: tsHoursAgo(50) })] },
    });
    // No windowDays passed — proves the DEFAULT is actually applied, not just that the constant
    // equals a literal (ORB-149 T3 review round 3: the old version of this test asserted
    // `DEFAULT_SLACK_WINDOW_DAYS === 60` directly, which would still pass even if the default
    // were never wired into scanSlackThreads at all).
    await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    const expectedOldest = slackTs(new Date(NOW.getTime() - DEFAULT_SLACK_WINDOW_DAYS * DAY));
    expect(deps.readConversationCalls[0]!.oldest).toBe(expectedOldest);
  });

  it("drops a message older than the window even if the reader hands it back anyway (defense-in-depth)", async () => {
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      // Three years old — well outside any real window. Without the window filter this would
      // rank as the MOST overdue obligation (selectObligations sorts most-overdue-first) and
      // land at the top of the morning brief on day one.
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts: tsHoursAgo(3 * 365 * 24) })] },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW, windowDays: 60 });
    expect(snapshots).toEqual([]);
  });
});

// ─── Important 3 — DM thread-id scoping / reopen-on-new-activity ──────────────────────────

describe("scanSlackThreads — DM thread-id scoping (Important 3)", () => {
  it("a NEW message produces a DIFFERENT threadId than the previous scan — dismissal can't blind future messages", async () => {
    const firstTs = tsHoursAgo(50);
    const deps1 = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts: firstTs })] },
    });
    const [firstSnap] = await scanSlackThreads(deps1, { ownUserId: OWN, now: () => NOW });

    // A later tick: the SAME conversation, but a NEW unanswered message arrived.
    const secondTs = tsHoursAgo(10);
    const later = new Date(NOW.getTime() + 40 * HOUR);
    const deps2 = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts: firstTs }), msg({ userId: "U_OTHER", ts: secondTs })] },
    });
    const [secondSnap] = await scanSlackThreads(deps2, { ownUserId: OWN, now: () => later });

    expect(firstSnap!.threadId).not.toBe(secondSnap!.threadId);
  });
});

// ─── Important 4 — D4: Slack must NEVER reach the interrupt/re-ping surface ────────────────

describe("scanSlackThreads — D4 no-interrupt guarantee (Important 4)", () => {
  it("a same-person double-bump in a DM is capped to theirUnansweredCount:1 — isRePing never becomes true", async () => {
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: {
        D1: [
          msg({ userId: "U_OTHER", ts: tsHoursAgo(30) }),
          msg({ userId: "U_OTHER", ts: tsHoursAgo(20) }), // same person, second unanswered message
        ],
      },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots[0]!.theirUnansweredCount).toBe(1);

    // Uncapped, this thread would be a re-ping (theirUnansweredCount 2 >= 2) and qualify at the
    // faster 24h REPING_AFTER_HOURS gate, then route to assignSurfaces' `interrupt` bucket. The
    // cap forces the standard 48h OWED_AFTER_HOURS gate instead, and isRePing stays false.
    const laterNow = new Date(NOW.getTime() + 30 * HOUR); // last message now 50h old — past OWED_AFTER_HOURS
    const obligations = selectObligations(snapshots, laterNow);
    expect(obligations).toHaveLength(1);
    // Pins the `>= 2` threshold this whole guarantee rests on — the more likely thing to drift.
    expect(obligations[0]!.isRePing).toBe(false);
    // The guarantee the ruling actually asked for (ORB-149 T3 review round 3): `isRePing` is
    // only equivalent to "never interrupts" because it's CURRENTLY the sole gate into
    // `interrupt` (assignSurfaces, brief-content.ts:224). Asserting on `interrupt` directly means
    // this test still catches a regression the day someone adds a second route into it (an age
    // threshold, an escalation rule) — the `isRePing` assertion above would stay green and this
    // one would fire.
    expect(assignSurfaces(obligations, new Set(), new Map()).interrupt).toEqual([]);
  });

  it("two different colleagues each posting once in a channel thread is NOT double-counted as a re-ping", async () => {
    const root = tsHoursAgo(60);
    const deps = fakeDeps({
      conversations: [{ id: "C1", kind: "channel" }],
      messagesByConvo: {
        C1: [
          msg({ userId: "U_OTHER", ts: root, threadTs: root, mentionsOwner: true }),
          // A DIFFERENT person posts next, no fresh mention needed — Bendik never joined, but
          // the first message's mention already made this thread a candidate.
          msg({ userId: "U_SECOND", ts: tsHoursAgo(50), threadTs: root, mentionsOwner: false }),
        ],
      },
    });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots).toHaveLength(1);
    // The false re-ping the old "any non-owner author" counting would have produced (2, from two
    // DIFFERENT people) — the correct same-last-speaker count is 1 (Kari alone spoke once).
    expect(snapshots[0]!.theirUnansweredCount).toBe(1);
    const obligations = selectObligations(snapshots, NOW);
    expect(obligations[0]!.isRePing).toBe(false);
  });
});

// ─── Important 5 — ownUserId validation ────────────────────────────────────────────────────

describe("scanSlackThreads — ownUserId validation (Important 5)", () => {
  it("throws when ownUserId is empty — never lets every conversation read as unanswered", async () => {
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts: tsHoursAgo(50) })] },
    });
    await expect(scanSlackThreads(deps, { ownUserId: "", now: () => NOW })).rejects.toThrow(/ownUserId/);
  });
});

describe("scanSlackThreads — scan bound", () => {
  it("honours maxConversations — never reads more conversations than the bound", async () => {
    const conversations: SlackConversationRef[] = Array.from({ length: 10 }, (_, i) => ({
      id: `C${i}`,
      kind: "im" as const,
      counterpartyUserId: "U_OTHER",
    }));
    const messagesByConvo: Record<string, SlackThreadMessage[]> = {};
    for (const c of conversations) messagesByConvo[c.id] = [msg({ userId: "U_OTHER", ts: tsHoursAgo(50) })];

    const deps = fakeDeps({ conversations, messagesByConvo });
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW, maxConversations: 3 });

    expect(deps.readConversationCalls).toHaveLength(3);
    expect(snapshots).toHaveLength(3);
  });

  it("honours maxMessagesPerConversation by passing it through as the ceiling", async () => {
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts: tsHoursAgo(50) })] },
    });
    await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW, maxMessagesPerConversation: 42 });
    expect(deps.readConversationCalls[0]!.ceiling).toBe(42);
  });
});

/**
 * ORB-164 fix round 1, finding 4 — `resolveIdentity` swallows every `getUserInfo` failure by
 * design (an obligation must never be lost over an identity hiccup), and it was swallowing the
 * scan's own CANCELLATION too. That printed "getUserInfo failed … degrading to a Slack-id-only
 * identity" into exactly the log window this ticket names as its acceptance evidence, and let a
 * scan whose budget was already spent carry on walking conversations. Cancellation is not a
 * degradation; it must read, and behave, like cancellation.
 */
describe("scanSlackThreads — cancellation is not a degradation", () => {
  it("an aborted getUserInfo propagates instead of degrading to a Slack-id identity", async () => {
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts: tsHoursAgo(50) })] },
      getUserInfo: async () => {
        throw new SlackScanAbortedError("morning-brief: slack scan cancelled after 20000ms");
      },
    });

    await expect(scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW })).rejects.toBeInstanceOf(
      SlackScanAbortedError,
    );
  });

  it("the platform's own AbortError propagates too — a bare abort() has no custom reason to match on", async () => {
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts: tsHoursAgo(50) })] },
      getUserInfo: async () => {
        throw abortError;
      },
    });

    await expect(scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW })).rejects.toThrow(abortError);
  });

  it("an ORDINARY getUserInfo failure still degrades rather than losing the obligation — the pre-existing rule is untouched", async () => {
    const errors: unknown[][] = [];
    const spy = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const ts = tsHoursAgo(50);
      const deps = fakeDeps({
        conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
        messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts })] },
        getUserInfo: async () => {
          throw new Error("missing_scope");
        },
      });

      const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.counterpartyAddress).toBe("slack:U_OTHER");
      expect(errors).toHaveLength(1);
    } finally {
      console.error = spy;
    }
  });
});

describe("isScanAborted", () => {
  it("matches the scan's own abort reason and the platform AbortError, and nothing else", () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    expect(isScanAborted(new SlackScanAbortedError("cancelled"))).toBe(true);
    expect(isScanAborted(abortError)).toBe(true);
    expect(isScanAborted(new Error("missing_scope"))).toBe(false);
    expect(isScanAborted("aborted")).toBe(false);
    expect(isScanAborted(undefined)).toBe(false);
  });

  it("keeps the original failure as `cause` — wrapping the timeout must not lose it", () => {
    const cause = new Error("morning-brief: slack scan timed out after 20000ms");
    expect(new SlackScanAbortedError("cancelled", { cause }).cause).toBe(cause);
  });
});

// ─── ORB-170 — the cap reaches both partitions, concurrently, with backoff ─────────────────
//
// The defect: `listConversations` partitions DMs ahead of channels (deliberate, review round
// 3), and the scan sliced `slice(0, maxConversations)`. On the real workspace — exactly 40
// DMs and 44 channels at a cap of 40 — the slice was the 40 DMs, and no channel was EVER
// scanned; not deferred, never (this file's own corrected comment admits there is no cursor).
// The ticket's lever: partition-aware selection + bounded concurrency + rate-limit backoff.

import { selectScanSet, DEFAULT_SLACK_SCAN_CONCURRENCY } from "../lib/brief-content-slack.js";
import { SlackRateLimitError } from "@lares/network/lib/importers/slack.js";

function convoSet(dms: number, channels: number): SlackConversationRef[] {
  const out: SlackConversationRef[] = [];
  for (let i = 0; i < dms; i++) out.push({ id: `D${i}`, kind: "im", counterpartyUserId: "U_OTHER" });
  for (let i = 0; i < channels; i++) out.push({ id: `C${i}`, kind: "channel" });
  return out;
}

describe("selectScanSet — partition-aware cap (ORB-170)", () => {
  it("under the cap, everything is selected unchanged", () => {
    const all = convoSet(3, 2);
    expect(selectScanSet(all, 40)).toEqual(all);
  });

  it("THE REGRESSION: 40 DMs + 44 channels at cap 40 selects channels too — never zero", () => {
    const picked = selectScanSet(convoSet(40, 44), 40);
    const channels = picked.filter((c) => c.kind === "channel");
    const dms = picked.filter((c) => c.kind !== "channel");
    expect(picked).toHaveLength(40);
    expect(channels).toHaveLength(20); // floor(cap/2) guaranteed to channels
    expect(dms).toHaveLength(20);
  });

  it("the real workspace at the new default cap 80 covers both partitions fully-ish", () => {
    const picked = selectScanSet(convoSet(40, 44), 80);
    expect(picked.filter((c) => c.kind !== "channel")).toHaveLength(40); // every DM
    expect(picked.filter((c) => c.kind === "channel")).toHaveLength(40); // 40 of 44 channels
  });

  it("a partition smaller than its share hands the remainder to the other", () => {
    const fewDms = selectScanSet(convoSet(5, 100), 40);
    expect(fewDms.filter((c) => c.kind !== "channel")).toHaveLength(5);
    expect(fewDms.filter((c) => c.kind === "channel")).toHaveLength(35);

    const fewChannels = selectScanSet(convoSet(100, 5), 40);
    expect(fewChannels.filter((c) => c.kind === "channel")).toHaveLength(5);
    expect(fewChannels.filter((c) => c.kind !== "channel")).toHaveLength(35);
  });

  it("DMs keep their priority position (first) and relative order is preserved", () => {
    const picked = selectScanSet(convoSet(40, 44), 40);
    expect(picked[0]!.id).toBe("D0");
    expect(picked[19]!.id).toBe("D19");
    expect(picked[20]!.id).toBe("C0");
    expect(picked[39]!.id).toBe("C19");
  });
});

describe("scanSlackThreads — bounded concurrency (ORB-170)", () => {
  it("runs conversations concurrently, bounded by the pool, with deterministic output order", async () => {
    const ts = tsHoursAgo(50);
    const conversations: SlackConversationRef[] = [];
    const messagesByConvo: Record<string, SlackThreadMessage[]> = {};
    for (let i = 0; i < 8; i++) {
      conversations.push({ id: `D${i}`, kind: "im", counterpartyUserId: "U_OTHER" });
      messagesByConvo[`D${i}`] = [msg({ userId: "U_OTHER", ts })];
    }
    let inFlight = 0;
    let maxInFlight = 0;
    const base = fakeDeps({ conversations, messagesByConvo });
    const deps: SlackSourceDeps = {
      ...base,
      readConversation: async (id, oldest, ceiling) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Later conversations resolve FIRST, so output order only stays stable if the scan
        // reassembles by selection index rather than completion order.
        const n = Number(id.slice(1));
        await new Promise((r) => setTimeout(r, (8 - n) * 5));
        inFlight--;
        return base.readConversation(id, oldest, ceiling);
      },
    };
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(DEFAULT_SLACK_SCAN_CONCURRENCY);
    expect(snapshots.map((s) => s.threadId)).toEqual(
      conversations.map((c) => `slack:im:${c.id}:${ts}`),
    );
  });
});

describe("scanSlackThreads — rate-limit backoff (ORB-170)", () => {
  it("a rate-limited conversation is retried once and still lands", async () => {
    const ts = tsHoursAgo(50);
    const base = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts })] },
    });
    let calls = 0;
    const deps: SlackSourceDeps = {
      ...base,
      readConversation: async (id, oldest, ceiling) => {
        calls++;
        if (calls === 1) throw new SlackRateLimitError(0);
        return base.readConversation(id, oldest, ceiling);
      },
    };
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(calls).toBe(2);
    expect(snapshots).toHaveLength(1);
  });

  it("a conversation rate-limited twice is SKIPPED — the rest of the scan survives", async () => {
    const ts = tsHoursAgo(50);
    const base = fakeDeps({
      conversations: [
        { id: "D1", kind: "im", counterpartyUserId: "U_OTHER" },
        { id: "D2", kind: "im", counterpartyUserId: "U_SECOND" },
      ],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts })], D2: [msg({ userId: "U_SECOND", ts })] },
    });
    const deps: SlackSourceDeps = {
      ...base,
      readConversation: async (id, oldest, ceiling) => {
        if (id === "D1") throw new SlackRateLimitError(0);
        return base.readConversation(id, oldest, ceiling);
      },
    };
    const snapshots = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.threadId).toContain("D2");
  });

  it("a non-rate-limit error still propagates — backoff never becomes a general swallow", async () => {
    const base = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts: tsHoursAgo(50) })] },
    });
    const deps: SlackSourceDeps = {
      ...base,
      readConversation: async () => { throw new Error("missing_scope"); },
    };
    await expect(scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW })).rejects.toThrow("missing_scope");
  });
});

// ─── scanSlackThreadsWithOwnActivity — ORB-45 Task 10 (B1) ──────────────────────────────────
//
// `scanSlackThreads` (above) is unchanged in signature/behaviour — every prior test in this file
// still exercises it directly. These tests cover the NEW `ownLastMessageByUser` half only.

describe("scanSlackThreadsWithOwnActivity", () => {
  it("scanSlackThreads still returns exactly the snapshots (delegation, not a behaviour change)", async () => {
    const ts = tsHoursAgo(50);
    const deps = fakeDeps({
      conversations: [{ id: "D1", kind: "im", counterpartyUserId: "U_OTHER" }],
      messagesByConvo: { D1: [msg({ userId: "U_OTHER", ts })] },
    });
    const viaScan = await scanSlackThreads(deps, { ownUserId: OWN, now: () => NOW });
    const viaWithActivity = await scanSlackThreadsWithOwnActivity(deps, { ownUserId: OWN, now: () => NOW });
    expect(viaWithActivity.snapshots).toEqual(viaScan);
  });

  it("records the latest own-message date per counterparty across two DM conversations", async () => {
    const otherLastOwn = tsHoursAgo(30);
    const secondLastOwn = tsHoursAgo(10);
    const deps = fakeDeps({
      conversations: [
        { id: "D1", kind: "im", counterpartyUserId: "U_OTHER" },
        { id: "D2", kind: "im", counterpartyUserId: "U_SECOND" },
      ],
      messagesByConvo: {
        D1: [
          msg({ userId: "U_OTHER", ts: tsHoursAgo(40) }),
          msg({ userId: OWN, ts: otherLastOwn }),
        ],
        D2: [
          msg({ userId: "U_SECOND", ts: tsHoursAgo(20) }),
          msg({ userId: OWN, ts: secondLastOwn }),
        ],
      },
    });
    const { ownLastMessageByUser } = await scanSlackThreadsWithOwnActivity(deps, { ownUserId: OWN, now: () => NOW });
    expect(ownLastMessageByUser.get("U_OTHER")).toEqual(parseSlackTsForTest(otherLastOwn));
    expect(ownLastMessageByUser.get("U_SECOND")).toEqual(parseSlackTsForTest(secondLastOwn));
  });

  it("keeps the LATER date when the same counterparty is active in more than one conversation", async () => {
    const earlier = tsHoursAgo(30);
    const later = tsHoursAgo(5);
    const deps = fakeDeps({
      conversations: [
        { id: "D1", kind: "im", counterpartyUserId: "U_OTHER" },
        { id: "G1", kind: "mpim" },
      ],
      messagesByConvo: {
        D1: [msg({ userId: "U_OTHER", ts: tsHoursAgo(40) }), msg({ userId: OWN, ts: earlier })],
        G1: [msg({ userId: "U_OTHER", ts: tsHoursAgo(6) }), msg({ userId: OWN, ts: later })],
      },
    });
    const { ownLastMessageByUser } = await scanSlackThreadsWithOwnActivity(deps, { ownUserId: OWN, now: () => NOW });
    expect(ownLastMessageByUser.get("U_OTHER")).toEqual(parseSlackTsForTest(later));
  });

  it("credits every other participant in an mpim group, not just whoever spoke last", async () => {
    const ownTs = tsHoursAgo(5);
    const deps = fakeDeps({
      conversations: [{ id: "G1", kind: "mpim" }],
      messagesByConvo: {
        G1: [
          msg({ userId: "U_OTHER", ts: tsHoursAgo(20) }),
          msg({ userId: "U_SECOND", ts: tsHoursAgo(10) }),
          msg({ userId: OWN, ts: ownTs }),
        ],
      },
    });
    const { ownLastMessageByUser } = await scanSlackThreadsWithOwnActivity(deps, { ownUserId: OWN, now: () => NOW });
    expect(ownLastMessageByUser.get("U_OTHER")).toEqual(parseSlackTsForTest(ownTs));
    expect(ownLastMessageByUser.get("U_SECOND")).toEqual(parseSlackTsForTest(ownTs));
  });

  it("scopes a channel to its own thread — own activity in one thread does not credit a different thread's participant", async () => {
    const root1 = tsHoursAgo(60);
    const root2 = tsHoursAgo(50);
    const ownTs = tsHoursAgo(5);
    const deps = fakeDeps({
      conversations: [{ id: "C1", kind: "channel" }],
      messagesByConvo: {
        C1: [
          msg({ userId: "U_OTHER", ts: root1, threadTs: root1, mentionsOwner: true }),
          msg({ userId: OWN, ts: ownTs, threadTs: root1 }),
          msg({ userId: "U_SECOND", ts: root2, threadTs: root2, mentionsOwner: true }),
        ],
      },
    });
    const { ownLastMessageByUser } = await scanSlackThreadsWithOwnActivity(deps, { ownUserId: OWN, now: () => NOW });
    expect(ownLastMessageByUser.get("U_OTHER")).toEqual(parseSlackTsForTest(ownTs));
    expect(ownLastMessageByUser.has("U_SECOND")).toBe(false);
  });
});

function parseSlackTsForTest(ts: string): Date {
  return new Date(Math.round(parseFloat(ts) * 1000));
}
