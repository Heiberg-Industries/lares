/**
 * tests/approval-check.test.ts — the freshness and payload binding on an approval card
 * (`src/approval-ledger.ts`, W7A-s5). No Docker: the ledger reader is injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_TTL_MS, ApprovalNotGivenError, ApprovalPayloadChangedError, assertApprovedCall,
  callIdFrom, payloadFingerprint, StaleApprovalError,
  type ApprovalLedgerReader, type AskRow,
} from "../src/approval-ledger.js";

const INPUT = { to: ["a@x.example"], subject: "Q3" };
const NOW = new Date("2026-09-20T12:00:00Z");

/** A fake `markUsed` counting in memory, keyed on request id — mirrors the atomic
 *  `UPDATE … RETURNING use_count` the production reader runs. */
function countingMarkUsed(counts: Map<string, number> = new Map()) {
  return async (requestId: string) => {
    const useCount = (counts.get(requestId) ?? 0) + 1;
    counts.set(requestId, useCount);
    return { useCount };
  };
}

function reader(
  row: AskRow | null,
  settled: string[] = [],
  markUsed: ApprovalLedgerReader["markUsed"] = countingMarkUsed(),
): ApprovalLedgerReader {
  return { ask: async () => row, settle: async (_id, outcome) => { settled.push(outcome); }, markUsed };
}
const row = (over: Partial<AskRow> = {}): AskRow => ({
  requestId: "req-1", callId: "call-1", agent: "fixture-agent", tool: "gmail_send",
  payloadHash: payloadFingerprint("gmail_send", INPUT),
  askedAt: new Date(NOW.getTime() - 60_000), answeredAt: null, outcome: null, answeredVia: null,
  usedAt: null, useCount: 0,
  ...over,
});

describe("assertApprovedCall", () => {
  it("passes a fresh card whose arguments are the ones it showed", async () => {
    await expect(assertApprovedCall(reader(row()), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    })).resolves.toBeUndefined();
  });

  it("passes a card the owner has already approved", async () => {
    await expect(assertApprovedCall(reader(row({
      outcome: "approved", answeredAt: new Date(NOW.getTime() - 30_000), answeredVia: "telegram",
    })), { callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW }))
      .resolves.toBeUndefined();
  });

  it("refuses a card older than the window, and records that it expired", async () => {
    const settled: string[] = [];
    const old = row({ askedAt: new Date(NOW.getTime() - APPROVAL_TTL_MS - 1) });
    await expect(assertApprovedCall(reader(old, settled), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    })).rejects.toBeInstanceOf(StaleApprovalError);
    expect(settled).toEqual(["expired"]);
  });

  it("a card exactly at the window is still an answer — the boundary is 'older than'", async () => {
    await expect(assertApprovedCall(reader(row({
      askedAt: new Date(NOW.getTime() - APPROVAL_TTL_MS),
    })), { callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW }))
      .resolves.toBeUndefined();
  });

  it("measures the age from asked_at only — a caller's own ttl shortens the window", async () => {
    const settled: string[] = [];
    await expect(assertApprovedCall(reader(row(), settled), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW, ttlMs: 30_000,
    })).rejects.toBeInstanceOf(StaleApprovalError);
    expect(settled).toEqual(["expired"]);
  });

  it("refuses arguments that are not the ones on the card, and records that", async () => {
    const settled: string[] = [];
    await expect(assertApprovedCall(reader(row(), settled), {
      callId: "call-1", toolName: "gmail_send",
      input: { ...INPUT, to: ["a@x.example", "stranger@y.example"] }, now: NOW,
    })).rejects.toBeInstanceOf(ApprovalPayloadChangedError);
    expect(settled).toEqual(["payload-changed"]);
  });

  it("the binding is the ask's own canonicalisation: key order passes, one character does not", async () => {
    await expect(assertApprovedCall(reader(row()), {
      callId: "call-1", toolName: "gmail_send",
      input: { subject: "Q3", to: ["a@x.example"] }, now: NOW,
    })).resolves.toBeUndefined();
    await expect(assertApprovedCall(reader(row()), {
      callId: "call-1", toolName: "gmail_send",
      input: { to: ["a@x.example"], subject: "Q4" }, now: NOW,
    })).rejects.toBeInstanceOf(ApprovalPayloadChangedError);
  });

  it("a change buried in a nested value refuses too", async () => {
    const nested = { to: ["a@x.example"], body: { text: "one", meta: { cc: ["b@x.example"] } } };
    const carded = row({ payloadHash: payloadFingerprint("gmail_send", nested) });
    await expect(assertApprovedCall(reader(carded), {
      callId: "call-1", toolName: "gmail_send",
      input: { body: { meta: { cc: ["b@x.example"] }, text: "one" }, to: ["a@x.example"] }, now: NOW,
    })).resolves.toBeUndefined();
    await expect(assertApprovedCall(reader(carded), {
      callId: "call-1", toolName: "gmail_send",
      input: { to: ["a@x.example"], body: { text: "one", meta: { cc: ["c@x.example"] } } }, now: NOW,
    })).rejects.toBeInstanceOf(ApprovalPayloadChangedError);
  });

  it("a key present with no value is not the same call as a key that is not there", async () => {
    const carded = row({ payloadHash: payloadFingerprint("gmail_send", { to: ["a@x.example"] }) });
    await expect(assertApprovedCall(reader(carded), {
      callId: "call-1", toolName: "gmail_send",
      input: { to: ["a@x.example"], cc: undefined }, now: NOW,
    })).rejects.toBeInstanceOf(ApprovalPayloadChangedError);
  });

  it("the same arguments under another tool name are another call", async () => {
    await expect(assertApprovedCall(reader(row()), {
      callId: "call-1", toolName: "gmail_draft", input: INPUT, now: NOW,
    })).rejects.toBeInstanceOf(ApprovalPayloadChangedError);
  });

  it("says nothing when there was no card — an autonomous call, or a box without 086", async () => {
    await expect(assertApprovedCall(reader(null), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    })).resolves.toBeUndefined();
    await expect(assertApprovedCall(reader(row()), {
      callId: undefined, toolName: "gmail_send", input: INPUT, now: NOW,
    })).resolves.toBeUndefined();
  });

  it("an unreadable ledger costs nothing — evidence never fails an action", async () => {
    const broken: ApprovalLedgerReader = {
      ask: async () => { throw new Error("connection refused"); },
      settle: async () => { throw new Error("connection refused"); },
      markUsed: async () => { throw new Error("connection refused"); },
    };
    await expect(assertApprovedCall(broken, {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    })).resolves.toBeUndefined();
  });

  it("a refusal still refuses when the settle write fails", async () => {
    const halfBroken: ApprovalLedgerReader = {
      ask: async () => row({ askedAt: new Date(NOW.getTime() - APPROVAL_TTL_MS - 1) }),
      settle: async () => { throw new Error("connection refused"); },
      markUsed: async () => { throw new Error("connection refused"); },
    };
    await expect(assertApprovedCall(halfBroken, {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    })).rejects.toBeInstanceOf(StaleApprovalError);
  });

  it("a settled row is never an approval again, whatever it settled as", async () => {
    const settled: string[] = [];
    await expect(assertApprovedCall(reader(row({
      outcome: "cancelled", answeredAt: NOW,
    }), settled), { callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW }))
      .rejects.toBeInstanceOf(ApprovalNotGivenError);
    await expect(assertApprovedCall(reader(row({ outcome: "ignored", answeredAt: NOW }), settled), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    })).rejects.toBeInstanceOf(ApprovalNotGivenError);
    await expect(assertApprovedCall(reader(row({ outcome: "invalid", answeredAt: NOW }), settled), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    })).rejects.toBeInstanceOf(ApprovalNotGivenError);
    // Already settled by an earlier pass through this check: refused as what it was settled as,
    // and never written a second time.
    await expect(assertApprovedCall(reader(row({ outcome: "expired", answeredAt: NOW }), settled), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    })).rejects.toBeInstanceOf(StaleApprovalError);
    await expect(assertApprovedCall(reader(row({ outcome: "payload-changed", answeredAt: NOW }), settled), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    })).rejects.toBeInstanceOf(ApprovalPayloadChangedError);
    expect(settled).toEqual([]);
  });

  it("reads eve's call id off a tool context, and nothing else", () => {
    // The shape a REAL eve 0.60.1 `execute` receives — measured, not assumed
    // (packages/board-evals/proofs/approval-binding-2026-09-20.md): the id is `callId`.
    expect(callIdFrom({
      abortSignal: undefined, callId: "call-7", session: {}, toolName: "gmail_send",
    })).toBe("call-7");
    expect(callIdFrom({ callId: "call-7", toolCallId: "call-other" })).toBe("call-7");
    expect(callIdFrom({ callId: "", toolCallId: "call-9" })).toBe("call-9");
    expect(callIdFrom({ callId: 7 })).toBeUndefined();
    expect(callIdFrom({ toolCallId: "call-9" })).toBe("call-9");
    expect(callIdFrom({ toolCallId: 9 })).toBeUndefined();
    expect(callIdFrom({ toolCallId: "" })).toBeUndefined();
    expect(callIdFrom(null)).toBeUndefined();
    expect(callIdFrom(undefined)).toBeUndefined();
    expect(callIdFrom({})).toBeUndefined();
    expect(callIdFrom("call-9")).toBeUndefined();
  });

  it("the refusals are readable, and name no message content", async () => {
    const err = await assertApprovedCall(reader(row({ askedAt: new Date(NOW.getTime() - APPROVAL_TTL_MS - 1) })), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/asked .* ago/);
    expect((err as Error).message).not.toContain("Q3");
    expect((err as Error).message).not.toContain("a@x.example");

    const changed = await assertApprovedCall(reader(row()), {
      callId: "call-1", toolName: "gmail_send",
      input: { ...INPUT, to: ["a@x.example", "stranger@y.example"] }, now: NOW,
    }).catch((e: Error) => e);
    expect((changed as Error).message).toBe(
      "What this would do is not what the card showed, so I did not do it. Ask me again.",
    );
    expect((changed as Error).message).not.toContain("stranger@y.example");
  });
});

describe("assertApprovedCall — use counting (W7A-s5b, observe don't enforce)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { warn.mockRestore(); });

  it("a pass on an existing row marks it used, and one pass warns nothing", async () => {
    const counts = new Map<string, number>();
    const markUsed = vi.fn(countingMarkUsed(counts));
    await expect(assertApprovedCall(reader(row(), [], markUsed), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    })).resolves.toBeUndefined();
    expect(markUsed).toHaveBeenCalledTimes(1);
    expect(markUsed).toHaveBeenCalledWith("req-1");
    expect(counts.get("req-1")).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a second pass warns once, naming the tool and call id, never the payload", async () => {
    const counts = new Map<string, number>();
    const markUsed = countingMarkUsed(counts);
    await assertApprovedCall(reader(row(), [], markUsed), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    });
    await assertApprovedCall(reader(row(), [], markUsed), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    });
    expect(counts.get("req-1")).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    const [line] = warn.mock.calls[0] as [string];
    expect(line).toContain("gmail_send");
    expect(line).toContain("call-1");
    expect(line).toContain("2");
    expect(line).not.toContain("Q3");
    expect(line).not.toContain("a@x.example");
  });

  it("a refusal never calls markUsed — expired, payload-changed, or already settled", async () => {
    const markUsed = vi.fn(countingMarkUsed());

    await expect(assertApprovedCall(reader(
      row({ askedAt: new Date(NOW.getTime() - APPROVAL_TTL_MS - 1) }), [], markUsed,
    ), { callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW }))
      .rejects.toBeInstanceOf(StaleApprovalError);

    await expect(assertApprovedCall(reader(row(), [], markUsed), {
      callId: "call-1", toolName: "gmail_send",
      input: { ...INPUT, to: ["a@x.example", "stranger@y.example"] }, now: NOW,
    })).rejects.toBeInstanceOf(ApprovalPayloadChangedError);

    await expect(assertApprovedCall(reader(
      row({ outcome: "cancelled", answeredAt: NOW }), [], markUsed,
    ), { callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW }))
      .rejects.toBeInstanceOf(ApprovalNotGivenError);

    expect(markUsed).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a markUsed that throws does not fail the call, and warns nothing", async () => {
    const markUsed: ApprovalLedgerReader["markUsed"] = async () => { throw new Error("connection refused"); };
    await expect(assertApprovedCall(reader(row(), [], markUsed), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    })).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a markUsed that returns null changes nothing", async () => {
    const markUsed: ApprovalLedgerReader["markUsed"] = async () => null;
    await expect(assertApprovedCall(reader(row(), [], markUsed), {
      callId: "call-1", toolName: "gmail_send", input: INPUT, now: NOW,
    })).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
