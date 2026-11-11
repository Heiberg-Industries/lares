/**
 * The two per-turn guards of a private console conversation, on eve 1.0's turn events.
 *
 * `private-model-turn` opens the model-purpose capability and `private-vault-turn` the Vault
 * capability when a verified private turn starts, and both must close it when the turn ends, for
 * EVERY outcome (`turn.settled`: completed, failed, cancelled) and when it pauses for a person
 * (`turn.paused`). A capability left open after a failed or cancelled turn is the bug to avoid.
 *
 * eve 1.0's `turn.started` carries `{ turnId, cause, follows }` and no sequence; the sequence is read
 * from `ctx.session.turn`, and only when that is the event's own turn.
 * The events are shaped from node_modules/eve/dist/src/protocol/session-events/families/turn.d.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ purpose: vi.fn(), vault: vi.fn(), agent: vi.fn() }));
vi.mock("@lares/agent-kit/model-purpose-client", () => ({ modelPurposeRequest: fake.purpose }));
vi.mock("@lares/agent-kit/vault-broker-client", () => ({ vaultBrokerRequest: fake.vault }));
vi.mock("../lib/definition.js", () => ({ thisAgent: fake.agent }));

import modelGuard from "../agent/hooks/private-model-turn.js";
import vaultGuard from "../agent/hooks/private-vault-turn.js";
import { vaultTurnCapability, clearSessionVaultTurnCapabilities } from "../agent/lib/vault-turn.js";

const INCARNATION = "11111111-1111-4111-8111-111111111111";
const NONCE = "a".repeat(43);
const RECEIPT = "r".repeat(43);
const CAPABILITY = "c".repeat(43);
const humanAuth = (extra: Record<string, unknown> = {}) => ({
  authenticator: "lares-console", principalType: "user", principalId: "member-1",
  attributes: { lares_member_id: "member-1", lares_admission_nonce: NONCE, lares_purpose: "human", ...extra },
});

let counter = 0;
/** A hook context for one turn of one session. */
const ctxFor = (opts: { sessionId: string; turnId: string; sequence?: number; turnOverride?: unknown; auth?: unknown }) => ({
  agent: { name: "helper" },
  channel: { kind: "channel:eve" },
  position: { line: ++counter, index: 0 },
  session: {
    id: opts.sessionId,
    auth: { current: opts.auth ?? null, initiator: opts.auth ?? null },
    ...("turnOverride" in opts
      ? (opts.turnOverride === undefined ? {} : { turn: opts.turnOverride })
      : { turn: { id: opts.turnId, sequence: opts.sequence ?? 0 } }),
  },
}) as never;
const started = (turnId: string) => ({ type: "turn.started", scope: { turnId }, data: { turnId, cause: { deliveryId: "d1" }, follows: null } }) as never;
const settled = (turnId: string, outcome: "completed" | "failed" | "cancelled") =>
  ({ type: "turn.settled", scope: { turnId }, data: { turnId, outcome, ...(outcome === "failed" ? { error: { code: "x", message: "x" } } : {}) } }) as never;
const paused = (turnId: string) => ({ type: "turn.paused", scope: { turnId }, data: { turnId, awaiting: [{ interactionId: "i1" }] } }) as never;

type Handler = (event: never, ctx: never) => Promise<void>;
const events = (hook: unknown) => (hook as { events: Record<string, Handler> }).events;

beforeEach(() => {
  vi.stubEnv("LARES_AGENT_NAME", "helper");
  vi.stubEnv("LARES_AGENT_INCARNATION", INCARNATION);
  fake.purpose.mockImplementation(async (op: string) => (op === "turn.open" ? { capability: CAPABILITY, expiresAt: Date.now() + 60_000 } : {}));
  fake.vault.mockImplementation(async (op: string) => (op === "turn.open" ? { turnCapability: CAPABILITY, expiresAt: Date.now() + 60_000 } : {}));
  fake.agent.mockResolvedValue({ loaded: { definition: { name: "helper" }, dutiesMd: "d", voiceMd: "v", hash: "h" } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

const closes = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.filter(([op]) => op === "turn.close");
const opens = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.filter(([op]) => op === "turn.open");

describe("private-model-turn", () => {
  const verified = (sessionId: string, turnId: string, sequence = 0) =>
    ctxFor({ sessionId, turnId, sequence, auth: humanAuth({ lares_model_purpose_required: "1", lares_model_pending_receipt: RECEIPT }) });

  it("subscribes to eve 1.0 turn events only", () => {
    expect(Object.keys(events(modelGuard)).sort()).toEqual(["turn.paused", "turn.settled", "turn.started"]);
  });

  it("opens on turn.started with the sequence from ctx.session.turn, and closes it on every outcome", async () => {
    for (const outcome of ["completed", "failed", "cancelled"] as const) {
      fake.purpose.mockClear();
      const sessionId = `model-${outcome}`;
      await events(modelGuard)["turn.started"](started("t1"), verified(sessionId, "t1", 4));
      expect(opens(fake.purpose)).toHaveLength(1);
      expect(opens(fake.purpose)[0]?.[1]).toMatchObject({ pendingReceipt: RECEIPT, context: { session: { id: sessionId, turn: { id: "t1", sequence: 4 } } } });
      expect(closes(fake.purpose)).toHaveLength(0);
      await events(modelGuard)["turn.settled"](settled("t1", outcome), verified(sessionId, "t1", 4));
      expect(closes(fake.purpose), outcome).toHaveLength(1);
      expect(closes(fake.purpose)[0]?.[1]).toEqual({ turnCapability: CAPABILITY, turnId: "t1", sequence: 4 });
      // Closing is once: a repeat of the settle finds nothing open.
      await events(modelGuard)["turn.settled"](settled("t1", outcome), verified(sessionId, "t1", 4));
      expect(closes(fake.purpose), outcome).toHaveLength(1);
    }
  });

  it("closes when the turn pauses for a person, and does not reopen on the same turn", async () => {
    await events(modelGuard)["turn.started"](started("t1"), verified("model-pause", "t1", 2));
    await events(modelGuard)["turn.paused"](paused("t1"), verified("model-pause", "t1", 2));
    expect(closes(fake.purpose)).toHaveLength(1);
    await events(modelGuard)["turn.settled"](settled("t1", "completed"), verified("model-pause", "t1", 2));
    expect(closes(fake.purpose)).toHaveLength(1);
  });

  it("closes even when ctx.session.turn no longer names the settled turn: the sequence is remembered from the start", async () => {
    await events(modelGuard)["turn.started"](started("t1"), verified("model-late", "t1", 6));
    await events(modelGuard)["turn.settled"](settled("t1", "cancelled"), verified("model-late", "t-next", 7));
    expect(closes(fake.purpose)).toHaveLength(1);
    expect(closes(fake.purpose)[0]?.[1]).toMatchObject({ turnId: "t1", sequence: 6 });
  });

  it("gives a turn that is not a verified private console turn NO capability", async () => {
    const cases: Array<[string, unknown]> = [
      ["a door conversation", { authenticator: "telegram-webhook", principalType: "user", principalId: "1", attributes: {} }],
      ["no caller at all", null],
      ["a console caller with nothing required", humanAuth()],
      ["a resolver, not a human", humanAuth({ lares_purpose: "resolver", lares_model_purpose_required: "1", lares_model_pending_receipt: RECEIPT })],
      ["another member's tag without admission", { authenticator: "lares-console", attributes: { lares_member_id: "member-2" } }],
    ];
    for (const [name, auth] of cases) {
      await events(modelGuard)["turn.started"](started("t1"), ctxFor({ sessionId: `model-none-${name}`, turnId: "t1", auth }));
      await events(modelGuard)["turn.settled"](settled("t1", "completed"), ctxFor({ sessionId: `model-none-${name}`, turnId: "t1", auth }));
    }
    expect(fake.purpose).not.toHaveBeenCalled();
  });

  it("refuses (fails the turn) when custody is required but the turn cannot be placed or the receipt is missing", async () => {
    // Required, no receipt.
    await expect(events(modelGuard)["turn.started"](started("t1"),
      ctxFor({ sessionId: "model-bad-1", turnId: "t1", auth: humanAuth({ lares_model_purpose_required: "1" }) }))).rejects.toThrow("Model purpose authority");
    // ctx.session.turn is a different turn: no sequence is invented.
    await expect(events(modelGuard)["turn.started"](started("t1"),
      ctxFor({ sessionId: "model-bad-2", turnId: "t1", turnOverride: { id: "t-other", sequence: 3 }, auth: humanAuth({ lares_model_purpose_required: "1", lares_model_pending_receipt: RECEIPT }) }))).rejects.toThrow("Model purpose authority");
    // No turn on the context at all.
    await expect(events(modelGuard)["turn.started"](started("t1"),
      ctxFor({ sessionId: "model-bad-3", turnId: "t1", turnOverride: undefined, auth: humanAuth({ lares_model_purpose_required: "1", lares_model_pending_receipt: RECEIPT }) }))).rejects.toThrow("Model purpose authority");
    expect(opens(fake.purpose)).toHaveLength(0);
  });

  it("a settle that arrives with nothing open closes nothing and does not throw", async () => {
    await expect(events(modelGuard)["turn.settled"](settled("t-unknown", "failed"), verified("model-empty", "t-unknown"))).resolves.toBeUndefined();
    await expect(events(modelGuard)["turn.settled"]({ data: null } as never, {} as never)).resolves.toBeUndefined();
    expect(closes(fake.purpose)).toHaveLength(0);
  });
});

describe("private-vault-turn", () => {
  const verified = (sessionId: string, turnId: string, sequence = 0) =>
    ctxFor({ sessionId, turnId, sequence, auth: humanAuth({ lares_vault_pending: "p".repeat(43) }) });
  const key = (sessionId: string, turnId: string, sequence = 0) => ({ sessionId, turnId, sequence, incarnation: INCARNATION });
  afterEach(() => { for (const id of ["vault-a", "vault-b", "vault-c", "vault-d", "vault-e"]) clearSessionVaultTurnCapabilities(id, INCARNATION); });

  it("subscribes to eve 1.0 turn events only", () => {
    expect(Object.keys(events(vaultGuard)).sort()).toEqual(["turn.paused", "turn.settled", "turn.started"]);
  });

  it("opens on turn.started with the sequence from ctx.session.turn, and closes it on every outcome", async () => {
    for (const outcome of ["completed", "failed", "cancelled"] as const) {
      fake.vault.mockClear();
      const sessionId = `vault-${outcome}`;
      await events(vaultGuard)["turn.started"](started("t1"), verified(sessionId, "t1", 3));
      expect(opens(fake.vault)).toHaveLength(1);
      expect(opens(fake.vault)[0]?.[1]).toMatchObject({ sessionId, turnId: "t1", sequence: 3, memberId: "member-1", admissionNonce: NONCE });
      expect(vaultTurnCapability(key(sessionId, "t1", 3))?.capability).toBe(CAPABILITY);
      await events(vaultGuard)["turn.settled"](settled("t1", outcome), verified(sessionId, "t1", 3));
      expect(vaultTurnCapability(key(sessionId, "t1", 3)), outcome).toBeUndefined();
      expect(closes(fake.vault), outcome).toHaveLength(1);
      expect(closes(fake.vault)[0]?.[1]).toEqual({ turnCapability: CAPABILITY, turnId: "t1", sequence: 3 });
      clearSessionVaultTurnCapabilities(sessionId, INCARNATION);
    }
  });

  it("closes when the turn pauses for a person", async () => {
    await events(vaultGuard)["turn.started"](started("t1"), verified("vault-a", "t1", 1));
    expect(vaultTurnCapability(key("vault-a", "t1", 1))).toBeDefined();
    await events(vaultGuard)["turn.paused"](paused("t1"), verified("vault-a", "t1", 1));
    expect(vaultTurnCapability(key("vault-a", "t1", 1))).toBeUndefined();
    expect(closes(fake.vault)).toHaveLength(1);
  });

  it("closes even when ctx.session.turn no longer names the settled turn", async () => {
    await events(vaultGuard)["turn.started"](started("t1"), verified("vault-b", "t1", 5));
    await events(vaultGuard)["turn.settled"](settled("t1", "failed"), verified("vault-b", "t-next", 6));
    expect(vaultTurnCapability(key("vault-b", "t1", 5))).toBeUndefined();
    expect(closes(fake.vault)[0]?.[1]).toMatchObject({ turnId: "t1", sequence: 5 });
  });

  it("a settle that lands while the broker is still opening wins: the late capability is closed, never stored", async () => {
    let release!: (value: unknown) => void;
    fake.vault.mockImplementation(async (op: string) => (op === "turn.open"
      ? new Promise((resolve) => { release = resolve; })
      : {}));
    const opening = events(vaultGuard)["turn.started"](started("t1"), verified("vault-c", "t1", 0));
    await vi.waitFor(() => expect(opens(fake.vault)).toHaveLength(1));
    await events(vaultGuard)["turn.settled"](settled("t1", "cancelled"), verified("vault-c", "t1", 0));
    release({ turnCapability: CAPABILITY, expiresAt: Date.now() + 60_000 });
    await opening;
    expect(vaultTurnCapability(key("vault-c", "t1", 0))).toBeUndefined();
    expect(closes(fake.vault).map((call) => call[1])).toContainEqual({ turnCapability: CAPABILITY, turnId: "t1", sequence: 0 });
  });

  it("gives a turn that is not a verified private human turn NO capability (the non-owner case)", async () => {
    const cases: Array<[string, unknown]> = [
      ["a door conversation", { authenticator: "slack-webhook", principalType: "user", principalId: "U1", attributes: {} }],
      ["no caller", null],
      ["a console human without a broker receipt", humanAuth()],
      ["a console human with a malformed receipt", humanAuth({ lares_vault_pending: "short" })],
      ["a resolver", humanAuth({ lares_purpose: "resolver", lares_vault_pending: "p".repeat(43) })],
      ["a malformed admission", { authenticator: "lares-console", attributes: { lares_member_id: "member-1", lares_vault_pending: "p".repeat(43) } }],
    ];
    for (const [name, auth] of cases) {
      const c = ctxFor({ sessionId: "vault-d", turnId: "t1", sequence: 0, auth });
      await events(vaultGuard)["turn.started"](started("t1"), c);
      expect(vaultTurnCapability(key("vault-d", "t1", 0)), name).toBeUndefined();
    }
    expect(opens(fake.vault)).toHaveLength(0);
  });

  it("opens nothing when ctx.session.turn is missing or is not the event's turn", async () => {
    const auth = humanAuth({ lares_vault_pending: "p".repeat(43) });
    await events(vaultGuard)["turn.started"](started("t1"), ctxFor({ sessionId: "vault-e", turnId: "t1", turnOverride: { id: "t-other", sequence: 2 }, auth }));
    await events(vaultGuard)["turn.started"](started("t1"), ctxFor({ sessionId: "vault-e", turnId: "t1", turnOverride: undefined, auth }));
    await events(vaultGuard)["turn.started"](started("t1"), ctxFor({ sessionId: "vault-e", turnId: "t1", turnOverride: { id: "t1" }, auth }));
    expect(opens(fake.vault)).toHaveLength(0);
  });

  it("missing custody only turns the Vault tools off: a failed open does not throw and leaves nothing open", async () => {
    fake.vault.mockRejectedValue(new Error("broker absent"));
    await expect(events(vaultGuard)["turn.started"](started("t1"), verified("vault-a", "t1", 0))).resolves.toBeUndefined();
    expect(vaultTurnCapability(key("vault-a", "t1", 0))).toBeUndefined();
    await expect(events(vaultGuard)["turn.settled"](settled("t1", "failed"), verified("vault-a", "t1", 0))).resolves.toBeUndefined();
  });
});
