// Reset a meeting follow-up's claim so Saga can check the page again in conversation — the
// "check again" escape hatch (LAR-28). Without this, revisiting a denied or already-queued card
// could only be done with a hand-run UPDATE on the box: `claimMeeting`'s own hash-diff reclaim
// (lib/meeting-followup-store.ts) only fires on the SCHEDULE's own next tick, and only once the
// live summary block's hash has already changed — useful once Bendik has corrected the page, but
// no help for "let me look at it again right now" or a correction that has not landed yet.
//
// GATED EXACTLY LIKE `meeting_followup_send`, deliberately (LAR-28 spec): resetting the claim is
// not itself a send, but it is what MAKES the next tick compose — and, for an autonomous series,
// send WITHOUT a card — so it inherits the identical policy `meeting_followup_send` uses, keyed on
// the SAME series. `followupApproval` (that tool's own exported policy) is reused verbatim rather
// than re-implemented: `to: []` because this tool sends nothing itself, so there is no recipient
// set to check for a group alias, and the series key is read back from the store
// (`seriesKeyFor`) rather than taken as input — this tool takes only `notionPageId`. A one-off
// meeting (`series_key` `''`) or a page with no claim row at all both resolve to `seriesKey ===
// ""`, which `followupApproval` already treats as "always a human decision" — exactly right here,
// since neither case has an opted-in series to trust.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { KitRatchet } from "@lares/agent-kit/ratchet";
import { assertApproval } from "../lib/approvals.js";
import { lastRecipientsFingerprint, resetClaimForRedraft, seriesKeyFor } from "../lib/meeting-followup-store.js";
import { followupApproval, FOLLOWUP_AGENT, FOLLOWUP_CAPABILITY } from "./meeting_followup_send.js";

export default defineTool({
  description:
    "Check a meeting's follow-up again and, if it has not already been sent, reset it so the " +
    "next automatic pass drafts and sends a fresh card — the 'check again' path for when Bendik " +
    "says he corrected the meeting page. Refuses a follow-up that has already been sent; that " +
    "cannot be undone.",
  inputSchema: z.object({ notionPageId: z.string() }),
  approval: async (ctx: { toolInput?: unknown }) => {
    const input = (ctx.toolInput ?? {}) as { notionPageId?: unknown };
    const notionPageId = typeof input.notionPageId === "string" ? input.notionPageId : "";
    // No page id at all can never resolve to a real series — same fail-toward-asking shape as
    // `followupApproval`'s own empty-seriesKey rule, reached one step earlier here.
    const seriesKey = notionPageId === ""
      ? ""
      : (await seriesKeyFor(getPool(), notionPageId).catch(() => null)) ?? "";
    const decide = followupApproval({
      level: (key) => new KitRatchet(getPool()).level(FOLLOWUP_AGENT, FOLLOWUP_CAPABILITY, key),
      lastFingerprint: (key) => lastRecipientsFingerprint(getPool(), key),
    });
    return decide({ toolInput: { seriesKey, to: [] } });
  },
  async execute(input, ctx) {
    // This tool has no app-principal path — unlike `meeting_followup_send`, it is never called
    // from the schedule's own turn, only from a live conversation — so every call is asserted
    // against the ordinary allowed-human check, no exemption needed.
    await assertApproval(ctx, "meeting_followup_redraft", input);

    const result = await resetClaimForRedraft(getPool(), input.notionPageId);
    if (result.alreadySent) {
      return { reset: false, notionPageId: input.notionPageId, reason: "already sent — cannot be undone" };
    }
    return { reset: result.reset, notionPageId: input.notionPageId };
  },
});
