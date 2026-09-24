// T7 (Phase 4, ORB-39): the People projection, and the Meetings→People relation.
//
// Vendor-neutral and pure in exactly the sense run.ts, transcript-sync.ts and
// notion-born-sync.ts are: every side effect arrives as an injected dep, every
// person and every meeting is contained, the ordering is deterministic (sorted),
// and dry-run produces the full plan with zero writes.
//
// FOUR things this engine must not get wrong. Each is a decision, and each is the
// decision that keeps this from becoming the thing spec §8.3 exists to prevent —
// a FOURTH contact store, drifting quietly away from the three Bendik already has
// (Twenty CRM, services/network, the Brain vault).
//
//   1. **Nothing about a person originates here.** Every projected field is a
//      value the source system holds verbatim: the name it spells, the address it
//      keys on, its own record id. There is no scoring, no ranking, no promotion,
//      no enrichment and no company lookup. Deciding a person is a commercial
//      contact happens in Twenty, and this pass has no opinion about it.
//
//   2. **Unmatched means blank-and-flagged, never inferred** (spec §8). An
//      attendee this pass cannot resolve to a source person contributes NO link
//      and is named in the `People Unmatched` flag beside the relation. No
//      placeholder person is created to satisfy a relation, and nothing is ever
//      derived from a display name, a transcript body, an email domain or a
//      calendar title — `attendeeEmails` reads ONLY the `<addresses>` the
//      attendee pass itself wrote. A wrong address on a contact record is worse
//      than a blank one, and the two are indistinguishable once written.
//
//   3. **The projection is SELECTED by the meetings, not by the CRM.** A People
//      row is created only for a source person some Meetings row's `Attendees`
//      actually names. Mirroring the whole CRM into Notion would be the
//      fourth-store mistake in its purest form: thousands of rows nobody asked
//      for, every one of them a copy that can go stale. Existing rows are kept
//      current whether or not a meeting names them — that is what "read-mostly
//      projection" means — but nothing new appears without a meeting behind it.
//
//   4. **Read-mostly: it creates and updates, and it never deletes.** A People row
//      the source no longer recognises is left EXACTLY as it is and counted as
//      `unsourced`. Three reasons, any one of which is sufficient: the row may
//      have been made by hand for someone who is deliberately not in the CRM; a
//      partial source read and a genuine removal are indistinguishable from here;
//      and the relation that points at it is real history. Retiring a person is a
//      human decision made in Notion, not a side effect of an hourly job.
//
// It also writes NOTHING to the state database, and needs no schema of its own.
// The Notion People rows ARE the state: `Source ID` and `Email` are the two
// identities the next tick re-reads. That is deliberate — a local table mirroring
// what Notion already holds would be a second place for the same fact to be wrong.

/**
 * One person as a SOURCE system holds them. A structural type declared here
 * rather than imported from the adapter, for the same reason attendees.ts
 * declares its own `MeetingRow`: this file may not import from adapters/
 * (neutrality.test.ts), and the adapter's row is assignable to this one, so the
 * composition root hands it over with no mapping layer in between.
 */
export interface SourcePerson {
  /** The source system's own record id — stable across a change of address. */
  sourceId: string;
  /** Human-readable label for that system. The adapter supplies it; no vendor name lives in this file. */
  source: string;
  /** Display name as the source spells it. "" when the source holds none. */
  name: string;
  /** Primary address, already trimmed and lower-cased by the adapter. "" when there is none. */
  email: string;
  /**
   * Every OTHER address the source holds. Match-only, never projected: they let
   * an attendee who wrote from an alias resolve to the right person, which is
   * still email identity and not an inference. Which address is a person's
   * identity is the source's call, so only `email` is ever written to Notion.
   */
  otherEmails: string[];
}

/** One Meetings row as this pass reads it. */
export interface PeopleMeetingRow {
  pageId: string;
  title: string;
  /** `Attendees` rich text as the attendee pass wrote it: `Name <email>, …`. */
  attendees: string;
  /** The `People` relation Notion currently holds — page ids. */
  people: string[];
  /** Notion withheld part of the relation (>25 links). See the refusal below. */
  peopleTruncated: boolean;
  /** The `People Unmatched` flag Notion currently holds. */
  peopleUnmatched: string;
}

/** One People row as Notion currently holds it. */
export interface PeopleRow {
  pageId: string;
  name: string;
  /** `Email`, lower-cased by the adapter. "" when the row carries none. */
  email: string;
  /** `Source` select. "" on a row a human made by hand. */
  source: string;
  /** `Source ID` rich text. "" on a row a human made by hand. */
  sourceId: string;
}

/** The four properties this pass writes on a People row. */
export interface PersonProps {
  name: string;
  email: string;
  source: string;
  sourceId: string;
}

export interface PeopleSyncOptions {
  dryRun: boolean;
  /**
   * The owner's own address(es) — `NotionSyncConfig.selfEmails`. Excluded from the
   * attendee set entirely, because "who was this meeting with" never means the
   * person whose calendar it is: Bendik is on every meeting, he is deliberately
   * not a CRM record (`selfContactId` is excluded from network's Twenty matcher),
   * and leaving him in would flag 100% of meetings unresolved and make the flag
   * worthless. `formatAttendees` already treats him specially for the same reason.
   */
  selfEmails: readonly string[];
}

export interface PeopleSyncDeps {
  /** Every person the source system holds (adapters/twenty-people.ts). */
  listSourcePeople: () => Promise<SourcePerson[]>;
  queryPeople: () => Promise<PeopleRow[]>;
  queryMeetings: () => Promise<PeopleMeetingRow[]>;
  createPerson: (props: PersonProps) => Promise<{ pageId: string }>;
  /** Partial by contract — only the fields that actually changed are sent. */
  updatePerson: (pageId: string, props: Partial<PersonProps>) => Promise<void>;
  /** The relation and its flag, in ONE patch — see the adapter for why they travel together. */
  updateMeetingPeople: (
    pageId: string,
    value: { people: string[]; unmatched: string },
  ) => Promise<void>;
  /**
   * Best-effort human ping — the existing signal-spine path (adapters/
   * signal-notify.ts), or a console line when it is unconfigured. The SAME
   * surface pull/apply/transcripts already use for "a human must look at this",
   * never a new one.
   *
   * Used for exactly the two things this pass does that a human cannot undo from
   * Notion: a link added to a meeting that had already settled, and a hand-made
   * row the source renamed. Repairs here are asymmetric — a hand-ADDED link
   * sticks, a hand-REMOVED one comes back within the hour — so the one signal
   * guarding the irreversible direction has to leave the container. A console.log
   * in an unattended hourly job is not a report.
   *
   * The message carries the meeting and the address because the spine dedupes on
   * a 24h fingerprint over the message text: distinct cases must read distinctly
   * or the second one is swallowed.
   */
  notify: (message: string) => Promise<void>;
}

/** A source person this pass deliberately did nothing about, and why. */
export interface PersonSkip {
  sourceId: string;
  name: string;
  reason: string;
}

/**
 * One address more than one record claims. Settled deterministically — the
 * existing binding wins, because it is the older evidence — and REPORTED, because
 * which record the address really belongs to is a question only a human can
 * answer, in the source.
 */
export interface ContestedAddress {
  email: string;
  /** The People row the address stays bound to. */
  boundTo: string;
  /** The source record that binding belongs to. */
  boundBy: string;
  /** Source records that also claimed it and were refused. */
  alsoClaimedBy: string[];
}

/**
 * A hand-made People row the source adopted, whose displayed NAME changed as a
 * result — so every meeting already linked to it now shows a different human.
 */
export interface Relabelled {
  pageId: string;
  from: string;
  to: string;
  sourceId: string;
}

/** A meeting this pass deliberately did not touch, and why. */
export interface MeetingSkip {
  pageId: string;
  title: string;
  reason: string;
}

export interface PeopleSyncResult {
  /** People the source returned. */
  sourcePeople: number;
  /** People rows Notion held when the pass started. */
  peopleRows: number;
  meetingsScanned: number;
  created: number;
  updated: number;
  /** Source people whose People row already matched, field for field. */
  unchanged: number;
  /**
   * Source people with no People row and no meeting naming them. The bulk of a
   * real CRM lands here every tick, which is the point — see decision 3.
   */
  notNeeded: number;
  /**
   * Source people the source holds no address for. COUNTED, never listed: an
   * address-less contact is the commonest thing in a CRM, and one log line each
   * would bury the skips that need a human. They cannot be projected (there is no
   * key) and cannot be matched (an attendee is an address), so there is nothing
   * to decide about them.
   */
  noEmail: number;
  /** People rows the source does not recognise. Left untouched — decision 4. */
  unsourced: number;
  /** One email held by more than one People row. Reported; the lowest page id is used. */
  duplicates: Array<{ email: string; pageIds: string[] }>;
  /**
   * One address claimed by more than one source record — primary or alias, one
   * rule for both (round 2, F6). The binding is never taken from the row that
   * already holds it; the losing claim is reported instead.
   */
  contestedAddresses: ContestedAddress[];
  /**
   * Hand-made rows the source adopted and RENAMED. Adoption is the designed
   * feature (it is why a hand-made row exists — pre-create the row so the meeting
   * links, then add the person to the CRM), and the key does not move, so the
   * binding stays honest. What changes is the LABEL a historical meeting shows,
   * which is the same harm class as `lateLinks` and gets the same treatment: act,
   * and make sure a human hears about it.
   */
  relabelled: Relabelled[];
  /** Source people refused because acting would have written over someone else's row. */
  skipped: PersonSkip[];
  relationsUpdated: number;
  relationsUnchanged: number;
  /** Attendee addresses across all meetings that resolved to no person. */
  unresolved: number;
  /** Meetings carrying at least one unresolved attendee. */
  meetingsFlagged: number;
  meetingsSkipped: MeetingSkip[];
  /**
   * Links added to a meeting whose relation was ALREADY non-empty — i.e. a
   * settled meeting whose set of people grew.
   *
   * Reported because it is the one remaining way a person can join a meeting they
   * did not attend: an address that this pass has never bound to anybody, which
   * the source later assigns to someone. That is indistinguishable from the
   * desirable case (the attendee was simply not in the CRM yet), so the pass acts
   * — and says so, rather than growing a historical record in silence.
   */
  lateLinks: Array<{ pageId: string; title: string; emails: string[] }>;
  errored: number;
  summary: string;
}

/** What one `Attendees` string names: addresses we can match on, and entries we cannot. */
export interface ParsedAttendees {
  /** Lower-cased, de-duplicated `<bracketed>` addresses. */
  emails: string[];
  /**
   * Entries carrying NO address at all — a hand-typed bare name. Neither
   * matchable nor ignorable: `formatAttendees` always emits brackets, but
   * `Attendees` is hand-editable and the attendee pass never rewrites a non-empty
   * one, so a bare name is a real attendee this pass cannot resolve. It goes into
   * the flag with everything else it could not resolve, because falling out of
   * BOTH halves of blank-and-flag is the one outcome §8 has no room for.
   */
  unaddressed: string[];
}

/**
 * Splits an `Attendees` string into what can be matched and what cannot.
 *
 * ONLY the `<bracketed>` part is ever an identity, and that is the whole rule this
 * function exists to enforce. The attendee pass writes `Name <email>, …` from the
 * calendar invite, so the address inside the angle brackets is a VERIFIED identity
 * that came from Google. The display name beside it is not an identity at all — two
 * people share a name, and a name plus a company domain is exactly the guess spec §8
 * forbids. An entry with no brackets therefore yields no address; it is REPORTED as
 * unresolved, never matched on its name.
 */
export function parseAttendees(attendees: string): ParsedAttendees {
  const emails = new Set<string>();
  const unaddressed = new Set<string>();

  // ADDRESSES FIRST, commas second — and that order is the whole of round 2's
  // minor fix. Splitting on `,` up front looked equivalent and was not: a display
  // name may CONTAIN a comma, and `formatAttendees` (lib/attendees.ts) emits
  // Google's raw displayName, so a directory-style "Vegusdal, Stein
  // <stein@…>" split into a phantom entry "Vegusdal" that was then flagged
  // permanently — noise in the one field Bendik is meant to act on, naming a
  // fragment of somebody who IS linked.
  //
  // `([^<>]*)<([^<>]+)>` consumes each address together with the text in front of
  // it, so that text is the display name whatever punctuation it holds. Only what
  // is left AFTER the final address is residue with no address of its own.
  //
  // The residual cost, named: a bare name written BEFORE an address ("Bare Name,
  // Ada <ada@x.io>") is absorbed into that address's display name and not
  // flagged. There is no way to tell it from a comma inside a display name, and
  // the two failures are not equal — one is constant noise on ordinary Norwegian
  // names, the other a missed flag in a hand-edit-only case.
  let tail = 0;
  for (const match of attendees.matchAll(/<([^<>]+)>/g)) {
    const email = (match[1] ?? "").trim().toLowerCase();
    if (email !== "") emails.add(email);
    tail = (match.index ?? 0) + match[0].length;
  }
  for (const raw of attendees.slice(tail).split(",")) {
    const entry = raw.trim().replace(/\s+/g, " ");
    if (entry !== "") unaddressed.add(entry);
  }
  return { emails: [...emails], unaddressed: [...unaddressed] };
}

/** The matchable half of parseAttendees. */
export function attendeeEmails(attendees: string): string[] {
  return parseAttendees(attendees).emails;
}

/**
 * The `People Unmatched` flag's one format: sorted, de-duplicated, comma-space
 * separated. Sorted because the value is compared byte-for-byte against what
 * Notion returns on the next tick — an order that depended on the attendee
 * string's order would re-write the property every time a human re-ordered
 * `Attendees`, which is the "correct for one tick, broken on the next" shape.
 */
export function formatUnmatched(emails: readonly string[]): string {
  return [...new Set(emails)].sort().join(", ");
}

/**
 * How many relation targets Notion inlines in a page object. Beyond this it
 * returns the first 25 and sets `has_more`.
 *
 * Load-bearing on BOTH sides, and the write side is what review round 1 found
 * missing: the read-side refusal alone let the pass write a 26-link relation that
 * it then refused to touch on every later tick — a row driven into its own
 * permanently-refused state, reported as a success. See the three refusals in the
 * relation loop.
 */
export const RELATION_INLINE_CAP = 25;

/**
 * The relation this pass will assert: everything Notion already holds, PLUS every
 * link it verified this tick. Sorted, so the value written is deterministic.
 *
 * **Additive, never subtractive, and that is decision 4 applied to the relation.**
 * The obvious alternative — make the relation exactly the derived set — deletes a
 * link the moment the derivation stops reproducing it, and the derivation stops
 * for reasons that have nothing to do with the meeting. That is verified history
 * destroyed by a routine hourly job, which is exactly what the never-delete
 * posture (spec §7) exists to prevent.
 *
 * TWO costs, both real, and the second was mis-stated in round 1's docs:
 *
 *  - A link stays after the attendee is removed from `Attendees` by hand. The
 *    attendee pass never rewrites a non-empty `Attendees`, so this only arises
 *    from a manual edit.
 *  - **A link REMOVED by hand comes back**, if the derivation still reproduces it.
 *    Only the removal of a link the derivation no longer produces sticks. The
 *    relation is what `Attendees` says — an INVITE list, not an attendance list —
 *    so "she was invited but did not come" is not something this property can
 *    express, and unlinking does not make it express it.
 */
function assertedLinks(current: readonly string[], verified: ReadonlySet<string>): string[] {
  return [...new Set([...current, ...verified])].sort();
}

/** Set equality over page ids — the relation's order is Notion's business, not ours. */
function sameLinks(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...right].every((id) => left.has(id));
}

/**
 * The fields whose Notion value disagrees with the source. Partial on purpose
 * (the `updateDocProps` house style): a name-only refresh must not re-assert the
 * email that keys the row, both because re-writing a value that has not changed
 * is a lie about what happened and because the smaller the patch, the smaller the
 * blast radius when one property's type is wrong on the database.
 *
 * **`Email` is written ONCE and then never overwritten** (review round 1,
 * Important 2). It is the row's KEY — the durable binding between an address and
 * a person — and a key that moves when the CRM moves is what let an address
 * reassigned to a different human attach the wrong person to a historical meeting:
 *
 *   Alice attends as `post@acme.no`; her row is keyed on it. Twenty later moves
 *   that address to Bob. If the key had followed, Alice's row would stop holding
 *   `post@acme.no`, nothing would object, and Bob — a person who was never in the
 *   room — would be linked to Alice's meeting, permanently and silently, because
 *   the relation is additive.
 *
 * Held fixed, the same sequence refuses itself: `post@acme.no` still resolves to
 * Alice's row (so the meeting stays right, and gains no spurious flag), and Bob
 * is refused with a report naming the row and the Source ID that holds it —
 * because two records claiming one address is a mess only a human can settle.
 *
 * The cost, named: the row's `Email` is the address the person was FIRST projected
 * under, not necessarily their current one. `Source ID` points at the system where
 * the current one lives, and any newer address the source holds still RESOLVES
 * (linkAliases binds it at runtime) — it just does not overwrite the key. An empty
 * `Email` is still filled in, because that is a first write, not an overwrite.
 */
function changedProps(row: PeopleRow, person: SourcePerson): Partial<PersonProps> {
  const change: Partial<PersonProps> = {};
  if (row.name !== person.name) change.name = person.name;
  if (row.email === "" && person.email !== "") change.email = person.email;
  if (row.source !== person.source) change.source = person.source;
  if (row.sourceId !== person.sourceId) change.sourceId = person.sourceId;
  return change;
}

/**
 * Every identity in this file is normalised at ITS OWN boundary — `toPersonRow`
 * lower-cases a People row's `Email`, `parseAttendees` lower-cases what it reads.
 * A `SourcePerson` arrives from an adapter, which is the one boundary this file
 * cannot see inside, so it is normalised again here rather than trusted to have
 * been. Unreachable through `twenty-people.ts` today (it already normalises), and
 * that is exactly why it was worth closing: it was the one identity whose form was
 * guaranteed by a comment instead of by code, and a non-normalised source would
 * have PATCHed the same row every tick, forever.
 */
function normalisePerson(person: SourcePerson): SourcePerson {
  const email = person.email.trim().toLowerCase();
  return {
    ...person,
    email,
    otherEmails: [...new Set(person.otherEmails.map((e) => e.trim().toLowerCase()))]
      .filter((e) => e !== "" && e !== email),
  };
}

/**
 * A page id that cannot exist, used only in dry-run to stand in for a create that
 * did not happen. Without it the preview would report every to-be-created person
 * as an UNRESOLVED attendee — the opposite of what the live run does — and the
 * pre-flight would be describing a run nobody is going to make (the same defect
 * T4's review round 1 found in the transcript preview).
 */
const PLANNED = (sourceId: string): string => `planned:${sourceId}`;

export async function runPeopleSync(
  opts: PeopleSyncOptions,
  deps: PeopleSyncDeps,
): Promise<PeopleSyncResult> {
  // Sorted at every entry point: the projection loop, the duplicate resolution and
  // the relation loop all pick a winner when there is a tie, and a tie broken by
  // whatever order Notion happened to return would flip between ticks and write
  // forever. Deterministic ordering is what makes "quiet in steady state" a
  // property rather than a hope.
  const source = (await deps.listSourcePeople())
    .map(normalisePerson)
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const peopleRows = [...await deps.queryPeople()].sort((a, b) => a.pageId.localeCompare(b.pageId));
  const meetings = [...await deps.queryMeetings()].sort((a, b) => a.pageId.localeCompare(b.pageId));

  const selfEmails = new Set(
    opts.selfEmails.map((email) => email.trim().toLowerCase()).filter((email) => email !== ""),
  );
  const attendeesOf = (row: PeopleMeetingRow): ParsedAttendees => {
    const parsed = parseAttendees(row.attendees);
    return {
      emails: parsed.emails.filter((email) => !selfEmails.has(email)),
      unaddressed: parsed.unaddressed,
    };
  };

  // Every address any meeting needs a person for. This is the selection rule
  // (decision 3) and nothing else: a source person is projected because a meeting
  // names them, never because they exist.
  const wanted = new Set<string>();
  for (const row of meetings) for (const email of attendeesOf(row).emails) wanted.add(email);

  // A source that returns nothing while People rows exist that IT put there is
  // never a legitimate "nobody to project" — it is what an expired API key, a
  // wrong base URL or a blocked egress rule produces. Same refusal, and the same
  // reasoning, as runAttendeeSync's empty-calendar guard.
  //
  // Keyed on EVIDENCE ("this source demonstrably worked before, and now returns
  // nothing"), not on what is at stake — because in this design nothing much IS at
  // stake. The relation's lookup table is seeded from Notion's own People rows, so
  // an empty source leaves every already-projected attendee resolving exactly as
  // before; it writes nothing and destroys nothing. What it does do is stop
  // maintaining the projection SILENTLY, and a number in a log line is not enough
  // signal for that. So: loud when the source has visibly stopped answering, and
  // quiet for the two legitimate empty cases — a first run, and a deployment whose
  // People rows are all hand-made.
  const projected = peopleRows.filter((row) => row.sourceId !== "").length;
  if (source.length === 0 && projected > 0) {
    throw new Error(
      `notion-sync: the people source returned 0 people while ${projected} People row(s) ` +
      "carry a Source ID it wrote — refusing to treat a source outage as a source that has " +
      "become empty; check its base URL, API key and egress before re-running",
    );
  }

  // ---------------------------------------------------------------------------
  // Index what Notion already holds. TWO identities, on purpose.
  //
  // `Source ID` is the source system's own record id and survives a change of
  // address; `Email` is what an attendee string can be matched on and is what a
  // hand-made row carries. Keying on the email alone would fork a person into a
  // second row the day their primary address changes in the CRM — and then leave
  // the old row behind, unsourced, forever. Keying on the id alone would ignore
  // every row Bendik made by hand.
  // ---------------------------------------------------------------------------
  const bySourceId = new Map<string, PeopleRow>();
  const byEmail = new Map<string, PeopleRow>();
  const pagesPerEmail = new Map<string, string[]>();
  for (const row of peopleRows) {
    if (row.sourceId !== "" && !bySourceId.has(row.sourceId)) bySourceId.set(row.sourceId, row);
    if (row.email === "") continue;
    if (!byEmail.has(row.email)) byEmail.set(row.email, row);
    pagesPerEmail.set(row.email, [...(pagesPerEmail.get(row.email) ?? []), row.pageId]);
  }
  const duplicates = [...pagesPerEmail.entries()]
    .filter(([, pageIds]) => pageIds.length > 1)
    .map(([email, pageIds]) => ({ email, pageIds }))
    .sort((a, b) => a.email.localeCompare(b.email));

  // The relation's lookup table: address → People page. Seeded from what Notion
  // holds so a row a human made by hand for someone the CRM does not know is a
  // first-class match target — it just never gets MAINTAINED by this pass, which
  // is the honest division of labour between a projection and a human's own work.
  //
  // Because `Email` is write-once (changedProps), this seed is also the DURABLE
  // half of the binding: an address a People row already holds keeps resolving to
  // that row whatever the source does with it later. That is what pins a
  // historical meeting's attendee to the person who was actually in the room.
  const linkFor = new Map<string, string>();
  // Who holds each bound address, where we know. Only rows carrying a Source ID
  // count as a CLAIM by a source record; a hand-made row asserts a binding but
  // claims no record, so a source person adopting it is not a conflict.
  const boundBy = new Map<string, string>();
  for (const [email, row] of byEmail) {
    linkFor.set(email, row.pageId);
    if (row.sourceId !== "") boundBy.set(email, row.sourceId);
  }
  const contestedAddresses: ContestedAddress[] = [];
  const relabelled: Relabelled[] = [];

  /**
   * email -> the source record whose PRIMARY it is. Computed once, from the source
   * itself, BEFORE anything binds — so the third level of the claim order
   * (bindAddresses) is a fact about the data rather than a race between records.
   * First by `sourceId` wins when two records share a primary; that collision is
   * settled and reported on the create path instead.
   */
  const primaryOf = new Map<string, string>();
  for (const person of source) {
    if (person.email !== "" && !primaryOf.has(person.email)) {
      primaryOf.set(person.email, person.sourceId);
    }
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let notNeeded = 0;
  let noEmail = 0;
  let errored = 0;
  const skipped: PersonSkip[] = [];
  const claimed = new Set<string>();
  /**
   * Every People row some source person matched — whether it was then written,
   * refused, or found already claimed. `unsourced` is computed from THIS and not
   * from `claimed` (review round 1, Minor 7): a row the pass recognised and then
   * refused is contested, not orphaned, and reporting it as "the source no longer
   * holds this person" would be wrong exactly when something already needs a human.
   */
  const recognised = new Set<string>();

  for (const person of source) {
    if (person.email === "") {
      noEmail += 1;
      continue;
    }

    const row = bySourceId.get(person.sourceId) ?? byEmail.get(person.email);

    if (row === undefined) {
      const named = wanted.has(person.email) || person.otherEmails.some((e) => wanted.has(e));
      if (!named) {
        notNeeded += 1;
        continue;
      }
      // A CREATE KEYS A ROW ON AN ADDRESS, so it needs the same rule
      // `bindAddresses` applies (round 3, F7). Round 2 guarded the bind and left
      // this one consulting a map seeded from ROWS, which is exactly the index
      // that cannot see the case that matters: an address bound this tick by
      // somebody else's ALIAS is held by no row at all, so the create went ahead,
      // minted a row keyed on it — and on the NEXT tick that row seeded `byEmail`,
      // outranked the alias, and the binding MOVED. The relation is additive, so
      // it kept both answers, and `boundTo` flipped between ticks. An address
      // binding to one person "and never moving" was true only within a tick.
      //
      // Consulting `linkFor` closes it at the source: no row is ever minted on an
      // address something else already binds, so nothing can re-seat the index
      // between ticks. It also subsumes what the old map did — two records with no
      // rows both claiming one primary — because the first one's create binds it.
      //
      // Which record the address really belongs to stays unanswered, deliberately:
      // this is the same "older evidence wins, and say so" rule as everywhere else
      // in this file, and here the older evidence is simply the earlier record in a
      // deterministically sorted pass. Both the person (no row) and the address
      // (two claimants) are reported, because they are different facts and a reader
      // of either list alone would be misled.
      const heldBy = linkFor.get(person.email);
      if (heldBy !== undefined) {
        const holder = boundBy.get(person.email);
        skipped.push({
          sourceId: person.sourceId, name: person.name,
          reason: `${person.email} is already bound to People row ${heldBy}` +
            `${holder === undefined ? "" : ` (${holder})`} — no row created`,
        });
        if (holder !== undefined && holder !== person.sourceId) {
          const existing = contestedAddresses.find((c) => c.email === person.email);
          if (existing === undefined) {
            contestedAddresses.push({
              email: person.email, boundTo: heldBy, boundBy: holder,
              alsoClaimedBy: [person.sourceId],
            });
          } else if (!existing.alsoClaimedBy.includes(person.sourceId)) {
            existing.alsoClaimedBy.push(person.sourceId);
          }
        }
        continue;
      }
      const props: PersonProps = {
        name: person.name, email: person.email,
        source: person.source, sourceId: person.sourceId,
      };
      if (opts.dryRun) {
        created += 1;
        bindAddresses(linkFor, boundBy, primaryOf, contestedAddresses, person, PLANNED(person.sourceId));
        continue;
      }
      try {
        const { pageId } = await deps.createPerson(props);
        created += 1;
        bindAddresses(linkFor, boundBy, primaryOf, contestedAddresses, person, pageId);
      } catch (err) {
        errored += 1;
        // Contained per person, like every other engine here: the address simply
        // stays unresolved for this tick, the meeting is flagged, and the next tick
        // tries again. Nothing is left half-written, because a create is one call.
        console.error(
          `notion-sync: people: could not create a People row for ${person.email} ` +
          `(${person.source} ${person.sourceId}): ${message(err)}`,
        );
      }
      continue;
    }

    // Two refusals, both of which protect somebody else's row. Neither invents a
    // resolution: only a human can say which record is which. Both mark the row
    // RECOGNISED, so it is never also reported as one the source has forgotten.
    recognised.add(row.pageId);
    if (row.sourceId !== "" && row.sourceId !== person.sourceId) {
      // The reassignment refusal (round 1, Important 2). Because `Email` is
      // write-once, a row keeps the address it was projected under — so when the
      // source hands that address to a DIFFERENT record, this fires immediately,
      // permanently, and with both ids in the message, instead of the new record
      // quietly acquiring a row (and every meeting the old address appears in).
      skipped.push({
        sourceId: person.sourceId, name: person.name,
        reason: `People row ${row.pageId} already carries Source ID ${row.sourceId}`,
      });
      continue;
    }
    if (claimed.has(row.pageId)) {
      skipped.push({
        sourceId: person.sourceId, name: person.name,
        reason: `People row ${row.pageId} was already claimed by another source person`,
      });
      continue;
    }
    claimed.add(row.pageId);

    const change = changedProps(row, person);
    // Adoption of a hand-made row that RENAMES it. Adoption itself is the designed
    // feature and is not refused — it is why a hand-made row exists, and refusing
    // it on a name mismatch would both introduce name matching and leave the person
    // unprojectable forever, because the row blocks their create. What is reported
    // is the consequence: every meeting already linked to that row now shows a
    // different human.
    if (row.sourceId === "" && change.name !== undefined && row.name !== "") {
      relabelled.push({
        pageId: row.pageId, from: row.name, to: person.name, sourceId: person.sourceId,
      });
    }
    if (Object.keys(change).length === 0) {
      unchanged += 1;
    } else if (opts.dryRun) {
      updated += 1;
    } else {
      try {
        await deps.updatePerson(row.pageId, change);
        updated += 1;
      } catch (err) {
        errored += 1;
        console.error(
          `notion-sync: people: could not update People row ${row.pageId} ` +
          `(${person.source} ${person.sourceId}): ${message(err)}`,
        );
      }
    }

    // Every address the source holds for this person points at their row — unless
    // it already points at somebody else's, which is refused and reported. See
    // bindAddresses for why the primary needs the same guard the aliases always had.
    bindAddresses(linkFor, boundBy, primaryOf, contestedAddresses, person, row.pageId);
  }

  // A People row nobody in the source answers for. Counted, never touched — the
  // never-delete posture (spec §7, decision 4) with nothing else attached to it.
  const unsourced = peopleRows.filter((row) => !recognised.has(row.pageId)).length;

  // ---------------------------------------------------------------------------
  // The relation, and its flag.
  // ---------------------------------------------------------------------------
  let relationsUpdated = 0;
  let relationsUnchanged = 0;
  let unresolved = 0;
  let meetingsFlagged = 0;
  const meetingsSkipped: MeetingSkip[] = [];
  const lateLinks: Array<{ pageId: string; title: string; emails: string[] }> = [];

  for (const row of meetings) {
    const attendees = attendeesOf(row);
    const links = new Set<string>();
    const resolvedBy: Array<{ email: string; pageId: string }> = [];
    // A bare name is as unresolved as an unknown address, and lands in the same
    // flag — see ParsedAttendees.unaddressed for why silence was not an option.
    const missing: string[] = [...attendees.unaddressed];
    for (const email of attendees.emails) {
      const pageId = linkFor.get(email);
      if (pageId === undefined) missing.push(email);
      else {
        links.add(pageId);
        resolvedBy.push({ email, pageId });
      }
    }
    if (missing.length > 0) {
      unresolved += missing.length;
      meetingsFlagged += 1;
    }

    const people = assertedLinks(row.people, links);
    const unmatchedValue = formatUnmatched(missing);
    if (sameLinks(row.people, people) && row.peopleUnmatched === unmatchedValue) {
      relationsUnchanged += 1;
      continue;
    }

    // THREE refusals, and the last two are what round 1 found missing. Notion
    // inlines at most RELATION_INLINE_CAP relation targets, so both sides of this
    // property have to respect the same number — the read side alone let the pass
    // write a 26-link relation it then refused to touch on every later tick, and
    // reported that as a success. All three are deliberately checked only once a
    // write is actually needed, so a settled row at the cap stays quiet rather
    // than reporting itself every hour.
    if (row.peopleTruncated) {
      // Writing a set computed against a partial read would DROP the links it
      // could not see — a deletion, dressed up as a refresh.
      meetingsSkipped.push({
        pageId: row.pageId, title: row.title,
        reason: `Notion returned a truncated People relation (>${RELATION_INLINE_CAP} links) — ` +
          "refusing to write a set it could not read",
      });
      continue;
    }
    if (row.people.length >= RELATION_INLINE_CAP) {
      // Not known-truncated, but not provably complete either: at exactly the cap,
      // "25 links" and "the first 25 of more" are the same response unless Notion
      // sets `has_more` in a data-source query — a shape this service has not
      // probed. Refusing here makes the pass correct WHICHEVER way that falls,
      // instead of correct only if the flag is present.
      meetingsSkipped.push({
        pageId: row.pageId, title: row.title,
        reason: `the People relation is at Notion's inline cap (${RELATION_INLINE_CAP}) and cannot be ` +
          "proven complete — refusing to write a set that could drop links it did not read",
      });
      continue;
    }
    if (people.length > RELATION_INLINE_CAP) {
      // Writing this would produce a row Notion can never return intact, which
      // this same loop would then refuse forever. Writing only the first 25 would
      // silently drop a verified attendee. Neither is honest; refuse and report.
      meetingsSkipped.push({
        pageId: row.pageId, title: row.title,
        reason: `${people.length} verified attendees exceeds Notion's inline relation cap ` +
          `(${RELATION_INLINE_CAP}) — refusing to write a relation that could not be read back whole`,
      });
      continue;
    }

    // A settled meeting whose set of people GREW. Reported, never silent — see
    // PeopleSyncResult.lateLinks.
    if (row.people.length > 0) {
      const already = new Set(row.people);
      const added = resolvedBy.filter((r) => !already.has(r.pageId)).map((r) => r.email);
      if (added.length > 0) {
        lateLinks.push({ pageId: row.pageId, title: row.title, emails: [...new Set(added)].sort() });
      }
    }

    if (opts.dryRun) {
      relationsUpdated += 1;
      continue;
    }
    try {
      await deps.updateMeetingPeople(row.pageId, { people, unmatched: unmatchedValue });
      relationsUpdated += 1;
    } catch (err) {
      errored += 1;
      console.error(
        `notion-sync: people: could not write the People relation on meeting ${row.pageId}: ${message(err)}`,
      );
    }
  }

  // The two things this pass does that a human cannot undo from Notion. Both are
  // already in the result and the log; this is what makes them leave the container.
  // Best-effort, exactly like every other notify in this service: a down spine must
  // never fail a tick or make a completed write look like a failure.
  for (const late of lateLinks) {
    await ping(opts, deps,
      `notion-sync: people: meeting "${late.title || late.pageId}" (${late.pageId}) gained a ` +
      `People link for ${late.emails.join(", ")} — the source learned about them after the ` +
      "meeting. If they were not there, correct Attendees or the source: a link removed in " +
      "Notion comes back on the next tick.");
  }
  for (const row of relabelled) {
    await ping(opts, deps,
      `notion-sync: people: People row ${row.pageId} was adopted by the source (${row.sourceId}) ` +
      `and renamed "${row.from}" → "${row.to}" — every meeting already linked to that row now ` +
      "shows the new name.");
  }

  return {
    sourcePeople: source.length,
    peopleRows: peopleRows.length,
    meetingsScanned: meetings.length,
    created, updated, unchanged, notNeeded, noEmail, unsourced,
    duplicates, contestedAddresses, relabelled, skipped,
    relationsUpdated, relationsUnchanged, unresolved, meetingsFlagged, meetingsSkipped,
    lateLinks, errored,
    summary:
      `${created} created, ${updated} updated, ${unchanged} unchanged, ` +
      `${relationsUpdated} relations written, ${relationsUnchanged} relations unchanged, ` +
      `${unresolved} attendee(s) unresolved across ${meetingsFlagged} meeting(s), ` +
      `${unsourced} unsourced, ${errored} errored, ` +
      `${source.length} in source, ${meetings.length} meetings scanned` +
      `${opts.dryRun ? " (dry-run)" : ""}`,
  };
}

/**
 * Points every address the source holds for this person at their People page —
 * **and never at somebody else's** — reporting each address it had to refuse.
 *
 * ONE RULE FOR EVERY ADDRESS, primary and alias alike: an address binds to this
 * page only if it is unbound, or already points here. That symmetry is round 2's
 * fix (F6), and its absence was the sixth defect of this phase's signature class.
 * Round 1 pinned the STORED key (`Email` is write-once) but left this RUNTIME
 * binding following the CRM, because the primary was set unconditionally while
 * only the aliases were guarded. The hole that left:
 *
 *   The `row.sourceId !== person.sourceId` refusal in the projection loop can only
 *   fire for a person the EMAIL index matched. A person the SOURCE ID index
 *   matched — i.e. anyone who already has a row — never reaches it. So when the
 *   source moved an address onto such a person, they simply took the binding from
 *   the other person's row, the additive relation made the link permanent, and
 *   nothing was reported. Bob leaves, a new hire inherits `post@acme.no`, and on
 *   tick 3 she is attached to Bob's meetings, silently and unrepairably from
 *   Notion (a hand-removed link comes back within the hour).
 *
 * The existing binding wins because it is the older evidence: it came either from
 * a People row's write-once key or from an earlier record in this same
 * deterministically-sorted pass. Which record the address REALLY belongs to is not
 * a question this pass can answer, so it answers none of it and says so.
 *
 * A binding held by a HAND-MADE row (no `Source ID`) is respected silently: Bendik
 * made that row deliberately, the source person still gets their own row, and
 * there is no second record contesting anything.
 *
 * ---
 *
 * THREE LEVELS OF CLAIM, added in round 4 and ruled on by the review:
 *
 *     stored row key  >  source primary  >  source alias
 *
 * The first two are enforced by the rule above (a row key seeds `linkFor` before
 * the loop, so it outranks everything). The third is `primaryOf`: **an ALIAS may
 * not bind an address that is another record's PRIMARY**, whether or not anything
 * currently binds it.
 *
 * This is not a bind-order race and it grants a primary nothing — it only REMOVES
 * a binding opportunity from the weakest claim. That distinction is what makes it
 * safe: F6 was caused by an UNGUARDED WRITE (a primary set unconditionally, taking
 * another row's key), and a tightening cannot revive it. **The inverse — letting a
 * primary take an address held only as an alias BINDING — is F6, and is exactly
 * what this must not do.** The primary keeps its `linkFor` guard.
 *
 * Without the third level, the losing claim was decided by which Twenty record id
 * sorted first: identical data, opposite answer, and a one-tick blip in the source
 * read flipping it permanently. Worse, the outcome violated spec §8 squarely — a
 * meeting read `People=[the alias holder]` with an EMPTY flag: not blank, not
 * flagged, and wrong about who was in the room.
 *
 * The level order is the one `SourcePerson.otherEmails` already states in prose
 * ("match-only, never projected… which address is a person's identity is the
 * source's call"); this only says it in code.
 */
function bindAddresses(
  linkFor: Map<string, string>,
  boundBy: Map<string, string>,
  primaryOf: ReadonlyMap<string, string>,
  contested: ContestedAddress[],
  person: SourcePerson,
  pageId: string,
): void {
  const report = (email: string, boundTo: string, holder: string): void => {
    const existing = contested.find((c) => c.email === email);
    if (existing === undefined) {
      contested.push({ email, boundTo, boundBy: holder, alsoClaimedBy: [person.sourceId] });
    } else if (!existing.alsoClaimedBy.includes(person.sourceId)) {
      existing.alsoClaimedBy.push(person.sourceId);
    }
  };

  const addresses = [person.email, ...person.otherEmails];
  for (const [index, email] of addresses.entries()) {
    const held = linkFor.get(email);
    // Already ours: this address ALREADY points at this page, so re-affirming it
    // changes no binding — it only records who is being credited for it.
    //
    // WHAT THIS ARM'S POSITION DOES AND DOES NOT DO (corrected in the final fix
    // wave; the earlier note overstated it). It is NOT what keeps F6's STEAL
    // refused — that is `linkFor`'s row-key seed before the loop, plus the alias
    // arm below; a reviewer mutated this ordering and STEAL, SWAP and the F6
    // regression all still passed, and no test pins the order. What it IS
    // load-bearing for is REPORT FIDELITY: without it, a record whose own stored
    // row key is also another record's primary would `report(...)` itself as
    // contesting its own address, every tick, forever
    // ("boundBy: crm-alice, alsoClaimedBy: [crm-alice]").
    if (held === pageId) {
      boundBy.set(email, person.sourceId);
      continue;
    }
    if (index > 0) {
      // An ALIAS, and the address is somebody else's IDENTITY. Refused whether or
      // not it is bound yet: binding it here is what let a row later be minted on
      // it by its real owner and the binding then move (F7), and what made a
      // meeting show the alias holder instead of the person whose address it is.
      const owner = primaryOf.get(email);
      if (owner !== undefined && owner !== person.sourceId) {
        report(email, held ?? "", boundBy.get(email) ?? owner);
        continue;
      }
    }
    if (held === undefined) {
      linkFor.set(email, pageId);
      boundBy.set(email, person.sourceId);
      continue;
    }
    const holder = boundBy.get(email);
    if (holder === undefined || holder === person.sourceId) continue;
    report(email, held, holder);
  }
}

/**
 * Best-effort: a ping that fails is logged, never thrown. Same posture as every
 * other notify call in this service (spec §18.6).
 *
 * **Silent in dry-run** — the contract every pass here shares (transcript-sync.ts,
 * apply-sync.ts: "a rehearsal has no business messaging a human"). Round 2 shipped
 * this without the guard, so `notion-sync people --dry-run` — the exact pre-flight
 * the runbook tells the operator to run — pinged the spine, and said "gained a
 * People link" about a link nothing gained. A daemon left on NOTION_SYNC_DRY_RUN=1
 * would have done it hourly.
 */
async function ping(opts: PeopleSyncOptions, deps: PeopleSyncDeps, text: string): Promise<void> {
  if (opts.dryRun) return;
  try {
    await deps.notify(text);
  } catch (err) {
    console.error(`notion-sync: people: notify failed: ${message(err)}`);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
