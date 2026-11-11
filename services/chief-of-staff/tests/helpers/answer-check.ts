/**
 * Drives eve 1.0's REAL answer check (`harness/hitl/responders.js`: `checkResponders`, then `weighResponders`) for one answer
 * to one approval card, built by eve's own `askApprovals`. Resolves to eve's verdict. Used by the per-door tests.
 */
import { fileURLToPath, pathToFileURL } from "node:url";

// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { askApprovals } from "eve-internals/hitl-approvals";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { responseSubmitted } from "eve-internals/interaction-facts";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { callRequested } from "eve-internals/call-facts";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { emptySessionView, foldLine } from "eve-internals/session-fold";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { initialSessionProjection } from "eve-internals/session-projection";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { ContextContainer, contextStorage } from "eve-internals/context-container";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import * as keys from "eve-internals/context-keys";


export const RESPONDERS_URL = pathToFileURL(fileURLToPath(new URL("../../node_modules/eve/dist/src/harness/hitl/responders.js", import.meta.url))).href;

type Fact = { type: string; data: Record<string, unknown> };
const TURN = "turn_0";
const CARD = "ix_card";
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

export const CARD_ID = CARD;

/** A session with one approval card open for `echo_note`, built the way eve builds it. */
function openCard(requester: unknown, toolName: string, input: unknown, ids: { callId: string; cardId: string }) {
  const table = emptySessionView();
  let position = 0;
  const fold = (...facts: Fact[]) => foldLine(table, { at: "2026-11-11T09:00:00.000Z", facts }, position++);
  fold({ type: "session.started", data: {} });
  fold({ type: "delivery.admitted", data: { deliveryId: "d0" } }, { type: "turn.started", data: { turnId: TURN, cause: { deliveryId: "d0" } } });
  fold(callRequested({ action: { callId: ids.callId, input, kind: "tool-call", toolName }, owner: { turnId: TURN } }));
  const request = {
    call: { callId: ids.callId, input, toolName }, interactionId: ids.cardId,
    request: { allowFreeform: false, display: "confirmation", kind: "approval", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }], prompt: "Approve?" },
  };
  let state: Record<string, any> = { projection: { ...initialSessionProjection(), view: table }, relayedRequestIds: new Set<string>(), responders: {}, signIns: [], turn: { remembered: {}, suspended: [] } };
  const asked = askApprovals(state, {
    event: { turnId: TURN },
    messages: [{ content: [{ input, toolCallId: ids.callId, toolName, type: "tool-call" }], role: "assistant" }],
    requester, requests: [request], responseAuthRequiredRequestIds: [ids.cardId], tasks: [],
  });
  fold(...asked.events);
  state = { ...state, turn: asked.turn };
  return { state, fold, table };
}

/** Steps 1 and 2 of eve's answer check for one answer. Resolves to what eve concluded. */
export async function driveAnswer(opts: { tool: any; toolName: string; input: unknown; requester: unknown; responder: unknown; optionId: string; withPolicy?: boolean; sessionId?: string; callId?: string; cardId?: string }) {
  const { checkResponders, weighResponders } = (await import(RESPONDERS_URL)) as any;
  const ids = { callId: opts.callId ?? "call_1", cardId: opts.cardId ?? CARD };
  const s = openCard(opts.requester, opts.toolName, opts.input, ids);
  const tool = opts.tool;
  const tools = async () => new Map([[opts.toolName, opts.withPolicy === false ? { approval: { request: tool.approval.request } } : tool]]);
  // The tool's `responseAuthRequiredRequestIds` is what eve derives from the tool: with a policy, the id is in it.
  const step = s.state.turn.suspended[0];
  const required = opts.withPolicy === false ? [] : [ids.cardId];
  s.state = { ...s.state, turn: { ...s.state.turn, suspended: [{ ...step, responseAuthRequiredRequestIds: required }] } };
  const delivery = { answers: [{ interactionId: ids.cardId, optionId: opts.optionId, responder: opts.responder, responseId: "resp_1", deliveryId: "d1" }] };
  const container = new ContextContainer();
  container.set(keys.SessionKey, { sessionId: opts.sessionId ?? "wrun_door", auth: { current: opts.requester, initiator: opts.requester }, turn: { id: TURN, sequence: 0 } });
  return contextStorage.run(container, async () => {
    const check = checkResponders(s.state, delivery, NOW);
    if (check.refused.length > 0) return { stage: "refused-before-policy" as const, reason: check.refused[0].reason };
    if (check.admit.length > 0 && Object.keys(check.weigh).length === 0) return { stage: "admitted-without-policy" as const };
    s.fold(responseSubmitted({ deliveryId: "d1", interactionId: ids.cardId, responseId: "resp_1", value: { optionId: opts.optionId } }));
    s.state = { ...s.state, responders: { ...s.state.responders, ...check.weigh } };
    const weighed = await weighResponders(s.state, { now: NOW, tools });
    const types = weighed.events.map((f: Fact) => [f.type, f.data["outcome"] ?? null]);
    if (weighed.events.some((f: Fact) => f.type === "response.admitted")) return { stage: "admitted" as const, types };
    return { stage: "held-or-refused" as const, types };
  });
}

