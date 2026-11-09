/**
 * Drive, read-only — its own file so read_url (a READ grant) imports no write code; the
 * write-shape lint follows imports and flagged lib/google.ts's Gmail send.
 */
import type { google } from "googleapis";

import { GoogleConfigError } from "@lares/agent-kit/google-auth";

export type DriveApi = ReturnType<typeof google.drive>;

/**
 * Drive is not connected for any agent. The mailbox an agent's owner chooses is consented for mail
 * (and read-only calendar) and carries no Drive scope, and the older email door that once held
 * Drive access is gone. A Google Docs link therefore answers with a plain "not connected".
 */
export async function driveApisFor(): Promise<Array<{ account: string; api: DriveApi }>> {
  throw new GoogleConfigError("Google Drive is not connected for this agent");
}
