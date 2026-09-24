// The ONLY file in this service that knows Twenty's HTTP shape. Lives under
// adapters/ so the vendor-neutrality test exempts it (spec §11), exactly like
// notion-client.ts does for Notion.
//
// **It can only read.** The factory returns a single function, `listPeople`, and
// there is deliberately no create, no update and no delete anywhere in this file.
// "The People projection never writes back to the source" (spec §8.3) is therefore
// a property of the code's SHAPE rather than a rule the engine has to remember —
// there is no method here that a future caller could reach for.
//
// Why Twenty is the read, when the constraint says "network + Twenty":
// `services/network` is a Mac-local SQLite database (`~/.lares/network.db`,
// "Runs on the Mac only; never deployed") and this service runs in a container on
// the agent box, so its file is not reachable here — and its vault projection
// (`wiki/people/*.md`) deliberately carries no email address, so it cannot be
// keyed by one anyway. What the network layer knows about a person it already
// PUSHES INTO Twenty on its own schedule (`services/network/lib/twenty-sync.ts`
// writes pulse band, last personal contact and the LinkedIn URL onto the Twenty
// record). So one email-keyed read of Twenty is a read of both stores, and adding
// a second, unreachable one would buy nothing.
//
// Conventions mirrored from services/network/lib/twenty.ts, which mirrored
// services/crm-intelligence/lib/twenty.ts (ADR-0007: this family collapses into
// `@lares/twenty-client` the next time crm-intelligence is touched — that is not
// this task, and reaching across service boundaries for one GET would couple two
// deployables that ship independently):
//   - Auth:       `Authorization: Bearer <apiKey>`
//   - REST base:  `{baseUrl}/rest`
//   - People:     GET /rest/people?limit=60[&starting_after=<cursor>]
//                 → { data: { people: [...] }, pageInfo: { hasNextPage, endCursor } }
//   - 429:        honour `Retry-After` (seconds), retry once, then throw

import type { SourcePerson } from "../people-sync.js";

export interface TwentyPeopleOptions {
  /** Base URL of the Twenty instance, e.g. `https://crm.example.com`. No default — a
   *  wrong-by-default host would read someone else's CRM, and this file must carry no
   *  deployment's own hostname (tests/neutrality.test.ts). */
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * The label that lands in the People row's `Source` property. A constant rather
 * than config: it names the system this adapter speaks to, and this adapter speaks
 * to exactly one. The ENGINE never sees it except as a string handed over on each
 * person, so no vendor name reaches the vendor-neutral core.
 */
export const TWENTY_SOURCE = "Twenty";

/** Page size Twenty's REST list endpoints are documented and used with elsewhere. */
const PAGE_SIZE = 60;
const MAX_RETRY_WAIT_MS = 30_000;

interface RawPerson {
  id?: string;
  name?: { firstName?: string | null; lastName?: string | null } | null;
  emails?: { primaryEmail?: string | null; additionalEmails?: string[] | null } | null;
}

interface PeoplePage {
  data?: { people?: RawPerson[] };
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

/** Trimmed and lower-cased — the one form every comparison downstream is made on. */
function normaliseEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Maps one Twenty record to the engine's `SourcePerson`. Nothing is derived: the
 * name is the two name fields joined, the emails are the addresses Twenty holds.
 * A record with no primary address yields `email: ""`, which the engine treats as
 * "not projectable" — it never falls back to an additional address, because which
 * of several addresses is a person's identity is Twenty's call, not this file's.
 */
export function toSourcePerson(raw: RawPerson): SourcePerson {
  const first = (raw.name?.firstName ?? "").trim();
  const last = (raw.name?.lastName ?? "").trim();
  const primary = normaliseEmail(raw.emails?.primaryEmail);
  const others = (raw.emails?.additionalEmails ?? [])
    .map(normaliseEmail)
    .filter((email) => email !== "" && email !== primary);
  return {
    sourceId: String(raw.id ?? ""),
    source: TWENTY_SOURCE,
    name: `${first} ${last}`.trim(),
    email: primary,
    // De-duplicated so the engine's alias index cannot be handed the same address
    // twice and report a conflict with itself.
    otherEmails: [...new Set(others)],
  };
}

export function makeTwentyPeopleSource(opts: TwentyPeopleOptions) {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const restBase = `${opts.baseUrl.replace(/\/$/, "")}/rest`;

  async function request(url: string): Promise<PeoplePage> {
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const res = await doFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: "application/json" },
      });
      if (res.ok) return (await res.json()) as PeoplePage;
      if (res.status === 429 && attempt === 0) {
        const seconds = Number(res.headers.get("retry-after") ?? "0");
        const waitMs = Number.isFinite(seconds) && seconds > 0
          ? Math.min(seconds * 1000, MAX_RETRY_WAIT_MS)
          : 0;
        if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      const body = await res.text().catch(() => "");
      throw new Error(`twenty GET ${url} failed: ${res.status} ${body.slice(0, 200)}`);
    }
    throw new Error("unreachable: the retry loop always returns or throws");
  }

  /**
   * Every person Twenty holds, in one cursor-paged read.
   *
   * All of them, not a filtered subset: which people the projection actually
   * CREATES is decided by the engine from the meetings that name them, and doing
   * that selection here would put a policy decision behind an HTTP boundary where
   * no test can see it.
   */
  async function listPeople(): Promise<SourcePerson[]> {
    const people: SourcePerson[] = [];
    let cursor: string | null = null;
    for (;;) {
      const url: string = cursor === null
        ? `${restBase}/people?limit=${PAGE_SIZE}`
        : `${restBase}/people?limit=${PAGE_SIZE}&starting_after=${encodeURIComponent(cursor)}`;
      const page: PeoplePage = await request(url);
      const records: RawPerson[] = page.data?.people ?? [];
      for (const raw of records) people.push(toSourcePerson(raw));
      const info = page.pageInfo;
      if (records.length === 0 || !info?.hasNextPage || !info.endCursor) break;
      cursor = info.endCursor;
    }
    return people;
  }

  return { listPeople };
}
