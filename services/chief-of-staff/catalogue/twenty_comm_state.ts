// Update a person's outreach comm-state. GATED WRITE — requires Bendik to tap Approve on the card until ratcheted.
//
// Ported from `services/agent-runtime/lib/adapters/twenty-client.ts`'s `writeCommState`:
// read-before-write — if a human changed the value out from under us (current !=
// expectedPrevious), skip the write rather than clobber a rep's manual edit.
//
// ORB-51 posture: a genuine 404 on the read (person deleted since we last saw them) is a
// real, typed "not found" outcome — the old client's `getOrNull` already treated it that
// way. A `TwentyUnavailableError` on either the read or the write propagates instead.
//
// ORB-93: `expectedPrevious` OMITTED used to be treated as an assertion of `null` — so a
// caller that didn't know (or didn't bother naming) the prior state got compared against
// null regardless of what the record actually held. agent/skills/sales-outreach.md's own
// send-time call omits it, so the very first transition (new person, truly null) happened to
// match — but any FOLLOW-UP send on a person already past that state hit the CAS mismatch
// and silently skipped, `rep_edit_detected`, every time: comm-state never advanced past the
// first hop. Omitting `expectedPrevious` now means "no assertion, just set it" — the CAS
// check only fires when a caller explicitly names a prior state to protect (including
// `null` — an explicit `expectedPrevious: null` still asserts "must currently be unset").
// Callers that care about not clobbering a rep's manual edit (this file's reply-triage
// caller, lib/outreach-reply-triage.ts, always passes one) keep that protection; callers
// that don't know the prior state no longer silently no-op.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { twentyGet, twentyPatch, TwentyNotFoundError } from "../lib/twenty-client.js";
import { commStateSchema } from "../lib/twenty-enums.js";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Update a person's outreach comm-state (e.g. EMAIL_SENT → REPLIED_POSITIVE). " +
    "Pass `expectedPrevious` to skip the write (without error) if a human changed the state " +
    "first — omit it to set the state unconditionally. Requires approval until ratcheted.",
  inputSchema: z.object({
    recordId: z.string(),
    state: commStateSchema,
    // ORB-120: normalised too, and not merely for symmetry — this is compared against the
    // stored (UPPERCASE) value, so a lowercase assertion would ALWAYS mismatch and skip the
    // write as `rep_edit_detected`. Same defect family, silent instead of loud.
    expectedPrevious: commStateSchema.nullable().optional(),
  }),
  approval: approvalFor("twenty_comm_state"),
  async execute(input, ctx) {
    await assertApproval(ctx, "twenty_comm_state", input);
    const { recordId, state, expectedPrevious } = input;

    let body: { data?: { person?: any } };
    try {
      body = await twentyGet<{ data?: { person?: any } }>(`/people/${recordId}`);
    } catch (err) {
      if (err instanceof TwentyNotFoundError) return { ok: false, reason: "not_found" } as const;
      throw err;
    }
    const person = body?.data?.person;
    if (!person) return { ok: false, reason: "not_found" } as const;

    if (expectedPrevious !== undefined) {
      const current = (person.commState ?? null) as string | null;
      if (current !== expectedPrevious) return { ok: true, skipped: true, reason: "rep_edit_detected" } as const;
    }

    await twentyPatch(`/people/${recordId}`, { commState: state });
    return { ok: true } as const;
  },
});
