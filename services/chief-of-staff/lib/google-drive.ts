import {managedGoogleSelection} from './managed-google.js';
/**
 * Drive, read-only (ORB-286 batch 6) — its own file so read_url (a READ grant) imports no write
 * code; the ORB-199 write-shape lint follows imports and flagged lib/google.ts's Gmail send.
 */
import { google } from "googleapis";

import { GoogleConfigError, buildOAuth2Client, listDecryptedRefreshTokens } from "@lares/agent-kit/google-auth";
import { GoogleUnenrolledError, orgConfig, type GoogleOrgConfig } from "./google-orgs.js";

const PROVIDER = "google";

// ─── Drive, read-only (ORB-286 batch 6) ────────────────────────────────────────────────────
// For Google Docs/Sheets/Slides links Bendik sends: the readability worker can't sign in and
// only ever saw the login shell. Scope: drive.readonly (Bendik, 2026-09-14) — granted by
// re-consenting through the console, whose GOOGLE_SCOPES carries it. A token enrolled before that
// answers 403 insufficient-scope, which lib/google-doc.ts turns into a plain sentence.

export type DriveApi = ReturnType<typeof google.drive>;

/** Same shape as `buildAuthedGmail`: the kit builds the OAuth2 client, the `google.drive(...)`
 *  call stays here. */
function buildAuthedDrive(cfg: GoogleOrgConfig, refreshToken: string): DriveApi {
  return google.drive({ version: "v3", auth: buildOAuth2Client(cfg, refreshToken) });
}

let testDriveApiFactory: ((cfg: GoogleOrgConfig, refreshToken: string) => DriveApi) | undefined;
export function __setTestDriveApiFactory(factory: typeof testDriveApiFactory): void {
  testDriveApiFactory = factory;
}

/**
 * A Drive client per enrolled account, the primary mailbox first — a shared document may live in
 * either org, so a reader tries each. An account whose org has no OAuth client on this host is
 * skipped, not fatal.
 */
export async function driveApisFor(principal?: string): Promise<Array<{ account: string; api: DriveApi }>> {
  const p = principal ?? process.env["GOOGLE_PRINCIPAL_ID"];
  if (!p) throw new GoogleConfigError("GOOGLE_PRINCIPAL_ID is not set and no principal was given");
  const selected=await managedGoogleSelection(p);
  const tokens = await listDecryptedRefreshTokens(p, PROVIDER, selected??undefined);
  if (tokens.length === 0) throw new GoogleUnenrolledError(p);
  const primary = process.env["GMAIL_PRIMARY_EMAIL"];
  const ordered = [...tokens].sort((a, b) => Number(b.emailAddress === primary) - Number(a.emailAddress === primary));
  const out: Array<{ account: string; api: DriveApi }> = [];
  for (const t of ordered) {
    let org: GoogleOrgConfig;
    try {
      org = orgConfig(t.orgId);
    } catch {
      continue;
    }
    out.push({ account: t.emailAddress, api: (testDriveApiFactory ?? buildAuthedDrive)(org, t.token) });
  }
  return out;
}

