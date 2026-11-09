/**
 * The Google OAuth client lookup and the chief of staff's "not enrolled" error, split out
 * of lib/google.ts so read-only callers never import the Gmail-send / Calendar-write code.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { GoogleConfigError } from "@lares/agent-kit/google-auth";

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
// The Google OAuth client shape a mailbox is opened with. Which organisations exist is
// installation data; the only client lookup is `personalOrgConfig` below.
// -----------------------------------------------------------------------------------------

export interface GoogleOrgConfig {
  orgId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Where the host mounts secret files. */
const SECRETS_DIR = "/run/secrets";

/** Root-configured personal-client mounts only. No email-door, principal or legacy fallback.
 * Metadata is bounded and can name only deterministic in-container files, never host paths.
 * Org IDs match console discovery's lowercase persisted values exactly; aliases are refused.
 */
export function personalOrgConfig(orgId: string): GoogleOrgConfig {
  try {
    const raw = process.env.LARES_PERSONAL_GOOGLE_CLIENTS;
    if (!/^[a-z0-9]{1,32}$/.test(orgId) || !raw || raw.length > 16_384 ||
      process.env.TOKEN_ENC_KEY_FILE !== '/run/secrets/google-token-key') throw new Error();
    const clients = z.record(z.string().regex(/^[a-z0-9]{1,32}$/), z.strictObject({
      clientIdFile: z.string(), clientSecretFile: z.string(),
    })).parse(JSON.parse(raw));
    if (!Object.keys(clients).length || Object.keys(clients).length > 32) throw new Error();
    for (const [org, files] of Object.entries(clients)) {
      if (files.clientIdFile !== `${SECRETS_DIR}/personal-google-${org}-id` ||
        files.clientSecretFile !== `${SECRETS_DIR}/personal-google-${org}-secret`) throw new Error();
    }
    const selected = Object.hasOwn(clients, orgId) ? clients[orgId] : undefined;
    if (!selected) throw new Error();
    const clientId = readFileSync(selected.clientIdFile, 'utf8').trim();
    const clientSecret = readFileSync(selected.clientSecretFile, 'utf8').trim();
    if (!clientId || !clientSecret) throw new Error();
    return { orgId, clientId, clientSecret, redirectUri: '' };
  } catch { throw new GoogleConfigError('Selected personal Google client is not configured'); }
}
