"use server";
// The steps behind the one Connect screen for an outside (MCP) tool server. Each step is a thin wrapper
// round keeper actions that already exist, run in the order the two older pages ask the owner to press
// them: declare, save, apply, look up the tools, review, record, accept, stage, activate. Nothing here
// widens what a step allows: every keeper action still checks the signed-in session, the agent's edit
// access, the definition hash, the access revision and the exact tool descriptions on its own.
//
// Owner admission is checked first (the same guard the other installation-wide actions use), then the keeper checks the agent.
// Every step returns its outcome. A refusal carries the keeper's own reason in plain words. The
// credential passes through to the keeper and is not kept, logged or returned.
import { cookies } from "next/headers";
import { z } from "zod";
import { outsideToolSchema, type OutsideToolDeclaration } from "@lares/agent-kit/definition";
import { memberAuditAddress, requireConsoleMember, sessionMember } from "../../lib/auth";
import { listAgents } from "../../lib/agents";
import { keeper, KeeperRefusedError, KeeperUnavailableError } from "../../lib/keeper-client";
import { keeperReason } from "../../lib/keeper-reason";
import { parseOutsideDescriptorAcceptance, parseOutsideDescriptorPublication, parseOutsideDescriptorReview, parseOutsideDiscoveryDocument,
  parseOutsideDiscoveryInspection, parseOutsideDiscoveryPreview, type OutsideDescriptorReviewDto, type OutsideDiscoveryDocumentDto,
  type OutsidePendingApplyDto } from "../../lib/outside-discovery-dto";
import { PENDING_TOOL } from "../../lib/outside-connect-words";

/** `retryable: false`: pressing the same step again would be wrong (a token may already have been sent, or what the owner
 *  read is out of date), so the screen offers only "start again". */
export type ConnectStep<T> = { ok: true; value: T } | { ok: false; message: string; retryable: boolean };
export type ConnectTool = OutsideDiscoveryDocumentDto["tools"][number];
export type ConnectIdentity = { accountId: string; agentName: string; connectionName: string; requestId: string; claimOperationId: string };
export type ConnectDeclared = { definitionHash: string; accessRevision: number; applied: boolean };

const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
const uuid = z.string().uuid();
const identitySchema = z.strictObject({ accountId: uuid, agentName: nameSchema, connectionName: nameSchema, requestId: uuid, claimOperationId: uuid });
const connectionSchema = z.strictObject({
  name: nameSchema, url: z.string().min(1).max(2048), description: z.string().min(1).max(500), token: z.boolean(), trusted: z.boolean(),
  allow: z.array(z.string().min(1)).max(200), read: z.array(z.string().min(1)).max(200),
});
const stateSchema = z.object({ definitionHash: z.string().regex(/^[a-f0-9]{64}$/), accessRevision: z.number().int().positive(),
  connections: z.array(outsideToolSchema), applicationStatus: z.enum(["applied", "pending", "unavailable"]) });
type State = z.infer<typeof stateSchema>;
const TIMEOUT = { timeoutMs: 90_000 };

const fail = (message: string, retryable = true): { ok: false; message: string; retryable: boolean } => ({ ok: false, message, retryable });

async function admitted(): Promise<{ sessionToken: string; actor: string }> {
  const sessionToken = (await cookies()).get("lares_session")?.value;
  const member = await sessionMember(sessionToken);
  const actor = member ? await memberAuditAddress(member.id) : undefined;
  if (!sessionToken || !member || !actor) throw new Error("Sign in again to connect an outside tool.");
  return { sessionToken, actor };
}

/** Runs one step: sign-in, then the work. A refusal becomes the keeper's reason; anything else, `what`. */
async function step<T>(what: string, work: (who: { sessionToken: string; actor: string }) => Promise<T>): Promise<ConnectStep<T>> {
  let who: { sessionToken: string; actor: string };
  try { who = await admitted(); } catch (error) { return fail(error instanceof Error ? error.message : "Sign in again to connect an outside tool."); }
  try { return { ok: true, value: await work(who) }; }
  catch (error) {
    if (error instanceof StepFailure) return fail(error.message, error.retryable);
    return fail(keeperReason(error, `${what} Nothing was changed by this step that you need to undo; press Try again.`));
  }
}
class StepFailure extends Error { constructor(message: string, readonly retryable = true) { super(message); } }

async function read(who: { sessionToken: string; actor: string }, agent: string): Promise<State> {
  return stateSchema.parse(await keeper<unknown>("outside.connections.get", { sessionToken: who.sessionToken, name: agent }, who.actor));
}

function declarationOf(c: z.infer<typeof connectionSchema>): OutsideToolDeclaration {
  return { name: c.name, url: c.url, description: c.description, token: c.token, trusted: c.trusted, tools: { allow: c.allow, read: c.read } };
}

/** Agents the owner can tick. The keeper decides, per agent, whether the member may edit it. */
export async function connectListAgents(): Promise<ConnectStep<{ name: string; displayName: string }[]>> {
  await requireConsoleMember();
  return step("The agent list could not be read.", async () => (await listAgents({ strict: true })).map(a => ({ name: a.name, displayName: a.displayName })));
}

/**
 * Declare the connection on one agent, save it, and (unless `applyNow` is false) apply it if the save left it waiting. With a token and
 * no tool names yet (`provisional`), the declaration carries a placeholder tool so the server can be asked
 * what it offers; it is replaced by the owner's chosen tools before anything is reviewed or activated.
 */
export async function connectDeclare(input: unknown): Promise<ConnectStep<ConnectDeclared>> {
  await requireConsoleMember();
  const parsed = z.strictObject({ agent: nameSchema, connection: connectionSchema, provisional: z.boolean(), applyNow: z.boolean().optional() }).safeParse(input);
  if (!parsed.success) return fail("The connection details are not valid. Check the address, the name and the tool list.");
  const { agent, connection, provisional } = parsed.data, applyNow = parsed.data.applyNow !== false;
  return step("The connection could not be saved.", async (who) => {
    const state = await read(who, agent);
    const next = declarationOf(provisional ? { ...connection, allow: [PENDING_TOOL], read: [] } : connection);
    const connections = [...state.connections.filter(c => c.name !== connection.name), next];
    const staging = connection.token ? [connection.name] : [];
    const saved = stateSchema.parse(await keeper<unknown>("outside.connections.save",
      { sessionToken: who.sessionToken, name: agent, expectedDefinitionHash: state.definitionHash, expectedAccessRevision: state.accessRevision,
        connections, ...(staging.length ? { stagingCredentialFor: staging } : {}) }, who.actor, TIMEOUT));
    if (saved.applicationStatus === "applied" || !applyNow) return { definitionHash: saved.definitionHash, accessRevision: saved.accessRevision, applied: saved.applicationStatus === "applied" };
    const applied = stateSchema.parse(await keeper<unknown>("outside.connections.apply",
      { sessionToken: who.sessionToken, name: agent, expectedDefinitionHash: saved.definitionHash, expectedAccessRevision: saved.accessRevision,
        ...(staging.length ? { stagingCredentialFor: staging } : {}) }, who.actor, TIMEOUT));
    return { definitionHash: applied.definitionHash, accessRevision: applied.accessRevision, applied: applied.applicationStatus === "applied" };
  });
}

const sameBytes = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().filter(k => rec[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(rec[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * One bounded look at the tools the server offers, with the owner's token. The keeper sends the token to
 * the declared address through the reviewed route and keeps it sealed; it is not returned. If the answer
 * is lost on the way, the saved request is inspected once and never sent again.
 */
export async function connectLookUpTools(input: { agent: string; name: string; credential: string }): Promise<ConnectStep<{ identity: ConnectIdentity; serverName: string; tools: ConnectTool[] }>> {
  await requireConsoleMember();
  const parsed = z.strictObject({ agent: nameSchema, name: nameSchema, credential: z.string().min(1).max(4096) }).safeParse(input);
  if (!parsed.success || Buffer.byteLength(parsed.data.credential) > 4096) return fail("The token is empty or too long.");
  const { agent, name, credential } = parsed.data;
  return step("The tool list could not be read.", async (who) => {
    const preview = parseOutsideDiscoveryPreview(await keeper<unknown>("outside.discovery-preview", { sessionToken: who.sessionToken, agentName: agent, connectionName: name }, who.actor));
    if (!preview) throw new StepFailure("The keeper's answer about this connection was not understood. Press Try again.");
    const identity: ConnectIdentity = { accountId: preview.accountId, agentName: agent, connectionName: name, requestId: preview.requestId, claimOperationId: preview.claimOperationId };
    let document: OutsideDiscoveryDocumentDto | undefined;
    try {
      document = parseOutsideDiscoveryDocument(await keeper<unknown>("outside.discover", { sessionToken: who.sessionToken, consent: true, requestId: preview.requestId,
        claimOperationId: preview.claimOperationId, accountId: preview.accountId, agentName: agent, connectionName: name,
        expectedGeneration: preview.expectedGeneration, expectedCandidateRevision: preview.expectedCandidateRevision,
        expectedDefinitionHash: preview.definitionHash, expectedAccessRevision: preview.accessRevision, expectedDestinationHash: preview.destinationHash,
        expectedRoutePolicyHash: preview.routePolicyHash, consentGeneration: preview.consentGeneration, credential }, who.actor)) ?? undefined;
    } catch (error) {
      // A refusal means the keeper declined before any exchange: its reason is shown as it is.
      if (error instanceof KeeperRefusedError) throw error;
      if (error instanceof KeeperUnavailableError && !error.outcomeMayBeUnknown) throw new StepFailure("The keeper could not be reached, so nothing was sent. Press Try again.");
      const found = parseOutsideDiscoveryInspection(await keeper<unknown>("outside.discovery-inspect", { sessionToken: who.sessionToken, accountId: identity.accountId,
        agentName: agent, connectionName: name, requestId: identity.requestId, claimOperationId: identity.claimOperationId }, who.actor).catch(() => undefined));
      if (found?.state !== "complete") throw new StepFailure("The server's answer did not arrive, and the saved request shows no result. The token was sent at most once and this screen will not send it again. Check the address, then start again.", false);
      document = found.document;
    }
    if (!document) throw new StepFailure("The server answered, but not with a tool list this screen can read. Check that the address is the server's MCP address.");
    return { identity, serverName: `${document.serverInfo.name} ${document.serverInfo.version}`.trim(), tools: document.tools };
  });
}

/**
 * Review, record, accept and stage the exact descriptions of the tools the owner chose. When `seen` is
 * given, the descriptions the server gives now must match what the owner was shown; if they differ the
 * step stops before anything is recorded, so the owner never accepts text they did not read.
 */
export async function connectReviewAndStage(input: { identity: ConnectIdentity; seen?: ConnectTool[] }): Promise<ConnectStep<OutsidePendingApplyDto>> {
  await requireConsoleMember();
  const parsed = z.strictObject({ identity: identitySchema, seen: z.array(z.unknown()).max(200).optional() }).safeParse(input);
  if (!parsed.success) return fail("The connection details are not valid. Start again.");
  const { identity } = parsed.data;
  return step("The tool descriptions could not be reviewed.", async (who) => {
    const base = { sessionToken: who.sessionToken, ...identity };
    const review: OutsideDescriptorReviewDto | undefined = parseOutsideDescriptorReview(await keeper<unknown>("outside.discovery-review-preview", base, who.actor));
    if (!review) throw new StepFailure("The keeper's review was not understood. Press Try again.");
    if (input.seen) {
      const seen = new Map(input.seen.map(t => [t.name, t]));
      const changed = review.descriptor.tools.filter(t => { const before = seen.get(t.name); return !before || before.description !== t.description || !sameBytes(before.inputSchema, t.inputSchema); });
      if (changed.length) throw new StepFailure(`The server now describes ${changed.map(t => t.name).join(", ")} differently from what you were shown. Nothing was accepted. Start again to read the new descriptions.`, false);
    }
    const publication = parseOutsideDescriptorPublication(await keeper<unknown>("outside.discovery-review-publish", { ...base,
      expectedGeneration: review.expectedGeneration, expectedDescriptorHash: review.descriptorHash }, who.actor));
    if (!publication) throw new StepFailure("The keeper's record of the descriptions was not understood. Press Try again.");
    // Accepting repeats the review check, so it also proves this session belongs to the member who sent the token.
    const again = parseOutsideDescriptorReview(await keeper<unknown>("outside.discovery-review-preview", base, who.actor));
    if (!again || again.descriptorHash !== review.descriptorHash) throw new StepFailure("The descriptions changed while they were being recorded. Nothing was accepted. Start again.", false);
    const acceptance = parseOutsideDescriptorAcceptance(await keeper<unknown>("outside.discovery-review-accept", { sessionToken: who.sessionToken, accountId: identity.accountId,
      publicationId: publication.publicationId, expectedPublicationHash: publication.publicationHash }, who.actor));
    if (!acceptance) throw new StepFailure("The keeper's acceptance was not understood. Press Try again.");
    const selectors = { ...identity, publicationId: publication.publicationId, acceptanceId: acceptance.acceptanceId, expectedGeneration: review.expectedGeneration,
      expectedCandidateRevision: review.expectedCandidateRevision, expectedConsentGeneration: review.expectedConsentGeneration,
      expectedDefinitionHash: review.expectedDefinitionHash, expectedAccessRevision: review.expectedAccessRevision,
      expectedPublicationHash: publication.publicationHash, expectedAcceptanceHash: acceptance.acceptanceHash };
    const staged = await keeper<Record<string, unknown>>("outside.candidate-stage", { sessionToken: who.sessionToken, ...selectors }, who.actor);
    const receipt = z.strictObject({ staged: z.literal(true), activationReviewId: uuid, activationReviewHash: z.string().regex(/^[a-f0-9]{64}$/),
      expectedPolicyHash: z.string().regex(/^[a-f0-9]{64}$/), stageOperationId: uuid, candidateRevision: z.number().int().positive() }).parse(staged);
    return { ...selectors, activationReviewId: receipt.activationReviewId, activationReviewHash: receipt.activationReviewHash,
      expectedPolicyHash: receipt.expectedPolicyHash, stageOperationId: receipt.stageOperationId, candidateRevision: receipt.candidateRevision };
  });
}

/** Makes the staged credential the active one in the keeper's custody. */
export async function connectActivateCredential(input: { staged: OutsidePendingApplyDto }): Promise<ConnectStep<{ credentialRevision: number }>> {
  await requireConsoleMember();
  const staged = z.strictObject({ accountId: uuid, agentName: nameSchema, connectionName: nameSchema, requestId: uuid, claimOperationId: uuid, publicationId: uuid, acceptanceId: uuid,
    expectedGeneration: z.number().int().positive(), expectedCandidateRevision: z.number().int().positive().nullable(), expectedConsentGeneration: z.number().int().positive(),
    expectedDefinitionHash: z.string().regex(/^[a-f0-9]{64}$/), expectedAccessRevision: z.number().int().positive(), expectedPublicationHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedAcceptanceHash: z.string().regex(/^[a-f0-9]{64}$/), expectedPolicyHash: z.string().regex(/^[a-f0-9]{64}$/), activationReviewId: uuid,
    activationReviewHash: z.string().regex(/^[a-f0-9]{64}$/), stageOperationId: uuid, candidateRevision: z.number().int().positive() }).safeParse(input.staged);
  if (!staged.success) return fail("The staged credential details are not valid. Start again.");
  return step("The credential could not be activated.", async (who) => {
    const result = z.object({ outcome: z.literal("applied"), credentialRevision: z.number() }).parse(
      await keeper<unknown>("outside.candidate-apply", { sessionToken: who.sessionToken, ...staged.data }, who.actor, TIMEOUT));
    if (result.credentialRevision !== staged.data.candidateRevision) throw new StepFailure("The keeper activated a different credential revision than the one staged. Check the connection under Integrations before using it.");
    return { credentialRevision: result.credentialRevision };
  });
}

/** Applies the agent's saved connection declarations if any are waiting. */
export async function connectApplyAgent(input: { agent: string }): Promise<ConnectStep<{ applied: boolean }>> {
  await requireConsoleMember();
  const agent = nameSchema.safeParse(input.agent);
  if (!agent.success) return fail("The agent name is not valid.");
  return step("The agent could not be updated.", async (who) => {
    const state = await read(who, agent.data);
    if (state.applicationStatus === "applied") return { applied: true };
    const applied = stateSchema.parse(await keeper<unknown>("outside.connections.apply",
      { sessionToken: who.sessionToken, name: agent.data, expectedDefinitionHash: state.definitionHash, expectedAccessRevision: state.accessRevision }, who.actor, TIMEOUT));
    return { applied: applied.applicationStatus === "applied" };
  });
}

/**
 * Takes a half-finished connection off an agent: removes the declaration with this name and applies the
 * change. A token already held in custody is not touched; stopping its use is a separate, explicit control.
 */
export async function connectRemoveDeclaration(input: { agent: string; name: string }): Promise<ConnectStep<{ removed: boolean }>> {
  await requireConsoleMember();
  const parsed = z.strictObject({ agent: nameSchema, name: nameSchema }).safeParse(input);
  if (!parsed.success) return fail("The connection name is not valid.");
  const { agent, name } = parsed.data;
  return step("The half-set-up connection could not be removed.", async (who) => {
    const state = await read(who, agent);
    if (!state.connections.some(c => c.name === name)) return { removed: false };
    const saved = stateSchema.parse(await keeper<unknown>("outside.connections.save", { sessionToken: who.sessionToken, name: agent,
      expectedDefinitionHash: state.definitionHash, expectedAccessRevision: state.accessRevision, connections: state.connections.filter(c => c.name !== name) }, who.actor, TIMEOUT));
    if (saved.applicationStatus !== "applied")
      await keeper<unknown>("outside.connections.apply", { sessionToken: who.sessionToken, name: agent, expectedDefinitionHash: saved.definitionHash, expectedAccessRevision: saved.accessRevision }, who.actor, TIMEOUT);
    return { removed: true };
  });
}
