// Look up a CRM person or company by name/email. Read-only HTTP against TWENTY_BASE_URL.
//
// Ported from `services/agent-runtime/lib/adapters/twenty-client.ts`'s `lookup` +
// `buildLookupQueries` (this Twenty instance splits names inconsistently across
// firstName/lastName, so the first token is matched against firstName and the last token
// against lastName; results are de-duplicated by id).
//
// ORB-51 deviation from the old client: the old `lookup` caught every sub-query failure and
// folded it into a `warnings` string array — so a genuine "Twenty is down" looked, to the
// model, just like a slow partial search. None of these sub-queries can legitimately 404 (an
// empty result set from a list endpoint is just a 200 with zero rows), so the only thing a
// sub-query can throw is a real `TwentyUnavailableError` — and that must propagate, not hide
// in a field the model may never read.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { twentyGet } from "../lib/twenty-client.js";

export interface TwentyPersonLite {
  id: string;
  name: string;
  email: string | null;
  companyId: string | null;
}
export interface TwentyCompanyLite {
  id: string;
  name: string;
}
export interface TwentyLookupResult {
  people: TwentyPersonLite[];
  companies: TwentyCompanyLite[];
}
export interface LookupQuery {
  kind: "people-email" | "people-name" | "company-name";
  path: string;
}

/** Pure: turn a free-text term into the REST sub-queries to try. */
export function buildLookupQueries(term: string): LookupQuery[] {
  const t = term.trim();
  if (!t) return [];
  const enc = (s: string) => encodeURIComponent(s);
  if (t.includes("@")) {
    return [{ kind: "people-email", path: `/people?filter=emails.primaryEmail[eq]:${enc(t)}&limit=5` }];
  }
  const tokens = t.split(/\s+/);
  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  return [
    { kind: "people-name", path: `/people?filter=name.firstName[ilike]:${enc(`%${first}%`)}&limit=5` },
    { kind: "people-name", path: `/people?filter=name.lastName[ilike]:${enc(`%${last}%`)}&limit=5` },
    { kind: "company-name", path: `/companies?filter=name[ilike]:${enc(`%${t}%`)}&limit=5` },
  ];
}

function mapPerson(r: any): TwentyPersonLite {
  const fn = r?.name?.firstName ?? "";
  const ln = r?.name?.lastName ?? "";
  return {
    id: r?.id ?? "",
    name: `${fn} ${ln}`.trim() || (r?.emails?.primaryEmail ?? "(unnamed)"),
    email: r?.emails?.primaryEmail ?? null,
    companyId: r?.companyId ?? null,
  };
}

function mapCompany(r: any): TwentyCompanyLite {
  const name = typeof r?.name === "string" ? r.name : (r?.name?.text ?? "");
  return { id: r?.id ?? "", name };
}

/** Shared with `lib/person-sources.ts` (person_lookup's `crm`/`pulse` fan-out) so neither
 *  re-implements this fetch loop. */
export async function twentyLookup(term: string): Promise<TwentyLookupResult> {
  const out: TwentyLookupResult = { people: [], companies: [] };
  const t = term.trim();
  if (!t) return out;
  const seenPeople = new Set<string>();
  const seenCompanies = new Set<string>();
  for (const q of buildLookupQueries(t)) {
    const body = await twentyGet<{ data?: Record<string, any[]> }>(q.path);
    if (q.kind === "company-name") {
      for (const c of body?.data?.companies ?? []) {
        const m = mapCompany(c);
        if (m.id && !seenCompanies.has(m.id)) {
          seenCompanies.add(m.id);
          out.companies.push(m);
        }
      }
    } else {
      for (const p of body?.data?.people ?? []) {
        const m = mapPerson(p);
        if (m.id && !seenPeople.has(m.id)) {
          seenPeople.add(m.id);
          out.people.push(m);
        }
      }
    }
  }
  return out;
}

export default defineTool({
  description:
    "Look up a CRM record — read-only HTTP call to TWENTY_BASE_URL. Matches people by " +
    "first/last name token or exact email, and companies by name substring. Returns " +
    "deduplicated lightweight candidates (id, name, email/domain). An empty result is a " +
    "real answer (no matching records); TwentyUnavailableError is thrown only on a genuine " +
    "transport/HTTP failure against Twenty.",
  inputSchema: z.object({ name: z.string() }),
  async execute({ name }) {
    return twentyLookup(name);
  },
});
