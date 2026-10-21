/** Manual, read-only provider proof for exact member-selected Gmail execution.
 * Run from this service with tsx tests/live/personal-gmail.live.mts. Required:
 * GMAIL_PROBE_CONTEXT_FILE: private JSON captured by trusted server code for a CURRENT
 * authenticated human console turn (session auth/current/initiator/turn), never model input.
 * GMAIL_PROBE_SELECTION_FILE: private JSON {accountId,generation,resourceBindingId} copied
 * from that same turn's gmail_accounts listing. Runtime DB, managed identity, matching OAuth
 * client files and encryption-key file must be configured normally. No legacy fallback.
 * The probe reads at most one inbox message and prints no IDs, addresses, subjects, bodies,
 * tokens, provider payloads or raw errors. It does not send, draft, reconnect or alter consent.
 * Never run automatically or treat a fixture as provider-backed proof.
 */
import { readFileSync } from 'node:fs';
import { closePool } from '@lares/agent-kit/db';
import { hasConsoleTurnAuthorityTag } from '@lares/agent-kit/console-turn-authority';
import gmailAccounts from '../../catalogue/gmail_accounts.js';
import gmailSearch from '../../catalogue/gmail_search.js';
import gmailRead from '../../catalogue/gmail_read.js';
import { mailboxSelectionSchema } from '../../lib/personal-gmail.js';
try {
  const contextPath = process.env.GMAIL_PROBE_CONTEXT_FILE;
  const selectionPath = process.env.GMAIL_PROBE_SELECTION_FILE;
  if (!contextPath || !selectionPath) throw new Error('Probe configuration required');
  const ctx = JSON.parse(readFileSync(contextPath, 'utf8'));
  if (!hasConsoleTurnAuthorityTag(ctx)) throw new Error('Private console context required');
  const selection = mailboxSelectionSchema.parse(JSON.parse(readFileSync(selectionPath, 'utf8')));
  const available = await gmailAccounts.execute({}, ctx);
  const found = available.some(account => account.accountId === selection.accountId && account.generation === selection.generation &&
    account.mailboxes.some(resource => resource.resourceBindingId === selection.resourceBindingId));
  if (!found) throw new Error('Current selection required');
  const ids = await gmailSearch.execute({ query: 'in:inbox', max: 1, selection }, ctx);
  let messageRead = false;
  if (ids[0]) {
    const message = await gmailRead.execute({ id: ids[0], selection }, ctx);
    messageRead = 'bodyText' in message && typeof message.bodyText === 'string' && message.bodyText.startsWith("<<<SOMEONE ELSE'S WORDS");
  }
  console.log(JSON.stringify({ selectionAvailable: found, matchedCount: ids.length, messageRead }));
} catch {
  console.error('Personal Gmail probe refused or unavailable'); process.exitCode = 1;
} finally { await closePool(); }
