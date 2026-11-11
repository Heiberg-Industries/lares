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
