/** Manual opt-in live check of the "read + drafts" permission: one Google sign-in, then the three
 * agent-mailbox probes (drafts, Drive, calendar events) with that permission, then the permission is
 * withdrawn again at Google. This is where the probes' GOOGLE_LIVE_REFRESH_TOKEN comes from.
 *
 * Run from services/chief-of-staff:
 *   RUN_AGENT_MAILBOX_LIVE=1 GOOGLE_LIVE_CLIENT_ID=... GOOGLE_LIVE_CLIENT_SECRET=... \
 *     GOOGLE_LIVE_DOC_URL=... pnpm exec tsx tests/live/agent-mailbox-all.live.mts
 *
 * Inputs (environment):
 *   RUN_AGENT_MAILBOX_LIVE=1      manual opt-in
 *   GOOGLE_LIVE_CLIENT_ID, GOOGLE_LIVE_CLIENT_SECRET   the Google client agents' mailboxes are connected
 *                                 with. Register http://localhost:6767/api/accounts/google/callback as a
 *                                 redirect address on it first.
 *   GOOGLE_LIVE_DOC_URL           a Google Doc the signed-in account owns (for the Drive probe)
 *
 * The scopes asked for are exactly the engine's "read+mail-draft" power. The refresh token is kept in
 * memory only, handed to the three probes through their environment, never printed or stored, and
 * revoked at the end. Before the probes, one harmless read per service shows whether the Google Cloud
 * project has the Gmail, Calendar and Drive APIs switched on; only Google's short reason is printed.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { googlePersonalConsentScopes } from '@lares/agent-kit/personal-consent';

if (process.env.RUN_AGENT_MAILBOX_LIVE !== '1') throw new Error('Manual opt-in required');
const { GOOGLE_LIVE_CLIENT_ID: clientId, GOOGLE_LIVE_CLIENT_SECRET: clientSecret, GOOGLE_LIVE_DOC_URL: docUrl } = process.env;
if (!clientId || !clientSecret || !docUrl) throw new Error('Set GOOGLE_LIVE_CLIENT_ID, GOOGLE_LIVE_CLIENT_SECRET and GOOGLE_LIVE_DOC_URL');

const PORT = 6767;
const CALLBACK = '/api/accounts/google/callback';
const REDIRECT = `http://localhost:${PORT}${CALLBACK}`;
const SCOPES = googlePersonalConsentScopes('read+mail-draft');
const LIVE_DIR = dirname(fileURLToPath(import.meta.url));

const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(16).toString('hex');
const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
for (const [k, v] of Object.entries({
  client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline',
  prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
})) auth.searchParams.set(k, v);

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (u.pathname !== CALLBACK) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      .end('Done. Go back to the terminal.');
    server.close();
    const answer = u.searchParams.get('code');
    if (u.searchParams.get('state') !== state) reject(new Error('The answer from Google did not match this run.'));
    else if (u.searchParams.get('error')) reject(new Error(`Google refused the sign-in: ${u.searchParams.get('error')}`));
    else if (!answer) reject(new Error('Google answered without a sign-in code.'));
    else resolve(answer);
  });
  server.on('error', (e: NodeJS.ErrnoException) =>
    reject(e.code === 'EADDRINUSE' ? new Error(`Port ${PORT} is busy; close whatever uses it and try again.`) : e));
  server.listen(PORT, '127.0.0.1', () => {
    console.log('Open this address in your browser, choose the Google account and allow everything listed.');
    console.log('It contains no secret or token:');
    console.log(auth.href);
  });
  setTimeout(() => { server.close(); reject(new Error('No answer from Google within 10 minutes.')); }, 600_000).unref();
});

const tokenRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
  code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: 'authorization_code', code_verifier: verifier }) });
const tokens = await tokenRes.json() as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
if (!tokenRes.ok || !tokens.refresh_token || !tokens.access_token) {
  throw new Error(`Google did not hand out a long-lived token (${tokens.error ?? 'no refresh token'}).`);
}
const refreshToken = tokens.refresh_token;

let allPassed = true;
try {
  const granted = new Set(String(tokens.scope ?? '').split(' '));
  console.log('\nPermissions granted:', JSON.stringify(Object.fromEntries(
    SCOPES.map(s => [s.replace('https://www.googleapis.com/auth/', ''), granted.has(s)]))));

  console.log('\n== Can this Google Cloud project reach each service?');
  for (const [name, url] of [
    ['Gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/profile'],
    ['Calendar', 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary'],
    ['Drive', 'https://www.googleapis.com/drive/v3/about?fields=kind'],
  ] as const) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    if (r.ok) { console.log(`${name}: reachable`); continue; }
    const e = ((await r.json().catch(() => ({}))) as { error?: { status?: string; details?: { reason?: string }[]; errors?: { reason?: string }[] } }).error ?? {};
    const reason = e.details?.find(d => d.reason)?.reason ?? e.errors?.[0]?.reason ?? e.status ?? 'unknown';
    const off = /SERVICE_DISABLED|accessNotConfigured/.test(reason) ? `: the ${name} API is switched off in the Google Cloud project` : '';
    console.log(`${name}: refused (${r.status} ${reason})${off}`);
    allPassed = false;
  }

  const env = { ...process.env, GOOGLE_LIVE_REFRESH_TOKEN: refreshToken,
    RUN_AGENT_MAILBOX_DRAFT_LIVE: '1', RUN_AGENT_MAILBOX_DRIVE_LIVE: '1', RUN_AGENT_MAILBOX_CALENDAR_LIVE: '1' };
  for (const [name, file] of [['Drafts', 'agent-mailbox-draft'], ['Drive', 'agent-mailbox-drive'], ['Calendar', 'agent-mailbox-calendar']] as const) {
    console.log(`\n== ${name} probe`);
    const r = spawnSync('pnpm', ['exec', 'tsx', `${LIVE_DIR}/${file}.live.mts`], { env, stdio: 'inherit' });
    if (r.status !== 0) allPassed = false;
  }
} finally {
  await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token: refreshToken }) }).catch(() => undefined);
  console.log('\nThe test permission was withdrawn again at Google. Nothing was stored.');
}
console.log(allPassed ? 'Every service was reachable and every probe finished. Every value above should be true.'
  : 'Something above was refused or stopped with an error. The output holds no secrets.');
if (!allPassed) process.exitCode = 1;
