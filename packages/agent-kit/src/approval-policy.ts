/**
 * The approval rules every gated tool of every role goes through, written once (ADR-0025): who may
 * approve, who may answer a card on a native door, and the policies a catalogue tool's approval
 * request, approval answer and execution are wrapped in.
 *
 * A role binds them to its doors and its own extras in its `lib/approvals.ts`
 * (`approvalPolicy({...})`). Everything a role does differently is a setting below, and a role that
 * leaves a setting out gets the behaviour it had before the rules moved here. The kit holds no role
 * names except what a role passes in.
 */
import { assertPrivateConsoleTool as assertPrivateTool, isPrivateConsoleContext, privateOnlyTool, doorVaultReadTool, managedDoorToolHidden, privateOwnerTool,
  type PrivateRole } from "./private-console-surface.js";
import { assertSharedRoomAllows } from "./shared-room.js";
import { isExactApprovalContext, isExactApprovalResponse, isApprovalRecheck, reserveExactApproval, reserveExactApprovalOrDeny,
  approveExactResponse, requireApprovedExecution, requireApprovedRecheck, approvalResponderOf,
  type ApprovedExecution, type ExactApprovalAdapter, type ExactApprovalOptions, type ExactResponseContext } from "./approval-execution.js";
import { guardConsoleToolContext, type ConsoleAuthorityContext } from "./console-turn-authority.js";
import { approvalLedger, assertApprovedCall, callIdFrom } from "./approval-ledger.js";
import { principalFromAuth, type PrincipalPolicy } from "./principals.js";

/**
 * Refused because the person who approved is not the person allowed to, on THIS door.
 *
 * Typed, and distinct from a write failure, because these two are the ones an operator must never
 * confuse: "the gate stopped someone" and "the write failed" look identical in a transcript
 * otherwise. `doors` names the doors whose buttons the role shows ("Slack or Telegram", "Slack").
 */
export class UnauthorizedApproverError extends Error {
  readonly approver: string;
  constructor(approver: string, doors: string) {
    super(
      `approval refused: ${approver} is not an allowed approver for this agent. ` +
        `A ${doors} approval button can be clicked by anyone who can see the ` +
        `message, so the approver is re-checked here against packages/agent-kit/src/principals.ts.`,
    );
    this.approver = approver;
    this.name = "UnauthorizedApproverError";
  }
}

/** The normalised shape a caller extracts from its door's auth context (via `principalFromAuth`)
 *  before calling `assertApprover`. `absent` is set ONLY for a null/undefined auth context;
 *  `assertApprover` refuses it — only `approverFrom`'s initiator fallback consumes the marker. */
export interface ApprovalPrincipal {
  authenticator?: string;
  userId?: string;
  absent?: boolean;
}

/** The `ctx.session.auth` projection every eve tool receives. */
export interface SessionAuthLike {
  current?: unknown;
  initiator?: unknown;
}

/** A role's settings. Every optional one, left out, is "this role does not do that". */
export interface ApprovalPolicyConfig {
  /** The role, as the private (web chat) surface knows it. */
  readonly role: PrivateRole;
  /** The role's allow-lists, bound to its doors (`principalPolicy`). */
  readonly principals: PrincipalPolicy;
  /** The doors named in `UnauthorizedApproverError`'s text. */
  readonly approvalDoors: string;
  /** A schedule-opened session's declared approver, read off the initiator (Telegram pushes). */
  readonly declaredApprover?: (initiator: unknown) => ApprovalPrincipal | undefined;
  /** The exact-approval adapter for a tool in web chat. Without it no tool has one. */
  readonly adapterFor?: (tool: string, input?: unknown) => ExactApprovalAdapter;
  /** What a web chat reservation that cannot be made does: answer a denial with a reason the model
   *  reads, or throw (eve then parks the conversation). */
  readonly reserveRefusal: "deny" | "throw";
  /** The tools that never run in web chat without an exact approved card. */
  readonly needsExactCard: (tool: string) => boolean;
  /** Keeps an accepted native answer's answerer until the card settles; returns why it cannot, or
   *  null once kept. An answer that cannot be kept is refused. */
  readonly keepAnswer?: (requestId: unknown, sessionId: unknown, principal: unknown) => string | null;
  /** Whether the person in a web chat conversation is the agent's current owner, asked for the
   *  tools only an owner may use. Without it nobody is. */
  readonly callerIsOwner?: (ctx: unknown) => Promise<boolean>;
  /** A native door's request policy after the authored one decided (default: the authored answer). */
  readonly nativeRequest?: (name: string, ctx: unknown, decision: unknown) => unknown;
  /** A refusal for a web chat request before anything is reserved or shown, or undefined. */
  readonly beforeExactCard?: (name: string, ctx: ConsoleAuthorityContext & { callId?: string; toolInput?: unknown }) => Promise<unknown>;
  /** Tools with their own request, answer and execution checks (after the private-surface check). */
  readonly ownChecks?: Readonly<Record<string, {
    readonly request: (ctx: unknown) => unknown;
    readonly response: (ctx: unknown) => unknown;
    readonly execution: (ctx: unknown, input: unknown) => Promise<unknown>;
  }>>;
}

export interface ApprovalPolicy {
  approverFrom(auth: SessionAuthLike | null | undefined, env?: NodeJS.ProcessEnv): ApprovalPrincipal;
  assertApprover(approval: ApprovalPrincipal, env?: NodeJS.ProcessEnv): void;
  assertOwnerAnswerer(approval: ApprovalPrincipal, env?: NodeJS.ProcessEnv): void;
  assertApproval(
    ctx: { session?: { auth?: SessionAuthLike | null }; approval?: { responder?: unknown } },
    toolName: string,
    input: unknown,
  ): Promise<ApprovedExecution | undefined>;
  nativeAnswerDecision(ctx: unknown): { status: "allowed" } | { status: "rejected"; reason: string };
  catalogueApprovalRequest(name: string, ctx: unknown, authored: unknown): Promise<unknown>;
  catalogueApprovalResponse(name: string, ctx: unknown): Promise<unknown>;
  guardCatalogueExecution(ctx: unknown, name: string, input: unknown): Promise<void>;
}

/** The approval rules bound to one role. */
export function approvalPolicy(config: ApprovalPolicyConfig): ApprovalPolicy {
  const { principals } = config;
  const exactOptions = (tool: string, input?: unknown): ExactApprovalOptions =>
    config.adapterFor ? { adapter: config.adapterFor(tool, input) } : {};
  const refusedLabel = (approval: ApprovalPrincipal): string =>
    approval.userId !== undefined && approval.userId.length > 0
      ? `${approval.authenticator ?? "unknown-channel"}:${approval.userId}`
      : "an unidentified principal";

  /**
   * The approver for a gated tool call, resolved from the session's auth contexts.
   *
   * `current` — the identity that triggered THIS resume — wins whenever it exists. When it is
   * ABSENT (null/undefined), the approval is attributed to the session's INITIATOR — the
   * door-verified identity that opened the session — and checked against the allow-list exactly
   * like any other principal. eve resumes a Telegram card tap with `auth: null` (the tap itself
   * carries no identity); the session's initiator is real and verified, and the card only exists
   * inside that same chat. A session with an unknown or missing initiator still refuses.
   *
   * A SCHEDULE-opened session's initiator is the app and says nothing about who tapped; a role
   * whose pushes declare which chat they were addressed to passes `declaredApprover`, and that
   * principal goes through the same allow-list check as every other.
   */
  function approverFrom(auth: SessionAuthLike | null | undefined, env: NodeJS.ProcessEnv = process.env): ApprovalPrincipal {
    const current = principalFromAuth(auth?.current);
    if (current.absent !== true) return current;
    // Gated on the allow-list rather than on the shape of the authenticator, so an app initiator
    // can never satisfy it by accident.
    const initiator = principalFromAuth(auth?.initiator);
    if (initiator.absent !== true && principals.isAllowedPrincipal(initiator.authenticator, initiator.userId, env)) {
      return initiator;
    }
    const declared = config.declaredApprover?.(auth?.initiator);
    if (declared !== undefined) return declared;
    // Nothing resolvable. Return the initiator when there is one, purely so the refusal names what
    // it actually saw instead of "an unidentified principal".
    return initiator.absent === true ? {} : initiator;
  }

  /**
   * Re-checks WHO approved, which the framework does not. eve's own docs: built-in card buttons are
   * handled before any authored inbound handler, and anyone who can interact with the message can
   * answer it. So a door's inbound allow-list does not cover the click that authorises the write;
   * the re-check is the tool's job. Fail-closed on every other principal too, including
   * authenticators the agent fronts for other purposes (an operator with the route password can
   * start a session, but a write wants a named, door-verified human). Strict, including ABSENT: the
   * null-auth case is handled UPSTREAM by `approverFrom`, never by exempting absence itself.
   */
  function assertApprover(approval: ApprovalPrincipal, env: NodeJS.ProcessEnv = process.env): void {
    if (!principals.isAllowedPrincipal(approval.authenticator, approval.userId, env)) {
      throw new UnauthorizedApproverError(refusedLabel(approval), config.approvalDoors);
    }
  }

  /** The answerer of an approved native card must be the agent's OWNER (the first id on that door's
   *  allow-list), not merely an allowed person. Used where the answerer of record is
   *  `ctx.approval.responder`. */
  function assertOwnerAnswerer(approval: ApprovalPrincipal, env: NodeJS.ProcessEnv = process.env): void {
    if (!principals.isOwnerPrincipal(approval.authenticator, approval.userId, env)) {
      throw new UnauthorizedApproverError(refusedLabel(approval), config.approvalDoors);
    }
  }

  /**
   * The one call a gated tool makes before it acts: WHO answered, then WHICH CARD they answered —
   * the same arguments, and not a stale one (`assertApprovedCall`). A missing call id or a missing
   * row PASSES the second check (evidence never fails an action), so it never replaces the first.
   *
   * `input` MUST be the tool's own raw first argument, unmodified: `payloadFingerprint` treats a key
   * present with an `undefined` value as different from a key that is absent.
   *
   * eve 1.0: `session.auth.current` is the person (or, for a scheduled turn, the app principal) who
   * ASKED; the person who answered is `ctx.approval.responder`, present only when a card was
   * answered. The approver of record is the answerer, and it must be the agent's OWNER. With no
   * card (an autonomous call) the session's own caller must be an allowed approver.
   */
  async function assertApproval(
    ctx: { session?: { auth?: SessionAuthLike | null }; approval?: { responder?: unknown } },
    toolName: string,
    input: unknown,
  ): Promise<ApprovedExecution | undefined> {
    if (isExactApprovalContext(ctx)) {
      return await requireApprovedExecution(ctx as ConsoleAuthorityContext, toolName, input, exactOptions(toolName, input));
    }
    await guardConsoleToolContext(ctx);
    const responder = approvalResponderOf(ctx);
    if (responder !== undefined) assertOwnerAnswerer(principalFromAuth(responder));
    else assertApprover(approverFrom(ctx?.session?.auth));
    await assertApprovedCall(approvalLedger(), { callId: callIdFrom(ctx), toolName, input });
    return undefined;
  }

  /** The private-surface check, with the owner question asked afresh for the tools only an owner may
   *  use. A conversation started in a shared room is refused every tool the room rule does not list,
   *  first and in words for the room, before any card or execution. */
  async function assertPrivateConsoleTool(ctx: unknown, name: string): Promise<void> {
    if (!isPrivateConsoleContext(ctx)) assertSharedRoomAllows(ctx, name, (!privateOnlyTool(name) || (config.role === "chief-of-staff" && doorVaultReadTool(name))) && !managedDoorToolHidden(ctx, name));
    const callerIsOwner = config.callerIsOwner && privateOwnerTool(name) && isPrivateConsoleContext(ctx)
      ? await config.callerIsOwner(ctx) : false;
    assertPrivateTool(ctx, config.role, name, { callerIsOwner });
  }

  /** Preserve the authored native policy; bound console calls additionally require exact authority. */
  async function catalogueApprovalRequest(name: string, ctx: unknown, authored: unknown): Promise<unknown> {
    await assertPrivateConsoleTool(ctx, name);
    const own = config.ownChecks?.[name];
    if (own) return own.request(ctx);
    if (!isExactApprovalContext(ctx)) {
      await guardConsoleToolContext(ctx);
      const decision = await (authored as (ctx: unknown) => unknown)(ctx);
      return config.nativeRequest ? config.nativeRequest(name, ctx, decision) : decision;
    }
    const c = ctx as ConsoleAuthorityContext & { callId?: string; toolInput?: unknown };
    const refusedEarly = await config.beforeExactCard?.(name, c);
    if (refusedEarly) return refusedEarly;
    if (isApprovalRecheck(c)) {
      // eve asks the policy again, as the requester, before it runs a call that was approved. The
      // call must already be approved on its card; nothing is reserved or shown again. Anything
      // else is denied.
      try { await requireApprovedRecheck(c, name, c.toolInput, exactOptions(name, c.toolInput)); }
      catch { return "denied"; }
      return "user-approval";
    }
    if (config.reserveRefusal === "deny") {
      const refused = await reserveExactApprovalOrDeny(c, name, exactOptions(name, c.toolInput));
      if (refused) return refused;
    } else {
      await reserveExactApproval(c, name, exactOptions(name, c.toolInput));
    }
    const decision = await (authored as (ctx: unknown) => unknown)(ctx);
    if (decision === "denied" || (typeof decision === "object" && decision !== null && "type" in decision && decision.type === "denied")) return decision;
    return "user-approval";
  }

  /**
   * The answer check for a card on a native door (Slack, Telegram). Without a response policy eve's
   * default lets anyone answer a card whose requester is missing, and refuses the owner on a card a
   * SCHEDULED turn raised (its requester is the app principal). So every gated tool carries this
   * one. It is asked about a Deny as well as an Approve, accepts an answer only from the agent's
   * OWNER (the first id on the door's allow-list, identified by the door's verified sender, never
   * by message text) and refuses everyone else; the card stays pending. Fail closed.
   */
  function nativeAnswerDecision(ctx: unknown): { status: "allowed" } | { status: "rejected"; reason: string } {
    const refused = (reason: string) => ({ status: "rejected" as const, reason });
    try {
      const c = ctx as { response?: { decision?: unknown; principal?: unknown } };
      if (c?.response?.decision !== "approve" && c?.response?.decision !== "deny") return refused("this answer is neither Approve nor Deny");
      // The requester plays no part: it may be a person, the app principal of a scheduled turn, or
      // missing, and none of those changes who may answer.
      const answerer = principalFromAuth(c.response.principal);
      if (answerer.absent === true || !principals.isOwnerPrincipal(answerer.authenticator, answerer.userId)) return refused("only the agent's owner can answer this card");
      if (config.keepAnswer) {
        const notKept = config.keepAnswer((ctx as { request?: { interactionId?: unknown } }).request?.interactionId,
          (ctx as { session?: { id?: unknown } }).session?.id, c.response.principal);
        // An answer whose answerer cannot be kept until the card settles is not accepted.
        if (notKept) return refused(notKept);
      }
      return { status: "allowed" };
    } catch { return refused("this answer could not be verified"); }
  }

  /** The response policy is asked about a Deny as well as an Approve. On a native door it is the
   *  check above; in a bound console conversation it is the exact check, and anyone who is not that
   *  conversation's own resolver is refused for both, with the card staying pending. */
  async function catalogueApprovalResponse(name: string, ctx: unknown): Promise<unknown> {
    await assertPrivateConsoleTool(ctx, name);
    const own = config.ownChecks?.[name];
    if (own) return own.response(ctx);
    if (!isExactApprovalResponse(ctx)) return nativeAnswerDecision(ctx);
    return approveExactResponse(ctx as ExactResponseContext, exactOptions(name, (ctx as ExactResponseContext).request.toolInput));
  }

  async function guardCatalogueExecution(ctx: unknown, name: string, input: unknown): Promise<void> {
    await assertPrivateConsoleTool(ctx, name);
    const own = config.ownChecks?.[name];
    if (own) { await own.execution(ctx, input); return; }
    if (isExactApprovalContext(ctx)) {
      // The answerer of an approved call is `ctx.approval.responder`; `session.auth.current` is the requester.
      if (approvalResponderOf(ctx) !== undefined) {
        await requireApprovedExecution(ctx as ConsoleAuthorityContext, name, input, exactOptions(name, input));
        return;
      }
      // A change that needs an approved card never runs without one.
      if (config.needsExactCard(name)) throw new Error("Exact approval authority is unavailable or has changed");
    }
    await guardConsoleToolContext(ctx);
  }

  return { approverFrom, assertApprover, assertOwnerAnswerer, assertApproval, nativeAnswerDecision,
    catalogueApprovalRequest, catalogueApprovalResponse, guardCatalogueExecution };
}
