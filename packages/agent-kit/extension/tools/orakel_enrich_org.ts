// Look up one Norwegian/Nordic company by org number via Orakel. See lib/orakel-client.ts
// for the ORB-51 posture (OrakelNotFoundError vs OrakelUnavailableError).
import { defineTool } from "eve/tools";
import { z } from "zod";

import { orakelEnrichOrg } from "../lib/orakel-client.js";

export default defineTool({
  description:
    "Look up a Norwegian/Nordic company by its org number (Brønnøysund) via Orakel — " +
    "read-only HTTP call to ORAKEL_URL. Returns the full profile: name, location " +
    "(municipality), employee count, size class, founding date, NACE industry, " +
    "website/LinkedIn, technologies — plus latest financials (revenue, operating & net " +
    "result, fiscal year), a financial-health score (0-100), revenue growth (CAGR), " +
    "ownership concentration / foreign-owned flag, and bankruptcy / debt-negotiation " +
    "status. This is the reliable lookup. Throws OrakelNotFoundError for no such company, " +
    "OrakelUnavailableError if Orakel itself is unreachable.",
  inputSchema: z.object({ orgNumber: z.string() }),
  async execute({ orgNumber }) {
    return orakelEnrichOrg(orgNumber);
  },
});
