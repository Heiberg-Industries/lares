/**
 * google-auth — the Google OAuth *plumbing* every agent that reads the fleet's shared
 * `oauth_tokens` table needs, and nothing above that line (ORB-142 Step D).
 *
 * WHAT THIS MODULE IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * eve-saga and eve-marcel both authenticate against the same `oauth_tokens` Postgres table,
 * with the same AES-256-GCM storage format, the same `TOKEN_ENC_KEY_FILE` docker-secret
 * convention, and the same sealed-egress proxy requirement. Before this module, roughly 180
 * lines of that were byte-identical duplication between the two files — including the SQL
 * text and the error-message strings. That duplication is what this module removes: a fix to
 * the decrypt path, the secret-file convention, or the proxy pinning now lands once.
 *
 * ABOVE that line the two agents share ZERO code, and their policies actively CONTRADICT each
 * other in three places, each a deliberate safety decision. None of it lives here:
 *
 *   - **The org registry stays per-agent.** eve-saga has a two-org table (`heiberg`, `zero7`);
 *     eve-marcel is hardcoded to `heiberg` alone. A shared org table would be one line of
 *     config away from giving a deliberately-restricted agent reach into another org's
 *     Gmail/Calendar. This module therefore never learns an org's name: it takes an already-
 *     resolved `{ clientId, clientSecret }` from the caller and asks no questions.
 *   - **Mailbox-selection policy stays per-agent.** eve-saga falls back to the most-recently-
 *     updated mailbox on a miss; eve-marcel is fatal-no-fallback by design. The functions
 *     below return token ROWS; what a caller does with them is that caller's policy.
 *   - **Scope gating stays per-agent.** eve-marcel refuses to hand out a Calendar client when
 *     the token's `scopes` column lacks calendar access; eve-saga has no such check. That
 *     asymmetry is deliberate, and reconciling it is not this module's business.
 *
 * ONE MORE DELIBERATE CEILING: `buildOAuth2Client` returns an authenticated `OAuth2Client` and
 * stops there. It does NOT call `google.gmail(...)` or `google.calendar(...)` — each agent
 * makes that one-line call itself, against its own capability surface. So this module can
 * never, on its own, construct a live Gmail or Calendar API object; it can only hand back a
 * client that still needs an agent-local call to become one.
 *
 * LAZINESS (the ORB-46 door-provisioning crash-loop lesson, preserved from both sources):
 * nothing here reads a credential at module scope. Every secret file is read inside the
 * function that needs it, on every call. A missing or malformed secret surfaces as a typed
 * `GoogleConfigError` the first time a caller actually needs it — never as the framework
 * crashing at container boot.
 */
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { OAuth2Client } from "googleapis-common";

import { getPool } from "./db.js";

// -----------------------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------------------

/** A Google secret (the token-enc-key file, an OAuth client id/secret file) is missing,
 *  unreadable, or malformed — a configuration problem, not "this person isn't enrolled".
 *
 *  Deliberately the ONLY error type in this module. Each agent keeps its own "not enrolled"
 *  and "scope missing" errors local, because their arity, semantics and messages differ:
 *  eve-saga's `GoogleUnenrolledError(principal, account?)` names a mailbox, eve-marcel's
 *  `GoogleUnenrolledError(principal, org)` names an org and is fatal by design, and
 *  `GoogleScopeMissingError` exists only on eve-marcel. */
export class GoogleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleConfigError";
  }
}

// -----------------------------------------------------------------------------------------
// Crypto — ported verbatim from services/box/lib/crypto.ts's decryptSecret (the shape
// both eve-saga and eve-marcel had copied byte-for-byte). Storage format:
// base64(IV(12 bytes) || ciphertext || authTag(16 bytes)). `encryptSecret` is NOT here: this
// stack only ever READS tokens that oauth-enroll.ts already wrote.
// -----------------------------------------------------------------------------------------

const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEX64 = /^[0-9a-fA-F]{64}$/;

function keyBuf(keyHex: string): Buffer {
  if (!HEX64.test(keyHex)) throw new GoogleConfigError("encryption key must be 64 hex chars (32 bytes)");
  return Buffer.from(keyHex, "hex");
}

/** AES-256-GCM decrypt, byte-for-byte identical to `services/box/lib/crypto.ts`'s
 *  `decryptSecret` — get this wrong and every stored Google refresh token becomes silently
 *  undecryptable or decrypts to garbage. Exported for a direct round-trip test against a
 *  locally-encrypted fixture (this module has no `encryptSecret`, so the test encrypts with
 *  the same raw algorithm to prove the two are inverse). */
export function decryptSecret(encoded: string, keyHex: string): string {
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyBuf(keyHex), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

const DEFAULT_TOKEN_ENC_KEY_FILE = "/run/secrets/token-enc-key";

/** Read on every call, never at module scope — the "read the file lazily at call time, trim
 *  whitespace" convention every secret in this codebase follows. Throws `GoogleConfigError`
 *  (not the framework crashing at boot) when the file is missing or its contents aren't 64
 *  hex chars. */
export function readTokenEncKey(): string {
  const path = process.env["TOKEN_ENC_KEY_FILE"] ?? DEFAULT_TOKEN_ENC_KEY_FILE;
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new GoogleConfigError(`token-enc-key not readable: ${path}`);
  }
  if (!HEX64.test(value)) {
    throw new GoogleConfigError(`token-enc-key at ${path} must be 64 hex chars (32 bytes)`);
  }
  return value;
}

/** Read a secret file named by an env var, falling back to a default path — same convention
 *  as `readTokenEncKey`, on every call, never at module scope. `label` is what the error
 *  message names, so a caller can say which org's client id failed to read without this
 *  module ever knowing what an org is. */
export function readSecretFile(envVar: string, defaultPath: string, label: string): string {
  const path = process.env[envVar] ?? defaultPath;
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new GoogleConfigError(`${label} not readable: ${path}`);
  }
  if (value.length === 0) throw new GoogleConfigError(`${label} file is empty: ${path}`);
  return value;
}

// -----------------------------------------------------------------------------------------
// oauth_tokens store — the read half only, SQL included, ported verbatim from
// services/box/lib/oauth-tokens.ts (via both agents' identical copies). `storeToken` /
// `encryptSecret` are not here: this stack only ever reads.
//
// Both functions return ROWS. Neither has an opinion about which row a caller should use —
// that selection is POLICY, and policy is exactly what stays per-agent (see the module
// doc-comment).
// -----------------------------------------------------------------------------------------

export interface DecryptedGoogleToken {
  token: string;
  scopes: string[];
  emailAddress: string;
  orgId: string;
}

// ── "I looked, and there was nothing" is the quietest way this can break ────────────────────
//
// Box 085 (services/box/sql/085_oauth_principal_is_the_register_id.sql) renamed every legacy
// `principal` spelling onto the identity register's id. A deployment that applies it but leaves
// `GOOGLE_PRINCIPAL_ID` at the old spelling does not crash: the SELECTs below simply match no
// row, and the caller turns that into "not enrolled with Google". That is the ONE failure this
// rename can cause, so it says so — once per process, naming the principal it looked under, so
// the line is a diagnosis rather than noise in a schedule that polls.
let principalMissWarned = false;

function warnNoTokenForPrincipal(principal: string, provider: string): void {
  if (principalMissWarned) return;
  principalMissWarned = true;
  console.warn(
    `google-auth: no ${provider} token is stored under the principal "${principal}". ` +
    `Box migration 085 renamed legacy principal spellings onto the identity register's id ` +
    `(users.id): if this deployment still names the old spelling in GOOGLE_PRINCIPAL_ID, point ` +
    `it at the register's id instead. Said once per process.`,
  );
}

/** Tests only: let the once-per-process warning above fire again. */
export function resetGooglePrincipalWarningForTests(): void {
  principalMissWarned = false;
}

interface OAuthTokenRow {
  refresh_token_enc: string;
  scopes: string[];
  email_address: string;
  org_id: string;
}

/** The most-recently-updated token row for (principal, provider), or `null` when there is
 *  none. A raw data read, NOT a selection policy: "most recent" is simply what `ORDER BY
 *  updated_at DESC LIMIT 1` means, and turning a `null` into an error — or refusing to accept
 *  a most-recent answer at all, as eve-marcel deliberately does — is the caller's decision. */
export async function getMostRecentRefreshToken(principal: string, provider: string): Promise<DecryptedGoogleToken | null> {
  const keyHex = readTokenEncKey();
  const { rows } = await getPool().query<OAuthTokenRow>(
    `SELECT refresh_token_enc, scopes, email_address, org_id FROM oauth_tokens
     WHERE principal=$1 AND provider=$2 ORDER BY updated_at DESC LIMIT 1`,
    [principal, provider],
  );
  const r = rows[0];
  if (!r) { warnNoTokenForPrincipal(principal, provider); return null; }
  return { token: decryptSecret(r.refresh_token_enc, keyHex), scopes: r.scopes, emailAddress: r.email_address, orgId: r.org_id };
}

/** Every enrolled mailbox for (principal, provider), decrypted, ordered by email address.
 *  `provider` is a parameter rather than a module constant so this module never pins itself to
 *  one agent's provider string. */
export async function listDecryptedRefreshTokens(principal: string, provider: string, selection?: {mailbox:string;org:string}): Promise<DecryptedGoogleToken[]> {
  const keyHex = readTokenEncKey();
  const { rows } = await getPool().query<OAuthTokenRow>(
    `SELECT refresh_token_enc, scopes, email_address, org_id FROM oauth_tokens
     WHERE principal=$1 AND provider=$2 AND ($3::text IS NULL OR email_address=$3) AND ($4::text IS NULL OR org_id=$4) ORDER BY email_address`,
    [principal, provider, selection?.mailbox??null, selection?.org??null],
  );
  if (rows.length === 0) warnNoTokenForPrincipal(principal, provider);
  return rows.map((r) => ({
    token: decryptSecret(r.refresh_token_enc, keyHex),
    scopes: r.scopes,
    emailAddress: r.email_address,
    orgId: r.org_id,
  }));
}

// -----------------------------------------------------------------------------------------
// Egress proxy + OAuth2 client construction — ported verbatim from
// services/agent-runtime/lib/adapters/google-proxy.ts, via both agents' identical copies.
//
// Every agent using this module is sealed: Google's API IPs are broad/rotating and can't be
// IP-allow-listed, so Google OAuth/API traffic tunnels through the shared squid proxy
// (`EGRESS_PROXY_URL`), which allow-lists googleapis.com by DOMAIN. Both the token refresh and
// every API call go through the OAuth2 client's own gaxios transporter, so the proxy has to be
// installed THERE — a global dispatcher patch would also capture gateway/Twenty/Orakel
// traffic, which squid denies. Without this, every call is silently dropped by the firewall
// once deployed — invisible to a test suite that stubs the network layer.
// -----------------------------------------------------------------------------------------

function applyEgressProxy(auth: unknown): void {
  const proxy = process.env["EGRESS_PROXY_URL"];
  if (!proxy) return;
  const t = (auth as { transporter?: { defaults?: Record<string, unknown> } }).transporter;
  if (t?.defaults) t.defaults.proxy = proxy;
}

/** An OAuth client id/secret pair the CALLER has already resolved. `redirectUri` only matters
 *  for the initial authorization-code exchange (`oauth-enroll.ts`), never for refreshing an
 *  existing token or calling the API, so omitting it is correct for every agent that only ever
 *  reads already-enrolled tokens. */
export interface OAuth2ClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}

/** The authenticated, auto-refreshing `OAuth2Client`: construct it, pin the egress proxy on
 *  its transporter, set the refresh token, hand it back.
 *
 *  It STOPS there, on purpose. Turning this into a Gmail or Calendar API object takes one more
 *  line — `google.gmail({ version: "v1", auth })` / `google.calendar({ version: "v3", auth })`
 *  — and that line lives in each agent's own `lib/google.ts`, next to that agent's own
 *  capability surface. This module has no way to reach an API on its own. */
export function buildOAuth2Client(cfg: OAuth2ClientConfig, refreshToken: string): OAuth2Client {
  // `OAuth2Client` is imported from `googleapis-common` rather than from `googleapis` itself,
  // and it is the SAME class: `googleapis-common`'s AuthPlus assigns `OAuth2 =
  // google_auth_library_1.OAuth2Client`, so `new google.auth.OAuth2(...)` — what both agents
  // wrote before — and this construct the identical object. Taking it from the smaller package
  // keeps `googleapis` (a 26 MB bundle chunk with an enormous type surface) out of this
  // package's module graph; importing it from a second package boundary pushed eve-saga's
  // `eve build` past Node's default heap limit even though the emitted bundle was unchanged.
  // Importing from `google-auth-library` directly would NOT be safe: two versions of it are
  // installed in this workspace, and only the one `googleapis-common` re-exports is the class
  // `googleapis` itself uses.
  //
  // Constructed WITHOUT a third argument when the caller has no redirectUri, rather than
  // passing `undefined` — exactly reproducing eve-marcel's two-argument call, while eve-saga
  // keeps passing its (possibly empty-string) redirectUri as before.
  const auth = cfg.redirectUri === undefined
    ? new OAuth2Client(cfg.clientId, cfg.clientSecret)
    : new OAuth2Client(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
  applyEgressProxy(auth);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}
