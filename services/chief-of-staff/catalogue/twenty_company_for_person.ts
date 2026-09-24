// Read the company linked to a CRM person, by the person's record id. Read-only HTTP
// against TWENTY_BASE_URL.
//
// Ported from `services/agent-runtime/lib/adapters/twenty-client.ts`'s
// `getCompanyForPerson`, which itself calls `getPersonImpl` first to resolve `companyId`.
//
// ORB-51 posture: three distinct "no company" outcomes are all valid, expected results —
// person not found, person found but has no linked company, and a dangling companyId that
// 404s — and all collapse to the same typed not-found shape the hand's description
// promised ("...or a no-company note"). Only a genuine `TwentyUnavailableError` from either
// HTTP call propagates as a real error.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { twentyGet, TwentyNotFoundError } from "../lib/twenty-client.js";
import { fetchTwentyPerson } from "./twenty_get_person.js";

export interface TwentyCrmCompany {
  recordId: string;
  name: string;
  domain: string | null;
  orgNumber: string | null;
}
export type TwentyCompanyNotFound = { ok: false; reason: "no linked company" };

/** Shared with `lib/person-sources.ts` (person_lookup's `company` source) so it doesn't
 *  re-implement this two-step fetch. */
export async function twentyCompanyForPerson(recordId: string): Promise<TwentyCrmCompany | TwentyCompanyNotFound> {
  const person = await fetchTwentyPerson(recordId);
  if ("ok" in person) return { ok: false, reason: "no linked company" };
  if (!person.companyId) return { ok: false, reason: "no linked company" };

  let body: { data?: { company?: any } };
  try {
    body = await twentyGet<{ data?: { company?: any } }>(`/companies/${person.companyId}`);
  } catch (err) {
    if (err instanceof TwentyNotFoundError) return { ok: false, reason: "no linked company" };
    throw err;
  }
  const c = body?.data?.company;
  if (!c) return { ok: false, reason: "no linked company" };
  return {
    recordId: c?.id ?? person.companyId,
    name: typeof c?.name === "string" ? c.name : (c?.name?.text ?? ""),
    domain: c?.domainName?.primaryLinkUrl ?? c?.domainName ?? null,
    orgNumber: c?.orgNumber ?? null,
  };
}

/**
 * ORB-166 — the CRM company matched BY MAIL DOMAIN, for person_lookup's organisation stage.
 *
 * Lives beside `twentyCompanyForPerson` rather than in `twenty_lookup.ts` because it answers a
 * COMPANY question, and because `buildLookupQueries` deliberately matches companies by NAME
 * substring only: handing it "atcyrus.com" searches for a company literally called
 * "atcyrus.com", finds nothing, and that nothing then reads as "the CRM does not know them".
 *
 * `domainName` is a Twenty LINKS composite, so the filter addresses its subfield exactly the way
 * `buildLookupQueries` addresses `emails.primaryEmail`. Matching is `ilike` on a contained
 * substring: the stored value is usually a URL (`https://atcyrus.com`), not a bare host.
 *
 * An empty result is a real answer — the CRM holds no company on that domain — and returns null.
 * Only a genuine `TwentyUnavailableError` propagates: the organisation stage must be able to tell
 * "asked, nobody there" from "could not ask".
 *
 * FIX ROUND 1 — the `ilike` is a SUBSTRING match, so a query for `cyrus.com` matches a stored
 * `https://atcyrus.com` and hands back the wrong company under the right name. Every candidate is
 * therefore host-verified here: the stored URL's host must BE the queried domain or a subdomain of
 * it (`www.nomono.co` passes, `atcyrus.com` for `cyrus.com` does not). The query asks for several
 * rather than one so a coincidental substring hit cannot crowd out the real record behind it, and
 * a company whose host cannot be read at all is rejected rather than assumed — an unverifiable
 * match is not a match.
 */
function hostMatches(stored: string | null | undefined, domain: string): boolean {
  if (!stored) return false;
  const raw = String(stored).trim().toLowerCase();
  if (!raw) return false;
  // Stored values are usually URLs but not always — fall back to treating it as a bare host.
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    host = raw.split("/")[0] ?? "";
  }
  return host === domain || host.endsWith(`.${domain}`);
}

export async function twentyCompanyByDomain(domain: string): Promise<TwentyCrmCompany | null> {
  const d = domain.trim().toLowerCase();
  if (!d) return null;
  const body = await twentyGet<{ data?: { companies?: any[] } }>(
    `/companies?filter=domainName.primaryLinkUrl[ilike]:${encodeURIComponent(`%${d}%`)}&limit=5`,
  );
  for (const c of body?.data?.companies ?? []) {
    const stored = c?.domainName?.primaryLinkUrl ?? c?.domainName ?? null;
    if (!hostMatches(stored, d)) continue;
    return {
      recordId: c?.id ?? "",
      name: typeof c?.name === "string" ? c.name : (c?.name?.text ?? ""),
      domain: stored,
      orgNumber: c?.orgNumber ?? null,
    };
  }
  return null;
}

export default defineTool({
  description:
    "Read the company linked to a CRM person (by the person's record id) — read-only HTTP " +
    "call to TWENTY_BASE_URL. Returns name, domain, org number — or a no-company note (a " +
    "real, expected outcome: the person may not exist, have no linked company, or point at " +
    "a company record that no longer exists). TwentyUnavailableError is thrown only on a " +
    "genuine transport/HTTP failure against Twenty.",
  inputSchema: z.object({ recordId: z.string() }),
  async execute({ recordId }): Promise<TwentyCrmCompany | TwentyCompanyNotFound> {
    return twentyCompanyForPerson(recordId);
  },
});
