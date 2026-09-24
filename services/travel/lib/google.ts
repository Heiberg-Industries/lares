/**
 * lib/google.ts — lazy Gmail-readonly client, sourced from the fleet's shared `oauth_tokens`
 * Postgres table.
 *
 * AUTH PLUMBING NOW LIVES IN THE KIT (ORB-142 Step D): `decryptSecret`, `readTokenEncKey`,
 * `readSecretFile`, the `oauth_tokens` row read, the egress-proxy pinning and the
 * `OAuth2Client` construction were byte-identical duplication between this file and
 * `services/chief-of-staff/lib/google.ts`, and now live once in `@lares/agent-kit/google-auth`.
 *
 * WHAT DELIBERATELY DID NOT MOVE — this file is a least-privilege boundary, and these are the
 * things that keep it one. `heibergClientConfig()` stays here, hardcoded to the single
 * `heiberg` org: eve-saga has a TWO-org registry (`heiberg` + `zero7`), and sharing that table
 * would put Marcel one line of config away from reach into zero7's Gmail/Calendar. The
 * NO-fallback `selectMailboxToken` rule stays here (eve-saga's policy is the exact opposite —
 * fall back to the most-recently-updated mailbox). `GoogleUnenrolledError` — org-scoped and
 * fatal by design, unlike eve-saga's account-scoped one of the same name —
 * `GoogleScopeMissingError`, and the `hasCalendarScope` gate all stay here; eve-saga has no
 * scope check at all, and that asymmetry is deliberate, not a gap to reconcile. The kit hands
 * back an authenticated `OAuth2Client` and stops there: the `google.gmail(...)` /
 * `google.calendar(...)` calls stay in this file, so nothing shared can build a Google API
 * object on its own.
 *
 * Ported from two precedents (per the Task 4 brief's "compare both, port whichever shape is
 * more directly reusable" instruction):
 *   - Crypto + oauth_tokens read + lazy-secret-file conventions: `services/chief-of-staff/lib/google.ts`
 *     (`decryptSecret`, `readTokenEncKey`, its `heibergOrgConfig`-style secret-file reads,
 *     `buildAuthedGmail`, the `GoogleConfigError`/`GoogleUnenrolledError` split). This is the
 *     PRIMARY reference: eve-saga already targets the SAME `oauth_tokens` table with the SAME
 *     `TOKEN_ENC_KEY_FILE` docker-secret convention this service's compose block (Task 1) uses
 *     — more directly reusable than old Marcel's plain-env `TOKEN_ENC_KEY` (`keyFromEnv`).
 *     Every one of those pieces is now the kit's, shared by both agents.
 *   - The org-scoped, NO-fallback mailbox selection rule: `services/marcel/lib/gmail-token.ts`'s
 *     `selectMailboxToken`. eve-saga has no equivalent — it defaults to "most-recently-updated",
 *     pinned by an optional `GMAIL_PRIMARY_EMAIL` env var. This task's brief asks for old
 *     Marcel's rule verbatim: Marcel reads exactly one mailbox, so there is no "most recent"
 *     fallback, and a miss is fatal (a wrong-org read is worse than refusing to start).
 *
 * Scope is `gmail.readonly` ONLY: this file returns the raw `googleapis` `gmail_v1.Gmail`
 * client and nothing else — no search/read/send/draft adapter layer on top of it. There is no
 * write-mail surface here, and none planned for any later task. Readonly-ness is enforced by
 * which scope the underlying refresh token was actually granted at oauth-enroll time (out of
 * scope for this file), not by anything this client-construction code does.
 *
 * LAZINESS (the ORB-46 door-provisioning crash-loop lesson): `gmailClient()` does all of its
 * I/O — reading the token-enc-key file, querying Postgres, reading the OAuth client secret
 * files — only when actually CALLED, never at module load. An eager client built at container
 * startup that can't reach its dependency crash-loops the whole container; this file must
 * never reproduce that.
 *
 * SEALED EGRESS: eve-marcel is sealed identically to eve-saga (Task 1's compose block joins
 * it to the `saga_egress` nft saddr set; `squid.conf` allow-lists `googleapis.com` by DOMAIN
 * for exactly this reason). Google's API IPs are broad/rotating and can't be reached by a
 * direct allow, so every Gmail call — including the OAuth2 token refresh — must tunnel
 * through the same squid proxy, reading `EGRESS_PROXY_URL`. That pinning now happens inside
 * the kit's `buildOAuth2Client` (it was `applyEgressProxy` here, byte-identical to eve-saga's
 * function of the same name). Without it, every call is silently dropped by the firewall once
 * deployed — invisible to a test suite that stubs the network layer.
 *
 * CALENDAR (Task 11): `calendarClient()` reuses this SAME `oauth_tokens` row — Calendar is
 * read via the identical (principal, org) lookup, the identical `heibergClientConfig`, and
 * the identical `applyEgressProxy` call, since Calendar API traffic is sealed the same way
 * Gmail's is. It does NOT reuse `buildAuthedGmail` itself: `google.gmail({...})` and
 * `google.calendar({...})` return different client types, and this codebase's own convention
 * (see e.g. `dataRoot()`, duplicated per-tool-file rather than shared) is to duplicate a small
 * piece of construction code rather than force two unrelated client shapes through one
 * generic function — so `buildAuthedCalendar` is a parallel function, identical in shape.
 * (Both now share the kit's `buildOAuth2Client` for the AUTH half; what stays duplicated is
 * only the one-line `google.gmail(...)` / `google.calendar(...)` call, which is the point.)
 * The one genuinely NEW piece Calendar needs that Gmail never checked: `oauth_tokens.scopes`
 * might not actually include calendar access (a mailbox enrolled for Gmail-only, with nobody
 * ever having re-consented with Calendar added) — `calendarClient()` checks this explicitly
 * and throws `GoogleScopeMissingError` rather than letting a scope-less token reach Google and
 * come back as an opaque 403. IMPORTANT OPEN QUESTION (flagged for Bendik, not verifiable from
 * code alone): whether the REAL, currently-enrolled `oauth_tokens` row for (U_bendik, heiberg)
 * actually has calendar scope is an operational fact this file cannot determine — if it
 * doesn't, `calendar_list_events` will fail loudly with `GoogleScopeMissingError` the first
 * time it's called, which is the intended, safe degradation, not a bug.
 */
import { google, type calendar_v3, type gmail_v1 } from "googleapis";

import {
  GoogleConfigError,
  buildOAuth2Client,
  listDecryptedRefreshTokens as listKitRefreshTokens,
  readSecretFile,
  type DecryptedGoogleToken,
} from "@lares/agent-kit/google-auth";

// -----------------------------------------------------------------------------------------
// Errors — only `GoogleConfigError` (genuinely identical in both agents) comes from the kit.
// `GoogleUnenrolledError` below is MARCEL'S OWN: eve-saga has a type of the same name with
// different arity, different semantics (account-scoped, with a most-recent fallback) and a
// different message. `GoogleScopeMissingError` exists only here. Neither is merged.
// -----------------------------------------------------------------------------------------

/** No `oauth_tokens` row matches the requested (principal, org) — a real, expected outcome
 *  (enrollment hasn't happened / was revoked / wrong org), distinct from a config or transport
 *  failure. Never thrown eagerly — only when `gmailClient()` actually tries to resolve a
 *  client. Faithful to old Marcel's fatal-throw behavior: a wrong-mailbox read is worse than
 *  refusing to start. */
export class GoogleUnenrolledError extends Error {
  constructor(
    readonly principal: string,
    readonly org: string,
  ) {
    super(
      `eve-marcel: no oauth_tokens row for principal '${principal}' in org '${org}' — enrol the mailbox via the console before starting Marcel`,
    );
    this.name = "GoogleUnenrolledError";
  }
}

/** An `oauth_tokens` row exists for the requested (principal, org) — real Gmail enrollment —
 *  but its `scopes` column does not include the scope a CALLER actually needs (Calendar, for
 *  `calendarClient()`). Distinct from `GoogleUnenrolledError` (no row at all) and
 *  `GoogleConfigError` (a secret/config problem): this is "the mailbox is enrolled, but nobody
 *  ever consented to this particular access" — fixed by re-running the Google OAuth consent
 *  flow with the missing scope added, not by touching any file or env var. Thrown before any
 *  Calendar API call is attempted, so the failure reads as a clear, typed error rather than an
 *  opaque `403 insufficientPermissions` from Google. */
export class GoogleScopeMissingError extends Error {
  constructor(
    readonly principal: string,
    readonly org: string,
    readonly requiredScope: string,
  ) {
    super(
      `eve-marcel: the oauth_tokens row for principal '${principal}' in org '${org}' has no '${requiredScope}' scope — re-run the Google OAuth consent flow for this mailbox with Calendar access added`,
    );
    this.name = "GoogleScopeMissingError";
  }
}

// -----------------------------------------------------------------------------------------
// oauth_tokens store — the SQL read half is the kit's now (`listDecryptedRefreshTokens`,
// parameterised by provider). Marcel always passes "google". Selecting WHICH of the returned
// rows to use is `selectMailboxToken` below, and that stays here: it is policy, and Marcel's
// policy is deliberately the opposite of eve-saga's.
// -----------------------------------------------------------------------------------------

const PROVIDER = "google";

/** Every enrolled mailbox for (principal, "google"), decrypted — `selectMailboxToken` (below)
 *  does the org-scoped pick, not this query. */
async function listDecryptedRefreshTokens(principal: string): Promise<DecryptedGoogleToken[]> {
  return listKitRefreshTokens(principal, PROVIDER);
}

/**
 * Ported from `services/marcel/lib/gmail-token.ts`'s `selectMailboxToken` — Marcel reads
 * exactly one mailbox (the heiberg inbox travel mail arrives on), so there is no "pick the
 * most recent" fallback here (contrast eve-saga's `resolveGmailApi`, which serves several
 * accounts and defaults to "most recently updated"). A miss is fatal: reading the wrong
 * mailbox silently is worse than refusing to start.
 */
export function selectMailboxToken(rows: DecryptedGoogleToken[], principal: string, org: string): DecryptedGoogleToken {
  const match = rows.find((r) => r.orgId === org);
  if (!match) throw new GoogleUnenrolledError(principal, org);
  return match;
}

// -----------------------------------------------------------------------------------------
// Heiberg-org OAuth client config — the client id/secret pair every Google refresh token in
// this org's oauth_tokens rows was issued under. Ported from eve-saga's `heibergOrgConfig`,
// narrowed to Gmail only (no calendar in this task's scope).
//
// THIS IS A LEAST-PRIVILEGE BOUNDARY AND STAYS LOCAL (ORB-142 Step D). eve-saga's equivalent
// is a two-row registry (`heiberg`, `zero7`) looked up by whichever org the token itself
// claims. Marcel's is one hardcoded org, with no lookup and no table to add a row to. Sharing
// them would put Marcel one line of config away from reach into zero7's Gmail/Calendar, so the
// kit deliberately knows nothing about orgs: it takes an already-resolved
// `{ clientId, clientSecret }` and asks no questions. Only the generic file read is shared.
// -----------------------------------------------------------------------------------------

const DEFAULT_CLIENT_ID_FILE = "/run/secrets/google-client-id-heiberg";
const DEFAULT_CLIENT_SECRET_FILE = "/run/secrets/google-client-secret-heiberg";

interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
}

function heibergClientConfig(): GoogleClientConfig {
  return {
    clientId: readSecretFile("GOOGLE_CLIENT_ID_HEIBERG_FILE", DEFAULT_CLIENT_ID_FILE, "Google client id (heiberg)"),
    clientSecret: readSecretFile("GOOGLE_CLIENT_SECRET_HEIBERG_FILE", DEFAULT_CLIENT_SECRET_FILE, "Google client secret (heiberg)"),
  };
}

// -----------------------------------------------------------------------------------------
// Gmail client construction — ported from services/marcel/lib/gmail.ts's `makeGmailReader`
// (its `google.auth.OAuth2` + `google.gmail({version:"v1", auth})` construction, lines
// 124-127) and eve-saga's `buildAuthedGmail`. The OAuth2 client — construction, sealed-egress
// proxy pinning, credentials — is the kit's `buildOAuth2Client` now; the `google.gmail(...)`
// call stays here, so nothing shared can build a Gmail API object on its own.
// -----------------------------------------------------------------------------------------

function buildAuthedGmail(cfg: GoogleClientConfig, refreshToken: string): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth: buildOAuth2Client(cfg, refreshToken) });
}

/** Injectable for tests only — swaps the real googleapis client factory for a stub so
 *  `tests/google.test.ts` can prove `gmailClient()`'s selection/decrypt path end to end
 *  without ever reaching Google. Unset (the default) uses `buildAuthedGmail`. */
let testGmailApiFactory: ((cfg: GoogleClientConfig, refreshToken: string) => gmail_v1.Gmail) | undefined;
export function __setTestGmailApiFactory(factory: typeof testGmailApiFactory): void {
  testGmailApiFactory = factory;
}

/**
 * The lazy, per-call Gmail readonly client. Selects the `oauth_tokens` row by
 * `(GOOGLE_PRINCIPAL_ID, GOOGLE_ORG)` via `selectMailboxToken` — throws `GoogleUnenrolledError`
 * on no match. Throws `GoogleConfigError` if either env var is unset, or if the token-enc-key
 * / OAuth client secret files are missing or malformed.
 *
 * Token lookup happens BEFORE the org's OAuth client secret files are read, deliberately —
 * matching eve-saga's `resolveGmailApi` ordering: an unenrolled principal must surface as
 * `GoogleUnenrolledError` even when this host has no Google client secrets mounted at all, not
 * as a confusing `GoogleConfigError` about a file that was never going to be needed for this
 * call.
 *
 * Calling this function is the ONLY thing that does I/O — nothing at module scope touches the
 * filesystem, the DB, or Google.
 */
export async function gmailClient(): Promise<gmail_v1.Gmail> {
  const principal = process.env["GOOGLE_PRINCIPAL_ID"];
  if (!principal) throw new GoogleConfigError("GOOGLE_PRINCIPAL_ID is not set");
  const org = process.env["GOOGLE_ORG"];
  if (!org) throw new GoogleConfigError("GOOGLE_ORG is not set");

  const rows = await listDecryptedRefreshTokens(principal);
  const mailbox = selectMailboxToken(rows, principal, org);

  const cfg = heibergClientConfig();
  const factory = testGmailApiFactory ?? buildAuthedGmail;
  return factory(cfg, mailbox.token);
}

// -----------------------------------------------------------------------------------------
// Calendar client construction (Task 11) — parallel to the Gmail construction above, same
// shape, same `applyEgressProxy` call. See this file's own top-of-file doc comment ("CALENDAR
// (Task 11)") for why this is a sibling function rather than a shared generic.
// -----------------------------------------------------------------------------------------

/** Any scope string containing "calendar" (case-insensitive) satisfies the check — Google's
 *  own Calendar scopes are all `.../auth/calendar`, `.../auth/calendar.readonly`, or
 *  `.../auth/calendar.events.readonly`; none of Gmail's scopes contain that substring, so this
 *  can't false-positive against a Gmail-only row. */
const CALENDAR_SCOPE_LABEL = "calendar.readonly";

function hasCalendarScope(scopes: readonly string[]): boolean {
  return scopes.some((s) => s.toLowerCase().includes("calendar"));
}

function buildAuthedCalendar(cfg: GoogleClientConfig, refreshToken: string): calendar_v3.Calendar {
  return google.calendar({ version: "v3", auth: buildOAuth2Client(cfg, refreshToken) });
}

/** Injectable for tests only — same purpose as `__setTestGmailApiFactory`. */
let testCalendarApiFactory: ((cfg: GoogleClientConfig, refreshToken: string) => calendar_v3.Calendar) | undefined;
export function __setTestCalendarApiFactory(factory: typeof testCalendarApiFactory): void {
  testCalendarApiFactory = factory;
}

/**
 * The lazy, per-call Calendar readonly client. Same `(GOOGLE_PRINCIPAL_ID, GOOGLE_ORG)`
 * oauth_tokens lookup as `gmailClient()` — throws `GoogleUnenrolledError` on no match,
 * `GoogleConfigError` on missing env vars / unreadable secret files — PLUS one Calendar-only
 * check: the matched row's `scopes` must include calendar access, or this throws
 * `GoogleScopeMissingError` instead of ever attempting a Calendar API call. That check runs
 * BEFORE the org's OAuth client secret files are read, for the same reason `gmailClient()`
 * orders its own unenrolled check first: a scope problem must surface as
 * `GoogleScopeMissingError` even on a host with no Google client secrets mounted at all.
 *
 * Calling this function is the ONLY thing that does I/O — nothing at module scope touches the
 * filesystem, the DB, or Google.
 */
export async function calendarClient(): Promise<calendar_v3.Calendar> {
  const principal = process.env["GOOGLE_PRINCIPAL_ID"];
  if (!principal) throw new GoogleConfigError("GOOGLE_PRINCIPAL_ID is not set");
  const org = process.env["GOOGLE_ORG"];
  if (!org) throw new GoogleConfigError("GOOGLE_ORG is not set");

  const rows = await listDecryptedRefreshTokens(principal);
  const mailbox = selectMailboxToken(rows, principal, org);

  if (!hasCalendarScope(mailbox.scopes)) {
    throw new GoogleScopeMissingError(principal, org, CALENDAR_SCOPE_LABEL);
  }

  const cfg = heibergClientConfig();
  const factory = testCalendarApiFactory ?? buildAuthedCalendar;
  return factory(cfg, mailbox.token);
}
