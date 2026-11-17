import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOORS, claimEnvNames } from "@lares/agent-kit/door-kinds";

const keeper = vi.hoisted(() => ({ calls: [] as Array<{ op: string; input: Record<string, unknown> }>, fail: false }));
vi.mock("@lares/agent-kit/vault-broker-client", async (original) => {
  const real = await original<typeof import("@lares/agent-kit/vault-broker-client")>();
  return { ...real, vaultBrokerRequest: async (op: string, input: Record<string, unknown>) => {
    keeper.calls.push({ op, input });
    if (keeper.fail) throw new Error("Vault reader unavailable (the keeper refused: grant)");
    return op === "door.turn.open" ? { ok: true, turnCapability: "p".repeat(43), expiresAt: Date.now() + 60_000 } : { ok: true };
  } };
});
vi.mock("../lib/definition.js", () => ({ thisAgent: async () => ({ loaded: { definition: {}, dutiesMd: "", voiceMd: "", hash: "h".repeat(64) } }) }));

const INCARNATION = "11111111-1111-4111-8111-111111111111";
const REVISION = "5c1ac4e0-0000-4000-8000-000000000001";
const SENDER = "U0CLAIMED";
// A private chat and a shared room for each door in the table; a new door fails the first test until it adds both.
const PLACES: Record<string, { privateChat: Record<string, unknown>; room: Record<string, unknown> }> = {
  slack: { privateChat: { channel_id: "D0DIRECT", author_type: "user" }, room: { channel_id: "C0ROOM", author_type: "user" } },
  telegram: { privateChat: { chat_type: "private" }, room: { chat_type: "group" } },
};
const kinds = [...new Set(Object.values(DOORS).map((row) => row.door))];
const auth = (door: string, where: "privateChat" | "room") =>
  ({ authenticator: Object.entries(DOORS).find(([, row]) => row.door === door)![0], principalType: "user", attributes: { user_id: SENDER, ...PLACES[door]![where] } });
const ctx = (current: unknown, initiator: unknown = current) => ({ session: { id: "session_1", turn: { id: "turn_0", sequence: 0 }, auth: { current, initiator } } });

let hook: { events: Record<string, (event: unknown, ctx: unknown) => Promise<void>> };
beforeEach(async () => {
  keeper.calls = []; keeper.fail = false;
  vi.stubEnv("LARES_AGENT_NAME", "helper"); vi.stubEnv("LARES_AGENT_INCARNATION", INCARNATION);
  for (const door of kinds) { const names = claimEnvNames(door); vi.stubEnv(names.principal, SENDER); vi.stubEnv(names.revision, REVISION); }
  hook = (await import("../agent/hooks/private-vault-turn.js")).default as never;
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("the turn-start hook opens a door pass, over every door in the table", () => {
  it("has a private chat and a room for every door", () => { expect(kinds.sort()).toEqual(Object.keys(PLACES).sort()); });
  for (const door of kinds) {
    it(`${door}: opens one pass for the claimed person in a private chat, and closes it when the turn settles`, async () => {
      const c = ctx(auth(door, "privateChat"));
      await hook.events["turn.started"]!({ data: { turnId: "turn_0" } }, c);
      expect(keeper.calls.map((call) => call.op)).toEqual(["door.turn.open"]);
      expect(keeper.calls[0]!.input).toMatchObject({ door, principal: SENDER, claimRevision: REVISION, chat: "private" });
      await hook.events["turn.settled"]!({ data: { turnId: "turn_0" } }, c);
      expect(keeper.calls.map((call) => call.op)).toEqual(["door.turn.open", "door.turn.close"]);
      expect(keeper.calls[1]!.input).toMatchObject({ turnCapability: "p".repeat(43), turnId: "turn_0", sequence: 0 });
    });
    it(`${door}: opens nothing in a shared room`, async () => {
      await hook.events["turn.started"]!({ data: { turnId: "turn_0" } }, ctx(auth(door, "room")));
      expect(keeper.calls).toEqual([]);
    });
    it(`${door}: a refused pass never fails the turn`, async () => {
      keeper.fail = true;
      await expect(hook.events["turn.started"]!({ data: { turnId: "turn_0" } }, ctx(auth(door, "privateChat")))).resolves.toBeUndefined();
    });
  }
});
