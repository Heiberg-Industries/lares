// Flag a person do-not-contact. GATED WRITE — requires Bendik to tap Approve on the card until ratcheted.
//
// Ported from `services/agent-runtime/lib/adapters/twenty-client.ts`'s `setDoNotContact`
// (PATCH /people/{id} { doNotContact: true, doNotContactReason }).
import { defineTool } from "eve/tools";
import { z } from "zod";

import { twentyPatch } from "../lib/twenty-client.js";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

export default defineTool({
  description: "Flag a person do-not-contact with a reason (unsubscribe, bounce). Requires approval until ratcheted.",
  // ORB-120 audit: `reason` is LEGITIMATELY free-form. Twenty's `doNotContactReason` is a TEXT
  // field, not a SELECT (verified against the live schema, `GET /rest/metadata/fields`,
  // 2026-08-19) — there is no enum to constrain it to. `doNotContact` is a BOOLEAN and is set
  // by this tool, never taken from the model.
  inputSchema: z.object({ recordId: z.string(), reason: z.string() }),
  approval: approvalFor("twenty_do_not_contact"),
  async execute(input, ctx) {
    await assertApproval(ctx, "twenty_do_not_contact", input);
    const { recordId, reason } = input;
    await twentyPatch(`/people/${recordId}`, { doNotContact: true, doNotContactReason: reason });
    return { ok: true } as const;
  },
});
