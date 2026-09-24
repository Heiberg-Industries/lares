// Contacts who were once warm and have gone quiet. Read-only from the content-stripped
// network replica (NETWORK_DB_PATH) — see lib/network-client.ts for the ORB-51 posture.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { networkDormant } from "../lib/network-client.js";

export default defineTool({
  description:
    "Contacts who were once warm and have gone quiet (the dormant-warm queue) — " +
    "read-only from the content-stripped network replica (mounted read-only at " +
    "NETWORK_DB_PATH). Ranked by warmth score, capped at `limit` (default 25). An empty " +
    "array is a real answer — nobody is currently dormant-warm — a down or unsynced " +
    "replica throws instead of returning one.",
  inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
  async execute({ limit }) {
    return networkDormant(limit);
  },
});
