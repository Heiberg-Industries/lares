/**
 * tests/live/mcp-server.live.mts — LIVE probe of a remote MCP server (streamable HTTP).
 *
 * NOT part of `pnpm test`: it calls a real server. Run it by hand whenever the Connect screen's
 * discovery or the read-only hint handling changes. The address and token come from the environment
 * only; nothing here names a vendor or holds an address:
 *
 *     MCP_URL=https://… [MCP_TOKEN=…] [MCP_TOOL=name] [MCP_ARGS='{"k":"v"}'] \
 *       npx tsx packages/agent-kit/tests/live/mcp-server.live.mts
 *
 * It initialises a session, lists the tools (printing which ones carry readOnlyHint), then calls one
 * read tool: MCP_TOOL if given, otherwise the first tool marked read-only. A fixture is what we believe
 * a server does; this is what it does (AGENTS.md).
 */
const url = process.env.MCP_URL, token = process.env.MCP_TOKEN, wanted = process.env.MCP_TOOL;
if (!url) { console.error("Set MCP_URL (and MCP_TOKEN if the server needs one)."); process.exit(2); }

let id = 0, session: string | undefined;
async function rpc(method: string, params?: unknown, notify = false): Promise<any> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), ...(notify ? {} : { id: ++id }) };
  const res = await fetch(url!, { method: "POST", body: JSON.stringify(body), headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18",
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? { "mcp-session-id": session } : {}) } });
  session = res.headers.get("mcp-session-id") ?? session;
  if (notify) return undefined;
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const text = await res.text();
  const payload = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).filter(Boolean).map(l => JSON.parse(l)).find(m => m.id === id)
    : JSON.parse(text);
  if (!payload) throw new Error(`${method}: no answer`);
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result;
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lares-live-probe", version: "0" } });
await rpc("notifications/initialized", undefined, true);
console.log("server:", init.serverInfo?.name, init.serverInfo?.version);
const listed = await rpc("tools/list", {});
const tools: any[] = listed.tools ?? [];
for (const t of tools) console.log(`${t.annotations?.readOnlyHint === true ? "read-only" : "unmarked "}  ${t.name}`);
const pick = wanted ? tools.find(t => t.name === wanted) : tools.find(t => t.annotations?.readOnlyHint === true);
if (!pick) { console.error("No read tool to call: set MCP_TOOL."); process.exit(1); }
const result = await rpc("tools/call", { name: pick.name, arguments: process.env.MCP_ARGS ? JSON.parse(process.env.MCP_ARGS) : {} });
console.log(`called ${pick.name}:`, JSON.stringify(result).slice(0, 400));
