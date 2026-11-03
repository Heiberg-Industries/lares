/** HAND-RUN ONLY. Never part of `pnpm test`, never run by CI. Run it by the owner, with the owner's own key.
 *
 * Purpose: a fixture is what we believe the embeddings API does; this is what it does. The included gateway's
 * embedding alias (images/gateway-runtime/admission_contract.py, check_embedding_body and TerminalEvidence.embedding_usage)
 * branches on the provider's reply: `object` is "list", each item is `{object:"embedding", index:i, embedding:[...]}`,
 * `usage` carries integer `prompt_tokens` and `total_tokens` (and, for some providers, `completion_tokens: 0`), and the
 * request carries `encoding_format: "float"`, one to 32 string inputs, and nothing else. This probe calls the provider
 * DIRECTLY (not through the gateway) and checks each of those against the real service.
 *
 * ASSERTED (a failure here means the gateway's embedding contract is wrong for this provider):
 *   1. a normal 2-input call: HTTP 200, `object` "list", items in order with `object` "embedding" and `index` 0, 1,
 *      each embedding exactly 1024 finite numbers, `usage` with integer `prompt_tokens` and `total_tokens`, and
 *      `total_tokens` = `prompt_tokens` + `completion_tokens` (0 when absent).
 *   2. a 32-input call: HTTP 200 and 32 items; the size of the reply is printed against the gateway's 4 MiB cap.
 *   3. a wrong key: HTTP 401, with a JSON error body.
 * RECORDED (printed, not asserted; copy what differs into the notes below and into the contract if needed):
 *   4. `encoding_format: "base64"`: accepted or not, and whether `embedding` then comes back as a string. The gateway
 *      refuses base64 itself; this only says whether that refusal is stricter than the provider.
 *   5. a single input of more than 8192 tokens: the status and error shape (expected: a 4xx, not a charge).
 *   6. 33 inputs: the status and error shape (expected: a 4xx; the gateway refuses it before the provider anyway).
 *
 * It prints SHAPES only: status codes, key names, counts, lengths, byte sizes. Never the key, a vector, a response body
 * or an input. It spends a few thousand tokens of the provider's cheapest embedding model.
 *
 * Environment:
 *   LARES_PROBE_APPROVED=1       required: the calls are real and billed (a few cents at most)
 *   EMBED_PROBE_KEY_FILE         path to a file holding the provider key (never pass the key in argv or the environment)
 *   EMBED_PROBE_BASE_URL         optional, default https://api.mistral.ai/v1 (the version path, no trailing slash)
 *   EMBED_PROBE_MODEL            optional, default mistral-embed
 * Run: LARES_PROBE_APPROVED=1 EMBED_PROBE_KEY_FILE=/path/to/key pnpm -C services/keeper exec tsx tests/live/mistral-embeddings.live.mts
 * Record below, after a run: the date, the model, and any shape that differed from the fixtures.
 *   Last run: NOT YET RUN.
 */
import { readFileSync } from "node:fs";

if (process.env.LARES_PROBE_APPROVED !== "1") {
  console.log("LIVE VALIDATION PENDING: set LARES_PROBE_APPROVED=1 and EMBED_PROBE_KEY_FILE. The calls are real and billed. No network calls made.");
  process.exit(0);
}
const keyFile = process.env.EMBED_PROBE_KEY_FILE;
if (!keyFile) {
  console.log("LIVE VALIDATION PENDING: set EMBED_PROBE_KEY_FILE to a file holding the provider key. No network calls made.");
  process.exit(0);
}
const key = readFileSync(keyFile, "utf8").trim();
if (!key || /\s/.test(key)) throw new Error("the key file does not hold a single-line key");
const base = process.env.EMBED_PROBE_BASE_URL ?? "https://api.mistral.ai/v1";
const model = process.env.EMBED_PROBE_MODEL ?? "mistral-embed";
const url = new URL(base);
if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || base.endsWith("/"))
  throw new Error("EMBED_PROBE_BASE_URL must be an https address with no credentials, query or trailing slash");

const GATEWAY_RESPONSE_CAP = 4 * 1024 * 1024;
const failures: string[] = [];
const check = (name: string, ok: boolean, shape: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(shape)}`);
  if (!ok) failures.push(name);
};
const record = (name: string, shape: unknown) => console.log(`NOTE ${name}: ${JSON.stringify(shape)}`);
/** Key names and primitive types only, one level deep. Never a value. */
const shapeOf = (v: unknown): unknown =>
  Array.isArray(v) ? `array(${v.length})` : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Array.isArray(x) ? `array(${x.length})` : typeof x])) : typeof v;

async function embed(body: unknown, withKey = key): Promise<{ status: number; bytes: number; json: any }> {
  let response: Response;
  try {
    response = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${withKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    // The message could carry the address or a header; say only that the call failed.
    throw new Error("the embeddings call failed before any reply; provider details omitted");
  }
  const text = await response.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, bytes: Buffer.byteLength(text), json };
}

const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// 1. a normal call
{
  const r = await embed({ model, input: ["a short probe sentence", "another short probe sentence"], encoding_format: "float" });
  const data = Array.isArray(r.json?.data) ? r.json.data : [];
  const usage = r.json?.usage ?? {};
  check("normal call: status and list shape", r.status === 200 && r.json?.object === "list" && data.length === 2, { status: r.status, object: r.json?.object, items: data.length });
  check("normal call: items in order, each an embedding of 1024 finite numbers",
    data.every((item: any, i: number) => item?.object === "embedding" && item.index === i && Array.isArray(item.embedding) && item.embedding.length === 1024 && item.embedding.every((x: unknown) => typeof x === "number" && Number.isFinite(x))),
    { itemKeys: data[0] ? shapeOf(data[0]) : null });
  check("normal call: usage is integers and total = prompt + completion",
    integer(usage.prompt_tokens) && integer(usage.total_tokens) && usage.total_tokens === usage.prompt_tokens + (usage.completion_tokens ?? 0),
    { usageKeys: shapeOf(usage), completionTokensPresent: "completion_tokens" in usage, topLevelKeys: Object.keys(r.json ?? {}).sort() });
  record("normal call: reply bytes", { bytes: r.bytes });
}

// 2. the largest batch the gateway admits
{
  const input = Array.from({ length: 32 }, (_, i) => `probe sentence number ${i}`);
  const r = await embed({ model, input, encoding_format: "float" });
  check("32 inputs: status and item count", r.status === 200 && Array.isArray(r.json?.data) && r.json.data.length === 32, { status: r.status, items: r.json?.data?.length ?? null });
  check("32 inputs: reply is inside the gateway's 4 MiB cap", r.bytes < GATEWAY_RESPONSE_CAP, { bytes: r.bytes, cap: GATEWAY_RESPONSE_CAP });
}

// 3. a wrong key (never the real one)
{
  const r = await embed({ model, input: ["x"], encoding_format: "float" }, "invalid-probe-key");
  check("wrong key: status 401 with a JSON error", r.status === 401 && r.json !== undefined, { status: r.status, errorShape: shapeOf(r.json) });
}

// 4. base64 (recorded)
{
  const r = await embed({ model, input: ["x"], encoding_format: "base64" });
  record("base64 encoding_format", { status: r.status, embeddingType: typeof r.json?.data?.[0]?.embedding, errorShape: r.status === 200 ? null : shapeOf(r.json) });
}

// 5. one input of more than 8192 tokens (recorded)
{
  const long = "probe ".repeat(12_000);
  const r = await embed({ model, input: [long], encoding_format: "float" });
  record("one input over 8192 tokens", { status: r.status, errorShape: r.status === 200 ? null : shapeOf(r.json), usage: r.status === 200 ? shapeOf(r.json?.usage) : null });
}

// 6. 33 inputs (recorded)
{
  const r = await embed({ model, input: Array.from({ length: 33 }, (_, i) => `probe sentence number ${i}`), encoding_format: "float" });
  record("33 inputs", { status: r.status, items: r.json?.data?.length ?? null, errorShape: r.status === 200 ? null : shapeOf(r.json) });
}

if (failures.length) {
  console.error(`FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("PASS: the provider's embeddings API matches the gateway's contract. Record the date and any NOTE lines in this file's header.");
