import { describe, it, expect } from "vitest";
import {
  runPeopleSync, attendeeEmails, parseAttendees, formatUnmatched,
  type PeopleSyncDeps, type PeopleSyncOptions, type PeopleMeetingRow,
  type PeopleRow, type SourcePerson, type PersonProps,
} from "../lib/people-sync.js";

const SELF = "bendik@example.com";
const OPTS: PeopleSyncOptions = { dryRun: false, selfEmails: [SELF] };

function person(over: Partial<SourcePerson> = {}): SourcePerson {
  return {
    sourceId: "crm-1", source: "TestCRM", name: "Alex Partner",
    email: "alex@partner.example", otherEmails: [], ...over,
  };
}

function meeting(over: Partial<PeopleMeetingRow> = {}): PeopleMeetingRow {
  return {
    pageId: "meet-1", title: "Alex // Bendik",
    attendees: `Alex Partner <alex@partner.example>, Bendik <${SELF}>`,
    people: [], peopleTruncated: false, peopleUnmatched: "", ...over,
  };
}

function row(over: Partial<PeopleRow> = {}): PeopleRow {
  return {
    pageId: "person-1", name: "Alex Partner", email: "alex@partner.example",
    source: "TestCRM", sourceId: "crm-1", ...over,
  };
}

interface World {
  deps: PeopleSyncDeps;
  created: Array<{ pageId: string; props: PersonProps }>;
  updated: Array<{ pageId: string; props: Partial<PersonProps> }>;
  relations: Array<{ pageId: string; people: string[]; unmatched: string }>;
  pings: string[];
}

function world(
  source: SourcePerson[],
  people: PeopleRow[],
  meetings: PeopleMeetingRow[],
  fail?: { create?: string; update?: string; relation?: string },
): World {
  const created: World["created"] = [];
  const updated: World["updated"] = [];
  const relations: World["relations"] = [];
  const pings: string[] = [];
  let n = 0;
  const deps: PeopleSyncDeps = {
    listSourcePeople: async () => source,
    queryPeople: async () => people,
    queryMeetings: async () => meetings,
    createPerson: async (props) => {
      if (props.sourceId === fail?.create) throw new Error("notion POST failed: 400");
      n += 1;
      const pageId = `new-${n}`;
      created.push({ pageId, props });
      return { pageId };
    },
    updatePerson: async (pageId, props) => {
      if (pageId === fail?.update) throw new Error("notion PATCH failed: 500");
      updated.push({ pageId, props });
    },
    updateMeetingPeople: async (pageId, value) => {
      if (pageId === fail?.relation) throw new Error("notion PATCH failed: 500");
      relations.push({ pageId, ...value });
    },
    notify: async (text) => { pings.push(text); },
  };
  return { deps, created, updated, relations, pings };
}

describe("attendeeEmails", () => {
  it("takes ONLY the bracketed addresses, never the display names", () => {
    expect(attendeeEmails("Alex Partner <alex@partner.example>, Ada Lovelace <ada@x.io>"))
      .toEqual(["alex@partner.example", "ada@x.io"]);
  });

  it("yields nothing for an entry with no address — a name is never an identity", () => {
    expect(attendeeEmails("Alex Partner, Ada Lovelace")).toEqual([]);
    expect(attendeeEmails("")).toEqual([]);
  });

  it("lower-cases and de-duplicates, so one person cannot become two", () => {
    expect(attendeeEmails("A <alex@partner.example>, B <alex@partner.example>")).toEqual(["alex@partner.example"]);
  });

  // Round 2: addresses are tokenised BEFORE commas, because a display name may
  // contain one — `formatAttendees` emits Google's raw displayName, and
  // "Partner, Alex" is an ordinary Norwegian directory-style name.
  it("does not split a display name that contains a comma into a phantom entry", () => {
    const parsed = parseAttendees("Partner, Alex <alex@partner.example>, Lovelace, Ada <ada@x.io>");
    expect(parsed.emails).toEqual(["alex@partner.example", "ada@x.io"]);
    expect(parsed.unaddressed).toEqual([]);
  });

  it("still reports an entry written after the last address as unresolved", () => {
    const parsed = parseAttendees("Partner, Alex <alex@partner.example>, Someone Unlisted");
    expect(parsed.emails).toEqual(["alex@partner.example"]);
    expect(parsed.unaddressed).toEqual(["Someone Unlisted"]);
  });

  it("treats a string with no address at all as entirely unresolved", () => {
    expect(parseAttendees("Acme AS, room@acme.no")).toEqual({
      emails: [], unaddressed: ["Acme AS", "room@acme.no"],
    });
  });
});

describe("formatUnmatched", () => {
  it("is sorted and comma-separated, so the round-trip comparison is stable", () => {
    expect(formatUnmatched(["b@x.io", "a@x.io"])).toBe("a@x.io, b@x.io");
    expect(formatUnmatched([])).toBe("");
  });
});

describe("runPeopleSync — the projection", () => {
  it("creates a People row for a source person a meeting names", async () => {
    const w = world([person()], [], [meeting()]);
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.created).toEqual([{
      pageId: "new-1",
      props: {
        name: "Alex Partner", email: "alex@partner.example",
        source: "TestCRM", sourceId: "crm-1",
      },
    }]);
    expect(res).toMatchObject({ created: 1, updated: 0, errored: 0 });
  });

  it("links the meeting to the row it just created", async () => {
    const w = world([person()], [], [meeting()]);
    await runPeopleSync(OPTS, w.deps);

    expect(w.relations).toEqual([{ pageId: "meet-1", people: ["new-1"], unmatched: "" }]);
  });

  it("does NOT create a source person no meeting names — People is not a CRM mirror", async () => {
    const w = world(
      [person(), person({ sourceId: "crm-2", email: "nobody@x.io", name: "Nobody" })],
      [], [meeting()],
    );
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.created.map((c) => c.props.sourceId)).toEqual(["crm-1"]);
    expect(res.notNeeded).toBe(1);
  });

  it("never projects a source person the source holds no email for", async () => {
    // The meeting names them by display name only, so nothing but an inference
    // could connect the two — which is exactly what must not happen.
    const w = world([person({ email: "" })], [], [meeting({ attendees: "Alex Partner" })]);
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.created).toEqual([]);
    expect(res.noEmail).toBe(1);
  });

  it("updates ONLY the fields that changed", async () => {
    const w = world([person({ name: "Alex V. Partner" })], [row()], [meeting()]);
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.updated).toEqual([{ pageId: "person-1", props: { name: "Alex V. Partner" } }]);
    expect(w.created).toEqual([]);
    expect(res).toMatchObject({ created: 0, updated: 1 });
  });

  it("writes nothing when the projection already matches the source", async () => {
    const w = world([person()], [row()], [meeting({ people: ["person-1"] })]);
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.created).toEqual([]);
    expect(w.updated).toEqual([]);
    expect(w.relations).toEqual([]);
    expect(res).toMatchObject({ unchanged: 1, relationsUnchanged: 1 });
  });

  it("keeps the KEY when the source changes a person's address — and binds both", async () => {
    // `Source ID` identifies the row; `Email` is the durable binding this pass made
    // when it first projected them, and it is never overwritten (see changedProps).
    const w = world([person({ email: "stein@newco.io" })], [row()], [
      meeting({ pageId: "meet-old", attendees: `Alex <alex@partner.example>, Bendik <${SELF}>` }),
      meeting({ pageId: "meet-new", attendees: `Alex <stein@newco.io>, Bendik <${SELF}>` }),
    ]);
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.created).toEqual([]);
    expect(w.updated).toEqual([]);
    expect(res.unchanged).toBe(1);
    // BOTH addresses reach the one row: the old one durably, the new one from the source.
    expect(w.relations).toEqual([
      { pageId: "meet-new", people: ["person-1"], unmatched: "" },
      { pageId: "meet-old", people: ["person-1"], unmatched: "" },
    ]);
    expect(res.unresolved).toBe(0);
  });

  it("REFUSES a source record handed an address another record's row already holds", async () => {
    // The reassignment case: post@acme.no was Alice's; Twenty now gives it to Bob.
    const alice = row({ pageId: "person-alice", sourceId: "crm-alice", name: "Alice", email: "post@acme.no" });
    const w = world(
      [person({ sourceId: "crm-bob", name: "Bob", email: "post@acme.no" })],
      [alice],
      [meeting({ attendees: `Alice <post@acme.no>, Bendik <${SELF}>`, people: ["person-alice"] })],
    );
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.created).toEqual([]);
    expect(w.updated).toEqual([]);
    expect(res.skipped).toEqual([{
      sourceId: "crm-bob", name: "Bob",
      reason: "People row person-alice already carries Source ID crm-alice",
    }]);
    // Bob is attached to nothing; the meeting still names the person who was there.
    expect(w.relations).toEqual([]);
    expect(res.unresolved).toBe(0);
    // …and the contested row is NOT reported as one the source has forgotten.
    expect(res.unsourced).toBe(0);
  });

  it("adopts a hand-made row that carries the email but no Source ID", async () => {
    const w = world([person()], [row({ sourceId: "", source: "" })], [meeting()]);
    await runPeopleSync(OPTS, w.deps);

    expect(w.created).toEqual([]);
    expect(w.updated).toEqual([
      { pageId: "person-1", props: { source: "TestCRM", sourceId: "crm-1" } },
    ]);
  });

  it("NEVER deletes a row the source no longer holds — it is left alone and counted", async () => {
    const w = world(
      [person()],
      [row(), row({ pageId: "person-9", sourceId: "crm-gone", email: "gone@x.io" })],
      [],
    );
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.created).toEqual([]);
    expect(w.updated).toEqual([]);
    expect(res.unsourced).toBe(1);
  });

  it("refuses to write when two People rows claim one email, and reports both", async () => {
    const w = world(
      [person()],
      [row({ pageId: "person-b", sourceId: "" }), row({ pageId: "person-a", sourceId: "" })],
      [meeting()],
    );
    const res = await runPeopleSync(OPTS, w.deps);

    // Deterministic: the lowest page id wins, whatever order Notion returned them in,
    // so the choice cannot flip between ticks and start a write loop.
    expect(w.updated.map((u) => u.pageId)).toEqual(["person-a"]);
    expect(res.duplicates).toEqual([{ email: "alex@partner.example", pageIds: ["person-a", "person-b"] }]);
  });

  it("refuses a row whose Source ID belongs to a DIFFERENT source person", async () => {
    const w = world(
      [person({ sourceId: "crm-2" })],
      [row({ sourceId: "crm-1" })],
      [meeting()],
    );
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.updated).toEqual([]);
    expect(w.created).toEqual([]);
    expect(res.skipped).toEqual([{
      sourceId: "crm-2", name: "Alex Partner",
      reason: "People row person-1 already carries Source ID crm-1",
    }]);
  });
});

describe("runPeopleSync — the relation", () => {
  it("leaves an unmatched attendee OUT of the relation and flags the meeting", async () => {
    const w = world([person()], [row()], [meeting({
      attendees: `Alex <alex@partner.example>, Unknown Person <who@nowhere.io>, Bendik <${SELF}>`,
    })]);
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.created).toEqual([]); // no placeholder person, ever
    expect(w.relations).toEqual([
      { pageId: "meet-1", people: ["person-1"], unmatched: "who@nowhere.io" },
    ]);
    expect(res).toMatchObject({ unresolved: 1, meetingsFlagged: 1 });
  });

  it("leaves the relation EMPTY when no attendee resolves", async () => {
    const w = world(
      [person({ sourceId: "crm-9", email: "someone@else.io", name: "Someone Else" })],
      [], [meeting({ attendees: "Unknown <who@nowhere.io>" })],
    );
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.created).toEqual([]);
    expect(w.relations).toEqual([{ pageId: "meet-1", people: [], unmatched: "who@nowhere.io" }]);
    expect(res.meetingsFlagged).toBe(1);
  });

  it("never derives a person from a display name — and flags the bare name", async () => {
    const w = world([person()], [row()], [meeting({ attendees: "Alex Partner, Ada Lovelace" })]);
    const res = await runPeopleSync(OPTS, w.deps);

    // No link and no person invented — but the entries do not vanish either: a
    // hand-typed name is a real attendee this pass cannot resolve, and falling out
    // of BOTH halves of blank-and-flag is the one outcome §8 has no room for.
    expect(w.created).toEqual([]);
    expect(w.relations).toEqual([
      { pageId: "meet-1", people: [], unmatched: "Ada Lovelace, Alex Partner" },
    ]);
    expect(res).toMatchObject({ unresolved: 2, meetingsFlagged: 1 });
  });

  it("excludes the owner's own addresses from the attendee set", async () => {
    const w = world([], [], [meeting({ attendees: `Bendik <${SELF}>` })]);
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.relations).toEqual([]);
    expect(res).toMatchObject({ unresolved: 0, meetingsFlagged: 0, relationsUnchanged: 1 });
  });

  it("resolves an attendee who used one of the source's ADDITIONAL addresses", async () => {
    const w = world(
      [person({ otherEmails: ["s.vegusdal@partner.example"] })],
      [row()],
      [meeting({ attendees: `Alex <s.vegusdal@partner.example>, Bendik <${SELF}>` })],
    );
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.relations).toEqual([{ pageId: "meet-1", people: ["person-1"], unmatched: "" }]);
    expect(res.unresolved).toBe(0);
  });

  it("compares the relation as a SET — a reordered read is not a change", async () => {
    const w = world(
      [person(), person({ sourceId: "crm-2", email: "ada@x.io", name: "Ada" })],
      [row(), row({ pageId: "person-2", sourceId: "crm-2", email: "ada@x.io", name: "Ada" })],
      [meeting({
        attendees: "Alex <alex@partner.example>, Ada <ada@x.io>",
        people: ["person-2", "person-1"],
      })],
    );
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.relations).toEqual([]);
    expect(res.relationsUnchanged).toBe(1);
  });

  it("NEVER removes a link Notion already holds — the relation is additive", async () => {
    // `other-page` is a link this pass did not derive: a person Bendik linked by
    // hand, or one whose address the source no longer holds. Dropping it would be
    // a routine job deleting verified history — see assertedLinks.
    const w = world([person()], [row()], [meeting({ people: ["person-1", "other-page"] })]);
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.relations).toEqual([]);
    expect(res.relationsUnchanged).toBe(1);
  });

  it("adds a verified link beside the ones Notion already holds", async () => {
    const w = world([person()], [row()], [meeting({ people: ["other-page"] })]);
    await runPeopleSync(OPTS, w.deps);

    expect(w.relations).toEqual([
      { pageId: "meet-1", people: ["other-page", "person-1"], unmatched: "" },
    ]);
  });

  it("refuses to touch a meeting whose relation Notion truncated", async () => {
    const w = world([person()], [row()], [meeting({ people: ["other-page"], peopleTruncated: true })]);
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.relations).toEqual([]);
    expect(res.meetingsSkipped).toEqual([{
      pageId: "meet-1", title: "Alex // Bendik",
      reason: "Notion returned a truncated People relation (>25 links) — refusing to write a set it could not read",
    }]);
  });

  it("says nothing about a truncated relation there was no reason to write to", async () => {
    // The refusals are checked only once a write is needed, so a settled row at or
    // over the cap stays quiet instead of reporting itself every hour.
    const w = world([person()], [row()], [meeting({ people: ["person-1"], peopleTruncated: true })]);
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.relations).toEqual([]);
    expect(res.meetingsSkipped).toEqual([]);
    expect(res.relationsUnchanged).toBe(1);
  });

  it("clears a stale flag once the person appears in the source", async () => {
    const w = world([person()], [row()], [
      meeting({ people: ["person-1"], peopleUnmatched: "alex@partner.example" }),
    ]);
    await runPeopleSync(OPTS, w.deps);

    expect(w.relations).toEqual([{ pageId: "meet-1", people: ["person-1"], unmatched: "" }]);
  });
});

describe("runPeopleSync — containment and refusals", () => {
  it("refuses the whole pass when a source that HAS projected rows returns nothing", async () => {
    const w = world([], [row()], [meeting()]);
    await expect(runPeopleSync(OPTS, w.deps)).rejects.toThrow(/returned 0 people/);
  });

  it("does not refuse a first run, or a deployment whose People rows are all hand-made", async () => {
    expect((await runPeopleSync(OPTS, world([], [], [meeting()]).deps)).errored).toBe(0);
    const handMade = world([], [row({ source: "", sourceId: "" })], [meeting()]);
    expect((await runPeopleSync(OPTS, handMade.deps)).errored).toBe(0);
  });

  it("contains a failing create — the rest of the pass still runs", async () => {
    const w = world(
      [person(), person({ sourceId: "crm-2", email: "ada@x.io", name: "Ada" })],
      [],
      [meeting({ attendees: "Alex <alex@partner.example>, Ada <ada@x.io>" })],
      { create: "crm-1" },
    );
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.created.map((c) => c.props.sourceId)).toEqual(["crm-2"]);
    expect(res.errored).toBe(1);
    // The person whose create failed is unresolved THIS tick and resolves the next.
    expect(w.relations).toEqual([
      { pageId: "meet-1", people: ["new-1"], unmatched: "alex@partner.example" },
    ]);
  });

  it("contains a failing relation write", async () => {
    const w = world([person()], [row()], [meeting()], { relation: "meet-1" });
    const res = await runPeopleSync(OPTS, w.deps);
    expect(res.errored).toBe(1);
  });
});

describe("runPeopleSync — dry run", () => {
  it("writes nothing at all", async () => {
    const w = world([person()], [], [meeting()]);
    const res = await runPeopleSync({ ...OPTS, dryRun: true }, w.deps);

    expect(w.created).toEqual([]);
    expect(w.updated).toEqual([]);
    expect(w.relations).toEqual([]);
    expect(res).toMatchObject({ created: 1, relationsUpdated: 1 });
    expect(res.summary).toContain("dry-run");
  });

  it("reports the SAME unresolved attendees a live run would", async () => {
    const meetings = [meeting({
      attendees: `Alex <alex@partner.example>, Ghost <who@nowhere.io>, Bendik <${SELF}>`,
    })];
    const preview = await runPeopleSync({ ...OPTS, dryRun: true }, world([person()], [], meetings).deps);
    const live = await runPeopleSync(OPTS, world([person()], [], meetings).deps);

    expect(preview.unresolved).toBe(live.unresolved);
    expect(preview.meetingsFlagged).toBe(live.meetingsFlagged);
    expect(preview.created).toBe(live.created);
  });
});

describe("runPeopleSync — two source records, one address", () => {
  it("creates ONE row and reports the second, rather than a pair it can never un-merge", async () => {
    const w = world(
      [person(), person({ sourceId: "crm-2", name: "Alex (dup)" })],
      [],
      [meeting()],
    );
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.created.map((c) => c.props.sourceId)).toEqual(["crm-1"]);
    // TWO facts, two lists: the person got no row, and the address has two
    // claimants. A reader of either list alone would be misled.
    expect(res.skipped).toEqual([{
      sourceId: "crm-2", name: "Alex (dup)",
      reason: "alex@partner.example is already bound to People row new-1 (crm-1) — no row created",
    }]);
    expect(res.contestedAddresses).toEqual([{
      email: "alex@partner.example", boundTo: "new-1", boundBy: "crm-1", alsoClaimedBy: ["crm-2"],
    }]);
  });

  it("refuses a create for an address an EXISTING projected row already holds", async () => {
    // The row belongs to crm-1; crm-2 turns up in Twenty holding the same address.
    const w = world(
      [person({ sourceId: "crm-2", name: "Alex (dup)" })],
      [row()],
      [meeting()],
    );
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.created).toEqual([]);
    expect(w.updated).toEqual([]);
    expect(res.skipped[0]?.reason).toContain("already carries Source ID crm-1");
  });
});

describe("runPeopleSync — round 1 fixes", () => {
  it("REPORTS an alias two source records both claim, instead of settling it silently", async () => {
    const w = world(
      [
        person({ otherEmails: ["shared@acme.no"] }),
        person({ sourceId: "crm-2", name: "Ada", email: "ada@x.io", otherEmails: ["shared@acme.no"] }),
      ],
      [],
      [meeting({ attendees: "Alex <alex@partner.example>, Ada <ada@x.io>, Shared <shared@acme.no>" })],
    );
    const res = await runPeopleSync(OPTS, w.deps);

    // Deterministic — the first binding wins — and now SAID, which is the half
    // that was missing.
    expect(res.contestedAddresses).toEqual([{
      email: "shared@acme.no", boundTo: "new-1", boundBy: "crm-1", alsoClaimedBy: ["crm-2"],
    }]);
    expect(w.relations[0]?.people).toEqual(["new-1", "new-2"]);
  });

  it("does not call a hand-made row's address a conflict — it claims no source record", async () => {
    const w = world(
      [person({ otherEmails: ["ada@x.io"] })],
      [row({ pageId: "hand-1", name: "Ada", email: "ada@x.io", source: "", sourceId: "" })],
      [meeting({ attendees: "Alex <alex@partner.example>, Ada <ada@x.io>" })],
    );
    const res = await runPeopleSync(OPTS, w.deps);
    expect(res.contestedAddresses).toEqual([]);
  });

  it("normalises a SourcePerson at ITS boundary too — a shouty source does not churn", async () => {
    // Unreachable through twenty-people.ts today; it was the one identity whose
    // form was guaranteed by a comment rather than by code.
    const shouty = person({ email: " alex@partner.example ", otherEmails: [" S.V@partner.example "] });
    const w = world([shouty], [row()], [meeting()]);
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.updated).toEqual([]);
    expect(res.unchanged).toBe(1);
  });

  it("counts a CONTESTED row as recognised, not as one the source has forgotten", async () => {
    const w = world(
      [person({ sourceId: "crm-2", name: "Other" })],
      [row()],
      [meeting()],
    );
    const res = await runPeopleSync(OPTS, w.deps);

    expect(res.skipped).toHaveLength(1);
    expect(res.unsourced).toBe(0);
  });

  it("refuses a relation write that would exceed Notion's inline cap", async () => {
    const many = Array.from({ length: 26 }, (_, i) =>
      row({ pageId: `p-${String(i).padStart(2, "0")}`, sourceId: `crm-${i}`, email: `p${i}@x.io` }));
    const source = many.map((r) => person({ sourceId: r.sourceId, name: r.name, email: r.email }));
    const w = world(source, many, [meeting({
      attendees: many.map((r) => `X <${r.email}>`).join(", "),
    })]);
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.relations).toEqual([]);
    expect(res.meetingsSkipped[0]?.reason).toContain("exceeds Notion's inline relation cap (25)");
  });

  it("refuses a relation already at the cap rather than writing over a read it cannot prove", async () => {
    const existing = Array.from({ length: 25 }, (_, i) => `old-${i}`);
    const w = world([person()], [row()], [meeting({ people: existing })]);
    const res = await runPeopleSync(OPTS, w.deps);

    expect(w.relations).toEqual([]);
    expect(res.meetingsSkipped[0]?.reason).toContain("at Notion's inline cap (25)");
  });
});
