/**
 * tests/live/mcp-connection.live.mts — the LIVE check of what an outside (MCP) tool server really
 * does, before the engine's outside-tools code is trusted against it.
 *
 * NOT part of `pnpm test` and never run in CI: it calls a real server with a real key. Run it by
 * hand when an outside tool is added, or when the engine's outside-tool handling changes:
 *
 *     MCP_URL=https://tools.example.org/mcp MCP_TOKEN=... \
 *       npx tsx packages/agent-kit/tests/live/mcp-connection.live.mts
 *
 * WHAT IT DOES. The same three steps eve's MCP client does over Streamable HTTP: `initialize`
 * (then the `initialized` notification), `tools/list`, and, if you name one, a single read call.
 * It prints the tool names and descriptions (the descriptions are what the model will be shown, so
 * read them for anything that looks like an instruction), whether the server sent its own
 * `instructions`, and how a wrong key is answered.
 *
 * ENVIRONMENT.
 *   MCP_URL        required. The server address, exactly as in the definition's `outsideTools[].url`.
 *   MCP_TOKEN      optional. Sent as `Authorization: Bearer ...`. Never printed.
 *   MCP_READ_TOOL  optional. A tool name from the list to call once. Use a READ tool only.
 *   MCP_READ_ARGS  optional. The call's arguments as JSON, default {}.
 *   MCP_ALLOW      optional. The entry's tools.allow, comma separated; the fingerprint the engine
 *                  pins covers only these. Default: every listed tool.
 *   EGRESS_PROXY_URL  optional. When set, an https MCP_URL goes through this CONNECT proxy, the way
 *                  an agent's call goes through squid inside the box.
 *
 * Exit code 0 only when initialize and tools/list both succeeded (and the read call, if asked for).
 */
import { ProxyAgent, fetch as undiciFetch } from "undici";

import { descriptionsHash } from "../../src/outside-pins.js";

const url = process.env["MCP_URL"];
const token = process.env["MCP_TOKEN"];
const readTool = process.env["MCP_READ_TOOL"];
const readArgs = process.env["MCP_READ_ARGS"] ?? "{}";
const proxyUrl = process.env["EGRESS_PROXY_URL"];

if (!url) {
  console.error("Set MCP_URL (and MCP_TOKEN if the server needs a key). See the header of this file.");
  process.exit(2);
}

const dispatcher = proxyUrl && url.startsWith("https:") ? new ProxyAgent(proxyUrl) : undefined;
let sessionId: string | undefined;
let nextId = 1;

interface RpcResult { status: number; body: unknown; headers: Headers }

/** One JSON-RPC POST. The server may answer with plain JSON or a one-event SSE stream. */
async function rpc(method: string, params: unknown, opts: { notify?: boolean; withToken?: boolean } = {}): Promise<RpcResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  if (token && opts.withToken !== false) headers["authorization"] = `Bearer ${token}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const message = opts.notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params };
  const res = await undiciFetch(url as string, { method: "POST", headers, body: JSON.stringify(message), ...(dispatcher ? { dispatcher } : {}) });
  const text = await res.text();
  sessionId = res.headers.get("mcp-session-id") ?? sessionId;
  let body: unknown = text;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    try { body = JSON.parse(data); } catch { body = data; }
  } else {
    try { body = text === "" ? null : JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body, headers: res.headers as unknown as Headers };
}

const result = (r: RpcResult) => (r.body as { result?: Record<string, unknown> } | null)?.result;
let failed = false;
const fail = (why: string) => { failed = true; console.error(`FAIL: ${why}`); };

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "lares-live-probe", version: "0" },
});
console.log(`initialize -> HTTP ${init.status}`);
const initResult = result(init);
if (init.status !== 200 || !initResult) {
  fail(`initialize did not succeed: ${JSON.stringify(init.body).slice(0, 300)}`);
} else {
  const info = initResult["serverInfo"] as { name?: string; version?: string } | undefined;
  console.log(`  server: ${info?.name ?? "?"} ${info?.version ?? ""}, protocol ${String(initResult["protocolVersion"])}`);
  console.log(`  server instructions: ${typeof initResult["instructions"] === "string" ? JSON.stringify(initResult["instructions"]) : "(none)"}`);
  await rpc("notifications/initialized", {}, { notify: true });

  const list = await rpc("tools/list", {});
  console.log(`tools/list -> HTTP ${list.status}`);
  const tools = (result(list)?.["tools"] as Array<{ name: string; description?: string }> | undefined) ?? [];
  if (list.status !== 200 || tools.length === 0) fail(`tools/list gave no tools: ${JSON.stringify(list.body).slice(0, 300)}`);
  for (const t of tools) console.log(`  - ${t.name}: ${(t.description ?? "(no description)").replace(/\s+/g, " ")}`);
  // The engine pins a fingerprint of the ALLOWED tools' name, description and input schema the first
  // time an agent uses an entry, and compares it at every session start (outside-pins.ts). Set
  // MCP_ALLOW to the entry's tools.allow (comma separated) to see the value it would record; run twice
  // to confirm the server's answer is stable between calls (a server that varies it would trip the check).
  const allow = (process.env["MCP_ALLOW"] ?? tools.map((t) => t.name).join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  console.log(`  description fingerprint for [${allow.join(", ")}]: ${descriptionsHash(tools as never, allow)}`);

  if (readTool) {
    if (!tools.some((t) => t.name === readTool)) {
      fail(`${readTool} is not in the tool list`);
    } else {
      const call = await rpc("tools/call", { name: readTool, arguments: JSON.parse(readArgs) });
      console.log(`tools/call ${readTool} -> HTTP ${call.status}`);
      console.log(`  ${JSON.stringify(result(call) ?? call.body).slice(0, 1000)}`);
      if (call.status !== 200 || result(call)?.["isError"] === true) fail("the read call did not succeed");
    }
  }
}

if (token) {
  // How a wrong key is answered: the engine's key-refused signal depends on eve seeing this as an
  // authorization problem, so look at what this server actually sends.
  sessionId = undefined;
  nextId = 1;
  const wrong = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lares-live-probe", version: "0" } }, { withToken: false });
  console.log(`initialize WITHOUT the key -> HTTP ${wrong.status} (a server that checks keys answers 401 or 403)`);
}

console.log(failed ? "RESULT: FAILED" : "RESULT: ok");
process.exit(failed ? 1 : 0);
