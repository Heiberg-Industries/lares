/** Manual opt-in live probe: can a compose-scoped Google token create, read and delete a draft?
 * Run from services/chief-of-staff:  pnpm exec tsx tests/live/agent-mailbox-draft.live.mts
 * Inputs (environment):
 *   RUN_AGENT_MAILBOX_DRAFT_LIVE=1        manual opt-in
 *   GOOGLE_LIVE_CLIENT_ID, GOOGLE_LIVE_CLIENT_SECRET   the OAuth client the account was connected with
 *   GOOGLE_LIVE_REFRESH_TOKEN             a refresh token granted with the "read+mail-draft" power
 *                                         (get one with services/console/tests/live/google-account-consent.live.mts
 *                                         and PERSONAL_CONSENT_POWER=read+mail-draft; the probe never stores it)
 * The draft is addressed to the account itself, then deleted. Nothing is sent.
 * Only booleans are printed, never addresses, tokens or message text:
 *   accessTokenIssued      the refresh token produced an access token
 *   scopesIncludeCompose   the token reports gmail.compose (or a broader mail scope)
 *   draftCreated           drafts.create to self succeeded and returned an id
 *   draftReadBack          drafts.get returned that draft
 *   draftDeleted           drafts.delete removed it
 *   sendNotCalled          always true: this probe never calls a send method
 */
import { google } from 'googleapis';

if (process.env.RUN_AGENT_MAILBOX_DRAFT_LIVE !== '1') throw new Error('Manual opt-in required');
const { GOOGLE_LIVE_CLIENT_ID: id, GOOGLE_LIVE_CLIENT_SECRET: secret, GOOGLE_LIVE_REFRESH_TOKEN: refresh } = process.env;
if (!id || !secret || !refresh) throw new Error('Set GOOGLE_LIVE_CLIENT_ID, GOOGLE_LIVE_CLIENT_SECRET and GOOGLE_LIVE_REFRESH_TOKEN');

const result = { accessTokenIssued: false, scopesIncludeCompose: false, draftCreated: false, draftReadBack: false, draftDeleted: false, sendNotCalled: true };
let draftId: string | undefined;
const auth = new google.auth.OAuth2(id, secret);
auth.setCredentials({ refresh_token: refresh });
try {
  const { credentials } = await auth.refreshAccessToken();
  result.accessTokenIssued = !!credentials.access_token;
  const info = await auth.getTokenInfo(credentials.access_token as string);
  result.scopesIncludeCompose = info.scopes.some(s => ['https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'].includes(s));
  const gmail = google.gmail({ version: 'v1', auth });
  const self = (await gmail.users.getProfile({ userId: 'me' })).data.emailAddress as string;
  const raw = Buffer.from([`To: ${self}`, 'Subject: agent mailbox draft probe', 'Content-Type: text/plain; charset=UTF-8', '', 'probe'].join('\r\n')).toString('base64url');
  const created = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
  draftId = created.data.id ?? undefined;
  result.draftCreated = !!draftId;
  if (draftId) result.draftReadBack = (await gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'minimal' })).data.id === draftId;
} catch {
  console.error('Live draft probe failed. Inspect locally without sharing raw responses.');
  process.exitCode = 1;
} finally {
  if (draftId) {
    try { await google.gmail({ version: 'v1', auth }).users.drafts.delete({ userId: 'me', id: draftId }); result.draftDeleted = true; } catch { /* reported as false */ }
  }
  console.log(JSON.stringify(result));
}
