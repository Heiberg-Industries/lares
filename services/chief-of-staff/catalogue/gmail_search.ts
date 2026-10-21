// Search the connected mailbox with a Gmail query (query/max go to lib/google.ts's Gmail adapter).
//
// Always taints `third_party` on a successful call: message ids alone are still someone
// else's mailbox contents, not the owner's own words
// (the origin model, "The in-turn taint rule"). A thrown call taints
// nothing.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { withPersonalGmail, hasConsoleTurnAuthorityTag, mailboxSelectionSchema } from "../lib/personal-gmail.js";
import { googleClients } from "../lib/google.js";
import { taintTurn, turnKeyFrom } from "@lares/agent-kit/origin-taint";

export default defineTool({
  description:
    "Search a connected mailbox with a Gmail query (e.g. `in:inbox -from:me`). Returns message ids. " +
    "In a private console turn, first call gmail_accounts and supply its exact `selection` " +
    "(accountId, generation, resourceBindingId); there is no default mailbox. On native channels, " +
    "`account` selects a legacy enrolled email address; omitted, the configured legacy default is used.",
  inputSchema: z.object({
    query: z.string(),
    max: z.number().int().positive().max(500).optional(),
    account: z.string().optional(),
    selection: mailboxSelectionSchema.optional(),
  }),
  async execute({ query, max, account, selection }, ctx) {
    if (!hasConsoleTurnAuthorityTag(ctx) && selection !== undefined) throw new Error("Personal mailbox selection requires private console authority");
    const result = hasConsoleTurnAuthorityTag(ctx)
      ? await withPersonalGmail(ctx, selection, account, gmail => gmail.search(query, max ?? 25))
      : await (await googleClients().gmail(account)).search(query, max ?? 25);
    const k = turnKeyFrom(ctx);
    if (k) taintTurn(k, "third_party");
    return result;
  },
});
