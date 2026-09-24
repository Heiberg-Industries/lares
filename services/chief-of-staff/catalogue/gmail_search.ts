// Search the connected mailbox with a Gmail query. Ported from
// services/agent-runtime/lib/adapters/hands/gmail.ts's "search" action (hands/gmail.ts:15) —
// same query/max marshaling as the old hand, now against lib/google.ts's ported adapter.
//
// W3A-s5 — always taints `third_party` on a successful call: message ids alone are still someone
// else's mailbox contents, not Bendik's own words
// (docs/specs/2026-09-18-origin-model-design.md, "The in-turn taint rule"). A thrown call taints
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
