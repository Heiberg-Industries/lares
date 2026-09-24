import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ORB-45 Task 10 (B5), branch review — `gatewayComplete`'s `maxRetries` passthrough.
 *
 * WHY THIS FILE EXISTS AT ALL: `lib/obligation-intent.ts` documents itself as "NO retry", and
 * `INTENT_MAX_PER_PASS = 8` is sized as a spend ceiling on that basis. The claim was false at the
 * wire — `generateText` defaults to 2 retries, so the real ceiling was 24 model calls per pass —
 * and nothing in the suite could have caught it, because every test mocked the `complete` dep and
 * never reached the SDK call this option lives on. The assertion here is deliberately about the
 * ARGUMENT handed to `generateText`, which is the only place the difference is observable.
 *
 * ORB-225 addendum: `resolveModelForPurpose` (the pure purpose→model resolver) has its own
 * mock-free unit tests below, but this file's real-`generateText`-call harness is the only place
 * that can confirm the resolved model actually REACHES the SDK call, not just that the pure
 * function returns the right string — so it also carries that one assertion per purpose.
 *
 * Both describe blocks live in this one file because `vi.mock("ai", ...)` must be declared
 * (and its factory's `generateTextMock` initialized) before ANYTHING imports `lib/llm-complete.ts`
 * — including a static top-level import of `resolveModelForPurpose` alone, which would otherwise
 * pull in `lib/llm-complete.ts`'s own `import { generateText } from "ai"` ahead of the mock
 * factory being ready and fail with "Cannot access 'generateTextMock' before initialization".
 * Hence everything this file needs from `lib/llm-complete.ts` comes from the one dynamic import
 * below, after the mocks are set up — the same pattern the original maxRetries suite used.
 */

const generateTextMock = vi.fn(async () => ({ text: "expects_reply" }));
vi.mock("ai", () => ({ generateText: generateTextMock }));
vi.mock("../lib/gateway-provider.js", () => ({ gatewayModel: (m: string) => ({ id: m }) }));

const { gatewayComplete, resolveModelForPurpose, outputTokenBudget, THINKING_MODEL_MIN_OUTPUT_TOKENS } =
  await import("../lib/llm-complete.js");

beforeEach(() => generateTextMock.mockClear());

/**
 * Folkepuls 2026-09-07: the first real `writer` call after ORB-225 pointed `heiberg-writer` at a
 * thinking-on model. The compose call asked for `maxOutputTokens: 1024`, sized for the visible
 * email alone; the model spent 540–630 of those tokens thinking (gateway spend log,
 * `completion_tokens_details.reasoning_tokens`) and the JSON it returned was cut off mid-string
 * three times out of three. Thinking shares `max_tokens` — a cap sized for text only is a cap
 * the model cannot meet. The budget therefore lives HERE, beside the purpose→model mapping that
 * decides whether thinking is in play, not at the call sites.
 */
describe("outputTokenBudget — thinking shares max_tokens on writer/brain purposes", () => {
  it("floors writer and brain at the thinking-model minimum, whatever the caller asked for", () => {
    expect(outputTokenBudget("writer", 1024)).toBe(THINKING_MODEL_MIN_OUTPUT_TOKENS);
    expect(outputTokenBudget("brain", 1024)).toBe(THINKING_MODEL_MIN_OUTPUT_TOKENS);
    expect(outputTokenBudget("writer", undefined)).toBe(THINKING_MODEL_MIN_OUTPUT_TOKENS);
  });
  it("keeps a caller's cap when it is already above the floor", () => {
    expect(outputTokenBudget("writer", THINKING_MODEL_MIN_OUTPUT_TOKENS * 2)).toBe(
      THINKING_MODEL_MIN_OUTPUT_TOKENS * 2,
    );
  });
  it("leaves utility alone — its alias is not a thinking model, and 512 stays the default", () => {
    expect(outputTokenBudget("utility", 512)).toBe(512);
    expect(outputTokenBudget("utility", undefined)).toBe(512);
  });
});

describe("gatewayComplete — the floored budget is what reaches generateText", () => {
  it("a writer call asking for 1024 hands the floor to the SDK, not 1024", async () => {
    await gatewayComplete("prompt", { purpose: "writer", maxOutputTokens: 1024 });
    const arg = generateTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg["maxOutputTokens"]).toBe(THINKING_MODEL_MIN_OUTPUT_TOKENS);
  });

  it("a utility call's own cap still passes through untouched", async () => {
    await gatewayComplete("prompt", { purpose: "utility", maxOutputTokens: 300 });
    const arg = generateTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg["maxOutputTokens"]).toBe(300);
  });

  it("names the cap and the model in a warning when the reply stopped on length — the failure was a SyntaxError three times before anyone read the gateway log", async () => {
    const truncated: { text: string; finishReason: string } = {
      text: '{"subject": "Folkepuls', finishReason: "length",
    };
    generateTextMock.mockResolvedValueOnce(truncated);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await gatewayComplete("prompt", { purpose: "writer" });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain("maxOutputTokens");
      expect(message).toContain(String(THINKING_MODEL_MIN_OUTPUT_TOKENS));
      expect(message).toContain("heiberg-writer");
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent when the reply finished normally", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await gatewayComplete("prompt", { purpose: "writer" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("resolveModelForPurpose (ORB-225)", () => {
  it("defaults each purpose to its alias", () => {
    expect(resolveModelForPurpose("utility", {})).toBe("heiberg-utility");
    expect(resolveModelForPurpose("writer", {})).toBe("heiberg-writer");
    expect(resolveModelForPurpose("brain", {})).toBe("heiberg-brain");
  });
  it("the purpose's env knob wins over the alias; an explicit model wins over both", () => {
    expect(resolveModelForPurpose("utility", { UTILITY_MODEL: "x" })).toBe("x");
    expect(resolveModelForPurpose("writer", { WRITER_MODEL: "y" })).toBe("y");
    expect(resolveModelForPurpose("brain", { EVE_SAGA_MODEL: "z" })).toBe("z");
    expect(resolveModelForPurpose("brain", { EVE_SAGA_MODEL: "z" }, "explicit")).toBe("explicit");
  });
  it("EVE_SAGA_MODEL no longer leaks into utility or writer calls", () => {
    expect(resolveModelForPurpose("utility", { EVE_SAGA_MODEL: "z" })).toBe("heiberg-utility");
    expect(resolveModelForPurpose("writer", { EVE_SAGA_MODEL: "z" })).toBe("heiberg-writer");
  });
});

describe("gatewayComplete — maxRetries", () => {
  it("passes maxRetries through to generateText when the caller sets it", async () => {
    await gatewayComplete("prompt", { maxRetries: 0, maxOutputTokens: 8 });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const arg = generateTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg["maxRetries"]).toBe(0);
    expect(arg["maxOutputTokens"]).toBe(8);
  });

  it("OMITS the key entirely when the caller does not set it — every other call site keeps the SDK default", async () => {
    await gatewayComplete("prompt");
    const arg = generateTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect("maxRetries" in arg).toBe(false);
  });

  it("0 is passed as 0, not swallowed by a falsy check — the whole point of the option", async () => {
    await gatewayComplete("prompt", { maxRetries: 0 });
    const arg = generateTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg["maxRetries"]).toBe(0);
  });
});

describe("gatewayComplete — purpose resolution reaches generateText (ORB-225)", () => {
  it("defaults to the utility alias when no purpose, model, or env is given", async () => {
    await gatewayComplete("prompt");
    const arg = generateTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect((arg["model"] as { id: string }).id).toBe("heiberg-utility");
  });

  it('uses the writer alias when purpose: "writer" is given', async () => {
    await gatewayComplete("prompt", { purpose: "writer" });
    const arg = generateTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect((arg["model"] as { id: string }).id).toBe("heiberg-writer");
  });

  it("an explicit model still wins over purpose", async () => {
    await gatewayComplete("prompt", { purpose: "brain", model: "explicit-model" });
    const arg = generateTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect((arg["model"] as { id: string }).id).toBe("explicit-model");
  });
});
