// services/chief-of-staff/lib/person/org.ts
// CORE — vendor-neutral. No I/O, no SDKs: this file only decides WHAT organisation question to
// put, never asks it. The adapter (lib/person-sources.ts) does the asking.
//
// ORB-166. person-360 knew people and not companies, so a 16:30 intro call with a stranger at
// Cyrus — the bridge his own dev agent runs on, which he self-hosts — came out of the brief as
// "first contact, no prior history — worth a quick look at Cyrus". The person half was right.
// The company half was never asked.
import { PERSONAL_DOMAINS } from "@lares/junk";
import type { Candidate, PersonQuery } from "./types.js";

/** Which note store a hit came out of. Rendered beside every path, because "read the note" is
 *  only actionable if you know which store to read it from. */
export type OrgStore = "brain" | "atlas";

/** The organisation-shaped question, derived once in `deriveOrgQuery` and then carried around
 *  so a "nothing found" can be scoped to exactly what was asked. At least one field is set —
 *  `deriveOrgQuery` returns null rather than an empty query. */
export interface OrgQuery {
  name?: string;
  domain?: string;
  /**
   * A CRM person record whose linked company NAME can still be resolved.
   *
   * Twenty's person record carries a `companyId` and no company name (`TwentyPersonLite`), so a
   * CRM-only person yields no `name` here however hard derivation squints at them — and if their
   * address is a personal mailbox, no `domain` either. Without this field that person would be
   * reported as having "no company on file" when the CRM has one on file and one call away. The
   * adapter resolves it; core only says that it CAN be resolved.
   */
  crmRecordId?: string;
}

/** One note the stores hold on this organisation. A PATH, deliberately — not an excerpt and not
 *  a summary. A path is an invitation to read; a summary would be a fact the dossier never
 *  established. */
export interface OrgNote {
  store: OrgStore;
  path: string;
}

export interface OrgFacts {
  /** Echoed back so the render can say what "nothing else" is scoped to. */
  asked: OrgQuery;
  notes: OrgNote[];
  /** The CRM company on this mail domain, when there is one. */
  crm?: { name: string; domain?: string; orgNumber?: string };
}

/**
 * THE list. One place, one test (tests/person-org.test.ts).
 *
 * A personal mailbox has no organisation behind it, and treating `gmail.com` as a company is
 * not a harmless extra search: it puts a term into the note stores that matches half of
 * everything, and then renders the noise as what we know about the person's employer. Worse,
 * an empty result for it would read as "we looked into their company and found nothing" — an
 * absence about a company that does not exist.
 *
 * Norwegian consumer ISP mailboxes are in here for a local reason: Bendik's correspondents
 * genuinely use them, and `online.no` (Telenor's consumer mail) would otherwise be looked up as
 * if it were the telco. Only domains that are consumer mailboxes are listed — `telenor.no` is a
 * company domain and must stay searchable.
 */
const FREE_MAIL_DOMAINS_HERE = [
  // Google
  "gmail.com", "googlemail.com",
  // Microsoft
  "hotmail.com", "hotmail.co.uk", "hotmail.no", "hotmail.se", "hotmail.fr", "hotmail.de",
  "outlook.com", "outlook.no", "outlook.dk", "outlook.se",
  "live.com", "live.no", "live.se", "live.dk", "live.co.uk",
  "msn.com", "passport.com",
  // Apple
  "icloud.com", "me.com", "mac.com",
  // Yahoo
  "yahoo.com", "yahoo.no", "yahoo.se", "yahoo.dk", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "ymail.com", "rocketmail.com",
  // Proton
  "proton.me", "protonmail.com", "protonmail.ch", "pm.me",
  // Other consumer webmail in common use here
  "aol.com", "gmx.com", "gmx.net", "gmx.de", "mail.com", "zoho.com",
  "fastmail.com", "fastmail.fm", "hey.com", "tutanota.com", "tuta.io",
  "mailbox.org", "posteo.de", "web.de", "yandex.com", "yandex.ru",
  // Norwegian consumer ISP mailboxes (the ISP's SUBSCRIBER mail, not the company's own domain)
  "online.no", "start.no", "frisurf.no", "broadpark.no", "getmail.no", "c2i.net",
  "lyse.net", "chello.no", "nextgentel.no", "sf-nett.no", "trollnet.no",
];

/**
 * The list above UNIONED with `@lares/junk`'s `PERSONAL_DOMAINS`, which is the same predicate —
 * "this mailbox belongs to a person, not an organisation" — reached from the other direction
 * (`classifySender`, used by lib/email-triage.ts). Two hand-maintained copies of one idea drift:
 * adding `hey.com` to one would leave the other confidently treating it as a company. Unioned
 * rather than replaced, because this list is the wider of the two — it carries the Norwegian
 * consumer ISP mailboxes and the country variants that sender-classification never needed.
 *
 * `@lares/junk` is a pure set-and-regex module: no I/O, no SDK, nothing read at import time, so
 * this stays a core file that tests without a fixture.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  ...FREE_MAIL_DOMAINS_HERE,
  ...PERSONAL_DOMAINS,
]);

/** Whether this domain is a personal mailbox rather than an organisation. Tolerant about the
 *  shape it arrives in (`" @GMail.CoM "`) because the callers vary. */
export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.trim().toLowerCase().replace(/^@/, ""));
}

/** The address inside "Connor Turland <connor@atcyrus.com>", lowercased. Duplicated from the
 *  adapter's own `addressOf` on purpose: core does not import the adapter, and this is four
 *  lines of parsing rather than a dependency edge pointing the wrong way. */
function addressOf(raw: string): string {
  const m = /<([^>]+)>/.exec(raw);
  return (m?.[1] ?? raw).trim().toLowerCase();
}

/**
 * The organisation's mail domain, or nothing at all.
 *
 * "Nothing at all" covers two cases that both mean the same thing HERE — this is not an address,
 * and this is a personal address — because both answer the only question being asked: is there a
 * company domain to look up? A free-mail address is not a failure to parse and must never be
 * reported as one.
 */
export function workDomainOf(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const addr = addressOf(email);
  const at = addr.lastIndexOf("@");
  if (at < 1) return undefined;
  const domain = addr.slice(at + 1).trim();
  if (!domain.includes(".")) return undefined;
  if (isFreeMailDomain(domain)) return undefined;
  return domain;
}

/**
 * What organisation, if any, sits behind this lookup — from the company a source already
 * vouched for and from the mail domain, in that order of confidence.
 *
 * Returns null when there is neither, and that null is the whole free-mail rule: gather.ts turns
 * it into a `not-applicable` source and NEVER calls the organisation source at all. Not asked is
 * different from asked-and-empty, and only one of the two may reach the model as a finding.
 *
 * `candidates` (not just the resolved person) supplies the name because the CRM's own person
 * record carries a companyId and no company NAME — the name arrives via the relationship graph,
 * on a different candidate for the same human.
 */
export function deriveOrgQuery(
  query: PersonQuery,
  person?: Candidate,
  candidates: readonly Candidate[] = [],
): OrgQuery | null {
  const name = [person, ...candidates]
    .map((c) => c?.company?.trim())
    .find((c): c is string => !!c);

  const addresses = [...(person?.emails ?? []), ...(query.emails ?? []), ...(query.email ? [query.email] : [])];
  const domain = addresses.map(workDomainOf).find((d): d is string => !!d);

  // Only when no source already handed us a name — this costs the adapter one CRM call, and a
  // name we already have is worth more than the same name fetched again. Mirrors `company()`'s
  // own condition in lib/person-sources.ts: Twenty-sourced, so there is a record id to ask on.
  const crmRecordId = !name && person?.source === "twenty" ? person.sourceId : undefined;

  if (!name && !domain && !crmRecordId) return null;
  return {
    ...(name ? { name } : {}),
    ...(domain ? { domain } : {}),
    ...(crmRecordId ? { crmRecordId } : {}),
  };
}

/**
 * The search terms, in the order the stores are asked.
 *
 * The bare LABEL ("atcyrus" out of "atcyrus.com") is the load-bearing third term, not padding.
 * `searchNotes` (@lares/agent-kit) tokenises on non-word characters and requires EVERY token,
 * falling back to any-token hits ranked by count. So "atcyrus.com" becomes ["atcyrus", "com"],
 * and when no note carries both, the fallback ranks twenty notes that merely contain "com" —
 * every note with a URL in it — above nothing. The label asks the question the domain was
 * actually standing in for.
 *
 * Tokens under two characters are dropped by that same tokeniser, so a label too short to
 * survive it is left out here rather than sent to match everything.
 */
export function orgSearchTerms(org: OrgQuery): string[] {
  const terms: string[] = [];
  const push = (t: string | undefined) => {
    const v = t?.trim();
    if (!v) return;
    if (terms.some((existing) => existing.toLowerCase() === v.toLowerCase())) return;
    terms.push(v);
  };

  push(org.name);
  push(org.domain);
  const label = org.domain?.split(".")[0];
  if (label && label.length >= 2) push(label);

  return terms;
}

/**
 * Rank a store's hits for one term, BEFORE anything slices them.
 *
 * `searchNotes` (@lares/agent-kit) returns its primary all-tokens-matched pass in WALK ORDER —
 * whatever `readdirSync` yields, depth-first. Only its ≤20 partial-match fallback is sorted, and
 * that sort is by token count, not by relevance. So an unranked `.slice(0, 3)` over twelve notes
 * mentioning "Nomono" prints whichever three the filesystem happened to reach first — an
 * `_inbox/clips/…` article and two daily notes — and `companies/nomono.md` never appears at all.
 * Saga then describes the relationship from a clipped article. A cap needs a known ordering, or
 * it silently drops the valuable half and looks like a complete answer.
 *
 * The order, most to least canonical:
 *   1. the filename IS the term (`nomono.md` for "Nomono")
 *   2. more of the term's tokens appear in the FILENAME — a note titled for the company beats one
 *      that merely mentions it
 *   3. more of the term's tokens appear anywhere in the PATH — a `companies/nomono/…` folder
 *   4. shallower, then shorter, then alphabetical — deterministic, and canonical notes live
 *      nearer the root than clippings and dailies do
 *
 * Content is deliberately not scored: the wiring hands back paths, and reading every hit to rank
 * it would multiply the store I/O this stage already costs. Tokens follow notes-store's own rule
 * (unicode word chunks, under two characters dropped) so the ranking cannot disagree with the
 * search that produced the list.
 */
export function rankOrgHits(paths: readonly string[], term: string): string[] {
  const tokens = term
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  const wanted = term.trim().toLowerCase();

  const key = (path: string): [number, number, number, number, number, string] => {
    const lower = path.toLowerCase();
    const base = (lower.split("/").pop() ?? lower).replace(/\.md$/, "");
    const exact = base === wanted || tokens.some((t) => base === t) ? 0 : 1;
    const inBase = tokens.filter((t) => base.includes(t)).length;
    const inPath = tokens.filter((t) => lower.includes(t)).length;
    return [exact, -inBase, -inPath, lower.split("/").length, lower.length, lower];
  };

  return [...paths].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i]! < kb[i]!) return -1;
      if (ka[i]! > kb[i]!) return 1;
    }
    return 0;
  });
}
