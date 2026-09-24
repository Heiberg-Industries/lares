/**
 * agent/tools/forget.ts — retire a standing fact the owner has superseded (ORB-167).
 *
 * The other half of `remember`. Without it the store is a ratchet: "I've switched to driving"
 * would leave the train fact standing beside the car one, and every brief afterwards would carry
 * both. A memory that cannot be corrected is worse than none, because he stops trusting the ones
 * that are right.
 *
 * RETIRING IS NOT DELETING. `forgetFact` stamps `retired_at`; the row stays. The superseded fact
 * is what explains why she used to say "train", and nothing in this system is worth losing that.
 *
 * GATED (ORB-278 step 1): retiring a fact is a delete — `TOOL_CATEGORIES` (@lares/agent-kit/always-ask)
 * marks it so, and `mustAlwaysAsk` makes the board ask before every call regardless of any level set
 * for `memory`. `remember` stays ungated (it reaches nobody outside this box); `forget` is the
 * riskier of the two (a wrong id silently drops a fact he stated), which is why the description
 * also tells the model to name the fact back rather than guess an id, and why an unknown or
 * already-retired id answers "nothing changed" instead of "done".
 *
 * BUT ONLY WHEN HE IS IN THE TURN (review fix, the same hole as `remember`'s). Ungated is not
 * unattributed: the 08:00/20:00 brief turns run as the app principal, carry the facts block and
 * the sentence "if he supersedes one, call `forget`", and contain no utterance of his at all — so
 * a model re-reading a stale-looking fact there could retire it with nobody present to have
 * superseded anything. `humanTurnRefusal` (lib/approvals.ts) requires an allowlisted HUMAN on
 * `ctx.session.auth.current`; the refusal is a returned message, matching this tool's existing
 * "nothing changed" posture rather than costing the turn.
 *
 * ONE STEP, WRITTEN DOWN (ORB-167 follow-up). Retiring used to be the whole job; now the same
 * transaction that retires the row also writes a `forget_ledger` entry (`recordForgotten`,
 * `@lares/agent-kit/forget-ledger`) keyed on a one-way hash of the fact's words — so a later
 * `remember` or a Notion re-sync can be checked against it without this tool, or that table,
 * ever holding the words back out. The ledger holds no readable text; the reply below quotes the
 * fact this tool holds in hand at the moment it retires it, never anything read back from the
 * ledger. On a box that has not applied `services/box/sql/076_forget_ledger.sql`,
 * `isMissingLedgerTable` catches the failure OUTSIDE the transaction `forgetFact` ran (which has
 * already rolled itself back), and this tool simply retires the fact again with no ledger writer
 * — one step still, just without the "cannot come back" half, and the reply says so.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import type { PoolClient } from "pg";

import { getPool } from "@lares/agent-kit/db";
import { isMissingLedgerTable, recordForgotten } from "@lares/agent-kit/forget-ledger";
import { humanTurnRefusal } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";
import { configuredOwnerId } from "../lib/identity-client.js";
import { forgetFact, type StandingFact } from "../lib/standing-facts.js";

/** Built here, not in `lib/standing-facts.ts`, so that file keeps no dependency on the ledger
 *  module. Runs inside `forgetFact`'s own transaction — see `ForgetLedgerWriter`.
 *
 *  HOT-PATH HONESTY (W5I-s7): `f.userId` is `CANONICAL_USER_ID` — the fail-soft configured owner
 *  key (`ownerId()`), not a live read of the identity register. That is deliberate: this runs
 *  inside a turn, and a register round-trip here would cost the turn a query for a value that
 *  practically never changes mid-process. The register-verified check is done ONCE per process,
 *  not on every `forget` call — `checkOwnerKeyAgreement` (W5I-s5b, `lib/identity-client.ts`)
 *  compares this same key against `users.id` at boot and raises a repair the moment they
 *  disagree, rather than silently filing every write under a name notion-sync's forgotten-file
 *  guard does not look under. `recordForgotten` itself also refuses a value that does not even
 *  LOOK canonical (`assertCanonicalOwner`, packages/vault-format/src/forget-ledger.ts). */
async function writeLedger(client: PoolClient, f: StandingFact): Promise<void> {
  await recordForgotten(client, { owner: f.userId, kind: "fact", words: f.fact, reason: "forget" });
}

export default defineTool({
  description:
    "Retire a standing fact the owner has superseded or told you to drop — \"I've switched to " +
    "driving\", \"forget that\". Pass the id shown in square brackets beside the fact in your " +
    "\"What I have been told\" block. It stops being applied from the next conversation on, and " +
    "you must stop applying it immediately in this one; nothing is deleted and nobody is told. " +
    "If you are not certain which fact is meant, say the fact back and ask — retiring the wrong " +
    "one silently removes something the owner stated, and they will only notice when a brief " +
    "gets it wrong. When a fact is REPLACED rather than dropped, do not call this: call " +
    "`remember` with the new words and `supersedes` set to the old fact's id, so the two rows " +
    "stay linked.",
  inputSchema: z.object({
    id: z.number().int().positive().describe("The id in square brackets beside the fact."),
  }),
  approval: approvalFor("forget"),
  async execute({ id }, ctx) {
    const notHim = humanTurnRefusal(
      ctx.session?.auth,
      "Only the owner can retire a standing fact they stated.",
    );
    if (notHim) return { forgotten: false as const, message: notHim };

    const pool = getPool();
    // CANONICAL_USER_ID for the same reason as `remember` — see its call site's comment.
    let retired: StandingFact | null;
    let ledgerMissing = false;
    try {
      retired = await forgetFact(pool, id, configuredOwnerId(), undefined, writeLedger);
    } catch (err) {
      if (!isMissingLedgerTable(err)) throw err;
      // `forgetFact` rolled its own transaction back, so the id is exactly as it was — this
      // second call is the only writer of the retirement, not a second attempt at one.
      ledgerMissing = true;
      retired = await forgetFact(pool, id, configuredOwnerId());
    }
    // Never "forgotten" for an update that changed nothing. A guessed or stale id updates zero
    // rows; reporting success there would tell him a correction landed when it did not.
    if (!retired) {
      return {
        forgotten: false as const,
        message: `No standing fact with id ${id} — either it is already retired or that is not its id. Nothing changed.`,
      };
    }
    return {
      forgotten: true as const,
      fact: retired.fact,
      message: ledgerMissing
        ? "Retired. This installation does not keep a forget ledger yet, so a re-import could " +
          "bring it back — apply services/box/sql/076_forget_ledger.sql to close that."
        : `Retired — I'll stop applying "${retired.fact}", and it is written down so a re-import ` +
          "or a re-sync cannot bring it back.",
    };
  },
});
