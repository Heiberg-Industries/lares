/**
 * THE TURNS THAT ASKED AN APPROVAL CARD (eve 1.0, every door). Durable, so a restart cannot reopen them.
 *
 * eve 1.0 continues a paused turn after a card is answered, as the person who ASKED: on Slack or
 * Telegram that is the owner, so `auth.current` alone would let the continuation's model call an
 * ungated write (`remember`, `forget`, `deadline_add`, `deadline_reset`) as if the owner had just
 * said so. Once a turn has asked an approval card, the rest of that turn carries no new human
 * instruction (`humanTurnRefusal` in lib/approvals.ts reads this).
 *
 * WHERE IT LIVES. In eve's own durable per-session state (`defineState`, eve
 * `docs/concepts/state.md`: hooks write it, tools read it, it survives crashes and redeploys), not
 * in process memory: a native turn needs no model capability, so nothing else refuses the
 * continuation after a restart.
 *
 * WHEN IT IS WRITTEN. When the card OPENS (`interaction.opened`), not only when it settles. eve
 * does not rerun hooks for lines an interrupted step already wrote, and it checkpoints before it
 * waits for an approval (`docs/concepts/execution-model-and-durability.mdx`, "Resuming after a
 * crash"). So a mark written by the opening hook is in the checkpoint every answerable card waits
 * from; a step interrupted before that checkpoint leaves its card `abandoned`, which nobody can
 * answer. A mark written only by the settle hook could be lost to a crash between the settle line
 * and the next checkpoint, after which the continuation runs. The settle hook marks too; it changes
 * nothing when the opening hook already did.
 *
 * The cost: an ungated write the model requests in the same turn after a card opened is refused,
 * even before the card is answered. It is refused with a sentence, never silently, and nothing
 * changes; the owner can say it again in a new message.
 *
 * FAILS CLOSED. A turn with no id, or state that cannot be read, counts as a turn that asked a card.
 * A mark that cannot be written throws, which fails the turn before it can continue.
 */
import { defineState } from "eve/context";

/** Recent turns only: the turn that matters is always the session's latest. */
const MAX_TURNS = 64;
const cardTurns = defineState<readonly string[]>("lares.approval-card-turns", () => []);
/** The turns in which a person's answer to a card was applied (written at settle). Only says which
 *  sentence is true when that turn's reply is refused; it widens nothing. */
const answeredTurns = defineState<readonly string[]>("lares.approval-answered-turns", () => []);

type TurnLike = { turn?: { id?: unknown } | null } | null | undefined;

/** Record that `turnId` asked an approval card. Throws when it cannot, so the turn fails closed. */
export function noteApprovalCardTurn(turnId: unknown): void {
  if (typeof turnId !== "string" || !turnId) throw new Error("An approval card's turn could not be recorded");
  cardTurns.update((ids) => (ids.includes(turnId) ? ids : [...ids, turnId].slice(-MAX_TURNS)));
}

/** True when this session's current turn asked an approval card, or when that cannot be known. */
export function turnAskedACard(session: TurnLike): boolean {
  const turnId = session?.turn?.id;
  if (typeof turnId !== "string" || !turnId) return true;
  try {
    const ids = cardTurns.get();
    return !Array.isArray(ids) || ids.includes(turnId);
  } catch {
    return true;
  }
}

/** Record that a person's answer (Approve or Deny) to a card in `turnId` was applied. Throws when it
 *  cannot, like {@link noteApprovalCardTurn}. */
export function noteAnswerApplied(turnId: unknown): void {
  if (typeof turnId !== "string" || !turnId) throw new Error("An approval card's turn could not be recorded");
  answeredTurns.update((ids) => (ids.includes(turnId) ? ids : [...ids, turnId].slice(-MAX_TURNS)));
}

/** What the model is told when an action that reaches other people is refused by
 *  {@link outwardActionAfterAnswerRefusal}. It says nothing about the earlier card. */
export const ANSWERED_TURN_REFUSED = "That cannot be started in the reply to an answered request. Ask again in a new message.";

/**
 * AN ACTION THAT REACHES OTHER PEOPLE CANNOT BE STARTED IN THE REPLY TO AN ANSWERED REQUEST.
 * One rule, read by every approval check it covers (the owner's ruling): the personal mail send
 * (lib/personal-send-approval.ts), the calendar writes, `gmail_send` and `meeting_followup_send`
 * (`catalogueApprovalRequest` in lib/approvals.ts), and every outside (MCP) tool call
 * (`requestOutsideApproval` in lib/outside-tools.ts). It is the same at every door.
 *
 * On eve 1.0 an answered card (Approve or Deny) does not start a new turn: the paused turn carries
 * on as the person who ASKED, so that continuation could raise another card for another outward
 * action. Nothing caps that chain, each round is model calls charged to that person, and a hurried
 * Approve on the second card could do the same thing twice (the same mail, a second invitation or
 * cancellation to the attendees). So in a turn in which a person's answer to a card was applied, a
 * NEW such action is refused before its card, its draft or any provider call; the person asks again
 * in a new message, which is a new turn. The approved action of the answered card itself never
 * reaches this: eve re-asks its policy as a recheck, which every caller lets through first.
 *
 * Read from the durable answer mark below, written by the settle hook. FAILS CLOSED: a turn with no
 * id, or state that cannot be read, is refused like an answered one. Returns eve's denial (the model
 * reads `reason`), or undefined when the rule does not apply.
 */
export function outwardActionAfterAnswerRefusal(session: TurnLike, reason: string = ANSWERED_TURN_REFUSED): { type: "denied"; reason: string } | undefined {
  return turnAppliedAnAnswer(session) === false ? undefined : { type: "denied", reason };
}

/** Whether a person's answer to a card was applied in this session's current turn; undefined when
 *  that cannot be known (no turn id, unreadable state). */
export function turnAppliedAnAnswer(session: TurnLike): boolean | undefined {
  const turnId = session?.turn?.id;
  if (typeof turnId !== "string" || !turnId) return undefined;
  try {
    const ids = answeredTurns.get();
    return Array.isArray(ids) ? ids.includes(turnId) : undefined;
  } catch {
    return undefined;
  }
}
