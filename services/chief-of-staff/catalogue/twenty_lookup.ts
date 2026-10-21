// Look up a CRM person or company by name/email. Read-only HTTP against TWENTY_BASE_URL.
//
// A Twenty instance may split names inconsistently across
// firstName/lastName, so every name token is matched against BOTH fields, with vowels and
// accented letters as a one-character wildcard; results are de-duplicated by id, ranked by
// how many tokens match the folded name/email, and cut to ten (`buildLookupQueries`).
//
// Additional emails: the lookup matches `emails.primaryEmail` only. It leaves additional
// emails out until `tests/live/twenty-lookup.live.mts` shows Twenty's REST filter supports them.
//
// A sub-query failure is never folded into a `warnings` field: a genuine "Twenty is down" would
// look, to the model, just like a slow partial search. None of these sub-queries can legitimately
// 404 (an empty result set from a list endpoint is just a 200 with zero rows), so the only thing a
// sub-query can throw is a real `TwentyUnavailableError`, and that must propagate, not hide
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

const MAX_NAME_TOKENS = 4;
const MAX_SUB_QUERIES = 10;
const MAX_PEOPLE = 10;
const PER_QUERY_LIMIT = 20;

/** Lowercase, strip accents; letters that do not decompose are spelled out. */
export function foldName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss");
}

/** Name tokens worth searching: letters only, two or more of them, at most four. */
function nameTokens(term: string): string[] {
  const out: string[] = [];
  for (const raw of term.normalize("NFC").split(/[^\p{L}]+/u)) {
    const tok = raw.toLowerCase();
    if (tok.length >= 2 && !out.includes(tok)) out.push(tok);
    if (out.length === MAX_NAME_TOKENS) break;
  }
  return out;
}

/** Consonants a-z stay; every vowel and every other letter becomes the one-character
 *  wildcard `_`, so "gluck" and "glück" both give `gl_ck`. */
function accentPattern(token: string): string {
  return [...token].map((ch) => (/[b-df-hj-np-tv-xz]/.test(ch) ? ch : "_")).join("");
}

/** The original, narrow builder: first token on firstName, last token on lastName, literal
 *  ilike, limit 5. Note linking needs "exactly one person", so it must not use the wider
 *  accent-tolerant queries below. */
export function buildStrictPersonQueries(term: string): LookupQuery[] {
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

/** Pure: turn a free-text term into the REST sub-queries to try (at most ten). */
export function buildLookupQueries(term: string): LookupQuery[] {
  const t = term.trim();
  if (!t) return [];
  const enc = (s: string) => encodeURIComponent(s);
  if (t.includes("@")) {
    const local = t.slice(0, t.indexOf("@"));
    const queries: LookupQuery[] = [
      { kind: "people-email", path: `/people?filter=emails.primaryEmail[eq]:${enc(t)}&limit=5` },
    ];
    if (local) {
      queries.push({
        kind: "people-email",
        path: `/people?filter=emails.primaryEmail[ilike]:${enc(`${local}@%`)}&limit=${PER_QUERY_LIMIT}`,
      });
    }
    return queries;
  }
  const toks = nameTokens(t);
  const q = (field: string, pat: string): LookupQuery => ({
    kind: "people-name",
    path: `/people?filter=name.${field}[ilike]:${enc(`%${pat}%`)}&limit=${PER_QUERY_LIMIT}`,
  });
  // Literal spellings first, so an exact spelling is never crowded out by the wildcard ones.
  const names: LookupQuery[] = [];
  for (const tok of toks) names.push(q("firstName", tok), q("lastName", tok));
  // Then accent-tolerant patterns, for tokens of 4+ letters whose pattern differs, longest first.
  const wild = toks
    .filter((tok) => tok.length >= 4 && accentPattern(tok) !== tok)
    .sort((a, b) => b.length - a.length);
  for (const tok of wild) names.push(q("firstName", accentPattern(tok)), q("lastName", accentPattern(tok)));
  return [
    ...names.slice(0, MAX_SUB_QUERIES - 1),
    { kind: "company-name", path: `/companies?filter=name[ilike]:${enc(`%${t}%`)}&limit=${PER_QUERY_LIMIT}` },
  ];
}

/** How many of the term's tokens appear in this person's folded name or email. */
function matchScore(tokens: string[], p: TwentyPersonLite): number {
  const hay = foldName(`${p.name} ${p.email ?? ""}`);
  return tokens.filter((tok) => hay.includes(tok)).length;
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

/** Shared with `lib/person-sources.ts` (person_lookup's `crm` source) so neither
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
  const tokens = t.includes("@")
    ? [foldName(t), foldName(t.slice(0, t.indexOf("@")))].filter(Boolean)
    : nameTokens(t).map(foldName);
  out.people = out.people
    .map((p, i) => ({ p, i, score: matchScore(tokens, p) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, MAX_PEOPLE)
    .map((x) => x.p);
  return out;
}

export default defineTool({
  description:
    "Look up a CRM record — read-only HTTP call to TWENTY_BASE_URL. Matches people by " +
    "ANY name token (first or last name, extra or misspelt middle names are fine), " +
    "tolerates accents (Müller finds Muller), or by email address / the part before the @, " +
    "and companies by name substring. Returns at most ten deduplicated candidates (id, " +
    "name, email/domain), best match first. An empty result is a " +
    "real answer (no matching records); TwentyUnavailableError is thrown only on a genuine " +
    "transport/HTTP failure against Twenty.",
  inputSchema: z.object({ name: z.string() }),
  async execute({ name }) {
    return twentyLookup(name);
  },
});
