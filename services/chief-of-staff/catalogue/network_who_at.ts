// Who in Bendik's relationship network is at a given company. Read-only from the
// content-stripped network replica (LinkedIn + Contacts + iMessage + calls, mounted
// read-only at NETWORK_DB_PATH) — see lib/network-client.ts for the ORB-51 posture (a
// missing or unsynced replica is an error, never an empty result).
import { defineTool } from "eve/tools";
import { z } from "zod";

import { networkWhoAt } from "../lib/network-client.js";

export default defineTool({
  description:
    "Who in Bendik's relationship network (Pulse) works at a given company — read-only " +
    "from the content-stripped network replica (LinkedIn + Contacts + iMessage + calls " +
    "signals, mounted read-only at NETWORK_DB_PATH; no raw message content). Matches the " +
    "company name loosely (substring, case-insensitive). Returns contacts ranked by " +
    "warmth score. An empty array is a real answer — nobody at that company is in the " +
    "network — a down or unsynced replica throws instead of returning one.",
  inputSchema: z.object({ company: z.string() }),
  async execute({ company }) {
    return networkWhoAt(company);
  },
});
