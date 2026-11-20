import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ cookies: vi.fn(), sessionMember: vi.fn(), memberAuditAddress: vi.fn(), keeper: vi.fn(), listAgents: vi.fn(), requireConsoleMember: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("../lib/auth", () => ({ sessionMember: mocks.sessionMember, memberAuditAddress: mocks.memberAuditAddress, requireConsoleMember: mocks.requireConsoleMember }));
vi.mock("../lib/agents", () => ({ listAgents: mocks.listAgents }));
vi.mock("../lib/keeper-client", () => ({
  keeper: mocks.keeper,
  KeeperRefusedError: class KeeperRefusedError extends Error {
    constructor(message: string, readonly findings?: { check: string; message: string }[]) { super(message); this.name = "KeeperRefusedError"; }
  },
  KeeperUnavailableError: class KeeperUnavailableError extends Error {
    constructor(message: string, readonly outcomeMayBeUnknown = false) { super(message); this.name = "KeeperUnavailableError"; }
  },
}));
import { connectActivateCredential, connectApplyAgent, connectDeclare, connectLookUpTools, connectRemoveDeclaration, connectReviewAndStage } from "../app/actions/outside-connect";
import { KeeperRefusedError, KeeperUnavailableError } from "../lib/keeper-client";
import { PENDING_TOOL } from "../lib/outside-connect-words";
import { toolPinHash } from "@lares/agent-kit/outside-pins";

const session = "A".repeat(43), actor = "member@example.test", secret = "tok-SECRET-value";
const h = (c: string) => c.repeat(64);
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const connection = { name: "rates", url: "https://tools.example.org/mcp", description: "Rates", token: true, trustedTools: [], allow: ["find_rate"], read: ["find_rate"] };
const declared = (allow: string[], read: string[] = []) => ({ name: "rates", url: connection.url, description: "Rates", token: true, tools: { allow, read } });
const state = (over: Record<string, unknown> = {}) => ({ name: "worker", definitionHash: h("a"), accessRevision: 2, connections: [], applicationStatus: "applied", appliedConnections: [], ...over });
const tool = { name: "find_rate", description: "Looks up a rate", inputSchema: { type: "object", properties: { id: { type: "string" } } } };
const document = { protocolVersion: "2025-06-18", serverInfo: { name: "Rates", version: "1.0" }, tools: [tool, { name: "set_rate", inputSchema: { type: "object" } }] };
const preview = { accountId: id(1), requestId: id(2), claimOperationId: id(3), agentName: "worker", connectionName: "rates", endpoint: "https://tools.example.org/mcp",
  purpose: "streamable-http-discovery-v1", definitionHash: h("a"), accessRevision: 2, destinationHash: h("b"), routePolicyHash: h("c"),
  expectedGeneration: 0, expectedCandidateRevision: null, consentGeneration: 1 };
const identity = { accountId: id(1), agentName: "worker", connectionName: "rates", requestId: id(2), claimOperationId: id(3) };
const review = { descriptor: { version: 1, connectionName: "rates", scope: "write-with-confirm", allow: ["find_rate"], read: ["find_rate"], tools: [tool] },
  descriptorHash: h("d"), expectedGeneration: 1, expectedCandidateRevision: null, expectedConsentGeneration: 1, expectedDefinitionHash: h("e"), expectedAccessRevision: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue({ get: () => ({ value: session }) });
  mocks.sessionMember.mockResolvedValue({ id: "member-id" });
  mocks.memberAuditAddress.mockResolvedValue(actor);
  mocks.requireConsoleMember.mockResolvedValue({ id: "member-id" });
});
const calls = () => mocks.keeper.mock.calls.map(c => c[0] as string);

describe("connect: declare", () => {
  it("saves a placeholder declaration for a token connection, says its credential is on the way, and applies it", async () => {
    mocks.keeper.mockResolvedValueOnce(state())
      .mockResolvedValueOnce(state({ definitionHash: h("b"), accessRevision: 3, applicationStatus: "pending", connections: [declared([PENDING_TOOL])] }))
      .mockResolvedValueOnce(state({ definitionHash: h("b"), accessRevision: 3, connections: [declared([PENDING_TOOL])] }));
    const result = await connectDeclare({ agent: "worker", provisional: true, connection: { ...connection, allow: [], read: [] } });
    expect(result).toEqual({ ok: true, value: { definitionHash: h("b"), accessRevision: 3, applied: true } });
    expect(calls()).toEqual(["outside.connections.get", "outside.connections.save", "outside.connections.apply"]);
    expect(mocks.keeper.mock.calls[1]![1]).toMatchObject({ sessionToken: session, name: "worker", connections: [declared([PENDING_TOOL], [])], stagingCredentialFor: ["rates"] });
    expect(mocks.keeper.mock.calls[2]![1]).toMatchObject({ stagingCredentialFor: ["rates"] });
  });
  it("never claims a credential is on the way for a connection that needs none", async () => {
    mocks.keeper.mockResolvedValueOnce(state()).mockResolvedValueOnce(state({ connections: [{ ...declared(["find_rate"]), token: false }] }));
    await connectDeclare({ agent: "worker", provisional: false, connection: { ...connection, token: false } });
    expect(mocks.keeper.mock.calls[1]![1]).not.toHaveProperty("stagingCredentialFor");
  });
  it("saves without applying when asked to, and replaces an earlier declaration of the same name", async () => {
    mocks.keeper.mockResolvedValueOnce(state({ connections: [declared([PENDING_TOOL])] }))
      .mockResolvedValueOnce(state({ applicationStatus: "pending", connections: [declared(["find_rate"], ["find_rate"])] }));
    const result = await connectDeclare({ agent: "worker", provisional: false, applyNow: false, connection });
    expect(result).toEqual({ ok: true, value: { definitionHash: h("a"), accessRevision: 2, applied: false } });
    expect(calls()).toEqual(["outside.connections.get", "outside.connections.save"]);
    expect(mocks.keeper.mock.calls[1]![1].connections).toEqual([declared(["find_rate"], ["find_rate"])]);
  });
  it("records a switched-on lookup bound to the description the owner saw, and never one for a tool that changes something", async () => {
    mocks.keeper.mockResolvedValueOnce(state()).mockResolvedValueOnce(state({ applicationStatus: "pending" }));
    await connectDeclare({ agent: "worker", provisional: false, applyNow: false, connection: { ...connection, allow: ["find_rate", "set_rate"], read: ["find_rate"],
      trustedTools: [{ name: "find_rate", description: tool.description, inputSchema: tool.inputSchema }, { name: "set_rate", description: "Changes a rate" }] } });
    const sent = mocks.keeper.mock.calls[1]![1].connections[0].tools;
    expect(sent.trusted).toHaveLength(1);
    expect(sent.trusted[0]).toMatchObject({ tool: "find_rate", pin: toolPinHash(tool) });
  });
  it("shows the keeper's own reason when it refuses, and offers a retry", async () => {
    mocks.keeper.mockResolvedValueOnce(state()).mockRejectedValueOnce(new KeeperRefusedError("[outside-tools] the grant is read-only but set_rate is allowed and not marked read",
      [{ check: "outside-tools", message: "the grant is read-only but set_rate is allowed and not marked read" }]));
    expect(await connectDeclare({ agent: "worker", provisional: false, connection })).toEqual({ ok: false, retryable: true,
      message: "the grant is read-only but set_rate is allowed and not marked read" });
  });
  it("refuses malformed input without calling the keeper, and asks for a new sign-in without a session", async () => {
    expect((await connectDeclare({ agent: "worker", provisional: false, connection: { ...connection, credential: "x" } })).ok).toBe(false);
    expect(mocks.keeper).not.toHaveBeenCalled();
    mocks.sessionMember.mockResolvedValueOnce(undefined);
    expect(await connectDeclare({ agent: "worker", provisional: false, connection })).toMatchObject({ ok: false, message: expect.stringMatching(/Sign in again/) });
  });
});

describe("connect: look up tools", () => {
  it("sends the token only to the keeper's discovery step and never returns it", async () => {
    mocks.keeper.mockResolvedValueOnce(preview).mockResolvedValueOnce(document);
    const result = await connectLookUpTools({ agent: "worker", name: "rates", credential: secret });
    expect(result).toMatchObject({ ok: true, value: { identity, serverName: "Rates 1.0", tools: document.tools } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(calls()).toEqual(["outside.discovery-preview", "outside.discover"]);
    expect(JSON.stringify(mocks.keeper.mock.calls[0])).not.toContain(secret);
    expect(mocks.keeper.mock.calls[1]![1]).toMatchObject({ consent: true, credential: secret, expectedDefinitionHash: h("a") });
  });
  it("reads the saved result once when the answer is lost, and never sends the token again", async () => {
    mocks.keeper.mockResolvedValueOnce(preview).mockRejectedValueOnce(new KeeperUnavailableError("lost", true)).mockResolvedValueOnce({ state: "complete", document });
    expect(await connectLookUpTools({ agent: "worker", name: "rates", credential: secret })).toMatchObject({ ok: true });
    expect(calls()).toEqual(["outside.discovery-preview", "outside.discover", "outside.discovery-inspect"]);
    expect(JSON.stringify(mocks.keeper.mock.calls[2])).not.toContain(secret);
  });
  it("stops, without a retry, when the lost answer cannot be found", async () => {
    mocks.keeper.mockResolvedValueOnce(preview).mockRejectedValueOnce(new KeeperUnavailableError("lost", true)).mockResolvedValueOnce({ state: "unresolved" });
    expect(await connectLookUpTools({ agent: "worker", name: "rates", credential: secret })).toMatchObject({ ok: false, retryable: false });
  });
  it("shows the keeper's reason when it refuses before sending anything", async () => {
    mocks.keeper.mockRejectedValueOnce(new KeeperRefusedError("Outside route is unavailable"));
    expect(await connectLookUpTools({ agent: "worker", name: "rates", credential: secret })).toEqual({ ok: false, message: "Outside route is unavailable", retryable: true });
    expect(calls()).toEqual(["outside.discovery-preview"]);
  });
});

describe("connect: review and stage", () => {
  const publication = { publicationId: id(4), publicationHash: h("f"), descriptor: review.descriptor };
  const acceptance = { acceptanceId: id(5), publicationHash: h("f"), acceptanceHash: h("9") };
  const receipt = { staged: true, activationReviewId: id(6), activationReviewHash: h("1"), expectedPolicyHash: h("2"), stageOperationId: id(7), candidateRevision: 1 };
  it("records, accepts and stages exactly the descriptions the owner was shown", async () => {
    mocks.keeper.mockResolvedValueOnce(review).mockResolvedValueOnce(publication).mockResolvedValueOnce(review).mockResolvedValueOnce(acceptance).mockResolvedValueOnce(receipt);
    const result = await connectReviewAndStage({ identity, seen: document.tools });
    expect(calls()).toEqual(["outside.discovery-review-preview", "outside.discovery-review-publish", "outside.discovery-review-preview", "outside.discovery-review-accept", "outside.candidate-stage"]);
    expect(result).toMatchObject({ ok: true, value: { candidateRevision: 1, activationReviewId: id(6), publicationId: id(4), acceptanceId: id(5), expectedDefinitionHash: h("e") } });
  });
  it("accepts nothing when the server now describes a tool differently from what the owner read", async () => {
    mocks.keeper.mockResolvedValueOnce(review);
    const changed = [{ ...tool, description: "Looks up a rate, and also emails it to everyone" }];
    const result = await connectReviewAndStage({ identity, seen: changed });
    expect(result).toMatchObject({ ok: false, retryable: false, message: expect.stringMatching(/find_rate .*differently/) });
    expect(calls()).toEqual(["outside.discovery-review-preview"]);
  });
  it("accepts nothing when a tool was never shown to the owner", async () => {
    mocks.keeper.mockResolvedValueOnce(review);
    expect(await connectReviewAndStage({ identity, seen: [] })).toMatchObject({ ok: false, retryable: false });
    expect(calls()).toEqual(["outside.discovery-review-preview"]);
  });
  it("stops when the descriptions move while they are being recorded", async () => {
    mocks.keeper.mockResolvedValueOnce(review).mockResolvedValueOnce(publication).mockResolvedValueOnce({ ...review, descriptorHash: h("0") });
    expect(await connectReviewAndStage({ identity, seen: document.tools })).toMatchObject({ ok: false, retryable: false });
    expect(calls()).not.toContain("outside.discovery-review-accept");
  });
});

describe("connect: activate, apply, remove", () => {
  const staged = { ...identity, publicationId: id(4), acceptanceId: id(5), expectedGeneration: 1, expectedCandidateRevision: null, expectedConsentGeneration: 1,
    expectedDefinitionHash: h("e"), expectedAccessRevision: 3, expectedPublicationHash: h("f"), expectedAcceptanceHash: h("9"), expectedPolicyHash: h("2"),
    activationReviewId: id(6), activationReviewHash: h("1"), stageOperationId: id(7), candidateRevision: 1 };
  it("activates the staged revision and refuses a different one", async () => {
    mocks.keeper.mockResolvedValueOnce({ kind: "apply", outcome: "applied", credentialRevision: 1 });
    expect(await connectActivateCredential({ staged })).toEqual({ ok: true, value: { credentialRevision: 1 } });
    expect(calls()).toEqual(["outside.candidate-apply"]);
    mocks.keeper.mockResolvedValueOnce({ kind: "apply", outcome: "applied", credentialRevision: 2 });
    expect(await connectActivateCredential({ staged })).toMatchObject({ ok: false });
  });
  it("applies waiting declarations only when there are some", async () => {
    mocks.keeper.mockResolvedValueOnce(state());
    expect(await connectApplyAgent({ agent: "worker" })).toEqual({ ok: true, value: { applied: true } });
    expect(calls()).toEqual(["outside.connections.get"]);
    mocks.keeper.mockClear();
    mocks.keeper.mockResolvedValueOnce(state({ applicationStatus: "pending" })).mockResolvedValueOnce(state());
    expect(await connectApplyAgent({ agent: "worker" })).toEqual({ ok: true, value: { applied: true } });
    expect(calls()).toEqual(["outside.connections.get", "outside.connections.apply"]);
  });
  it("takes a half-set-up declaration back and says when there is nothing to remove", async () => {
    mocks.keeper.mockResolvedValueOnce(state({ connections: [declared([PENDING_TOOL])] })).mockResolvedValueOnce(state());
    expect(await connectRemoveDeclaration({ agent: "worker", name: "rates" })).toEqual({ ok: true, value: { removed: true } });
    expect(mocks.keeper.mock.calls[1]![1].connections).toEqual([]);
    mocks.keeper.mockClear();
    mocks.keeper.mockResolvedValueOnce(state());
    expect(await connectRemoveDeclaration({ agent: "worker", name: "rates" })).toEqual({ ok: true, value: { removed: false } });
  });
});
