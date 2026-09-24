import { describe, it, expect } from "vitest";
import { makePersonSources } from "../lib/person-sources.js";
import { NotApplicableError, SEARCH_WINDOW_DAYS } from "../lib/person/types.js";
import type { PersonWiring } from "../lib/person-sources.js";

/**
 * Task 8 — the ADAPTER LOGIC inside `makePersonSources` (crm/pulse/mail/meetings/transcripts/
 * company), exercised against a stub `PersonWiring` — no real Twenty/Gmail/Calendar/network/
 * vault/Orakel involved. This is a near-verbatim port of
 * `services/agent-runtime/tests/person-sources.test.ts`: the fan-out logic itself was ported
 * unchanged (see lib/person-sources.ts's header), so its own test's cases transfer directly.
 *
 * One family of cases does NOT transfer: the old adapter's `twentyLookup` returned a
 * `warnings: string[]` field, because the old-runtime Twenty client swallowed a degraded
 * sub-query into that field rather than throwing. eve-saga's `twentyGet` (lib/twenty-client.ts)
 * never does that — it throws `TwentyUnavailableError` directly — so `TwentyLookupResult` here
 * has no `warnings` field, and the "degraded lookup vs clean empty" distinction is now expressed
 * as "the stub throws" vs "the stub returns {people:[],companies:[]} cleanly". See
 * lib/person-sources.ts's `nameForAddress` doc comment for the full explanation.
 *
 * tests/person-lookup.test.ts covers the OTHER half: that `eveSagaPersonWiring()` actually calls
 * eve-saga's real clients (identity-client, twenty tools, network-client, google.ts, notes-store,
 * orakel-client) with the right shapes, plus one end-to-end `person_lookup` tool test.
 */

// A TwentyPersonLite (agent/tools/twenty_lookup.ts) always carries a non-null `name` in
// practice (eve-saga's `mapPerson` synthesises one) — this fixture matches that.
const wiring: PersonWiring = {
  myAddresses: async () => ["owner@owner.example", "owner@project.example"],
  twentyLookup: async () => ({
    people: [{ id: "p1", name: "Lars Eriksen", email: "lars@partner.example", companyId: null }],
    companies: [],
  }),
  twentyCompanyForPerson: async () => null,
  // The REAL @lares/network personProfile() shape — nested contact/identities, NOT a flat
  // {name,emails,company}.
  networkPerson: async () => ({
    contact: { id: 42, displayName: "Lars Eriksen", company: "Nomono" },
    identities: [{ kind: "email", value: "lars@partner.example" }],
    interactions: [],
  }),
  mailSearch: async () => ["m1"],
  mailRead: async () => ({
    id: "m1", threadId: "t1", from: "Lars <lars@partner.example>", to: ["owner@owner.example"],
    subject: "Pilot", bodyText: "…", sentAt: "2026-07-15T10:00:00Z", messageId: "<a>", references: "",
    isCalendarNotice: false,
  }),
  listEvents: async () => [],
  vaultSearch: async () => [],
  vaultRead: async () => "",
  atlasSearch: async () => [],
  crmCompanyByDomain: async () => null,
  orakelSearch: async () => [],
};

describe("makePersonSources", () => {
  it("maps a Twenty hit into a Candidate", async () => {
    const s = makePersonSources(wiring);
    const found = await s.crm({ name: "Lars Eriksen" });
    expect(found[0]).toMatchObject({ source: "twenty", sourceId: "p1", displayName: "Lars Eriksen", emails: ["lars@partner.example"] });
  });

  it("marks a thread as owed when the last message is theirs", async () => {
    const s = makePersonSources(wiring);
    const mail = await s.mail(
      { source: "twenty", sourceId: "p1", displayName: "Lars", emails: ["lars@partner.example"] },
      ["owner@owner.example"],
    );
    expect(mail[0]!.lastSpeakerIsThem).toBe(true);
    expect(mail[0]!.fromThem).toBe(true);
  });

  it("does NOT mark a thread as owed when Bendik sent the last message from a SECOND address", async () => {
    const s = makePersonSources({
      ...wiring,
      mailRead: async () => ({
        id: "m1", threadId: "t1", from: "Bendik <owner@project.example>", to: ["lars@partner.example"],
        subject: "Pilot", bodyText: "…", sentAt: "2026-07-15T10:00:00Z", messageId: "<a>", references: "",
        isCalendarNotice: false,
      }),
    });
    const mail = await s.mail(
      { source: "twenty", sourceId: "p1", displayName: "Lars", emails: ["lars@partner.example"] },
      ["owner@owner.example", "owner@project.example"],
    );
    expect(mail[0]!.lastSpeakerIsThem).toBe(false);
    expect(mail[0]!.fromThem).toBe(false);
  });

  it("skips calendar-notice mail — an RSVP is not a reply", async () => {
    const s = makePersonSources({
      ...wiring,
      mailRead: async () => ({
        id: "m1", threadId: "t1", from: "Lars <lars@partner.example>", to: ["owner@owner.example"],
        subject: "Godtatt: Pilot", bodyText: "", sentAt: "2026-07-15T10:00:00Z", messageId: "<a>", references: "",
        isCalendarNotice: true,
      }),
    });
    const mail = await s.mail(
      { source: "twenty", sourceId: "p1", displayName: "Lars", emails: ["lars@partner.example"] },
      ["owner@owner.example"],
    );
    expect(mail).toEqual([]);
  });

  it("maps a network/pulse hit into a Candidate from the REAL personProfile shape (nested contact/identities, not a flat {name,emails,company})", async () => {
    const s = makePersonSources({
      ...wiring,
      networkPerson: async () => ({
        contact: { id: 42, displayName: "Lars Eriksen", company: "Nomono" },
        identities: [{ kind: "phone", value: "+47 000 00 000" }, { kind: "email", value: "lars@partner.example" }],
        interactions: [],
      }),
    });
    const found = await s.pulse({ name: "Lars Eriksen" });
    expect(found[0]).toMatchObject({ source: "pulse", sourceId: "42", displayName: "Lars Eriksen", emails: ["lars@partner.example"], company: "Nomono" });
  });

  it("pulse returns nothing on a genuine miss (personProfile → null), not a throw", async () => {
    const s = makePersonSources({ ...wiring, networkPerson: async () => null });
    expect(await s.pulse({ name: "Nobody Knows" })).toEqual([]);
  });

  it("meetings: keeps only events where the person is an attendee — the real calendar client has no server-side filter, so getting this wrong leaks every meeting Bendik has into every person's dossier", async () => {
    const s = makePersonSources({
      ...wiring,
      listEvents: async () => [
        { id: "e1", summary: "Pilot sync", start: "2026-07-20T09:00:00Z", end: "2026-07-20T09:30:00Z", attendees: [{ email: "lars@partner.example" }] },
        { id: "e2", summary: "Unrelated 1:1", start: "2026-07-21T09:00:00Z", end: "2026-07-21T09:30:00Z", attendees: [{ email: "someone-else@example.com" }] },
        { id: "e3", summary: "No attendees logged", start: "2026-07-22T09:00:00Z", end: "2026-07-22T09:30:00Z" },
      ],
    });
    const meetings = await s.meetings(
      { source: "twenty", sourceId: "p1", displayName: "Lars", emails: ["lars@partner.example"] },
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
      attendees: [{ email: "lars@partner.example" }],
    }));
    const s = makePersonSources({ ...wiring, listEvents: async () => full });
    await expect(s.meetings(
      { source: "twenty", sourceId: "p1", displayName: "Lars", emails: ["lars@partner.example"] },
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
      { source: "twenty", sourceId: "p1", displayName: "Lars", emails: ["lars@partner.example"] },
      [],
    )).rejects.toThrow(/no addresses for the owner/);
  });

  it("company: resolves a Twenty-sourced person's company NAME via twentyCompanyForPerson before asking Orakel — Twenty's own record only carries a companyId, never a name", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyCompanyForPerson: async (id) => (id === "p1" ? "Nomono" : null),
      orakelSearch: async (name) =>
        name === "Nomono" ? [{ orgNumber: "999", name: "Nomono", country: "NO", employeeCount: 12, naceName: "Software", sizeClass: "small" }] : [],
    });
    const facts = await s.company({ source: "twenty", sourceId: "p1", displayName: "Lars", emails: ["lars@partner.example"] });
    expect(facts).toMatchObject({ name: "Nomono", orgNumber: "999" });
  });

  it("company: does not consult Twenty for a non-Twenty-sourced candidate with no company hint", async () => {
    const calls: string[] = [];
    const s = makePersonSources({
      ...wiring,
      twentyCompanyForPerson: async (id) => { calls.push(id); return "should not be called"; },
    });
    const facts = await s.company({ source: "pulse", sourceId: "c42", displayName: "Lars", emails: ["lars@partner.example"] });
    expect(facts).toBeNull();
    expect(calls).toEqual([]);
  });

  it("pulse: resolves a name via Twenty first when only an email is given, then searches Pulse by that name — this is the night-before pre-meeting path, which looks people up by email", async () => {
    const seenNetworkNames: string[] = [];
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async () => ({ people: [{ id: "p1", name: "Lars Eriksen", email: "lars@partner.example", companyId: null }], companies: [] }),
      networkPerson: async (a) => {
        seenNetworkNames.push(a.name);
        return { contact: { id: 42, displayName: "Lars Eriksen", company: "Nomono" }, identities: [{ kind: "email", value: "lars@partner.example" }], interactions: [] };
      },
    });
    const found = await s.pulse({ email: "lars@partner.example" });
    expect(seenNetworkNames).toEqual(["Lars Eriksen"]);
    expect(found[0]).toMatchObject({ source: "pulse", displayName: "Lars Eriksen" });
  });

  it("pulse: throws NOT-APPLICABLE on an email-only query Twenty does not know either — a clean miss is a permanent index limit, not an outage", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async () => ({ people: [], companies: [] }),
    });
    await expect(s.pulse({ email: "nobody@example.com" })).rejects.toBeInstanceOf(NotApplicableError);
    await expect(s.pulse({ email: "nobody@example.com" })).rejects.toThrow(/pulse can only be searched by name/);
  });

  it("crm: throws when Twenty returned records but every one was dropped for lacking a usable name — Twenty DID find people, we failed to read them", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async () => ({
        people: [
          { id: "p1", name: "", email: "lars@partner.example", companyId: null },
          { id: "p2", name: "   ", email: null, companyId: null },
        ],
        companies: [],
      }),
    });
    await expect(s.crm({ name: "Lars Eriksen" })).rejects.toThrow(/Twenty returned 2 records but none carried a usable name/);
  });

  it("pulse: picks the record whose OWN email matches the queried address, not just any record with a name", async () => {
    const seenNetworkNames: string[] = [];
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async () => ({
        people: [
          { id: "p2", name: "Ingrid Holm", email: "ingrid@partner.example", companyId: null },
          { id: "p1", name: "Lars Eriksen", email: "lars@partner.example", companyId: null },
        ],
        companies: [],
      }),
      networkPerson: async (a) => {
        seenNetworkNames.push(a.name);
        return { contact: { id: 42, displayName: "Lars Eriksen", company: "Nomono" }, identities: [{ kind: "email", value: "lars@partner.example" }], interactions: [] };
      },
    });
    const found = await s.pulse({ email: "lars@partner.example" });
    expect(seenNetworkNames).toEqual(["Lars Eriksen"]);
    expect(found[0]).toMatchObject({ source: "pulse", displayName: "Lars Eriksen" });
  });

  it("pulse: throws NOT-APPLICABLE when Twenty returns records but none whose email matches the queried address — never resolves somebody else's name", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async () => ({
        people: [
          { id: "p2", name: "Ingrid Holm", email: "ingrid@partner.example", companyId: null },
          { id: "p3", name: "Someone Else", email: "someone@othercompany.co", companyId: null },
        ],
        companies: [],
      }),
    });
    await expect(s.pulse({ email: "lars@partner.example" }))
      .rejects.toThrow(/pulse can only be searched by name, and no name is known for lars@partner\.example/);
  });

  // ---------------------------------------------------------------------------------------
  // A plural `emails` query has no single search term: crm() and pulse() each look up EVERY
  // address and merge.
  // ---------------------------------------------------------------------------------------

  it("crm: a plural `emails` query looks up EACH address and unions the results by sourceId", async () => {
    const seenQueries: string[] = [];
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async ({ query }) => {
        seenQueries.push(query);
        if (query === "lars@partner.example") return { people: [{ id: "p1", name: "Lars Eriksen", email: "lars@partner.example", companyId: null }], companies: [] };
        if (query === "lars@newco.com") return { people: [{ id: "p2", name: "Lars Eriksen", email: "lars@newco.com", companyId: null }], companies: [] };
        return { people: [], companies: [] };
      },
    });
    const found = await s.crm({ emails: ["lars@partner.example", "lars@newco.com"] });
    expect(seenQueries).toEqual(["lars@partner.example", "lars@newco.com"]);
    expect(found.map((c) => c.sourceId).sort()).toEqual(["p1", "p2"]);
  });

  it("crm: a plural `emails` query de-duplicates the same Twenty record found via more than one address", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async () => ({ people: [{ id: "p1", name: "Lars Eriksen", email: "lars@partner.example", companyId: null }], companies: [] }),
    });
    const found = await s.crm({ emails: ["lars@partner.example", "lars@newco.com"] });
    expect(found).toHaveLength(1);
  });

  it("pulse: a plural `emails` query tries each address in order, using the first that resolves a name", async () => {
    const seenTwentyQueries: string[] = [];
    const seenNetworkNames: string[] = [];
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async ({ query }) => {
        seenTwentyQueries.push(query);
        // Only the SECOND address is known to Twenty — the first must be tried and skipped,
        // not just picked because it is first in the list.
        if (query === "lars@newco.com") return { people: [{ id: "p2", name: "Lars Eriksen", email: "lars@newco.com", companyId: null }], companies: [] };
        return { people: [], companies: [] };
      },
      networkPerson: async (a) => {
        seenNetworkNames.push(a.name);
        return { contact: { id: 42, displayName: "Lars Eriksen", company: "NewCo" }, identities: [{ kind: "email", value: "lars@newco.com" }], interactions: [] };
      },
    });
    const found = await s.pulse({ emails: ["lars@partner.example", "lars@newco.com"] });
    expect(seenTwentyQueries).toEqual(["lars@partner.example", "lars@newco.com"]);
    expect(seenNetworkNames).toEqual(["Lars Eriksen"]);
    expect(found[0]).toMatchObject({ source: "pulse", displayName: "Lars Eriksen" });
  });

  it("pulse: throws NOT-APPLICABLE naming every address tried when NONE of them resolve a name — a clean miss on every address is still a permanent index limit, not an outage", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async () => ({ people: [], companies: [] }),
    });
    await expect(s.pulse({ emails: ["lars@partner.example", "lars@newco.com"] })).rejects.toBeInstanceOf(NotApplicableError);
    await expect(s.pulse({ emails: ["lars@partner.example", "lars@newco.com"] }))
      .rejects.toThrow(/no name is known for any of: lars@partner\.example, lars@newco\.com/);
  });

  // ---------------------------------------------------------------------------------------
  // DEVIATION from the old adapter's test suite: eve-saga's `twentyGet` throws
  // `TwentyUnavailableError` directly on any HTTP failure rather than swallowing it into a
  // `warnings` field, so a genuine outage during pulse's name resolution is exercised here by
  // making the stub throw — not by returning a degraded-but-empty result. The distinction this
  // proves (an outage must never wear the not-applicable label) is unchanged; only the
  // mechanics of simulating an outage differ. See lib/person-sources.ts's `nameForAddress`
  // doc comment.
  // ---------------------------------------------------------------------------------------

  it("pulse: a Twenty lookup that THROWS during name resolution is a plain failure, not not-applicable — an outage must never wear the permanent-limit label", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async () => { throw new Error("Twenty GET /people → 401 Unauthorized"); },
    });
    const err = await s.pulse({ email: "lars@partner.example" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotApplicableError);
    expect(String(err)).toMatch(/401 Unauthorized/);
  });

  it("crm: a Twenty lookup that THROWS propagates as a plain failure, not an empty result", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async () => { throw new Error("Twenty GET /people → 503"); },
    });
    await expect(s.crm({ name: "Lars Eriksen" })).rejects.toThrow(/503/);
  });

  // ---------------------------------------------------------------------------------------
  // Fix round 2 (reviewer finding on Task 8): a multi-address `emails` merge query must
  // tolerate ONE term's lookup throwing as long as another term still finds a real candidate
  // — the old adapter's fix round 1 (ORB-44) hardened exactly this "partial read that found
  // someone despite one degraded sub-query is still a find" behaviour, and a plain
  // `Promise.all` would lose it.
  // ---------------------------------------------------------------------------------------

  it("crm: a plural `emails` query still succeeds when the FIRST address's Twenty lookup throws but the SECOND finds a real candidate", async () => {
    const seenQueries: string[] = [];
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async ({ query }) => {
        seenQueries.push(query);
        if (query === "lars@partner.example") throw new Error("Twenty GET /people → 503");
        if (query === "lars@newco.com") return { people: [{ id: "p2", name: "Lars Eriksen", email: "lars@newco.com", companyId: null }], companies: [] };
        return { people: [], companies: [] };
      },
    });
    const found = await s.crm({ emails: ["lars@partner.example", "lars@newco.com"] });
    expect(seenQueries).toEqual(["lars@partner.example", "lars@newco.com"]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ source: "twenty", sourceId: "p2", displayName: "Lars Eriksen" });
  });

  it("crm: a plural `emails` query still throws when EVERY address either errors or finds nothing (one erroring term, one clean-empty term)", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async ({ query }) => {
        if (query === "lars@partner.example") throw new Error("Twenty GET /people → 503");
        return { people: [], companies: [] };
      },
    });
    // Only one term actually errored (the other was a clean miss), so the original error
    // rethrows unwrapped — same message shape as the single-term throw case above.
    await expect(s.crm({ emails: ["lars@partner.example", "lars@newco.com"] })).rejects.toThrow(/503/);
  });

  it("crm: a plural `emails` query throws a combined message naming every address when ALL of them error", async () => {
    const s = makePersonSources({
      ...wiring,
      twentyLookup: async ({ query }) => {
        if (query === "lars@partner.example") throw new Error("Twenty GET /people → 503");
        throw new Error("Twenty GET /people → 401 Unauthorized");
      },
    });
    await expect(s.crm({ emails: ["lars@partner.example", "lars@newco.com"] }))
      .rejects.toThrow(/Twenty lookup failed on 2 of 2 addresses.*503.*401 Unauthorized/s);
  });

  it("pulse: a network/Pulse read that itself throws stays a plain failure", async () => {
    const s = makePersonSources({
      ...wiring,
      networkPerson: async () => { throw new Error("network db locked"); },
    });
    const err = await s.pulse({ name: "Lars Eriksen" }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NotApplicableError);
    expect(String(err)).toMatch(/network db locked/);
  });

  // The render quotes these windows so an empty result reads as "nothing in the window", not
  // "nothing ever". If the adapter ever stops searching the window the render names, the
  // sentence becomes false — which is the whole defect, restored by a copy-paste.
  it("mail and calendar search exactly the windows the render tells Bendik about", async () => {
    const seenMailQueries: string[] = [];
    let seenWindow: { timeMin: string; timeMax: string } | null = null;
    const s = makePersonSources({
      ...wiring,
      mailSearch: async (q) => { seenMailQueries.push(q); return []; },
      listEvents: async (o) => { seenWindow = { timeMin: o.timeMin, timeMax: o.timeMax }; return []; },
    });
    const lars = { source: "twenty", sourceId: "p1", displayName: "Lars", emails: ["lars@partner.example"] };
    await s.mail(lars, ["owner@owner.example"]);
    await s.meetings(lars, ["owner@owner.example"]);

    expect(seenMailQueries[0]).toContain(`newer_than:${SEARCH_WINDOW_DAYS.mail}d`);
    const w = seenWindow as unknown as { timeMin: string; timeMax: string };
    const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
    expect(days(w.timeMin, new Date().toISOString())).toBe(SEARCH_WINDOW_DAYS.calendarBack);
    expect(days(new Date().toISOString(), w.timeMax)).toBe(SEARCH_WINDOW_DAYS.calendarAhead);
  });
});

/**
 * ORB-166 — the `organisation` source: both note stores and the CRM, asked by company NAME and
 * mail DOMAIN rather than by human.
 */
describe("makePersonSources.organisation", () => {
  it("searches BOTH stores, by name and by domain, and marks every hit with its store", async () => {
    const brain: string[] = [];
    const atlas: string[] = [];
    const s = makePersonSources({
      ...wiring,
      vaultSearch: async (q) => { brain.push(q); return q === "Cyrus" ? ["tools/cyrus.md"] : []; },
      atlasSearch: async (q) => { atlas.push(q); return q === "atcyrus.com" ? ["ventures/ada/bridge.md"] : []; },
    });
    const facts = await s.organisation({ name: "Cyrus", domain: "atcyrus.com" });
    expect(facts?.notes).toEqual([
      { store: "brain", path: "tools/cyrus.md" },
      { store: "atlas", path: "ventures/ada/bridge.md" },
    ]);
    // Name, domain, and the domain's bare label — in both stores.
    expect(brain).toEqual(["Cyrus", "atcyrus.com", "atcyrus"]);
    expect(atlas).toEqual(["Cyrus", "atcyrus.com", "atcyrus"]);
  });

  it("echoes back what it actually asked — after the CRM had its say", async () => {
    const s = makePersonSources({ ...wiring, vaultSearch: async () => ["a.md"] });
    const facts = await s.organisation({ name: "Cyrus", domain: "atcyrus.com" });
    expect(facts?.asked).toEqual({ name: "Cyrus", domain: "atcyrus.com" });
  });

  it("looks the CRM company up BY DOMAIN, never by name", async () => {
    const asked: string[] = [];
    const s = makePersonSources({
      ...wiring,
      crmCompanyByDomain: async (d) => { asked.push(d); return { name: "Cyrus", domain: "https://atcyrus.com", orgNumber: null }; },
    });
    const facts = await s.organisation({ name: "Cyrus", domain: "atcyrus.com" });
    expect(asked).toEqual(["atcyrus.com"]);
    expect(facts?.crm).toEqual({ name: "Cyrus", domain: "https://atcyrus.com" });
  });

  it("does not ask the CRM at all when there is no domain to ask on", async () => {
    const asked: string[] = [];
    const s = makePersonSources({
      ...wiring,
      vaultSearch: async () => ["a.md"],
      crmCompanyByDomain: async (d) => { asked.push(d); return null; },
    });
    await s.organisation({ name: "Nomono" });
    expect(asked).toEqual([]);
  });

  it("NEVER routes an organisation query to Orakel — a US vendor's absence there is not a finding", async () => {
    const orakel: string[] = [];
    const s = makePersonSources({
      ...wiring,
      vaultSearch: async () => ["tools/cyrus.md"],
      orakelSearch: async (n) => { orakel.push(n); return []; },
    });
    await s.organisation({ name: "Cyrus", domain: "atcyrus.com" });
    expect(orakel).toEqual([]);
  });

  it("returns null — a real asked-and-empty answer — when neither store nor the CRM has anything", async () => {
    const s = makePersonSources(wiring);
    expect(await s.organisation({ name: "Nobody", domain: "nobody.example" })).toBeNull();
  });

  it("a store that cannot be READ throws, so it can never render as 'nothing found'", async () => {
    const s = makePersonSources({
      ...wiring,
      vaultSearch: async () => ["tools/cyrus.md"],
      atlasSearch: async () => { throw new Error("atlas is not configured: ATLAS_PATH is unset"); },
    });
    await expect(s.organisation({ name: "Cyrus", domain: "atcyrus.com" })).rejects.toThrow(/ATLAS_PATH is unset/);
  });

  /**
   * FIX ROUND 1, Finding 2b. The CRM is asked FIRST, and its name becomes a search term — because
   * for a CRM-sourced person the name is the only word the notes actually use. Asked afterwards,
   * `connor@atcyrus.com` searched only for "atcyrus.com" and "atcyrus", and every Brain note that
   * calls the company "Cyrus" was missed. The ticket's own scenario.
   */
  it("feeds the CRM's company name back in as a search term, before the stores are asked", async () => {
    const brain: string[] = [];
    const s = makePersonSources({
      ...wiring,
      // The note says "Cyrus" and never "atcyrus" — unreachable from the domain alone.
      vaultSearch: async (q) => { brain.push(q); return q === "Cyrus" ? ["tools/cyrus-linear-bridge.md"] : []; },
      crmCompanyByDomain: async () => ({ name: "Cyrus", domain: "https://atcyrus.com", orgNumber: null }),
    });
    const facts = await s.organisation({ domain: "atcyrus.com" });
    expect(brain[0]).toBe("Cyrus");
    expect(facts?.notes).toEqual([{ store: "brain", path: "tools/cyrus-linear-bridge.md" }]);
    expect(facts?.asked).toEqual({ name: "Cyrus", domain: "atcyrus.com" });
  });

  /**
   * FIX ROUND 1, Finding 2a. Twenty's person record carries only a companyId, so for a CRM person
   * on a personal mailbox the name is one call away and was never fetched — the stage reported "no
   * company on file" about someone whose company the CRM holds.
   */
  it("resolves the company NAME from the CRM record when derivation could not see one", async () => {
    const brain: string[] = [];
    const s = makePersonSources({
      ...wiring,
      twentyCompanyForPerson: async (id) => (id === "p1" ? "Nomono" : null),
      vaultSearch: async (q) => { brain.push(q); return q === "Nomono" ? ["companies/nomono.md"] : []; },
    });
    const facts = await s.organisation({ crmRecordId: "p1" });
    expect(brain).toEqual(["Nomono"]);
    expect(facts?.asked).toEqual({ name: "Nomono" });
    expect(facts?.notes).toEqual([{ store: "brain", path: "companies/nomono.md" }]);
  });

  it("does not spend that call when a name is already known", async () => {
    const asked: string[] = [];
    const s = makePersonSources({
      ...wiring,
      twentyCompanyForPerson: async (id) => { asked.push(id); return "Whatever"; },
      vaultSearch: async () => ["a.md"],
    });
    await s.organisation({ name: "Nomono", crmRecordId: "p1" });
    expect(asked).toEqual([]);
  });

  it("returns null when the CRM record turns out to have no company either", async () => {
    const s = makePersonSources({ ...wiring, twentyCompanyForPerson: async () => null });
    expect(await s.organisation({ crmRecordId: "p1" })).toBeNull();
  });

  /**
   * FIX ROUND 1, Finding 1 — a cap needs a known ordering. The test below this one uses
   * interchangeable `notes/nN.md` paths and cannot bite on ordering; this one can.
   */
  it("ranks before it caps, so the canonical note survives even when it walks LAST", async () => {
    const walkOrder = [
      "_inbox/clips/2026-01-02-a-long-article-mentioning-nomono.md",
      "daily/2026-01-03.md",
      "daily/2026-01-04.md",
      "meetings/2026-02-11-nomono-sync.md",
      "companies/nomono.md",
    ];
    const s = makePersonSources({ ...wiring, vaultSearch: async () => walkOrder });
    const facts = await s.organisation({ name: "Nomono" });
    const paths = facts!.notes.map((n) => n.path);
    expect(paths[0]).toBe("companies/nomono.md");
    expect(paths).toContain("companies/nomono.md");
  });

  it("deduplicates a path matched by more than one term, and caps what one store contributes", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `notes/n${i}.md`);
    const s = makePersonSources({ ...wiring, vaultSearch: async () => many, atlasSearch: async () => [] });
    const facts = await s.organisation({ name: "Cyrus", domain: "atcyrus.com" });
    const paths = facts!.notes.map((n) => n.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.length).toBeLessThanOrEqual(4);
  });
});
