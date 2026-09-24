// The owner's own email addresses, from the identity registry (user_aliases, via
// DATABASE_URL). See lib/identity-client.ts for the ORB-51 posture and the canonical-id
// reasoning.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { configuredOwnerId, listAliases } from "../lib/identity-client.js";

export default defineTool({
  description:
    "List your owner's own email addresses — the mailboxes enrolled to them in the " +
    "identity registry (e.g. owner@owner.example, owner@project.example), read-only from the " +
    "`user_aliases` table via DATABASE_URL. Use this to resolve \"my zero7 address\" " +
    "when inviting them to something. Returns {addresses: string[]}. An empty list means " +
    "the registry genuinely has none on file — say so plainly and ask, never guess an " +
    "address (a guessed address emails a real stranger). This is your owner's OWN " +
    "identity only; it is not a directory for looking up other people.",
  inputSchema: z.object({}),
  async execute() {
    return { addresses: await listAliases(getPool(), configuredOwnerId(), "email") };
  },
});
