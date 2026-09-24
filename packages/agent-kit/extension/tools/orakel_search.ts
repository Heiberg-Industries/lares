// Search Norwegian/Nordic companies by name via Orakel. See lib/orakel-client.ts for the
// ORB-51 posture (OrakelUnavailableError vs a legitimate zero-match search).
import { defineTool } from "eve/tools";
import { z } from "zod";

import { orakelSearch } from "../lib/orakel-client.js";

export default defineTool({
  description:
    "Search Norwegian/Nordic companies by name (or free text) via Orakel — read-only " +
    "HTTP call to ORAKEL_URL. Returns up to `limit` lightweight candidates (org number, " +
    "name, employee count, industry, size class) so you can pick the right one — then " +
    "call orakel_enrich_org on its org number for the full profile. Use this first when " +
    "you have a company NAME but no org number. An empty array is a real answer (a " +
    "search with zero legitimate matches); OrakelUnavailableError is thrown only on a " +
    "genuine transport/HTTP failure.",
  inputSchema: z.object({ query: z.string(), limit: z.number().int().min(1).max(25).optional() }),
  async execute({ query, limit }) {
    return orakelSearch(query, limit !== undefined ? { limit } : undefined);
  },
});
