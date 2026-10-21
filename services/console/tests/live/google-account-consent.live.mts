/** Manual opt-in live Google data-consent probe. Does not store tokens, send mail or write events.
 * Run from services/console with its locked dependencies: pnpm exec tsx tests/live/google-account-consent.live.mts
 * Set RUN_GOOGLE_ACCOUNT_CONSENT_LIVE=1, GOOGLE_LIVE_ORG=<configured-org>, the data client secrets,
 * and CONSOLE_OAUTH_REDIRECT=http://localhost:6767/api/auth/callback. Register the distinct data
 * callback http://localhost:6767/api/accounts/google/callback on that data client first.
 * Only neutral booleans/counts are printed; do not paste consent codes or tokens into a ticket.
 */
import { createServer } from 'node:http';
import { startAccountConsent, finishAccountConsent } from '../../lib/account-oauth.ts';
if (process.env.RUN_GOOGLE_ACCOUNT_CONSENT_LIVE !== '1') throw new Error('Manual opt-in required');
if (process.env.CONSOLE_OAUTH_REDIRECT !== 'http://localhost:6767/api/auth/callback') throw new Error('Use the dedicated localhost probe callback');
const org = process.env.GOOGLE_LIVE_ORG;
if (!org || !/^[a-z0-9]+$/.test(org)) throw new Error('Configure GOOGLE_LIVE_ORG');
const { flow, url } = await startAccountConsent({ memberId: 'manual-probe', session: 'manual-probe-only', org });
const server = createServer();
let expire!: () => void;
const completed = new Promise<URL>((resolve, reject) => {
  expire = () => reject(new Error("Consent timed out"));
  server.on('request', (request, response) => {
    const callback = new URL(request.url ?? '/', 'http://localhost:6767');
    if (callback.pathname !== '/api/accounts/google/callback') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end('Consent response received. Return to the terminal.');
    resolve(callback);
  });
  server.on('error', reject);
});
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(6767, '127.0.0.1', resolve); });
const timeout = setTimeout(expire, 10 * 60 * 1000);
console.log('Open this authorization URL locally. It contains no client secret or token:');
console.log(url.href);
try {
  const result = await finishAccountConsent(await completed, flow);
  const account = await result.adapter.verifyAccount(null);
  const mailbox = await result.adapter.verifyResource({} as never, 0);
  const calendar = await result.adapter.verifyResource({} as never, 1);
  console.log(JSON.stringify({ providerIdentityVerified: !!account.subject, grantedScopeCount: result.material.scopes.length,
    ownMailboxVerified: mailbox.externalId === account.subject, primaryOwnedCalendarVerified: !!calendar.externalId,
    refreshTokenPresent: !!result.material.refreshToken, stored: false, mailSent: false, calendarWritten: false }));
} catch {
  console.error('Live consent verification refused. No credentials stored. Inspect locally without sharing raw responses.');
  process.exitCode = 1;
} finally { clearTimeout(timeout); server.close(); }
