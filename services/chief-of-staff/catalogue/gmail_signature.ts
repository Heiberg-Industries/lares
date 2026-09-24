// The account's configured Gmail signature (HTML), for the given send-as address. Ported
// from hands/gmail.ts's "signature" action (hands/gmail.ts:17). Best-effort: any googleapis
// error degrades to "" inside lib/google.ts's GmailClient, never throws.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { googleClients } from "../lib/google.js";

export default defineTool({
  description: "Get the account's configured Gmail signature (HTML) for the given mailbox address. Returns { signatureHtml } (empty if none).",
  inputSchema: z.object({ account: z.string() }),
  async execute({ account }) {
    const gmail = await googleClients().gmail(account);
    return { signatureHtml: await gmail.getSignature(account) };
  },
});
