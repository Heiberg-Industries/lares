/**
 * The paged `listPeople` capability — the ONE place allowed to call it directly.
 *
 * Task 5 deliberately did not build a `listPeople` tool ("the full-contact-dump guard"):
 * handing the model a raw dump of every CRM person is exactly the surface Task 13's
 * `commercial_who_to_contact` tool exists to gate — it pulls the full universe here, then
 * filters/scores/ranks it down to a handful of names before anything reaches a model.
 *
 * Ported from `services/agent-runtime/lib/adapters/twenty-client.ts`'s `listPeople` (the
 * per-page REST call and field mapping) and the paging loop (the 2000-record cap), collapsed
 * into one function since eve-saga has no integration-registry layer — this file is that
 * wiring's replacement.
 */
import { twentyGet } from "./twenty-client.js";

/** Full person shape the commercial radar scores on — carries signal fields `listPeople`'s
 *  lighter siblings (`twenty_lookup`, `twenty_get_person`) don't need. */
export interface TwentyPerson {
  id: string;
  name: string;
  email: string | null;
  companyId: string | null;
  /** Always null — company name is not included in the people list payload; callers join
   *  via companyId (or a per-survivor `getCompanyForPerson` call) if needed. */
  companyName: string | null;
  /** Relationship strength level as written by crm-intelligence (e.g. "GOOD", "STRONG") —
   *  or null if unscored. */
  strength: string | null;
  /** ISO datetime of most recent interaction as written by crm-intelligence — or null if
   *  never contacted. */
  lastContactedAt: string | null;
  /** The Heiberg brand this person is associated with — direct field on the Twenty record. */
  brand: string | null;
  /** Outreach state machine value (e.g. "never_contacted", "email_sent") — null if not set. */
  commState: string | null;
  /** True if the person has been flagged do-not-contact. */
  doNotContact: boolean;
  /** createdBy.source — "EMAIL" / "CALENDAR" / "API" / "MANUAL" / "IMPORT" / … — or null if
   *  unrecorded. Used by the junk-contact classifier. */
  source: string | null;
  /** True when linkedinLink.primaryLinkUrl is present and non-empty — a curation signal. */
  hasLinkedin: boolean;
  /** True when phones.primaryPhoneNumber is present and non-empty — a curation signal. */
  hasPhone: boolean;
}

interface ListPeoplePage {
  data?: { people?: Record<string, unknown>[] };
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

function mapPerson(r: Record<string, any>): TwentyPerson {
  const fn = r?.name?.firstName ?? "";
  const ln = r?.name?.lastName ?? "";
  return {
    id: r?.id ?? "",
    name: `${fn} ${ln}`.trim() || (r?.emails?.primaryEmail ?? "(unnamed)"),
    email: r?.emails?.primaryEmail ?? null,
    companyId: r?.companyId ?? null,
    companyName: null,
    strength: r?.strength ?? null,
    lastContactedAt: r?.lastContactedAt ?? null,
    brand: r?.brand ?? null,
    commState: r?.commState ?? null,
    doNotContact: r?.doNotContact === true,
    source: r?.createdBy?.source ?? null,
    hasLinkedin: !!r?.linkedinLink?.primaryLinkUrl,
    hasPhone: !!r?.phones?.primaryPhoneNumber,
  };
}

/**
 * List CRM people with the commercial radar's signal fields, paging with Twenty's
 * `starting_after` cursor convention until the cursor runs out or `cap` is reached (default
 * 2000, matching the old registry's hard fan-out cap). A genuine Twenty failure
 * (`TwentyUnavailableError`) on any page propagates — it is not swallowed into a partial
 * result, per ORB-51.
 */
export async function listPeopleCapped(opts: { cap?: number; pageSize?: number } = {}): Promise<TwentyPerson[]> {
  const cap = opts.cap ?? 2000;
  const pageSize = opts.pageSize ?? 60;
  const all: TwentyPerson[] = [];
  let cursor: string | undefined;
  for (;;) {
    const path = cursor
      ? `/people?limit=${pageSize}&starting_after=${encodeURIComponent(cursor)}`
      : `/people?limit=${pageSize}`;
    const page = await twentyGet<ListPeoplePage>(path);
    const records = page?.data?.people ?? [];
    for (const r of records) all.push(mapPerson(r));
    const nextCursor = page?.pageInfo?.hasNextPage && page?.pageInfo?.endCursor ? page.pageInfo.endCursor : null;
    if (!nextCursor || all.length >= cap) break;
    cursor = nextCursor;
  }
  return all.slice(0, cap);
}
