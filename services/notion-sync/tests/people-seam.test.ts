// The multi-tick test. This phase's signature defect is a change that is correct
// for ONE tick and broken on the next — four times now, every one invisible in the
// diff and caught only by running several ticks in sequence. So this file never
// asserts a single call: it runs the People pass four or more times against a
// STATEFUL fake Notion (tests/helpers/fake-notion-store.ts) that answers each read
// with what the previous tick wrote, and asserts the pass goes quiet and stays
// quiet.
//
// FOUR ticks rather than three, for the reason T4's seam test gives: a two-tick
// oscillation passes three.
//
// It drives the REAL adapter — `makeNotionClient`, so `personProperties`,
// `toPersonRow`, `toMeetingRow` and `updateMeetingPeople` are all in the loop. The
// class of bug this catches is a write shape that does not read back as the same
// value (an `Email` written as rich text, a relation compared in the wrong order,
// a flag string whose formatting drifts): each of those is quiet for exactly one
// tick and then writes forever.
import { describe, it, expect } from "vitest";
import { makeNotionClient } from "../lib/adapters/notion-client.js";
import { runPeopleSync, type PeopleSyncResult, type SourcePerson } from "../lib/people-sync.js";
import { makeNotionStore, personPageProps, meetingPageProps } from "./helpers/fake-notion-store.js";

const PEOPLE_DS = "people-data-source";
const MEETINGS_DS = "meetings-data-source";
const SELF = "owner@example.com";

function person(over: Partial<SourcePerson> = {}): SourcePerson {
  return {
    sourceId: "crm-1", source: "TestCRM", name: "Alex Partner",
    email: "alex@partner.example", otherEmails: [], ...over,
  };
}

/**
 * One world: a stateful Notion, a mutable source list, and a `tick()` that runs
 * the pass exactly the way the composition root does.
 */
function world(source: SourcePerson[]) {
  const store = makeNotionStore();
  const pings: string[] = [];
  /** Source records whose create should fail this tick — see the F7(iv) test. */
  const failCreates = new Set<string>();
  const notion = makeNotionClient({
    token: "t", version: "2026-03-11", fetchImpl: store.impl as unknown as typeof fetch,
    minIntervalMs: 0,
  });
  let people = [...source];

  async function tick(dryRun = false): Promise<PeopleSyncResult> {
    return runPeopleSync(
      { dryRun, selfEmails: [SELF] },
      {
        listSourcePeople: async () => people,
        queryPeople: () => notion.queryPeople(PEOPLE_DS),
        queryMeetings: async () => notion.queryMeetings(MEETINGS_DS),
        createPerson: async (props) => {
          if (failCreates.has(props.sourceId)) throw new Error("notion POST /v1/pages failed: 500");
          return notion.createPersonPage(PEOPLE_DS, props);
        },
        updatePerson: notion.updatePersonProps,
        updateMeetingPeople: notion.updateMeetingPeople,
        notify: async (text: string) => { pings.push(text); },
      },
    );
  }

  /** Every write this world has seen — the quietness assertion's subject. */
  const writes = (): string[] => store.requests
    .filter((r) => r.method !== "POST" || !r.path.endsWith("/query"))
    .map((r) => `${r.method} ${r.path}`);

  const peopleRows = (): Array<{ id: string; email: unknown; sourceId: unknown; name: unknown }> =>
    [...store.pages.values()]
      .filter((p) => p.dataSourceId === PEOPLE_DS)
      .map((p) => {
        const props = p.properties as Record<string, Record<string, unknown> | undefined>;
        const rich = (v: unknown): string => Array.isArray(v)
          ? v.map((i) => String((i as { plain_text?: unknown }).plain_text ?? "")).join("")
          : "";
        return {
          id: p.id,
          email: props.Email?.email,
          sourceId: rich(props["Source ID"]?.rich_text),
          name: rich(props.Name?.title),
        };
      });

  const meetingProps = (id: string): Record<string, unknown> =>
    (store.pages.get(id)?.properties ?? {}) as Record<string, unknown>;

  /** The People page projected for a source record — page ids differ with sort order. */
  const pageOfSource = (sourceId: string): string | undefined =>
    peopleRows().find((r) => r.sourceId === sourceId)?.id;

  return {
    store, tick, writes, peopleRows, meetingProps, pings, failCreates, pageOfSource,
    setSource: (next: SourcePerson[]) => { people = next; },
    seedMeeting: (id: string, props: Parameters<typeof meetingPageProps>[0]) =>
      store.seed(MEETINGS_DS, id, meetingPageProps(props)),
    seedPerson: (id: string, props: Parameters<typeof personPageProps>[0]) =>
      store.seed(PEOPLE_DS, id, personPageProps(props)),
  };
}

describe("the People pass over four ticks", () => {
  it("projects a person and links the meeting ONCE, then goes quiet", async () => {
    const w = world([person()]);
    w.seedMeeting("meet-1", {
      title: "Alex // Bendik",
      attendees: `Alex Partner <alex@partner.example>, Bendik <${SELF}>`,
    });

    const first = await w.tick();
    expect(first).toMatchObject({ created: 1, relationsUpdated: 1, errored: 0 });
    const afterFirst = w.writes();
    expect(afterFirst).toHaveLength(2); // one create, one relation patch

    for (const label of ["tick 2", "tick 3", "tick 4"]) {
      const res = await w.tick();
      expect(res, label).toMatchObject({
        created: 0, updated: 0, relationsUpdated: 0,
        unchanged: 1, relationsUnchanged: 1, errored: 0,
      });
      expect(w.writes(), label).toEqual(afterFirst);
    }

    // ONE People row, and the relation points at it.
    expect(w.peopleRows()).toEqual([
      { id: "notion-page-1", email: "alex@partner.example", sourceId: "crm-1", name: "Alex Partner" },
    ]);
    expect(w.meetingProps("meet-1").People).toEqual({
      relation: [{ id: "notion-page-1" }], has_more: false,
    });
  });

  it("carries a source change through in ONE update, then goes quiet again", async () => {
    const w = world([person()]);
    w.seedMeeting("meet-1", { attendees: `Alex <alex@partner.example>, B <${SELF}>` });
    await w.tick();
    const settled = w.writes().length;

    w.setSource([person({ name: "Alex V. Partner" })]);
    const changed = await w.tick();
    expect(changed).toMatchObject({ updated: 1, created: 0 });
    expect(w.writes()).toHaveLength(settled + 1);

    for (const label of ["tick 3", "tick 4", "tick 5"]) {
      const res = await w.tick();
      expect(res, label).toMatchObject({ created: 0, updated: 0, relationsUpdated: 0 });
      expect(w.writes(), label).toHaveLength(settled + 1);
    }
    expect(w.peopleRows()).toHaveLength(1);
    expect(w.peopleRows()[0]?.name).toBe("Alex V. Partner");
  });

  it("follows a changed email onto the SAME row — never a second person", async () => {
    const w = world([person()]);
    w.seedMeeting("meet-1", { attendees: `Alex <alex@partner.example>, B <${SELF}>` });
    await w.tick();

    // Twenty renames the primary address, and the invite for the next meeting
    // carries the new one.
    w.setSource([person({ email: "stein@newco.io" })]);
    w.seedMeeting("meet-2", { attendees: `Alex <stein@newco.io>, B <${SELF}>` });

    const res = await w.tick();
    // The row's `Email` is its KEY and is never overwritten, so there is nothing to
    // update — and the OLD address keeps resolving, which is what pins the old
    // meeting to the person who was actually in the room (round 1, Important 2).
    expect(res).toMatchObject({ created: 0, updated: 0, unresolved: 0 });
    expect(w.peopleRows()).toEqual([
      { id: "notion-page-1", email: "alex@partner.example", sourceId: "crm-1", name: "Alex Partner" },
    ]);

    const settled = w.writes().length;
    for (const label of ["tick 3", "tick 4", "tick 5"]) {
      await w.tick();
      expect(w.writes(), label).toHaveLength(settled);
    }
    // Both meetings point at the one row, and NEITHER is flagged.
    for (const id of ["meet-1", "meet-2"]) {
      expect(w.meetingProps(id).People, id).toEqual({
        relation: [{ id: "notion-page-1" }], has_more: false,
      });
    }
    // Never flagged: an empty rich_text is Notion's cleared value, written once on
    // tick 1 and never touched again.
    expect(w.meetingProps("meet-1")["People Unmatched"]).toEqual({ rich_text: [] });
  });

  it("REFUSES an address reassigned to a different human, every tick, and links nobody new", async () => {
    // The defect round 1 found: Alice attended as post@acme.no; Twenty later hands
    // that address to Bob. Additive links made the wrong attachment permanent.
    const alice = person({ sourceId: "crm-alice", name: "Alice", email: "post@acme.no" });
    const w = world([alice]);
    w.seedMeeting("meet-1", { attendees: `Alice <post@acme.no>, B <${SELF}>` });
    await w.tick();
    const settled = w.writes().length;
    expect(w.meetingProps("meet-1").People).toEqual({
      relation: [{ id: "notion-page-1" }], has_more: false,
    });

    // Alice is gone from the CRM; Bob now holds her address.
    w.setSource([person({ sourceId: "crm-bob", name: "Bob", email: "post@acme.no" })]);

    for (const label of ["tick 2", "tick 3", "tick 4", "tick 5"]) {
      const res = await w.tick();
      expect(res.skipped, label).toEqual([{
        sourceId: "crm-bob", name: "Bob",
        reason: "People row notion-page-1 already carries Source ID crm-alice",
      }]);
      // Refused on the FIRST tick and every tick after — no two-tick settle, and
      // the contested row is not also reported as forgotten by the source.
      expect(res, label).toMatchObject({ created: 0, updated: 0, unsourced: 0, unresolved: 0 });
      expect(w.writes(), label).toHaveLength(settled);
    }

    // ONE People row, still Alice's, and the meeting still names only her.
    expect(w.peopleRows()).toEqual([
      { id: "notion-page-1", email: "post@acme.no", sourceId: "crm-alice", name: "Alice" },
    ]);
    expect(w.meetingProps("meet-1").People).toEqual({
      relation: [{ id: "notion-page-1" }], has_more: false,
    });
  });

  it("P3: an address reassigned while its owner is STILL in the source attaches nobody new", async () => {
    // The reviewer's exact sequence, and the one a mutable `Email` key gets wrong:
    // Alice stays in Twenty with a NEW address, and Bob is handed her old one. With
    // the key following the source, Alice's row stops holding post@acme.no, Bob's
    // create succeeds on the next tick, and Bob is linked to Alice's meeting.
    const w = world([person({ sourceId: "crm-alice", name: "Alice", email: "post@acme.no" })]);
    w.seedMeeting("m1", { attendees: `Alice <post@acme.no>, B <${SELF}>` });
    await w.tick();
    const settled = w.writes().length;

    w.setSource([
      person({ sourceId: "crm-alice", name: "Alice", email: "alice@newco.io" }),
      person({ sourceId: "crm-bob", name: "Bob", email: "post@acme.no" }),
    ]);

    for (const label of ["tick 2", "tick 3", "tick 4", "tick 5"]) {
      const res = await w.tick();
      expect(res, label).toMatchObject({ created: 0, updated: 0, unresolved: 0, unsourced: 0 });
      expect(res.skipped, label).toEqual([{
        sourceId: "crm-bob", name: "Bob",
        reason: "People row notion-page-1 already carries Source ID crm-alice",
      }]);
      expect(res.lateLinks, label).toEqual([]);
      expect(w.writes(), label).toHaveLength(settled);
      // ONE row, and the meeting names ONLY the person who was in the room.
      expect(w.peopleRows(), label).toHaveLength(1);
      expect(w.meetingProps("m1").People, label).toEqual({
        relation: [{ id: "notion-page-1" }], has_more: false,
      });
    }

    // Alice's NEW address still reaches her row — the key is pinned, not the person.
    w.seedMeeting("m2", { attendees: `Alice <alice@newco.io>, B <${SELF}>` });
    await w.tick();
    expect(w.meetingProps("m2").People).toEqual({
      relation: [{ id: "notion-page-1" }], has_more: false,
    });
  });

  it("never writes a relation Notion could not return whole — and never wedges the row", async () => {
    // 26 verified attendees. Writing them would produce a row this same loop
    // refuses on every later tick, and reports as a success (round 1, Important 1).
    const many = Array.from({ length: 26 }, (_, i) =>
      person({ sourceId: `crm-${String(i).padStart(2, "0")}`, name: `P${i}`, email: `p${i}@x.io` }));
    const w = world(many);
    w.seedMeeting("meet-1", {
      attendees: [...many.map((p) => `${p.name} <${p.email}>`), `B <${SELF}>`].join(", "),
    });

    for (const label of ["tick 1", "tick 2", "tick 3", "tick 4"]) {
      const res = await w.tick();
      expect(res.relationsUpdated, label).toBe(0);
      expect(res.meetingsSkipped, label).toHaveLength(1);
      expect(res.meetingsSkipped[0]?.reason, label).toContain("exceeds Notion's inline relation cap");
    }
    // The people are still projected — only the relation is refused — and the
    // meeting's relation was never written at all.
    expect(w.peopleRows()).toHaveLength(26);
    expect(w.meetingProps("meet-1").People).toBeUndefined();
  });

  it("refuses a relation already AT the cap, whichever way has_more falls", async () => {
    // 25 links present and no `has_more`. Under one shape that is complete; under
    // the other it is the first 25 of more. The pass must be right either way.
    const existing = Array.from({ length: 25 }, (_, i) => `old-${i}`);
    const w = world([person()]);
    w.seedMeeting("meet-1", {
      attendees: `Alex <alex@partner.example>, B <${SELF}>`, people: existing,
    });

    for (const label of ["tick 1", "tick 2", "tick 3", "tick 4"]) {
      const res = await w.tick();
      expect(res.relationsUpdated, label).toBe(0);
      expect(res.meetingsSkipped[0]?.reason, label).toContain("at Notion's inline cap");
      expect(w.meetingProps("meet-1").People, label).toEqual({
        relation: existing.map((id) => ({ id })), has_more: false,
      });
    }
  });

  it("reports a link added to a meeting that had already settled", async () => {
    const w = world([person()]);
    w.seedMeeting("meet-1", {
      attendees: `Alex <alex@partner.example>, Ghost <ghost@nowhere.io>, B <${SELF}>`,
    });
    const first = await w.tick();
    expect(first.lateLinks).toEqual([]);   // nothing to be late to on the first tick

    w.setSource([person(), person({ sourceId: "crm-2", name: "Ghost", email: "ghost@nowhere.io" })]);
    const second = await w.tick();
    expect(second.lateLinks).toEqual([
      { pageId: "meet-1", title: "", emails: ["ghost@nowhere.io"] },
    ]);

    // …and it is reported once, not every tick.
    expect((await w.tick()).lateLinks).toEqual([]);
  });

  it("flags an unresolvable attendee once, and does not re-flag it every tick", async () => {
    const w = world([person()]);
    w.seedMeeting("meet-1", {
      attendees: `Alex <alex@partner.example>, Ghost <ghost@nowhere.io>, B <${SELF}>`,
    });

    const first = await w.tick();
    expect(first).toMatchObject({ unresolved: 1, meetingsFlagged: 1, created: 1 });
    const settled = w.writes().length;

    for (const label of ["tick 2", "tick 3", "tick 4"]) {
      const res = await w.tick();
      // Still flagged — the fact has not changed — but nothing is WRITTEN.
      expect(res, label).toMatchObject({
        unresolved: 1, meetingsFlagged: 1, relationsUpdated: 0, relationsUnchanged: 1,
      });
      expect(w.writes(), label).toHaveLength(settled);
    }

    expect(w.meetingProps("meet-1")["People Unmatched"]).toEqual({
      rich_text: [{ plain_text: "ghost@nowhere.io" }],
    });
    // No placeholder person was invented to satisfy the relation.
    expect(w.peopleRows()).toHaveLength(1);
  });

  it("clears the flag the tick the person appears in the source, then settles", async () => {
    const w = world([person()]);
    w.seedMeeting("meet-1", {
      attendees: `Alex <alex@partner.example>, Ghost <ghost@nowhere.io>, B <${SELF}>`,
    });
    await w.tick();

    w.setSource([person(), person({ sourceId: "crm-2", name: "Ghost", email: "ghost@nowhere.io" })]);
    const res = await w.tick();
    expect(res).toMatchObject({ created: 1, relationsUpdated: 1, unresolved: 0, meetingsFlagged: 0 });
    // An empty rich_text is Notion's own representation of a cleared property —
    // NOT a one-item array holding "" — and plainText() reads it back as "".
    expect(w.meetingProps("meet-1")["People Unmatched"]).toEqual({ rich_text: [] });

    const settled = w.writes().length;
    for (const label of ["tick 3", "tick 4", "tick 5", "tick 6"]) {
      await w.tick();
      expect(w.writes(), label).toHaveLength(settled);
    }
    expect(w.peopleRows()).toHaveLength(2);
  });

  it("never touches a row the source stopped holding — four ticks, zero writes", async () => {
    const w = world([person()]);
    w.seedMeeting("meet-1", { attendees: `Alex <alex@partner.example>, B <${SELF}>` });
    await w.tick();
    const settled = w.writes().length;

    // The person is deleted in the CRM. The meeting still happened.
    w.setSource([person({ sourceId: "crm-2", name: "Someone", email: "someone@else.io" })]);

    for (const label of ["tick 2", "tick 3", "tick 4", "tick 5"]) {
      const res = await w.tick();
      expect(res, label).toMatchObject({ created: 0, updated: 0, unsourced: 1, errored: 0 });
      expect(w.writes(), label).toHaveLength(settled);
    }
    // The row is still there, with everything it had.
    expect(w.peopleRows()).toEqual([
      { id: "notion-page-1", email: "alex@partner.example", sourceId: "crm-1", name: "Alex Partner" },
    ]);
    expect(w.meetingProps("meet-1").People).toEqual({
      relation: [{ id: "notion-page-1" }], has_more: false,
    });
  });

  it("keeps a hand-made People row and its link, and adopts it only when the source knows them", async () => {
    const w = world([]);
    // Bendik made this row himself for someone who is deliberately not in the CRM.
    w.seedPerson("hand-1", { name: "Ada Lovelace", email: "ada@analytical.io" });
    w.seedMeeting("meet-1", {
      attendees: `Ada <ada@analytical.io>, B <${SELF}>`, people: ["hand-1"],
    });

    for (const label of ["tick 1", "tick 2", "tick 3", "tick 4"]) {
      const res = await w.tick();
      expect(res, label).toMatchObject({
        created: 0, updated: 0, unsourced: 1,
        relationsUpdated: 0, relationsUnchanged: 1, unresolved: 0,
      });
      expect(w.writes(), label).toEqual([]);
    }

    // The CRM later learns about her: the row is ADOPTED, not duplicated.
    w.setSource([person({ sourceId: "crm-7", name: "Ada Lovelace", email: "ada@analytical.io" })]);
    const adopted = await w.tick();
    expect(adopted).toMatchObject({ created: 0, updated: 1 });
    expect(w.peopleRows()).toEqual([
      { id: "hand-1", email: "ada@analytical.io", sourceId: "crm-7", name: "Ada Lovelace" },
    ]);

    const settled = w.writes().length;
    for (const label of ["tick 6", "tick 7", "tick 8"]) {
      await w.tick();
      expect(w.writes(), label).toHaveLength(settled);
    }
  });

  it("refuses a truncated relation every tick without ever writing to it", async () => {
    const w = world([person()]);
    w.seedMeeting("meet-1", {
      attendees: `Alex <alex@partner.example>, B <${SELF}>`,
      people: ["someone-else"], peopleTruncated: true,
    });

    for (const label of ["tick 1", "tick 2", "tick 3", "tick 4"]) {
      const res = await w.tick();
      expect(res.meetingsSkipped, label).toHaveLength(1);
      expect(res.relationsUpdated, label).toBe(0);
    }
    // The person is still projected — only the relation is refused.
    expect(w.peopleRows()).toHaveLength(1);
    expect(w.meetingProps("meet-1").People).toEqual({
      relation: [{ id: "someone-else" }], has_more: true,
    });
  });

  it("a dry-run tick writes nothing and leaves the next live tick with the same work", async () => {
    const w = world([person()]);
    w.seedMeeting("meet-1", { attendees: `Alex <alex@partner.example>, B <${SELF}>` });

    const preview = await w.tick(true);
    expect(w.writes()).toEqual([]);
    const live = await w.tick();
    expect(live.created).toBe(preview.created);
    expect(live.relationsUpdated).toBe(preview.relationsUpdated);
    expect(live.unresolved).toBe(preview.unresolved);

    for (const label of ["tick 3", "tick 4", "tick 5"]) {
      const res = await w.tick();
      expect(res, label).toMatchObject({ created: 0, relationsUpdated: 0 });
    }
  });

  it("two meetings sharing a person produce ONE row and two links", async () => {
    const w = world([person()]);
    w.seedMeeting("meet-1", { attendees: `Alex <alex@partner.example>, B <${SELF}>` });
    w.seedMeeting("meet-2", { attendees: `Alex <ALEX@PARTNER.EXAMPLE>, B <${SELF}>` });

    const first = await w.tick();
    expect(first).toMatchObject({ created: 1, relationsUpdated: 2 });
    expect(w.peopleRows()).toHaveLength(1);

    const settled = w.writes().length;
    for (const label of ["tick 2", "tick 3", "tick 4"]) {
      await w.tick();
      expect(w.writes(), label).toHaveLength(settled);
    }
    for (const id of ["meet-1", "meet-2"]) {
      expect(w.meetingProps(id).People, id).toEqual({
        relation: [{ id: "notion-page-1" }], has_more: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// F6 (round 2): the RUNTIME binding, not just the stored key. Three sequences
// nothing ran before — each is quiet for two ticks and wrong on the third.
// ---------------------------------------------------------------------------
describe("an address moved between people who BOTH already have rows", () => {
  const alice = (email: string): SourcePerson =>
    person({ sourceId: "crm-alice", name: "Alice", email });
  const bob = (email: string): SourcePerson =>
    person({ sourceId: "crm-bob", name: "Bob", email });

  /** Both people projected, each with their own meeting. Alice sorts first. */
  function settled() {
    const w = world([alice("alice@acme.no"), bob("post@acme.no")]);
    w.seedMeeting("m-alice", { title: "A", attendees: `Alice <alice@acme.no>, B <${SELF}>` });
    w.seedMeeting("m-bob", { title: "B", attendees: `Bob <post@acme.no>, B <${SELF}>` });
    return w;
  }

  it("STEAL: a new hire inheriting a departed colleague's address attaches to nothing of his", async () => {
    const w = settled();
    await w.tick();
    const settledWrites = w.writes().length;
    expect(w.meetingProps("m-bob").People).toEqual({
      relation: [{ id: "notion-page-2" }], has_more: false,
    });

    // Bob leaves; Alice inherits post@acme.no. She already has a row, so the
    // projection loop matches her by Source ID and its own collision guard is
    // never reached — this is the hole the primary binding used to leave open.
    w.setSource([alice("post@acme.no")]);

    for (const label of ["tick 2", "tick 3", "tick 4", "tick 5"]) {
      const res = await w.tick();
      expect(res.contestedAddresses, label).toEqual([{
        email: "post@acme.no", boundTo: "notion-page-2", boundBy: "crm-bob",
        alsoClaimedBy: ["crm-alice"],
      }]);
      expect(res.lateLinks, label).toEqual([]);
      expect(w.writes(), label).toHaveLength(settledWrites);
      // Bob's meeting still names Bob, and ONLY Bob.
      expect(w.meetingProps("m-bob").People, label).toEqual({
        relation: [{ id: "notion-page-2" }], has_more: false,
      });
    }
    expect(w.peopleRows()).toHaveLength(2);
  });

  it("SWAP: two people exchanging addresses attach to nothing of each other's", async () => {
    const w = settled();
    await w.tick();
    const settledWrites = w.writes().length;

    w.setSource([alice("post@acme.no"), bob("alice@acme.no")]);

    for (const label of ["tick 2", "tick 3", "tick 4", "tick 5"]) {
      const res = await w.tick();
      expect(res.contestedAddresses.map((c) => c.email).sort(), label)
        .toEqual(["alice@acme.no", "post@acme.no"]);
      expect(w.writes(), label).toHaveLength(settledWrites);
      expect(w.meetingProps("m-alice").People, label).toEqual({
        relation: [{ id: "notion-page-1" }], has_more: false,
      });
      expect(w.meetingProps("m-bob").People, label).toEqual({
        relation: [{ id: "notion-page-2" }], has_more: false,
      });
    }
  });

  it("TIEBREAK: two records claiming one NEW address settle the same way every tick, and say so", async () => {
    const w = settled();
    await w.tick();
    const settledWrites = w.writes().length;

    // Neither row holds shared@acme.no, so nothing seeds the binding — the winner
    // is decided inside the pass. It must be the same winner every tick, and the
    // loser must be named rather than silently overwritten.
    w.setSource([
      { ...alice("alice@acme.no"), otherEmails: ["shared@acme.no"] },
      { ...bob("post@acme.no"), otherEmails: ["shared@acme.no"] },
    ]);
    w.seedMeeting("m-shared", { title: "S", attendees: `X <shared@acme.no>, B <${SELF}>` });

    const first = await w.tick();
    // Deterministic: the record that sorts first binds it.
    expect(first.contestedAddresses).toEqual([{
      email: "shared@acme.no", boundTo: "notion-page-1", boundBy: "crm-alice",
      alsoClaimedBy: ["crm-bob"],
    }]);
    const after = w.writes().length;
    expect(after).toBe(settledWrites + 1);   // only m-shared's own relation

    for (const label of ["tick 3", "tick 4", "tick 5"]) {
      const res = await w.tick();
      expect(res.contestedAddresses[0]?.boundTo, label).toBe("notion-page-1");
      expect(w.writes(), label).toHaveLength(after);
    }
    expect(w.meetingProps("m-shared").People).toEqual({
      relation: [{ id: "notion-page-1" }], has_more: false,
    });
  });
});

describe("round 2 — the reports that have to leave the container", () => {
  it("pings the spine when a settled meeting gains a link, naming the meeting and the address", async () => {
    const w = world([person()]);
    w.seedMeeting("m1", {
      title: "Ukesmøte",
      attendees: `Alex <alex@partner.example>, Ghost <ghost@nowhere.io>, B <${SELF}>`,
    });
    await w.tick();
    expect(w.pings).toEqual([]);

    w.setSource([person(), person({ sourceId: "crm-2", name: "Ghost", email: "ghost@nowhere.io" })]);
    await w.tick();

    expect(w.pings).toHaveLength(1);
    // Both identifiers present — the spine dedupes on a 24h fingerprint over the
    // message text, so distinct cases must read distinctly.
    expect(w.pings[0]).toContain("m1");
    expect(w.pings[0]).toContain("ghost@nowhere.io");
    expect(w.pings[0]).toContain("Ukesmøte");

    await w.tick();
    expect(w.pings).toHaveLength(1);   // reported once, not every tick
  });

  it("adopts a hand-made row the source renames — and reports and pings the rename", async () => {
    const w = world([]);
    w.seedPerson("hand-1", { name: "Alice", email: "post@acme.no" });
    w.seedMeeting("m1", { title: "Old", attendees: `Alice <post@acme.no>, B <${SELF}>`, people: ["hand-1"] });
    await w.tick();

    // The CRM later hands that address to somebody else entirely.
    w.setSource([person({ sourceId: "crm-bob", name: "Bob", email: "post@acme.no" })]);
    const res = await w.tick();

    expect(res.relabelled).toEqual([
      { pageId: "hand-1", from: "Alice", to: "Bob", sourceId: "crm-bob" },
    ]);
    expect(w.pings.some((p) => p.includes("hand-1") && p.includes("Bob"))).toBe(true);
    // No SECOND row and no second link — adoption keeps the key and the page.
    expect(w.peopleRows()).toHaveLength(1);
    expect(w.meetingProps("m1").People).toEqual({ relation: [{ id: "hand-1" }], has_more: false });

    const settled = w.writes().length;
    for (const label of ["tick 3", "tick 4", "tick 5"]) {
      const again = await w.tick();
      expect(again.relabelled, label).toEqual([]);
      expect(w.writes(), label).toHaveLength(settled);
    }
  });

  it("a directory-style name with a comma never becomes a phantom unmatched attendee", async () => {
    const w = world([person()]);
    w.seedMeeting("m1", {
      title: "Ukesmøte",
      attendees: `Partner, Alex <alex@partner.example>, Heiberg, Bendik <${SELF}>`,
    });

    const first = await w.tick();
    expect(first).toMatchObject({ created: 1, unresolved: 0, meetingsFlagged: 0 });

    const settled = w.writes().length;
    for (const label of ["tick 2", "tick 3", "tick 4"]) {
      const res = await w.tick();
      expect(res, label).toMatchObject({ unresolved: 0, meetingsFlagged: 0, relationsUpdated: 0 });
      expect(w.writes(), label).toHaveLength(settled);
    }
    expect(w.meetingProps("m1")["People Unmatched"]).toEqual({ rich_text: [] });
    expect(w.meetingProps("m1").People).toEqual({
      relation: [{ id: "notion-page-1" }], has_more: false,
    });
  });

  it("still flags a bare name written after the last address", async () => {
    const w = world([person()]);
    w.seedMeeting("m1", { attendees: `Alex <alex@partner.example>, B <${SELF}>, Someone Unlisted` });
    const res = await w.tick();

    expect(res).toMatchObject({ unresolved: 1, meetingsFlagged: 1 });
    expect(w.meetingProps("m1")["People Unmatched"]).toEqual({
      rich_text: [{ plain_text: "Someone Unlisted" }],
    });
  });
});

// ---------------------------------------------------------------------------
// F7 / round 4: an address one record holds as an ALIAS and another as its
// PRIMARY. Round 3 refused the create and left the address with the alias holder,
// so the meeting read `People=[alias holder]` with an EMPTY flag — §8's exact
// failure. Round 4's third level of the claim order settles it on the data
// instead of on Twenty's record ids:
//
//     stored row key  >  source primary  >  source alias
// ---------------------------------------------------------------------------
describe("an address one record holds as an alias and another as its primary", () => {
  const ALICE_MEETING = "m-alice";
  const SHARED_MEETING = "m-shared";

  /**
   * `aliceId` holds `post@acme.no` among her ADDITIONAL addresses; `carolId` holds
   * it as her PRIMARY. The two ids decide the sort order and nothing else — which
   * is the whole point of running this both ways round.
   */
  function world7(aliceId: string, carolId: string) {
    const w = world([
      { ...person({ sourceId: aliceId, name: "Alice", email: "alice@acme.no" }),
        otherEmails: ["post@acme.no"] },
      person({ sourceId: carolId, name: "Carol", email: "post@acme.no" }),
    ]);
    w.seedMeeting(ALICE_MEETING, { title: "A", attendees: `Alice <alice@acme.no>, B <${SELF}>` });
    w.seedMeeting(SHARED_MEETING, { title: "Kickoff", attendees: `Carol <post@acme.no>, B <${SELF}>` });
    return w;
  }

  for (const [label, aliceId, carolId] of [
    ["alias holder sorts first", "crm-alice", "crm-carol"],
    ["primary holder sorts first", "crm-zalice", "crm-acarol"],
  ] as const) {
    it(`links the meeting to whoever OWNS the address — ${label}`, async () => {
      const w = world7(aliceId, carolId);

      for (const tick of ["tick 1", "tick 2", "tick 3", "tick 4", "tick 5"]) {
        const res = await w.tick();
        const carol = w.pageOfSource(carolId);
        const alice = w.pageOfSource(aliceId);
        expect(carol, `${tick}: carol projected`).toBeDefined();

        // The kickoff names the person whose IDENTITY that address is — the same
        // answer in both sort orders, which is what makes it a fact about the data.
        expect(w.meetingProps(SHARED_MEETING).People, tick).toEqual({
          relation: [{ id: carol }], has_more: false,
        });
        expect(w.meetingProps(ALICE_MEETING).People, tick).toEqual({
          relation: [{ id: alice }], has_more: false,
        });
        // …and it is not blank-with-a-clean-flag, nor flagged: it is right.
        expect(res.unresolved, tick).toBe(0);
        // The refused ALIAS claim is reported, and the owner never changes.
        expect(res.contestedAddresses, tick).toHaveLength(1);
        expect(res.contestedAddresses[0]?.email, tick).toBe("post@acme.no");
        expect(res.contestedAddresses[0]?.boundBy, tick).toBe(carolId);
        expect(res.contestedAddresses[0]?.alsoClaimedBy, tick).toEqual([aliceId]);
      }

      // Two rows, one per source record — and quiet after the first tick.
      expect(w.peopleRows()).toHaveLength(2);
      const settled = w.writes().length;
      await w.tick();
      expect(w.writes()).toHaveLength(settled);
    });
  }

  it("F6 REGRESSION: a primary still cannot take an address a stored row KEY holds", async () => {
    // The inverse of the round-4 rule, and the thing it must never become. Bob's
    // row is keyed on post@acme.no; Alice's record is later handed it as her
    // PRIMARY. Level 1 outranks level 2, so nothing moves.
    const w = world([
      person({ sourceId: "crm-alice", name: "Alice", email: "alice@acme.no" }),
      person({ sourceId: "crm-bob", name: "Bob", email: "post@acme.no" }),
    ]);
    w.seedMeeting("m-alice", { title: "A", attendees: `Alice <alice@acme.no>, B <${SELF}>` });
    w.seedMeeting("m-bob", { title: "B", attendees: `Bob <post@acme.no>, B <${SELF}>` });
    await w.tick();
    const bobPage = w.pageOfSource("crm-bob");
    const settled = w.writes().length;

    // Bob leaves; Alice inherits the address as her PRIMARY.
    w.setSource([person({ sourceId: "crm-alice", name: "Alice", email: "post@acme.no" })]);

    for (const tick of ["tick 2", "tick 3", "tick 4", "tick 5", "tick 6"]) {
      const res = await w.tick();
      expect(res.contestedAddresses, tick).toEqual([{
        email: "post@acme.no", boundTo: bobPage as string, boundBy: "crm-bob",
        alsoClaimedBy: ["crm-alice"],
      }]);
      expect(w.writes(), tick).toHaveLength(settled);
      expect(w.meetingProps("m-bob").People, tick).toEqual({
        relation: [{ id: bobPage }], has_more: false,
      });
    }
    expect(w.peopleRows()).toHaveLength(2);
  });

  it("is unmoved when the alias holder vanishes from the source for a tick", async () => {
    const w = world7("crm-alice", "crm-carol");
    await w.tick();
    const carol = w.pageOfSource("crm-carol");
    const settled = w.writes().length;

    // A partial source read, an offboarding, a filter change — Alice is simply not
    // there this tick. Nothing about who owns the address may move because of it.
    w.setSource([person({ sourceId: "crm-carol", name: "Carol", email: "post@acme.no" })]);
    for (const tick of ["tick 2", "tick 3", "tick 4"]) {
      const res = await w.tick();
      expect(res.unsourced, tick).toBe(1);
      expect(w.writes(), tick).toHaveLength(settled);
      expect(w.meetingProps(SHARED_MEETING).People, tick).toEqual({
        relation: [{ id: carol }], has_more: false,
      });
    }

    // …and when she comes back, the contested report comes back with her.
    w.setSource([
      { ...person({ sourceId: "crm-alice", name: "Alice", email: "alice@acme.no" }),
        otherEmails: ["post@acme.no"] },
      person({ sourceId: "crm-carol", name: "Carol", email: "post@acme.no" }),
    ]);
    const back = await w.tick();
    expect(back.contestedAddresses[0]?.boundBy).toBe("crm-carol");
    expect(w.writes()).toHaveLength(settled);
  });

  it("leaves the meeting blank AND flagged when the owner's create fails — then heals", async () => {
    const w = world7("crm-alice", "crm-carol");
    w.failCreates.add("crm-carol");

    const first = await w.tick();
    expect(first.errored).toBe(1);
    // Blank and flagged — never the alias holder. §8's rule under a failed write.
    expect(w.meetingProps(SHARED_MEETING).People).toEqual({ relation: [], has_more: false });
    expect(w.meetingProps(SHARED_MEETING)["People Unmatched"]).toEqual({
      rich_text: [{ plain_text: "post@acme.no" }],
    });
    expect(first).toMatchObject({ unresolved: 1, meetingsFlagged: 1 });

    w.failCreates.clear();
    const healed = await w.tick();
    expect(healed.created).toBe(1);
    expect(w.meetingProps(SHARED_MEETING).People).toEqual({
      relation: [{ id: w.pageOfSource("crm-carol") }], has_more: false,
    });
    expect(w.meetingProps(SHARED_MEETING)["People Unmatched"]).toEqual({ rich_text: [] });

    const settled = w.writes().length;
    for (const tick of ["tick 3", "tick 4", "tick 5"]) {
      await w.tick();
      expect(w.writes(), tick).toHaveLength(settled);
    }
  });
});

describe("F8 — dry-run is silent", () => {
  it("sends no ping at all, however many dry ticks are run", async () => {
    const w = world([person()]);
    w.seedMeeting("m1", {
      title: "Ukesmøte",
      attendees: `Alex <alex@partner.example>, Ghost <ghost@nowhere.io>, B <${SELF}>`,
    });
    await w.tick();
    w.setSource([person(), person({ sourceId: "crm-2", name: "Ghost", email: "ghost@nowhere.io" })]);

    // A live tick here WOULD ping — that is what makes the silence meaningful.
    for (const label of ["dry 1", "dry 2", "dry 3"]) {
      const res = await w.tick(true);
      expect(res.lateLinks, label).toHaveLength(1);   // still PLANNED, and reported
      expect(w.pings, label).toEqual([]);
    }
    await w.tick();
    expect(w.pings).toHaveLength(1);
  });

  it("sends no relabel ping in dry-run either", async () => {
    const w = world([]);
    w.seedPerson("hand-1", { name: "Alice", email: "post@acme.no" });
    w.seedMeeting("m1", { attendees: `Alice <post@acme.no>, B <${SELF}>`, people: ["hand-1"] });
    await w.tick();
    w.setSource([person({ sourceId: "crm-bob", name: "Bob", email: "post@acme.no" })]);

    const res = await w.tick(true);
    expect(res.relabelled).toHaveLength(1);
    expect(w.pings).toEqual([]);
  });
});

describe("an adopted hand-made row's address", () => {
  it("is defended against a later ALIAS claim, and the owner is named", async () => {
    // Round 3 used this to pin the `held === pageId` arm. Round 4's claim order
    // now answers the same question from `primaryOf`, so the arm no longer
    // discriminates (mutation-verified: removing it fails nothing). The BEHAVIOUR
    // is still worth pinning, and that is what this asserts.
    const w = world([]);
    w.seedPerson("hand-1", { name: "Ada", email: "ada@x.io" });
    w.seedMeeting("m1", { attendees: `Ada <ada@x.io>, B <${SELF}>`, people: ["hand-1"] });
    await w.tick();

    w.setSource([
      person({ sourceId: "crm-a", name: "Ada", email: "ada@x.io" }),
      { ...person({ sourceId: "crm-b", name: "Other", email: "other@x.io" }),
        otherEmails: ["ada@x.io"] },
    ]);
    w.seedMeeting("m2", { attendees: `Other <other@x.io>, B <${SELF}>` });

    const res = await w.tick();
    expect(res.contestedAddresses).toEqual([{
      email: "ada@x.io", boundTo: "hand-1", boundBy: "crm-a", alsoClaimedBy: ["crm-b"],
    }]);
  });
});
