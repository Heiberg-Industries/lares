// Shared credential types with a save-time `test()` call — ADR-0019 rule 3
// (docs/decisions/0019-integrations.md). One shape per auth kind (API key, OAuth2), checked
// against the real vendor when the owner saves it, not discovered on first real use days later.
//
// RULE ONE: A CREDENTIAL NEVER HOLDS A SECRET VALUE — only a secret FILE NAME or a ROW
// REFERENCE. This follows the "credential custody" vocabulary already in ./connections.ts (who
// holds the credential decides what the console may offer) and the row shape
// `google-auth.ts:151-170` already uses for Google's refresh token (`refresh_token_enc`, read by
// `(principal, provider)`, decrypted only at the point of use). `ApiKeyCredential.secretFile` and
// `OAuth2Credential.clientIdFile`/`clientSecretFile` name a secret file on disk; `refreshTokenRef`
// names a table, key column and key — never the token itself. A type with a field for the secret
// value would let one careless `JSON.stringify` of a credential (a log line, a console response,
// a test snapshot) leak it; the type having no such field makes that structurally impossible
// here, whatever a caller does downstream.
//
// RULE TWO: `test()` RUNS AT SAVE TIME, NOT DISCOVERED ON FIRST USE. The owner pastes a key or
// finishes a sign-in; the console calls `test()` right then, against the real vendor, and shows
// the answer in plain words — never lets a broken credential sit until a scheduled job quietly
// fails on it.
//
// RULE THREE: `test()` MUST BE SAFE TO REPEAT. It takes the shared request helper
// (`./request.js`'s `Requester`) as a dependency and must call it with a read — a lookup of the
// account/workspace/identity the credential belongs to — never a call that sends or creates
// anything. A save-time check that fires an email or creates a record is not a check, it's a side
// effect; and `Requester` only retries a call it can tell is idempotent (`./request.ts`'s own
// module header), so `test()` staying a GET also means the request helper's own retry-on-failure
// behaves the way `test()` needs it to.
//
// NO CONCRETE CREDENTIAL TYPE IS DEFINED HERE. Google, Notion and Slack are wave 6B; defining one
// in this slice, without a live probe against the real vendor, would be a fixture pretending to
// be knowledge — the repo rule in CLAUDE.md. `defineCredentialType` is the identity function,
// present only for inference, the same shape `eve/tools`'s `defineTool` already establishes in
// this codebase — so every credential type this fleet writes reads the same way.

import { isRequestError, type RequestErrorKind } from "./request-error.js";
import type { Requester } from "./request.js";

export type CredentialKind = "api_key" | "oauth2";

export interface ApiKeyCredential {
  kind: "api_key";
  integration: string;
  /** The secret FILE name, never the secret. */
  secretFile: string;
}

export interface OAuth2Credential {
  kind: "oauth2";
  integration: string;
  /** ADR-0019 rule 4: the owner supplies their own client. Lares never operates a central one. */
  clientIdFile: string;
  clientSecretFile: string;
  refreshTokenRef: { table: string; keyColumn: string; key: string };
  scopes: readonly string[];
}

export type Credential = ApiKeyCredential | OAuth2Credential;

export type CredentialTestResult =
  | { ok: true; /** What the vendor said identifies this credential — an account email, a workspace name. Never a token. */ identity?: string }
  | { ok: false; kind: RequestErrorKind; message: string };

export interface CredentialType<C extends Credential = Credential> {
  kind: C["kind"];
  /** Refuses a malformed credential before anything is stored. */
  validate(c: C): string[];
  /** One real call against the vendor. Checked at SAVE time, never discovered on first use. */
  test(c: C, deps: { request: Requester }): Promise<CredentialTestResult>;
}

export function defineCredentialType<C extends Credential>(t: CredentialType<C>): CredentialType<C> {
  return t;
}

/** Turns any thrown error into a `{ ok: false }` — a test() never throws, so a console save
 *  always gets an answer it can show. */
export async function runCredentialTest<C extends Credential>(
  t: CredentialType<C>,
  c: C,
  deps: { request: Requester },
): Promise<CredentialTestResult> {
  try {
    return await t.test(c, deps);
  } catch (e) {
    if (isRequestError(e)) {
      return { ok: false, kind: e.kind, message: e.message };
    }
    return { ok: false, kind: "down", message: String((e as Error)?.message ?? e) };
  }
}
