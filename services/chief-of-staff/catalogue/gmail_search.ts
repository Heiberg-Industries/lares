// Search the connected mailbox with a Gmail query (query/max go to lib/google.ts's Gmail adapter).
//
// Always taints `third_party` on a successful call: message ids alone are still someone
// else's mailbox contents, not the owner's own words
// (the origin model, "The in-turn taint rule"). A thrown call taints
// nothing.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { googleClients } from "../lib/google.js";
import { taintTurn, turnKeyFrom } from "@lares/agent-kit/origin-taint";

export default defineTool({
  description:
    "Search a connected mailbox with a Gmail query (e.g. `in:inbox -from:me`). Returns message ids. " +
    "Set `account` (an email address) to search a specific enrolled mailbox; omitted, the default " +
    "mailbox (GMAIL_PRIMARY_EMAIL, normally owner@owner.example) is searched.",
  inputSchema: z.object({
    query: z.string(),
    max: z.number().int().positive().max(500).optional(),
    account: z.string().optional(),
  }),
  async execute({ query, max, account }, ctx) {
    const gmail = await googleClients().gmail(account);
    const result = await gmail.search(query, max ?? 25);
    const k = turnKeyFrom(ctx);
    if (k) taintTurn(k, "third_party");
    return result;
  },
});
