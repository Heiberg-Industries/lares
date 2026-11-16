/**
 * services/box/tests/live/provider-models.live.mts — the LIVE probe for `../../lib/doctor.ts`'s
 * `testProviderKey` / `readProviderKeyResult` (`lares doctor --test-model` on an installation with
 * the built-in gateway).
 *
 * NOT part of `pnpm test`, and not run in CI. Run it BY HAND whenever the provider list or what a
 * provider answers is in doubt:
 *
 *     npx tsx services/box/tests/live/provider-models.live.mts
 *
 * With no key given it needs network access and nothing else: it asks each provider for its model
 * list with a key that is invalid on purpose, so it holds no secret and cannot spend money. Give a
 * real key file to check the accepted answer too (the model list is free; still, it is your key):
 *
 *     PROBE_ANTHROPIC_KEY_FILE=/path/to/key PROBE_OPENAI_KEY_FILE=/path/to/key \
 *       npx tsx services/box/tests/live/provider-models.live.mts
 *
 * WHY THIS FILE EXISTS. A fixture is what we believe an API does; only a live call is what it does.
 * The doctor reads three things from the provider's answer, and this probe checks each against the
 * real providers, through the doctor's own function:
 *   1. a key the provider does not accept answers 401 (or 403), never a 200, 404 or 5xx;
 *   2. that refusal is a JSON error envelope (it is not echoed; this only shows it is what we think);
 *   3. a key the provider accepts answers 200 with a `data` array (only with a real key file).
 *
 * WHAT IT PRINTS: the provider, the HTTP status, the content type, the error's `type` / `code`
 * fields and the doctor's verdict. Never a key, never a full body.
 *
 * LAST RUN: **2026-11-16**, fake key only. **PASS.**
 *   - anthropic `GET https://api.anthropic.com/v1/models`: HTTP 401, application/json,
 *     `error.type: "authentication_error"`; doctor verdict `refused`.
 *   - openai `GET https://api.openai.com/v1/models`: HTTP 401, application/json,
 *     `error.type: "invalid_request_error"`, `error.code: "invalid_api_key"`; doctor verdict `refused`.
 *   The accepted answer (3) has not been run here: it needs a real key.
 */
import { readFileSync } from "node:fs";
import { testProviderKey, type ProviderKeyTestDeps } from "../../lib/doctor.js";

// Obviously fake; never a real key.
const FAKE_KEY = "sk-lares-probe-invalid-key-0000000000000000";

const PROVIDERS: { provider: ProviderKeyTestDeps["provider"]; baseUrl: string; keyFile: string | undefined }[] = [
  { provider: "anthropic", baseUrl: "https://api.anthropic.com", keyFile: process.env.PROBE_ANTHROPIC_KEY_FILE },
  { provider: "openai", baseUrl: "https://api.openai.com/v1", keyFile: process.env.PROBE_OPENAI_KEY_FILE },
];

let failed = false;
for (const target of PROVIDERS) {
  // The raw answer, for the shape; then the doctor's own reading of it.
  const url = target.provider === "anthropic" ? `${target.baseUrl}/v1/models` : `${target.baseUrl}/models`;
  const headers: Record<string, string> = target.provider === "anthropic"
    ? { "x-api-key": FAKE_KEY, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${FAKE_KEY}` };
  const raw = await fetch(url, { headers: { ...headers, "user-agent": "lares-live-probe" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const contentType = (raw.headers.get("content-type") ?? "").split(";")[0]!.trim();
  let error: { type?: unknown; code?: unknown } = {};
  try { error = ((JSON.parse(await raw.text()) as { error?: typeof error }).error ?? {}); } catch { /* not JSON: reported below */ }
  const refused = await testProviderKey({ provider: target.provider, baseUrl: target.baseUrl, key: FAKE_KEY });
  console.log(`${target.provider} fake key: HTTP ${raw.status}, content-type ${contentType || "(none)"}, error.type ${String(error.type)}, error.code ${String(error.code)}, doctor verdict ${refused.verdict}`);
  if (raw.status !== 401 && raw.status !== 403) { console.error(`FAIL: ${target.provider} answered a fake key with HTTP ${raw.status}, not 401 or 403`); failed = true; }
  if (contentType !== "application/json") { console.error(`FAIL: ${target.provider}'s refusal is not JSON`); failed = true; }
  if (refused.verdict !== "refused") { console.error(`FAIL: the doctor read ${target.provider}'s refusal as ${refused.verdict}`); failed = true; }
  if (target.keyFile) {
    const accepted = await testProviderKey({ provider: target.provider, baseUrl: target.baseUrl, key: readFileSync(target.keyFile, "utf8").trim() });
    console.log(`${target.provider} real key: doctor verdict ${accepted.verdict}`);
    if (accepted.verdict !== "accepted") { console.error(`FAIL: the doctor did not read ${target.provider}'s answer to a real key as accepted`); failed = true; }
  }
}
if (failed) process.exit(1);
console.log("PASS");
