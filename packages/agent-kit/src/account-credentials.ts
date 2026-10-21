/** Server-only bridge to existing encrypted OAuth custody. Never expose as a model tool or DTO.
 * Call only inside PgAccountStore's locked lifecycle/resource transaction. No alias/email adoption.
 */
import type { PoolClient } from 'pg';

export interface AccountCredentialOwner {
  id: string; ownerMemberId: string; connectorId: string; generation: number;
}
/** The trusted callback writes with the existing OAuth custody helper on THIS transaction.
 * A rejected association rolls back both the credential write and account lifecycle changes.
 */
export interface OAuthCredentialCommit { persist(db: PoolClient, context: Readonly<AccountCredentialOwner>): Promise<string> }
export interface StoredAccountCredential {
  refreshTokenEnc: string; scopes: string[]; orgId: string; emailAddress: string;
}
export class AccountCredentialError extends Error {
  constructor() { super('Account credentials require an explicit verified reconnect'); }
}

export async function associateAccountCredential(db: PoolClient, account: AccountCredentialOwner,
  persist: OAuthCredentialCommit['persist']): Promise<void> {
  const context = Object.freeze({ ...account });
  const tokenId = await persist(db, context);
  if (typeof tokenId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(tokenId))
    throw new AccountCredentialError();
  // Canonical registry member and connector are exact; aliases and display labels confer nothing.
  const token = await db.query(`SELECT id FROM oauth_tokens
    WHERE id=$1::uuid AND principal=$2 AND provider=$3 FOR UPDATE`,
    [tokenId, account.ownerMemberId, account.connectorId]);
  if (!token.rows[0]) throw new AccountCredentialError();
  const associated = await db.query('SELECT account_id FROM connected_account_credentials WHERE oauth_token_id=$1::uuid FOR UPDATE', [tokenId]);
  if (associated.rows[0] && associated.rows[0].account_id !== account.id) throw new AccountCredentialError();
  const current = await db.query('SELECT oauth_token_id FROM connected_account_credentials WHERE account_id=$1 FOR UPDATE', [account.id]);
  if (current.rows[0] && current.rows[0].oauth_token_id !== tokenId) throw new AccountCredentialError();
  await db.query(`INSERT INTO connected_account_credentials
    (account_id,owner_member_id,connector_id,account_generation,oauth_token_id) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (account_id) DO UPDATE SET account_generation=EXCLUDED.account_generation,
      oauth_token_id=EXCLUDED.oauth_token_id`,
    [account.id, account.ownerMemberId, account.connectorId, account.generation, tokenId]);
}

/** The caller already holds the current member/account/resource locks. This lookup additionally
 * locks association and custody until the callback finishes; no references escape in public views.
 */
export async function readAccountCredential(db: PoolClient, account: AccountCredentialOwner): Promise<StoredAccountCredential> {
  const { rows } = await db.query(`SELECT t.refresh_token_enc,t.scopes,t.org_id,t.email_address
    FROM connected_account_credentials c JOIN oauth_tokens t
      ON t.id=c.oauth_token_id AND t.principal=c.owner_member_id AND t.provider=c.connector_id
    WHERE c.account_id=$1 AND c.owner_member_id=$2 AND c.connector_id=$3 AND c.account_generation=$4
    FOR SHARE OF c,t`, [account.id, account.ownerMemberId, account.connectorId, account.generation]);
  if (!rows[0]) throw new AccountCredentialError();
  return { refreshTokenEnc: rows[0].refresh_token_enc, scopes: rows[0].scopes,
    orgId: rows[0].org_id, emailAddress: rows[0].email_address };
}
