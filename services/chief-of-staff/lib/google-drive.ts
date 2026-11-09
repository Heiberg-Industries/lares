/**
 * Drive, read-only — its own file so read_url (a READ grant) imports no write code; the
 * write-shape lint follows imports and flagged lib/google.ts's Gmail send. The chosen-mailbox cache it
 * shares with Gmail and Calendar lives in ./chosen-mailbox.ts for the same reason.
 */
import type { google } from "googleapis";

import { GoogleConfigError } from "@lares/agent-kit/google-auth";
import { chosenMailbox, noMailbox, staleChoiceError } from "./chosen-mailbox.js";

/** What reading a file needs: its details, an export of a Google document, and a download. Nothing writes. */
export type DriveApi = { files: Pick<ReturnType<typeof google.drive>["files"], "get" | "export"> };

/**
 * The Drive of the mailbox this agent works on, as a list of one. Same account, same refresh and same
 * recheck as Gmail and Calendar. Refuses in plain words when nothing is chosen, when the choice no
 * longer holds, or when the account was connected before Drive reading was part of "read + drafts".
 */
export async function driveApisFor(): Promise<Array<{ account: string; api: DriveApi }>> {
  const r = await chosenMailbox();
  if (noMailbox(r)) throw new GoogleConfigError("Google Drive is not connected for this agent; choose a mailbox on its Access tab");
  if (!r.ok) throw await staleChoiceError();
  if (!r.drive) throw new GoogleConfigError("To read Google Docs, reconnect Google on Your accounts");
  return [{ account: r.mailbox, api: r.drive }];
}
