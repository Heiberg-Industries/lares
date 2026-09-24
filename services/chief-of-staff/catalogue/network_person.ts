// What the network replica knows about one person, by name. Read-only from the
// content-stripped network replica (NETWORK_DB_PATH) — see lib/network-client.ts for the
// ORB-51 posture.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { networkPerson } from "../lib/network-client.js";

export default defineTool({
  description:
    "What Bendik's network replica knows about one person, by name (fuzzy match) — " +
    "read-only from the content-stripped replica (mounted read-only at NETWORK_DB_PATH). " +
    "Returns contact/company/title, warmth score and band, known identities " +
    "(email/phone/etc.), and recent interaction summaries (channel, direction, timestamp " +
    "— never raw message content). Returns null when no contact matches that name, which " +
    "is a real answer; a down or unsynced replica throws instead.",
  inputSchema: z.object({ name: z.string() }),
  async execute({ name }) {
    return networkPerson(name);
  },
});
