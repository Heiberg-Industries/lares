// Locked tool descriptions for outside tools (ADR-0019 rule 10).
//
// An outside server writes the descriptions the model reads for its tools. eve cannot override them,
// and the keeper cannot reach outside hosts, so the check lives in the agent: the first time an agent
// connects to a new or changed entry it records a fingerprint of `tools/list` for the allowed tools
// (trust on first use); at every later session start one `tools/list` call is compared with it. A
// mismatch drops that connection for the session, keeps what the server now says for the owner to
// review, and opens a repair. Only the owner accepts new descriptions, in the console (the keeper's
// `outside.accept_fingerprint`); this module never does.
//
// MODULE SCOPE IS INERT (`eve build` evaluates this with no network and no database).
import { createHash } from "node:crypto";

import type { Queryable } from "@lares/vault-format/forget-ledger";

import { openRepair, resolveRepair } from "./repairs.js";
import type { OutsideToolDeclaration } from "./definition.js";

export const OUTSIDE_PIN_REPAIR_KIND = "outside-tool-descriptions";

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().filter((k) => rec[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** One allowed tool as the model is shown it. This is also what is kept for the owner to review. */
export interface PinnedTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** The ALLOWED tools, as the model will be shown them, sorted by name. Tools outside the allow-list
 *  are never part of it (they are never shown). */
export function allowedTools(tools: readonly ListedTool[], allow: readonly string[]): PinnedTool[] {
  const allowed = new Set(allow);
  return tools
    .filter((t) => allowed.has(t.name))
    .map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? null }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Fingerprint of what the model will be shown for the ALLOWED tools: name, description and input
 *  schema, sorted by name. */
export function descriptionsHash(tools: readonly ListedTool[], allow: readonly string[]): string {
  return sha256(canonical(allowedTools(tools, allow)));
}

/** Descriptions longer than this (as JSON) are not kept for review; the fingerprint still is. A
 *  server writes these words, so the store must not grow without bound because of one. */
export const KEPT_TOOLS_MAX_BYTES = 64 * 1024;

/** The descriptions to keep, or null when they are too long to keep. */
export function keptTools(tools: readonly PinnedTool[]): PinnedTool[] | null {
  return Buffer.byteLength(JSON.stringify(tools), "utf8") <= KEPT_TOOLS_MAX_BYTES ? [...tools] : null;
}

/** Fingerprint of the parts of an entry that decide what is pinned: its address and allow-list. */
export function entryConfigHash(entry: Pick<OutsideToolDeclaration, "url" | "tools">): string {
  return sha256(canonical({ url: entry.url, allow: [...entry.tools.allow].sort() }));
}

// ─── Asking the server ─────────────────────────────────────────────────────────────────────

export interface ListToolsOptions {
  url: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function rpcPost(opts: ListToolsOptions, message: unknown, session: { id?: string }, wantReply: boolean): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (session.id) headers["mcp-session-id"] = session.id;
  const res = await (opts.fetchImpl ?? fetch)(opts.url, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
  });
  session.id = res.headers.get("mcp-session-id") ?? session.id;
  const text = await res.text();
  if (!res.ok) throw new Error(`the server answered HTTP ${res.status}`);
  if (!wantReply) return null;
  let data = text;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
  }
  const body = JSON.parse(data) as { result?: unknown; error?: unknown };
  if (body.error !== undefined || body.result === undefined) throw new Error("the server returned an error");
  return body.result;
}

/** The server's tool list, over Streamable HTTP (initialize, initialized, tools/list with paging).
 *  Throws when the server cannot be asked; the caller treats that as "unreachable", not "changed". */
export async function listTools(opts: ListToolsOptions): Promise<ListedTool[]> {
  const session: { id?: string } = {};
  await rpcPost(opts, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lares-description-check", version: "0" } } }, session, true);
  await rpcPost(opts, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, session, false);
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = (await rpcPost(opts, { jsonrpc: "2.0", id: 2 + page, method: "tools/list", params: cursor ? { cursor } : {} }, session, true)) as { tools?: ListedTool[]; nextCursor?: string };
    for (const t of result.tools ?? []) if (typeof t?.name === "string") tools.push(t);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

// ─── The pin store ─────────────────────────────────────────────────────────────────────────

export interface StoredPin {
  configHash: string;
  pinHash: string;
}

export interface PinStore {
  get(agent: string, tool: string): Promise<StoredPin | undefined>;
  /** A fresh record (trust on first use). Clears anything kept from an earlier mismatch. */
  put(agent: string, tool: string, pin: StoredPin, tools: PinnedTool[] | null): Promise<void>;
  /** The descriptions matched: clear anything kept from an earlier mismatch, and keep the matching
   *  descriptions if the record has none yet. */
  matched(agent: string, tool: string, tools: PinnedTool[] | null): Promise<void>;
  /** The descriptions differ: keep what was seen for the owner to review. Never changes the pin. */
  seen(agent: string, tool: string, seenHash: string, tools: PinnedTool[] | null): Promise<void>;
}

const jsonOrNull = (tools: PinnedTool[] | null): string | null => (tools === null ? null : JSON.stringify(tools));

/** `outside_tool_pins` (with its `seen_*` columns). Throws on a database fault: the caller fails closed. */
export function pgPinStore(db: Queryable): PinStore {
  return {
    async get(agent, tool) {
      const r = await db.query(`SELECT config_hash, pin_hash FROM outside_tool_pins WHERE agent = $1 AND tool = $2`, [agent, tool]);
      const row = (r.rows as Array<{ config_hash: string; pin_hash: string }>)[0];
      return row === undefined ? undefined : { configHash: row.config_hash, pinHash: row.pin_hash };
    },
    async put(agent, tool, pin, tools) {
      await db.query(
        `INSERT INTO outside_tool_pins (agent, tool, config_hash, pin_hash, pin_tools) VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (agent, tool) DO UPDATE SET config_hash = EXCLUDED.config_hash, pin_hash = EXCLUDED.pin_hash,
           pin_tools = EXCLUDED.pin_tools, seen_hash = NULL, seen_tools = NULL, seen_at = NULL, pinned_at = now()`,
        [agent, tool, pin.configHash, pin.pinHash, jsonOrNull(tools)],
      );
    },
    async matched(agent, tool, tools) {
      // Writes only when there is something to change, so a normal session start stays a read.
      await db.query(
        `UPDATE outside_tool_pins SET seen_hash = NULL, seen_tools = NULL, seen_at = NULL, pin_tools = COALESCE(pin_tools, $3::jsonb)
         WHERE agent = $1 AND tool = $2 AND (seen_hash IS NOT NULL OR (pin_tools IS NULL AND $3::jsonb IS NOT NULL))`,
        [agent, tool, jsonOrNull(tools)],
      );
    },
    async seen(agent, tool, seenHash, tools) {
      await db.query(
        `UPDATE outside_tool_pins SET seen_hash = $3, seen_tools = $4::jsonb, seen_at = now()
         WHERE agent = $1 AND tool = $2 AND seen_hash IS DISTINCT FROM $3`,
        [agent, tool, seenHash, jsonOrNull(tools)],
      );
    },
  };
}

// ─── The check ─────────────────────────────────────────────────────────────────────────────

/**
 * - `pinned`: new or changed entry; its descriptions were recorded (trust on first use).
 * - `match`: the descriptions are what was recorded.
 * - `changed`: they differ. The connection must be dropped for this session.
 * - `unreachable`: the server could not be asked, or the key could not be read. Fail closed: drop the
 *   connection for this session, because a server that fails the check could still serve other
 *   descriptions to eve's own client.
 * - `unverified`: the pin store failed. Fail closed: drop the connection.
 */
export type PinVerdict = "pinned" | "match" | "changed" | "unreachable" | "unverified";

export interface PinCheckDeps {
  store: PinStore;
  list: (opts: ListToolsOptions) => Promise<ListedTool[]>;
}

export async function checkEntryPin(
  agent: string,
  entry: OutsideToolDeclaration,
  token: string | undefined,
  deps: PinCheckDeps,
): Promise<PinVerdict> {
  let tools: ListedTool[];
  try {
    tools = await deps.list({ url: entry.url, ...(token === undefined ? {} : { token }) });
  } catch {
    return "unreachable";
  }
  const configHash = entryConfigHash(entry);
  const shown = allowedTools(tools, entry.tools.allow);
  const pinHash = descriptionsHash(tools, entry.tools.allow);
  let verdict: "match" | "changed";
  try {
    const stored = await deps.store.get(agent, entry.name);
    if (stored === undefined || stored.configHash !== configHash) {
      await deps.store.put(agent, entry.name, { configHash, pinHash }, keptTools(shown));
      return "pinned";
    }
    verdict = stored.pinHash === pinHash ? "match" : "changed";
  } catch {
    return "unverified";
  }
  // Keeping what was seen is for the owner's review. It never decides the verdict: a failure here
  // leaves the connection exactly as the check decided (kept on a match, dropped on a change).
  try {
    if (verdict === "match") await deps.store.matched(agent, entry.name, keptTools(shown));
    else await deps.store.seen(agent, entry.name, pinHash, keptTools(shown));
  } catch (err) {
    console.warn("outside tools: could not keep what the description check saw:", err);
  }
  return verdict;
}

export function pinProblemWording(agentName: string, tool: string, verdict: "changed" | "unverified" | "unreachable"): { summary: string; detail: string } {
  if (verdict === "unreachable") {
    return {
      summary: `${agentName}: outside tool ${tool} could not be checked, so it is switched off for this conversation`,
      detail: `${agentName} checks what outside tool "${tool}" says about its tools before using it, and could not: the server did not answer the check, or its key could not be read. The tool is switched off for this conversation and is checked again in the next one. Check that the server is running and that its key is in place.`,
    };
  }
  return verdict === "changed"
    ? {
        summary: `${agentName}: outside tool ${tool} changed its tool descriptions; review and re-approve`,
        detail: `The server behind outside tool "${tool}" now describes its tools differently from when ${agentName} first connected. The connection is switched off until you have read the new descriptions and accepted them, on the agent's Access tab in the console.`,
      }
    : {
        summary: `${agentName}: could not check the descriptions of outside tool ${tool}`,
        detail: `${agentName} keeps a record of what outside tool "${tool}" said about its tools and could not read it, so the connection is switched off. Check that the box's database is reachable and that the latest database update has been applied.`,
      };
}

export interface PinReporter {
  db: Queryable;
  /** Optional extra channel (the chief of staff's signal spine). Never throws. */
  signal?: (key: string, summary: string, detail: string) => Promise<unknown>;
}

/** Reports a verdict: opens the repair and sends the signal for a bad one, resolves the repair for a
 *  good one. Never throws. */
export async function reportPinVerdict(
  agent: string,
  entryName: string,
  verdict: PinVerdict,
  reporter: PinReporter | undefined,
): Promise<void> {
  const ref = `${agent}:${entryName}`;
  try {
    if (verdict === "changed" || verdict === "unverified" || verdict === "unreachable") {
      const w = pinProblemWording(agent, entryName, verdict);
      if (reporter !== undefined) {
        await openRepair(reporter.db, {
          kind: OUTSIDE_PIN_REPAIR_KIND,
          ref,
          severity: "warn",
          what: w.summary,
          howToFix:
            verdict === "unreachable"
              ? "Check that the server is running and its key is in place; the next conversation checks again."
              : "Read the server's new descriptions on the agent's Access tab in the console, then accept them there.",
        });
        await reporter.signal?.(`outside-tool:${ref}:descriptions`, w.summary, w.detail);
      }
      console.warn(`outside tools: ${w.summary}`);
    } else if ((verdict === "match" || verdict === "pinned") && reporter !== undefined) {
      await resolveRepair(reporter.db, OUTSIDE_PIN_REPAIR_KIND, ref);
    }
  } catch (err) {
    console.warn("outside tools: could not report a description check result:", err);
  }
}

/** Runs the check for one entry and reports the verdict. Never throws. */
export async function verifyEntry(
  agent: string,
  entry: OutsideToolDeclaration,
  token: string | undefined,
  deps: PinCheckDeps,
  reporter: PinReporter | undefined,
): Promise<PinVerdict> {
  const verdict = await checkEntryPin(agent, entry, token, deps);
  await reportPinVerdict(agent, entry.name, verdict, reporter);
  return verdict;
}

// ─── At most once per session ──────────────────────────────────────────────────────────────

const MEMO_MAX = 1000;
const memo = new Map<string, { at: number; verdict: Promise<PinVerdict> }>();
const MEMO_TTL_MS = 60 * 60 * 1000;

/** The verdict for (session, agent, entry), computed once. eve runs a connection resolver two or
 *  three times per session; only the first run asks the server. A missing session id is memoized
 *  under a shared key for the TTL, which is still at most one call per hour per entry. */
export function verdictOncePerSession(
  sessionId: string | undefined,
  agent: string,
  entryName: string,
  compute: () => Promise<PinVerdict>,
  now: () => number = Date.now,
): Promise<PinVerdict> {
  const key = `${sessionId ?? "no-session"}\u0000${agent}\u0000${entryName}`;
  const t = now();
  const hit = memo.get(key);
  if (hit !== undefined && t - hit.at < MEMO_TTL_MS) return hit.verdict;
  if (memo.size >= MEMO_MAX) {
    for (const [k, v] of memo) if (t - v.at >= MEMO_TTL_MS || memo.size >= MEMO_MAX) memo.delete(k);
  }
  const verdict = compute();
  memo.set(key, { at: t, verdict });
  return verdict;
}

export function resetPinMemoForTests(): void {
  memo.clear();
}
