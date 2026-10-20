// services/chief-of-staff/lib/person-sources.ts
// ADAPTER — maps chief-of-staff's concrete clients onto the vendor-neutral PersonSources interface
// (lib/person/gather.ts). All vendor shapes stop here; lib/person/ never sees a Gmail header,
// a Twenty record, or a Google Calendar event.
//
// The `PersonWiring` SHAPE and every source function's LOGIC — the
// crm/mail/meetings/transcripts/company fan-out and its per-source honesty rules — are
// described below. `eveSagaPersonWiring()` constructs the `PersonWiring` interface directly
// from the chief of staff's own already-built clients (identity-client, twenty tools,
// google.ts, notes-store), so no caller has to inject adapter functions.
//
// THE UNIFORM RULE FOR EVERY SOURCE BELOW: when
// a source cannot determine its answer, it must THROW. lib/person/gather.ts's attempt() turns a
// throw into {status:"failed"}, which renders as COULD NOT READ. Returning [] (or null) renders
// as "nothing found" — a claim about the WORLD. A source may only return [] when it genuinely
// looked and there was nothing there. An expired API key, a truncated calendar window, an empty
// identity registry, or a nameless/addressless candidate must never look like an empty world —
// they are gaps in OUR reading, not facts about the person being looked up.
import { getPool } from "@lares/agent-kit/db";
import { configuredOwnerId, listAliases } from "./identity-client.js";
import { googleClients } from "./google.js";
import type { MailMessage, CalendarEvent } from "./google.js";
import { searchNotes, readNote, storeRoot } from "@lares/agent-kit/notes-store";
import { twentyLookup as twentyLookupFn } from "../catalogue/twenty_lookup.js";
import {
  twentyCompanyForPerson as twentyCompanyForPersonFn,
  twentyCompanyByDomain as twentyCompanyByDomainFn,
} from "../catalogue/twenty_company_for_person.js";
import type { TwentyLookupResult, TwentyPersonLite } from "../catalogue/twenty_lookup.js";

import { SEARCH_WINDOW_DAYS } from "./person/types.js";
import { orgSearchTerms, rankOrgHits } from "./person/org.js";
import type { OrgFacts, OrgNote, OrgQuery, OrgStore } from "./person/org.js";
import type { Candidate, PersonQuery } from "./person/types.js";
import type { CompanyFacts, MailItem, MeetingItem, PersonSources, TranscriptItem } from "./person/gather.js";

export interface PersonWiring {
  myAddresses(): Promise<string[]>;
  /** chief-of-staff's `TwentyLookupResult` (catalogue/twenty_lookup.ts) has no `warnings` field,
   *  because `lib/twenty-client.ts`'s `twentyGet` never
   *  swallows a sub-query failure into a warning string; it throws `TwentyUnavailableError`
   *  directly. */
  twentyLookup(args: { query: string }): Promise<TwentyLookupResult>;
  /** Twenty's own person record carries only companyId, never a company name (TwentyPersonLite)
   *  this resolves the NAME via twenty_company_for_person's logic, for company() below. */
  twentyCompanyForPerson(recordId: string): Promise<string | null>;
  mailSearch(query: string, max: number): Promise<string[]>;
  mailRead(id: string): Promise<MailMessage | null>;
  /** Mirrors `googleClients().calendar().listEvents` exactly (lib/google.ts) — a flat array of
   *  already-normalised `{id, summary, start, end, attendees?}`. There is no server-side
   *  text/attendee query (unlike Gmail search's `from:/to:`), so `meetings` below fetches the
   *  whole window and filters by attendee itself. */
  listEvents(o: { timeMin: string; timeMax: string; max: number; calendarId?: string }): Promise<CalendarEvent[]>;
  vaultSearch(q: string): Promise<string[]>;
  vaultRead(path: string): Promise<string>;
  /** Atlas is a note store of exactly the same shape as the vault (a directory of
   *  markdown behind `searchNotes`/`storeRoot` in @lares/agent-kit), so it is wired here the same
   *  way `vaultSearch` is: as a search function, NOT by calling the vault search tool (`catalogue/agent-kit__vault_search.ts`).
   *  That tool is a model-facing hand; this is an internal read, and routing it through the tool
   *  would make the dossier depend on eve's tool plumbing to answer a question it can answer
   *  itself. A store that cannot be read THROWS (notes-store's StorePathNotConfiguredError /
   *  StoreUnhealthyError) — which is the point: an unmounted Atlas must never look like an Atlas
   *  with nothing in it. */
  atlasSearch(q: string): Promise<string[]>;
  /** the CRM company on a mail domain, or null when the CRM genuinely holds none. */
  crmCompanyByDomain(domain: string): Promise<{ name: string; domain: string | null; orgNumber: string | null } | null>;
}

/** The address inside "Per Hansen <per@partner.example>", lowercased. */
export function addressOf(header: string): string {
  const m = /<([^>]+)>/.exec(header);
  return (m?.[1] ?? header).trim().toLowerCase();
}

// The three window numbers live in lib/person/types.ts (SEARCH_WINDOW_DAYS) because the RENDER
// quotes them: an unstated window turns "no mail in 400 days" into "they have never written",
// and a second copy of the numbers here would let the sentence drift away from the search.
// They are still three separate numbers, not one: mail and calendar have different cost
// profiles. Gmail search returns MOST-RECENT-first and is capped by MAIL_MAX, so widening its
// window is cheap and safe. The calendar client (lib/google.ts's makeCalendarClient) has no
// pagination and orders ascending, so a wide window risks silently dropping the newest events
// instead — narrower on purpose.
const MAIL_WINDOW_DAYS = SEARCH_WINDOW_DAYS.mail;
const MAIL_MAX = 25;
const CALENDAR_WINDOW_DAYS = SEARCH_WINDOW_DAYS.calendarBack;
const MEETINGS_LOOKAHEAD_DAYS = SEARCH_WINDOW_DAYS.calendarAhead;
// lib/google.ts's makeCalendarClient clamps `max` to 250 internally — pass its ceiling
// directly rather than a smaller number that would just get silently topped up.
const MEETINGS_MAX = 250;
const TRANSCRIPT_MAX = 5;
const EXCERPT_CHARS = 400;

/**
 * how much of the note stores the organisation stage may hand back.
 *
 * Both caps are small on purpose. `searchNotes` falls back to a PARTIAL-match pass when no note
 * carries every token, and that pass returns up to 20 paths ranked by how many tokens matched —
 * for a two-token query like `atbridgeco.example` a single shared token ("example") is enough to qualify.
 * Uncapped, one weak term buries three real hits under seventeen coincidences, and the render's
 * whole promise is that every path it prints is worth opening.
 */
const ORG_STORES: readonly OrgStore[] = ["brain", "atlas"];
const ORG_HITS_PER_TERM = 3;
const ORG_HITS_PER_STORE = 4;

/** One TwentyPersonLite (catalogue/twenty_lookup.ts) → Candidate. `email` is
 *  singular+nullable on the real record — there is no `emails` array and no company NAME
 *  (only companyId; see twentyCompanyForPerson in PersonWiring, used by company() below).
 *  chief-of-staff's `mapPerson` always synthesises a non-empty `name` (falling back to the primary
 *  email, then `"(unnamed)"`), so the empty-name guard below is defensive, not reachable in
 *  practice— kept as the `crm()` "none carried a usable name" check. */
function asTwentyCandidate(p: TwentyPersonLite): Candidate[] {
  const name = p.name?.trim();
  if (!name) return [];
  return [{ source: "twenty", sourceId: p.id || name, displayName: name, emails: p.email ? [p.email] : [] }];
}

export function makePersonSources(w: PersonWiring): PersonSources {
  return {
    myAddresses: () => w.myAddresses(),

    crm: async (q: PersonQuery) => {
      // A plural `emails` query has no single search term. Twenty's lookup takes one, so this
      // becomes N calls, one per address, unioned by sourceId. A plain email/name query is
      // just the N=1 case of the same shape.
      const terms = q.emails && q.emails.length > 0 ? q.emails : [q.email ?? q.name ?? ""];
      // Partial tolerance for a multi-term merge query. `Promise.all` would let ONE term's transient Twenty
      // hiccup (e.g. address 1 of 2 on a job-change merge) sink the whole call even though
      // address 2 still resolves — losing the "a partial read that found someone despite one
      // degraded sub-query is still a find" behaviour. The `twentyLookup` wiring has no `warnings` field to inspect (`twentyGet` never
      // swallows a failure into a warning) — the equivalent signal here is simply
      // whether THIS term's call threw. `Promise.allSettled` catches each individually so the
      // remaining terms still run; only surface `failed` when every term either errored or
      // came back with nothing usable.
      const settled = await Promise.allSettled(terms.map((term) => w.twentyLookup({ query: term })));
      const errors = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      const results = settled
        .filter((r): r is PromiseFulfilledResult<TwentyLookupResult> => r.status === "fulfilled")
        .map((r) => r.value);
      const people = results.flatMap((r) => r.people ?? []);
      const bySourceId = new Map<string, Candidate>();
      for (const cand of people.flatMap(asTwentyCandidate)) {
        if (!bySourceId.has(cand.sourceId)) bySourceId.set(cand.sourceId, cand);
      }
      const candidates = [...bySourceId.values()];
      // Twenty DID find records here — asTwentyCandidate only drops one for lacking a usable
      // name. If every record it returned was dropped, that is OUR mapping failing to read
      // what Twenty found, not Twenty finding nobody. (See asTwentyCandidate's doc comment:
      // chief-of-staff's own mapper always synthesises a name, so this is effectively unreachable
      // today — kept so a future change to that mapper cannot silently regress into the old
      // failure mode.)
      if (people.length > 0 && candidates.length === 0) {
        throw new Error(`Twenty returned ${people.length} records but none carried a usable name`);
      }
      // Every term either errored or (for the ones that didn't) came back with nothing
      // usable — this is a genuine "could not read", not "looked and found nobody". If at
      // least one term succeeded with a real candidate, the errors on the others are dropped:
      // the partial read is still a find.
      if (candidates.length === 0 && errors.length > 0) {
        // The single-term case (still the common path — a plain email/name query) rethrows
        // the original error UNWRAPPED, so its message and type (e.g. `TwentyUnavailableError`)
        // reach gather.ts's attempt() exactly as they did before this fix. Only a genuine
        // multi-address fan-out needs to say which addresses were tried.
        if (errors.length === 1) throw errors[0]!.reason;
        const reason = errors.map((e) => (e.reason instanceof Error ? e.reason.message : String(e.reason))).join("; ");
        throw new Error(`Twenty lookup failed on ${errors.length} of ${terms.length} addresses: ${reason}`);
      }
      return candidates;
    },

    mail: async (person, mine) => {
      // Without `mine` there is no way to tell "the owner sent this" from "they did" — every
      // message would satisfy `!mineSet.has(...)`, so a degraded identity registry (gather.ts
      // passes mine:[] when its own source fails) would make every thread look like one the owner
      // owes a reply on, which is a much louder and more actionable wrong answer than silence.
      if (mine.length === 0) {
        throw new Error("cannot tell whose replies are whose: the identity registry returned no addresses for the owner");
      }
      const mineSet = new Set(mine.map((a) => a.toLowerCase()));
      const addrs = person.emails;
      // resolve.ts can deliberately resolve a candidate with no address at all (the first
      // overall when none have one) — reachable, not hypothetical. Per the uniform rule (top
      // of file): cannot search is a throw, never an empty result.
      if (addrs.length === 0) throw new Error("no email address on this person — cannot search mail");
      // One `from:x OR to:x` pair per address (a merged person can carry more than one), the
      // whole disjunction parenthesised before ANDing with the date window. Gmail's query
      // grammar has no implicit precedence rule documented for mixed OR/AND terms; left
      // unparenthesised, `from:a OR to:a newer_than:400d` risks binding as
      // `from:a OR (to:a newer_than:400d)`, silently dropping the date filter from the `from:`
      // half.
      const clause = addrs.map((a) => `from:${a} OR to:${a}`).join(" OR ");
      const ids = await w.mailSearch(`(${clause}) newer_than:${MAIL_WINDOW_DAYS}d`, MAIL_MAX);
      const msgs = (await Promise.all(ids.map((id) => w.mailRead(id)))).filter((m): m is MailMessage => m !== null);

      // Keep only the newest message per thread — the thread's current state is what says who
      // owes whom. Calendar notices are dropped: Google sends an RSVP FROM the attendee's real
      // address, so an "Accepted:" would otherwise read as them writing to the owner.
      const newest = new Map<string, MailMessage>();
      for (const m of msgs) {
        if (m.isCalendarNotice) continue;
        const prev = newest.get(m.threadId);
        if (!prev || Date.parse(m.sentAt) > Date.parse(prev.sentAt)) newest.set(m.threadId, m);
      }

      return [...newest.values()].map((m): MailItem => {
        const fromThem = !mineSet.has(addressOf(m.from));
        return { at: new Date(m.sentAt), threadId: m.threadId, subject: m.subject, fromThem, lastSpeakerIsThem: fromThem };
      });
    },

    meetings: async (person, _mine) => {
      const emails = new Set(person.emails.map((e) => e.toLowerCase()));
      // Same reachable addressless-candidate case as mail() above — a name-only Candidate
      // can't be pinned to an event, so this is "cannot search", not "searched, found none".
      if (emails.size === 0) throw new Error("no email address on this person — cannot search meetings");

      const now = new Date();
      const from = new Date(now.getTime() - CALENDAR_WINDOW_DAYS * 86_400_000);
      const to = new Date(now.getTime() + MEETINGS_LOOKAHEAD_DAYS * 86_400_000);
      const events = await w.listEvents({ timeMin: from.toISOString(), timeMax: to.toISOString(), max: MEETINGS_MAX });

      // lib/google.ts's calendar client orders ascending by startTime with NO pagination. A
      // full-length result does not mean "lots of meetings" — it means the window held MORE
      // than MEETINGS_MAX events and the newest (most relevant) ones were cut off the end. A
      // short list here would be silently untrustworthy, so it is a failure, not a result.
      if (events.length === MEETINGS_MAX) {
        throw new Error(`calendar returned the maximum ${MEETINGS_MAX} events for this window — the newest are missing, so the meeting history cannot be trusted`);
      }

      // The real Calendar client has no server-side attendee/text filter (unlike Gmail's
      // from:/to: search), so every event in the window comes back and THIS is the only place
      // "is this THEIR meeting" gets decided. Skipping it would leak every meeting the owner has
      // into every person's dossier.
      return events.flatMap((e): MeetingItem[] => {
        if (!e.attendees?.some((a) => emails.has(a.email.toLowerCase()))) return [];
        if (!e.start) return [];
        const at = new Date(e.start);
        return [{ at, eventId: e.id, title: e.summary || "(untitled)", upcoming: at.getTime() > now.getTime() }];
      });
    },

    transcripts: async (person) => {
      const paths = (await w.vaultSearch(person.displayName)).filter((p) => p.includes("/transcripts/")).slice(0, TRANSCRIPT_MAX);
      const items = await Promise.all(paths.map(async (path): Promise<TranscriptItem> => {
        const body = await w.vaultRead(path);
        const m = /(\d{4}-\d{2}-\d{2})/.exec(path);
        return {
          at: m ? new Date(m[1]!) : new Date(0),
          path,
          excerpt: body.slice(0, EXCERPT_CHARS).replace(/\s+/g, " ").trim(),
        };
      }));
      return items;
    },

    company: async (person): Promise<CompanyFacts | null> => {
      // Twenty's own record never carries a company NAME (only companyId — TwentyPersonLite),
      // so for a CRM-sourced candidate with no company yet, ask Twenty for it before giving up.
      // If that lookup itself throws, it propagates — attempt() in gather.ts handles it, same
      // as every other source here.
      let companyName = person.company;
      if (!companyName && person.source === "twenty") {
        companyName = (await w.twentyCompanyForPerson(person.sourceId)) ?? undefined;
      }
      // Genuinely nothing to look up: not Twenty-sourced (or Twenty confirmed no company on
      // file) and no company hint from any other source either — a real empty, not a skip.
      if (!companyName) return null;
      // The engine has no company-data source of its own; an outside tool the owner connected
      // can answer that. What this source reports is the company the sources already name.
      return { name: companyName, note: "named in the CRM or the other sources; no company-data lookup is built in" };
    },

    /**
     * the ORGANISATION behind the person: both note stores and the CRM, asked by
     * company NAME and mail DOMAIN rather than by human.
     *
     * The CRM is asked FIRST and BY DOMAIN — a CRM company matched on a name would just be
     * `company()` again, one source over; the domain join is what this stage adds. Its answer,
     * and `twentyCompanyForPerson`'s, then become SEARCH TERMS: the name is usually the only
     * word the notes actually use.
     *
     * Any store that cannot be READ throws straight out of here, so gather.ts's attempt() marks
     * the whole stage `failed` and the render says COULD NOT READ. That is the uniform rule at
     * the top of this file, and it matters most here: Atlas is a mounted volume, and an unmounted
     * one answering "nothing found" is exactly how the chief of staff would come to say, confidently, that
     * there is nothing on a company the owner has written about for a year.
     */
    organisation: async (org: OrgQuery): Promise<OrgFacts | null> => {
      // THE CRM GOES FIRST, and not for tidiness. Its answer changes the QUESTION: Twenty's
      // person record carries a companyId and no company name, so for a CRM-sourced person the
      // only place the name exists is one of these two calls. Asked afterwards,
      // `dana@atbridgeco.example` would search the stores for "atbridgeco.example" and "atbridgeco"
      // only, and every vault note that calls the company "Bridgeco" and never writes the domain
      // would be missed.
      const crmHit = org.domain ? await w.crmCompanyByDomain(org.domain) : null;
      const crmName = org.crmRecordId && !org.name ? await w.twentyCompanyForPerson(org.crmRecordId) : null;

      // What was ACTUALLY asked, after the CRM had its say — this is what `asked` echoes and
      // what the render labels the section with, so a "nothing found" is scoped to the real
      // question rather than to the guess that preceded it.
      const asked: OrgQuery = {
        ...(org.name ?? crmName ?? crmHit?.name ? { name: (org.name ?? crmName ?? crmHit?.name)!.trim() } : {}),
        ...(org.domain ? { domain: org.domain } : {}),
      };
      if (!asked.name && !asked.domain) return null;

      const terms = orgSearchTerms(asked);
      const notes: OrgNote[] = [];
      const seen = new Set<string>();
      for (const store of ORG_STORES) {
        const search = store === "brain" ? w.vaultSearch : w.atlasSearch;
        let perStore = 0;
        for (const term of terms) {
          if (perStore >= ORG_HITS_PER_STORE) break;
          // RANK, then cap. searchNotes' primary pass is walk order, not relevance — see
          // rankOrgHits. Slicing an unranked list is how the canonical company note loses its
          // place to whatever the filesystem reached first.
          const hits = rankOrgHits(await search(term), term);
          for (const path of hits.slice(0, ORG_HITS_PER_TERM)) {
            const key = `${store}:${path}`;
            if (seen.has(key)) continue;
            seen.add(key);
            notes.push({ store, path });
            if (++perStore >= ORG_HITS_PER_STORE) break;
          }
        }
      }

      if (notes.length === 0 && !crmHit) return null;
      return {
        asked,
        notes,
        ...(crmHit
          ? {
              crm: {
                name: crmHit.name,
                ...(crmHit.domain ? { domain: crmHit.domain } : {}),
                ...(crmHit.orgNumber ? { orgNumber: crmHit.orgNumber } : {}),
              },
            }
          : {}),
      };
    },
  };
}

// -----------------------------------------------------------------------------------------
// chief-of-staff's real PersonWiring — calls chief-of-staff's own clients.
// No I/O happens at construction (matches lib/google.ts's laziness discipline); everything
// below is a thin function reference until person_lookup.ts's `execute()` actually calls it.
// -----------------------------------------------------------------------------------------

/** Builds the `PersonWiring` that `person_lookup.ts` wires into `makePersonSources`, calling
 *  chief-of-staff's own already-built clients. Exported (not inlined into person_lookup.ts) so tests
 *  can exercise each wiring function directly against the real clients' own test doubles. */
export function eveSagaPersonWiring(): PersonWiring {
  return {
    myAddresses: () => listAliases(getPool(), configuredOwnerId(), "email"),

    twentyLookup: ({ query }) => twentyLookupFn(query),

    twentyCompanyForPerson: async (recordId) => {
      const result = await twentyCompanyForPersonFn(recordId);
      if ("ok" in result) return null;
      return result.name;
    },


    // mailSearch/mailRead resolve the Gmail client fresh on each call — cheap: googleClients()
    // itself does no I/O, and `.gmail()` caches nothing across calls by design (lib/google.ts).
    // `googleClients().gmail()`
    // with no account defaults to the primary (most-recently-updated) mailbox, which is the
    // same "the one mailbox this hand acts on" behaviour.
    mailSearch: async (query, max) => (await googleClients().gmail()).search(query, max),
    mailRead: async (id) => (await googleClients().gmail()).read(id),

    listEvents: async (o) => (await googleClients().calendar()).listEvents(o),

    vaultSearch: async (q) => searchNotes(q, storeRoot("brain")).hits,
    vaultRead: async (path) => readNote(path, storeRoot("brain")).content,

    // Atlas, wired exactly like the Brain above: same engine, same store shape, a
    // different root. `storeRoot` reads ATLAS_PATH at CALL time, so nothing is read here at
    // construction (matching the laziness discipline this whole function keeps).
    atlasSearch: async (q) => searchNotes(q, storeRoot("atlas")).hits,

    crmCompanyByDomain: (domain) => twentyCompanyByDomainFn(domain),
  };
}
