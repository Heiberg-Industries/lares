// services/chief-of-staff/lib/person/resolve.ts
// CORE — vendor-neutral.
// Ported verbatim from services/agent-runtime/lib/person/resolve.ts (Task 8) — logic unchanged.
//
// The whole of this file is one decision: when two humans might be meant, ASK.
// But ask only answerable questions.
//
// ORB-39 spent four fix rounds on identity logic, and every one of its defects had the
// same shape — a surface that quietly picked a plausible answer. A wrong merge here is
// worse than a wrong lookup, because it does not look wrong: two people's histories
// arrive as one confident narrative, and nothing in the output says a choice was made.
//
// When two same-name candidates carry different addresses, this file asks which one.
// But what if one carries an address and one does not? The question "is this Lars with
// lars@nomono.co, or Lars with no address on file?" is unanswerable—the addressless
// record is a summary or a forward reference, not an identity assertion. Making this
// case ambiguous would fire on most people who appear in both the CRM and Pulse (which
// returns summaries). A rule that asks unanswerable questions gets ignored, and then it
// protects nothing. So: answer, but disclose. The addressless hit is moved into `setAside`,
// not hidden.
import type { Candidate, PersonQuery } from "./types.js";

export type Resolution =
  | {
      kind: "resolved";
      person: Candidate;
      alsoSeenIn: string[];
      setAside: Candidate[];
      /**
       * Set when the name he typed is not the name on the record — "Lars" answered with
       * "Lars Eriksen". Present so the render can say so in one clause: the inference is
       * his to accept or correct, and an inference nobody is told about is a guess.
       */
      matchedLoosely?: { asked: string; matched: string };
    }
  | { kind: "ambiguous"; candidates: Candidate[]; question: string }
  | { kind: "unknown" };

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Every address a candidate carries, normalised. A candidate can carry more than one — a
 * pulse identity with two email rows, or (Task 10) a person merged from a plural `emails`
 * query — so "this candidate's address" is a SET, not just its first entry.
 *
 * Carry-forward from Task 2's review: the address-conflict check below used to compare only
 * `emails[0]`, which was harmless while every source emitted one address per candidate. It
 * is not harmless once a candidate can carry two: comparing first-elements would call two
 * same-name candidates "different people" whenever the address they actually share is not
 * each one's first in list order — a false AMBIGUOUS the file's own header warns against.
 */
function addressesOf(c: Candidate): Set<string> {
  return new Set(c.emails.map(norm));
}

/** Does `c` carry any address in `addrs`? The set-overlap test `addressesOf` exists for. */
function sharesAddress(addrs: Set<string>, c: Candidate): boolean {
  return c.emails.some((e) => addrs.has(norm(e)));
}

/**
 * Is one of these two names plausibly the other, written differently?
 *
 * Two rules, both of them mirroring how the SOURCES already matched to produce the candidate
 * in the first place — this function only recovers records the sources themselves considered
 * hits, it never reaches further than they did:
 *
 *   1. One string contains the other. "lars" ↔ "lars eriksen", "lars" ↔ "larsen" — this is
 *      Twenty's `ilike %x%` and Pulse's substring search, exactly.
 *   2. Every word of one is a word of the other. "lars eriksen" ↔ "lars m. eriksen" — a stored
 *      middle initial defeats rule 1 in BOTH directions, and a middle initial is the single
 *      most common reason a CRM record is not spelled the way a human types the name.
 *
 * Both are deliberately symmetric: he types more than the record holds about as often as he
 * types less. And both are only ever a FALLBACK — an exact match, where one exists, wins
 * before this function is consulted, and whatever this returns is disclosed as a loose match
 * rather than presented as the name he asked for.
 */
function looselyMatches(want: string, name: string): boolean {
  if (name.length === 0) return false;
  if (name.includes(want) || want.includes(name)) return true;
  const wantWords = want.split(/\s+/).filter(Boolean);
  const nameWords = new Set(name.split(/\s+/).filter(Boolean));
  if (wantWords.length === 0 || nameWords.size === 0) return false;
  if (wantWords.every((w) => nameWords.has(w))) return true;
  const wantSet = new Set(wantWords);
  return [...nameWords].every((w) => wantSet.has(w));
}

function describe(c: Candidate): string {
  const where = c.company ? ` (${c.company})` : "";
  return `${c.displayName}${where} — ${c.emails[0] ?? "no address on file"} [${c.source}]`;
}

/**
 * Resolve a query against every source's candidates.
 *
 * Order matters: an exact address is a fact, a name is a guess that happened to be unique.
 * An email query that matches nothing returns `unknown` rather than falling back to name
 * matching — the caller asked about an address, and answering about a different person who
 * shares a name is the merge this file exists to prevent.
 */
export function resolvePerson(query: PersonQuery, candidates: Candidate[]): Resolution {
  // He supplied the addresses, so the identity question is already answered — by him, with
  // knowledge the sources do not have. Union everything that matches into one person and
  // never return ambiguous: asking again would be asking him to repeat himself.
  if (query.emails && query.emails.length > 0) {
    const want = new Set(query.emails.map(norm));
    const hits = candidates.filter((c) => c.emails.some((e) => want.has(norm(e))));
    if (hits.length === 0) return { kind: "unknown" };
    const first = hits[0]!;
    // Union every matching candidate's addresses, keeping each one's ORIGINAL casing — every
    // sibling path in this file shows him the address as the source spelled it, not a
    // lowercased form. De-duplication still has to be case-insensitive, so it is keyed on
    // `norm(e)` while the value pushed is `e` itself; first occurrence wins.
    const seen = new Set<string>();
    const emails: string[] = [];
    for (const c of hits) {
      for (const e of c.emails) {
        const key = norm(e);
        if (seen.has(key)) continue;
        seen.add(key);
        emails.push(e);
      }
    }
    return {
      kind: "resolved",
      person: { ...first, emails },
      alsoSeenIn: [...new Set(hits.slice(1).map((c) => c.source))],
      setAside: [],
    };
  }

  if (query.email) {
    const want = norm(query.email);
    const hits = candidates.filter((c) => c.emails.some((e) => norm(e) === want));
    if (hits.length === 0) return { kind: "unknown" };
    const [first, ...rest] = hits;
    return { kind: "resolved", person: first!, alsoSeenIn: [...new Set(rest.map((c) => c.source))], setAside: [] };
  }

  if (query.name) {
    const want = norm(query.name);
    const exact = candidates.filter((c) => norm(c.displayName) === want);
    if (exact.length > 0) return resolveNameHits(exact, query.name);

    // NOTHING matched exactly — but the sources that produced these candidates do not
    // search exactly. Twenty searches `firstName ilike %x%` / `lastName ilike %x%`
    // (adapters/twenty-client.ts) and Pulse substring-matches (services/network). So "Lars"
    // comes back holding a real record called "Lars Eriksen", and an exact-only rule throws
    // it away and reports "no record in the CRM" on the very same screen as "crm: read OK".
    // That is not a near-miss: "what's the deal with Lars" is the canonical way this hand is
    // called, in both the persona and the tool description.
    //
    // So: fall back to the same looseness the sources themselves used (see looselyMatches)
    // and DISCLOSE it. Never guess silently; but never ask an unanswerable question either
    // (see the header): with exactly one person behind the loose hits, "did you mean Lars
    // Eriksen?" is a question whose answer he already gave by typing "Lars".
    if (want.length === 0) return { kind: "unknown" };
    const loose = candidates.filter((c) => looselyMatches(want, norm(c.displayName)));
    if (loose.length === 0) return { kind: "unknown" };

    // "How many loose matches" counts PEOPLE, not rows: the CRM and Pulse both holding
    // "Lars Eriksen" is one human found twice, and the exact path below already knows how to
    // merge or set aside those. Two DIFFERENT names both matching "Lars" is the real
    // ambiguity, and it is the one case where he has to choose.
    const distinctNames = [...new Set(loose.map((c) => norm(c.displayName)))];
    if (distinctNames.length > 1) {
      return {
        kind: "ambiguous",
        candidates: loose,
        question:
          `More than one ${query.name} — which one?\n` +
          loose.map((c) => `- ${describe(c)}`).join("\n"),
      };
    }

    // One person, reached loosely. Everything downstream — the addressless setAside rule, the
    // conflicting-address ambiguity — is the exact path's logic, unchanged; only the label the
    // render prints differs.
    const r = resolveNameHits(loose, loose[0]!.displayName);
    return r.kind === "resolved"
      ? { ...r, matchedLoosely: { asked: query.name, matched: r.person.displayName } }
      : r;
  }

  return { kind: "unknown" };
}

/**
 * Decide between candidates that all carry the SAME name — whether they were reached by an
 * exact match on what he typed or by the loose fallback above. Split out so the loose path
 * cannot quietly acquire different merge semantics from the exact one: there is one rule for
 * "these share a name, now what", and both callers run it.
 */
function resolveNameHits(hits: Candidate[], askedName: string): Resolution {
  // Separate addressed from addressless.
  const addressed = hits.filter((c) => c.emails.length > 0);

  // Resolve to the first addressed, or the first overall if none have addresses.
  const resolved = addressed.length > 0 ? addressed[0]! : hits[0]!;
  const resolvedAddrs = addressesOf(resolved);

  // Check if any other addressed candidate has NO address in common with resolved. Tested
  // as set overlap (see addressesOf above), not first-element equality, so a candidate
  // carrying more than one address is judged on all of them.
  if (addressed.length > 1 && addressed.some((c) => c !== resolved && !sharesAddress(resolvedAddrs, c))) {
    // At least one addressed candidate shares nothing with resolved: ambiguous.
    return {
      kind: "ambiguous",
      candidates: hits,
      question:
        `More than one ${askedName} — which one?\n` +
        hits.map((c) => `- ${describe(c)}`).join("\n"),
    };
  }

  // When the resolved person has no address at all, every other hit is setAside.
  // Otherwise, alsoSeenIn are sources that share an address with resolved, and setAside are the rest.
  let alsoSeenIn: string[];
  let setAside: Candidate[];

  if (resolvedAddrs.size === 0) {
    alsoSeenIn = [];
    setAside = hits.filter((c) => c !== resolved);
  } else {
    alsoSeenIn = hits
      .filter((c) => c !== resolved && sharesAddress(resolvedAddrs, c))
      .map((c) => c.source);
    setAside = hits.filter((c) => c !== resolved && !sharesAddress(resolvedAddrs, c));
  }

  return {
    kind: "resolved",
    person: resolved,
    alsoSeenIn: [...new Set(alsoSeenIn)],
    setAside,
  };
}
