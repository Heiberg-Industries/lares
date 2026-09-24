// Look up one Norwegian/Nordic company by website domain via Orakel. See
// lib/orakel-client.ts for the ORB-51 posture (OrakelNotFoundError vs
// OrakelUnavailableError).
import { defineTool } from "eve/tools";
import { z } from "zod";

import { orakelEnrichDomain } from "../lib/orakel-client.js";

export default defineTool({
  description:
    "Best-effort lookup of a Norwegian/Nordic company by website domain via Orakel — " +
    "read-only HTTP call to ORAKEL_URL (Orakel has no domain filter, so this " +
    "name-searches by the domain's label then confirms the real domain matches). Returns " +
    "the same full profile as orakel_enrich_org. Prefer orakel_enrich_org when an org " +
    "number is already known. Throws OrakelNotFoundError when no candidate's domain " +
    "matches, OrakelUnavailableError if Orakel itself is unreachable.",
  inputSchema: z.object({ domain: z.string() }),
  async execute({ domain }) {
    return orakelEnrichDomain(domain);
  },
});
