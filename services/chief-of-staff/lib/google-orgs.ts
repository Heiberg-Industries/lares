/**
 * The per-org Google OAuth client lookup and the chief of staff's "not enrolled" error, split out
 * of lib/google.ts so read-only callers (lib/google-drive.ts → read_url) never import the
 * Gmail-send / Calendar-write code.
 */
import { GoogleConfigError, readSecretFile } from "@lares/agent-kit/google-auth";

// -----------------------------------------------------------------------------------------
// Errors — `GoogleUnenrolledError` is this role's own and stays here. Only `GoogleConfigError`
// comes from the kit.
// -----------------------------------------------------------------------------------------

/** The principal has no `oauth_tokens` row for the requested provider/account — a real,
 *  expected outcome (enrollment hasn't happened / was revoked), distinct from a config or
 *  transport failure. Never thrown eagerly — only when a tool actually tries to resolve a
 *  client for this principal. */
export class GoogleUnenrolledError extends Error {
  constructor(
    readonly principal: string,
    readonly account?: string,
  ) {
    super(
      account
        ? `principal ${principal} has no enrolled Google account ${account} — run bin/oauth-enroll.ts first`
        : `principal ${principal} is not enrolled with Google — run bin/oauth-enroll.ts first`,
    );
    this.name = "GoogleUnenrolledError";
  }
}

// -----------------------------------------------------------------------------------------
// Per-org OAuth client config. Which orgs exist is installation data: an org is any id the
// host holds a client pair for, named the same way the console discovers them
// (`GOOGLE_CLIENT_ID_<ORG>`). Nothing in the engine lists organisations.
// `orgConfig(orgId)` looks up whichever org the TOKEN itself says it belongs to, so a mailbox
// of any enrolled org is addressable and the caller picks which one each time.
// -----------------------------------------------------------------------------------------

export interface GoogleOrgConfig {
  orgId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** An org id is a single token of letters and digits, as the console's discovery reads it. It
 *  becomes part of an environment variable name and a secret file name, so anything else is
 *  refused rather than turned into a path. */
const ORG_ID = /^[A-Za-z0-9]+$/;

/** Where the host mounts secret files. The per-org file names below are built from the org id at
 *  run time, so there is no fixed name for the secret lint to declare. */
const SECRETS_DIR = "/run/secrets";

/** The env var and default path for one org's client pair, derived from the org id alone:
 *  `GOOGLE_CLIENT_ID_<ORG>_FILE` falling back to `<secrets dir>/google-client-id-<org>` (and the
 *  same for the secret). `redirectUri` only matters for the initial authorization-code exchange
 *  (`oauth-enroll.ts`), never for refreshing an existing token or calling the API — so an unset
 *  `GOOGLE_REDIRECT_URI` is harmless for every org. */
function orgSecretSource(orgId: string): { clientIdEnv: string; clientIdDefault: string; clientSecretEnv: string; clientSecretDefault: string } {
  const upper = orgId.toUpperCase();
  const lower = orgId.toLowerCase();
  return {
    clientIdEnv: `GOOGLE_CLIENT_ID_${upper}_FILE`, clientIdDefault: `${SECRETS_DIR}/google-client-id-${lower}`,
    clientSecretEnv: `GOOGLE_CLIENT_SECRET_${upper}_FILE`, clientSecretDefault: `${SECRETS_DIR}/google-client-secret-${lower}`,
  };
}

/** Looked up by the TOKEN's own `orgId`, never assumed — an org this host holds no client pair
 *  for throws a config error naming it, the same shape as an unmounted secret. */
export function orgConfig(orgId: string): GoogleOrgConfig {
  if(process.env.LARES_AGENT_INCARNATION) {
    if(orgId!==process.env.LARES_EMAIL_ORG || !process.env.LARES_GOOGLE_CLIENT_ID_FILE || !process.env.LARES_GOOGLE_CLIENT_SECRET_FILE)throw new GoogleConfigError('Selected Google organisation is not configured');
    return {orgId,clientId:readSecretFile('LARES_GOOGLE_CLIENT_ID_FILE','', 'Google client id'),clientSecret:readSecretFile('LARES_GOOGLE_CLIENT_SECRET_FILE','', 'Google client secret'),redirectUri:''};
  }
  if (!ORG_ID.test(orgId)) throw new GoogleConfigError(`no OAuth client config for org '${orgId}'`);
  const row = orgSecretSource(orgId);
  return {
    orgId,
    clientId: readSecretFile(row.clientIdEnv, row.clientIdDefault, `Google client id (${orgId})`),
    clientSecret: readSecretFile(row.clientSecretEnv, row.clientSecretDefault, `Google client secret (${orgId})`),
    redirectUri: process.env["GOOGLE_REDIRECT_URI"] ?? "",
  };
}

