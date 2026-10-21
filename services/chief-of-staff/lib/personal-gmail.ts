/** Private console mailbox reads. Model input selects a resource, never a member/audience.
 * No credential, custody coordinate or raw provider/database error reaches a tool result.
 */
import { z } from 'zod';
import { PgAccountStore } from '@lares/agent-kit/account-store';
import { getPool } from '@lares/agent-kit/db';
import { hasConsoleTurnAuthorityTag, requireConsoleTurnAuthority, type ConsoleAuthorityContext } from '@lares/agent-kit/console-turn-authority';
import { personalGmailReader, type GmailClient } from './google.js';
import { untrustedLine } from '@lares/agent-kit/untrusted-text';

export { hasConsoleTurnAuthorityTag };
export const mailboxSelectionSchema = z.strictObject({
  accountId: z.string().min(1), generation: z.number().int().nonnegative(), resourceBindingId: z.string().min(1),
});
export type MailboxSelection = z.infer<typeof mailboxSelectionSchema>;
export const PERSONAL_MAILBOX_REFUSED = 'Selected personal mailbox is unavailable or authority changed';
const refuse = (): never => { throw new Error(PERSONAL_MAILBOX_REFUSED); };

/** Account/member/resource/custody locks remain held until the bounded read settles.
 * Abort is supplied to OAuth refresh and Gmail, not a race that releases locks while a
 * provider request continues in the background. Only these read operations are exposed.
 */
export async function withPersonalGmail<T>(ctx: ConsoleAuthorityContext, input: MailboxSelection | undefined,
  legacyAccount: string | undefined, work: (gmail: Pick<GmailClient, 'read' | 'search'>) => Promise<T>): Promise<T> {
  try {
    const selection = mailboxSelectionSchema.parse(input);
    if (legacyAccount !== undefined) refuse();
    const authority = await requireConsoleTurnAuthority(ctx);
    const memberId = authority.actingMemberId;
    if (!memberId || authority.spokenByMemberId !== memberId || authority.audience.participants.length !== 1 ||
      authority.audience.participants[0]?.kind !== 'member' || authority.audience.participants[0].memberId !== memberId) return refuse();
    return await new PgAccountStore(getPool()).withPersonalResourceCredential(memberId, selection, 'mailbox',
      async ({ account, resource }, credential, db) => {
        if (account.connectorId !== 'google' || account.providerAccount.issuer !== 'https://accounts.google.com' ||
          resource.externalId !== account.providerAccount.subject ||
          !credential.scopes.some(scope => scope === 'https://www.googleapis.com/auth/gmail.readonly' ||
            scope === 'https://www.googleapis.com/auth/gmail.modify' || scope === 'https://mail.google.com/')) refuse();
        await requireConsoleTurnAuthority(ctx, db);
        return work(personalGmailReader(credential, AbortSignal.timeout(15_000)));
      });
  } catch { return refuse(); }
}

/** Secret-free selection metadata, current actor only. Status is not provider health. */
export async function listPersonalMailboxes(ctx: ConsoleAuthorityContext) {
  try {
    const authority = await requireConsoleTurnAuthority(ctx);
    const memberId = authority.actingMemberId;
    if (!memberId || authority.spokenByMemberId !== memberId || authority.audience.participants.length !== 1 ||
      authority.audience.participants[0]?.kind !== 'member' || authority.audience.participants[0].memberId !== memberId) return refuse();
    const store = new PgAccountStore(getPool());
    const accounts = await store.list(memberId);
    const result = [];
    for (const account of accounts) {
      if (account.connectorId !== 'google') continue;
      const resources = account.status === 'ok'
        ? await store.listResources(memberId, account.id, account.generation) : [];
      result.push({ accountId: account.id, generation: account.generation, label: untrustedLine(account.providerAccount.label),
        status: account.status, mailboxes: resources.filter(resource => resource.resourceKind === 'mailbox').map(resource => ({
          resourceBindingId: resource.id, label: untrustedLine(resource.providerLabel),
        })) });
    }
    await requireConsoleTurnAuthority(ctx);
    return result;
  } catch { return refuse(); }
}
