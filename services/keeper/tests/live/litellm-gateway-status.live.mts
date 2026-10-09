/** HAND-RUN ONLY. Never part of `pnpm test`, never run by CI. Not yet run (LAR-111 slice 1).
 *
 * Purpose: a fixture is what we believe the gateway does; this is what it does. It exercises every
 * branch the keeper's gateway adapter (services/keeper/lib/gateway-admin.ts) takes on a gateway
 * response, against a real gateway, using the SAME adapter code:
 *   1. GET /health/liveliness, no auth      -> `ok` (200) vs `unreachable` (anything else)
 *   2. GET /health/readiness, no auth       -> `ready` / `not-ready` (503 or db != "connected") / `unreadable`
 *   3. GET /v1/model/info, admin key        -> `ok` (envelope {data:[{model_name, litellm_params.model}]}),
 *      and that NO api_key / api_base value appears in what the adapter returns
 *   4. GET /v1/model/info, no key and a deliberately wrong key -> the refusal status that becomes `refused`
 *   5. The `unreachable` and 3xx branches: a closed local port, and the raw status of each route
 * Optional (--read-only-key, informational, for the later external-gateway ticket): mint a throwaway
 * `key_type: read_only` key with the admin key, read /v1/model/info with it, check whether it can read
 * an agent key's /key/info (the "both user_id empty" question in the plan), then delete it.
 * This one mints and deletes a key, so it is behind a flag and needs LARES_PROBE_APPROVED=1.
 *
 * It never calls GET /health (that sends a paid test request to every model) and sends no POST
 * except the optional key mint/delete above. It prints SHAPES only (status codes, key names, counts),
 * never a key, a URL with credentials, an api_base or a response body.
 *
 * Environment:
 *   GATEWAY_URL           e.g. http://127.0.0.1:4000 (origin only)
 *   GATEWAY_ADMIN_KEY_FILE  path to a file holding the gateway admin key (never pass the key in argv)
 *   LARES_ALIAS_PREFIX    optional, default "lares": reported as served / not served
 * Run: pnpm -C services/keeper exec tsx tests/live/litellm-gateway-status.live.mts
 * Record below, after a run: LiteLLM version, date, and any shape that differed from the fixtures.
 *   Last run: NOT YET RUN.
 */
import { readFileSync } from "node:fs";
import { GatewayAdmin, GATEWAY_ROUTES } from "../../lib/gateway-admin.js";

const url = process.env.GATEWAY_URL;
const keyFile = process.env.GATEWAY_ADMIN_KEY_FILE;
if (!url || !keyFile) {
  console.log("LIVE VALIDATION PENDING: set GATEWAY_URL and GATEWAY_ADMIN_KEY_FILE. No network calls made.");
  process.exit(0);
}
const key = readFileSync(keyFile, "utf8").trimEnd();
if (!key.startsWith("sk-") || key.length < 16) throw new Error("admin key file does not hold a gateway key");
const gw = new GatewayAdmin(url);
const origin = new URL(url).origin;
const failures: string[] = [];
const check = (name: string, ok: boolean, shape: unknown) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(shape)}`); if (!ok) failures.push(name); };
const shapeOf = (v: unknown): unknown => Array.isArray(v) ? `array(${v.length})` : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x])) : typeof v;
const raw = async (path: string, withKey?: string) => {
  const r = await gw.call(path, withKey);
  let body: unknown; try { body = await r.json(); } catch { body = undefined; }
  return { status: r.status, shape: shapeOf(body), body };
};

// 1. liveliness
const live = await raw(GATEWAY_ROUTES.liveliness);
check("liveliness raw status and body shape", live.status === 200, { status: live.status, shape: live.shape });
check("liveliness adapter -> ok", (await gw.liveliness()).kind === "ok", {});

// 2. readiness
const ready = await raw(GATEWAY_ROUTES.readiness);
const rb = ready.body as Record<string, unknown> | undefined;
check("readiness raw status and keys", ready.status === 200 || ready.status === 503, { status: ready.status, keys: rb && typeof rb === "object" ? Object.keys(rb) : null, db: typeof rb?.db === "string" ? rb.db : null });
check("readiness adapter result", ["ready", "not-ready"].includes((await gw.readiness()).kind), { kind: (await gw.readiness()).kind });

// 3. model info with the admin key
const info = await raw(GATEWAY_ROUTES.modelInfo, key);
const rows = Array.isArray((info.body as { data?: unknown })?.data) ? (info.body as { data: Record<string, unknown>[] }).data : [];
check("model info status and envelope", info.status === 200 && Array.isArray((info.body as { data?: unknown })?.data), { status: info.status, topLevelKeys: info.body && typeof info.body === "object" ? Object.keys(info.body) : null, deployments: rows.length });
check("every deployment has model_name and litellm_params.model", rows.every(r => typeof r.model_name === "string" && typeof (r.litellm_params as Record<string, unknown> | undefined)?.model === "string"),
  { withModelName: rows.filter(r => typeof r.model_name === "string").length, withTarget: rows.filter(r => typeof (r.litellm_params as Record<string, unknown> | undefined)?.model === "string").length });
const adapter = await gw.modelInfo(key);
check("model info adapter -> ok", adapter.kind === "ok", { kind: adapter.kind, aliases: adapter.kind === "ok" ? adapter.models.length : 0 });
check("adapter output carries no key or api_base", !JSON.stringify(adapter).includes(key) && !JSON.stringify(adapter).includes("api_base") && !JSON.stringify(adapter).includes("api_key"), {});
check("raw response: api_key / api_base values absent or redacted (informational: LiteLLM docstring says excluded)",
  rows.every(r => { const p = (r.litellm_params ?? {}) as Record<string, unknown>; return !p.api_key && !p.api_base; }),
  { deploymentsWithApiKeyField: rows.filter(r => (r.litellm_params as Record<string, unknown> | undefined)?.api_key).length, deploymentsWithApiBaseField: rows.filter(r => (r.litellm_params as Record<string, unknown> | undefined)?.api_base).length });
const prefix = process.env.LARES_ALIAS_PREFIX ?? "lares";
for (const purpose of ["brain", "writer", "utility", "gate", "embed"])
  console.log(`INFO ${prefix}-${purpose}: ${adapter.kind === "ok" && adapter.models.some(m => m.alias === `${prefix}-${purpose}`) ? "served" : "not served"}`);
console.log(`INFO model_group_alias entries present in the envelope: ${info.body && typeof info.body === "object" ? Object.keys(info.body).filter(k => k !== "data").join(",") || "none" : "n/a"}`);

// 4. refusal statuses
const none = await raw(GATEWAY_ROUTES.modelInfo);
const wrong = await raw(GATEWAY_ROUTES.modelInfo, "sk-deliberately-wrong-0000000000");
check("no key -> 401/403", [401, 403].includes(none.status), { status: none.status });
check("wrong key -> 401/403", [401, 403].includes(wrong.status), { status: wrong.status });
check("adapter maps a wrong key to refused", (await gw.modelInfo("sk-deliberately-wrong-0000000000")).kind === "refused", {});

// 5. unreachable branch: a closed local port
const closed = new GatewayAdmin("http://127.0.0.1:9");
check("closed port -> unreachable (liveliness, readiness) and unavailable (model info)",
  (await closed.liveliness()).kind === "unreachable" && (await closed.readiness()).kind === "unreachable" && (await closed.modelInfo(key)).kind === "unavailable", {});
// Redirects are never followed: report what each route's status class is on this gateway.
for (const path of Object.values(GATEWAY_ROUTES)) {
  const r = await gw.call(path, path === GATEWAY_ROUTES.modelInfo ? key : undefined);
  check(`${path} does not redirect`, r.status < 300 || r.status >= 400, { status: r.status });
}

// Optional: read-only key questions for the later external-gateway ticket. Mints then deletes a key.
if (process.argv.includes("--read-only-key")) {
  if (process.env.LARES_PROBE_APPROVED !== "1") throw new Error("--read-only-key mints a key: set LARES_PROBE_APPROVED=1");
  const roKey = `sk-probe-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const post = (path: string, body: unknown, auth: string) => fetch(`${origin}${path}`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const minted = await post("/key/generate", { key: roKey, key_type: "read_only", key_alias: "lares-probe-read-only", duration: "1h" }, key);
    console.log(`INFO mint read_only key: status ${minted.status}`);
    if (minted.status === 200) {
      const seen = await gw.modelInfo(roKey);
      console.log(`INFO read_only key on /v1/model/info: ${seen.kind}${seen.kind === "ok" ? ` (${seen.models.length} aliases)` : ""}`);
      const agentKeyFile = process.env.GATEWAY_AGENT_KEY_FILE;
      if (agentKeyFile) {
        const { createHash } = await import("node:crypto");
        const hash = createHash("sha256").update(readFileSync(agentKeyFile, "utf8").trimEnd()).digest("hex");
        const other = await post("/v2/key/info", { keys: [hash] }, roKey);
        console.log(`INFO read_only key reading an agent key's info: status ${other.status} (200 means it CAN read other keys)`);
      } else console.log("INFO set GATEWAY_AGENT_KEY_FILE to also test reading an agent key's info");
    }
  } finally {
    const del = await post("/key/delete", { keys: [roKey] }, key);
    console.log(`INFO delete throwaway key: status ${del.status}`);
  }
}

console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "ALL CHECKS PASSED");
process.exitCode = failures.length ? 1 : 0;
