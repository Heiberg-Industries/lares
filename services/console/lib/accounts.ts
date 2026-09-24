// services/console/lib/accounts.ts
// Read/config layer for connected Google accounts. Reads the shared oauth_tokens table via
// @lares/agent-box (the runtime's token store) so the console and runtime agree on encryption,
// identity, and org. The page + OAuth routes consume this; no secrets ever reach the DTO.
import { listTokens, type StoredOAuthToken } from "@lares/agent-box/lib/oauth-tokens.js";
import { pool } from "./db";
import { ownerId } from "./proactivity";
import { readSecret } from "./secrets";
import type { GoogleAccountDTO, GoogleOrg } from "./contracts";

/**
 * The principal the console reads and writes `oauth_tokens` rows under.
 *
 * Box 085 (`services/box/sql/085_oauth_principal_is_the_register_id.sql`, ruling D4) renamed
 * every legacy principal spelling onto the identity register's id, so the DEFAULT here is the
 * owner key this console already uses for every other person-keyed row (`ownerId()`, the same
 * rule as the fleet's own `services/chief-of-staff/lib/principals.ts`) rather than a hard-coded
 * legacy string. An installation that sets `CONSOLE_PRINCIPAL_ID` explicitly still wins, and it
 * must name the same value as the fleet's `GOOGLE_PRINCIPAL_ID` — otherwise the console lists
 * accounts the agents cannot find. Read when an operation runs, never during module import.
 */
export function consolePrincipal(): string {
  return process.env.CONSOLE_PRINCIPAL_ID?.trim() || ownerId();
}

/** MUST stay in lockstep with SCOPES in agent-runtime/bin/oauth-enroll.ts — one grant covers
 *  every Google power the fleet uses. calendar.events is NOT optional: calendar.readonly alone
 *  makes Google reject writes with ACCESS_TOKEN_SCOPE_INSUFFICIENT, and a stored refresh token
 *  never gains scopes on its own, so a console-enrolled mailbox that omits it silently loses
 *  calendar writes until it is re-consented. (It was omitted here until 2026-08-05.) */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  // ORB-286 batch 6 (Bendik, 2026-09-14): read-only Drive, so Saga can open a Docs/Sheets/Slides
  // link he sends. A token enrolled before this lacks it until re-consented once.
  "https://www.googleapis.com/auth/drive.readonly",
];

/** Google orgs are DISCOVERED from the credentials this host actually has — never hardcoded, so
 *  someone else running Lares registers their own client in their own Workspace and nothing about
 *  Heiberg's setup is in the code. `_CONSOLE` is the login client, not a mailbox client, and
 *  `_FILE` is readSecret's own suffix (GOOGLE_CLIENT_ID_FILE means "read the id from this path",
 *  as agent-box/compose.yaml:717 does for Marcel) — without excluding it, the discovery regex's
 *  optional `(_FILE)?` group falls back to matching "FILE" itself as an org id. */
export function googleOrgs(): GoogleOrg[] {
  const ids = new Set<string>();
  for (const key of Object.keys(process.env)) {
    const m = /^GOOGLE_CLIENT_ID_([A-Z0-9]+?)(_FILE)?$/.exec(key);
    if (m && m[1] !== "CONSOLE" && m[1] !== "FILE") ids.add(m[1].toLowerCase());
  }
  const domains = orgDomains();
  return [...ids]
    .filter((id) => googleOrgClientConfig(id) !== null)
    .sort()
    .map((id) => ({ id, label: domains[id]?.length ? `${id} (${domains[id].join(" · ")})` : id }));
}

/** "zero7=project.example;heiberg=owner.example,service.example" */
export function parseOrgDomains(raw: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const pair of (raw ?? "").split(";")) {
    const [org, list] = pair.split("=", 2);
    if (!org?.trim() || !list?.trim()) continue;
    out[org.trim().toLowerCase()] = list.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  }
  return out;
}

export function orgDomains(): Record<string, string[]> {
  return parseOrgDomains(process.env.GOOGLE_ORG_DOMAINS);
}

export function resolveOrgForEmail(
  email: string,
  orgIds: string[],
  domains: Record<string, string[]>,
  defaultOrg: string | undefined,
): { org: string } | { error: string } {
  const at = email.trim().toLowerCase().lastIndexOf("@");
  if (at <= 0 || at === email.trim().length - 1) return { error: `"${email}" is not an email address.` };
  const domain = email.trim().toLowerCase().slice(at + 1);

  for (const org of orgIds) if ((domains[org] ?? []).includes(domain)) return { org };
  // orgIds are always lowercase (googleOrgs() lowercases every id it discovers) — GOOGLE_DEFAULT_ORG
  // is an env var a human sets and is under no such obligation, so compare case-insensitively or
  // GOOGLE_DEFAULT_ORG=Heiberg silently fails this check and falls through to "no client mapped".
  const normalizedDefault = defaultOrg?.trim().toLowerCase();
  if (normalizedDefault && orgIds.includes(normalizedDefault)) return { org: normalizedDefault };
  if (orgIds.length === 1) return { org: orgIds[0] };
  return {
    error: `No OAuth client is mapped to "${domain}". Set GOOGLE_ORG_DOMAINS or GOOGLE_DEFAULT_ORG.`,
  };
}

/** Per-org OAuth client config, mirroring bin/oauth-enroll.ts (GOOGLE_CLIENT_ID_<ORG> etc). */
export function googleOrgClientConfig(org: string): { clientId: string; clientSecret: string } | null {
  if (!/^[a-z0-9]+$/.test(org)) return null;
  const clientId = readSecret(`GOOGLE_CLIENT_ID_${org.toUpperCase()}`);
  const clientSecret = readSecret(`GOOGLE_CLIENT_SECRET_${org.toUpperCase()}`);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function toGoogleAccountDTO(t: StoredOAuthToken): GoogleAccountDTO {
  return {
    principal: t.principal,
    email: t.emailAddress,
    org: t.orgId,
    scopeCount: t.scopes.length,
    connectedAt: t.createdAt.toISOString().slice(0, 10),
  };
}

export async function listGoogleAccounts(): Promise<GoogleAccountDTO[]> {
  const rows = await listTokens(pool, "google").catch(() => [] as StoredOAuthToken[]);
  return rows.map(toGoogleAccountDTO);
}

/** The AES key the runtime uses to encrypt refresh tokens. Console must store with the SAME key. */
export function tokenEncKeyHex(): string {
  const k = readSecret("TOKEN_ENC_KEY");
  if (!k || !/^[0-9a-f]{64}$/i.test(k)) {
    throw new Error("TOKEN_ENC_KEY must be a 64-char hex string (set TOKEN_ENC_KEY or TOKEN_ENC_KEY_FILE)");
  }
  return k;
}
