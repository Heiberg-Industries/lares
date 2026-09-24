/**
 * eve-saga's binding of the shared Orakel client.
 *
 * The logic lives once, in `@lares/agent-kit/orakel-client`. This file supplies only the
 * env-based config resolution and re-exports the same surface this service already imported,
 * so its two callers are unchanged.
 *
 * WHY THIS BINDING EXISTS AT ALL — it is not redundancy with the extension's `orakel_*` tools.
 * Two consumers here call `orakelSearch` DIRECTLY rather than through a tool, and so sit
 * outside the extension's config scope:
 *   - `agent/tools/commercial_who_to_contact.ts` (the scored, top-8-per-brand surfacing)
 *   - `lib/person-sources.ts` (the `company` source behind `person_lookup`)
 *
 * ORB-143 originally satisfied that by copying the whole client here and leaving a "keep the
 * two in step by hand" comment in both files — the exact convention ORB-142 had just deleted
 * as superseded. The factory replaces the copy: config differs, logic does not.
 */
import {
  makeOrakelClient,
  OrakelUnavailableError,
  type OrakelConfig,
} from "@lares/agent-kit/orakel-client";

export {
  OrakelUnavailableError,
  OrakelNotFoundError,
  type EnrichmentCompany,
  type CompanyCandidate,
} from "@lares/agent-kit/orakel-client";

const DEFAULT_KEY_FILE = "/run/secrets/orakel-key";

/**
 * Resolved on every call, never at module scope — `eve build` evaluates this file and a build
 * has no secrets. Throwing here (rather than returning undefined) preserves the previous
 * behaviour exactly: an unset `ORAKEL_URL` was already an `OrakelUnavailableError`, not a
 * silent no-op, so an outage never reads as "this company does not exist".
 */
function envConfig(): OrakelConfig {
  const url = process.env["ORAKEL_URL"];
  if (!url) throw new OrakelUnavailableError("ORAKEL_URL is not set");
  return { keyFile: process.env["ORAKEL_KEY_FILE"] ?? DEFAULT_KEY_FILE, baseUrl: url };
}

const client = makeOrakelClient(envConfig);

export const orakelEnrichOrg = client.orakelEnrichOrg;
export const orakelSearch = client.orakelSearch;
export const orakelEnrichDomain = client.orakelEnrichDomain;
