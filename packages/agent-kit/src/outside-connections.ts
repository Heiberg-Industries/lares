// Outside tools at run time, B2a): the one implementation both role services use to turn an
// agent definition's `outsideTools` into eve MCP connections, and the rules around them.
//
// `outside-tools.ts` (same folder) holds the pure DEFINITION helpers (url check, which entries are in
// effect, secret names). This file is the RUNTIME half: connection settings, the approval policy,
// the approver re-check, the taint rule and the "something is wrong" classifier. Each role's
// `agent/connections/outside-tools.ts` is a few lines that call `resolveOutsideConnections`.
//
// MODULE SCOPE IS INERT: `eve build` evaluates this with no secrets and no network. The token file
// is read inside `getToken`, at call time, and never cached here.
import { readFile } from "node:fs/promises";

import type { McpClientConnectionDefinition } from "eve/connections";
import type { ApprovalContext, ApprovalResponseContext, ApprovalResponseDecision, ApprovalStatus } from "eve/tools/approval";

import type { AgentDefinition, OutsideToolDeclaration } from "./definition.js";
import { registerOutsideConnections } from "./approval-summary.js";
import { outsideHttpsHosts, outsideSecretTarget, outsideToolsInEffect } from "./outside-tools.js";
import { addEgressHosts } from "./slack-dispatcher.js";
import { asksAfterUntrustedText } from "./tainted-approval.js";
import { listTools, pgPinStore, reportPinVerdict, verdictOncePerSession, verifyEntry, type PinCheckDeps, type PinReporter } from "./outside-pins.js";
import { getPool } from "./db.js";
import type { Taint } from "./origin-taint.js";

/** The slice of a definition this file reads. */
export type OutsideDefinitionView = Pick<AgentDefinition, "name" | "grants" | "autonomy" | "outsideTools">;

export interface OutsideDeps {
  /** True when this responder (eve's `SessionAuthContext`) may approve: the role service passes the
   *  same allowlist check `assertApprover` uses (`isAllowedPrincipal`). */
  isAllowedApprover: (responder: unknown) => boolean;
  /** Reads a token file. Defaults to `fs.readFile`; tests inject. */
  readTokenFile?: (path: string) => Promise<string>;
  /** Registers the https hosts with the egress dispatcher. Defaults to the engine's; tests inject. */
  addHosts?: (hosts: string[]) => void;
  /** False for a role that has no origin-taint hook (creative): the turn's taint is never written
   *  there, so "ask once the turn has read outside text" could never fire. Every call then asks.
   *  Defaults to true. */
  taintAware?: boolean;
  /** Defaults to false. While it is false, an approval an outside tool needs is refused on a Telegram
   *  conversation with a plain message to use Slack. Flip it only after a Telegram tap has been
   *  seen approving an outside-tool write on the real bot (see `OUTSIDE_TELEGRAM_APPROVALS_PROVEN`). */
  telegramApprovals?: boolean;
  /** The locked-descriptions check (`checkedOutsideConnections`). Absent: no check (tests). */
  descriptions?: () => DescriptionCheckDeps;
}

/**
 * Whether the owner has seen a Telegram tap approve an outside-tool write on the real bot.
 *
 * The engine now resumes a Telegram tap with the verified owner's identity
 * (`services/chief-of-staff/lib/telegram-tap-auth.ts`), and a test drives eve's own approval code to
 * show that works. The live check on the real bot is still the owner's to run, so until
 * this is set to true outside-tool approvals are refused on Telegram rather than left to hang.
 */
export const OUTSIDE_TELEGRAM_APPROVALS_PROVEN = false;

/** eve's authenticator string for a Telegram session (`defaultTelegramAuth`). */
const TELEGRAM_AUTHENTICATOR = "telegram-webhook";

export const TELEGRAM_OUTSIDE_REFUSAL =
  "Approving a change to an outside tool is not available from Telegram yet. Ask for it again in Slack, where the approval card works, and nothing was done here.";

function sessionIsTelegram(ctx: unknown): boolean {
  const auth = (ctx as { session?: { auth?: { current?: unknown; initiator?: unknown } } } | null | undefined)?.session?.auth;
  const is = (a: unknown): boolean => (a as { authenticator?: unknown } | null | undefined)?.authenticator === TELEGRAM_AUTHENTICATOR;
  return is(auth?.current) || is(auth?.initiator);
}

/** Where the keeper mounts an entry's token inside the agent's container. */
export function outsideTokenPath(toolName: string): string {
  return `/run/secrets/${outsideSecretTarget(toolName)}`;
}

/** The bare tool name behind eve's `<connection>__<tool>`. */
export function bareToolName(connection: string, toolName: string): string {
  const prefix = `${connection}__`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

/**
 * The request-time approval policy.
 *
 * - untrusted (the default): every call asks, reads included. A read's arguments go to a server the
 *   agent has no reason to believe, and its answer is outside text.
 * - trusted: a tool listed in `tools.read` asks only after the turn has read somebody else's words
 *   (`asksAfterUntrustedText`); every other tool asks. In a role with no taint hook
 *   (`taintAware: false`) that check could never see outside text, so every call asks.
 *
 * A function that returns eve's status, and never throws: a policy that threw would take the gate down.
 */
export function outsideRequestPolicy(
  entry: OutsideToolDeclaration,
  opts: { taintAware?: boolean; telegramApprovals?: boolean } = {},
): (ctx: ApprovalContext) => Promise<ApprovalStatus> {
  const afterUntrusted = asksAfterUntrustedText();
  const telegramOk = opts.telegramApprovals ?? OUTSIDE_TELEGRAM_APPROVALS_PROVEN;
  return async (ctx) => {
    let decision: ApprovalStatus = "user-approval";
    try {
      if (entry.trusted === true && opts.taintAware !== false) {
        const bare = bareToolName(entry.name, ctx.toolName);
        decision = entry.tools.read.includes(bare) ? await afterUntrusted(ctx) : "user-approval";
      }
    } catch {
      decision = "user-approval";
    }
    // A card the owner cannot answer must not park the turn: refuse it with a sentence the model can pass on.
    if (decision === "user-approval" && !telegramOk && sessionIsTelegram(ctx)) return { type: "denied", reason: TELEGRAM_OUTSIDE_REFUSAL };
    return decision;
  };
}

/**
 * The approver re-check, through eve's approval `response` policy. A connection tool has no
 * `execute` of ours in which to call `assertApprover`, so this is the one seam. Same allowlist, same
 * fail-closed direction: anything that is not clearly an allowed principal is rejected and the
 * request stays pending.
 *
 * TELEGRAM: eve refuses a responder with no identity before this runs, and its own Telegram channel
 * resumes a button tap with none. The chief of staff's Telegram door therefore resumes a tap by an
 * allowed approver WITH that approver's identity (`lib/telegram-tap-auth.ts`), and until the owner has
 * seen it work on the real bot the request policy refuses outside-tool approvals on Telegram.
 * Slack and the console pass the clicker's identity.
 */
export function outsideResponsePolicy(
  isAllowedApprover: OutsideDeps["isAllowedApprover"],
): (ctx: ApprovalResponseContext) => ApprovalResponseDecision {
  return (ctx) => {
    let allowed = false;
    try {
      allowed = isAllowedApprover(ctx.responder);
    } catch {
      allowed = false;
    }
    return allowed ? { status: "allowed" } : { status: "rejected", reason: "this person is not an allowed approver for this agent" };
  };
}

/** Reads an entry's token file, at call time. Names the path, never the contents. */
export async function readOutsideToken(entry: OutsideToolDeclaration, read: (path: string) => Promise<string>): Promise<string> {
  const path = outsideTokenPath(entry.name);
  let raw: string;
  try {
    raw = await read(path);
  } catch {
    throw new Error(`outside tool ${entry.name}: token file not readable: ${path}`);
  }
  const token = raw.trim();
  if (token === "") throw new Error(`outside tool ${entry.name}: token file is empty: ${path}`);
  return token;
}

/** One entry as eve connection settings. Pure; no I/O until eve calls `getToken`. */
export function outsideConnection(agentName: string, entry: OutsideToolDeclaration, deps: OutsideDeps): McpClientConnectionDefinition {
  const read = deps.readTokenFile ?? ((p: string) => readFile(p, "utf8"));
  return {
    url: entry.url,
    description: entry.description,
    instanceKey: `outside:${agentName}:${entry.name}`,
    ...(entry.token === true
      ? {
          auth: {
            credentialOwner: "app" as const,
            getToken: async () => ({ token: await readOutsideToken(entry, read) }),
          },
        }
      : {}),
    tools: { allow: [...entry.tools.allow] },
    approval: { request: outsideRequestPolicy(entry, { taintAware: deps.taintAware, telegramApprovals: deps.telegramApprovals }), response: outsideResponsePolicy(deps.isAllowedApprover) },
  };
}

/**
 * The connections for one agent, or null when it has none in effect (no entries, no `outside` grant,
 * or autonomy `never`). eve runs the resolver several times per session and again after a restart, so
 * this is idempotent: the only state it touches is two in-process sets (the egress hosts and the card
 * connection names), and adding to them twice changes nothing.
 */
export function resolveOutsideConnections(
  definition: OutsideDefinitionView,
  deps: OutsideDeps,
): Record<string, McpClientConnectionDefinition> | null {
  const entries = outsideToolsInEffect(definition);
  if (entries.length === 0) return null;
  const hosts = outsideHttpsHosts(entries);
  if (hosts.length > 0) (deps.addHosts ?? addEgressHosts)(hosts);
  registerOutsideConnections(entries.map((e) => e.name));
  return Object.fromEntries(entries.map((e) => [e.name, outsideConnection(definition.name, e, deps)]));
}

// ─── Locked tool descriptions ──────────────────────────────────────────────────────────────

export interface DescriptionCheckDeps extends PinCheckDeps {
  reporter?: PinReporter;
}

/** The check wired to the box's database, built only when there is something to check (an agent with
 *  no outside tools never touches the database here). `signal` is the role's own sender, if any. */
export function descriptionChecks(signal?: PinReporter["signal"]): () => DescriptionCheckDeps {
  return () => {
    const db = getPool();
    return { store: pgPinStore(db), list: listTools, reporter: { db, ...(signal === undefined ? {} : { signal }) } };
  };
}

/**
 * `resolveOutsideConnections`, then the locked-descriptions check (ADR-0019 rule 10): at most once
 * per session and entry, ask the server for `tools/list` and compare it with what was recorded when
 * the entry was first used. An entry whose descriptions changed, or whose record could not be read,
 * is dropped from this session and reported once. FAILS CLOSED: so is an entry whose key file cannot be
 * read or whose server cannot be asked, because a hostile server could fail the check and then serve
 * changed descriptions to eve's own client. Only `match` and a fresh `pinned` keep the connection.
 * Each drop opens the repair and sends the signal once per session and entry; `match` and `pinned`
 * resolve an open repair. Returns null when nothing is left.
 */
export async function checkedOutsideConnections(
  definition: OutsideDefinitionView,
  deps: OutsideDeps,
  sessionId: string | undefined,
): Promise<Record<string, McpClientConnectionDefinition> | null> {
  const configs = resolveOutsideConnections(definition, deps);
  if (configs === null || deps.descriptions === undefined) return configs;
  const checks = deps.descriptions();
  const read = deps.readTokenFile ?? ((p: string) => readFile(p, "utf8"));
  const kept: Record<string, McpClientConnectionDefinition> = {};
  for (const entry of outsideToolsInEffect(definition)) {
    const config = configs[entry.name];
    if (config === undefined) continue;
    const verdict = await verdictOncePerSession(sessionId, definition.name, entry.name, async () => {
      let token: string | undefined;
      if (entry.token === true) {
        try {
          token = await readOutsideToken(entry, read);
        } catch {
          // Fail closed: without the key the check cannot run, and an unchecked connection is not kept.
          await reportPinVerdict(definition.name, entry.name, "unreachable", checks.reporter);
          return "unreachable";
        }
      }
      return verifyEntry(definition.name, entry, token, checks, checks.reporter);
    });
    // Fail closed: only a recorded match, or a first-time record just written, keeps the connection.
    if (verdict === "match" || verdict === "pinned") kept[entry.name] = config;
  }
  return Object.keys(kept).length === 0 ? null : kept;
}

// ─── Taint ─────────────────────────────────────────────────────────────────────────────────

/** eve's built-in tool the model uses to find a connection's tools. Its output carries the server's
 *  own tool descriptions, which are outside text. */
export const CONNECTION_SEARCH_TOOL = "connection_search";

/**
 * The class a tool result from an outside tool taints the turn at, or undefined for none. Results of
 * `<name>__*` from an UNTRUSTED connection are `third_party`; so is `connection_search` output while
 * any untrusted connection is present. A trusted connection's results are the owner's own call.
 */
export function outsideResultTaint(toolName: string, definition: OutsideDefinitionView): Taint | undefined {
  const untrusted = outsideToolsInEffect(definition).filter((e) => e.trusted !== true);
  if (untrusted.length === 0) return undefined;
  if (toolName === CONNECTION_SEARCH_TOOL) return "third_party";
  return untrusted.some((e) => toolName.startsWith(`${e.name}__`)) ? "third_party" : undefined;
}

// ─── Something is wrong ────────────────────────────────────────────────────────────────────

export interface OutsideProblem {
  connection: string;
  kind: "key-refused" | "unreachable";
}

function walkForProblems(value: unknown, names: ReadonlySet<string>, out: Map<string, OutsideProblem["kind"]>, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== "object") {
    if (typeof value === "string" && depth <= 6 && (value.includes("needsAuthorization") || value.includes('"error"'))) {
      try {
        walkForProblems(JSON.parse(value), names, out, depth + 1);
      } catch {
        /* not JSON: nothing to read */
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walkForProblems(v, names, out, depth + 1);
    return;
  }
  const rec = value as Record<string, unknown>;
  const conn = rec["connection"];
  if (typeof conn === "string" && names.has(conn)) {
    if (rec["needsAuthorization"] === true) {
      out.set(conn, "key-refused");
    } else if (typeof rec["error"] === "string" && !out.has(conn)) {
      // eve's connection_search reports a server it could not use as `{ connection, description,
      // error }` with no tools: "Authorization failed for ..." when getToken threw or the server
      // refused the key, "Failed to load tools for ..." when it did not answer.
      out.set(conn, rec["error"].startsWith("Authorization failed") ? "key-refused" : "unreachable");
    }
  }
  for (const v of Object.values(rec)) walkForProblems(v, names, out, depth + 1);
}

/**
 * What a tool result says about the health of an outside connection. A refused key shows up in
 * `connection_search` output as `needsAuthorization: true`; a server that is down, or a key file that
 * cannot be read, shows up there as an entry with an `error` string and no tools (eve 0.60.1); a
 * server that stops answering mid-session shows up as a failed `<name>__*` call (status `failed`, the harness's word for "the call did not complete").
 * A tool that ran and reported its own error is NOT a problem with the connection.
 */
export function outsideProblems(
  result: { toolName?: unknown; output?: unknown },
  status: unknown,
  definition: OutsideDefinitionView,
): OutsideProblem[] {
  const entries = outsideToolsInEffect(definition);
  if (entries.length === 0 || typeof result.toolName !== "string") return [];
  const names = new Set(entries.map((e) => e.name));
  if (result.toolName === CONNECTION_SEARCH_TOOL) {
    const found = new Map<string, OutsideProblem["kind"]>();
    walkForProblems(result.output, names, found);
    return [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([connection, kind]) => ({ connection, kind }));
  }
  const hit = entries.find((e) => result.toolName !== undefined && (result.toolName as string).startsWith(`${e.name}__`));
  return hit !== undefined && status === "failed" ? [{ connection: hit.name, kind: "unreachable" }] : [];
}

/** The plain sentence for the Repairs signal. Names the tool, never a key. */
export function outsideProblemWording(agentName: string, p: OutsideProblem): { summary: string; detail: string } {
  return p.kind === "key-refused"
    ? {
        summary: `${agentName}: the key for outside tool ${p.connection} was refused`,
        detail: `The server behind outside tool "${p.connection}" did not accept its key, so ${agentName} cannot use it. Replace the key in the console, then apply the change.`,
      }
    : {
        summary: `${agentName}: outside tool ${p.connection} did not answer`,
        detail: `A call to outside tool "${p.connection}" did not complete. The server may be down or unreachable from the box. Check that it is running; ${agentName} will keep trying when asked.`,
      };
}
