// services/chief-of-staff/lib/person/gather.ts
// CORE — vendor-neutral. Every source is an injected function, so this whole file
// tests with no I/O and no mocking framework.
// Ported verbatim from services/agent-runtime/lib/person/gather.ts (Task 8) — logic unchanged.
import { contactAnchor, partitionByAnchor } from "./anchor.js";
import { resolvePerson, type Resolution } from "./resolve.js";
import { deriveOrgQuery } from "./org.js";
import type { OrgFacts, OrgQuery } from "./org.js";
import { NotApplicableError } from "./types.js";
import type { Candidate, DatedItem, EngagementEvent, PersonQuery, SourceResult } from "./types.js";

export interface MailItem extends DatedItem {
  threadId: string;
  subject: string;
  /** The most recent message in the thread came from THEM. */
  fromThem: boolean;
  /** Nobody has replied since. This is the "you owe them" signal. */
  lastSpeakerIsThem: boolean;
}

export interface MeetingItem extends DatedItem { eventId: string; title: string; upcoming: boolean }
export interface TranscriptItem extends DatedItem { path: string; excerpt: string }
export interface CompanyFacts { name: string; orgNumber?: string; note: string }

/** Every source the hand fans out over. All optional-failure: they may throw. */
export interface PersonSources {
  myAddresses(): Promise<string[]>;
  crm(query: PersonQuery): Promise<Candidate[]>;
  pulse(query: PersonQuery): Promise<Candidate[]>;
  mail(person: Candidate, mine: string[]): Promise<MailItem[]>;
  meetings(person: Candidate, mine: string[]): Promise<MeetingItem[]>;
  transcripts(person: Candidate): Promise<TranscriptItem[]>;
  company(person: Candidate): Promise<CompanyFacts | null>;
  /** ORB-166 — the ORGANISATION behind the lookup: the note stores and the CRM, asked by company
   *  name and mail domain rather than by human. Only ever called with a non-null `OrgQuery`;
   *  "there is no organisation to ask about" is decided in `deriveOrgQuery` and never reaches
   *  this function. */
  organisation(org: OrgQuery): Promise<OrgFacts | null>;
}

export interface PersonDossier {
  query: PersonQuery;
  resolution: Resolution;
  anchor: EngagementEvent | null;
  /** After the anchor — what he has not seen. */
  fresh: { mail: MailItem[]; meetings: MeetingItem[]; transcripts: TranscriptItem[] };
  /** Before the anchor — context, not news. */
  history: { mail: MailItem[]; meetings: MeetingItem[]; transcripts: TranscriptItem[] };
  /** Threads where they spoke last. The ORB-45 signal, surfaced here too. */
  owed: MailItem[];
  sources: {
    crm: SourceResult<Candidate[]>;
    pulse: SourceResult<Candidate[]>;
    mail: SourceResult<MailItem[]>;
    meetings: SourceResult<MeetingItem[]>;
    transcripts: SourceResult<TranscriptItem[]>;
    company: SourceResult<CompanyFacts>;
    organisation: SourceResult<OrgFacts>;
    identity: SourceResult<string[]>;
  };
}

/**
 * Run one source and classify the outcome into exactly four states.
 *
 * This function is the single place `failed` and `not-applicable` can be produced, and it
 * can never produce `empty` from a throw. That is the whole point: the distinction is
 * structural, not a convention someone has to remember at each call site.
 *
 * The split between the two throw outcomes is deliberately narrow: ONLY a NotApplicableError
 * means "this source cannot answer a question of this shape". Everything else — a DB error, a
 * 401, a timeout, a bug — is `failed`, because "we could not ask this time" and "this can
 * never be asked" call for opposite things from the reader.
 */
async function attempt<T>(
  source: string,
  run: () => Promise<T>,
  isEmpty: (v: T) => boolean,
): Promise<SourceResult<T>> {
  try {
    const data = await run();
    return isEmpty(data) ? { status: "empty", source } : { status: "found", source, data };
  } catch (e) {
    if (e instanceof NotApplicableError) return { status: "not-applicable", source, reason: e.message };
    return { status: "failed", source, reason: e instanceof Error ? e.message : String(e) };
  }
}

const emptyArray = (v: unknown[]) => v.length === 0;
const listOf = <T>(r: SourceResult<T[]>): T[] => (r.status === "found" ? r.data : []);

/**
 * Same as attempt(), for a source whose "nothing" is `null` rather than an empty array
 * (only `company` is shaped this way). Still goes through attempt() — this does not add a
 * second place `failed` can be produced, it only re-types the result.
 *
 * The cast is sound, not a leap of faith: attempt() has already turned every `null` into
 * `status: "empty"` before this line runs, so the "found" branch can never actually hold
 * null. TypeScript just can't see that a runtime predicate (`v === null`) proves it, so the
 * cast states the invariant attempt() already enforces.
 */
async function attemptNullable<T>(source: string, run: () => Promise<T | null>): Promise<SourceResult<T>> {
  const r = await attempt<T | null>(source, run, (v) => v === null);
  return r as SourceResult<T>;
}

/**
 * What this lookup is FOR — which decides what it is worth asking (ORB-166 review fix).
 *
 * `organisation: false` means the caller renders no ORGANISATION section, so the stage is not
 * started at all. The only such caller today is the outbound email drafter, whose `bounded`
 * render already drops that section — so every triage tick was paying for up to six synchronous
 * full-note-store walks and a Twenty call per inbound message, times up to ten messages, to
 * produce text nobody ever read. On a single-threaded event loop that is not merely waste: it is
 * latency borrowed from whatever else the box is doing (a Telegram webhook, the Slack scan's
 * in-flight fetches).
 *
 * NOT the same thing as an empty result. The dossier still carries the source, marked
 * `not-applicable` with a reason, because "we did not ask" and "we asked and there is nothing"
 * are different facts and this file's whole discipline is never to collapse them.
 */
export interface GatherOptions {
  /** Default true. False skips the organisation stage entirely — no I/O, no result. */
  organisation?: boolean;
}

export async function gatherPerson(
  query: PersonQuery,
  sources: PersonSources,
  opts: GatherOptions = {},
): Promise<PersonDossier> {
  const identity = await attempt("identity", () => sources.myAddresses(), emptyArray);
  const mine = listOf(identity);

  const [crm, pulse] = await Promise.all([
    attempt("crm", () => sources.crm(query), emptyArray),
    attempt("pulse", () => sources.pulse(query), emptyArray),
  ]);

  const resolution = resolvePerson(query, [...listOf(crm), ...listOf(pulse)]);

  const nothing = <T>(source: string): SourceResult<T> => ({ status: "empty", source });
  const blank = {
    fresh: { mail: [], meetings: [], transcripts: [] },
    history: { mail: [], meetings: [], transcripts: [] },
    owed: [],
  };

  // ORB-166 — the ORGANISATION stage starts HERE, above the resolved-only fan-out, because the
  // shape it exists for is precisely the one that never reaches it: a first-contact address
  // resolves to UNKNOWN, and the domain inside it is at that moment the only thing anyone knows.
  // Derived from a resolved candidate only, an intro call with a stranger at a vendor he already
  // self-hosts would stay unanswered — which is the bug this ticket was filed about.
  //
  // AMBIGUOUS is the one resolution that skips it: that branch renders a question and nothing
  // else, so the I/O would buy output nobody ever reads.
  //
  // NOT ASKED AT ALL is checked first (review fix): `opts.organisation === false` says the caller
  // renders no organisation section, and starting the stage anyway would buy nothing but blocked
  // event-loop time. See `GatherOptions`.
  const organisationP: Promise<SourceResult<OrgFacts>> =
    opts.organisation === false
      ? Promise.resolve<SourceResult<OrgFacts>>({
          status: "not-applicable",
          source: "organisation",
          reason: "not consulted on this lookup — the caller renders no organisation section, so nothing was asked",
        })
    : resolution.kind === "ambiguous"
      // NOT `empty`. "We asked and there is nothing" is a claim about the world, and nobody
      // asked: an organisation question needs one person to be about, and this branch has two.
      ? Promise.resolve<SourceResult<OrgFacts>>({
          status: "not-applicable",
          source: "organisation",
          reason: "the person is ambiguous — an organisation cannot be looked up without deciding which of them it is",
        })
      : attemptNullable("organisation", () => {
          const orgQuery = deriveOrgQuery(
            query,
            resolution.kind === "resolved" ? resolution.person : undefined,
            [...listOf(crm), ...listOf(pulse)],
          );
          // No company on file and no work domain: there is no organisation-shaped question to
          // put. That is a fact about the QUESTION, not about the world, so it goes through
          // attempt() as not-applicable and the source is never called at all. A `gmail.com`
          // "company" is noise, and rendering its empty result as "company unknown" would be a
          // claim nobody established.
          if (!orgQuery) {
            throw new NotApplicableError(
              "no organisation to look up: no company on file for them anywhere, and no work mail " +
              "domain to look one up by (a personal mailbox is not a company)",
            );
          }
          return sources.organisation(orgQuery);
        });

  // Ambiguous or unknown: STOP. Fanning out on a guessed person is the merge Task 2 refuses
  // to make, arriving one layer later and dressed as a complete answer.
  if (resolution.kind !== "resolved") {
    return {
      query, resolution, anchor: null, ...blank,
      sources: {
        crm, pulse, identity,
        mail: nothing("mail"), meetings: nothing("meetings"),
        transcripts: nothing("transcripts"), company: nothing("company"),
        organisation: await organisationP,
      },
    };
  }

  const person = resolution.person;
  const [mail, meetings, transcripts, company, organisation] = await Promise.all([
    attempt("mail", () => sources.mail(person, mine), emptyArray),
    attempt("meetings", () => sources.meetings(person, mine), emptyArray),
    attempt("transcripts", () => sources.transcripts(person), emptyArray),
    attemptNullable("company", () => sources.company(person)),
    organisationP,
  ]);

  const mailItems = listOf(mail);
  const meetingItems = listOf(meetings);
  const transcriptItems = listOf(transcripts);

  // Engagements = what BENDIK did. Their inbound is excluded on purpose — see types.ts.
  const engagements: EngagementEvent[] = [
    ...mailItems.filter((m) => !m.fromThem).map((m): EngagementEvent => ({ at: m.at, kind: "sent-email", ref: m.threadId })),
    ...meetingItems.filter((m) => !m.upcoming).map((m): EngagementEvent => ({ at: m.at, kind: "meeting", ref: m.eventId })),
    ...transcriptItems.map((t): EngagementEvent => ({ at: t.at, kind: "transcript", ref: t.path })),
  ];
  const anchor = contactAnchor(engagements);
  const cut = anchor?.at ?? null;

  const m = partitionByAnchor(mailItems, cut);
  const mt = partitionByAnchor(meetingItems, cut);
  const tr = partitionByAnchor(transcriptItems, cut);

  return {
    query,
    resolution,
    anchor,
    fresh: { mail: m.fresh, meetings: mt.fresh, transcripts: tr.fresh },
    history: { mail: m.history, meetings: mt.history, transcripts: tr.history },
    owed: mailItems.filter((i) => i.lastSpeakerIsThem),
    sources: { crm, pulse, mail, meetings, transcripts, company, organisation, identity },
  };
}
