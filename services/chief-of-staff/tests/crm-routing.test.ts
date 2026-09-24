import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { getPool, closePool } from "@lares/agent-kit/db";
import { ensureRouteTables, makeRouteStore, type RouteProposalInput } from "../lib/route-store.js";
import { makeRouteClassifier, type RouteActivity, type OpenOpportunity } from "../lib/route-classify.js";
import { makeRouteEngine, decideProposalMode, LOW_CONFIDENCE, type RouteProposal } from "../lib/route-engine.js";
import {
  dueRouteSlot,
  buildRouteProposalPrompt,
  makeCrmRoutingTick,
  freshState,
  type CrmRoutingDeps,
} from "../agent/schedules/crm-routing.js";

/**
 * Task 13, Part 2 — the `crm-routing` schedule: a faithful port of
 * `services/agent-runtime/lib/adapters/route/{engine,classify,store}.ts` +
 * `bin/saga.ts`'s `routeTick` (~lines 1205-1280), delivering via eve's native Slack approval
 * card (the gated `twenty_create_opportunity`/`twenty_set_stage` tools) instead of the old
 * `proposeOutbound` mechanism.
 *
 * Layers, per the brief's Step 1:
 *   1. `lib/route-store.ts` against a REAL Postgres (testcontainer, ORB-45 pattern).
 *   2. `lib/route-classify.ts` — offline, fake LLM.
 *   3. `lib/route-engine.ts` — offline, fake Twenty/classifier/store.
 *   4. `agent/schedules/crm-routing.ts` — slot matching (once per slot-hour, not every tick),
 *      the prompt builder, `makeCrmRoutingTick`'s send-then-record ordering and per-proposal
 *      failure isolation, all offline; then ONE real-Postgres integration test proving a
 *      routing tick with a stubbed Twenty client actually writes `route_proposals` rows; then
 *      the gate — off means zero store/Twenty/Slack calls.
 */

// ─── 1. lib/route-store.ts — real Postgres round-trip ──────────────────────────────────────

describe("route-store", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const pool = getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await ensureRouteTables(pool);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  afterEach(async () => {
    await getPool().query(`DELETE FROM route_proposals`);
    await getPool().query(`DELETE FROM route_cursor`);
  });

  it("getCursor returns null before any setCursor call", async () => {
    const store = makeRouteStore(getPool());
    await expect(store.getCursor()).resolves.toBeNull();
  });

  it("setCursor then getCursor round-trips the ISO timestamp", async () => {
    const store = makeRouteStore(getPool());
    await store.setCursor("2026-06-20T12:00:00.000Z");
    expect(await store.getCursor()).toBe("2026-06-20T12:00:00.000Z");
  });

  it("setCursor twice overwrites — only one singleton row ever exists", async () => {
    const store = makeRouteStore(getPool());
    await store.setCursor("2026-06-20T12:00:00.000Z");
    await store.setCursor("2026-06-21T09:00:00.000Z");
    expect(await store.getCursor()).toBe("2026-06-21T09:00:00.000Z");
    const { rows } = await getPool().query("SELECT count(*)::int AS n FROM route_cursor");
    expect(rows[0].n).toBe(1);
  });

  it("recordProposal writes a real row, and alreadyProposed sees it afterward", async () => {
    const store = makeRouteStore(getPool());
    const input: RouteProposalInput = {
      personId: "person-1", brand: "ZERO7", proposedStage: "MEETING",
      signalRef: "msg:m1", confidence: 0.8,
    };
    expect(await store.alreadyProposed({ personId: "person-1", signalRef: "msg:m1" })).toBe(false);
    const { id } = await store.recordProposal(input);
    expect(id).toBeTruthy();
    expect(await store.alreadyProposed({ personId: "person-1", signalRef: "msg:m1" })).toBe(true);

    const { rows } = await getPool().query("SELECT person_id, brand, proposed_stage, signal_ref, confidence, status FROM route_proposals WHERE id = $1", [id]);
    expect(rows[0]).toMatchObject({
      person_id: "person-1", brand: "ZERO7", proposed_stage: "MEETING",
      signal_ref: "msg:m1", status: "proposed",
    });
  });

  it("alreadyProposed dedups regardless of status", async () => {
    const store = makeRouteStore(getPool());
    const { id } = await store.recordProposal({
      personId: "person-2", brand: "ORAKEL", proposedStage: "NEW", signalRef: "cal:c1", confidence: 0.6,
    });
    await store.markResolved(id, "applied");
    expect(await store.alreadyProposed({ personId: "person-2", signalRef: "cal:c1" })).toBe(true);
  });

  it("ensureRouteTables is idempotent — safe to call twice", async () => {
    await expect(ensureRouteTables(getPool())).resolves.toBeUndefined();
  });
});

// ─── 2. lib/route-classify.ts — offline, fake LLM ──────────────────────────────────────────

describe("makeRouteClassifier", () => {
  function fakeLlm(responseJson: object): (prompt: string) => Promise<string> {
    return async () => JSON.stringify(responseJson);
  }

  function activity(overrides: Partial<RouteActivity> = {}): RouteActivity {
    return {
      personHandle: "test@example.com", kind: "meeting",
      subject: "Intro call about Zero7", body: "Discussed the Zero7 platform.",
      at: "2026-06-20T10:00:00Z", ...overrides,
    };
  }

  function opp(overrides: Partial<OpenOpportunity> = {}): OpenOpportunity {
    return { id: "opp-1", name: "Test Opportunity", stage: "NEW", brand: "ORAKEL", ...overrides };
  }

  it("empty activity → action:none WITHOUT calling the llm", async () => {
    const llmSpy = vi.fn(async () => "{}");
    const { classify } = makeRouteClassifier({ llm: llmSpy });
    const result = await classify({ activity: [], openOpportunities: [] });
    expect(result.action).toBe("none");
    expect(result.confidence).toBe(0);
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it("parses a valid classification with an existing open opp → action:move", async () => {
    const llm = fakeLlm({ brand: "ORAKEL", stage: "MEETING", action: "move", confidence: 0.9, reasoning: "advances the deal" });
    const { classify } = makeRouteClassifier({ llm });
    const result = await classify({ activity: [activity()], openOpportunities: [opp()] });
    expect(result).toMatchObject({ brand: "ORAKEL", stage: "MEETING", action: "move", confidence: 0.9 });
  });

  it("malformed/non-JSON llm output → safe fallback, no throw", async () => {
    const { classify } = makeRouteClassifier({ llm: async () => "not json at all" });
    const result = await classify({ activity: [activity()], openOpportunities: [] });
    expect(result).toEqual({ brand: null, stage: null, action: "none", confidence: 0, reasoning: "could not parse classifier output" });
  });

  it("an llm that throws → safe fallback, no throw", async () => {
    const { classify } = makeRouteClassifier({ llm: async () => { throw new Error("gateway down"); } });
    const result = await classify({ activity: [activity()], openOpportunities: [] });
    expect(result.action).toBe("none");
    expect(result.confidence).toBe(0);
  });

  it("out-of-enum brand/stage/action from the llm are coerced to null/none", async () => {
    const llm = fakeLlm({ brand: "NOT_A_BRAND", stage: "NOT_A_STAGE", action: "delete", confidence: 0.7, reasoning: "x" });
    const { classify } = makeRouteClassifier({ llm });
    const result = await classify({ activity: [activity()], openOpportunities: [] });
    expect(result.brand).toBeNull();
    expect(result.stage).toBeNull();
    expect(result.action).toBe("none");
  });

  it("confidence is clamped to [0, 1]", async () => {
    const over = await makeRouteClassifier({ llm: fakeLlm({ brand: "ZERO7", stage: "NEW", action: "create", confidence: 99, reasoning: "x" }) })
      .classify({ activity: [activity()], openOpportunities: [] });
    expect(over.confidence).toBe(1);
    const under = await makeRouteClassifier({ llm: fakeLlm({ brand: "ZERO7", stage: "NEW", action: "create", confidence: -5, reasoning: "x" }) })
      .classify({ activity: [activity()], openOpportunities: [] });
    expect(under.confidence).toBe(0);
  });

  it("tolerates a code-fence-wrapped JSON reply", async () => {
    const fenced = async () => "```json\n" + JSON.stringify({ brand: "MURMUR", stage: "QUALIFIED", action: "create", confidence: 0.75, reasoning: "x" }) + "\n```";
    const { classify } = makeRouteClassifier({ llm: fenced });
    const result = await classify({ activity: [activity()], openOpportunities: [] });
    expect(result).toMatchObject({ brand: "MURMUR", stage: "QUALIFIED", action: "create" });
  });
});

// ─── 3. lib/route-engine.ts — offline, fake Twenty/classifier/store ────────────────────────

function makeFakeTwenty(opts: {
  msgParticipants?: Array<{ personId: string | null; messageId: string; handle: string; role: string; createdAt: string }>;
  calParticipants?: Array<{ personId: string | null; calendarEventId: string; handle: string; isOrganizer: boolean; createdAt: string }>;
  messages?: Record<string, { subject: string; text: string; receivedAt: string }>;
  calendarEvents?: Record<string, { title: string; description: string; startsAt: string }>;
  opportunities?: Record<string, Array<{ id: string; name: string; stage: string; brand: string }>>;
  personNames?: Record<string, string>;
}) {
  return {
    async listRecentMessageParticipants() { return opts.msgParticipants ?? []; },
    async listRecentCalendarParticipants() { return opts.calParticipants ?? []; },
    async getMessage(id: string) { return opts.messages?.[id] ?? { subject: "", text: "", receivedAt: "" }; },
    async getCalendarEvent(id: string) { return opts.calendarEvents?.[id] ?? { title: "", description: "", startsAt: "" }; },
    async listOpportunitiesForPerson(personId: string) { return opts.opportunities?.[personId] ?? []; },
    async getPersonName(personId: string) { return opts.personNames?.[personId] ?? null; },
  };
}

function makeFakeClassifier(decision: { brand: any; stage: any; action: any; confidence: number; reasoning: string }) {
  return { async classify() { return decision; } };
}

function makeFakeRouteStore(opts: { cursor?: string | null; proposed?: Array<{ personId: string; signalRef: string }> } = {}) {
  let cursor: string | null = opts.cursor ?? null;
  const proposed = new Set((opts.proposed ?? []).map((p) => `${p.personId}::${p.signalRef}`));
  const cursorsSet: string[] = [];
  return {
    async getCursor() { return cursor; },
    async setCursor(iso: string) { cursor = iso; cursorsSet.push(iso); },
    async alreadyProposed(args: { personId: string; signalRef: string }) { return proposed.has(`${args.personId}::${args.signalRef}`); },
    async proposedSince() { return false; },
    _cursorsSet: cursorsSet,
  };
}

const FIXED_NOW = new Date("2026-06-20T12:00:00.000Z");

describe("decideProposalMode", () => {
  it("skip below LOW_CONFIDENCE, confirm at/above it", () => {
    expect(decideProposalMode(LOW_CONFIDENCE - 0.01)).toBe("skip");
    expect(decideProposalMode(LOW_CONFIDENCE)).toBe("confirm");
    expect(decideProposalMode(1)).toBe("confirm");
  });
});

describe("makeRouteEngine — scan", () => {
  it("returns a proposal for new email activity", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-1", messageId: "msg-1", handle: "contact@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-1": { subject: "Zero7 demo", text: "Let's schedule a demo.", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-1": [] },
    });
    const classifier = makeFakeClassifier({ brand: "ZERO7", stage: "MEETING", action: "create", confidence: 0.8, reasoning: "mentions Zero7" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    const proposals = await engine.scan();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      personId: "person-1", brand: "ZERO7", stage: "MEETING", action: "create",
      opportunityId: null, signalRef: "msg:msg-1", mode: "confirm", personHandle: "contact@example.com",
    });
  });

  it("ignores self-handle participants (case-insensitive)", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-self", messageId: "msg-self", handle: "OWNER@owner.example", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-self": { subject: "Hi", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
    });
    const classifier = makeFakeClassifier({ brand: "ZERO7", stage: "MEETING", action: "create", confidence: 0.9, reasoning: "x" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW, selfHandles: ["owner@owner.example"] });

    expect(await engine.scan()).toHaveLength(0);
  });

  it("skips a signal that has already been proposed", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-1", messageId: "msg-known", handle: "c@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-known": { subject: "Hi", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-1": [] },
    });
    const classifier = makeFakeClassifier({ brand: "ZERO7", stage: "MEETING", action: "create", confidence: 0.9, reasoning: "x" });
    const store = makeFakeRouteStore({ proposed: [{ personId: "person-1", signalRef: "msg:msg-known" }] });
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    expect(await engine.scan()).toHaveLength(0);
  });

  it("downgrades 'move' to 'create' when no open opp matches the brand", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-1", messageId: "msg-move", handle: "c@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-move": { subject: "Orakel follow-up", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-1": [{ id: "opp-z7", name: "zero7 opp", stage: "NEW", brand: "ZERO7" }] },
    });
    const classifier = makeFakeClassifier({ brand: "ORAKEL", stage: "QUALIFIED", action: "move", confidence: 0.85, reasoning: "x" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    const proposals = await engine.scan();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ action: "create", opportunityId: null, brand: "ORAKEL" });
  });

  it("upgrades 'create' to 'move' when an open opp for the brand already exists (duplicate guard)", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-1", messageId: "msg-dup", handle: "c@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-dup": { subject: "Orakel trial", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-1": [{ id: "opp-orakel-existing", name: "deal", stage: "NEW", brand: "ORAKEL" }] },
    });
    const classifier = makeFakeClassifier({ brand: "ORAKEL", stage: "QUALIFIED", action: "create", confidence: 0.85, reasoning: "x" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    const proposals = await engine.scan();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ action: "move", opportunityId: "opp-orakel-existing", stage: "QUALIFIED" });
  });

  it("resolves the person's real name from Twenty, falling back to the handle when absent", async () => {
    const base = {
      msgParticipants: [{ personId: "person-1", messageId: "msg-n", handle: "c@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-n": { subject: "Zero7 demo", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-1": [] },
    };
    const classifier = makeFakeClassifier({ brand: "ZERO7", stage: "MEETING", action: "create", confidence: 0.8, reasoning: "x" });

    const withName = makeRouteEngine({
      twenty: makeFakeTwenty({ ...base, personNames: { "person-1": "Jonas Markussen" } }),
      classifier, store: makeFakeRouteStore(), clock: () => FIXED_NOW,
    });
    expect((await withName.scan())[0]).toMatchObject({ personName: "Jonas Markussen" });

    const withoutName = makeRouteEngine({
      twenty: makeFakeTwenty(base),
      classifier, store: makeFakeRouteStore(), clock: () => FIXED_NOW,
    });
    expect((await withoutName.scan())[0]).toMatchObject({ personName: "c@example.com" });
  });

  it("uses the matching open opportunity id for 'move'", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-1", messageId: "msg-move-ok", handle: "c@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-move-ok": { subject: "Orakel proposal", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-1": [{ id: "opp-orakel-1", name: "deal", stage: "QUALIFIED", brand: "ORAKEL" }] },
    });
    const classifier = makeFakeClassifier({ brand: "ORAKEL", stage: "PROPOSAL", action: "move", confidence: 0.9, reasoning: "x" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    const proposals = await engine.scan();
    expect(proposals[0]).toMatchObject({ action: "move", opportunityId: "opp-orakel-1" });
  });

  it("skips below LOW_CONFIDENCE (mode:'skip')", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-1", messageId: "msg-low", handle: "c@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-low": { subject: "Hi", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-1": [] },
    });
    const classifier = makeFakeClassifier({ brand: "ZERO7", stage: "MEETING", action: "create", confidence: LOW_CONFIDENCE - 0.01, reasoning: "x" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    expect(await engine.scan()).toHaveLength(0);
  });

  it("cursor advances to the max participant createdAt even when no proposals emit", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: null, messageId: "msg-x", handle: "x@example.com", role: "FROM", createdAt: "2026-06-20T11:30:00.000Z" }],
    });
    const classifier = makeFakeClassifier({ brand: "ZERO7", stage: "MEETING", action: "create", confidence: 0.9, reasoning: "x" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    await engine.scan();
    expect(store._cursorsSet).toEqual(["2026-06-20T11:30:00.000Z"]);
  });

  it("processes multiple persons deterministically (sorted by personId)", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [
        { personId: "person-b", messageId: "msg-b", handle: "b@example.com", role: "FROM", createdAt: "2026-06-20T10:01:00.000Z" },
        { personId: "person-a", messageId: "msg-a", handle: "a@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" },
      ],
      messages: {
        "msg-a": { subject: "A", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" },
        "msg-b": { subject: "B", text: "body", receivedAt: "2026-06-20T10:01:00.000Z" },
      },
      opportunities: { "person-a": [], "person-b": [] },
    });
    const classifier = makeFakeClassifier({ brand: "ZERO7", stage: "NEW", action: "create", confidence: 0.8, reasoning: "x" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    const proposals = await engine.scan();
    expect(proposals.map((p) => p.personId)).toEqual(["person-a", "person-b"]);
  });
});

// ─── 4. agent/schedules/crm-routing.ts ──────────────────────────────────────────────────────

// ORB-193 — every tick now takes the OWNER's timezone as its third argument (resolved per tick by
// the schedule). Europe/Oslo reproduces exactly what every case in this file asserted before.
const OSLO = "Europe/Oslo";

/**
 * LAR-17-s3 — PIN, asserted against the source: `parseRouteHours`/`DEFAULT_ROUTE_HOURS` are gone
 * (the hour list is a setting now, `packages/agent-kit/src/schedule-settings.ts`'s `crm-routing`
 * key), and the live tick asks `scheduleHours` before ever computing the slot. `dueRouteSlot`
 * itself is unchanged — it still takes a plain `number[]`, whatever supplies it.
 */
describe("crm-routing.ts reads its hours from the setting (LAR-17-s3)", () => {
  it("carries no ROUTE_HOURS parsing, and asks scheduleHours before dueRouteSlot", async () => {
    const src = await (await import("node:fs/promises")).readFile(
      new URL("../agent/schedules/crm-routing.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("parseRouteHours");
    expect(src).not.toContain("DEFAULT_ROUTE_HOURS");
    expect(src).not.toContain("ROUTE_HOURS");
    expect(src.indexOf('scheduleHours("crm-routing")')).toBeGreaterThan(-1);
    expect(src.indexOf('scheduleHours("crm-routing")')).toBeLessThan(src.lastIndexOf("dueRouteSlot("));
  });
});

describe("dueRouteSlot", () => {
  it("matches only at :00 on one of the given hours, Oslo time", () => {
    // 2026-06-20T07:00:00Z = 09:00 Oslo (CEST, UTC+2)
    // ORB-193 — the timezone is now an ARGUMENT (the owner clock, resolved per tick). Passing
    // Europe/Oslo reproduces exactly what this asserted before.
    expect(dueRouteSlot(new Date("2026-06-20T07:00:00Z"), "Europe/Oslo", [9, 13, 17])).toBe("2026-06-20T9");
    expect(dueRouteSlot(new Date("2026-06-20T07:01:00Z"), "Europe/Oslo", [9, 13, 17])).toBeNull();
    expect(dueRouteSlot(new Date("2026-06-20T08:00:00Z"), "Europe/Oslo", [9, 13, 17])).toBeNull();
  });
});

describe("buildRouteProposalPrompt", () => {
  function proposal(overrides: Partial<RouteProposal> = {}): RouteProposal {
    return {
      personId: "person-1", opportunityId: null, brand: "ZERO7", stage: "MEETING",
      action: "create", confidence: 0.8, reasoning: "mentions Zero7 demo",
      signalRef: "msg:m1", mode: "confirm", personHandle: "contact@example.com",
      personName: "Contact Example",
      ...overrides,
    };
  }

  it("instructs twenty_create_opportunity for a create action, with the exact args", () => {
    const text = buildRouteProposalPrompt(proposal());
    expect(text).toContain("twenty_create_opportunity");
    expect(text).toContain("ZERO7");
    expect(text).toContain("contact@example.com");
    expect(text).toContain("80%");
    expect(text).toContain("mentions Zero7 demo");
    expect(text).not.toContain("twenty_set_stage");
  });

  it("names a created opportunity after the person's real name, not the email handle", () => {
    const text = buildRouteProposalPrompt(proposal());
    expect(text).toContain('name: "ZERO7 — Contact Example"');
    expect(text).not.toContain('name: "ZERO7 — contact@example.com"');
  });

  it("instructs twenty_set_stage for a move action, with the opportunity id", () => {
    const text = buildRouteProposalPrompt(proposal({ action: "move", opportunityId: "opp-1", brand: "ORAKEL", stage: "PROPOSAL" }));
    expect(text).toContain("twenty_set_stage");
    expect(text).toContain("opp-1");
    expect(text).toContain("PROPOSAL");
    expect(text).not.toContain("twenty_create_opportunity");
  });

  it("instructs the model to post a plain-language sentence BEFORE calling the gated tool", () => {
    const text = buildRouteProposalPrompt(proposal());
    expect(text).toMatch(/plain-language/i);
    const sentenceIdx = text.search(/plain-language/i);
    const toolIdx = text.indexOf("Then call twenty_create_opportunity");
    expect(toolIdx).toBeGreaterThan(sentenceIdx);
  });

  // 2026-09-07: three declined proposals (Kai ×3, Stefan ×2, Finago) each came back as a
  // multi-paragraph analysis in the Saga DM — useful once, noise every morning. A decline is a
  // signal the ENGINE should have filtered; when one still reaches the model it costs one line.
  it("tells the model a decline is one short sentence, not an analysis", () => {
    const text = buildRouteProposalPrompt(proposal());
    expect(text).toContain("at most ONE short sentence");
    expect(text).toMatch(/no analysis/i);
    expect(text).not.toContain("say so instead and do not");
  });

  it("mentions the gated-approval-card behaviour", () => {
    const text = buildRouteProposalPrompt(proposal());
    expect(text).toMatch(/gated/i);
    expect(text).toMatch(/👍/);
  });
});

describe("makeCrmRoutingTick", () => {
  function proposal(overrides: Partial<RouteProposal> = {}): RouteProposal {
    return {
      personId: "person-1", opportunityId: null, brand: "ZERO7", stage: "MEETING",
      action: "create", confidence: 0.8, reasoning: "x",
      signalRef: "msg:m1", mode: "confirm", personHandle: "contact@example.com",
      personName: "Contact Example",
      ...overrides,
    };
  }

  function harness(scanResult: RouteProposal[]) {
    const sent: string[] = [];
    const recorded: RouteProposalInput[] = [];
    const deps: CrmRoutingDeps = {
      engine: { scan: async () => scanResult },
      store: { recordProposal: async (input) => { recorded.push(input); return { id: "row-1" }; } },
      door: { send: async (prompt) => { sent.push(prompt); } },
    };
    return { deps, sent, recorded };
  }

  const HOURS = [9, 13, 17];
  const AT_SLOT = new Date("2026-06-20T07:00:00Z"); // 09:00 Oslo
  const NOT_SLOT = new Date("2026-06-20T07:05:00Z"); // 09:05 Oslo

  it("does nothing when not in a slot minute, and resolves false — no pass happened this call", async () => {
    const { deps, sent, recorded } = harness([proposal()]);
    await expect(makeCrmRoutingTick(deps).tick(NOT_SLOT, HOURS, OSLO)).resolves.toBe(false);
    expect(sent).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("fires once per slot-hour — a second tick at the same slot is a no-op and resolves false", async () => {
    const { deps, sent } = harness([proposal()]);
    const state = freshState();
    await expect(makeCrmRoutingTick(deps, state).tick(AT_SLOT, HOURS, OSLO)).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    // Simulate the schedule firing again a minute later at the SAME hour (still minute 0 of
    // no other hour) — same slot key, must not re-fire.
    await expect(makeCrmRoutingTick(deps, state).tick(AT_SLOT, HOURS, OSLO)).resolves.toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("fires again at the NEXT slot hour", async () => {
    const { deps, sent } = harness([proposal()]);
    const state = freshState();
    await makeCrmRoutingTick(deps, state).tick(AT_SLOT, HOURS, OSLO);
    expect(sent).toHaveLength(1);
    const nextSlot = new Date("2026-06-20T11:00:00Z"); // 13:00 Oslo
    await expect(makeCrmRoutingTick(deps, state).tick(nextSlot, HOURS, OSLO)).resolves.toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("records a proposal only AFTER a successful send", async () => {
    const { deps, sent, recorded } = harness([proposal()]);
    await expect(makeCrmRoutingTick(deps).tick(AT_SLOT, HOURS, OSLO)).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ personId: "person-1", brand: "ZERO7", proposedStage: "MEETING", signalRef: "msg:m1" });
  });

  it("a send failure is NOT recorded, and does not block the next proposal in the batch", async () => {
    const sent: string[] = [];
    const recorded: RouteProposalInput[] = [];
    let call = 0;
    const deps: CrmRoutingDeps = {
      engine: { scan: async () => [proposal({ personId: "p-fail", signalRef: "msg:fail" }), proposal({ personId: "p-ok", signalRef: "msg:ok" })] },
      store: { recordProposal: async (input) => { recorded.push(input); return { id: "row" }; } },
      door: {
        send: async (prompt) => {
          call += 1;
          if (call === 1) throw new Error("Slack send failed");
          sent.push(prompt);
        },
      },
    };
    await expect(makeCrmRoutingTick(deps).tick(AT_SLOT, HOURS, OSLO)).resolves.toBe(true); // one item's send failure still completes the pass
    expect(sent).toHaveLength(1); // only the second proposal's send succeeded
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.personId).toBe("p-ok");
  });

  it("skips a proposal whose mode is not 'confirm', and still resolves true (a completed pass with nothing to deliver)", async () => {
    const { deps, sent, recorded } = harness([proposal({ mode: "auto" as never })]);
    await expect(makeCrmRoutingTick(deps).tick(AT_SLOT, HOURS, OSLO)).resolves.toBe(true);
    expect(sent).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  // ORB-175 fix round 1 (controller ruling) — a tick whose OUTER catch swallowed the whole
  // pass (here, engine.scan() itself throwing) is a FAILED pass: tick() must not throw, but
  // must resolve false so the caller does not stamp the heartbeat.
  it("a scan() failure does not throw out of tick(), and resolves false", async () => {
    const deps: CrmRoutingDeps = {
      engine: { scan: async () => { throw new Error("Twenty is down"); } },
      store: { recordProposal: async () => ({ id: "x" }) },
      door: { send: async () => {} },
    };
    await expect(makeCrmRoutingTick(deps).tick(AT_SLOT, HOURS, OSLO)).resolves.toBe(false);
  });
});

// ─── 5. Real-Postgres integration: a routing tick with a stubbed Twenty writes route_proposals ──

describe("crm-routing integration (real Postgres, stubbed Twenty)", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const pool = getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await ensureRouteTables(pool);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  it("a routing tick with a stubbed Twenty client returns proposals and writes real route_proposals rows", async () => {
    const pool = getPool();
    const store = makeRouteStore(pool);

    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-int", messageId: "msg-int", handle: "lead@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-int": { subject: "Zero7 pilot", text: "Ready to start a pilot.", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-int": [] },
    });
    const classifier = makeFakeClassifier({ brand: "ZERO7", stage: "PROPOSAL", action: "create", confidence: 0.9, reasoning: "pilot signal" });
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    const sent: string[] = [];
    const tick = makeCrmRoutingTick({ engine, store, door: { send: async (p) => { sent.push(p); } } });
    await tick.tick(new Date("2026-06-20T07:00:00Z"), [9], OSLO); // 09:00 Oslo

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("lead@example.com");

    const { rows } = await pool.query("SELECT person_id, brand, proposed_stage, signal_ref FROM route_proposals");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ person_id: "person-int", brand: "ZERO7", proposed_stage: "PROPOSAL", signal_ref: "msg:msg-int" });

    // A second scan against the same store must not re-propose the same signal.
    const proposalsAgain = await engine.scan();
    expect(proposalsAgain).toHaveLength(0);
  });
});

// ─── 6. Gate off → complete no-op ───────────────────────────────────────────────────────────

describe("crm-routing schedule — gate", () => {
  afterEach(() => {
    delete process.env["EVE_SCHEDULES_LIVE"];
    delete process.env["DATABASE_URL"];
    delete process.env["SLACK_ALLOWED_USER_IDS"];
  });

  it("gate off → zero store/Twenty/Slack calls (default export's run() is a full no-op)", async () => {
    delete process.env["EVE_SCHEDULES_LIVE"]; // fails closed
    // Deliberately leave DATABASE_URL/SLACK_ALLOWED_USER_IDS UNSET — if the gate did not
    // block before touching Postgres or the Slack allowlist, this would throw instead of
    // quietly returning, proving the early return actually happened.
    const toSpy = vi.fn();
    const waitUntilSpy = vi.fn();
    const { default: schedule } = await import("../agent/schedules/crm-routing.js");

    await expect(
      schedule.run!({ to: toSpy as never, waitUntil: waitUntilSpy as never, appAuth: {} as never }),
    ).resolves.toBeUndefined();

    expect(toSpy).not.toHaveBeenCalled();
    expect(waitUntilSpy).not.toHaveBeenCalled();
  });
});
