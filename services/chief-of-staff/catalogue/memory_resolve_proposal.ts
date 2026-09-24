// Approve or reject a waiting memory change. GATED WRITE — the owner taps Approve on the card
// on every call, and only that tap applies anything (ADR-0018 rule 2).
//
// Shaped on catalogue/atlas_resolve_proposal.ts, with two differences that matter:
//
//   1. THE APPLY IS IMMEDIATE, not "on the next sync tick". The Atlas lane hands an approved
//      proposal to a background sync engine; there is no background engine for memory, so the
//      approval and the change are one step, and the consequence sentence says so.
//   2. THE MODEL SUPPLIES AN ID, AND NOTHING ELSE THAT REACHES A WRITE. `applyMemoryProposal`
//      re-reads the proposal by that id inside the transaction that writes, so the words that
//      land in memory are the words the row has held since the night it was recorded — never a
//      text this call passed in, and never a row other than the one the proposal names. If that
//      standing row has changed since, the apply refuses and says so plainly.
//
// THREE CHECKS STAND IN FRONT OF IT, and they are not the same check:
//
//   - `assertApprover(approverFrom(ctx.session.auth))` — WHO pressed it. This is the check the
//     approval card needs: eve resumes an inline-keyboard tap with `auth: null`, so
//     `approverFrom` attributes the tap to the session's channel-verified initiator and the
//     allowlist decides. `humanTurnRefusal` (which `remember` uses) deliberately does NOT
//     appear here: it answers a different question — "did a human UTTER something on this turn"
//     — and only `auth.current` can answer it, which on a card tap is empty by eve's own
//     construction. Using it here would refuse every real approval. See lib/approvals.ts, whose
//     header states exactly this split.
//   - the card itself — an unattended turn cannot get past it: `approval` suspends the call
//     until the owner answers, so a schedule can raise this question but never settle it.
//   - the turn taint — `remember`'s second refusal, reused verbatim in spirit. If this turn has
//     already read somebody else's words, those words are not allowed to be what changes what
//     the agent believes about its owner. A fresh message costs one sentence; a laundered
//     preference costs everything downstream of it.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { stampFor, turnKeyFrom } from "@lares/agent-kit/origin-taint";
import { memoryRejectConsequence, resolveMemoryProposal } from "../lib/proposals-store.js";
import { ProposalNoLongerApplies, applyMemoryProposal } from "../lib/memory-proposal-apply.js";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Approve or reject a waiting memory change (the owner taps Approve on the card). Pass the " +
    "id and the decision ('approve' | 'reject') from memory_proposals — both are shown on the " +
    "card. Approving carries out whatever that change is straight away: it replaces a standing " +
    "preference with a new one, retires one with nothing put in its place, or, for something " +
    "the agent worked out on its own rather than something the owner said, keeps it as a " +
    "standing preference from now on. Rejecting leaves things exactly as they are, and the " +
    "same change is not raised again unless something new is observed. If a standing " +
    "preference this would have replaced has changed since the change was recorded, nothing is " +
    "applied and you are told so — read memory_proposals again rather than guessing.",
  inputSchema: z.object({
    id: z.number().int().positive(),
    decision: z.enum(["approve", "reject"]),
  }),
  approval: approvalFor("memory_resolve_proposal"),
  async execute(input, ctx) {
    await assertApproval(ctx, "memory_resolve_proposal", input);
    const { id, decision } = input;

    const key = turnKeyFrom(ctx);
    if ((key ? stampFor("owner", key) : "third_party") !== "owner") {
      return {
        id,
        decision,
        applied: false as const,
        consequence:
          "Nothing changed. Earlier in this turn you read something written by someone else, " +
          "and a change to what the owner has told me cannot rest on that. Say it again in a " +
          "fresh message and it will go through.",
      };
    }

    const pool = getPool();
    const row = await resolveMemoryProposal(pool, id, decision);

    if (decision === "reject") {
      return {
        id: row.id,
        action: row.action,
        decision,
        applied: false as const,
        consequence: memoryRejectConsequence(row),
      };
    }

    try {
      const { applied, message } = await applyMemoryProposal(pool, id);
      return { id: row.id, action: row.action, decision, applied, consequence: message };
    } catch (err) {
      // A refusal, not a failure: the proposal no longer names anything that can be changed.
      // A sentence rather than a throw, so the owner hears what happened instead of losing the
      // turn — and the row's own state already records that it went out of date.
      if (err instanceof ProposalNoLongerApplies) {
        return {
          id: row.id,
          action: row.action,
          decision,
          applied: false as const,
          consequence: err.message,
        };
      }
      throw err;
    }
  },
});
