// services/box/lib/oauth-tokens.ts
// Per-principal encrypted OAuth token store. Decryption is explicit (getDecryptedRefreshToken);
// every other read returns the secret-free StoredOAuthToken shape.
import type { Pool, PoolClient } from "pg";
import type { Queryable } from "./db.js";
import { encryptSecret, decryptSecret } from "./crypto.js";

export interface StoredOAuthToken {
  id: string; principal: string; provider: string; orgId: string;
  emailAddress: string; scopes: string[]; createdAt: Date; updatedAt: Date;
}

// ── "I looked, and there was nothing" is the quietest way this can break ────────────────────
//
// The baseline schema (sql/001_baseline.sql) keys every `principal` on the identity register's id
// rather than on a legacy spelling. A deployment that leaves one reader's
// principal environment value at the old spelling does not crash: the SELECT below simply
// matches no row, and the caller reports "no account connected". That is the ONE failure this
// rename can cause, so it says so — once per process, naming the principal it looked under, so
// the line is a diagnosis rather than noise in a poll loop.
let principalMissWarned = false;

function warnNoTokenForPrincipal(principal: string, provider: string): void {
  if (principalMissWarned) return;
  principalMissWarned = true;
  console.warn(
    `oauth tokens: no ${provider} token is stored under the principal "${principal}". ` +
    `Legacy principal spellings were replaced by the identity register's id ` +
    `(users.id): if this deployment still names the old spelling in its principal setting ` +
    `(GOOGLE_PRINCIPAL_ID / CONSOLE_PRINCIPAL_ID / NOTION_SYNC_PRINCIPAL), point it at the ` +
    `register's id instead. Said once per process.`,
  );
}

/** Tests only: let the once-per-process warning above fire again. */
export function resetOAuthPrincipalWarningForTests(): void {
  principalMissWarned = false;
}

const SAFE_COLS = `id, principal, provider, org_id AS "orgId", email_address AS "emailAddress",
  scopes, created_at AS "createdAt", updated_at AS "updatedAt"`;

export interface TokenMaterial { orgId: string; emailAddress: string; scopes: string[]; refreshToken: string }
export interface LockedAccountContext { readonly id: string; readonly ownerMemberId: string; readonly connectorId: string; readonly generation: number }
export class LegacyCredentialQuarantinedError extends Error {
  constructor() { super("This account requires the account-aware credential path"); }
}
async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
/** Lock the exact custody row, including a concurrent insert, before checking associations.
 * The fresh second query sees any association committed while the row lock was awaited. */
async function writeToken(db: Queryable, keyHex: string, principal: string, provider: string,
  material: TokenMaterial, accountId?: string): Promise<string> {
  const enc = encryptSecret(material.refreshToken, keyHex);
  await db.query(`INSERT INTO oauth_tokens (principal,provider,org_id,email_address,refresh_token_enc,scopes)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (principal,provider,email_address) DO NOTHING`,
    [principal,provider,material.orgId,material.emailAddress,enc,material.scopes]);
  const { rows } = await db.query<{id:string}>(`SELECT id FROM oauth_tokens
    WHERE principal=$1 AND provider=$2 AND email_address=$3 FOR UPDATE`, [principal,provider,material.emailAddress]);
  const id = rows[0]?.id;
  if (!id) throw new LegacyCredentialQuarantinedError();
  const associated = await db.query<{account_id:string}>('SELECT account_id FROM connected_account_credentials WHERE oauth_token_id=$1::uuid', [id]);
  if (associated.rows.some(row => row.account_id !== accountId)) throw new LegacyCredentialQuarantinedError();
  await db.query('UPDATE oauth_tokens SET org_id=$2,refresh_token_enc=$3,scopes=$4,updated_at=now() WHERE id=$1::uuid', [id,material.orgId,enc,material.scopes]);
  return id;
}
/** LEGACY enrollment only. Associated custody can never be overwritten through this path. */
export async function storeToken(pool: Pool, keyHex: string,
  t: TokenMaterial & { principal: string; provider: string }): Promise<string> {
  const material = { ...t, scopes: [...t.scopes] };
  return transaction(pool, db => writeToken(db, keyHex, material.principal, material.provider, material));
}
/** Server-only. Call exclusively from the verified lifecycle's persist callback on its locked
 * transaction. Context generation is the NEXT persisted generation returned by that lifecycle.
 * Neither caller form fields nor a model may supply this context. */
export async function writeVerifiedAccountToken(db: PoolClient, context: Readonly<LockedAccountContext>,
  keyHex: string, material: TokenMaterial): Promise<string> {
  const snapshot = Object.freeze({ ...context });
  const token = { ...material, scopes: [...material.scopes] };
  const current = await db.query(`SELECT id FROM connected_accounts WHERE id=$1 AND owner_member_id=$2
    AND connector_id=$3 AND generation=$4 AND status='ok' FOR UPDATE`,
    [snapshot.id,snapshot.ownerMemberId,snapshot.connectorId,snapshot.generation]);
  if (!current.rows[0]) throw new LegacyCredentialQuarantinedError();
  const association = await db.query<{oauth_token_id:string}>('SELECT oauth_token_id FROM connected_account_credentials WHERE account_id=$1 FOR UPDATE', [snapshot.id]);
  if (association.rows[0]) {
    // Keep permanent custody association even when the verified provider changes its label/address.
    const id = association.rows[0].oauth_token_id;
    const row = await db.query(`SELECT id FROM oauth_tokens WHERE id=$1::uuid AND principal=$2 AND provider=$3 FOR UPDATE`, [id,snapshot.ownerMemberId,snapshot.connectorId]);
    if (!row.rows[0]) throw new LegacyCredentialQuarantinedError();
    await db.query(`UPDATE oauth_tokens SET org_id=$2,email_address=$3,refresh_token_enc=$4,scopes=$5,updated_at=now() WHERE id=$1::uuid`,
      [id,token.orgId,token.emailAddress,encryptSecret(token.refreshToken,keyHex),token.scopes]);
    return id;
  }
  return writeToken(db,keyHex,snapshot.ownerMemberId,snapshot.connectorId,token,snapshot.id);
}

export async function getDecryptedRefreshToken(
  db: Queryable, keyHex: string, principal: string, provider: string,
): Promise<{ token: string; scopes: string[]; emailAddress: string; orgId: string } | null> {
  const { rows } = await db.query<{ refresh_token_enc: string; scopes: string[]; email_address: string; org_id: string; associated: boolean }>(
    `SELECT refresh_token_enc, scopes, email_address, org_id,
       EXISTS(SELECT 1 FROM connected_account_credentials c WHERE c.oauth_token_id=t.id) AS associated
     FROM oauth_tokens t WHERE principal=$1 AND provider=$2 ORDER BY updated_at DESC`,
    [principal, provider],
  );
  if (rows.some(row => row.associated)) throw new LegacyCredentialQuarantinedError();
  const r = rows[0];
  if (!r) { warnNoTokenForPrincipal(principal, provider); return null; }
  return { token: decryptSecret(r.refresh_token_enc, keyHex), scopes: r.scopes, emailAddress: r.email_address, orgId: r.org_id };
}

export async function listDecryptedRefreshTokens(
  db: Queryable, keyHex: string, principal: string, provider: string,
): Promise<Array<{ token: string; scopes: string[]; emailAddress: string; orgId: string }>> {
  const { rows } = await db.query<{ refresh_token_enc: string; scopes: string[]; email_address: string; org_id: string; associated: boolean }>(
    `SELECT refresh_token_enc, scopes, email_address, org_id,
       EXISTS(SELECT 1 FROM connected_account_credentials c WHERE c.oauth_token_id=t.id) AS associated
     FROM oauth_tokens t WHERE principal=$1 AND provider=$2 ORDER BY email_address`,
    [principal, provider],
  );
  if (rows.some(row => row.associated)) throw new LegacyCredentialQuarantinedError();
  if (rows.length === 0) warnNoTokenForPrincipal(principal, provider);
  return rows.map((r) => ({
    token: decryptSecret(r.refresh_token_enc, keyHex), scopes: r.scopes,
    emailAddress: r.email_address, orgId: r.org_id,
  }));
}

export async function listTokens(db: Queryable, provider?: string): Promise<StoredOAuthToken[]> {
  const { rows } = provider
    ? await db.query<StoredOAuthToken>(`SELECT ${SAFE_COLS} FROM oauth_tokens WHERE provider=$1 ORDER BY created_at`, [provider])
    : await db.query<StoredOAuthToken>(`SELECT ${SAFE_COLS} FROM oauth_tokens ORDER BY created_at`);
  return rows;
}

/** LEGACY removal only. Administrative person erasure remains a separate lifecycle. */
export async function deleteToken(pool: Pool, principal: string, provider: string, emailAddress?: string): Promise<void> {
  return transaction(pool, async db => {
    const { rows } = await db.query<{id:string}>(`SELECT id FROM oauth_tokens
      WHERE principal=$1 AND provider=$2 AND ($3::text IS NULL OR email_address=$3) ORDER BY id FOR UPDATE`,
      [principal,provider,emailAddress ?? null]);
    if (!rows.length) return;
    const ids = rows.map(row => row.id);
    const associated = await db.query('SELECT 1 FROM connected_account_credentials WHERE oauth_token_id=ANY($1::uuid[])', [ids]);
    if (associated.rows.length) throw new LegacyCredentialQuarantinedError();
    await db.query('DELETE FROM oauth_tokens WHERE id=ANY($1::uuid[])', [ids]);
  });
}
