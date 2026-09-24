/**
 * Thin Twenty REST client for the network service.
 *
 * Third thin Twenty client in the portfolio (orakel adapter → crm-intelligence → this one).
 * Per ADR 0007: extract to `@lares/twenty-client` when next touching crm-intelligence.
 * Do NOT import from crm-intelligence/lib/twenty.ts — cross-service imports are forbidden
 * by convention; this is a deliberate reimplementation of the same thin layer.
 *
 * Conventions mirrored from services/crm-intelligence/lib/twenty.ts:
 *   - Auth: `Authorization: Bearer <apiKey>`
 *   - 429: read `Retry-After` header (seconds → ms), wait, retry ONCE, then throw
 *   - Other non-2xx: throw Error with status code + first ~200 chars of body
 *   - Pagination: `GET /rest/people?limit=60&starting_after=<endCursor>` cursor style
 *                 Response: `{ data: { people: [] }, pageInfo: { hasNextPage, endCursor } }`
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TwentyPerson = {
  id: string;
  name: { firstName: string; lastName: string };
  emails: { primaryEmail: string | null; additionalEmails: string[] | null };
  linkedinLink: { primaryLinkUrl: string | null } | null;
  companyId: string | null;
  // crm-intelligence-owned, read-only for us:
  strength: string | null;
  lastContactedAt: string | null;
  // ours (provisioned in Task 6):
  pulse: string | null;
  lastPersonalContact: string | null;
};

export type TwentyOpportunity = {
  id: string;
  name: string;
  stage: string;
  companyId: string | null;
  pointOfContactId: string | null;
};

import type { CleanupPerson } from "./twenty-cleanup.js";

export interface TwentyClient {
  listPeople(): Promise<TwentyPerson[]>;
  /** Lighter people fetch carrying the fields the junk classifier needs (createdBy.source, phone). */
  listPeopleForCleanup(): Promise<CleanupPerson[]>;
  /** Person ids that are the target of a note / task (kept out of junk deletion). */
  listNoteTargetPersonIds(): Promise<string[]>;
  listTaskTargetPersonIds(): Promise<string[]>;
  deletePerson(id: string): Promise<void>;
  updatePerson(
    id: string,
    fields: Partial<Record<"pulse" | "lastPersonalContact", string | null>> & {
      linkedinLink?: { primaryLinkUrl: string };
    },
  ): Promise<void>;
  createPerson(input: {
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    linkedinUrl?: string;
    brand: string;
    companyId?: string;
  }): Promise<string>;
  findCompanyByName(name: string): Promise<{ id: string; name: string } | null>;
  listOpportunities(): Promise<TwentyOpportunity[]>;
  /** Null when the company can't be fetched (deleted, 404) — a digest section must not kill the run. */
  getCompanyName(id: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_RETRY_WAIT_MS = 30_000;

type RawPersonPayload = {
  id?: string;
  name?: { firstName?: string | null; lastName?: string | null } | null;
  emails?: { primaryEmail?: string | null; additionalEmails?: string[] | null } | null;
  linkedinLink?: { primaryLinkUrl?: string | null } | null;
  companyId?: string | null;
  strength?: string | null;
  lastContactedAt?: string | null;
  pulse?: string | null;
  lastPersonalContact?: string | null;
};

function mapRawPerson(r: RawPersonPayload): TwentyPerson {
  return {
    id: r.id ?? "",
    name: {
      firstName: r.name?.firstName ?? "",
      lastName: r.name?.lastName ?? "",
    },
    emails: {
      primaryEmail: r.emails?.primaryEmail ?? null,
      additionalEmails: r.emails?.additionalEmails ?? null,
    },
    linkedinLink: r.linkedinLink
      ? { primaryLinkUrl: r.linkedinLink.primaryLinkUrl ?? null }
      : null,
    companyId: r.companyId ?? null,
    strength: r.strength ?? null,
    lastContactedAt: r.lastContactedAt ?? null,
    pulse: r.pulse ?? null,
    lastPersonalContact: r.lastPersonalContact ?? null,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTwentyClient(baseUrl: string, apiKey: string): TwentyClient {
  const restBase = `${baseUrl.replace(/\/$/, "")}/rest`;

  async function request<T>(
    url: string,
    init: RequestInit,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    };

    // First attempt + one 429-retry
    for (let attempt = 0; attempt <= 1; attempt++) {
      const res = await fetch(url, { ...init, headers });

      if (res.ok) return (await res.json()) as T;

      if (res.status === 429 && attempt === 0) {
        const retryAfterRaw = res.headers.get("retry-after");
        const retryAfterSec = retryAfterRaw !== null ? Number(retryAfterRaw) : 0;
        const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, MAX_RETRY_WAIT_MS)
          : 0;
        if (waitMs > 0) await new Promise<void>((r) => setTimeout(r, waitMs));
        continue;
      }

      const bodyText = await res.text().catch(() => "");
      const snippet = bodyText.slice(0, 200);
      throw new Error(
        `Twenty ${init.method ?? "GET"} ${url} failed: ${res.status} ${snippet}`,
      );
    }

    throw new Error("unreachable: retry loop always returns or throws");
  }

  // noteTargets / taskTargets are join records: { personId, noteId|taskId, ... }.
  async function collectPersonIds(entity: "noteTargets" | "taskTargets"): Promise<string[]> {
    type Row = { personId?: string | null };
    type Page = { data?: Record<string, Row[]>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
    const ids: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const url: string = cursor
        ? `${restBase}/${entity}?limit=60&starting_after=${encodeURIComponent(cursor)}`
        : `${restBase}/${entity}?limit=60`;
      const body: Page = await request<Page>(url, { method: "GET" });
      const records: Row[] = body?.data?.[entity] ?? [];
      for (const r of records) if (r.personId) ids.push(r.personId);
      const pageInfo = body?.pageInfo;
      if (records.length === 0 || !pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      cursor = pageInfo.endCursor;
    }
    return ids;
  }

  return {
    async listPeople(): Promise<TwentyPerson[]> {
      const people: TwentyPerson[] = [];
      let cursor: string | null = null;

      for (;;) {
        const url: string = cursor
          ? `${restBase}/people?limit=60&starting_after=${encodeURIComponent(cursor)}`
          : `${restBase}/people?limit=60`;

        type PeoplePage = {
          data?: { people?: RawPersonPayload[] };
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
        const body: PeoplePage = await request<PeoplePage>(url, { method: "GET" });

        const records: RawPersonPayload[] = body?.data?.people ?? [];
        for (const r of records) people.push(mapRawPerson(r));

        const pageInfo: PeoplePage["pageInfo"] = body?.pageInfo;
        if (records.length === 0 || !pageInfo?.hasNextPage || !pageInfo.endCursor) break;
        cursor = pageInfo.endCursor;
      }

      return people;
    },

    async listPeopleForCleanup(): Promise<CleanupPerson[]> {
      type RawCleanup = {
        id?: string;
        name?: { firstName?: string | null; lastName?: string | null } | null;
        emails?: { primaryEmail?: string | null } | null;
        phones?: { primaryPhoneNumber?: string | null } | null;
        linkedinLink?: { primaryLinkUrl?: string | null } | null;
        pulse?: string | null;
        createdBy?: { source?: string | null } | null;
      };
      type Page = { data?: { people?: RawCleanup[] }; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
      const out: CleanupPerson[] = [];
      let cursor: string | null = null;
      for (;;) {
        const url: string = cursor
          ? `${restBase}/people?limit=60&starting_after=${encodeURIComponent(cursor)}`
          : `${restBase}/people?limit=60`;
        const body: Page = await request<Page>(url, { method: "GET" });
        const records: RawCleanup[] = body?.data?.people ?? [];
        for (const r of records) {
          out.push({
            id: r.id ?? "",
            firstName: r.name?.firstName ?? "",
            lastName: r.name?.lastName ?? "",
            primaryEmail: r.emails?.primaryEmail ?? null,
            source: r.createdBy?.source ?? null,
            hasLinkedin: !!r.linkedinLink?.primaryLinkUrl,
            hasPhone: !!r.phones?.primaryPhoneNumber,
            hasPulse: !!r.pulse,
          });
        }
        const pageInfo = body?.pageInfo;
        if (records.length === 0 || !pageInfo?.hasNextPage || !pageInfo.endCursor) break;
        cursor = pageInfo.endCursor;
      }
      return out;
    },

    async listNoteTargetPersonIds(): Promise<string[]> {
      return collectPersonIds("noteTargets");
    },

    async listTaskTargetPersonIds(): Promise<string[]> {
      return collectPersonIds("taskTargets");
    },

    async deletePerson(id): Promise<void> {
      await request<unknown>(`${restBase}/people/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    async updatePerson(id, fields): Promise<void> {
      await request<unknown>(`${restBase}/people/${id}`, {
        method: "PATCH",
        body: JSON.stringify(fields),
      });
    },

    async createPerson(input): Promise<string> {
      const body: Record<string, unknown> = {
        name: { firstName: input.firstName, lastName: input.lastName },
        brand: input.brand,
      };
      if (input.email) body["emails"] = { primaryEmail: input.email };
      if (input.phone) body["phones"] = { primaryPhoneNumber: input.phone };
      if (input.linkedinUrl) body["linkedinLink"] = { primaryLinkUrl: input.linkedinUrl };
      if (input.companyId) body["companyId"] = input.companyId;

      // Twenty's create-response wrapper key is unverified across versions
      // (may be "createPerson", "person", or a raw record with id).
      // Tolerant extractor: find the first wrapped object value that has a string id.
      // Shape will be confirmed against the live instance in Task 9.
      const res = await request<{ data?: Record<string, unknown> }>(
        `${restBase}/people`,
        { method: "POST", body: JSON.stringify(body) },
      );

      const data = res?.data;
      let createdId: string | undefined;
      if (data && typeof data === "object") {
        for (const v of Object.values(data)) {
          if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") {
            createdId = (v as { id: string }).id;
            break;
          }
        }
      }

      if (!createdId) throw new Error("Twenty createPerson: no id in response");
      return createdId;
    },

    async findCompanyByName(name): Promise<{ id: string; name: string } | null> {
      const url = `${restBase}/companies?filter=name[eq]:${encodeURIComponent(name)}&limit=1`;
      const body = await request<{
        data?: { companies?: { id?: string; name?: { text?: string } | string }[] };
      }>(url, { method: "GET" });

      const companies = body?.data?.companies ?? [];
      if (companies.length === 0) return null;

      const first = companies[0]!;
      const companyName =
        typeof first.name === "string"
          ? first.name
          : (first.name?.text ?? "");

      return { id: first.id ?? "", name: companyName };
    },

    async listOpportunities(): Promise<TwentyOpportunity[]> {
      type RawOpp = { id?: string; name?: string | null; stage?: string | null; companyId?: string | null; pointOfContactId?: string | null };
      type OppPage = {
        data?: { opportunities?: RawOpp[] };
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
      const opps: TwentyOpportunity[] = [];
      let cursor: string | null = null;
      for (;;) {
        const url: string = cursor
          ? `${restBase}/opportunities?limit=60&starting_after=${encodeURIComponent(cursor)}`
          : `${restBase}/opportunities?limit=60`;
        const body: OppPage = await request<OppPage>(url, { method: "GET" });
        const records: RawOpp[] = body?.data?.opportunities ?? [];
        for (const r of records) {
          opps.push({ id: r.id ?? "", name: r.name ?? "", stage: r.stage ?? "", companyId: r.companyId ?? null, pointOfContactId: r.pointOfContactId ?? null });
        }
        const pageInfo: OppPage["pageInfo"] = body?.pageInfo;
        if (records.length === 0 || !pageInfo?.hasNextPage || !pageInfo.endCursor) break;
        cursor = pageInfo.endCursor;
      }
      return opps;
    },

    async getCompanyName(id): Promise<string | null> {
      try {
        const body = await request<{ data?: { company?: { name?: { text?: string } | string } } }>(
          `${restBase}/companies/${encodeURIComponent(id)}`,
          { method: "GET" },
        );
        const name = body?.data?.company?.name;
        const text = typeof name === "string" ? name : (name?.text ?? "");
        return text || null;
      } catch {
        return null;
      }
    },
  };
}
