// Accepted outside tools execute only through Keeper; no agent-side provider or token access.
import { defineTool, type ToolContext } from "eve/tools";

import type { ApprovalContext, ApprovalResponseContext, ApprovalResponseDecision, ApprovalStatus } from "eve/tools/approval";

import type { AgentDefinition, OutsideToolDeclaration } from "./definition.js";
import { registerOutsideConnections, withCardTitle } from "./approval-summary.js";
import { outsideToolsInEffect, isTrustedRead, trustGrantFor } from "./outside-tools.js";
import { toolPinHash } from "./outside-pins.js";
import { asksAfterUntrustedText } from "./tainted-approval.js";
import { isApprovalRecheck } from "./approval-execution.js";
import type { Taint } from "./origin-taint.js";

/** The slice of a definition this file reads. */
export type OutsideDefinitionView = Pick<AgentDefinition, "name" | "grants" | "autonomy" | "outsideTools">;

interface OutsideDeps { isAllowedApprover:(responder:unknown)=>boolean }

/**
 * Whether the owner has seen a Telegram tap approve an outside-tool write on the real bot.
 *
 * eve 1.0 resumes a Telegram tap with the tapper's own identity, and the webhook front door has
 * already refused a tap by anyone who is not an allowed approver
 * (`services/chief-of-staff/lib/telegram-tap-gate.ts`); a test drives eve's own approval code to
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

/** The bare tool name behind eve's `<connection>__<tool>`. */
export function bareToolName(connection: string, toolName: string): string {
  const prefix = `${connection}__`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

/**
 * The request-time approval policy.
 *
 * - every tool asks, reads included, UNLESS the owner switched that one tool on ("run without asking")
 *   and it is also marked as only looking things up (`isTrustedRead`). A tool that changes
 *   something always asks.
 * - a trusted lookup runs without a card only while the turn has not read somebody else's words
 *   (`asksAfterUntrustedText`). In a role with no taint hook (`taintAware: false`) that check could
 *   never see outside text, so every call asks.
 * Keeper re-checks the trust itself at call time; this only decides whether a card is raised.
 *
 * A function that returns eve's status, and never throws: a policy that threw would take the gate down.
 */
export function outsideRequestPolicy(
  entry: OutsideToolDeclaration,
  opts: { taintAware?: boolean; telegramApprovals?: boolean; pins?: Readonly<Record<string, string>> } = {},
): (ctx: ApprovalContext) => Promise<ApprovalStatus> {
  const afterUntrusted = asksAfterUntrustedText();
  const telegramOk = opts.telegramApprovals ?? OUTSIDE_TELEGRAM_APPROVALS_PROVEN;
  return async (ctx) => {
    let decision: ApprovalStatus = "user-approval";
    try {
      const bare = bareToolName(entry.name, ctx.toolName);
      if (opts.taintAware !== false && isTrustedRead(entry, bare, opts.pins?.[bare])) {
        decision = await afterUntrusted(ctx);
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
 * ASKED ABOUT A DENY TOO. eve 1.0 runs this policy for `decision: "deny"` as well as `"approve"`
 * (`dist/src/harness/hitl/responders.js`: the policy gets `response: { decision, principal }`). The
 * rule is one rule: only a person who may approve may deny. A Deny from anyone else is rejected
 * exactly like their Approve, the request stays pending, and nothing is recorded as a decision. A
 * decision that is neither is rejected.
 *
 * The person who answered is `ctx.response.principal` (it was `ctx.responder`).
 *
 * TELEGRAM: eve refuses a responder with no identity before this runs. eve 1.0's own Telegram
 * channel resumes a button tap WITH the tapper's identity, and the chief of staff's webhook front
 * door refuses a tap by anyone who is not an allowed approver before it reaches eve
 * (`lib/telegram-tap-gate.ts`). Until the owner has seen an approval work on the real bot, the
 * request policy refuses outside-tool approvals on Telegram.
 * Slack and the console pass the clicker's identity.
 */
export function outsideResponsePolicy(
  isAllowedApprover: OutsideDeps["isAllowedApprover"],
): (ctx: ApprovalResponseContext) => ApprovalResponseDecision {
  return (ctx) => {
    let allowed = false;
    try {
      const decision = ctx?.response?.decision;
      allowed = (decision === "approve" || decision === "deny") && isAllowedApprover(ctx.response.principal) === true;
    } catch {
      allowed = false;
    }
    return allowed ? { status: "allowed" } : { status: "rejected", reason: "this person is not an allowed approver for this agent" };
  };
}

// ─── Taint ─────────────────────────────────────────────────────────────────────────────────

/** eve's built-in tool the model uses to find a connection's tools (it was `connection_search`). Its
 *  output carries the server's own tool descriptions, which are outside text. */
export const CONNECTION_SEARCH_TOOL = "eve__search";

/**
 * The class a tool result from an outside tool taints the turn at, or undefined for none. Results of
 * an outside tool are `third_party` unless the owner trusts that tool (a lookup the owner let run is the
 * owner's own call); so is `connection_search` output while any connection has no trusted tool (the descriptions it shows
 * are pinned, so a connection the owner already trusts for lookups adds nothing new).
 */
export function outsideResultTaint(toolName: string, definition: OutsideDefinitionView): Taint | undefined {
  const entries = outsideToolsInEffect(definition);
  if (entries.length === 0) return undefined;
  if (toolName === CONNECTION_SEARCH_TOOL) return entries.some((e) => !e.tools.allow.some((t) => trustGrantFor(e, t) !== undefined)) ? "third_party" : undefined;
  const hit = entries.find((e) => toolName.startsWith(`${e.name}__`));
  return hit !== undefined && trustGrantFor(hit, bareToolName(hit.name, toolName)) === undefined ? "third_party" : undefined;
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

/** Secret-free accepted tool metadata read through Keeper, never from a provider in this process. */
type OutsideSchemaJson=null|boolean|number|string|OutsideSchemaJson[]|{[key:string]:OutsideSchemaJson};
export interface AcceptedOutsideTool { name:string; description?:string; inputSchema:{[key:string]:OutsideSchemaJson} }
export interface OutsideRuntimeDeps {
  acceptedTools:(connectionName:string)=>Promise<AcceptedOutsideTool[]>;
  approval?:(connectionName:string,toolName:string)=>{request:(ctx:ApprovalContext)=>Promise<ApprovalStatus>;response:(ctx:ApprovalResponseContext)=>Promise<ApprovalResponseDecision>};
  /** Role-owned executor; its authority comes from the admitted-turn hook. */
  /** `runsFree` is true for a call the owner let run without a card (a trusted lookup). The executor
   *  must then ask Keeper for the trusted run; Keeper re-checks the trust itself. */
  executor:(connectionName:string,toolName:string,runsFree:boolean)=>(input:unknown,ctx:ToolContext)=>Promise<unknown>;
}

/** Ordinary Eve tools using the accepted catalog. The Keeper independently requires an exact,
 * current, unused receipt on execution. An Eve approval card alone never grants that authority.
 *
 * Every tool here is gated: `approval` is ALWAYS the object form, with the role's request and
 * response policies when it supplied them, and the card title (`prompt`) added. The model may reach
 * one of these by its own name or through `eve__tool`; either way eve shows the policies the entry's
 * own name, so the tainted-approval and exact-approval rules apply to both routes. */
export async function resolveOutsideTools(definition:OutsideDefinitionView,deps:OutsideRuntimeDeps){
  const tools:Record<string,ReturnType<typeof defineTool>>={};
  for(const entry of outsideToolsInEffect(definition)){
    // `eve` and the `eve__` prefix are eve's own; a tool or connection under that name is refused.
    if(entry.name==='eve'||entry.name.startsWith('eve__'))continue;
    let accepted:AcceptedOutsideTool[];
    try{accepted=await deps.acceptedTools(entry.name);}catch{continue;}
    registerOutsideConnections([entry.name]);
    const pins:Record<string,string>={};
    for(const tool of accepted)pins[tool.name]=toolPinHash(tool);
    for(const tool of accepted){
      if(!entry.tools.allow.includes(tool.name))continue;
      const authored=deps.approval?.(entry.name,tool.name)??{request:async()=> 'user-approval' as const};
      const runsFree=isTrustedRead(entry,tool.name,pins[tool.name]);
      // A trusted lookup skips the card only on a clean turn. A card already raised (eve asks the policy
      // again before the approved call runs) keeps its own path.
      const free=outsideRequestPolicy(entry,{telegramApprovals:true,pins});
      const gated=runsFree?{...authored,request:async (ctx:ApprovalContext)=>
        (isApprovalRecheck(ctx)?authored.request(ctx):(await free(ctx))==='not-applicable'?'not-applicable' as const:authored.request(ctx))}:authored;
      tools[`${entry.name}__${tool.name}`]=defineTool({description:tool.description??'',inputSchema:tool.inputSchema,
        approval:withCardTitle(gated),execute:deps.executor(entry.name,tool.name,runsFree)});
    }
  }
  return Object.keys(tools).length?tools:null;
}
