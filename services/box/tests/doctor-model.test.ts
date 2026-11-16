// services/box/tests/doctor-model.test.ts — `lares doctor --test-model`, one real
// completion.
//
// `readModelTestResult` is PURE (given a status and a body, never fetches). `testModel` is the
// one function in this repository allowed to call the gateway for a diagnostic — and only when a
// caller supplies gatewayUrl/key/alias explicitly; see lib/doctor.ts's header and bin/doctor.ts's
// `--test-model` flag (`lares doctor` alone never calls out).
import { describe, it, expect, vi } from "vitest";
import { readModelTestResult, readProviderKeyResult, testModel, testProviderKey } from "../lib/doctor.js";

describe("testing the model key with a real completion", () => {
  it("reads a normal answer as ok", () => {
    const r = readModelTestResult(200, JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
    expect(r.verdict).toBe("ok");
  });

  it("reads 401 as the key being wrong, and says where the key lives", () => {
    const r = readModelTestResult(401, '{"error":{"message":"Invalid API key"}}');
    expect(r.verdict).toBe("unauthorised");
    expect(r.say).toContain("GATEWAY_KEY_FILE");
  });

  it("reads a budget refusal as over-budget on either status the gateway uses", () => {
    // packages/agent-kit/src/gateway-budget.ts recognises budget_exceeded on 400 AND 429.
    for (const status of [400, 429]) {
      expect(readModelTestResult(status, '{"error":{"type":"budget_exceeded","message":"x"}}').verdict)
        .toBe("over-budget");
    }
  });

  it("reads an unknown alias as no-such-model", () => {
    const r = readModelTestResult(400, '{"error":{"message":"model not found: lares-brain"}}');
    expect(r.verdict).toBe("no-such-model");
  });

  // MEASURED 2026-09-21 against a real LiteLLM v1.99.1 (tests/live/gateway-completion.live.mts).
  // This is the exact envelope that gateway returns when the alias asked for is one the key may
  // not use, and it is the case this module got WRONG until that probe was run: a 403 read by
  // status alone became "the gateway rejected the key", so a mistyped LARES_MODEL_ALIAS at
  // install time sent the owner off to replace a key that was never the problem.
  it("reads a 403 that refuses the MODEL as no-such-model, never as a bad key", () => {
    const body = JSON.stringify({
      error: {
        message:
          "key not allowed to access model. This key can only access models=['fixture-alias']. " +
          "Tried to access definitely-not-a-real-alias-xyz",
        type: "key_model_access_denied",
        param: "model",
        code: "403",
      },
    });
    const r = readModelTestResult(403, body);
    expect(r.verdict).toBe("no-such-model");
    expect(r.say).toContain("LARES_MODEL_ALIAS");
    // The owner must not be sent to the key file for a problem that is not the key's.
    expect(r.say).not.toContain("GATEWAY_KEY_FILE");
  });

  // MEASURED 2026-09-21 against a real LiteLLM v1.101.0
  // (packages/agent-kit/tests/live/litellm-budget-refusal.live.mts, first ever run). A spending
  // cap that bites answers **429**, not the 400 this repository assumed from a 2026-09-01
  // measurement. It is recognised by `error.type`, not by status — which is the only reason
  // the status change did not break it. Pinned here so a future reader by status alone fails
  // loudly: a budget refusal is a WARNING about money, never a fault in the key or the model,
  // and reading it as either sends the owner to fix something that is not broken.
  it("reads the measured 429 budget refusal as over-budget, not as a bad key or a bad model", () => {
    const body = JSON.stringify({
      error: {
        message: "Budget has been exceeded! Key=fixture-probe-key (sk-...redacted)",
        type: "budget_exceeded",
        param: null,
        code: "429",
      },
    });
    const r = readModelTestResult(429, body);
    expect(r.verdict).toBe("over-budget");
    expect(r.say).not.toContain("GATEWAY_KEY_FILE");
    expect(r.say).not.toContain("LARES_MODEL_ALIAS");
  });

  it("reads a budget refusal as over-budget whatever the status, since the type is the signal", () => {
    const body = '{"error":{"type":"budget_exceeded","message":"Budget has been exceeded!"}}';
    // 400 was the 2026-09-01 measurement, 429 the 2026-09-21 one. Both must read the same.
    expect(readModelTestResult(400, body).verdict).toBe("over-budget");
    expect(readModelTestResult(429, body).verdict).toBe("over-budget");
  });

  it("still reads a 403 that says nothing about a model as the key being wrong", () => {
    const r = readModelTestResult(403, '{"error":{"message":"Forbidden"}}');
    expect(r.verdict).toBe("unauthorised");
  });

  it("reads a bare 404 as no-such-model even without a recognisable message", () => {
    const r = readModelTestResult(404, "{}");
    expect(r.verdict).toBe("no-such-model");
  });

  it("reads a 5xx as a failure, never a pass — the gateway answered, but not with a completion", () => {
    const r = readModelTestResult(503, "Service Unavailable");
    expect(r.verdict).toBe("unreadable");
    expect(r.say).not.toBe("");
  });

  it("reads a 200 with no completion shape as unreadable, never ok (fail-safe on an unrecognised body)", () => {
    const r = readModelTestResult(200, JSON.stringify({ ok: true }));
    expect(r.verdict).toBe("unreadable");
  });

  it("never repeats the gateway's body back, and never carries the key", async () => {
    const fetch = vi.fn(async () => new Response('{"error":{"message":"sk-secret-leaked"}}', { status: 401 }));
    const r = await testModel({ gatewayUrl: "http://gateway:4000", key: "sk-disposable-fixture-only", alias: "lares-brain", fetch: fetch as unknown as typeof globalThis.fetch });
    expect(r.say).not.toContain("sk-secret-leaked");
    expect(r.say).not.toContain("sk-disposable-fixture-only");
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-disposable-fixture-only");
    expect(init.method).toBe("POST");
  });

  it("reads a dead hop as unreachable rather than throwing", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const r = await testModel({ gatewayUrl: "http://gateway:4000", key: "k", alias: "a", fetch: fetch as unknown as typeof globalThis.fetch });
    expect(r.verdict).toBe("unreachable");
  });

  it("times out hard rather than waiting for a hung connection — a real but tiny timeout, never a long wait", async () => {
    // The stub fetch never resolves on its own; it only rejects when the request's own abort
    // signal fires, exactly like a real hung TCP connection would once aborted. `timeoutMs: 5`
    // keeps this a real timer, not a fake clock, while staying far short of "a real long wait".
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "TimeoutError"));
          });
        }),
    );
    const start = Date.now();
    const r = await testModel({
      gatewayUrl: "http://gateway:4000",
      key: "k",
      alias: "a",
      timeoutMs: 5,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(r.verdict).toBe("unreachable");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("sends the smallest possible request to the router route, with no key anywhere but the header", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }));
    await testModel({ gatewayUrl: "http://gateway:4000", key: "sk-disposable-fixture-only", alias: "lares-brain", fetch: fetch as unknown as typeof globalThis.fetch });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gateway:4000/v1/messages");
    const body = JSON.parse(init.body as string) as { model: string; max_tokens: number; messages: unknown[] };
    expect(body.model).toBe("lares-brain");
    expect(body.max_tokens).toBeLessThanOrEqual(16);
    expect(body.messages).toHaveLength(1);
    // The key belongs in the x-api-key header only — never in the URL or the request body.
    expect(url).not.toContain("sk-disposable-fixture-only");
    expect(init.body as string).not.toContain("sk-disposable-fixture-only");
  });
});

describe("the built-in gateway's refusal of a call it was not approved for", () => {
  it("reads the gateway's budget_admission_refused as nothing tested, never as a bad key or a bad model", () => {
    // images/gateway-runtime/lares_gateway.py: HTTP 400, this exact envelope, for a call with no budget ticket.
    const body = JSON.stringify({ error: { type: "budget_admission_refused", code: "budget_admission_refused", message: "I could not verify permission to spend. Please check the gateway setup." } });
    const r = readModelTestResult(400, body);
    expect(r.verdict).toBe("admission-refused");
    expect(r.say).not.toContain("GATEWAY_KEY_FILE");
    expect(r.say).toContain("cannot send a test completion");
  });
});

describe("testing the installation's provider key with the provider's free model list", () => {
  const anthropic = { provider: "anthropic" as const, baseUrl: "https://api.anthropic.com" };
  const openai = { provider: "openai" as const, baseUrl: "https://api.openai.com/v1" };
  const KEY = "sk-disposable-fixture-only";
  // The bodies MEASURED by tests/live/provider-models.live.mts for a key the provider does not accept.
  const anthropicRefusal = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
  const openaiRefusal = JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", param: null, code: "invalid_api_key" } });

  it("reads 401 as a refused key, and says so plainly", () => {
    for (const body of [anthropicRefusal, openaiRefusal]) {
      const r = readProviderKeyResult(401, body);
      expect(r.verdict).toBe("refused");
      expect(r.say).toContain("The provider key was refused");
      expect(r.say).toContain("HTTP 401");
    }
  });

  it("does not call a 403 a refused key: the provider may be refusing this server's country or region", () => {
    const r = readProviderKeyResult(403, "{}");
    expect(r.verdict).toBe("forbidden");
    expect(r.say).toContain("refused the request (HTTP 403)");
    expect(r.say).not.toContain("The provider key was refused");
  });

  it("reads a 404 or 405 as a provider with no model list, never as something to retry", () => {
    for (const status of [404, 405]) {
      const r = readProviderKeyResult(status, "{}");
      expect(r.verdict).toBe("no-model-list");
      expect(r.say).toContain("there is no model list at this address");
    }
  });

  it("reads a 200 model list as accepted, and anything else as not an answer about the key", () => {
    expect(readProviderKeyResult(200, JSON.stringify({ data: [{ id: "claude-x", type: "model" }], has_more: false })).verdict).toBe("accepted");
    expect(readProviderKeyResult(200, JSON.stringify({ object: "list", data: [] })).verdict).toBe("accepted");
    for (const [status, body] of [[200, "{}"], [200, "not json"], [429, "{}"], [500, "{}"]] as const)
      expect(readProviderKeyResult(status, body).verdict).toBe("unreadable");
  });

  it("asks Anthropic's /v1/models with the key in x-api-key only, and never repeats the key or the body", async () => {
    const fetch = vi.fn(async () => new Response(anthropicRefusal, { status: 401 }));
    const r = await testProviderKey({ ...anthropic, key: KEY, fetch: fetch as unknown as typeof globalThis.fetch });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    expect(r.verdict).toBe("refused");
    expect(r.say).not.toContain(KEY);
    expect(r.say).not.toContain("invalid x-api-key");
  });

  it("asks OpenAI's /models under its /v1 base with a Bearer key", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ object: "list", data: [{ id: "gpt-x" }] }), { status: 200 }));
    const r = await testProviderKey({ ...openai, key: KEY, fetch: fetch as unknown as typeof globalThis.fetch });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(r.verdict).toBe("accepted");
  });

  it("reads a provider it cannot reach as unreachable, naming the host and not the key", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const r = await testProviderKey({ ...anthropic, key: KEY, fetch: fetch as unknown as typeof globalThis.fetch });
    expect(r.verdict).toBe("unreachable");
    expect(r.say).toContain("api.anthropic.com");
    expect(r.say).not.toContain(KEY);
  });
});
