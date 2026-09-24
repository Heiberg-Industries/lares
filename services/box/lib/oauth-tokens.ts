// services/box/lib/oauth-tokens.ts
// Per-principal encrypted OAuth token store. Decryption is explicit (getDecryptedRefreshToken);
// every other read returns the secret-free StoredOAuthToken shape.
import type { Queryable } from "./db.js";
import { encryptSecret, decryptSecret } from "./crypto.js";

export interface StoredOAuthToken {
  id: string; principal: string; provider: string; orgId: string;
  emailAddress: string; scopes: string[]; createdAt: Date; updatedAt: Date;
}

// ── "I looked, and there was nothing" is the quietest way this can break ────────────────────
//
// Box 085 (sql/085_oauth_principal_is_the_register_id.sql) renamed every legacy `principal`
// spelling onto the identity register's id. A deployment that applies it but leaves one reader's
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
    `Box migration 085 renamed legacy principal spellings onto the identity register's id ` +
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

export async function storeToken(
  db: Queryable, keyHex: string,
  t: { principal: string; provider: string; orgId: string; emailAddress: string; scopes: string[]; refreshToken: string },
): Promise<string> {
  const enc = encryptSecret(t.refreshToken, keyHex);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (principal, provider, email_address) DO UPDATE
       SET org_id=$3, refresh_token_enc=$5, scopes=$6, updated_at=now()
     RETURNING id`,
    [t.principal, t.provider, t.orgId, t.emailAddress, enc, t.scopes],
  );
  return rows[0].id;
}

export async function getDecryptedRefreshToken(
  db: Queryable, keyHex: string, principal: string, provider: string,
): Promise<{ token: string; scopes: string[]; emailAddress: string; orgId: string } | null> {
  const { rows } = await db.query<{ refresh_token_enc: string; scopes: string[]; email_address: string; org_id: string }>(
    `SELECT refresh_token_enc, scopes, email_address, org_id FROM oauth_tokens
     WHERE principal=$1 AND provider=$2 ORDER BY updated_at DESC LIMIT 1`,
    [principal, provider],
  );
  const r = rows[0];
  if (!r) { warnNoTokenForPrincipal(principal, provider); return null; }
  return { token: decryptSecret(r.refresh_token_enc, keyHex), scopes: r.scopes, emailAddress: r.email_address, orgId: r.org_id };
}

export async function listDecryptedRefreshTokens(
  db: Queryable, keyHex: string, principal: string, provider: string,
): Promise<Array<{ token: string; scopes: string[]; emailAddress: string; orgId: string }>> {
  const { rows } = await db.query<{ refresh_token_enc: string; scopes: string[]; email_address: string; org_id: string }>(
    `SELECT refresh_token_enc, scopes, email_address, org_id FROM oauth_tokens
     WHERE principal=$1 AND provider=$2 ORDER BY email_address`,
    [principal, provider],
  );
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

export async function deleteToken(db: Queryable, principal: string, provider: string, emailAddress?: string): Promise<void> {
  if (emailAddress) {
    await db.query(`DELETE FROM oauth_tokens WHERE principal=$1 AND provider=$2 AND email_address=$3`, [principal, provider, emailAddress]);
    return;
  }
  await db.query(`DELETE FROM oauth_tokens WHERE principal=$1 AND provider=$2`, [principal, provider]);
}
