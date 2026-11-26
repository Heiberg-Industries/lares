/** HAND-RUN ONLY. One unauthenticated MCP `initialize` POST per invocation to the server you name, no
 * credential, no retries, nothing stored. It exists because the directory's login check branches on what a
 * real server answers (200, 401 with or without a `resource_metadata` challenge), and a fixture only says
 * what we believe a server does.
 *
 * Safe local preparation: pnpm -C services/keeper exec tsx tests/live/outside-connector-probe.live.mts --check
 * Authorised run: LARES_CONNECTOR_PROBE_APPROVED=1 pnpm -C services/keeper exec tsx tests/live/outside-connector-probe.live.mts \
 *   --url https://<server>/mcp --expect none|token|signin [--owner-says-token]
 * --owner-says-token applies the owner's Token choice the way outside.connector-probe does (expectToken): a dual-mode server
 * (sign-in page and token) is then recorded as token. Run it once against a server of each kind and note the date and result.
 * LAST RUN: UNRUN.
 * It goes direct from this machine, not through the outside route, so it proves the answer's shape, not the route.
 */
import { Agent } from 'undici';
import { askInitialize, classifyProbe } from '../../lib/outside-connectors.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check') { console.log(JSON.stringify({ outcome: 'probe-ready', providerRequests: 0 })); return; }
  if (process.env.LARES_CONNECTOR_PROBE_APPROVED !== '1') throw new Error('Separate owner approval required');
  const ownerSaysToken = args.includes('--owner-says-token'), rest = args.filter(a => a !== '--owner-says-token');
  const url = rest[rest.indexOf('--url') + 1], expected = rest[rest.indexOf('--expect') + 1];
  if (rest.length !== 4 || !url?.startsWith('https://') || !['none', 'token', 'signin'].includes(expected ?? '')) throw new Error('Usage: --url https://<server>/mcp --expect none|token|signin [--owner-says-token]');
  const answer = await askInitialize(url, new Agent({ allowH2: false }), Date.now() + 15_000);
  const classified = classifyProbe(answer);
  // The same rule as outside.connector-probe with expectToken: the owner's Token choice stands.
  const kind = ownerSaysToken ? 'token' : classified;
  console.log(JSON.stringify({ status: answer.status, hasChallenge: answer.wwwAuthenticate !== null, speaksMcp: answer.mcp, classifiedAs: classified, ownerSaysToken, recordedAs: kind, expected, outcome: kind === expected ? 'as-expected' : 'DIFFERENT' }));
  if (kind !== expected) process.exitCode = 1;
}
main().catch(error => { console.log(JSON.stringify({ outcome: 'failed', reason: error instanceof Error ? error.message : 'unknown' })); process.exitCode = 1; });
