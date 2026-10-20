import { describe, it, expect } from "vitest";
import { makePersonSources } from "../lib/person-sources.js";
import { SEARCH_WINDOW_DAYS } from "../lib/person/types.js";
import type { PersonWiring } from "../lib/person-sources.js";

/**
 * The ADAPTER LOGIC inside `makePersonSources` (crm/mail/meetings/transcripts/
 * company), exercised against a stub `PersonWiring` — no real Twenty/Gmail/Calendar/
 * vault involved. See lib/person-sources.ts's header for the fan-out logic.
 *
 * `twentyGet` (lib/twenty-client.ts) never swallows a degraded sub-query into a `warnings` field —
 * it throws `TwentyUnavailableError` directly — so `TwentyLookupResult` here
 * has no `warnings` field, and the "degraded lookup vs clean empty" distinction is now expressed
 * as "the stub throws" vs "the stub returns {people:[],companies:[]} cleanly".
 *
 * tests/person-lookup.test.ts covers the OTHER half: that `eveSagaPersonWiring()` actually calls
 * the chief of staff's real clients (identity-client, twenty tools, google.ts, notes-store) with the right shapes, plus one end-to-end `person_lookup` tool test.
 */

// A TwentyPersonLite (catalogue/twenty_lookup.ts) always carries a non-null `name` in
// practice (chief-of-staff's `mapPerson` synthesises one) — this fixture matches that.
const wiring: PersonWiring = {
  myAddresses: async () => ["owner@owner.example", "owner@project.example"],
  twentyLookup: async () => ({
    people: [{ id: "p1", name: "Per Hansen", email: "per@partner.example", companyId: null }],
    companies: [],
  }),
  twentyCompanyForPerson: async () => null,
  mailSearch: async () => ["m1"],
  mailRead: async () => ({
    id: "m1", threadId: "t1", from: "Per <per@partner.example>", to: ["owner@owner.example"],
    subject: "Pilot", bodyText: "…", sentAt: "2026-07-15T10:00:00Z", messageId: "<a>", references: "",
    isCalendarNotice: false,
  }),
  listEvents: async () => [],
  vaultSearch: async () => [],
  vaultRead: async () => "",
  atlasSearch: async () => [],
  crmCompanyByDomain: async () => null,
};

describe("makePersonSources", () => {
  it("maps a Twenty hit into a Candidate", async () => {
    const s = makePersonSources(wiring);
    const found = await s.crm({ name: "Per Hansen" });
    expect(found[0]).toMatchObject({ source: "twenty", sourceId: "p1", displayName: "Per Hansen", emails: ["per@partner.example"] });
  });

  it("marks a thread as owed when the last message is theirs", async () => {
    const s = makePersonSources(wiring);
    const mail = await s.mail(
      { source: "twenty", sourceId: "p1", displayName: "Per", emails: ["per@partner.example"] },
      ["owner@owner.example"],
    );
    expect(mail[0]!.lastSpeakerIsThem).toBe(true);
    expect(mail[0]!.fromThem).toBe(true);
  });

  it("does NOT mark a thread as owed when the owner sent the last message from a SECOND address", async () => {
    const s = makePersonSources({
      ...wiring,
      mailRead: async () => ({
        id: "m1", threadId: "t1", from: "Test Owner <owner@project.example>", to: ["per@partner.example"],
        subject: "Pilot", bodyText: "…", sentAt: "2026-07-15T10:00:00Z", messageId: "<a>", references: "",
        isCalendarNotice: false,
      }),
    });
    const mail = await s.mail(
      { source: "twenty", sourceId: "p1", displayName: "Per", emails: ["per@partner.example"] },
      ["owner@owner.example", "owner@project.example"],
    );
    expect(mail[0]!.lastSpeakerIsThem).toBe(false);
    expect(mail[0]!.fromThem).toBe(false);
  });

  it("skips calendar-notice mail — an RSVP is not a reply", async () => {
    const s = makePersonSources({
      ...wiring,
      mailRead: async () => ({
        id: "m1", threadId: "t1", from: "Per <per@partner.example>", to: ["owner@owner.example"],
        subject: "Godtatt: Pilot", bodyText: "", sentAt: "2026-07-15T10:00:00Z", messageId: "<a>", references: "",
        isCalendarNotice: true,
      }),
    });
    const mail = await s.mail(
      { source: "twenty", sourceId: "p1", displayName: "Per", emails: ["per@partner.example"] },
      ["owner@owner.example"],
    );
    expect(mail).toEqual([]);
  });

  it("meetings: keeps only events where the person is an attendee — the real calendar client has no server-side filter, so getting this wrong leaks every meeting the owner has into every person's dossier", async () => {
    const s = makePersonSources({
      ...wiring,
      listEvents: async () => [
        { id: "e1", summary: "Pilot sync", start: "2026-07-20T09:00:00Z", end: "2026-07-20T09:30:00Z", attendees: [{ email: "per@partner.example" }] },
        { id: "e2", summary: "Unrelated 1:1", start: "2026-07-21T09:00:00Z", end: "2026-07-21T09:30:00Z", attendees: [{ email: "someone-else@example.com" }] },
        { id: "e3", summary: "No attendees logged", start: "2026-07-22T09:00:00Z", end: "2026-07-22T09:30:00Z" },
      ],
    });
    const meetings = await s.meetings(
      { source: "twenty", sourceId: "p1", displayName: "Per", emails: ["per@partner.example"] },
      ["owner@owner.example"],
    );
    expect(meetings.map((m) => m.eventId)).toEqual(["e1"]);
  });

  // ---------------------------------------------------------------------------------------
  // The uniform rule for every source in this file — when a source cannot determine its
  // answer, it must THROW, so gather.ts's attempt() reports it as failed ("COULD NOT READ"),
  // not empty ("nothing found", a claim about the world).
  // ---------------------------------------------------------------------------------------

  it("meetings: throws when the window returns the maximum event count — a full page means the newest events are missing, not that there are few", async () => {
    const full = Array.from({ length: 250 }, (_, i) => ({
      id: `e${i}`, summary: "Busy", start: "2026-07-20T09:00:00Z", end: "2026-07-20T09:30:00Z",
      attendees: [{ email: "per@partner.example" }],
    }));
    const s = makePersonSources({ ...wiring, listEvents: async () => full });
    await expect(s.meetings(
      { source: "twenty", sourceId: "p1", displayName: "Per", emails: ["per@partner.example"] },
      ["owner@owner.example"],
    )).rejects.toThrow(/maximum 250 events/);
  });

  it("mail: throws when the person has no email address — resolve.ts can hand back a candidate with none", async () => {
    const s = makePersonSources(wiring);
    await expect(s.mail(
      { source: "twenty", sourceId: "p1", displayName: "Nameless Only", emails: [] },
      ["owner@owner.example"],
    )).rejects.toThrow(/no email address/);
  });

  it("meetings: throws when the person has no email address", async () => {
    const s = makePersonSources(wiring);
    await expect(s.meetings(
      { source: "twenty", sourceId: "p1", displayName: "Nameless Only", emails: [] },
      ["owner@owner.example"],
    )).rejects.toThrow(/no email address/);
  });

  it("mail: throws when the identity registry returned no addresses — otherwise every thread looks owed", async () => {
    const s = makePersonSources(wiring);
    await expect(s.mail(
      { source: "twenty", sourceId: "p1", displayName: "Per", emails: ["per@partner.example"] },
      [],
    )).rejects.toThrow(/no addresses for the owner/);
  });

  it("company: resolves a Twenty-sourced person's company NAME via twentyCompanyForPerson — Twenty's own record only carries a companyId, never a name", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyCompanyForPerson: async (id) => (id === "p1" ? "Northwind Audio" : null),
    });
    const facts = await s.company({ source: "twenty", sourceId: "p1", displayName: "Per", emails: ["per@partner.example"] });
    expect(facts).toMatchObject({ name: "Northwind Audio" });
  });

  it("company: does not consult Twenty for a non-Twenty-sourced candidate with no company hint", async () => {
    const calls: string[] = [];
    const s = makePersonSources({
      ...wiring,
      twentyCompanyForPerson: async (id) => { calls.push(id); return "should not be called"; },
    });
    const facts = await s.company({ source: "other", sourceId: "c42", displayName: "Per", emails: ["per@partner.example"] });
    expect(facts).toBeNull();
    expect(calls).toEqual([]);
  });

  it("crm: throws when Twenty returned records but every one was dropped for lacking a usable name — Twenty DID find people, we failed to read them", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async () => ({
        people: [
          { id: "p1", name: "", email: "per@partner.example", companyId: null },
          { id: "p2", name: "   ", email: null, companyId: null },
        ],
        companies: [],
      }),
    });
    await expect(s.crm({ name: "Per Hansen" })).rejects.toThrow(/Twenty returned 2 records but none carried a usable name/);
  });

  // ---------------------------------------------------------------------------------------
  // A plural `emails` query has no single search term: crm() looks up EVERY
  // address and merge.
  // ---------------------------------------------------------------------------------------

  it("crm: a plural `emails` query looks up EACH address and unions the results by sourceId", async () => {
    const seenQueries: string[] = [];
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async ({ query }) => {
        seenQueries.push(query);
        if (query === "per@partner.example") return { people: [{ id: "p1", name: "Per Hansen", email: "per@partner.example", companyId: null }], companies: [] };
        if (query === "per@newco.example") return { people: [{ id: "p2", name: "Per Hansen", email: "per@newco.example", companyId: null }], companies: [] };
        return { people: [], companies: [] };
      },
    });
    const found = await s.crm({ emails: ["per@partner.example", "per@newco.example"] });
    expect(seenQueries).toEqual(["per@partner.example", "per@newco.example"]);
    expect(found.map((c) => c.sourceId).sort()).toEqual(["p1", "p2"]);
  });

  it("crm: a plural `emails` query de-duplicates the same Twenty record found via more than one address", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async () => ({ people: [{ id: "p1", name: "Per Hansen", email: "per@partner.example", companyId: null }], companies: [] }),
    });
    const found = await s.crm({ emails: ["per@partner.example", "per@newco.example"] });
    expect(found).toHaveLength(1);
  });

  it("crm: a Twenty lookup that THROWS propagates as a plain failure, not an empty result", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async () => { throw new Error("Twenty GET /people → 503"); },
    });
    await expect(s.crm({ name: "Per Hansen" })).rejects.toThrow(/503/);
  });

  // ---------------------------------------------------------------------------------------
  // A multi-address `emails` merge query must
  // tolerate ONE term's lookup throwing as long as another term still finds a real candidate
  // — a "partial read that found someone despite one degraded sub-query is still a find",
  // and a plain `Promise.all` would lose it.
  // ---------------------------------------------------------------------------------------

  it("crm: a plural `emails` query still succeeds when the FIRST address's Twenty lookup throws but the SECOND finds a real candidate", async () => {
    const seenQueries: string[] = [];
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async ({ query }) => {
        seenQueries.push(query);
        if (query === "per@partner.example") throw new Error("Twenty GET /people → 503");
        if (query === "per@newco.example") return { people: [{ id: "p2", name: "Per Hansen", email: "per@newco.example", companyId: null }], companies: [] };
        return { people: [], companies: [] };
      },
    });
    const found = await s.crm({ emails: ["per@partner.example", "per@newco.example"] });
    expect(seenQueries).toEqual(["per@partner.example", "per@newco.example"]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ source: "twenty", sourceId: "p2", displayName: "Per Hansen" });
  });

  it("crm: a plural `emails` query still throws when EVERY address either errors or finds nothing (one erroring term, one clean-empty term)", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async ({ query }) => {
        if (query === "per@partner.example") throw new Error("Twenty GET /people → 503");
        return { people: [], companies: [] };
      },
    });
    // Only one term actually errored (the other was a clean miss), so the original error
    // rethrows unwrapped — same message shape as the single-term throw case above.
    await expect(s.crm({ emails: ["per@partner.example", "per@newco.example"] })).rejects.toThrow(/503/);
  });

  it("crm: a plural `emails` query throws a combined message naming every address when ALL of them error", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async ({ query }) => {
        if (query === "per@partner.example") throw new Error("Twenty GET /people → 503");
        throw new Error("Twenty GET /people → 401 Unauthorized");
      },
    });
    await expect(s.crm({ emails: ["per@partner.example", "per@newco.example"] }))
      .rejects.toThrow(/Twenty lookup failed on 2 of 2 addresses.*503.*401 Unauthorized/s);
  });

  // The render quotes these windows so an empty result reads as "nothing in the window", not
  // "nothing ever". If the adapter ever stops searching the window the render names, the
  // sentence becomes false — which is the whole defect, restored by a copy-paste.
  it("mail and calendar search exactly the windows the render tells the owner about", async () => {
    const seenMailQueries: string[] = [];
    let seenWindow: { timeMin: string; timeMax: string } | null = null;
    const s = makePersonSources({
      ...wiring,
      mailSearch: async (q) => { seenMailQueries.push(q); return []; },
      listEvents: async (o) => { seenWindow = { timeMin: o.timeMin, timeMax: o.timeMax }; return []; },
    });
    const per = { source: "twenty", sourceId: "p1", displayName: "Per", emails: ["per@partner.example"] };
    await s.mail(per, ["owner@owner.example"]);
    await s.meetings(per, ["owner@owner.example"]);

    expect(seenMailQueries[0]).toContain(`newer_than:${SEARCH_WINDOW_DAYS.mail}d`);
    const w = seenWindow as unknown as { timeMin: string; timeMax: string };
    const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
    expect(days(w.timeMin, new Date().toISOString())).toBe(SEARCH_WINDOW_DAYS.calendarBack);
    expect(days(new Date().toISOString(), w.timeMax)).toBe(SEARCH_WINDOW_DAYS.calendarAhead);
  });
});

/**
 * — the `organisation` source: both note stores and the CRM, asked by company NAME and
 * mail DOMAIN rather than by human.
 */
describe("makePersonSources.organisation", () => {
  it("searches BOTH stores, by name and by domain, and marks every hit with its store", async () => {
    const brain: string[] = [];
    const atlas: string[] = [];
    const s = makePersonSources({
      ...wiring,
      vaultSearch: async (q) => { brain.push(q); return q === "Bridgeco" ? ["tools/bridgeco.md"] : []; },
      atlasSearch: async (q) => { atlas.push(q); return q === "atbridgeco.example" ? ["ventures/vera/bridge.md"] : []; },
    });
    const facts = await s.organisation({ name: "Bridgeco", domain: "atbridgeco.example" });
    expect(facts?.notes).toEqual([
      { store: "brain", path: "tools/bridgeco.md" },
      { store: "atlas", path: "ventures/vera/bridge.md" },
    ]);
    // Name, domain, and the domain's bare label — in both stores.
    expect(brain).toEqual(["Bridgeco", "atbridgeco.example", "atbridgeco"]);
    expect(atlas).toEqual(["Bridgeco", "atbridgeco.example", "atbridgeco"]);
  });

  it("echoes back what it actually asked — after the CRM had its say", async () => {
    const s = makePersonSources({ ...wiring, vaultSearch: async () => ["a.md"] });
    const facts = await s.organisation({ name: "Bridgeco", domain: "atbridgeco.example" });
    expect(facts?.asked).toEqual({ name: "Bridgeco", domain: "atbridgeco.example" });
  });

  it("looks the CRM company up BY DOMAIN, never by name", async () => {
    const asked: string[] = [];
    const s = makePersonSources({
      ...wiring,
      crmCompanyByDomain: async (d) => { asked.push(d); return { name: "Bridgeco", domain: "https://atbridgeco.example", orgNumber: null }; },
    });
    const facts = await s.organisation({ name: "Bridgeco", domain: "atbridgeco.example" });
    expect(asked).toEqual(["atbridgeco.example"]);
    expect(facts?.crm).toEqual({ name: "Bridgeco", domain: "https://atbridgeco.example" });
  });

  it("does not ask the CRM at all when there is no domain to ask on", async () => {
    const asked: string[] = [];
    const s = makePersonSources({
      ...wiring,
      vaultSearch: async () => ["a.md"],
      crmCompanyByDomain: async (d) => { asked.push(d); return null; },
    });
    await s.organisation({ name: "Northwind Audio" });
    expect(asked).toEqual([]);
  });

  it("returns null — a real asked-and-empty answer — when neither store nor the CRM has anything", async () => {
    const s = makePersonSources(wiring);
    expect(await s.organisation({ name: "Nobody", domain: "nobody.example" })).toBeNull();
  });

  it("a store that cannot be READ throws, so it can never render as 'nothing found'", async () => {
    const s = makePersonSources({
      ...wiring,
      vaultSearch: async () => ["tools/bridgeco.md"],
      atlasSearch: async () => { throw new Error("atlas is not configured: ATLAS_PATH is unset"); },
    });
    await expect(s.organisation({ name: "Bridgeco", domain: "atbridgeco.example" })).rejects.toThrow(/ATLAS_PATH is unset/);
  });

  /**
   * The CRM is asked FIRST, and its name becomes a search term — because
   * for a CRM-sourced person the name is the only word the notes actually use. Asked afterwards,
   * `dana@atbridgeco.example` searched only for "atbridgeco.example" and "atbridgeco", and every Brain note that
   * calls the company "Bridgeco" was missed. The ticket's own scenario.
   */
  it("feeds the CRM's company name back in as a search term, before the stores are asked", async () => {
    const brain: string[] = [];
    const s = makePersonSources({
      ...wiring,
      // The note says "Bridgeco" and never "atbridgeco" — unreachable from the domain alone.
      vaultSearch: async (q) => { brain.push(q); return q === "Bridgeco" ? ["tools/bridgeco-tracker-bridge.md"] : []; },
      crmCompanyByDomain: async () => ({ name: "Bridgeco", domain: "https://atbridgeco.example", orgNumber: null }),
    });
    const facts = await s.organisation({ domain: "atbridgeco.example" });
    expect(brain[0]).toBe("Bridgeco");
    expect(facts?.notes).toEqual([{ store: "brain", path: "tools/bridgeco-tracker-bridge.md" }]);
    expect(facts?.asked).toEqual({ name: "Bridgeco", domain: "atbridgeco.example" });
  });

  /**
   * Twenty's person record carries only a companyId, so for a CRM person
   * on a personal mailbox the name is one call away and was never fetched — the stage reported "no
   * company on file" about someone whose company the CRM holds.
   */
  it("resolves the company NAME from the CRM record when derivation could not see one", async () => {
    const brain: string[] = [];
    const s = makePersonSources({
      ...wiring,
      twentyCompanyForPerson: async (id) => (id === "p1" ? "Northwind Audio" : null),
      vaultSearch: async (q) => { brain.push(q); return q === "Northwind Audio" ? ["companies/northwind-audio.md"] : []; },
    });
    const facts = await s.organisation({ crmRecordId: "p1" });
    expect(brain).toEqual(["Northwind Audio"]);
    expect(facts?.asked).toEqual({ name: "Northwind Audio" });
    expect(facts?.notes).toEqual([{ store: "brain", path: "companies/northwind-audio.md" }]);
  });

  it("does not spend that call when a name is already known", async () => {
    const asked: string[] = [];
    const s = makePersonSources({
      ...wiring,
      twentyCompanyForPerson: async (id) => { asked.push(id); return "Whatever"; },
      vaultSearch: async () => ["a.md"],
    });
    await s.organisation({ name: "Northwind Audio", crmRecordId: "p1" });
    expect(asked).toEqual([]);
  });

  it("returns null when the CRM record turns out to have no company either", async () => {
    const s = makePersonSources({ ...wiring, twentyCompanyForPerson: async () => null });
    expect(await s.organisation({ crmRecordId: "p1" })).toBeNull();
  });

  /**
   * A cap needs a known ordering. The test below this one uses
   * interchangeable `notes/nN.md` paths and cannot bite on ordering; this one can.
   */
  it("ranks before it caps, so the canonical note survives even when it walks LAST", async () => {
    const walkOrder = [
      "_inbox/clips/2026-01-02-a-long-article-mentioning-northwind-audio.md",
      "daily/2026-01-03.md",
      "daily/2026-01-04.md",
      "meetings/2026-02-11-northwind-sync.md",
      "companies/northwind-audio.md",
    ];
    const s = makePersonSources({ ...wiring, vaultSearch: async () => walkOrder });
    const facts = await s.organisation({ name: "Northwind Audio" });
    const paths = facts!.notes.map((n) => n.path);
    expect(paths[0]).toBe("companies/northwind-audio.md");
    expect(paths).toContain("companies/northwind-audio.md");
  });

  it("deduplicates a path matched by more than one term, and caps what one store contributes", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `notes/n${i}.md`);
    const s = makePersonSources({ ...wiring, vaultSearch: async () => many, atlasSearch: async () => [] });
    const facts = await s.organisation({ name: "Bridgeco", domain: "atbridgeco.example" });
    const paths = facts!.notes.map((n) => n.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.length).toBeLessThanOrEqual(4);
  });
});
