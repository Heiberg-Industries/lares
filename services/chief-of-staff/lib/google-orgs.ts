/**
 * The per-org Google OAuth client registry and Saga's "not enrolled" error, split out of
 * lib/google.ts (ORB-286 batch 6) so read-only callers (lib/google-drive.ts → read_url) never
 * import the Gmail-send / Calendar-write code. Contents moved verbatim.
 */
import { GoogleConfigError, readSecretFile } from "@lares/agent-kit/google-auth";

// -----------------------------------------------------------------------------------------
// Errors — `GoogleUnenrolledError` is SAGA'S OWN and stays here. eve-marcel has a type of the
// same name with different arity, different semantics (org-scoped, fatal-by-design) and a
// different message; the two were never one type and are deliberately not merged. Only
// `GoogleConfigError` — genuinely identical in both — comes from the kit.
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
// Per-org OAuth client config — ported from registry.ts's `googleOrgConfigs`. Originally
// narrowed to heiberg only (Task 2 mounted only that secret pair). ORB-75/76 (2026-08-16)
// need BOTH mailboxes addressable — Bendik's own call: the caller picks which mailbox each
// time, not a hard-coded pin — so zero7 joins the registry here, its secret pair mounted
// alongside heiberg's in the box compose. `orgConfig(orgId)` looks up whichever org the
// TOKEN itself says it belongs to, rather than a single hard-coded org — this is what
// removes the "no OAuth client config for org 'zero7'" throw the 2026-08-16 walk-up finding
// left in place as a deliberate stopgap.
// -----------------------------------------------------------------------------------------

export interface GoogleOrgConfig {
  orgId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const DEFAULT_CLIENT_ID_FILE = "/run/secrets/google-client-id-heiberg";
const DEFAULT_CLIENT_SECRET_FILE = "/run/secrets/google-client-secret-heiberg";
const DEFAULT_ZERO7_CLIENT_ID_FILE = "/run/secrets/google-client-id-zero7";
const DEFAULT_ZERO7_CLIENT_SECRET_FILE = "/run/secrets/google-client-secret-zero7";

/** One row per enrollable org — ORB-95: was a switch statement; a third org used to mean a
 *  new case block, now it's a new row. `redirectUri` only matters for the initial
 *  authorization-code exchange (`oauth-enroll.ts`), never for refreshing an existing token or
 *  calling the API — so an unset `GOOGLE_REDIRECT_URI` (matching the old registry's own
 *  `default: ""`) is harmless for every org. */
const ORG_SECRET_ENV: Record<string, { clientIdEnv: string; clientIdDefault: string; clientSecretEnv: string; clientSecretDefault: string }> = {
  heiberg: {
    clientIdEnv: "GOOGLE_CLIENT_ID_HEIBERG_FILE", clientIdDefault: DEFAULT_CLIENT_ID_FILE,
    clientSecretEnv: "GOOGLE_CLIENT_SECRET_HEIBERG_FILE", clientSecretDefault: DEFAULT_CLIENT_SECRET_FILE,
  },
  zero7: {
    clientIdEnv: "GOOGLE_CLIENT_ID_ZERO7_FILE", clientIdDefault: DEFAULT_ZERO7_CLIENT_ID_FILE,
    clientSecretEnv: "GOOGLE_CLIENT_SECRET_ZERO7_FILE", clientSecretDefault: DEFAULT_ZERO7_CLIENT_SECRET_FILE,
  },
};

/** Looked up by the TOKEN's own `orgId`, never assumed — an org this table doesn't know
 *  throws a config error naming it, the same shape as an unmounted secret. */
export function orgConfig(orgId: string): GoogleOrgConfig {
  if(process.env.LARES_AGENT_INCARNATION) {
    if(orgId!==process.env.LARES_EMAIL_ORG || !process.env.LARES_GOOGLE_CLIENT_ID_FILE || !process.env.LARES_GOOGLE_CLIENT_SECRET_FILE)throw new GoogleConfigError('Selected Google organisation is not configured');
    return {orgId,clientId:readSecretFile('LARES_GOOGLE_CLIENT_ID_FILE','', 'Google client id'),clientSecret:readSecretFile('LARES_GOOGLE_CLIENT_SECRET_FILE','', 'Google client secret'),redirectUri:''};
  }
  const row = ORG_SECRET_ENV[orgId];
  if (!row) throw new GoogleConfigError(`no OAuth client config for org '${orgId}'`);
  return {
    orgId,
    clientId: readSecretFile(row.clientIdEnv, row.clientIdDefault, `Google client id (${orgId})`),
    clientSecret: readSecretFile(row.clientSecretEnv, row.clientSecretDefault, `Google client secret (${orgId})`),
    redirectUri: process.env["GOOGLE_REDIRECT_URI"] ?? "",
  };
}

