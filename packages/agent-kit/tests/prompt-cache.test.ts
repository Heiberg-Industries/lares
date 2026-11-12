import { captureModelInvocation, runModelInvocation } from '../src/model-invocation.js';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// What eve puts on a message or a tool when it detects an Anthropic provider
// (`harness/prompt-cache.js`, `ANTHROPIC_CACHE_MARKERS["5m"]`; unchanged through 1.0.0-rc.10).
const EVE_MARKER = { anthropic: { cacheControl: EPHEMERAL }, bedrock: { cachePoint: { type: "default" } } };

// Long enough to look like a persona; the exact size does not matter to the shaping.
const PERSONA = "# Persona\n\n" + "I keep the owner's week in order. ".repeat(200).trimEnd();
const FACTS = "## What the owner has told me\n\n- Prefers mornings.";

/**
 * The system prompt as eve 1.0.0-rc.10 builds it for one turn of a door conversation (Slack,
 * Telegram). Every instruction file of a role is its own section; the role has no static
 * instructions, so eve sends them as ONE system message joined with "\n\n" and puts NO cache
 * marker on it (`harness/model-call/request.js`, `modelInstructions`: it marks only the first,
 * static section, which is empty here). The captured private-console requests further down
 * show the same shape with an empty per-turn part.
 */
function eveSystemFor(clock: string): SystemModelMessage {
  const sessionScoped = [PERSONA, FACTS, PROMPT_CACHE_BOUNDARY];
  const turnScoped = ["Answer in English.", clock];
  return { role: "system", content: [...sessionScoped, ...turnScoped].join("\n\n") };
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

  // The shape eve sent up to 1.0.0-rc.9 (one merged system message carrying eve's own marker).
  // rc.10 no longer sends it; the code still handles it, so the case stays pinned.
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

/**
 * Real request bodies, captured offline from the compiled chief-of-staff role on eve
 * 1.0.0-rc.10 (`fixtures/prompt-cache-eve-rc10-capture.json` says how). Two turns of one
 * conversation, the second with a tool call: `before` is what the AI SDK handed the gateway
 * provider's fetch, `wire` is what left it.
 */
describe("eve 1.0.0-rc.10 request bodies, as captured from the real role", () => {
  type Block = Record<string, unknown> & { type: string; text?: string; cache_control?: unknown };
  type Captured = { label: string; before: Body & { tools: Block[] }; wire: Body & { tools: Block[] } };
  const { requests } = JSON.parse(
    readFileSync(new URL("./fixtures/prompt-cache-eve-rc10-capture.json", import.meta.url), "utf8"),
  ) as { requests: Captured[] };

  /** Where every cache_control sits, as readable paths. */
  function markerPaths(body: Body & { tools: Block[] }): string[] {
    const paths: string[] = [];
    body.tools.forEach((t, i) => t.cache_control !== undefined && paths.push(`tools[${i}]`));
    (body.system as Block[]).forEach((s, i) => s.cache_control !== undefined && paths.push(`system[${i}]`));
    (body.messages as Array<{ content: Block[] }>).forEach((m, i) =>
      m.content.forEach((p, j) => p.cache_control !== undefined && paths.push(`messages[${i}].content[${j}]`)),
    );
    return paths;
  }

  /** The cached prefix Anthropic keys the system breakpoint on: the tools, then the marked system block. */
  const stablePrefix = (body: Body) => JSON.stringify({ tools: body["tools"], system: body.system?.[0] });

  it("holds two turns with a tool call", () => {
    expect(requests).toHaveLength(3);
    const last = requests[2]!.wire.messages!;
    expect(JSON.stringify(last)).toContain('"type":"tool_use"');
    expect(JSON.stringify(last)).toContain('"type":"tool_result"');
  });

  it("eve sends ONE system block with no cache marker, ending at the boundary, and leaves room for one", () => {
    for (const { before } of requests) {
      const system = before.system as Block[];
      expect(system).toHaveLength(1);
      expect(system[0]!.cache_control).toBeUndefined();
      expect(system[0]!.text!.endsWith(`\n\n${PROMPT_CACHE_BOUNDARY}`)).toBe(true);
      expect(countCacheControl(before)).toBeLessThan(MAX_CACHE_BREAKPOINTS);
    }
  });

  it("the shaping turns each captured body into exactly the captured wire body", () => {
    for (const { before, wire } of requests) expect(shapeAnthropicBody(before)).toEqual(wire);
  });

  const shaped = () => requests.map(({ before }) => shapeAnthropicBody(before) as Body & { tools: Block[] });

  it("on the wire: the last tool, the session-stable system block and eve's two conversation markers, never more than four", () => {
    for (const wire of shaped()) {
      const messages = wire.messages as Array<{ role: string; content: Block[] }>;
      const at = (i: number) => `messages[${i}].content[${messages[i]!.content.length - 1}]`;
      const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
      expect(markerPaths(wire)).toEqual([
        `tools[${wire.tools.length - 1}]`,
        "system[0]",
        ...(lastAssistant === -1 ? [] : [at(lastAssistant)]),
        at(messages.length - 1),
      ]);
      expect(countCacheControl(wire)).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
      expect(JSON.stringify(wire)).not.toContain(PROMPT_CACHE_BOUNDARY);
    }
  });

  it("the tools and the session-stable system block are byte-identical across both turns and every step", () => {
    const [first, ...rest] = shaped().map(stablePrefix);
    expect(JSON.parse(first!).system).toMatchObject({ type: "text", cache_control: EPHEMERAL });
    for (const prefix of rest) expect(prefix).toBe(first);
  });

  it("a door turn's per-turn text after the boundary stays outside the cached prefix", () => {
    // Same captured bodies with the per-turn tail a door conversation has (language line, clock),
    // a different clock on each turn: the marked block is unchanged, the tail follows unmarked.
    const shaped = requests.map(({ before, wire }, i) => {
      const system = [{ ...(before.system as Block[])[0]!, text: `${(before.system as Block[])[0]!.text}\n\nAnswer in English.\n\nNow: 09:${10 + i}` }];
      const body = shapeAnthropicBody({ ...before, system }) as Body & { tools: Block[] };
      expect(body.system?.[0]).toEqual(wire.system?.[0]);
      expect(body.system?.[1]).toEqual({ type: "text", text: `Answer in English.\n\nNow: 09:${10 + i}` });
      expect(countCacheControl(body)).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
      return body;
    });
    for (const body of shaped) expect(stablePrefix(body)).toBe(stablePrefix(shaped[0]!));
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
