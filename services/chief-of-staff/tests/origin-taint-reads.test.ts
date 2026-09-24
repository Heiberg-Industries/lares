/**
 * W3A-s5 — which reads taint, and at which level
 * (docs/specs/2026-09-18-origin-model-design.md, "The in-turn taint rule").
 *
 * Each tool's own `execute` is driven directly against an injected/mocked client, the pattern
 * `tests/tools-deadline.test.ts` and `tests/origin-taint-hook.test.ts` both use. W3A-s4's hook
 * (`agent/hooks/origin-taint.ts`) taints on the RESULT alone, because a hook cannot see a tool's
 * arguments; this slice moves the argument-aware refinements to the tools themselves, at the
 * call sites where the arguments are in hand.
 *
 * THE SECOND DESCRIBE BLOCK BELOW is the register-completeness audit. THE SAFETY DIRECTION: when
 * in doubt, taint. A read tool that brings back outside text and is missing from every register
 * is the dangerous failure this whole track exists to prevent — outside text enters a turn
 * unmarked. So that block enumerates every catalogue FILE across the three role services
 * (chief-of-staff, travel, creative) straight off the filesystem — never a hard-coded tool-name
 * list — and requires each one to be accounted for, either as a tool that taints (proven by a
 * behavioural test in this file or in `tests/origin-taint-hook.test.ts`) or on an explicit,
 * commented allow-list of tools verified to return no outside text. A tool added to any
 * catalogue later and left unclassified fails this suite until someone looks at it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { TAINTING_TOOLS } from "../agent/hooks/origin-taint.js";

const ctx = { session: { id: "s1", turn: { id: "t1" } } } as never;
const key = { sessionId: "s1", turnId: "t1" };

beforeEach(() => { vi.resetModules(); });

// `vi.doMock` registrations are NOT cleared by `vi.resetModules()` — they persist for the rest
// of the file until explicitly undone. Without this, a later test that doesn't mock, say,
// `../lib/notion-page.js` would still pick up an EARLIER test's mock of it (found running this
// suite: "a Google Doc is third_party" read `synced` instead, because the previous test's
// Notion mock was still active and read_url.ts checks the Notion branch first).
afterEach(() => {
  vi.doUnmock("../lib/google.js");
  vi.doUnmock("@lares/agent-kit/readability-client");
  vi.doUnmock("../lib/notion-page.js");
  vi.doUnmock("../lib/google-doc.js");
  vi.doUnmock("../lib/person-sources.js");
  vi.doUnmock("../lib/travel-store.js");
});

/**
 * DEVIATION FROM THE SLICE'S GIVEN TEST CODE: the plan's literal fixture imports
 * `currentTaint`/`resetTaintForTests` once at the top of the file (a static import, bound
 * before any `vi.resetModules()` runs) and then dynamically re-imports each TOOL module inside
 * every test. That combination is broken: `vi.resetModules()` clears vitest's module registry,
 * so the tool's own dynamically-re-imported copy of `@lares/agent-kit/origin-taint` is a FRESH
 * module instance with its own, separate `taints` Map — never the one the file-level static
 * import is bound to. Every taint assertion read `undefined` even though the tool's own
 * `taintTurn` call ran (confirmed by running the suite before this fix — every "taints" case
 * failed with "expected undefined to be 'third_party'", every "does not taint" case passed
 * vacuously). The fix: re-import `@lares/agent-kit/origin-taint` itself, dynamically, AFTER
 * `vi.resetModules()`, in every test — so the assertion reads from the SAME fresh instance the
 * freshly-imported tool wrote to.
 */
async function freshTaint() {
  return import("@lares/agent-kit/origin-taint");
}

describe("calendar_list_events taints only when it can be somebody else's calendar", () => {
  it("does not taint a bare listing of the owner's own primary calendar", async () => {
    vi.doMock("../lib/google.js", () => ({ googleClients: () => ({ calendar: async () => ({ listEvents: async () => [] }) }) }));
    const tool = (await import("../catalogue/calendar_list_events.js")).default;
    await tool.execute({ timeMin: "2026-09-18T00:00:00Z", timeMax: "2026-09-19T00:00:00Z" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBeUndefined();
  });

  it("taints when a specific calendarId is named", async () => {
    vi.doMock("../lib/google.js", () => ({ googleClients: () => ({ calendar: async () => ({ listEvents: async () => [] }) }) }));
    const tool = (await import("../catalogue/calendar_list_events.js")).default;
    await tool.execute({ timeMin: "a", timeMax: "b", calendarId: "someone@example.test" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBe("third_party");
  });

  it("taints when a specific account is named, even with no calendarId", async () => {
    vi.doMock("../lib/google.js", () => ({ googleClients: () => ({ calendar: async () => ({ listEvents: async () => [] }) }) }));
    const tool = (await import("../catalogue/calendar_list_events.js")).default;
    await tool.execute({ timeMin: "a", timeMax: "b", account: "someone@example.test" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBe("third_party");
  });

  it("a failed call taints nothing", async () => {
    vi.doMock("../lib/google.js", () => ({ googleClients: () => ({ calendar: async () => ({ listEvents: async () => { throw new Error("boom"); } }) }) }));
    const tool = (await import("../catalogue/calendar_list_events.js")).default;
    await expect(tool.execute({ timeMin: "a", timeMax: "b", calendarId: "someone@example.test" }, ctx)).rejects.toThrow("boom");
    expect((await freshTaint()).currentTaint(key)).toBeUndefined();
  });
});

describe("read_url taints at the level the branch earned", () => {
  it("a web page is third_party", async () => {
    vi.doMock("@lares/agent-kit/readability-client", () => ({ readUrl: async () => ({ title: "t", text: "x" }), readUrlModelOutput: (r: unknown) => r }));
    const tool = (await import("../catalogue/read_url.js")).default;
    await tool.execute({ url: "https://example.test/a" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBe("third_party");
  });

  it("a live Notion page is synced, not third_party", async () => {
    vi.doMock("../lib/notion-page.js", () => ({ notionPageIdFromUrl: () => "page-1", readNotionPage: async () => ({ title: "t", text: "x" }) }));
    const tool = (await import("../catalogue/read_url.js")).default;
    await tool.execute({ url: "https://notion.so/page-1" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBe("synced");
  });

  it("a Google Doc is third_party", async () => {
    vi.doMock("../lib/google-doc.js", () => ({
      googleDocFromUrl: () => ({ id: "doc-1", kind: "document" }),
      readGoogleDoc: async () => ({ title: "t", text: "x" }),
    }));
    const tool = (await import("../catalogue/read_url.js")).default;
    await tool.execute({ url: "https://docs.google.com/document/d/doc-1" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBe("third_party");
  });
});

describe("gmail_read / gmail_search always taint third_party on a successful call", () => {
  it("gmail_read taints on a found message", async () => {
    vi.doMock("../lib/google.js", () => ({ googleClients: () => ({ gmail: async () => ({ read: async () => ({ id: "m1", subject: "hi" }) }) }) }));
    const tool = (await import("../catalogue/gmail_read.js")).default;
    await tool.execute({ id: "m1" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBe("third_party");
  });

  it("gmail_read taints on the not-found path too — the model still saw what the mailbox returned", async () => {
    vi.doMock("../lib/google.js", () => ({ googleClients: () => ({ gmail: async () => ({ read: async () => null }) }) }));
    const tool = (await import("../catalogue/gmail_read.js")).default;
    await tool.execute({ id: "missing" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBe("third_party");
  });

  it("gmail_search taints on a successful call", async () => {
    vi.doMock("../lib/google.js", () => ({ googleClients: () => ({ gmail: async () => ({ search: async () => ["m1", "m2"] }) }) }));
    const tool = (await import("../catalogue/gmail_search.js")).default;
    await tool.execute({ query: "in:inbox" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBe("third_party");
  });

  it("a thrown gmail_search call taints nothing", async () => {
    vi.doMock("../lib/google.js", () => ({ googleClients: () => ({ gmail: async () => ({ search: async () => { throw new Error("boom"); } }) }) }));
    const tool = (await import("../catalogue/gmail_search.js")).default;
    await expect(tool.execute({ query: "in:inbox" }, ctx)).rejects.toThrow("boom");
    expect((await freshTaint()).currentTaint(key)).toBeUndefined();
  });
});

describe("the attachment extractor taints the turn it runs in", () => {
  // DEVIATION FROM THE SLICE'S GIVEN TEST: the plan's literal fixture used `attachment: a.txt`
  // and expected `third_party` — but `.txt` is not one of extractAttachment's recognised
  // extensions (IMAGE_EXTS, `.pdf`, `.docx`; see lib/digest/extract.ts), so the real function
  // returns null and nothing taints. `.png` is used below instead, the smallest correction that
  // makes the given test actually exercise a non-null return.
  it("an unrecognised attachment extension extracts nothing and taints nothing", async () => {
    const { extractAttachment } = await import("../lib/digest/extract.js");
    const result = await extractAttachment({
      breadcrumbBody: "---\nattachment: a.txt\n---\n",
      readFile: async () => Buffer.from("hello"),
      turn: key,
    });
    expect(result).toBeNull();
    expect((await freshTaint()).currentTaint(key)).toBeUndefined();
  });

  it("stamps third_party on a recognised attachment type (image)", async () => {
    const { extractAttachment } = await import("../lib/digest/extract.js");
    const result = await extractAttachment({
      breadcrumbBody: "---\nattachment: photo.png\n---\n",
      readFile: async () => Buffer.from("bytes"),
      turn: key,
    });
    expect(result?.kind).toBe("image");
    expect((await freshTaint()).currentTaint(key)).toBe("third_party");
  });

  it("does nothing to the turn when no `turn` is passed — the schedule path has none", async () => {
    const { extractAttachment } = await import("../lib/digest/extract.js");
    await extractAttachment({
      breadcrumbBody: "---\nattachment: photo.png\n---\n",
      readFile: async () => Buffer.from("bytes"),
    });
    expect((await freshTaint()).currentTaint(key)).toBeUndefined();
  });
});

describe("person_lookup taints when the mail source finds something (found auditing the catalogue for the completeness test below)", () => {
  const stubSources = (mail: unknown[]) => ({
    eveSagaPersonWiring: () => ({}),
    makePersonSources: () => ({
      myAddresses: async () => ["owner@owner.example"],
      crm: async () => [{ source: "twenty", sourceId: "p1", displayName: "Lars Eriksen", emails: ["lars@partner.example"] }],
      pulse: async () => [],
      mail: async () => mail,
      meetings: async () => [],
      transcripts: async () => [],
      company: async () => null,
      organisation: async () => null,
    }),
  });

  it("taints third_party when mail turns up something", async () => {
    vi.doMock("../lib/person-sources.js", () => stubSources([
      { at: new Date("2026-07-15T10:00:00Z"), threadId: "t1", subject: "Pilot", fromThem: true, lastSpeakerIsThem: true },
    ]));
    const tool = (await import("../catalogue/person_lookup.js")).default;
    await tool.execute({ name: "Lars Eriksen" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBe("third_party");
  });

  it("does not taint when mail found nothing", async () => {
    vi.doMock("../lib/person-sources.js", () => stubSources([]));
    const tool = (await import("../catalogue/person_lookup.js")).default;
    await tool.execute({ name: "Lars Eriksen" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBeUndefined();
  });
});

describe("calendar_conflicts taints unconditionally — it fans out beyond the primary calendar by design", () => {
  it("taints third_party on a successful call, even with no conflicts found", async () => {
    vi.doMock("../lib/google.js", () => ({
      googleClients: () => ({ calendar: async () => ({ listCalendars: async () => [], listEvents: async () => [] }) }),
      listEnrolledMailboxes: async () => ["owner@owner.example"],
    }));
    const tool = (await import("../catalogue/calendar_conflicts.js")).default;
    await tool.execute({}, ctx);
    expect((await freshTaint()).currentTaint(key)).toBe("third_party");
  });
});

describe("travel_read taints only for bookings.md — the vendor's own confirmation wording", () => {
  it("taints third_party when reading bookings.md", async () => {
    vi.doMock("../lib/travel-store.js", () => ({
      READABLE_TRIP_FILES: ["trip.md", "itinerary.md", "bookings.md"],
      readTripFile: () => ({ slug: "trip-1", file: "bookings.md", content: "Confirmation #123", lines: 1 }),
    }));
    const tool = (await import("../catalogue/travel_read.js")).default;
    await tool.execute({ slug: "trip-1", file: "bookings.md" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBe("third_party");
  });

  it("does not taint trip.md — the owner's/Marcel's own notes", async () => {
    vi.doMock("../lib/travel-store.js", () => ({
      READABLE_TRIP_FILES: ["trip.md", "itinerary.md", "bookings.md"],
      readTripFile: () => ({ slug: "trip-1", file: "trip.md", content: "notes", lines: 1 }),
    }));
    const tool = (await import("../catalogue/travel_read.js")).default;
    await tool.execute({ slug: "trip-1", file: "trip.md" }, ctx);
    expect((await freshTaint()).currentTaint(key)).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------------------
// Register completeness — every mail/web/attachment/others'-calendar/Notion read tool in the
// three role services' catalogues is either accounted for as tainting, or explicitly,
// honestly allow-listed as returning no outside text. See the file header.
// -----------------------------------------------------------------------------------------

function catalogueToolNames(...serviceDirParts: string[]): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "..", ...serviceDirParts, "catalogue");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .map((f) => f.replace(/\.ts$/, ""));
}

/**
 * Tools proven, by a behavioural test in this file (or — for the chief-of-staff hook's own
 * blanket coverage — in `tests/origin-taint-hook.test.ts`), to taint the turn when they bring
 * back outside text. Argument-aware tools (`calendar_list_events`, `person_lookup`,
 * `travel_read`) are listed once here; which argument/branch earns the taint is the behavioural
 * tests' job, not this list's.
 */
const TAINTS: Record<string, ReadonlySet<string>> = {
  "chief-of-staff": new Set<string>([
    ...TAINTING_TOOLS.keys(), // gmail_read, gmail_search, read_url — the hook's own blanket coverage
    "calendar_list_events", // self-taints on calendarId/account (Owner decision A3)
    "person_lookup", // self-taints when the mail source finds something
    "calendar_conflicts", // self-taints unconditionally — reads beyond the primary calendar by design
    "travel_read", // self-taints for file === "bookings.md" only
  ]),
  travel: new Set<string>([
    "read_url", // self-taints unconditionally — see services/travel/tests/tools-read-url.test.ts
  ]),
  creative: new Set<string>(),
};

/**
 * Every other catalogue tool, across the three services, verified to return no outside text —
 * no third-party words a prompt-laundering attempt could ride in on. One reason per tool. The
 * dividing line: a STRUCTURED field (an id, a name, a date, a status, a boolean, a URL the tool
 * itself built) is not "outside text" in the sense this track defends against; FREEFORM PROSE
 * someone other than the owner wrote — an email body/subject, a web page, a Notion page, an
 * attachment's text, another calendar's event titles, a vendor's booking confirmation — is.
 */
const NO_OUTSIDE_TEXT: Record<string, Record<string, string>> = {
  "chief-of-staff": {
    // Kit tools mounted directly in this catalogue (ORB-278 step 2) — vault/registry/signal
    // reads over the OWNER's own stores, or a public company-registry lookup returning
    // structured fields (name, org number) rather than freeform prose.
    "agent-kit__vault_drop": "gated vault DELETE — a write, returns only what was deleted",
    "agent-kit__vault_file": "gated vault write — a write, echoes only what was written",
    "agent-kit__vault_write": "gated vault write — a write, echoes only what was written",
    "agent-kit__market_edge": "structured market-signal read over the owner's own data",
    "agent-kit__orakel_enrich_domain": "structured public-registry fields (name, org number), no freeform prose",
    "agent-kit__orakel_enrich_org": "structured public-registry fields (name, org number), no freeform prose",
    "agent-kit__orakel_search": "structured public-registry fields (name, org number), no freeform prose",
    "agent-kit__signals_recent": "the owner's own persisted operational-signal spine",
    "agent-kit__transit_plan": "structured journey/route data, not freeform prose",
    // W5C-s3: one set of note tools, told which area. Both areas they can open are the
    // installation's own — the owner's private store and the business's shared one — so the
    // classification is the same whichever the model names, and the three `atlas_*` reads this
    // list used to carry beside them are gone.
    "agent-kit__vault_backlinks": "the installation's own Vault, internal, in either area",
    "agent-kit__vault_list": "the installation's own Vault, internal, in either area",
    "agent-kit__vault_read": "the installation's own Vault, internal, in either area",
    "agent-kit__vault_search": "the installation's own Vault, internal, in either area",
    atlas_proposals: "Bendik's OWN Notion/canonical-source edits, re-derived — a synced pipeline (W3A-s9's job), not a live third-party read",
    atlas_resolve_proposal: "gated write — approve/reject only, no new content surfaces",
    calendar_create_event: "gated write — echoes only what the model itself supplied",
    calendar_delete_event: "gated write — no content returned",
    calendar_free_busy: "structured busy/free windows only, no event titles or descriptions",
    calendar_list_calendars: "structured calendar id/name metadata, not event content",
    calendar_update_event: "gated write — echoes only what the model itself supplied",
    deadline_add: "internal store write; `fromThreadId` is an input, never read back",
    deadline_dismiss: "internal store write; `candidateThreadId` is an input, never read back",
    deadline_done: "internal store write",
    deadline_list: "internal store read — structured deadline rows, titles set by the owner or a statutory mint",
    deadline_mint_statutory: "gated write — structured statutory rules",
    deadline_reset: "internal store write",
    digest_run: "enqueues a queue row; digest content is delivered out-of-band by a separate container, never in this tool's own result",
    echo_note: "appends to a local log nothing reads — the approval-gate proof tool",
    facts_list: "the owner's own standing facts, origin-restricted to 'owner' at the table's CHECK constraint",
    forget: "internal store write",
    gmail_draft: "write — drafts nothing the model didn't compose itself",
    gmail_draft_recipients: "rewrites only To/Cc headers on the AGENT's own existing draft; returns only the new recipient list",
    gmail_send: "write — sends only what the model itself composed",
    gmail_signature: "the owner's own configured signature, not third-party text",
    identity_my_addresses: "the owner's own address registry",
    meeting_followup_auto: "internal policy write",
    meeting_followup_record_denial: "internal store write",
    meeting_followup_redraft: "internal store write — resets a claim, returns no new content",
    meeting_followup_send: "write — subject/body/meetingTitle are model-supplied inputs, never read back from an external source",
    // The memory lane (W4C-s5). `memory_proposals` returns the owner's OWN standing preference
    // beside what a nightly run proposes putting in its place — and `memory_proposals`' own
    // CHECK admits nothing but `origin = 'owner'`, so by construction there is no third-party
    // prose in either field. The resolve tool is a gated decision that echoes back only the
    // stored row's consequence sentence.
    memory_proposals: "the owner's own standing preferences and the proposed replacements, origin-restricted to 'owner' at the table",
    memory_resolve_proposal: "gated write — approve/reject only, echoes the stored consequence sentence and no new content",
    memory_used: "structured kind/ref/via labels a call site itself recorded at the moment of reading (memory_reads, box 075) — ids and paths, never a note's own body",
    network_dormant: "the CONTENT-STRIPPED network replica, by its own header",
    network_person: "the CONTENT-STRIPPED network replica, by its own header",
    network_who_at: "the CONTENT-STRIPPED network replica, by its own header",
    notion_proposals: "edits BENDIK made in Notion, re-derived — a synced pipeline (W3A-s9's job), not a live third-party read",
    notion_resolve_proposal: "gated write — approve/reject only",
    obligation_dismiss: "internal store write, changes only what is shown",
    outreach_track: "internal bookkeeping write",
    remember: "internal store write, Bendik's own words only (rejectFact enforces this)",
    remind_cancel: "gated write",
    remind_list: "internal store read — the owner's own reminders",
    remind_set: "gated write",
    save_note: "internal store write — echoes back only what the model itself just wrote (\"Noted.\"), or the missing-table message; never returns third-party text",
    set_language: "session state write, always-present tool",
    travel_current: "structured trip summary via lib/travel-store.ts's allowlist, not raw booking text",
    twenty_comm_state: "gated write — returns only ok/skipped/reason flags, no freeform CRM content",
    twenty_company_for_person: "structured CRM fields (name, domain, org number), no freeform notes",
    twenty_create_opportunity: "gated write",
    twenty_do_not_contact: "gated write",
    twenty_get_person: "structured CRM fields (name, email, role, LinkedIn url), no freeform notes",
    twenty_lookup: "structured CRM fields (name, email/domain), no freeform notes",
    twenty_note: "gated write",
    twenty_set_stage: "gated write",
    voice_guide: "examples are drawn from the mailbox's OWN SENT mail — Bendik's own past words, not third-party text",
  },
  travel: {
    "agent-kit__transit_plan": "structured journey/route data, not freeform prose",
    calendar_list_events: "always the account's OWN primary calendar — no calendarId parameter exists on this tool at all, matching Owner Decision A3's bare-primary-listing case",
    currency_convert: "structured numeric conversion",
    flight_status: "structured flight-status API data",
    info: "the house-info card — the group's own linked-trip data, internal",
    link_group: "write — links a chat to a trip, admin-only",
    nearby_places: "structured place data (name/address/rating/mapsUrl) from Google Places/Overpass, not freeform prose",
    nytur: "write — creates a trip from what the model itself was told",
    persona_overlay: "regenerates a markdown file from the trip's own structured facts",
    place_link: "a deterministic Google Maps URL the tool itself builds",
    predeparture_pack: "assembly over nearby_places's own structured output — no independent read",
    remember: "internal store write, the owner's own words only",
    set_language: "session state write, always-present tool",
    shopping_add: "internal store write",
    shopping_remove: "internal store write",
    strava_routes: "structured route/activity data",
    sveip: "returns only a fixed start-acknowledgment string; the sweep's own findings are delivered via a separate Telegram send the model's turn never sees",
    toggle_kill_switch: "internal state write",
    transit_directions: "structured directions data",
    trip_status: "structured trip-registry lookup, internal",
    weather_forecast: "structured weather API data",
  },
  creative: {
    vault_write: "gated write — a write, echoes only what was written",
    set_language: "session state write, always-present tool",
    studio_ideate: "runs an internal multi-model pipeline over the model's own brief; not an outside read",
    // W5C-s3: the same one set of note tools, under this role's own names.
    vault_list: "the business's own shared Vault, internal",
    vault_read: "the business's own shared Vault, internal",
    vault_search: "the business's own shared Vault, internal",
  },
};

describe("register completeness — every catalogue tool in every role service is classified", () => {
  for (const service of ["chief-of-staff", "travel", "creative"] as const) {
    it(`${service}: every catalogue file is either a tainting tool or explicitly allow-listed as returning no outside text`, () => {
      const names = catalogueToolNames(service);
      const taints = TAINTS[service]!;
      const safe = NO_OUTSIDE_TEXT[service]!;
      const unclassified = names.filter((n) => !taints.has(n) && !(n in safe));
      expect(unclassified, `unclassified catalogue tool(s) in ${service} — classify each as tainting or add it to NO_OUTSIDE_TEXT with a reason`).toEqual([]);
    });

    it(`${service}: no tool is BOTH tainting and allow-listed`, () => {
      const taints = TAINTS[service]!;
      const safe = NO_OUTSIDE_TEXT[service]!;
      const overlap = [...taints].filter((n) => n in safe);
      expect(overlap).toEqual([]);
    });
  }
});
