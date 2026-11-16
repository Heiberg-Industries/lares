/**
 * tests/live/provider-refusal.live.mts — the LIVE probe for the provider-refusal settlement in
 * `../../src/gateway-admission-protocol.ts` (`GATEWAY_PROVIDER_REFUSAL_STATUSES`, the
 * `provider-refusal` receipt) and the gateway transport that sends it
 * (`images/gateway-runtime/lares_gateway.py`, `OneShotTransport`).
 *
 * NOT part of `pnpm test`, and not run in CI. It needs network access and nothing else: it sends
 * one tiny request per provider with a key that is invalid on purpose, so it uses no real secret
 * and cannot spend money. Run it by hand whenever the provider list or the refusal rule is in doubt:
 *
 *     npx tsx packages/agent-kit/tests/live/provider-refusal.live.mts
 *
 * Another OpenAI-compatible provider can be added for one run, with its own base URL and model:
 *
 *     PROBE_OPENAI_COMPATIBLE_URL=https://api.provider.example/v1 PROBE_OPENAI_COMPATIBLE_MODEL=some-model \
 *       npx tsx packages/agent-kit/tests/live/provider-refusal.live.mts
 *
 * WHY THIS FILE EXISTS. A fixture is what we believe an API does; only a live call is what it does.
 * The gateway gives a call's reservation back at once when the provider's own response status is
 * 401 or 403, because the provider refused the call before doing any work. That rests on two
 * beliefs this probe checks against the real providers:
 *   1. A refused key gets 401 (or 403), never 429, 5xx or a 200 with an error inside it.
 *   2. Asking for a stream does not change that: the refusal comes as one JSON body with the
 *      error status, not as an event stream that could carry output first.
 * It then feeds each real status through the protocol's own receipt schema, which must accept it.
 *
 * WHAT IT PRINTS: the provider name, the HTTP status, the content type and the error's `type` /
 * `code` fields. Never the request key (it is a fixed fake), never a full body.
 *
 * 403 is not produced here: it needs a real key that lacks a permission, and this probe holds no
 * real key. The providers document it as a permission refusal sent before any work (Anthropic
 * `permission_error`; OpenAI's 403 for a key, project or region that may not use the API).
 *
 * LAST RUN: **2026-11-16**. **PASS.** Each provider refused the fake key with a streaming request:
 *   - anthropic: HTTP 401, `application/json`, `error.type: "authentication_error"`.
 *   - openai: HTTP 401, `text/plain` (a JSON body under that content type),
 *     `error.type: "invalid_request_error"`, `error.code: "invalid_api_key"`.
 *   - an OpenAI-compatible EU provider (`https://api.mistral.ai/v1`): HTTP 401, `application/json`.
 * None answered with an event stream, a 429, a 5xx or a 200.
 */
import { GATEWAY_PROVIDER_REFUSAL_STATUSES, gatewaySettleSchema } from "../../src/gateway-admission-protocol.js";

// Obviously fake; never a real key. The probe sends nothing else that identifies anyone.
const FAKE_KEY = "sk-lares-probe-invalid-key-0000000000000000";

interface Target { name: string; url: string; headers: Record<string, string>; body: unknown }

function targets(): Target[] {
  const list: Target[] = [
    {
      name: "anthropic",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": FAKE_KEY, "anthropic-version": "2023-06-01" },
      body: { model: "claude-haiku-4-5", max_tokens: 1, stream: true, messages: [{ role: "user", content: "probe" }] },
    },
    {
      name: "openai",
      url: "https://api.openai.com/v1/chat/completions",
      headers: { authorization: `Bearer ${FAKE_KEY}` },
      body: { model: "gpt-4o-mini", max_tokens: 1, stream: true, messages: [{ role: "user", content: "probe" }] },
    },
  ];
  const extra = process.env.PROBE_OPENAI_COMPATIBLE_URL, model = process.env.PROBE_OPENAI_COMPATIBLE_MODEL;
  if (extra && model) list.push({
    name: "openai-compatible",
    url: extra.replace(/\/$/, "") + "/chat/completions",
    headers: { authorization: `Bearer ${FAKE_KEY}` },
    body: { model, max_tokens: 1, stream: true, messages: [{ role: "user", content: "probe" }] },
  });
  return list;
}

const grant = {
  version: 1 as const, nonce: "1".repeat(64), requestHash: "2".repeat(64), profileHash: "3".repeat(64), endpointHash: "4".repeat(64),
  keyFingerprint: "5".repeat(64), purposeAlias: "probe", attemptId: "11111111-1111-4111-8111-111111111111",
  bindingId: "22222222-2222-4222-8222-222222222222", providerKey: "installation" as const,
};

let failed = false;
for (const target of targets()) {
  const response = await fetch(target.url, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", "user-agent": "lares-live-probe", ...target.headers },
    body: JSON.stringify(target.body),
  });
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const text = (await response.text()).slice(0, 4096);
  let error: { type?: unknown; code?: unknown } = {};
  try { const parsed = JSON.parse(text); error = (parsed?.error ?? {}) as typeof error; } catch { /* not JSON: reported below */ }
  console.log(`${target.name}: HTTP ${response.status}, content-type ${contentType || "(none)"}, error.type ${String(error.type)}, error.code ${String(error.code)}`);
  const refusal = (GATEWAY_PROVIDER_REFUSAL_STATUSES as readonly number[]).includes(response.status);
  if (!refusal) { console.error(`FAIL: ${target.name} answered a refused key with HTTP ${response.status}, not 401 or 403`); failed = true; continue; }
  if (contentType === "text/event-stream") { console.error(`FAIL: ${target.name} answered a refused streaming call with an event stream`); failed = true; continue; }
  const receipt = { ...grant, kind: "provider-refusal" as const, status: response.status, receiptHash: "6".repeat(64) };
  if (!gatewaySettleSchema.safeParse(receipt).success) { console.error(`FAIL: the protocol schema refused the real status ${response.status}`); failed = true; continue; }
  console.log(`${target.name}: PASS`);
}
if (failed) process.exit(1);
console.log("PASS: every provider refused the fake key with 401 or 403, before any stream");
