/**
 * The two small hooks every role installs for the console's conversation list and private-chat
 * binding, driven with eve 1.0 events. Both roles ship the same two files.
 *
 *  - `conversations`: a `*` hook that feeds the kit's conversation projection. eve 1.0 fails the
 *    running turn when a hook throws, so nothing may escape from it.
 *  - `console-turn-authority`: binds a private console conversation when its session starts. It is the
 *    opposite on purpose: when the binding cannot be made it must throw, so eve fails the turn.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ observe: vi.fn(), bind: vi.fn() }));
vi.mock("@lares/agent-kit/conversation-control", () => ({ observeConversation: fake.observe }));
vi.mock("@lares/agent-kit/console-turn-authority", () => ({ bindConsoleSessionStarted: fake.bind }));

type Handler = (event: never, ctx: never) => Promise<void>;
const roles = {
  "chief-of-staff": async () => ({
    conversations: (await import("../agent/hooks/conversations.js")).default,
    authority: (await import("../agent/hooks/console-turn-authority.js")).default,
  }),
  creative: async () => ({
    conversations: (await import("../../creative/agent/hooks/conversations.js")).default,
    authority: (await import("../../creative/agent/hooks/console-turn-authority.js")).default,
  }),
};
const ctx = { session: { id: "wrun_1", auth: { current: null, initiator: null } }, channel: { kind: "channel:slack" } } as never;

beforeEach(() => { fake.observe.mockReset(); fake.bind.mockReset(); });

for (const [role, load] of Object.entries(roles)) {
  describe(`${role}: conversations hook`, () => {
    it("is one `*` handler, so every fact (but the progress records) reaches the projection", async () => {
      const { conversations } = await load();
      expect(Object.keys((conversations as { events: object }).events)).toEqual(["*"]);
    });

    it("hands each eve 1.0 event to the projection untouched, with its context", async () => {
      const { conversations } = await load();
      const handler = (conversations as { events: Record<string, Handler> }).events["*"]!;
      const sent = [
        { type: "session.started", data: {} },
        { type: "interaction.opened", data: { interactionId: "i1", subject: { callId: "c1" }, request: { kind: "approval", prompt: "Approve?" } } },
        { type: "delivery.settled", data: { deliveryId: "d1", outcome: "handled" } },
        { type: "session.ended", data: { outcome: "completed" } },
        { type: "an.event.eve.adds.later", data: {} },
      ];
      for (const event of sent) await handler(event as never, ctx);
      expect(fake.observe.mock.calls.map(([event]) => (event as { type: string }).type)).toEqual(sent.map((e) => e.type));
      expect(fake.observe.mock.calls.every(([, c]) => c === ctx)).toBe(true);
    });

    it("never throws out of the hook, even when the projection does (eve would fail the turn)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      fake.observe.mockRejectedValue(new Error("projection down"));
      const { conversations } = await load();
      const handler = (conversations as { events: Record<string, Handler> }).events["*"]!;
      await expect(handler({ type: "session.ended", data: {} } as never, ctx)).resolves.toBeUndefined();
      fake.observe.mockImplementation(() => { throw new Error("sync failure"); });
      await expect(handler({ type: "session.ended", data: {} } as never, ctx)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe(`${role}: console-turn-authority hook`, () => {
    it("is keyed on session.started only", async () => {
      const { authority } = await load();
      expect(Object.keys((authority as { events: object }).events)).toEqual(["session.started"]);
    });

    it("binds the conversation from the context, and lets a refusal fail the turn", async () => {
      const { authority } = await load();
      const handler = (authority as { events: Record<string, Handler> }).events["session.started"]!;
      fake.bind.mockResolvedValue(undefined);
      await expect(handler({ type: "session.started", data: {} } as never, ctx)).resolves.toBeUndefined();
      expect(fake.bind).toHaveBeenCalledWith(ctx);
      fake.bind.mockRejectedValue(new Error("Conversation authority is not available"));
      await expect(handler({ type: "session.started", data: {} } as never, ctx)).rejects.toThrow("Conversation authority");
    });
  });
}
