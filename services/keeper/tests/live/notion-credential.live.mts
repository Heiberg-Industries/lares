/** HAND-RUN ONLY, with separate owner approval. Exactly one read-only provider request per
 * invocation, no content reads/writes, no retries, no journal or active credential mutation.
 *
 * Safe local preparation: pnpm -C services/keeper exec tsx tests/live/notion-credential.live.mts --check
 * Authorised run: set LARES_NOTION_PROBE_APPROVED=1, NOTION_TEST_TOKEN_FILE (test token only),
 * NOTION_TEST_PROXY_URL (approved egress proxy), then run this file with --expect passed.
 * For an explicitly approved invalid-token branch, --synthetic-invalid --expect refused
 * generates an invalid value and does not read any credential file. No traffic floods to
 * manufacture rate limits/outages. Other branches remain outstanding until observed safely.
 * Never put tokens in command arguments, URLs, logs or tracker comments.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { notionCredentialTester, NOTION_CREDENTIAL_ENDPOINT, NOTION_CREDENTIAL_VERSION, NOTION_CREDENTIAL_TIMEOUT_MS } from '../../lib/notion-credential.js';

async function main() {
  const args = process.argv.slice(2);
  const metadata = { endpoint: NOTION_CREDENTIAL_ENDPOINT, version: NOTION_CREDENTIAL_VERSION,
    sdk: '@notionhq/client', method: 'GET', timeoutMs: NOTION_CREDENTIAL_TIMEOUT_MS, retries: 0 };
  if (args.length === 1 && args[0] === '--check') {
    console.log(JSON.stringify({ ...metadata, outcome: 'probe-ready', providerRequests: 0 })); return;
  }
  if (process.env.LARES_NOTION_PROBE_APPROVED !== '1') throw new Error('Separate owner approval required');
  const invalid = args.includes('--synthetic-invalid');
  const rest = args.filter(arg => arg !== '--synthetic-invalid');
  const expected = z.enum(['passed', 'refused', 'rate-limited', 'unavailable', 'unexpected']).safeParse(rest[1]);
  if (rest.length !== 2 || rest[0] !== '--expect' || !expected.success) throw new Error('Specify expected fixed outcome');
  let requests = 0, responseStatus: number | null = null;
  const tester = notionCredentialTester(process.env.NOTION_TEST_PROXY_URL, undefined, event => {
    if (event.kind === 'request') requests++;
    else responseStatus = event.status;
  });
  if (!tester.ready()) throw new Error('Approved egress proxy required');
  const reference = invalid ? 'synthetic-invalid' : process.env.NOTION_TEST_TOKEN_FILE;
  if (!reference) throw new Error('Protected test credential file required');
  // Local custody failures are preparation failures, never observed provider unavailability.
  const value = (() => {
    if (invalid) return randomUUID();
    const fd = openSync(reference, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0 || st.size < 1 || st.size > 8192)
        throw new Error('Protected test credential file required');
      const value = readFileSync(fd, 'utf8').trimEnd();
      if (!value || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid test input');
      return value;
    } finally { closeSync(fd); }
  })();
  const result = await tester.test({ kind: 'api_key', integration: 'notion', secretFile: reference }, () => value);
  // Identity deliberately omitted; fixed outcome only, never provider bodies/errors.
  console.log(JSON.stringify({ ...metadata, outcome: result.outcome, identityKind: result.identity?.kind ?? null,
    requestsInitiated: requests, responseStatus, evidence: responseStatus === null ? 'transport-only' : 'provider-response' }));
  if (requests !== 1 || result.outcome !== expected.data) process.exitCode = 1;
}
void main().catch(() => {
  console.error('Notion credential probe refused or failed; no raw error retained');
  process.exitCode = 1;
});
