/** Manual provider-backed sign-in probe. Never imported by automated tests.
 * Run from services/console with explicit owner-supplied console client settings in the
 * environment, a registered loopback callback http://127.0.0.1:39114/api/auth/callback,
 * CONSOLE_OAUTH_REDIRECT set to that URI, and a temporary CONSOLE_SESSION_SECRET.
 * pnpm exec tsx tests/live/console-oidc.live.mts google|microsoft
 * No mailbox scopes, member/session writes or token logging. Microsoft execution remains
 * an explicit operator gate. Local simulated-provider tests are not this evidence.
 * Sources: https://github.com/panva/openid-client/blob/main/examples/oidc.ts
 * https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
 */
import { createServer } from 'node:http';
import { startSignIn, openFlow, finishSignIn, consoleRedirect, type SignInProvider } from '../../lib/console-oidc.ts';
const provider = process.argv[2];
if (provider !== 'google' && provider !== 'microsoft') throw new Error('Choose google or microsoft explicitly.');
const redirect = new URL(consoleRedirect());
if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(redirect.hostname) || redirect.port !== '39114') throw new Error('Register and configure the loopback callback http://127.0.0.1:39114/api/auth/callback.');
const started = await startSignIn(provider as SignInProvider, '/membership');
const flow = await openFlow(started.cookie);
if (!flow) throw new Error('Could not create the local sign-in flow.');
let completed = false;
const server = createServer(async (req, res) => {
  const callback = new URL(req.url ?? '/', redirect.origin);
  if (callback.pathname !== '/api/auth/callback') { res.writeHead(404).end(); return; }
  if (completed) { res.writeHead(410).end(); return; }
  completed = true;
  try {
    const proof = await finishSignIn(callback, flow);
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end('Sign-in verified. You may close this window.');
    console.log(`PASS: ${provider} verified issuer, audience, signature, state, nonce, expiry and provider identity. No account or session was written.`);
    // Identity metadata is intentionally opt-in so an ordinary probe is safe to capture.
    // This diagnostic output is not a lares owner-bootstrap receipt and cannot authorize an
    // existing owner. Fresh installs use the Console discovery display and host-side command.
    if (process.env.OIDC_PROBE_SHOW_IDENTITY === '1') console.log(JSON.stringify(proof.identity));
  } catch {
    process.exitCode = 1;
    res.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Sign-in was refused.');
    console.error('FAIL: provider sign-in was refused. Provider payloads and tokens are omitted.');
  } finally { server.close(); }
});
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(39114, '127.0.0.1', resolve); });
console.log('Open this sign-in URL in your browser. It requests identity only:');
console.log(started.url.href);
setTimeout(() => { if (!completed) { process.exitCode = 1; console.error('FAIL: sign-in probe timed out.'); server.close(); } }, 600_000).unref();
