/**
 * A real eve session view for tests, built by folding real event shapes through eve's own
 * `foldEvents`. The approval hooks read the tool name and input of a card from `ctx.view`
 * (`interaction(view, id).call`), so a test that wants the hook to see a card builds the call and the
 * interaction here and hands `session.view` to the hook as `ctx.view`. Nothing here is a stub of
 * eve's reader: if eve changes how a view is built, these tests fail with it.
 */
import { emptySessionView, foldEvents, type SessionView } from "eve/events";

export type Outcome = "accepted" | "declined" | "invalid" | "failed" | "withdrawn" | "interrupted" | "abandoned" | "expired";

export interface EveEvent {
  type: string;
  data: Record<string, unknown>;
  scope?: Record<string, unknown>;
  meta: { position: { line: number; index: number }; at: string; endOfLine: true };
}

export function eveSession(turnId = "turn-1") {
  let line = 0;
  let view: SessionView = emptySessionView();
  const push = (type: string, data: Record<string, unknown>, scope: Record<string, unknown> = { turnId }): EveEvent => {
    const event: EveEvent = { type, data, scope, meta: { position: { line: line++, index: 0 }, at: new Date().toISOString(), endOfLine: true } };
    view = foldEvents(view, [event]);
    return event;
  };
  push("turn.started", { turnId, cause: { deliveryId: "d1" }, follows: null });
  return {
    get view(): SessionView {
      return view;
    },
    /** The model asked for a call. `kind` defaults to a tool. */
    call(callId: string, name: string, input: unknown, kind = "tool"): EveEvent {
      return push("call.requested", { callId, owner: { turnId }, capability: { kind, name }, input });
    },
    /** eve opened an approval card (or another kind of interaction) for a call. */
    open(interactionId: string, callId: string, kind = "approval"): EveEvent {
      return push("interaction.opened", {
        interactionId,
        subject: { callId },
        request: { kind, prompt: "Approve?", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] },
      });
    },
    /** The card ended. `optionId` is the option a person chose, when one did. */
    settle(interactionId: string, outcome: Outcome, optionId?: string): EveEvent {
      return push("interaction.settled", { interactionId, outcome, ...(optionId !== undefined && { response: { optionId } }) });
    },
    /** The call ended. */
    settleCall(callId: string, outcome: string, output?: unknown): EveEvent {
      return push("call.settled", { callId, outcome, ...(output !== undefined && { output }) });
    },
  };
}
