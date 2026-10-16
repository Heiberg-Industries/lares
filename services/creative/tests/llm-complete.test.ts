import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// : the studio's default model is the installation's brain alias, worked out from
// LARES_MODEL_PREFIX at call time; the explicit knobs keep winning, and a missing prefix is a
// plain error rather than a guessed name.
const generateTextMock = vi.fn(async (_args: unknown) => ({ text: "ok" }));
vi.mock("ai", () => ({ generateText: generateTextMock }));
vi.mock("../lib/gateway-provider.js", () => ({ gatewayModel: (m: string) => ({ id: m }) }));

const { gatewayComplete } = await import("../lib/llm-complete.js");

const KEYS = ["LARES_MODEL_PREFIX", "STUDIO_MODEL", "AGENT_MODEL"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  generateTextMock.mockClear();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const modelUsed = () => ((generateTextMock.mock.calls[0]![0] as { model: { id: string } }).model.id);

describe("creative gatewayComplete model choice", () => {
  it("defaults to the installation's brain alias", async () => {
    process.env["LARES_MODEL_PREFIX"] = "home";
    await gatewayComplete("p");
    expect(modelUsed()).toBe("home-brain");
  });

  it("explicit model, STUDIO_MODEL and AGENT_MODEL still win, in that order", async () => {
    process.env["LARES_MODEL_PREFIX"] = "lares";
    process.env["AGENT_MODEL"] = "agent-x";
    await gatewayComplete("p");
    expect(modelUsed()).toBe("agent-x");
    process.env["STUDIO_MODEL"] = "studio-x";
    generateTextMock.mockClear();
    await gatewayComplete("p");
    expect(modelUsed()).toBe("studio-x");
    generateTextMock.mockClear();
    await gatewayComplete("p", { model: "explicit-x" });
    expect(modelUsed()).toBe("explicit-x");
  });

  it("says plainly that the prefix is missing when nothing names a model", async () => {
    await expect(gatewayComplete("p")).rejects.toThrow(/LARES_MODEL_PREFIX is not set/);
  });
});
