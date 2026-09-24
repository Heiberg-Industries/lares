/**
 * The extension's binding of the shared Orakel client.
 *
 * The logic lives once, in `packages/agent-kit/src/orakel-client.ts`. This file supplies the
 * only thing that is extension-specific — where config comes from — and re-exports the three
 * bound functions under the names `../tools/orakel_*.ts` already import, so the tools are
 * unaffected by where the implementation sits.
 *
 * The eve-saga side binds the same factory to `ORAKEL_KEY_FILE`/`ORAKEL_URL` instead
 * (`services/chief-of-staff/lib/orakel-client.ts`) — two bindings, one implementation.
 */
import { makeOrakelClient } from "../../src/orakel-client.js";
import extension from "../extension.js";

export {
  OrakelUnavailableError,
  OrakelNotFoundError,
  makeOrakelClient,
  type EnrichmentCompany,
  type CompanyCandidate,
  type OrakelConfig,
} from "../../src/orakel-client.js";

const boundClient = makeOrakelClient(() => extension.config.orakel);

export const orakelEnrichOrg = boundClient.orakelEnrichOrg;
export const orakelSearch = boundClient.orakelSearch;
export const orakelEnrichDomain = boundClient.orakelEnrichDomain;
