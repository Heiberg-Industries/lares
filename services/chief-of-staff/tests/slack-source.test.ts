import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackRateLimitError } from "@lares/network/lib/importers/slack.js";

const getMostRecentRefreshToken = vi.fn();
vi.mock("@lares/agent-kit/google-auth", () => ({
  getMostRecentRefreshToken: (...args: unknown[]) => getMostRecentRefreshToken(...args),
}));

const { createSlackSourceDeps, resolveSlackToken, SlackUnenrolledError, SlackApiError } = await import(
  "../lib/slack-source.js"
);

beforeEach(() => {
  getMostRecentRefreshToken.mockReset();
});

const TOKEN = "xoxp-test-token";
const OWN = "U_BENDIK";

type Call = { url: string; params: URLSearchParams };

/** Stubbed `fetch` — never touches the network, records every call, answers from a handler map
 *  keyed by Slack method name (mirrors services/network/tests/slack-reader.test.ts's stub). */
function stubFetch(handlers: Record<string, (calls: Call[], params: URLSearchParams) => { status?: number; headers?: Record<string, string>; body: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const [path, qs] = url.split("?");
    const method = path!.split("/").pop()!;
    const params = new URLSearchParams(qs ?? "");
    calls.push({ url, params });
    const handler = handlers[method];
    if (!handler) throw new Error(`unstubbed Slack method: ${method}`);
    const { status = 200, headers = {}, body } = handler(calls, params);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("createSlackSourceDeps — listConversations", () => {
  it("maps channel, im (with counterparty), and mpim (no counterparty needed) — DMs/group-DMs partitioned ahead of channels", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.list": () => ({
        body: {
          ok: true,
          channels: [
            { id: "C1", is_channel: true },
            { id: "D1", is_im: true, user: "U_OTHER" },
            { id: "G1", is_mpim: true },
          ],
        },
      }),
    });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    // Slack returned channel-first; the reader partitions im/mpim ahead of channel (see the
    // next test for why this is load-bearing, not cosmetic) — a STABLE partition, so D1/G1
    // keep their relative order from Slack's own response, just moved ahead of C1.
    expect(await deps.listConversations()).toEqual([
      { id: "D1", kind: "im", counterpartyUserId: "U_OTHER" },
      { id: "G1", kind: "mpim" },
      { id: "C1", kind: "channel" },
    ]);
  });

  it("ORB-149 review round 3, CRITICAL: partitions DMs/group-DMs AHEAD of channels even when Slack returns channels first, across pagination — a downstream slice() must never lose every DM to channels that happened to sort earlier", async () => {
    // Mirrors Bendik's real workspace shape (35 public + 6 private + 38 im — see
    // morning-brief.ts's SLACK_MAX_CONVERSATIONS comment): channels dominate the raw count,
    // so an UN-partitioned list handed to a small `maxConversations` slice would exclude every
    // DM. Two pages, channels on page 1, DMs/mpim on page 2 — the worst case for a naive
    // "preserve Slack's order" implementation.
    const { fetchImpl } = stubFetch({
      "conversations.list": (allCalls) => {
        if (allCalls.length === 1) {
          return {
            body: {
              ok: true,
              channels: [
                { id: "C1", is_channel: true },
                { id: "C2", is_channel: true },
                { id: "C3", is_private: true, is_channel: true }, // private channels arrive as channels too
              ],
              response_metadata: { next_cursor: "page2" },
            },
          };
        }
        return {
          body: {
            ok: true,
            channels: [
              { id: "D1", is_im: true, user: "U_A" },
              { id: "G1", is_mpim: true },
              { id: "D2", is_im: true, user: "U_B" },
            ],
            response_metadata: { next_cursor: "" },
          },
        };
      },
    });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const convos = await deps.listConversations();
    // Every im/mpim sorts before every channel — a slice(0, N) taken from THIS order can never
    // drop a DM in favour of a channel, regardless of how few conversations fit in the cap.
    const firstChannelIdx = convos.findIndex((c) => c.kind === "channel");
    const lastDmIdx = convos.map((c) => c.kind).lastIndexOf("im") >= convos.map((c) => c.kind).lastIndexOf("mpim")
      ? convos.map((c) => c.kind).lastIndexOf("im")
      : convos.map((c) => c.kind).lastIndexOf("mpim");
    expect(lastDmIdx).toBeLessThan(firstChannelIdx);
    // Relative order WITHIN each group is preserved (a stable partition, not a re-sort).
    expect(convos.filter((c) => c.kind === "im" || c.kind === "mpim").map((c) => c.id)).toEqual(["D1", "G1", "D2"]);
    expect(convos.filter((c) => c.kind === "channel").map((c) => c.id)).toEqual(["C1", "C2", "C3"]);
    // The scenario that actually motivated this: a downstream slice(0, 4) — smaller than the
    // 6 conversations total — still gets every DM/mpim, not just whichever channels sorted
    // first in Slack's raw response.
    const sliced = convos.slice(0, 4).map((c) => c.id);
    expect(sliced).toEqual(expect.arrayContaining(["D1", "G1", "D2"]));
  });

  it("skips archived conversations", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.list": () => ({ body: { ok: true, channels: [{ id: "C1", is_channel: true, is_archived: true }] } }),
    });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await deps.listConversations()).toEqual([]);
  });

  it("follows pagination via response_metadata.next_cursor", async () => {
    const { fetchImpl, calls } = stubFetch({
      "conversations.list": (allCalls) => {
        if (allCalls.length === 1) return { body: { ok: true, channels: [{ id: "C1", is_channel: true }], response_metadata: { next_cursor: "page2" } } };
        return { body: { ok: true, channels: [{ id: "C2", is_channel: true }], response_metadata: { next_cursor: "" } } };
      },
    });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const convos = await deps.listConversations();
    expect(convos.map((c) => c.id)).toEqual(["C1", "C2"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.params.get("cursor")).toBe("page2");
  });
});

describe("createSlackSourceDeps — readConversation (channel)", () => {
  it("populates threadTs (own ts, no thread) and mentionsOwner from text", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.history": () => ({
        body: {
          ok: true,
          messages: [
            { ts: "100.0001", user: "U_OTHER", text: `hey <@${OWN}> got a sec?` },
            { ts: "99.0001", user: "U_OTHER", text: "no mention here" },
          ],
          has_more: false,
        },
      }),
    });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const msgs = await deps.readConversation("C1", undefined, 50);
    // ORB-45 Task 10 (B1): `text` now rides along IN FLIGHT (never persisted — see
    // brief-content-slack.ts's SlackThreadMessage doc comment).
    expect(msgs).toEqual([
      { ts: "100.0001", userId: "U_OTHER", isBot: false, subtype: undefined, threadTs: "100.0001", mentionsOwner: true, text: `hey <@${OWN}> got a sec?` },
      { ts: "99.0001", userId: "U_OTHER", isBot: false, subtype: undefined, threadTs: "99.0001", mentionsOwner: false, text: "no mention here" },
    ]);
  });

  it("walks conversations.replies for a thread parent and stamps replies with the parent's threadTs", async () => {
    const { fetchImpl, calls } = stubFetch({
      "conversations.history": () => ({
        body: { ok: true, messages: [{ ts: "100.0001", user: "U_OTHER", thread_ts: "100.0001", reply_count: 2 }], has_more: false },
      }),
      "conversations.replies": () => ({
        body: {
          ok: true,
          messages: [
            { ts: "100.0001", user: "U_OTHER" }, // parent, excluded (already pushed)
            { ts: "101.0001", user: OWN, text: "on it" },
            { ts: "102.0001", user: "U_OTHER" },
          ],
        },
      }),
    });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const msgs = await deps.readConversation("C1", undefined, 50);
    expect(msgs).toEqual([
      { ts: "100.0001", userId: "U_OTHER", isBot: false, subtype: undefined, threadTs: "100.0001", mentionsOwner: false, text: undefined },
      { ts: "101.0001", userId: OWN, isBot: false, subtype: undefined, threadTs: "100.0001", mentionsOwner: false, text: "on it" },
      { ts: "102.0001", userId: "U_OTHER", isBot: false, subtype: undefined, threadTs: "100.0001", mentionsOwner: false, text: undefined },
    ]);
    const repliesCall = calls.find((c) => c.url.includes("conversations.replies"));
    expect(repliesCall!.params.get("ts")).toBe("100.0001");
  });

  it("does not exceed ceiling even across a thread expansion", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.history": () => ({
        body: { ok: true, messages: [{ ts: "100.0001", user: "U_OTHER", thread_ts: "100.0001", reply_count: 5 }], has_more: false },
      }),
      "conversations.replies": () => ({
        body: {
          ok: true,
          messages: [
            { ts: "100.0001", user: "U_OTHER" },
            { ts: "101.0001", user: "U_A" },
            { ts: "102.0001", user: "U_B" },
            { ts: "103.0001", user: "U_C" },
          ],
        },
      }),
    });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const msgs = await deps.readConversation("C1", undefined, 2);
    expect(msgs).toHaveLength(2);
  });

  it("follows history pagination via has_more + next_cursor, forwarding oldest/cursor", async () => {
    const { fetchImpl, calls } = stubFetch({
      "conversations.history": (allCalls) => {
        const n = allCalls.filter((c) => c.url.includes("conversations.history")).length;
        if (n === 1) return { body: { ok: true, messages: [{ ts: "100.0001", user: "U_OTHER" }], has_more: true, response_metadata: { next_cursor: "abc" } } };
        return { body: { ok: true, messages: [{ ts: "99.0001", user: "U_OTHER" }], has_more: false } };
      },
    });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const msgs = await deps.readConversation("C1", "50.0000", 50);
    expect(msgs.map((m) => m.ts)).toEqual(["100.0001", "99.0001"]);
    const historyCalls = calls.filter((c) => c.url.includes("conversations.history"));
    expect(historyCalls[0]!.params.get("oldest")).toBe("50.0000");
    expect(historyCalls[1]!.params.get("cursor")).toBe("abc");
  });

  it("429 becomes SlackRateLimitError with retryAfterSeconds", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.history": () => ({ status: 429, headers: { "Retry-After": "9" }, body: { ok: false } }),
    });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const err = await deps.readConversation("C1", undefined, 50).catch((e) => e);
    expect(err).toBeInstanceOf(SlackRateLimitError);
    expect((err as InstanceType<typeof SlackRateLimitError>).retryAfterSeconds).toBe(9);
  });
});

describe("createSlackSourceDeps — readConversation (im/mpim)", () => {
  it("never expands threads and mentionsOwner is always false", async () => {
    const { fetchImpl, calls } = stubFetch({
      "conversations.list": () => ({ body: { ok: true, channels: [{ id: "D1", is_im: true, user: "U_OTHER" }] } }),
      "conversations.history": () => ({
        body: { ok: true, messages: [{ ts: "100.0001", user: "U_OTHER", text: `<@${OWN}> hi`, thread_ts: "100.0001", reply_count: 3 }], has_more: false },
      }),
    });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    await deps.listConversations(); // populates the kind cache with "im" for D1
    const msgs = await deps.readConversation("D1", undefined, 50);
    expect(msgs).toEqual([{ ts: "100.0001", userId: "U_OTHER", isBot: false, subtype: undefined, threadTs: "100.0001", mentionsOwner: false, text: `<@${OWN}> hi` }]);
    expect(calls.some((c) => c.url.includes("conversations.replies"))).toBe(false);
  });
});

describe("createSlackSourceDeps — Slackbot mapping (Important 5)", () => {
  it("maps USLACKBOT's own messages to isBot:true even with no bot_id", async () => {
    const { fetchImpl } = stubFetch({
      "conversations.history": () => ({
        body: { ok: true, messages: [{ ts: "100.0001", user: "USLACKBOT" }], has_more: false },
      }),
    });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const msgs = await deps.readConversation("D1", undefined, 50);
    expect(msgs[0]!.isBot).toBe(true);
  });
});

describe("createSlackSourceDeps — getUserInfo", () => {
  it("populates email and displayName", async () => {
    const { fetchImpl } = stubFetch({
      "users.info": () => ({ body: { ok: true, user: { id: "U_OTHER", profile: { email: "lars@partner.example", display_name: "Lars" } } } }),
    });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await deps.getUserInfo("U_OTHER")).toEqual({ id: "U_OTHER", email: "lars@partner.example", displayName: "Lars" });
  });

  it("degrades to a name-only identity when users:read.email has nothing on file (D3)", async () => {
    const { fetchImpl } = stubFetch({
      "users.info": () => ({ body: { ok: true, user: { id: "U_GUEST", profile: { display_name: "Guest" } } } }),
    });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await deps.getUserInfo("U_GUEST")).toEqual({ id: "U_GUEST", email: null, displayName: "Guest" });
  });

  it("returns null for an unknown/deactivated user rather than throwing", async () => {
    const { fetchImpl } = stubFetch({ "users.info": () => ({ body: { ok: false, error: "user_not_found" } }) });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    expect(await deps.getUserInfo("U_GONE")).toBeNull();
  });

  it("rethrows a real failure instead of returning null (Critical 2, eve-saga twin)", async () => {
    const { fetchImpl } = stubFetch({ "users.info": () => ({ body: { ok: false, error: "missing_scope" } }) });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    const err = await deps.getUserInfo("U_ANYONE").catch((e) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as InstanceType<typeof SlackApiError>).code).toBe("missing_scope");
  });

  it("429 on users.info still becomes SlackRateLimitError, not null", async () => {
    const { fetchImpl } = stubFetch({ "users.info": () => ({ status: 429, headers: { "Retry-After": "3" }, body: { ok: false } }) });
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });
    await expect(deps.getUserInfo("U_X")).rejects.toBeInstanceOf(SlackRateLimitError);
  });
});

describe("SlackUnenrolledError", () => {
  it("names the principal and points at the runbook", () => {
    const err = new SlackUnenrolledError("fixture-owner");
    expect(err.message).toContain("fixture-owner");
    expect(err.message).toContain("docs/runbooks/slack-user-token.md");
    expect(err.name).toBe("SlackUnenrolledError");
  });
});

describe("resolveSlackToken", () => {
  it("refuses blank principal before querying credentials", async () => {
    await expect(resolveSlackToken("   ")).rejects.toThrow("Set SLACK_TOKEN_PRINCIPAL_ID");
    expect(getMostRecentRefreshToken).not.toHaveBeenCalled();
  });

  it("throws SlackUnenrolledError — never a silent no-op — when nothing is enrolled", async () => {
    getMostRecentRefreshToken.mockResolvedValue(null);
    await expect(resolveSlackToken("fixture-owner")).rejects.toBeInstanceOf(SlackUnenrolledError);
    expect(getMostRecentRefreshToken).toHaveBeenCalledWith("fixture-owner", "slack");
  });

  it("returns the token from oauth_tokens (provider='slack') when enrolled", async () => {
    getMostRecentRefreshToken.mockResolvedValue({ token: "xoxp-live", scopes: [], emailAddress: "owner@owner.example", orgId: "heiberg" });
    expect(await resolveSlackToken("fixture-owner")).toBe("xoxp-live");
  });

  it("honours an explicit principal override", async () => {
    getMostRecentRefreshToken.mockResolvedValue({ token: "xoxp-live", scopes: [], emailAddress: "x", orgId: "heiberg" });
    await resolveSlackToken("U_SOMEONE_ELSE");
    expect(getMostRecentRefreshToken).toHaveBeenCalledWith("U_SOMEONE_ELSE", "slack");
  });
});

/**
 * ORB-164 — cancellation. The morning brief's sub-timeout used to RACE the scan and leave it
 * running (morning-brief.ts's own note said so); the budget it outran was then spent again,
 * invisibly, every morning. The reader now carries the caller's AbortSignal all the way to
 * `fetch`, which is what actually stops in-flight Slack work.
 */
describe("createSlackSourceDeps — AbortSignal", () => {
  /** Records the `signal` each call was given, and answers with an empty conversation list. */
  function signalRecordingFetch(): { fetchImpl: typeof fetch; signals: Array<AbortSignal | null | undefined> } {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response(JSON.stringify({ ok: true, channels: [], messages: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { fetchImpl, signals };
  }

  it("passes the caller's signal to every Slack request", async () => {
    const { fetchImpl, signals } = signalRecordingFetch();
    const controller = new AbortController();
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl, signal: controller.signal });

    await deps.listConversations();
    await deps.readConversation("D1", undefined, 10);

    expect(signals).toHaveLength(2);
    for (const s of signals) expect(s).toBe(controller.signal);
  });

  it("omits the signal entirely when the caller supplies none — the option is additive", async () => {
    const { fetchImpl, signals } = signalRecordingFetch();
    const deps = createSlackSourceDeps({ token: TOKEN, ownUserId: OWN, fetchImpl });

    await deps.listConversations();

    expect(signals).toEqual([undefined]);
  });

  it("an already-aborted signal fails the call rather than spending a Slack request", async () => {
    const deps = createSlackSourceDeps({
      token: TOKEN,
      ownUserId: OWN,
      signal: AbortSignal.abort(new Error("budget spent")),
      fetchImpl: (async () => {
        throw new Error("fetch should never be reached with an aborted signal");
      }) as typeof fetch,
    });

    await expect(deps.listConversations()).rejects.toThrow(/budget spent/);
  });
});
