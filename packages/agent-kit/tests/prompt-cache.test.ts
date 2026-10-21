import { captureModelInvocation, runModelInvocation } from '../src/model-invocation.js';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, tool, type ModelMessage, type SystemModelMessage } from "ai";
import { z } from "zod";

import { createGatewayProvider } from "../src/gateway-provider.js";
import {
  MAX_CACHE_BREAKPOINTS,
  PROMPT_CACHE_BOUNDARY,
  reshapeJsonBody,
  shapeAnthropicBody,
  splitAtBoundary,
  stripBoundaryFromChatBody,
} from "../src/prompt-cache.js";

const EPHEMERAL = { type: "ephemeral" };

// What eve 0.60.1 puts on a message, a tool or the system prompt when it detects an Anthropic
// provider (`harness/prompt-cache.js`, `ANTHROPIC_CACHE_MARKER`).
const EVE_MARKER = { anthropic: { cacheControl: EPHEMERAL }, bedrock: { cachePoint: { type: "default" } } };

// Long enough to look like a persona; the exact size does not matter to the shaping.
const PERSONA = "# Persona\n\n" + "I keep the owner's week in order. ".repeat(200).trimEnd();
const FACTS = "## What the owner has told me\n\n- Prefers mornings.";

/**
 * The system prompt exactly as eve builds it for one turn (read out of the 0.60.1 dist):
 * `buildDynamicInstructionMessages` puts every session-scoped block first and every turn-scoped
 * block after; `applySystemCacheBreakpoint` marks the LAST block; `mergeSystemInstructions`
 * then joins them all into ONE system message with "\n\n", keeping that marker.
 */
function eveSystemFor(clock: string): SystemModelMessage {
  const sessionScoped = [PERSONA, FACTS, PROMPT_CACHE_BOUNDARY];
  const turnScoped = ["Answer in English.", clock];
  return { role: "system", content: [...sessionScoped, ...turnScoped].join("\n\n"), providerOptions: EVE_MARKER };
}

/** eve marks the last message and the most recent assistant message before it. */
function eveMessagesFor(turn: number): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let i = 1; i <= turn; i += 1) {
    messages.push({ role: "user", content: `message ${i}` });
    if (i < turn) messages.push({ role: "assistant", content: `reply ${i}` });
  }
  const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
  if (lastAssistant !== -1) messages[lastAssistant] = { ...messages[lastAssistant]!, providerOptions: EVE_MARKER } as ModelMessage;
  messages[messages.length - 1] = { ...messages[messages.length - 1]!, providerOptions: EVE_MARKER } as ModelMessage;
  return messages;
}

/** eve marks the last tool. */
function eveTools() {
  return {
    remind_set: tool({ description: "Set a reminder.", inputSchema: z.object({ when: z.string() }) }),
    note_read: { ...tool({ description: "Read a note.", inputSchema: z.object({ path: z.string() }) }), providerOptions: EVE_MARKER },
  };
}

const ANTHROPIC_REPLY = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "lares-brain",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

const CHAT_REPLY = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 0,
  model: "lares-brain",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

type Body = Record<string, unknown> & { system?: Array<Record<string, unknown>>; messages?: Array<Record<string, unknown>> };

function countCacheControl(body: Body): number {
  return (JSON.stringify(body).match(/"cache_control"/g) ?? []).length;
}

describe("splitAtBoundary", () => {
  it("splits at the marker and trims the whitespace eve's join leaves around it", () => {
    expect(splitAtBoundary(`stable\n\n${PROMPT_CACHE_BOUNDARY}\n\nvolatile`)).toEqual({ head: "stable", tail: "volatile" });
  });
  it("is undefined when there is no marker", () => {
    expect(splitAtBoundary("no marker here")).toBeUndefined();
  });
});

describe("shapeAnthropicBody", () => {
  const text = `stable\n\n${PROMPT_CACHE_BOUNDARY}\n\nvolatile`;

  it("MOVES an existing system breakpoint to the end of the stable part — the count does not grow", () => {
    const body = {
      tools: [{ name: "a" }, { name: "b", cache_control: EPHEMERAL }],
      system: [{ type: "text", text, cache_control: EPHEMERAL }],
      messages: [
        { role: "assistant", content: [{ type: "text", text: "x", cache_control: EPHEMERAL }] },
        { role: "user", content: [{ type: "text", text: "y", cache_control: EPHEMERAL }] },
      ],
    };
    const shaped = shapeAnthropicBody(body) as Body;
    expect(shaped.system).toEqual([
      { type: "text", text: "stable", cache_control: EPHEMERAL },
      { type: "text", text: "volatile" },
    ]);
    expect(countCacheControl(shaped)).toBe(MAX_CACHE_BREAKPOINTS);
  });

  it("adds a breakpoint when none was asked for and there is room", () => {
    const shaped = shapeAnthropicBody({ system: [{ type: "text", text }], messages: [] }) as Body;
    expect(shaped.system).toEqual([
      { type: "text", text: "stable", cache_control: EPHEMERAL },
      { type: "text", text: "volatile" },
    ]);
  });

  it("never adds a fifth breakpoint — Anthropic refuses more than four", () => {
    const marked = { type: "text", text: "m", cache_control: EPHEMERAL };
    const body = { system: [{ type: "text", text }], messages: [{ role: "user", content: [marked, marked, marked, marked] }] };
    const shaped = shapeAnthropicBody(body) as Body;
    expect(shaped.system).toEqual([{ type: "text", text: "stable" }, { type: "text", text: "volatile" }]);
    expect(countCacheControl(shaped)).toBe(MAX_CACHE_BREAKPOINTS);
  });

  it("accepts a plain string system prompt", () => {
    const shaped = shapeAnthropicBody({ system: text, messages: [] }) as Body;
    expect(shaped.system?.[0]).toEqual({ type: "text", text: "stable", cache_control: EPHEMERAL });
  });

  it("leaves a body without the marker as the very same object", () => {
    const body = { system: [{ type: "text", text: "plain", cache_control: EPHEMERAL }], messages: [] };
    expect(shapeAnthropicBody(body)).toBe(body);
  });
});

describe("reshapeJsonBody", () => {
  it("passes anything it cannot read through untouched", () => {
    const shape = vi.fn((b: unknown) => b);
    expect(reshapeJsonBody(undefined, shape)).toBeUndefined();
    const notJson = { method: "POST", body: `not json ${PROMPT_CACHE_BOUNDARY}` };
    expect(reshapeJsonBody(notJson, shape)).toBe(notJson);
    const noMarker = { method: "POST", body: JSON.stringify({ system: "x" }) };
    expect(reshapeJsonBody(noMarker, shape)).toBe(noMarker);
    expect(shape).not.toHaveBeenCalled();
  });
});

describe("stripBoundaryFromChatBody", () => {
  it("removes the marker from system messages and leaves one string", () => {
    const body = { messages: [{ role: "system", content: `stable\n\n${PROMPT_CACHE_BOUNDARY}\n\nvolatile` }, { role: "user", content: "hi" }] };
    expect(stripBoundaryFromChatBody(body)).toEqual({
      messages: [{ role: "system", content: "stable\n\nvolatile" }, { role: "user", content: "hi" }],
    });
  });
});

describe("through gatewayModel(), two turns of one session", () => {
  let dir: string;
  let keyPath: string;
  let bodies: Body[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-kit-prompt-cache-"));
    keyPath = join(dir, "gateway-key");
    writeFileSync(keyPath, "test-gateway-key\n", "utf8");
    delete process.env["GATEWAY_LANE"];
    bodies = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    delete process.env["GATEWAY_LANE"];
  });

  function fakeFetch(reply: unknown): void {
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    });
  }

  it("anthropic lane: the cached prefix is byte-identical across turns, and the breakpoint sits on it", async () => {
    fakeFetch(ANTHROPIC_REPLY);
    const { gatewayModel } = createGatewayProvider({ defaultKeyFile: keyPath });
    const clocks = ["Now: 2026-10-15 09:14", "Now: 2026-10-15 09:31"];
    for (const [i, clock] of clocks.entries()) {
      await runModelInvocation(captureModelInvocation({ type: 'step.started', data: { turnId: `turn-${i}`, sequence: i, stepIndex: 0 } }, { id: 'session', auth: { current: null, initiator: null } }, 'lares-brain'), () => generateText({ model: gatewayModel("lares-brain"), system: eveSystemFor(clock), messages: eveMessagesFor(i + 1), tools: eveTools() }));
    }

    const [first, second] = bodies as [Body, Body];
    // Anthropic caches in the order tools -> system -> messages, so the cached prefix is the
    // tools plus the first system block.
    const prefix = (b: Body) => JSON.stringify({ tools: b["tools"], system: b.system?.[0] });
    expect(prefix(second)).toBe(prefix(first));
    expect(first.system?.[0]).toMatchObject({ cache_control: EPHEMERAL });
    expect(first.system?.[0]?.["text"]).toBe(`${PERSONA}\n\n${FACTS}`);

    // The per-turn part follows, unmarked, and is what changed.
    expect(first.system?.[1]).toEqual({ type: "text", text: `Answer in English.\n\n${clocks[0]}` });
    expect(second.system?.[1]).toEqual({ type: "text", text: `Answer in English.\n\n${clocks[1]}` });

    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toContain(PROMPT_CACHE_BOUNDARY);
      expect(countCacheControl(body)).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
    }
  });

  it("openai-compatible lane: no cache_control, and the marker never reaches the model", async () => {
    process.env["GATEWAY_LANE"] = "openai-compatible";
    fakeFetch(CHAT_REPLY);
    const { gatewayModel } = createGatewayProvider({ defaultKeyFile: keyPath });
    await runModelInvocation(captureModelInvocation({ type: 'step.started', data: { turnId: 'turn', sequence: 0, stepIndex: 0 } }, { id: 'session', auth: { current: null, initiator: null } }, 'lares-brain'), () => generateText({ model: gatewayModel("lares-brain"), system: eveSystemFor("Now: 09:14"), messages: eveMessagesFor(1) }));

    const [body] = bodies as [Body];
    expect(JSON.stringify(body)).not.toContain(PROMPT_CACHE_BOUNDARY);
    expect(JSON.stringify(body)).not.toContain("cache_control");
    const system = body.messages?.filter((m) => m["role"] === "system") ?? [];
    expect(system).toHaveLength(1);
    expect(system[0]?.["content"]).toBe(`${PERSONA}\n\n${FACTS}\n\nAnswer in English.\n\nNow: 09:14`);
  });
});
