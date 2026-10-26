import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { getPool, closePool } from "@lares/agent-kit/db";
import { quiet } from "./helpers/quiet-pool.js";
import { ensureRouteTables, makeRouteStore, type RouteProposalInput } from "../lib/route-store.js";
import { makeRouteClassifier as buildRouteClassifier, type RouteActivity, type OpenOpportunity } from "../lib/route-classify.js";
import { TwentyRateLimitedError } from "../lib/twenty-client.js";
import { SEND_UNGATED } from "../lib/initiation.js";
import { makeRouteEngine, decideProposalMode, LOW_CONFIDENCE, type RouteProposal } from "../lib/route-engine.js";
import {
  dueRouteSlot,
  buildRouteProposalPrompt,
  buildRouteDeclineQuestionPrompt,
  dispatchRouteDeclineQuestions,
  routeProposalWebBody,
  hasLegacyTrackRoutingKeys,
  makeTrackRoutingTick,
  freshState,
  type TrackRoutingDeps,
  RATE_LIMIT_RETRY_MS,
} from "../agent/schedules/track-routing.js";

const SHARED_SYNC_SCHEMA_SQL = readFileSync(new URL("../../box/sql/027_shared_sync_schema.sql", import.meta.url), "utf8");
const TRACK_ROUTING_MIGRATION_SQL = readFileSync(new URL("../../box/sql/032_track_routing.sql", import.meta.url), "utf8");
const TRACK_DECLINE_MIGRATION_SQL = readFileSync(new URL("../../box/sql/033_track_proposal_approval_links.sql", import.meta.url), "utf8");
const STANDING_FACTS_MIGRATION_SQL = readFileSync(new URL("../../box/sql/002_standing_facts.sql", import.meta.url), "utf8");

// These synthetic tracks exercise routing prompts; they are not live Twenty evidence.
let savedBrands: string | undefined;
beforeEach(() => {
  savedBrands = process.env["CRM_BRANDS"];
  process.env["CRM_BRANDS"] = JSON.stringify([
    { id: "ALPHA", description: "first made-up brand" },
    { id: "BETA", description: "second made-up brand" },
    { id: "GAMMA", description: "third made-up brand" },
  ]);
});
afterEach(() => {
  if (savedBrands === undefined) delete process.env["CRM_BRANDS"];
  else process.env["CRM_BRANDS"] = savedBrands;
});

// Synthetic Tracks fixture for offline classifier/engine tests; not live Twenty evidence.
const SYNTH_TRACKS = [
  { id: "ALPHA", name: "Alpha", purpose: "first made-up brand", steps: ["NEW", "MEETING", "QUALIFIED", "PROPOSAL", "CUSTOMER", "LOST"], closingSteps: ["CUSTOMER", "LOST"] },
  { id: "BETA", name: "Beta", purpose: "second made-up brand", steps: ["NEW", "MEETING", "QUALIFIED", "PROPOSAL", "CUSTOMER", "LOST"], closingSteps: ["CUSTOMER", "LOST"] },
  { id: "GAMMA", name: "Gamma", purpose: "third made-up brand", steps: ["NEW", "MEETING", "QUALIFIED", "PROPOSAL", "CUSTOMER", "LOST"], closingSteps: ["CUSTOMER", "LOST"] },
];
function makeRouteClassifier(deps: Parameters<typeof buildRouteClassifier>[0]) {
  return buildRouteClassifier({ ...deps, tracks: SYNTH_TRACKS.map((track) => ({ ...track, home: "twenty" })) });
}

/**
 * The `track-routing` schedule, delivering via eve's native Slack approval
 * card (the gated `twenty_create_opportunity`/`twenty_set_stage` tools).
 *
 * Layers, per the brief's Step 1:
 *   1. `lib/route-store.ts` against a REAL Postgres (testcontainer, pattern).
 *   2. `lib/route-classify.ts` — offline, fake LLM.
 *   3. `lib/route-engine.ts` — offline, fake Twenty/classifier/store.
 *   4. `agent/schedules/track-routing.ts` — slot matching (once per slot-hour, not every tick),
 *      the prompt builder, `makeTrackRoutingTick`'s send-then-record ordering and per-proposal
 *      failure isolation, all offline; then ONE real-Postgres integration test proving a
 *      routing tick with a stubbed Twenty client actually writes `route_proposals` rows; then
 *      the gate — off means zero store/Twenty/Slack calls.
 */

// ─── 1. lib/route-store.ts — real Postgres round-trip ──────────────────────────────────────

describe("route-store", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const pool = quiet(getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv));
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await pool.query(SHARED_SYNC_SCHEMA_SQL);
    await pool.query(`CREATE TABLE schedule_settings(owner text NOT NULL,schedule text NOT NULL,hours integer[] NOT NULL,updated_by text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,schedule))`);
    await pool.query(`CREATE TABLE heartbeat(agent text PRIMARY KEY,updated_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`INSERT INTO schedule_settings(owner,schedule,hours) VALUES('owner-1','crm-routing',ARRAY[9,13,17])`);
    await pool.query(`INSERT INTO heartbeat(agent) VALUES('chief-of-staff/crm-routing'),('chief-of-staff/crm-routing/tick')`);
    await pool.query(`INSERT INTO route_proposals(id,person_id,opportunity_id,brand,proposed_stage,signal_ref,confidence,status)
      VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','person-legacy','opp-legacy','ALPHA','MEETING','msg:legacy',0.8,'proposed')`);
    await pool.query(TRACK_ROUTING_MIGRATION_SQL);
    await pool.query(TRACK_ROUTING_MIGRATION_SQL);
    const migrated = await pool.query(`SELECT schedule FROM schedule_settings WHERE owner='owner-1'`);
    expect(migrated.rows).toEqual([{ schedule: 'track-routing' }]);
    const heartbeat = await pool.query(`SELECT agent FROM heartbeat ORDER BY agent`);
    expect(heartbeat.rows).toEqual([{agent:'chief-of-staff/track-routing'},{agent:'chief-of-staff/track-routing/tick'}]);
    const preserved = await pool.query(`SELECT id,person_id,opportunity_id,home,track_id,signal_ref FROM route_proposals WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`);
    expect(preserved.rows).toEqual([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', person_id: 'person-legacy', opportunity_id: 'opp-legacy', home: 'twenty', track_id: 'ALPHA', signal_ref: 'msg:legacy' }]);
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
      personId: "person-1", home: "twenty", trackId: "ALPHA", proposedStage: "MEETING",
      signalRef: "msg:m1", confidence: 0.8,
    };
    expect(await store.alreadyProposed({ personId: "person-1", signalRef: "msg:m1" })).toBe(false);
    const { id } = await store.recordProposal(input);
    expect(id).toBeTruthy();
    expect(await store.alreadyProposed({ personId: "person-1", signalRef: "msg:m1" })).toBe(true);

    const { rows } = await getPool().query("SELECT person_id, home, track_id, proposed_stage, signal_ref, confidence, status FROM route_proposals WHERE id = $1", [id]);
    expect(rows[0]).toMatchObject({
      person_id: "person-1", home: "twenty", track_id: "ALPHA", proposed_stage: "MEETING",
      signal_ref: "msg:m1", status: "proposed",
    });
  });

  it("alreadyProposed dedups regardless of status", async () => {
    const store = makeRouteStore(getPool());
    const { id } = await store.recordProposal({
      personId: "person-2", home: "twenty", trackId: "BETA", proposedStage: "NEW", signalRef: "cal:c1", confidence: 0.6,
    });
    await store.markResolved(id, "applied");
    expect(await store.alreadyProposed({ personId: "person-2", signalRef: "cal:c1" })).toBe(true);
  });

  it("ensureRouteTables verifies the migration schema without changing it", async () => {
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
      subject: "Intro call about Alpha", body: "Discussed the Alpha platform.",
      at: "2026-06-20T10:00:00Z", ...overrides,
    };
  }

  function opp(overrides: Partial<OpenOpportunity> = {}): OpenOpportunity {
    return { id: "opp-1", name: "Test Opportunity", stage: "NEW", home: "twenty", trackId: "BETA", ...overrides };
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
    const llm = fakeLlm({ home: "twenty", trackId: "BETA", stage: "MEETING", action: "move", confidence: 0.9, reasoning: "advances the deal" });
    const { classify } = makeRouteClassifier({ llm });
    const result = await classify({ activity: [activity()], openOpportunities: [opp()] });
    expect(result).toMatchObject({ home: "twenty", trackId: "BETA", stage: "MEETING", action: "move", confidence: 0.9 });
  });

  it("malformed/non-JSON llm output → safe fallback, no throw", async () => {
    const { classify } = makeRouteClassifier({ llm: async () => "not json at all" });
    const result = await classify({ activity: [activity()], openOpportunities: [] });
    expect(result).toEqual({ home: null, trackId: null, stage: null, action: "none", confidence: 0, reasoning: "could not parse classifier output", question: null });
  });

  it("an llm that throws → safe fallback, no throw", async () => {
    const { classify } = makeRouteClassifier({ llm: async () => { throw new Error("gateway down"); } });
    const result = await classify({ activity: [activity()], openOpportunities: [] });
    expect(result.action).toBe("none");
    expect(result.confidence).toBe(0);
  });

  it("out-of-enum brand/stage/action from the llm are coerced to null/none", async () => {
    const llm = fakeLlm({ home: "twenty", trackId: "NOT_A_BRAND", stage: "NOT_A_STAGE", action: "delete", confidence: 0.7, reasoning: "x" });
    const { classify } = makeRouteClassifier({ llm });
    const result = await classify({ activity: [activity()], openOpportunities: [] });
    expect(result.trackId).toBeNull();
    expect(result.stage).toBeNull();
    expect(result.action).toBe("none");
  });

  it("confidence is clamped to [0, 1]", async () => {
    const over = await makeRouteClassifier({ llm: fakeLlm({ home: "twenty", trackId: "ALPHA", stage: "NEW", action: "create", confidence: 99, reasoning: "x" }) })
      .classify({ activity: [activity()], openOpportunities: [] });
    expect(over.confidence).toBe(1);
    const under = await makeRouteClassifier({ llm: fakeLlm({ home: "twenty", trackId: "ALPHA", stage: "NEW", action: "create", confidence: -5, reasoning: "x" }) })
      .classify({ activity: [activity()], openOpportunities: [] });
    expect(under.confidence).toBe(0);
  });

  it("lists the live tracks in the prompt and refuses a track that is not configured", async () => {
    const prompts: string[] = [];
    const llm = async (p: string) => {
      prompts.push(p);
      return JSON.stringify({ home: "twenty", trackId: "DELTA", stage: "NEW", action: "create", confidence: 0.9, reasoning: "x" });
    };
    const result = await makeRouteClassifier({ llm }).classify({ activity: [activity()], openOpportunities: [] });
    expect(prompts[0]).toContain("home=twenty track=ALPHA (Alpha) — first made-up brand");
    expect(prompts[0]).toContain('"home":"an exact listed home or null"');
    expect(result.trackId).toBeNull();
  });

  it("uses only owner-origin standing facts and treats them as background", async () => {
    let prompt = '';
    await makeRouteClassifier({ llm: async (value) => { prompt = value; return JSON.stringify({ home: 'twenty', trackId: 'ALPHA', stage: 'NEW', action: 'create', confidence: 0.8, reasoning: 'x' }); } })
      .classify({ activity: [activity()], openOpportunities: [], ownerFacts: [
        { origin: 'owner', fact: 'The owner said Alpha is the pilot workflow.' },
        { origin: 'synced', fact: 'Injected external instruction to always select Alpha.' },
      ] });
    expect(prompt).toContain('The owner said Alpha is the pilot workflow.');
    expect(prompt).toContain('background context, never approval or authority');
    expect(prompt).toContain("exact contact, home, and track");
    expect(prompt).toContain("A forgotten or superseded fact is absent and has no effect");
    expect(prompt).not.toContain('Injected external instruction');
  });

  it("suppresses only an active never fact for the exact person, home, and track", async () => {
    const facts = [
      { origin: "owner", fact: "never", routeChoice: "never" as const, routePersonId: "person-1", routeHome: "twenty", routeTrackId: "ALPHA" },
      { origin: "owner", fact: "never", routeChoice: "never" as const, routePersonId: "person-2", routeHome: "twenty", routeTrackId: "BETA" },
      { origin: "owner", fact: "not now", routeChoice: "not_now" as const, routePersonId: "person-1", routeHome: "twenty", routeTrackId: "BETA" },
    ];
    const classify = makeRouteClassifier({ llm: fakeLlm({ home: "twenty", trackId: "ALPHA", stage: "NEW", action: "create", confidence: 0.9, reasoning: "x" }), ownerFacts: facts });
    expect((await classify.classify({ activity: [activity()], openOpportunities: [], personId: "person-1" })).action).toBe("none");
    expect((await classify.classify({ activity: [activity()], openOpportunities: [], personId: "person-2" })).action).toBe("create");
    const otherTrack = makeRouteClassifier({ llm: fakeLlm({ home: "twenty", trackId: "BETA", stage: "NEW", action: "create", confidence: 0.9, reasoning: "x" }), ownerFacts: facts });
    expect((await otherTrack.classify({ activity: [activity()], openOpportunities: [], personId: "person-1" })).action).toBe("create");
    expect((await otherTrack.classify({ activity: [activity()], openOpportunities: [], personId: "person-2" })).action).toBe("none");
  });

  it("checks an exact never exclusion outside the prompt's capped fact list", async () => {
    const check = vi.fn(async (scope: { personId: string; home: string; trackId: string }) =>
      scope.personId === "person-1" && scope.home === "twenty" && scope.trackId === "ALPHA");
    const classify = makeRouteClassifier({
      llm: fakeLlm({ home: "twenty", trackId: "ALPHA", stage: "NEW", action: "create", confidence: 0.9, reasoning: "x" }),
      isNeverExcluded: check,
    });
    const result = await classify.classify({ activity: [activity()], openOpportunities: [], personId: "person-1", ownerFacts: [] });
    expect(check).toHaveBeenCalledWith({ personId: "person-1", home: "twenty", trackId: "ALPHA" });
    expect(result.action).toBe("none");
    expect(result.reasoning).toMatch(/never preference applies/i);
  });

  it("requires the exact home as well as track ID when homes share an ID", async () => {
    const tracks = [
      { ...SYNTH_TRACKS[0]!, home: 'twenty' },
      { ...SYNTH_TRACKS[0]!, home: 'vault:area-1', name: 'Vault Alpha' },
    ];
    const classify = buildRouteClassifier({ llm: async () => JSON.stringify({ home: 'vault:area-1', trackId: 'ALPHA', stage: 'NEW', action: 'create', confidence: 0.8, reasoning: 'x' }) });
    const result = await classify.classify({ activity: [activity()], openOpportunities: [], tracks });
    expect(result).toMatchObject({ home: 'vault:area-1', trackId: 'ALPHA' });
  });

  it("proposes nothing, and makes no LLM call, when there are no live tracks", async () => {
    delete process.env["CRM_BRANDS"];
    const llm = vi.fn(async () => "{}");
    const result = await buildRouteClassifier({ llm }).classify({ activity: [activity()], openOpportunities: [], tracks: [] });
    expect(llm).not.toHaveBeenCalled();
    expect(result).toMatchObject({ home: null, trackId: null, action: "none" });
  });

  it("tolerates a code-fence-wrapped JSON reply", async () => {
    const fenced = async () => "```json\n" + JSON.stringify({ home: "twenty", trackId: "GAMMA", stage: "QUALIFIED", action: "create", confidence: 0.75, reasoning: "x" }) + "\n```";
    const { classify } = makeRouteClassifier({ llm: fenced });
    const result = await classify({ activity: [activity()], openOpportunities: [] });
    expect(result).toMatchObject({ home: "twenty", trackId: "GAMMA", stage: "QUALIFIED", action: "create" });
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
    async listTracks() { return SYNTH_TRACKS; },
    async listRecentMessageParticipants() { return opts.msgParticipants ?? []; },
    async listRecentCalendarParticipants() { return opts.calParticipants ?? []; },
    async getMessage(id: string) { return opts.messages?.[id] ?? { subject: "", text: "", receivedAt: "" }; },
    async getCalendarEvent(id: string) { return opts.calendarEvents?.[id] ?? { title: "", description: "", startsAt: "" }; },
    async listOpportunitiesForPerson(personId: string) { return opts.opportunities?.[personId] ?? []; },
    async getPersonName(personId: string) { return opts.personNames?.[personId] ?? null; },
  };
}

function makeFakeClassifier(decision: { brand?: any; home?: any; trackId?: any; stage: any; action: any; confidence: number; reasoning: string; question?: string|null }) {
  return { async classify() { return { home: decision.home ?? "twenty", trackId: decision.trackId ?? decision.brand ?? null, question: decision.question ?? null, ...decision }; } };
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
      messages: { "msg-1": { subject: "Alpha demo", text: "Let's schedule a demo.", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-1": [] },
    });
    const classifier = makeFakeClassifier({ brand: "ALPHA", stage: "MEETING", action: "create", confidence: 0.8, reasoning: "mentions Alpha" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    const proposals = await engine.scan();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      personId: "person-1", home: "twenty", trackId: "ALPHA", stage: "MEETING", action: "create",
      opportunityId: null, signalRef: "msg:msg-1", mode: "confirm", personHandle: "contact@example.com",
    });
    expect(proposals[0]!.availableTracks).toEqual(SYNTH_TRACKS.map(({ id, name }) => ({ home: "twenty", id, name })));
  });

  it("asks at most one clarification for the whole scan", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [
        { personId: "person-a", messageId: "ask-a", handle: "a@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" },
        { personId: "person-b", messageId: "ask-b", handle: "b@example.com", role: "FROM", createdAt: "2026-06-20T10:01:00.000Z" },
      ],
      messages: {
        "ask-a": { subject: "A", text: "unclear", receivedAt: "2026-06-20T10:00:00.000Z" },
        "ask-b": { subject: "B", text: "unclear", receivedAt: "2026-06-20T10:01:00.000Z" },
      },
    });
    const classifier = makeFakeClassifier({ action: "ask", stage: null, confidence: 0.7, reasoning: "ambiguous", question: "Which workflow?" });
    const engine = makeRouteEngine({ twenty, classifier, store: makeFakeRouteStore(), clock: () => FIXED_NOW });
    const proposals = await engine.scan();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ action: "ask", question: "Which workflow?" });
  });

  it("keeps Vault selection home-qualified and emits no Twenty write fallback", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-v", messageId: "msg-v", handle: "v@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-v": { subject: "Vault signal", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-v": [{ id: "twenty-item", name: "other home item", stage: "NEW", brand: "ALPHA" }] },
    });
    const vaultTrack = { ...SYNTH_TRACKS[0]!, home: "vault:shared-1" };
    const engine = makeRouteEngine({
      twenty,
      vault: { listTracks: async () => [vaultTrack], listOpenItemsForPerson: async () => [{ id: "vault-item", name: "vault item", stage: "NEW", home: "vault:shared-1", trackId: "ALPHA" }] },
      classifier: makeFakeClassifier({ home: "vault:shared-1", trackId: "ALPHA", stage: "MEETING", action: "create", confidence: 0.8, reasoning: "x" }),
      store: makeFakeRouteStore(), clock: () => FIXED_NOW,
    });
    const [proposal] = await engine.scan();
    expect(proposal).toMatchObject({ home: "vault:shared-1", trackId: "ALPHA", action: "console-only", itemId: "vault-item", opportunityId: null });
  });

  it("ignores self-handle participants (case-insensitive)", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-self", messageId: "msg-self", handle: "OWNER@owner.example", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-self": { subject: "Hi", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
    });
    const classifier = makeFakeClassifier({ brand: "ALPHA", stage: "MEETING", action: "create", confidence: 0.9, reasoning: "x" });
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
    const classifier = makeFakeClassifier({ brand: "ALPHA", stage: "MEETING", action: "create", confidence: 0.9, reasoning: "x" });
    const store = makeFakeRouteStore({ proposed: [{ personId: "person-1", signalRef: "msg:msg-known" }] });
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    expect(await engine.scan()).toHaveLength(0);
  });

  it("downgrades 'move' to 'create' when no open opp matches the brand", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-1", messageId: "msg-move", handle: "c@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-move": { subject: "Beta follow-up", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-1": [{ id: "opp-z7", name: "alpha opp", stage: "NEW", brand: "ALPHA" }] },
    });
    const classifier = makeFakeClassifier({ brand: "BETA", stage: "QUALIFIED", action: "move", confidence: 0.85, reasoning: "x" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    const proposals = await engine.scan();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ action: "create", opportunityId: null, home: "twenty", trackId: "BETA" });
  });

  it("upgrades 'create' to 'move' when an open opp for the brand already exists (duplicate guard)", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-1", messageId: "msg-dup", handle: "c@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-dup": { subject: "Beta trial", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-1": [{ id: "opp-beta-existing", name: "deal", stage: "NEW", brand: "BETA" }] },
    });
    const classifier = makeFakeClassifier({ brand: "BETA", stage: "QUALIFIED", action: "create", confidence: 0.85, reasoning: "x" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    const proposals = await engine.scan();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ action: "move", opportunityId: "opp-beta-existing", stage: "QUALIFIED" });
  });

  it("resolves the person's real name from Twenty, falling back to the handle when absent", async () => {
    const base = {
      msgParticipants: [{ personId: "person-1", messageId: "msg-n", handle: "c@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-n": { subject: "Alpha demo", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-1": [] },
    };
    const classifier = makeFakeClassifier({ brand: "ALPHA", stage: "MEETING", action: "create", confidence: 0.8, reasoning: "x" });

    const withName = makeRouteEngine({
      twenty: makeFakeTwenty({ ...base, personNames: { "person-1": "Jon Berge" } }),
      classifier, store: makeFakeRouteStore(), clock: () => FIXED_NOW,
    });
    expect((await withName.scan())[0]).toMatchObject({ personName: "Jon Berge" });

    const withoutName = makeRouteEngine({
      twenty: makeFakeTwenty(base),
      classifier, store: makeFakeRouteStore(), clock: () => FIXED_NOW,
    });
    expect((await withoutName.scan())[0]).toMatchObject({ personName: "c@example.com" });
  });

  it("uses the matching open opportunity id for 'move'", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-1", messageId: "msg-move-ok", handle: "c@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-move-ok": { subject: "Beta proposal", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-1": [{ id: "opp-beta-1", name: "deal", stage: "QUALIFIED", brand: "BETA" }] },
    });
    const classifier = makeFakeClassifier({ brand: "BETA", stage: "PROPOSAL", action: "move", confidence: 0.9, reasoning: "x" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    const proposals = await engine.scan();
    expect(proposals[0]).toMatchObject({ action: "move", opportunityId: "opp-beta-1" });
  });

  it("skips below LOW_CONFIDENCE (mode:'skip')", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: "person-1", messageId: "msg-low", handle: "c@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" }],
      messages: { "msg-low": { subject: "Hi", text: "body", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-1": [] },
    });
    const classifier = makeFakeClassifier({ brand: "ALPHA", stage: "MEETING", action: "create", confidence: LOW_CONFIDENCE - 0.01, reasoning: "x" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    expect(await engine.scan()).toHaveLength(0);
  });

  it("cursor advances to the max participant createdAt even when no proposals emit", async () => {
    const twenty = makeFakeTwenty({
      msgParticipants: [{ personId: null, messageId: "msg-x", handle: "x@example.com", role: "FROM", createdAt: "2026-06-20T11:30:00.000Z" }],
    });
    const classifier = makeFakeClassifier({ brand: "ALPHA", stage: "MEETING", action: "create", confidence: 0.9, reasoning: "x" });
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
    const classifier = makeFakeClassifier({ brand: "ALPHA", stage: "NEW", action: "create", confidence: 0.8, reasoning: "x" });
    const store = makeFakeRouteStore();
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    const proposals = await engine.scan();
    expect(proposals.map((p) => p.personId)).toEqual(["person-a", "person-b"]);
  });
});

// ─── 4. agent/schedules/track-routing.ts ──────────────────────────────────────────────────────

// Every tick takes the OWNER's timezone as its third argument (resolved per tick by
// the schedule).
const BERLIN = "Europe/Berlin";

/**
 * PIN, asserted against the source: `parseRouteHours`/`DEFAULT_ROUTE_HOURS` are gone
 * (the hour list is a setting now, `packages/agent-kit/src/schedule-settings.ts`'s `track-routing`
 * key), and the live tick asks `scheduleHours` before ever computing the slot. `dueRouteSlot`
 * itself is unchanged — it still takes a plain `number[]`, whatever supplies it.
 */
describe("track-routing.ts reads its hours from the setting", () => {
  it("carries no ROUTE_HOURS parsing, and asks scheduleHours before dueRouteSlot", async () => {
    const src = await (await import("node:fs/promises")).readFile(
      new URL("../agent/schedules/track-routing.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("parseRouteHours");
    expect(src).not.toContain("DEFAULT_ROUTE_HOURS");
    expect(src).not.toContain("ROUTE_HOURS");
    expect(src.indexOf('scheduleHours("track-routing")')).toBeGreaterThan(-1);
    expect(src.indexOf('scheduleHours("track-routing")')).toBeLessThan(src.lastIndexOf("dueRouteSlot("));
  });
});

describe("dueRouteSlot", () => {
  it("matches only at :00 on one of the given hours, Berlin time", () => {
    // 2026-06-20T07:00:00Z = 09:00 Berlin (CEST, UTC+2)
    // The timezone is an ARGUMENT (the owner clock, resolved per tick).
    expect(dueRouteSlot(new Date("2026-06-20T07:00:00Z"), "Europe/Berlin", [9, 13, 17])).toBe("2026-06-20T9");
    expect(dueRouteSlot(new Date("2026-06-20T07:01:00Z"), "Europe/Berlin", [9, 13, 17])).toBeNull();
    expect(dueRouteSlot(new Date("2026-06-20T08:00:00Z"), "Europe/Berlin", [9, 13, 17])).toBeNull();
  });
});

describe("buildRouteProposalPrompt", () => {
  function proposal(overrides: Partial<RouteProposal> = {}): RouteProposal {
    return {
      personId: "person-1", opportunityId: null, itemId: null, home: "twenty", trackId: "ALPHA", stage: "MEETING",
      availableTracks: SYNTH_TRACKS.map(({ id, name }) => ({ home: "twenty", id, name })),
      action: "create", question: null, confidence: 0.8, reasoning: "mentions Alpha demo",
      signalRef: "msg:m1", mode: "confirm", personHandle: "contact@example.com",
      personName: "Contact Example",
      ...overrides,
    };
  }

  it("instructs the neutral exact-home tool for a create action", () => {
    const text = buildRouteProposalPrompt(proposal());
    expect(text).toContain('track_add_item with { home: "twenty", trackId: "ALPHA"');
    expect(text).toContain("ALPHA");
    expect(text).toContain("contact@example.com");
    expect(text).toContain("80%");
    expect(text).toContain("mentions Alpha demo");
    expect(text).not.toContain("twenty_set_stage");
  });

  it("asks one question when another live track fits and keeps the response non-executable", () => {
    const text = buildRouteProposalPrompt(proposal({ action: "ask", question: "Should this go in Alpha or Beta?", home: null, trackId: null }));
    expect(text).toContain("one clarification");
    expect(text).toContain("Should this go in Alpha or Beta?");
    expect(text).toContain("Reply in your own words");
    expect(text).toContain("remember only a standing fact you explicitly state");
    expect(text).not.toContain("Then call track_");
  });

  it("instructs the neutral exact-home tool for a move action", () => {
    const text = buildRouteProposalPrompt(proposal({ action: "move", opportunityId: "opp-1", itemId: "opp-1", trackId: "BETA", stage: "PROPOSAL" }));
    expect(text).toContain("track_move_item");
    expect(text).toContain('itemId: "opp-1"');
    expect(text).toContain("PROPOSAL");
    expect(text).not.toContain("track_add_item");
  });

  it("instructs the model to post a plain-language sentence BEFORE calling the gated tool", () => {
    const text = buildRouteProposalPrompt(proposal());
    expect(text).toMatch(/plain-language/i);
    const sentenceIdx = text.search(/plain-language/i);
    const toolIdx = text.indexOf("Then call track_add_item");
    expect(toolIdx).toBeGreaterThan(sentenceIdx);
  });

  // Declined proposals once each came back as a
  // multi-paragraph analysis in the chief of staff DM — useful once, noise every morning. A decline is a
  // signal the ENGINE should have filtered; when one still reaches the model it costs one line.
  it("tells the model a decline is one short sentence, not an analysis", () => {
    const text = buildRouteProposalPrompt(proposal());
    expect(text).toContain("keep it to\none line");
    expect(text).toMatch(/no analysis/i);
    expect(text).not.toContain("say so instead and do not");
  });

  it("mentions the gated-approval-card behaviour", () => {
    const text = buildRouteProposalPrompt(proposal());
    expect(text).toMatch(/existing approval gate/i);
    expect(text).toMatch(/approval/i);
  });

  it("keeps Vault notices Console-only and clarification replies free of write promises", () => {
    const vault = routeProposalWebBody(proposal({ action: 'console-only', home: 'vault:shared-1', trackId: 'ALPHA' }));
    expect(vault).toContain('private Console');
    expect(vault).toContain('cannot authorize a write');
    expect(vault).not.toContain('Reply to this message');
    const question = routeProposalWebBody(proposal({ action: 'ask', question: 'Which track fits?', home: null, trackId: null }));
    expect(question).toContain('Reply in your own words');
    expect(question).toContain('remember only a standing fact you explicitly state');
    expect(question).not.toContain('request this change');
    expect(question).not.toContain('approve it before writing');
    expect(routeProposalWebBody(proposal({ action: 'create' }))).toContain('approve it before writing');
  });
});

describe("route decline questions", () => {
  it("dispatches distinct exact-contact questions once and refuses stale audiences", async () => {
    const identity = { memberId: "member-1", address: "slack-user:owner", accessRevision: 12 };
    const questions = [
      { requestId: "request-a", door: "slack" as const, identity, personId: "contact-a", home: "twenty", trackId: "alpha" },
      { requestId: "request-b", door: "slack" as const, identity, personId: "contact-b", home: "vault:team", trackId: "alpha" },
      { requestId: "request-revoked", door: "slack" as const, identity, personId: "contact-c", home: "twenty", trackId: "beta" },
    ];
    const claimed = new Set<string>();
    const sent: string[] = [];
    const deps = {
      now: new Date("2026-10-26T09:00:00Z"), tz: "UTC", gate: SEND_UNGATED,
      currentIdentity: async (q: typeof questions[number]) => q.requestId === "request-revoked"
        ? { ...identity, accessRevision: 13 } : identity,
      claim: async (q: typeof questions[number]) => {
        if (claimed.has(q.requestId)) return false;
        claimed.add(q.requestId);
        return true;
      },
      send: async (q: typeof questions[number]) => { sent.push(buildRouteDeclineQuestionPrompt(q)); },
    };
    expect(await dispatchRouteDeclineQuestions(questions, deps)).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('Reply directly to this message (or in its Slack thread): Not now, or never for contact-a on twenty/alpha?');
    expect(sent[1]).toContain('Reply directly to this message (or in its Slack thread): Not now, or never for contact-b on vault:team/alpha?');
    expect(sent.every((text) => text.includes("reply link identifies what this question is about"))).toBe(true);
    expect(sent.every((text) => text.includes("Ambiguous, missing, revoked, cross-member, or tainted replies save nothing"))).toBe(true);
    expect(await dispatchRouteDeclineQuestions(questions, deps)).toBe(0);
    expect(sent).toHaveLength(2);
    expect(claimed.has("request-revoked")).toBe(false);
  });
});

describe('legacy applied-definition transition guard', () => {
  it('blocks old schedule or delivery keys and allows a clean renamed definition', () => {
    expect(hasLegacyTrackRoutingKeys({ schedules: { 'crm-routing': { on: false } } })).toBe(true);
    expect(hasLegacyTrackRoutingKeys({ delivery: { 'crm-routing': ['web'] } })).toBe(true);
    expect(hasLegacyTrackRoutingKeys({ schedules: { 'track-routing': { on: false } }, delivery: { 'track-routing': ['web'] } })).toBe(false);
    expect(hasLegacyTrackRoutingKeys(null)).toBe(true);
  });
});

describe("makeTrackRoutingTick", () => {
  function proposal(overrides: Partial<RouteProposal> = {}): RouteProposal {
    return {
      personId: "person-1", opportunityId: null, itemId: null, home: "twenty", trackId: "ALPHA", stage: "MEETING",
      availableTracks: SYNTH_TRACKS.map(({ id, name }) => ({ home: "twenty", id, name })),
      action: "create", question: null, confidence: 0.8, reasoning: "x",
      signalRef: "msg:m1", mode: "confirm", personHandle: "contact@example.com",
      personName: "Contact Example",
      ...overrides,
    };
  }

  function harness(scanResult: RouteProposal[]) {
    const sent: string[] = [];
    const recorded: RouteProposalInput[] = [];
    const deps: TrackRoutingDeps = {
      engine: { scan: async () => scanResult },
      store: { recordProposal: async (input) => { recorded.push(input); return { id: "row-1" }; } },
      door: { send: async (prompt) => { sent.push(prompt); } },
    };
    return { deps, sent, recorded };
  }

  const HOURS = [9, 13, 17];
  const AT_SLOT = new Date("2026-06-20T07:00:00Z"); // 09:00 Berlin
  const NOT_SLOT = new Date("2026-06-20T07:05:00Z"); // 09:05 Berlin

  it("does nothing when not in a slot minute, and resolves false — no pass happened this call", async () => {
    const { deps, sent, recorded } = harness([proposal()]);
    await expect(makeTrackRoutingTick(deps).tick(NOT_SLOT, HOURS, BERLIN)).resolves.toBe(false);
    expect(sent).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("fires once per slot-hour — a second tick at the same slot is a no-op and resolves false", async () => {
    const { deps, sent } = harness([proposal()]);
    const state = freshState();
    await expect(makeTrackRoutingTick(deps, state).tick(AT_SLOT, HOURS, BERLIN)).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    // Simulate the schedule firing again a minute later at the SAME hour (still minute 0 of
    // no other hour) — same slot key, must not re-fire.
    await expect(makeTrackRoutingTick(deps, state).tick(AT_SLOT, HOURS, BERLIN)).resolves.toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("fires again at the NEXT slot hour", async () => {
    const { deps, sent } = harness([proposal()]);
    const state = freshState();
    await makeTrackRoutingTick(deps, state).tick(AT_SLOT, HOURS, BERLIN);
    expect(sent).toHaveLength(1);
    const nextSlot = new Date("2026-06-20T11:00:00Z"); // 13:00 Berlin
    await expect(makeTrackRoutingTick(deps, state).tick(nextSlot, HOURS, BERLIN)).resolves.toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("supports a simple injected store that records after a successful send", async () => {
    const { deps, sent, recorded } = harness([proposal()]);
    await expect(makeTrackRoutingTick(deps).tick(AT_SLOT, HOURS, BERLIN)).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ personId: "person-1", home: "twenty", trackId: "ALPHA", proposedStage: "MEETING", signalRef: "msg:m1" });
  });

  it("has an exact pending row before the card sends and removes it on HOLD", async () => {
    const states = new Map<string, string>();
    const deps: TrackRoutingDeps = {
      engine: { scan: async () => [proposal()] },
      store: {
        recordProposal: async () => ({ id: "unused" }),
        reserveProposal: async () => { states.set("row", "pending"); return { id: "row" }; },
        confirmProposalSent: async (id) => { if (states.get(id) === "pending") states.set(id, "proposed"); },
        discardUnsentProposal: async (id) => { if (states.get(id) === "pending") states.delete(id); },
      },
      door: { send: async () => { expect(states.get("row")).toBe("pending"); } },
      gate: async () => ({ handled: false, reason: "hold" }),
    };
    await makeTrackRoutingTick(deps).tick(AT_SLOT, HOURS, BERLIN);
    expect(states.has("row")).toBe(false);
  });

  it("keeps a linked row when the delivery call throws after creating its exact link", async () => {
    const states = new Map<string, string>();
    const deps: TrackRoutingDeps = {
      engine: { scan: async () => [proposal()] },
      store: {
        recordProposal: async () => ({ id: "unused" }),
        reserveProposal: async () => { states.set("row", "pending"); return { id: "row" }; },
        confirmProposalSent: async (id) => { if (states.get(id) === "pending") states.set(id, "proposed"); },
        discardUnsentProposal: async (id) => { if (states.get(id) === "pending") states.delete(id); },
      },
      door: { send: async () => { states.set("row", "proposed-with-link"); throw new Error("delivery acknowledgement lost"); } },
    };
    await makeTrackRoutingTick(deps).tick(AT_SLOT, HOURS, BERLIN);
    expect(states.get("row")).toBe("proposed-with-link");
  });

  it("a send failure is NOT recorded, and does not block the next proposal in the batch", async () => {
    const sent: string[] = [];
    const recorded: RouteProposalInput[] = [];
    let call = 0;
    const deps: TrackRoutingDeps = {
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
    await expect(makeTrackRoutingTick(deps).tick(AT_SLOT, HOURS, BERLIN)).resolves.toBe(true); // one item's send failure still completes the pass
    expect(sent).toHaveLength(1); // only the second proposal's send succeeded
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.personId).toBe("p-ok");
  });

  it("skips a proposal whose mode is not 'confirm', and still resolves true (a completed pass with nothing to deliver)", async () => {
    const { deps, sent, recorded } = harness([proposal({ mode: "auto" as never })]);
    await expect(makeTrackRoutingTick(deps).tick(AT_SLOT, HOURS, BERLIN)).resolves.toBe(true);
    expect(sent).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  // A tick whose OUTER catch swallowed the whole
  // pass (here, engine.scan() itself throwing) is a FAILED pass: tick() must not throw, but
  // must resolve false so the caller does not stamp the heartbeat.
  it("a scan() failure does not throw out of tick(), and resolves false", async () => {
    const deps: TrackRoutingDeps = {
      engine: { scan: async () => { throw new Error("Twenty is down"); } },
      store: { recordProposal: async () => ({ id: "x" }) },
      door: { send: async () => {} },
    };
    await expect(makeTrackRoutingTick(deps).tick(AT_SLOT, HOURS, BERLIN)).resolves.toBe(false);
  });
});

// ─── 3b. CRM rate limit: defer and resume, never fail, never skip ────────────────

describe("CRM rate limit", () => {
  const base = {
    msgParticipants: [
      { personId: "p-1", messageId: "m-1", handle: "one@example.com", role: "FROM", createdAt: "2026-06-20T10:00:00.000Z" },
      { personId: "p-2", messageId: "m-2", handle: "two@example.com", role: "FROM", createdAt: "2026-06-20T10:05:00.000Z" },
      { personId: "p-3", messageId: "m-3", handle: "three@example.com", role: "FROM", createdAt: "2026-06-20T10:10:00.000Z" },
    ],
    messages: {
      "m-1": { subject: "1", text: "b", receivedAt: "2026-06-20T10:00:00.000Z" },
      "m-2": { subject: "2", text: "b", receivedAt: "2026-06-20T10:05:00.000Z" },
      "m-3": { subject: "3", text: "b", receivedAt: "2026-06-20T10:10:00.000Z" },
    },
  };
  const limited = () => new TwentyRateLimitedError("Twenty GET /messages/m-2 -> 429", 1);
  const decision = { home: "twenty", trackId: "ALPHA", stage: "NEW", action: "create", confidence: 0.8, reasoning: "x" };

  // A fake Twenty that honours the cursor like the real `createdAt[gt]` filter does.
  function rig(failMessage: { id: string | null }) {
    const fake = makeFakeTwenty(base);
    const store = makeFakeRouteStore({ cursor: "2026-06-20T09:00:00.000Z" });
    const twenty = {
      ...fake,
      async listRecentMessageParticipants(since: string) {
        return base.msgParticipants.filter((p) => p.createdAt > since);
      },
      async getMessage(id: string) {
        if (id === failMessage.id) throw limited();
        return fake.getMessage(id);
      },
    };
    return { engine: makeRouteEngine({ twenty, classifier: makeFakeClassifier(decision), store, clock: () => FIXED_NOW }), store };
  }

  it("stops at the limit: keeps what it found, parks the cursor just before the first unprocessed signal, throws nothing", async () => {
    const { engine, store } = rig({ id: "m-2" });
    const out = await engine.scanDetailed();
    expect(out.proposals.map((p) => p.personId)).toEqual(["p-1"]);
    expect(out.deferredReason).toContain("429");
    expect(await store.getCursor()).toBe("2026-06-20T10:04:59.999Z"); // not past 10:05, p-2's signal
  });

  it("the next scan resumes at the unprocessed person and loses nobody", async () => {
    const failing = { id: "m-2" as string | null };
    const { engine, store } = rig(failing);
    await engine.scanDetailed();
    failing.id = null;
    const out = await engine.scanDetailed();
    expect(out.deferredReason).toBeNull();
    expect(out.proposals.map((p) => p.personId)).toEqual(["p-2", "p-3"]); // p-1 is behind the cursor
    expect(await store.getCursor()).toBe("2026-06-20T10:10:00.000Z");
  });

  it("a limit on the very first read changes nothing: no proposals, cursor untouched", async () => {
    const twenty = { ...makeFakeTwenty(base), async listRecentMessageParticipants(): Promise<never> { throw limited(); } };
    const store = makeFakeRouteStore({ cursor: "2026-06-20T09:00:00.000Z" });
    const engine = makeRouteEngine({ twenty, classifier: makeFakeClassifier(decision), store });
    const out = await engine.scanDetailed();
    expect(out.proposals).toEqual([]);
    expect(out.deferredReason).not.toBeNull();
    expect(store._cursorsSet).toEqual([]);
  });

  it("any other Twenty failure still throws out of the scan", async () => {
    const twenty = { ...makeFakeTwenty(base), async getMessage(): Promise<never> { throw new Error("boom"); } };
    const engine = makeRouteEngine({ twenty, classifier: makeFakeClassifier(decision), store: makeFakeRouteStore() });
    await expect(engine.scanDetailed()).rejects.toThrow("boom");
  });

  it("the tick delivers what it found, resolves true, raises no error, and resumes after the wait within the slot", async () => {
    const failing = { id: "m-2" as string | null };
    const { engine } = rig(failing);
    const recorded: string[] = [];
    const deps: TrackRoutingDeps = {
      engine,
      store: { recordProposal: async (i) => { recorded.push(i.personId); return { id: "r" }; } },
      door: { send: async () => {} },
    };
    const state = freshState();
    const tick = makeTrackRoutingTick(deps, state);
    const AT = new Date("2026-06-20T07:00:00Z"); // 09:00 Berlin
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(tick.tick(AT, [9, 13, 17], "Europe/Berlin")).resolves.toBe(true);
      expect(recorded).toEqual(["p-1"]);
      expect(state.deferred).not.toBeNull();
      expect(errSpy).not.toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("deferred"))).toBe(true);

      // Too early to resume: nothing happens.
      const soon = new Date(AT.getTime() + 60_000);
      await expect(tick.tick(soon, [9, 13, 17], "Europe/Berlin")).resolves.toBe(false);

      failing.id = null;
      const later = new Date(AT.getTime() + RATE_LIMIT_RETRY_MS + 1_000);
      await expect(tick.tick(later, [9, 13, 17], "Europe/Berlin")).resolves.toBe(true);
      expect(recorded).toEqual(["p-1", "p-2", "p-3"]);
      expect(state.deferred).toBeNull();
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// ─── 5. Real-Postgres integration: a routing tick with a stubbed Twenty writes route_proposals ──

describe("track-routing integration (real Postgres, stubbed Twenty)", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const pool = getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await pool.query(SHARED_SYNC_SCHEMA_SQL);
    await pool.query(STANDING_FACTS_MIGRATION_SQL);
    await pool.query(`CREATE TABLE schedule_settings(owner text NOT NULL,schedule text NOT NULL,hours integer[] NOT NULL,updated_by text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,schedule))`);
    await pool.query(`CREATE TABLE heartbeat(agent text PRIMARY KEY,updated_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(TRACK_ROUTING_MIGRATION_SQL);
    await pool.query(`CREATE TABLE users(id text PRIMARY KEY);
      CREATE TABLE approval_asks(request_id text PRIMARY KEY);`);
    await pool.query(TRACK_DECLINE_MIGRATION_SQL);
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
      messages: { "msg-int": { subject: "Alpha pilot", text: "Ready to start a pilot.", receivedAt: "2026-06-20T10:00:00.000Z" } },
      opportunities: { "person-int": [] },
    });
    const classifier = makeFakeClassifier({ brand: "ALPHA", stage: "PROPOSAL", action: "create", confidence: 0.9, reasoning: "pilot signal" });
    const engine = makeRouteEngine({ twenty, classifier, store, clock: () => FIXED_NOW });

    const sent: string[] = [];
    const tick = makeTrackRoutingTick({ engine, store, door: { send: async (p) => { sent.push(p); } } });
    await tick.tick(new Date("2026-06-20T07:00:00Z"), [9], BERLIN); // 09:00 Berlin

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("lead@example.com");

    const { rows } = await pool.query("SELECT person_id, home, track_id, proposed_stage, signal_ref FROM route_proposals");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ person_id: "person-int", home: "twenty", track_id: "ALPHA", proposed_stage: "PROPOSAL", signal_ref: "msg:msg-int" });

    // A second scan against the same store must not re-propose the same signal.
    const proposalsAgain = await engine.scan();
    expect(proposalsAgain).toHaveLength(0);
  });
});

// ─── 6. Gate off → complete no-op ───────────────────────────────────────────────────────────

describe("track-routing schedule — gate", () => {
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
    const { default: schedule } = await import("../agent/schedules/track-routing.js");

    await expect(
      schedule.run!({ to: toSpy as never, waitUntil: waitUntilSpy as never, appAuth: {} as never }),
    ).resolves.toBeUndefined();

    expect(toSpy).not.toHaveBeenCalled();
    expect(waitUntilSpy).not.toHaveBeenCalled();
  });
});
