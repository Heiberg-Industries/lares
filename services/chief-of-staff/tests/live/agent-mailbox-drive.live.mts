/** Manual opt-in live probe: can the "read + drafts" token read a Google Doc through the code read_url uses?
 * Run from services/chief-of-staff:  pnpm exec tsx tests/live/agent-mailbox-drive.live.mts
 * Inputs (environment):
 *   RUN_AGENT_MAILBOX_DRIVE_LIVE=1        manual opt-in
 *   GOOGLE_LIVE_CLIENT_ID, GOOGLE_LIVE_CLIENT_SECRET   the OAuth client the account was connected with
 *   GOOGLE_LIVE_REFRESH_TOKEN             a refresh token granted with the "read+mail-draft" power
 *                                         (services/console/tests/live/google-account-consent.live.mts with
 *                                         PERSONAL_CONSENT_POWER=read+mail-draft; the probe never stores it)
 *   GOOGLE_LIVE_DOC_URL                   a Google Doc the account owns
 * Reads only. Only booleans are printed, never document text, ids or addresses:
 *   accessTokenIssued      the refresh token produced an access token
 *   scopeIncludesDrive     the token reports drive.readonly
 *   metadataRead           files.get returned the Doc's name and type (the same call read_url makes)
 *   textExported           readGoogleDoc returned non-empty text for the link
 *   noWriteMethodUsed      always true: only files.get and files.export are reachable from the Drive reader
 */
import { google } from 'googleapis';
import { readGoogleDoc } from '../../lib/google-doc.js';
import type { DriveApi } from '../../lib/google-drive.js';

if (process.env.RUN_AGENT_MAILBOX_DRIVE_LIVE !== '1') throw new Error('Manual opt-in required');
const { GOOGLE_LIVE_CLIENT_ID: id, GOOGLE_LIVE_CLIENT_SECRET: secret, GOOGLE_LIVE_REFRESH_TOKEN: refresh, GOOGLE_LIVE_DOC_URL: docUrl } = process.env;
if (!id || !secret || !refresh || !docUrl) throw new Error('Set GOOGLE_LIVE_CLIENT_ID, GOOGLE_LIVE_CLIENT_SECRET, GOOGLE_LIVE_REFRESH_TOKEN and GOOGLE_LIVE_DOC_URL');

const result = { accessTokenIssued: false, scopeIncludesDrive: false, metadataRead: false, textExported: false, noWriteMethodUsed: true };
try {
  const auth = new google.auth.OAuth2(id, secret);
  auth.setCredentials({ refresh_token: refresh });
  const { credentials } = await auth.refreshAccessToken();
  result.accessTokenIssued = !!credentials.access_token;
  const info = await auth.getTokenInfo(credentials.access_token as string);
  result.scopeIncludesDrive = info.scopes.includes('https://www.googleapis.com/auth/drive.readonly');
  const files = google.drive({ version: 'v3', auth }).files;
  const api: DriveApi = { files };
  const docId = docUrl.match(/\/d\/([A-Za-z0-9_-]{10,})/)?.[1];
  if (docId) {
    const meta = (await files.get({ fileId: docId, fields: 'name,mimeType', supportsAllDrives: true })).data;
    result.metadataRead = !!meta.name && !!meta.mimeType;
  }
  const doc = await readGoogleDoc(docUrl, { apis: async () => [{ account: 'probe', api }] });
  result.textExported = doc.text.length > 0;
} catch {
  console.error('Live Drive probe failed. Inspect locally without sharing raw responses.');
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify(result));
}
