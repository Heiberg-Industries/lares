// Tests for the /sveip fire-and-forget tool (Task 5). The only injected seam is `backfill`
// (per the brief) — the ack and the completion report go through the RAW `sendTelegramMessage`
// primitive directly, so that's what these tests mock and assert on, never a `to(...).send()`
// call (which a tool's `ctx` doesn't even expose — see agent/tools/sveip.ts's own doc comment).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { BackfillResult } from "../lib/bookings.js";

vi.mock("eve/channels/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("eve/channels/telegram")>();
  return { ...actual, sendTelegramMessage: vi.fn(async () => ({ id: "1", chatId: undefined, chatType: undefined, raw: {} })) };
});

import { sendTelegramMessage } from "eve/channels/telegram";
import { createSveipTool, composeCompletionReport, type SveipDeps } from "../catalogue/sveip.js";

const sendMock = vi.mocked(sendTelegramMessage);

const ADMIN_ID = "123456789";
const OTHER_ID = "999999999";

function auth(overrides: Partial<{ chatType: string; userId: string }> = {}) {
  const chatType = overrides.chatType ?? "private";
  const userId = overrides.userId ?? ADMIN_ID;
  return {
    authenticator: "telegram-webhook",
    principalId: chatType === "private" ? `telegram:${userId}` : `telegram:-100123:${userId}`,
    principalType: "user",
    attributes: { chat_id: chatType === "private" ? userId : "-100123", chat_type: chatType, user_id: userId },
  } as never;
}

function ctx(a: unknown) {
  return { session: { id: "wrun_test", auth: { current: a, initiator: a } } } as never;
}

function backfillResult(overrides: Partial<BackfillResult> = {}): BackfillResult {
  return { filed: 0, duplicates: 0, noTrip: 0, notBooking: 0, unclearSubjects: [], ...overrides };
}

/** A `backfill` deps stub whose promise resolves only when the test calls `resolve` — lets a
 *  test prove `execute()` returned BEFORE the sweep settled, not just "fast because the mock
 *  was fast". `callCount` is a function, not a captured value, so it stays live across the
 *  `execute()` call (a destructured plain number would freeze at 0). */
function deferredBackfill(): { deps: SveipDeps; resolve: (r: BackfillResult) => void; callCount: () => number } {
  let resolveFn!: (r: BackfillResult) => void;
  let calls = 0;
  const deps: SveipDeps = {
    backfill: () => {
      calls++;
      return new Promise<BackfillResult>((resolve) => {
        resolveFn = resolve;
      });
    },
  };
  return { deps, resolve: (r) => resolveFn(r), callCount: () => calls };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ADMIN_ID;
  sendMock.mockClear();
});

afterEach(() => {
  delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
});

describe("sveip execute() — structurally non-blocking", () => {
  it("resolves and returns the ack BEFORE the injected backfill promise ever settles", async () => {
    const { deps, resolve } = deferredBackfill();
    const tool = createSveipTool(deps);

    const ack = await tool.execute({}, ctx(auth()));

    expect(ack).toContain("Sveiper Reise-innboksen");
    // Exactly one send so far — the ack. The completion send cannot have happened: the
    // backfill promise is still pending (we haven't called `resolve` yet).
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ chatId: ADMIN_ID, body: { text: expect.stringContaining("Sveiper Reise-innboksen") } });

    // Now let the sweep finish and confirm the completion report follows, exactly once.
    resolve(backfillResult({ filed: 2 }));
    await flushMicrotasks();
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][0]).toMatchObject({ chatId: ADMIN_ID, body: { text: composeCompletionReport(backfillResult({ filed: 2 })) } });
  });

  it("calls backfill() exactly once per invocation", async () => {
    const { deps, resolve, callCount } = deferredBackfill();
    const tool = createSveipTool(deps);
    await tool.execute({}, ctx(auth()));
    expect(callCount()).toBe(1);
    resolve(backfillResult());
    await flushMicrotasks();
    expect(callCount()).toBe(1);
  });
});

describe("sveip execute() — completion report delivery", () => {
  it("sends the completion report via the raw sendTelegramMessage primitive only, never twice", async () => {
    const { deps, resolve } = deferredBackfill();
    const tool = createSveipTool(deps);
    await tool.execute({}, ctx(auth()));
    resolve(backfillResult({ filed: 1, duplicates: 3 }));
    await flushMicrotasks();
    await flushMicrotasks();

    const completionCalls = sendMock.mock.calls.filter((c) => (c[0].body as { text: string }).text.startsWith("Reise-sveipet er ferdig"));
    expect(completionCalls).toHaveLength(1);
  });

  it("sends a failure notice via the raw primitive when backfill rejects", async () => {
    const deps: SveipDeps = { backfill: () => Promise.reject(new Error("gmail down")) };
    const tool = createSveipTool(deps);
    await tool.execute({}, ctx(auth()));
    await flushMicrotasks();
    await flushMicrotasks();

    const failureCalls = sendMock.mock.calls.filter((c) => (c[0].body as { text: string }).text.includes("feilet"));
    expect(failureCalls).toHaveLength(1);
    expect((failureCalls[0][0].body as { text: string }).text).toContain("gmail down");
  });
});

describe("sveip execute() — admin-DM only gate", () => {
  it("refuses a group-chat call even from the admin's own user id, and never calls backfill or sends anything", async () => {
    const { deps, callCount } = deferredBackfill();
    const tool = createSveipTool(deps);

    await expect(tool.execute({}, ctx(auth({ chatType: "group" })))).rejects.toThrow(/admin-DM only/);

    expect(callCount()).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("refuses a private-chat call from a non-admin user id", async () => {
    const { deps, callCount } = deferredBackfill();
    const tool = createSveipTool(deps);

    await expect(tool.execute({}, ctx(auth({ userId: OTHER_ID })))).rejects.toThrow(/admin-DM only/);

    expect(callCount()).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("refuses when session auth is entirely absent", async () => {
    const { deps, callCount } = deferredBackfill();
    const tool = createSveipTool(deps);

    await expect(tool.execute({}, ctx(null))).rejects.toThrow(/admin-DM only/);

    expect(callCount()).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("falls back from an absent `current` auth to `initiator`, matching the fleet's Telegram-HITL-resume convention", async () => {
    const { deps } = deferredBackfill();
    const tool = createSveipTool(deps);
    const initiatorOnly = { session: { id: "wrun_test", auth: { current: null, initiator: auth() } } } as never;

    await expect(tool.execute({}, initiatorOnly)).resolves.toContain("Sveiper Reise-innboksen");
  });
});

describe("composeCompletionReport", () => {
  it("uses singular Norwegian grammar for exactly one filed booking", () => {
    expect(composeCompletionReport(backfillResult({ filed: 1 }))).toBe("Reise-sveipet er ferdig: fant 1 ny booking.");
  });

  it("uses plural grammar for zero or many", () => {
    expect(composeCompletionReport(backfillResult({ filed: 0 }))).toBe("Reise-sveipet er ferdig: fant 0 nye bookinger.");
    expect(composeCompletionReport(backfillResult({ filed: 3 }))).toBe("Reise-sveipet er ferdig: fant 3 nye bookinger.");
  });

  it("appends a full skip accounting when present", () => {
    const msg = composeCompletionReport(backfillResult({ filed: 1, duplicates: 2, noTrip: 1, notBooking: 4 }));
    expect(msg).toContain("Ellers: 2 allerede registrert, 1 traff ingen turdatoer, 4 var ikke bookinger.");
  });

  it("lists up to 3 unclear subjects, with an ellipsis when there are more", () => {
    const msg = composeCompletionReport(backfillResult({ unclearSubjects: ["A", "B", "C", "D"] }));
    expect(msg).toContain("4 e-poster skjønte jeg ikke: «A», «B», «C» …");
    expect(msg).toContain("videresend eller send skjermbilde");
  });

  it("omits the skip/unclear sentences entirely when there is nothing to report", () => {
    expect(composeCompletionReport(backfillResult({ filed: 5 }))).toBe("Reise-sveipet er ferdig: fant 5 nye bookinger.");
  });
});
