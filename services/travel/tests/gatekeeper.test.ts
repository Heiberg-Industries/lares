import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { Gatekeeper, makeGateDecide, type GateAction } from "../lib/gatekeeper.js";
import { Budget } from "../lib/budget.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Ported from services/marcel/tests/gatekeeper.test.ts, adapted to eve-marcel's Gatekeeper:
// `tz` moves from a constructor dep to a per-call `consider()` argument (the trip's own tz,
// not old Marcel's fixed "Europe/Paris" — see lib/gatekeeper.ts's docstring) and chat ids are
// strings, matching eve's `TelegramChat.id: string` rather than old Marcel's `number`.

// 1752566400 = 2025-07-15 10:00 Europe/Paris (not quiet hours).
const NOON_PARIS = 1752566400;
// 1752613200 = 2025-07-15 23:00 Europe/Paris (quiet hours).
const NIGHT_PARIS = 1752613200;

describe("Gatekeeper.consider", () => {
  it("downgrades a third speak within the hour", async () => {
    let t = NOON_PARIS;
    const g = new Gatekeeper({ decide: async () => ({ action: "speak" }), now: () => t });
    expect((await g.consider("1", "a", "Europe/Paris")).action).toBe("speak");
    t += 600;
    expect((await g.consider("1", "b", "Europe/Paris")).action).not.toBe("speak"); // consecutive rule
    t += 600;
    expect((await g.consider("1", "c", "Europe/Paris")).action).toBe("speak");
    t += 600;
    expect((await g.consider("1", "d", "Europe/Paris")).action).not.toBe("speak"); // 2/hour cap now binds
    t += 3700;
    expect((await g.consider("1", "e", "Europe/Paris")).action).toBe("speak");
  });

  it("stays silent during quiet hours even when the model says speak, without calling decide", async () => {
    const decide = vi.fn(async (): Promise<GateAction> => ({ action: "speak" }));
    const g = new Gatekeeper({ decide, now: () => NIGHT_PARIS });

    const result = await g.consider("1", "goodnight everyone", "Europe/Paris");

    expect(result).toEqual({ action: "silent" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("uses the tz passed into consider(), not a fixed zone — the same wall-clock instant is quiet in Paris but not in a west-coast US trip's tz", async () => {
    const decide = vi.fn(async (): Promise<GateAction> => ({ action: "speak" }));
    const g = new Gatekeeper({ decide, now: () => NIGHT_PARIS });

    const parisResult = await g.consider("1", "hi", "Europe/Paris");
    expect(parisResult).toEqual({ action: "silent" });

    const laResult = await g.consider("2", "hi", "America/Los_Angeles");
    expect(laResult.action).toBe("speak");
  });

  it("fails silent when decide throws", async () => {
    const g = new Gatekeeper({
      decide: async () => {
        throw new Error("model unavailable");
      },
      now: () => NOON_PARIS,
    });

    const result = await g.consider("1", "hello", "Europe/Paris");

    expect(result).toEqual({ action: "silent" });
  });

  it("fails silent when decide returns a malformed action", async () => {
    const g = new Gatekeeper({
      decide: async () => ({ action: "shout" }) as unknown as GateAction,
      now: () => NOON_PARIS,
    });

    const result = await g.consider("1", "hello", "Europe/Paris");

    expect(result).toEqual({ action: "silent" });
  });

  it("tracks separate chats with independent caps", async () => {
    let t = NOON_PARIS;
    const g = new Gatekeeper({ decide: async () => ({ action: "speak" }), now: () => t });

    // Chat 1: speak, then downgraded by consecutive rule.
    expect((await g.consider("1", "a", "Europe/Paris")).action).toBe("speak");
    expect((await g.consider("1", "b", "Europe/Paris")).action).not.toBe("speak");

    // Chat 2 has never spoken — its first consider() is unaffected by chat 1's state.
    t += 60;
    expect((await g.consider("2", "x", "Europe/Paris")).action).toBe("speak");
  });

  it("passes a model react through untouched, with its own emoji", async () => {
    const g = new Gatekeeper({
      decide: async () => ({ action: "react", emoji: "😂" }),
      now: () => NOON_PARIS,
    });

    const result = await g.consider("1", "lol", "Europe/Paris");

    expect(result).toEqual({ action: "react", emoji: "😂" });
  });
});

describe("makeGateDecide", () => {
  let budgetFile: string;

  function freshBudget(): Budget {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marcel-gate-budget-"));
    budgetFile = path.join(dir, "budget.json");
    return new Budget(budgetFile, 1_000_000, "UTC");
  }

  it("calls the raw model with maxOutputTokens 64 and parses a clean speak response", async () => {
    let capturedMaxOutputTokens: number | undefined;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        capturedMaxOutputTokens = options.maxOutputTokens;
        return {
          content: [{ type: "text", text: '{"action":"speak"}' }],
          finishReason: "stop",
          usage: {
            inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 4, text: 4, reasoning: undefined },
          },
        };
      },
    });
    const budget = freshBudget();

    const decide = makeGateDecide({ model: () => model, budget });
    const result = await decide("noen prater om middag");

    expect(result).toEqual({ action: "speak" });
    expect(capturedMaxOutputTokens).toBe(64);
  });

  it("tracks token usage against the injected budget", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: '{"action":"silent"}' }],
        finishReason: "stop",
        usage: {
          inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 4, text: 4, reasoning: undefined },
        },
      }),
    });
    const budget = freshBudget();

    const decide = makeGateDecide({ model: () => model, budget });
    await decide("noen prater om middag");

    expect(budget.exceeded()).toBe(false);
    budget.add(1_000_000 - 16); // top up to exactly the limit — proves the 16 (12+4) was recorded
    expect(budget.exceeded()).toBe(true);
  });

  it("extracts JSON embedded in surrounding text", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: 'Sure, here you go: {"action":"react","emoji":"👍"} thanks!' }],
        finishReason: "stop",
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
      }),
    });

    const decide = makeGateDecide({ model: () => model, budget: freshBudget() });
    const result = await decide("hei");

    expect(result).toEqual({ action: "react", emoji: "👍" });
  });

  it("falls back to silent on unparseable model text", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "not json at all" }],
        finishReason: "stop",
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
      }),
    });

    const decide = makeGateDecide({ model: () => model, budget: freshBudget() });
    const result = await decide("hei");

    expect(result).toEqual({ action: "silent" });
  });
});
