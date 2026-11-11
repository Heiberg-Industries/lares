// The Waiting on you page's server half: which approvals are waiting, and deciding one — with a fake
// database and a fake agent door that behave like the real ones: eve's session stream as NDJSON in
// stream version 27 (one stored line holds every event a state change produced, between the
// route's own heartbeat and end marks), and an answer that is accepted at once and settled on the
// agent's next step.
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { createStreamChecker } from "eve/events";
import { APPROVED_PENDING, classifyReadFailure, decideWaiting, EXPIRED_NOTE, itemId, kindOfStatus, listWaiting, ownedFrom, readApprovals, readStreamLines, type WaitingDeps } from "../lib/waiting";

const grantAccess=vi.hoisted(()=>({captureUse:vi.fn(async()=>1)}));
vi.mock('@lares/agent-kit/grant-store',()=>({PgGrantStore:class {captureUse=grantAccess.captureUse;async captureUseWithExpiry(){const revision=await grantAccess.captureUse();return revision===undefined?undefined:{accessRevision:revision,validUntil:null};}}}));
beforeEach(()=>vi.stubEnv('AGENT_OWNER_USER_ID','owner-id'));
afterAll(()=>vi.unstubAllEnvs());

const OWNER = "owner@example.com";
const OTHER = "someone-else@example.com";
const INC = "11111111-1111-4111-8111-111111111111";
const INC2 = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const telegramDoor = [{ kind: "telegram", enabled: true }];

/** One row per agent × applied claim, as the ownership query returns them. */
function agentRow(over: Record<string, unknown> = {}) {
  return {
    name: "example", address: "10.0.0.5", state: "ready", status: "valid", runtime_control_token: INC, incarnation: INC,
    doors: telegramDoor, channels: null, claim: { kind: "telegram", owner_email: OWNER },
    ...over,
  };
}

/** One stored line of a version 27 stream: when it was written, and the events it holds. */
interface Line { at: string; facts: { type: string; scope?: Record<string, string>; data: Record<string, unknown> }[] }
const line = (at: string, ...facts: Line["facts"]): Line => ({ at, facts });
const TWO = [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }];

/** An agent asks to run a tool and waits: the call it wants to make, then the card about it. */
function asked(interactionId: string, prompt: string, at: string, input: unknown = { to: "someone@example.com", body: "The whole reply, every word of it." }): Line[] {
  const callId = `call-${interactionId}`;
  return [
    line(at, { type: "call.requested", scope: { turnId: "t1", runId: "r1" }, data: { callId, owner: { runId: "r1" }, capability: { kind: "tool", name: "gmail_send" }, input } }),
    line(at,
      { type: "interaction.opened", scope: { turnId: "t1" }, data: { interactionId, subject: { callId }, request: { kind: "approval", prompt, display: "confirmation", allowFreeform: false, options: TWO } } },
      { type: "turn.paused", scope: { turnId: "t1" }, data: { turnId: "t1", awaiting: [{ interactionId }] } }),
  ];
}
/** How a card ended: `accepted` and `declined` are a person's decision; anything else is not. */
const resolved = (interactionId: string, outcome: string): Line =>
  line("2026-10-15T11:59:00.000Z", { type: "interaction.settled", scope: { turnId: "t1" }, data: { interactionId, outcome } });
const ran = (callId: string, outcome: string, error?: string): Line =>
  line("2026-10-15T11:59:30.000Z", { type: "call.settled", scope: { turnId: "t1" }, data: { callId, outcome, ...(outcome === "completed" ? { output: {} } : {}), ...(error ? { error: { code: "TOOL_FAILED", message: error } } : {}) } });
/** The response body eve's stream route writes for these lines. */
const ndjson = (lines: readonly unknown[]): string =>
  ['{"$eve":"heartbeat"}', ...lines.map((l) => JSON.stringify(l)), '{"$eve":"stream.ended"}'].join("\n") + "\n";
const facts = (lines: readonly unknown[], startLine = 0) => readStreamLines(ndjson(lines), startLine);

interface Fake {
  deps: WaitingDeps;
  posts: Array<{ url: string; headers: Headers; body: unknown }>;
  /** Stored lines by session id. A string is sent as the body just as it is. */
  streams: Record<string, unknown[] | string>;
  queries: Array<{ sql: string; values: unknown[] }>;
  streamUrls: string[];
}

function fake(opts: {
  agents?: Record<string, unknown>[];
  sessions?: Record<string, Array<{ session_id: string; door: string }>>;
  streams?: Record<string, unknown[] | string>;
  postStatus?: number;
  /** The JSON body of a refused answer. */
  postBody?: unknown;
  /** Response headers of every stream, when not the ones a version 27 agent sends. */
  streamHeaders?: Record<string, string>;
  /** A status the stream route answers for these sessions instead of a stream. */
  streamStatus?: Record<string, number>;
  /** What the agent writes after an answer: nothing, only the resolution, or the resolution plus
   *  the tool's own result (the default: it ran). */
  after?: "nothing" | "resolve" | { status: string; error?: string };
  /** An address whose every request hangs and ignores its abort signal. */
  stalled?: string;
  /** Proposal rows as the database holds them, by table. */
  notion?: Record<string, unknown>[];
  atlas?: Record<string, unknown>[];
  /** Make every proposal query fail, as an unreachable database would. */
  proposalsDown?: boolean;
} = {}): Fake {
  const streams: Record<string, unknown[] | string> = { ...(opts.streams ?? {}) };
  const posts: Fake["posts"] = [];
  const queries: Fake["queries"] = [];
  const streamUrls: string[] = [];
  const agents = opts.agents ?? [agentRow()];
  const notion = opts.notion ?? [];
  const atlas = opts.atlas ?? [];
  const sessions = opts.sessions ?? { example: [{ session_id: "wrun_tg", door: "telegram" }] };
  const deps: WaitingDeps = {
    connect:async()=>({query:async(sql,values=[])=>({...await deps.query(sql,values),command:["BEGIN","COMMIT","ROLLBACK"].includes(sql)?sql:undefined}),release(){}}),
    signedInMember: async () => ({id:"owner-id",organisationId:"org",role:"owner",status:"active",automationMode:"draft-and-ask"}),
    query: async (sql, values) => {
      queries.push({ sql, values });
      if (["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.includes("pg_advisory_xact_lock")||sql.includes("console_vault_source_captures")) return {rows:[]};
      if (sql.includes("AS organisation_id FROM users"))return {rows:[{organisation_id:"org"}]};
      if (sql.includes("FROM users WHERE"))return {rows:[{id:values[0],org_id:"org",org_role:"owner",status:"active",automation_mode:"draft-and-ask"}]};
      if (sql.includes("FROM orgs WHERE"))return {rows:[{id:"org"}]};
      if (sql.startsWith("SELECT 1 FROM users") || sql.includes("FROM agent_resources r WHERE")) return {rows:[{}]};
      if (sql.includes("console_session_bindings") && !sql.includes("agent_conversations")) {
        const session = sessions[String(values[0])]?.find(s=>s.session_id === values[2]);
        if (!session || ["slack","telegram"].includes(session.door)) return {rows:[]};
        return {rows:[{agent:values[0],incarnation:values[1],session_id:values[2],member_id:"owner-id",admission_nonce:"a".repeat(43),place_id:`console:${values[0]}:${values[1]}:${values[2]}`,audience_revision:1,policy_revision:2,agent_access_revision:1,private_surface_revision:2,source_history_guard_revision:1}]};
      }
      if (sql.includes("agent_door_connections")) return { rows: agents.filter((a) => values[0] === null || a.name === values[0]) };
      if (sql.includes("agent_conversations")) {
        const mine = sessions[values[0] as string] ?? [];
        return { rows: values[2] ? mine.filter((s) => s.session_id === values[2]) : mine };
      }
      if (sql.includes("notion_sync_proposals") || sql.includes("atlas_proposals")) {
        if (opts.proposalsDown) throw new Error("database down");
        const table = sql.includes("atlas_proposals") ? atlas : notion;
        if (/^\s*(WITH p AS \()?\s*UPDATE/.test(sql)) {
          const [id, state] = values as [number, string];
          const row = table.find((r) => Number(r.id) === id && ["pending", "approved"].includes(r.state as string));
          if (!row) return { rows: [] };
          row.state = state;
          return { rows: [row] };
        }
        return { rows: table.filter((r) => ["pending", "approved"].includes(r.state as string)) };
      }
      throw new Error(`unexpected query ${sql}`);
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (opts.stalled && url.includes(opts.stalled)) return new Promise<Response>(() => {});
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("eve:route-pw").toString("base64")}`);
      // The bounded read eve's own client makes: the tail position asked for, and no following.
      const stream = /\/eve\/v1\/session\/([A-Za-z0-9_-]+)\/stream\?includeTailIndex=1&follow=false(?:&startIndex=(-?\d+))?$/.exec(url);
      if (init?.method === "GET" && stream) {
        streamUrls.push(url);
        expect(headers.get("x-lares-member-id")).toBe("owner-id");
        expect(["read","legacy-read"]).toContain(headers.get("x-lares-purpose"));
        const refused = opts.streamStatus?.[stream[1]!];
        if (refused !== undefined) return new Response(JSON.stringify({ ok: false, code: refused === 410 ? "session_expired" : "session_stranded", error: "framework words" }), { status: refused, headers: { "content-type": "application/json" } });
        const stored = streams[stream[1]!];
        if (stored === undefined) return new Response(JSON.stringify({ ok: false, error: "Session not found." }), { status: 404 });
        const version = { "content-type": "application/x-ndjson; charset=utf-8", "x-eve-stream-version": "27", ...(opts.streamHeaders ?? {}) };
        if (typeof stored === "string") return new Response(stored, { status: 200, headers: version });
        // A negative start index is that many lines from the end, as eve's route reads it.
        const start = stream[2] === undefined ? 0 : Number(stream[2]) < 0 ? Math.max(0, stored.length + Number(stream[2])) : Number(stream[2]);
        return new Response(ndjson(stored.slice(start)), { status: 200, headers: { ...version, "x-eve-stream-tail-index": String(stored.length - 1) } });
      }
      const send = /\/eve\/v1\/session\/([A-Za-z0-9_-]+)$/.exec(url);
      if (init?.method === "POST" && send) {
        const body = JSON.parse(String(init.body)) as { answers: Array<{ interactionId: string; optionId: string }> };
        posts.push({ url, headers, body });
        const status = opts.postStatus ?? 202;
        const after = opts.after ?? { status: "completed" };
        if (status === 202 && after !== "nothing") {
          const r = body.answers[0]!;
          const added: unknown[] = [resolved(r.interactionId, r.optionId === "approve" ? "accepted" : "declined")];
          if (typeof after === "object" && r.optionId === "approve") added.push(ran(`call-${r.interactionId}`, after.status, after.error));
          if (r.optionId === "deny") added.push(ran(`call-${r.interactionId}`, "rejected"));
          streams[send[1]!] = [...(streams[send[1]!] as unknown[] ?? []), ...added];
        }
        return new Response(JSON.stringify(opts.postBody ?? { ok: status === 202 }), { status, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${init?.method} ${url}`);
    }) as typeof fetch,
    routePassword: () => "route-pw",
    now: () => NOW,
    sleep: async () => {},
  };
  return { deps, posts, streams, queries, streamUrls };
}

describe("the fixtures", () => {
  it("are lines the framework's own stream checker accepts, set in the turn they are a slice of", () => {
    // `asked`, `resolved` and `ran` are the part of a turn the page reads. Put back into a whole
    // turn — a message, a model run that asks for the call and finishes — the framework's checker
    // finds nothing wrong with how they relate.
    const checker = createStreamChecker();
    const [requested, card] = asked("req-1", "Send it", "2026-10-15T11:00:00.000Z");
    const whole: Line[] = [
      line("2026-10-15T10:59:00.000Z", { type: "session.started", data: {} }),
      line("2026-10-15T10:59:01.000Z", { type: "delivery.admitted", data: { deliveryId: "d1", source: { channel: "telegram" } } }),
      line("2026-10-15T10:59:02.000Z",
        { type: "turn.started", scope: { turnId: "t1" }, data: { turnId: "t1", cause: { deliveryId: "d1" }, follows: null } },
        { type: "delivery.consumed", scope: { turnId: "t1" }, data: { deliveryId: "d1", turnId: "t1", parts: [{ kind: "text", text: "send it" }] } }),
      line("2026-10-15T10:59:03.000Z", { type: "model.requested", scope: { turnId: "t1" }, data: { runId: "r1", owner: { turnId: "t1" } } }),
      line("2026-10-15T10:59:04.000Z", { type: "model.started", scope: { turnId: "t1", runId: "r1" }, data: { runId: "r1", modelId: "m", attempt: 0 } }),
      line(requested!.at, ...requested!.facts, { type: "model.settled", scope: { turnId: "t1", runId: "r1" }, data: { runId: "r1", outcome: "completed", finishReason: "tool-calls" } }),
      card!,
      resolved("req-1", "declined"),
      ran("call-req-1", "rejected"),
    ];
    expect(whole.flatMap((l, position) => checker.check(l, position))).toEqual([]);
  });
});

describe("reading a version 27 stream", () => {
  it("returns the recorded events in order, each with the time and the position of its line", () => {
    const read = facts(asked("req-1", "Send it", "2026-10-15T11:00:00.000Z"));
    expect(read.map((f) => [f.type, f.position.line, f.position.index, f.at])).toEqual([
      ["call.requested", 0, 0, "2026-10-15T11:00:00.000Z"],
      ["interaction.opened", 1, 0, "2026-10-15T11:00:00.000Z"],
      ["turn.paused", 1, 1, "2026-10-15T11:00:00.000Z"],
    ]);
    expect(read[1]!.data.interactionId).toBe("req-1");
  });

  it("counts a preview line as a line but returns no event for it, and ignores the route's own marks", () => {
    const body = [
      '{"$eve":"heartbeat"}',
      JSON.stringify(line("2026-10-15T11:00:00.000Z", { type: "turn.started", data: { turnId: "t1" } })),
      JSON.stringify({ progress: { type: "content.delta", data: { partId: "p1", kind: "text", delta: "Hel" } } }),
      '{"$eve":"heartbeat"}',
      "",
      JSON.stringify(line("2026-10-15T11:00:02.000Z", { type: "turn.settled", data: { turnId: "t1", outcome: "completed" } })),
      '{"$eve":"a-mark-added-later","x":1}',
      '{"$eve":"stream.ended"}',
    ].join("\n");
    expect(readStreamLines(body).map((f) => [f.type, f.position.line])).toEqual([["turn.started", 0], ["turn.settled", 2]]);
  });

  it("starts counting where the response starts, and follows a position mark", () => {
    expect(facts([resolved("req-1", "accepted")], 40)[0]!.position).toEqual({ line: 40, index: 0 });
    const skipped = ['{"$eve":"position","next":7}', JSON.stringify(resolved("req-1", "accepted"))].join("\n");
    expect(readStreamLines(skipped, 2)[0]!.position).toEqual({ line: 7, index: 0 });
    // A mark never moves the count backwards.
    expect(readStreamLines(['{"$eve":"position","next":1}', JSON.stringify(resolved("req-1", "accepted"))].join("\n"), 5)[0]!.position.line).toBe(5);
  });

  it("refuses a record written in the stream format before this one, rather than read half of it", () => {
    const older = [
      { type: "session.started", data: {}, meta: { at: "2026-09-01T10:00:00.000Z" } },
      { type: "input.requested", data: { requests: [{ requestId: "req-1", kind: "tool-approval", prompt: "Send it", options: [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }], action: { callId: "c", toolName: "gmail_send", input: {} } }] }, meta: { at: "2026-09-01T10:00:01.000Z" } },
    ];
    expect(() => readStreamLines(older.map((e) => JSON.stringify(e)).join("\n"))).toThrow(/earlier format/);
  });

  it("skips what is not a line at all, and still reads the rest", () => {
    const body = ["not json", "7", "[]", '"text"', JSON.stringify({ at: "x", facts: [null, 3, { noType: true }, { type: "turn.paused", data: "not an object" }] }), JSON.stringify(resolved("req-1", "accepted"))].join("\n");
    const read = readStreamLines(body);
    expect(read.map((f) => f.type)).toEqual(["turn.paused", "interaction.settled"]);
    expect(read[0]!.data).toEqual({});
  });
});

describe("readApprovals", () => {
  it("a card opened and not settled is waiting; a settled one is not; a question is not an approval", () => {
    const { pending, resolved: settled, results } = readApprovals(facts([
      ...asked("req-1", "Send the reply", "2026-10-15T11:00:00.000Z"),
      ...asked("req-2", "Book the room", "2026-10-15T11:10:00.000Z"),
      resolved("req-2", "accepted"),
      ran("call-req-2", "failed", "approval refused"),
      line("2026-10-15T11:20:00.000Z", { type: "interaction.opened", data: { interactionId: "q-1", subject: { turnId: "t1" }, request: { kind: "question", prompt: "Which day?" } } }),
      line("2026-10-15T11:21:00.000Z", { type: "interaction.opened", data: { interactionId: "b-1", subject: { turnId: "t1" }, request: { kind: "budget", prompt: "Continue?", options: TWO } } }),
    ]));
    expect(pending.map((p) => p.interactionId)).toEqual(["req-1"]);
    expect(pending[0]).toMatchObject({ toolName: "gmail_send", callId: "call-req-1", prompt: "Send the reply", at: "2026-10-15T11:00:00.000Z", input: { to: "someone@example.com" } });
    expect(settled.get("req-2")).toBe("approved");
    expect(results.get("call-req-2")).toEqual({ status: "failed", error: "approval refused" });
    expect(readApprovals(["not an event", null, 3, { type: "interaction.opened" }]).pending).toEqual([]);
  });

  it("only 'accepted' and 'declined' are a decision; every other ending is nobody deciding", () => {
    const ending = (outcome: string) => readApprovals(facts([...asked("req-1", "Send it", "2026-10-15T11:00:00.000Z"), resolved("req-1", outcome)]));
    expect(ending("accepted").resolved.get("req-1")).toBe("approved");
    expect(ending("declined").resolved.get("req-1")).toBe("cancelled");
    for (const outcome of ["withdrawn", "interrupted", "abandoned", "expired", "invalid", "failed", "an-outcome-added-later"]) {
      expect(ending(outcome).resolved.get("req-1"), outcome).toBe("other");
      expect(ending(outcome).pending, outcome).toEqual([]);
    }
  });

  it("nothing is waiting once its call has finished, or the session has ended", () => {
    const open = asked("req-1", "Send it", "2026-10-15T11:00:00.000Z");
    expect(readApprovals(facts(open)).pending).toHaveLength(1);
    expect(readApprovals(facts([...open, ran("call-req-1", "interrupted")])).pending).toEqual([]);
    expect(readApprovals(facts([...open, line("2026-10-15T11:30:00.000Z", { type: "session.ended", data: { outcome: "failed", error: { code: "session_stranded", message: "x" } } })])).pending).toEqual([]);
  });

  it("the older stream's event names are not cards: nothing is read from them", () => {
    const older = [
      { type: "input.requested", data: { requests: [{ requestId: "req-1", kind: "tool-approval", prompt: "Send it" }] }, at: "2026-10-15T11:00:00.000Z" },
      { type: "action.result", data: { status: "completed", result: { callId: "c" } } },
    ];
    expect(readApprovals(older)).toMatchObject({ pending: [] });
    expect(readApprovals(older).results.size).toBe(0);
  });

  it("a card a sub-agent relays shows the tool it is about, and claims no result from this session's own call", () => {
    const relayed = [
      line("2026-10-15T11:00:00.000Z", { type: "call.requested", data: { callId: "delegate-1", owner: { runId: "r1" }, capability: { kind: "agent", name: "researcher" }, input: { message: "look it up" } } }),
      line("2026-10-15T11:00:05.000Z", { type: "interaction.opened", data: {
        interactionId: "wrun_child/int_9", subject: { callId: "delegate-1" },
        request: { kind: "approval", prompt: "Send the summary?", options: TWO },
        origin: { sessionId: "wrun_child", interactionId: "int_9", call: { callId: "child-call", name: "gmail_send", input: { to: "someone@example.com" } } },
      } }),
    ];
    const { pending } = readApprovals(facts(relayed));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ interactionId: "wrun_child/int_9", toolName: "gmail_send", input: { to: "someone@example.com" }, callId: "" });
  });
});

describe("who owns an agent: the keeper's own selection, and only a sole claimant", () => {
  it("the one applied claimant on an enabled door owns it", () => {
    expect(ownedFrom([agentRow()], OWNER).map((a) => a.name)).toEqual(["example"]);
    expect(ownedFrom([agentRow()], OTHER)).toEqual([]);
  });

  it("an agent with no claim at all belongs to the installation administrator; a claim still wins", () => {
    const unclaimed = agentRow({ claim: null });
    expect(ownedFrom([unclaimed], OWNER, true).map((a) => a.name)).toEqual(["example"]);
    expect(ownedFrom([unclaimed], OWNER, false)).toEqual([]);
    expect(ownedFrom([agentRow()], OTHER, true)).toEqual([]);
  });

  it("two members holding claims on one agent: neither owns it", () => {
    const rows = [agentRow(), agentRow({ claim: { kind: "slack", owner_email: OTHER } })].map((r) => ({ ...r, doors: [...telegramDoor, { kind: "slack", enabled: true }] }));
    expect(ownedFrom(rows, OWNER)).toEqual([]);
    expect(ownedFrom(rows, OTHER)).toEqual([]);
  });

  it("a claim not yet applied, or on a switched-off door, does not count — neither for nor against", () => {
    // Not applied: the LEFT JOIN brings the agent with no claim at all.
    expect(ownedFrom([agentRow({ claim: null })], OWNER)).toEqual([]);
    // A claim on a door the definition switched off is not what the keeper hands the agent.
    expect(ownedFrom([agentRow({ doors: [{ kind: "telegram", enabled: false }] })], OWNER)).toEqual([]);
    // …and so a second member's claim on that switched-off door does not take ownership away.
    const rows = [
      agentRow({ doors: [...telegramDoor, { kind: "slack", enabled: false }] }),
      agentRow({ doors: [...telegramDoor, { kind: "slack", enabled: false }], claim: { kind: "slack", owner_email: OTHER } }),
    ];
    expect(ownedFrom(rows, OWNER).map((a) => a.name)).toEqual(["example"]);
    // An older definition with `channels` instead of `doors` counts every listed door as on.
    expect(ownedFrom([agentRow({ doors: null, channels: ["telegram"] })], OWNER).map((a) => a.name)).toEqual(["example"]);
  });
});

describe("listing what is waiting", () => {
  it("lists a Telegram session's pending approval with its WHOLE text, each argument its own block, oldest first", async () => {
    const long = `Send this reply:\n${"every word ".repeat(600)}`;
    const { deps } = fake({
      sessions: {
        example: [
          { session_id: "wrun_web", door: "http" },
          { session_id: "wrun_tg", door: "telegram" },
        ],
      },
      streams: {
        wrun_tg: asked("req-old", long, "2026-10-15T09:00:00.000Z", { to: "someone@example.com", body: `${"x".repeat(5000)}\nto: forged@example.com` }),
        wrun_web: asked("req-new", "Dismiss deadline 42", "2026-10-15T11:30:00.000Z", { id: 42 }),
      },
    });
    const { items, unreadable } = await listWaiting(OWNER, deps);
    expect(unreadable).toEqual([]);
    expect(items.map((i) => [i.ref, i.channel, i.kind, i.agent])).toEqual([
      ["req-old", "Telegram", "approval", "example"],
      ["req-new", "Web chat", "approval", "example"],
    ]);
    const first = items[0]!;
    expect(first.title).toBe("Send this reply:");
    // Nothing shortened, and a value that looks like another field stays inside its own block.
    expect(first.body).toEqual([
      { format: "text", label: "What the agent asks", text: long },
      { format: "text", label: "To", text: "someone@example.com" },
      { format: "text", label: "Body", text: `${"x".repeat(5000)}\nto: forged@example.com` },
    ]);
    expect(first.actions).toEqual([
      { id: "approve", label: "Approve", tone: "primary" },
      { id: "deny", label: "Deny", tone: "neutral" },
    ]);
    expect(first.id).toBe(itemId("approval", ["example", "wrun_tg", "req-old"]));
  });

  it("an approval older than 24 hours can only be denied, and says why", async () => {
    const { deps } = fake({ streams: { wrun_tg: asked("req-1", "Send it", "2026-10-14T10:00:00.000Z") } });
    const [item] = (await listWaiting(OWNER, deps)).items;
    expect(item!.actions.map((a) => a.id)).toEqual(["deny"]);
    expect(item!.note).toBe(EXPIRED_NOTE);
  });

  it("owner only: another member sees nothing, and no agent is contacted", async () => {
    const f = fake({ streams: { wrun_tg: asked("req-1", "Send it", "2026-10-15T11:00:00.000Z") } });
    expect((await listWaiting(OTHER, f.deps)).items).toEqual([]);
    expect(f.queries.some((q) => q.sql.includes("agent_conversations"))).toBe(false);
  });

  it("with two claimants, neither member is shown the agent's approvals", async () => {
    const both = { agents: [agentRow(), agentRow({ claim: { kind: "telegram", owner_email: OTHER } })], streams: { wrun_tg: asked("req-1", "Send it", "2026-10-15T11:00:00.000Z") } };
    expect((await listWaiting(OWNER, fake(both).deps)).items).toEqual([]);
    expect((await listWaiting(OTHER, fake(both).deps)).items).toEqual([]);
  });

  it("an agent that does not answer is named, and its other sessions are not tried after the first failure", async () => {
    const f = fake({ sessions: { example: [{ session_id: "wrun_a", door: "telegram" }, { session_id: "wrun_b", door: "slack" }, { session_id: "wrun_c", door: "slack" }] } });
    let calls = 0;
    f.deps.fetch = (async () => {
      calls++;
      throw new Error("connection refused");
    }) as typeof fetch;
    expect(await listWaiting(OWNER, f.deps)).toEqual({ items: [], unreadable: [{ agent: "example", kind: "unreachable" }] });
    // Six may be in flight at once, so this counts starts, not "exactly one" — but a failure stops
    // the agent: no session starts after the first one has failed.
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("a stream larger than the cap is not read whole: the agent is named as unreadable", async () => {
    const f = fake();
    f.deps.fetch = (async () => {
      // An endless body; the bounded reader must stop it.
      const chunk = new TextEncoder().encode(`${JSON.stringify({ progress: { type: "content.delta", data: { partId: "p1", delta: "x".repeat(60000) } } })}\n`);
      return new Response(new ReadableStream({ pull: (c) => c.enqueue(chunk) }), { status: 200, headers: { "x-eve-stream-version": "27" } });
    }) as typeof fetch;
    expect(await listWaiting(OWNER, f.deps)).toEqual({ items: [], unreadable: [{ agent: "example", kind: "error" }] });
  });

  it("one stalled agent does not stall the page past its deadline; the others are still listed", async () => {
    const f = fake({
      agents: [agentRow(), agentRow({ name: "stalled", address: "10.0.0.6", runtime_control_token: INC2, incarnation: INC2 })],
      sessions: { example: [{ session_id: "wrun_tg", door: "telegram" }], stalled: [{ session_id: "wrun_x", door: "slack" }] },
      streams: { wrun_tg: asked("req-1", "Send it", "2026-10-15T11:00:00.000Z") },
      stalled: "10.0.0.6",
    });
    const started = Date.now();
    const list = await listWaiting(OWNER, f.deps, 200);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(list.items.map((i) => i.ref)).toEqual(["req-1"]);
    expect(list.unreadable).toEqual([{ agent: "stalled", kind: "timeout" }]);
  });
});

describe("cards that are open, and cards that are not", () => {
  const twoSessions = { example: [{ session_id: "wrun_a", door: "telegram" }, { session_id: "wrun_b", door: "slack" }] };

  it("finds an open card in a version 27 stream, and leaves every settled one out", async () => {
    const { deps } = fake({
      sessions: twoSessions,
      streams: {
        wrun_a: [
          ...asked("req-open", "Send the reply", "2026-10-15T11:00:00.000Z"),
          ...asked("req-approved", "Book the room", "2026-10-15T11:05:00.000Z"), resolved("req-approved", "accepted"), ran("call-req-approved", "completed"),
          ...asked("req-denied", "Delete the draft", "2026-10-15T11:06:00.000Z"), resolved("req-denied", "declined"), ran("call-req-denied", "rejected"),
        ],
        wrun_b: [...asked("req-withdrawn", "Send the invoice", "2026-10-15T11:07:00.000Z"), resolved("req-withdrawn", "withdrawn")],
      },
    });
    const { items, unreadable } = await listWaiting(OWNER, deps);
    expect(unreadable).toEqual([]);
    expect(items.map((i) => i.ref)).toEqual(["req-open"]);
    expect(items[0]).toMatchObject({ title: "Send the reply", createdAt: "2026-10-15T11:00:00.000Z", channel: "Telegram" });
    expect(items[0]!.id).toBe(itemId("approval", ["example", "wrun_a", "req-open"]));
  });

  it("offers only Approve and Deny, whatever else a card lists", async () => {
    const lines = asked("req-1", "Send it", "2026-10-15T11:00:00.000Z");
    (lines[1]!.facts[0]!.data.request as { options: unknown[] }).options.push({ id: "always-allow", label: "Always allow" });
    const f = fake({ streams: { wrun_tg: lines } });
    const [item] = (await listWaiting(OWNER, f.deps)).items;
    expect(item!.actions.map((a) => a.id)).toEqual(["approve", "deny"]);
    expect(await decideWaiting(OWNER, item!.id, "always-allow", f.deps)).toMatchObject({ ok: false, reason: "gone" });
    expect(f.posts).toEqual([]);
  });
});

describe("a conversation the console cannot read is skipped, not an error on the page", () => {
  const sessions = { example: [{ session_id: "wrun_old", door: "telegram" }, { session_id: "wrun_new", door: "slack" }] };
  const readable = asked("req-new", "Send it", "2026-10-15T11:00:00.000Z");
  const lines = (f: ReturnType<typeof fake>) => {
    const out: string[] = [];
    f.deps.log = (l) => out.push(l);
    return out;
  };
  // What a conversation recorded before the upgrade looks like on the wire: one event per line,
  // each with its own `type`, and an approval under the older event name.
  const olderRecord = [
    { type: "session.started", data: {}, meta: { at: "2026-09-01T10:00:00.000Z" } },
    { type: "input.requested", data: { requests: [{ requestId: "req-old", kind: "tool-approval", prompt: "Send it", options: [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }], action: { callId: "c", toolName: "gmail_send", input: {} } }] }, meta: { at: "2026-09-01T10:00:01.000Z" } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n";

  it("a record written in an earlier format: one log line, the other conversation still listed, the agent not named as failing", async () => {
    const f = fake({ sessions, streams: { wrun_old: olderRecord, wrun_new: readable } });
    const out = lines(f);
    const list = await listWaiting(OWNER, f.deps);
    expect(list.items.map((i) => i.ref)).toEqual(["req-new"]);
    expect(list.unreadable).toEqual([]);
    expect(out).toEqual(["[waiting] skipped a conversation of agent example: its record was written in an earlier format"]);
  });

  it.each([
    [409, "the agent no longer serves it (HTTP 409)"],
    [410, "its record is no longer kept (HTTP 410)"],
  ])("a conversation the agent no longer serves (HTTP %i)", async (status, reason) => {
    const f = fake({ sessions, streams: { wrun_new: readable }, streamStatus: { wrun_old: status } });
    const out = lines(f);
    const list = await listWaiting(OWNER, f.deps);
    expect(list.items.map((i) => i.ref)).toEqual(["req-new"]);
    expect(list.unreadable).toEqual([]);
    expect(out).toEqual([`[waiting] skipped a conversation of agent example: ${reason}`]);
  });

  it.each([
    ["an agent still on the stream version before this one", { "x-eve-stream-version": "26" }],
    ["a version this console has never seen", { "x-eve-stream-version": "28" }],
  ])("%s: its conversations are skipped, never read as if they were this version", async (_name, streamHeaders) => {
    const f = fake({ sessions, streams: { wrun_old: readable, wrun_new: readable }, streamHeaders });
    const out = lines(f);
    const list = await listWaiting(OWNER, f.deps);
    expect(list).toEqual({ items: [], unreadable: [] });
    expect(out).toEqual(Array(2).fill("[waiting] skipped a conversation of agent example: its stream is not a version this console reads"));
  });

  it("a response that names no stream version at all is skipped too", async () => {
    const f = fake({ sessions: { example: [{ session_id: "wrun_new", door: "slack" }] }, streams: { wrun_new: readable } });
    const out = lines(f);
    const inner = f.deps.fetch;
    f.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await inner(input, init);
      return new Response(await response.text(), { status: response.status });
    }) as typeof fetch;
    expect(await listWaiting(OWNER, f.deps)).toEqual({ items: [], unreadable: [] });
    expect(out).toHaveLength(1);
  });

  it("the log line carries no session id, credential or framework text", async () => {
    const f = fake({ sessions, streams: { wrun_old: olderRecord, wrun_new: readable }, streamStatus: {} });
    const out = lines(f);
    await listWaiting(OWNER, f.deps);
    for (const l of out) {
      expect(l).not.toMatch(/wrun_|route-pw|authorization|framework words/i);
    }
  });
});

describe("why an agent could not be read", () => {
  const SECRET = "route-pw";
  const lines = (f: ReturnType<typeof fake>) => {
    const out: string[] = [];
    f.deps.log = (l) => out.push(l);
    return out;
  };

  it("classifies statuses and failures: refused, not-found, error, timeout, unreachable", () => {
    expect(kindOfStatus(401)).toBe("refused");
    expect(kindOfStatus(403)).toBe("refused");
    expect(kindOfStatus(404)).toBe("not-found");
    expect(kindOfStatus(500)).toBe("error");
    expect(classifyReadFailure(new DOMException("x", "TimeoutError"))).toEqual({ kind: "timeout" });
    expect(classifyReadFailure(new TypeError("fetch failed"))).toEqual({ kind: "unreachable" });
    expect(classifyReadFailure(new RangeError("body too large"))).toEqual({ kind: "error" });
  });

  it("a 401 or 403 is 'refused', and the log line names the agent and the status", async () => {
    const f = fake();
    const out = lines(f);
    f.deps.fetch = (async () => new Response(`denied for ${SECRET}`, { status: 401 })) as typeof fetch;
    expect((await listWaiting(OWNER, f.deps)).unreadable).toEqual([{ agent: "example", kind: "refused" }]);
    expect(out).toEqual(["[waiting] could not read agent example: refused (HTTP 401)"]);
  });

  it("another HTTP status is 'error' with its status", async () => {
    const f = fake();
    const out = lines(f);
    f.deps.fetch = (async () => new Response("boom", { status: 502 })) as typeof fetch;
    expect((await listWaiting(OWNER, f.deps)).unreadable).toEqual([{ agent: "example", kind: "error" }]);
    expect(out).toEqual(["[waiting] could not read agent example: error (HTTP 502)"]);
  });

  it("a connection failure is 'unreachable'", async () => {
    const f = fake();
    const out = lines(f);
    f.deps.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect((await listWaiting(OWNER, f.deps)).unreadable).toEqual([{ agent: "example", kind: "unreachable" }]);
    expect(out).toEqual(["[waiting] could not read agent example: unreachable"]);
  });

  it("a read that runs past its own timeout is 'timeout', not 'unreachable'", async () => {
    const f = fake();
    const out = lines(f);
    f.deps.fetch = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch;
    expect((await listWaiting(OWNER, f.deps)).unreadable).toEqual([{ agent: "example", kind: "timeout" }]);
    expect(out).toEqual(["[waiting] could not read agent example: timeout"]);
  });

  it("an agent that misses the page deadline is 'timeout' and logged once", async () => {
    const f = fake({ stalled: "10.0.0.5" });
    const out = lines(f);
    expect((await listWaiting(OWNER, f.deps, 100)).unreadable).toEqual([{ agent: "example", kind: "timeout" }]);
    expect(out).toEqual(["[waiting] could not read agent example: timeout"]);
  });

  it("no route password mounted is 'refused' for every agent, and no log line carries a secret", async () => {
    const f = fake();
    const out = lines(f);
    f.deps.routePassword = () => undefined;
    expect((await listWaiting(OWNER, f.deps)).unreadable).toEqual([{ agent: "example", kind: "refused" }]);
    const g = fake();
    const more = lines(g);
    g.deps.fetch = (async (_u: unknown, init?: RequestInit) => {
      throw new Error(`failed with ${new Headers(init?.headers).get("authorization")} and ${SECRET}`);
    }) as typeof fetch;
    await listWaiting(OWNER, g.deps);
    for (const line of [...out, ...more]) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(Buffer.from(`eve:${SECRET}`).toString("base64"));
      expect(line).not.toMatch(/authorization|basic /i);
    }
    expect(more).toEqual(["[waiting] could not read agent example: unreachable"]);
  });

  it("a retired role is never returned, so it is never asked or named", async () => {
    expect(ownedFrom([agentRow({ role: "travel" })], OWNER)).toEqual([]);
    expect(ownedFrom([agentRow({ applied_role: "travel" })], OWNER)).toEqual([]);
    expect(ownedFrom([agentRow({ status: "retired" })], OWNER)).toEqual([]);
    expect(ownedFrom([agentRow({ role: "chief-of-staff", applied_role: "chief-of-staff" })], OWNER).map((a) => a.name)).toEqual(["example"]);
    const f = fake({
      agents: [agentRow(), agentRow({ name: "gone", address: "10.0.0.9", role: "travel", runtime_control_token: INC2, incarnation: INC2 })],
      sessions: { example: [], gone: [{ session_id: "wrun_x", door: "slack" }] },
    });
    const asked: string[] = [];
    const inner = f.deps.fetch;
    f.deps.fetch = ((u: string | URL | Request, i?: RequestInit) => (asked.push(String(u)), inner(u, i))) as typeof fetch;
    const list = await listWaiting(OWNER, f.deps);
    expect(list.unreadable).toEqual([]);
    expect(asked.some((u) => u.includes("10.0.0.9"))).toBe(false);
  });

  it("the ownership query asks for the roles it filters on", async () => {
    const f = fake();
    await listWaiting(OWNER, f.deps);
    expect(f.queries[0]!.sql).toContain("definition->>'role' AS role");
    expect(f.queries[0]!.sql).toContain("applied_definition->>'role' AS applied_role");
  });
});

describe("deciding", () => {
  const id = itemId("approval", ["example", "wrun_tg", "req-1"]);
  const waiting = () => ({ wrun_tg: asked("req-1", "Send it", "2026-10-15T11:00:00.000Z") });

  it("Approve: answers the session through the agent's own door as the owner; says it ran only once the tool's result shows it", async () => {
    const f = fake({ streams: waiting() });
    const result = await decideWaiting(OWNER, id, "approve", f.deps);
    expect(result).toMatchObject({ ok: true, outcome: "approved" });
    expect(result.message).toBe("Approved, and example carried it out. Its reply appears in the Telegram conversation this came from.");
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.url).toBe("http://10.0.0.5:3000/eve/v1/session/wrun_tg");
    expect(f.posts[0]!.headers.get("x-lares-member")).toBe(OWNER);
    // The framework's own answer body: the card by its interaction id, and one of its two options.
    expect(f.posts[0]!.body).toEqual({ answers: [{ interactionId: "req-1", optionId: "approve" }] });
    // The outcome is read from the stream's tail, not the whole session again.
    expect(f.streamUrls.at(-1)).toMatch(/\/stream\?includeTailIndex=1&follow=false&startIndex=-500$/);
    expect(f.streamUrls[0]).toMatch(/\/stream\?includeTailIndex=1&follow=false$/);
  });

  it("Approve accepted, but the tool refused it (an unauthorised approver, say): says so, never 'carrying on'", async () => {
    const f = fake({ streams: waiting(), after: { status: "failed", error: "approval refused: owner@example.com is not an allowed approver for this agent." } });
    const result = await decideWaiting(OWNER, id, "approve", f.deps);
    expect(result).toEqual({
      ok: false,
      reason: "action-failed",
      message: "Your approval arrived, but the action did not go through: approval refused: owner@example.com is not an allowed approver for this agent.",
    });
  });

  it("Approve accepted and nothing run yet: the careful sentence, not a claim of success", async () => {
    const f = fake({ streams: waiting(), after: "resolve" });
    expect(await decideWaiting(OWNER, id, "approve", f.deps)).toEqual({ ok: true, outcome: "approved", message: APPROVED_PENDING });
  });

  it("Deny: answers with the framework's own 'deny', and says the agent will not do it", async () => {
    const f = fake({ streams: waiting() });
    expect(await decideWaiting(OWNER, id, "deny", f.deps)).toEqual({ ok: true, outcome: "cancelled", message: "Denied. example will not do it." });
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.body).toEqual({ answers: [{ interactionId: "req-1", optionId: "deny" }] });
  });

  it("the older word for declining is not an answer any more: nothing is sent", async () => {
    const f = fake({ streams: waiting() });
    expect(await decideWaiting(OWNER, id, "cancel", f.deps)).toMatchObject({ ok: false, reason: "gone" });
    expect(f.posts).toEqual([]);
    expect(f.streamUrls).toEqual([]);
  });

  it("already decided elsewhere (on Telegram, say): says so and sends nothing", async () => {
    const denied = fake({ streams: { wrun_tg: [...waiting().wrun_tg, resolved("req-1", "declined")] } });
    expect(await decideWaiting(OWNER, id, "approve", denied.deps)).toEqual({ ok: false, reason: "decided-elsewhere", message: "This was already denied elsewhere. Nothing more was sent." });
    expect(denied.posts).toEqual([]);
    const approved = fake({ streams: { wrun_tg: [...waiting().wrun_tg, resolved("req-1", "accepted")] } });
    expect(await decideWaiting(OWNER, id, "deny", approved.deps)).toEqual({ ok: false, reason: "decided-elsewhere", message: "This was already approved elsewhere. Nothing more was sent." });
    expect(approved.posts).toEqual([]);
  });

  it("a card that ended with nobody deciding (withdrawn by a typed reply, say) is not 'decided': nothing is sent", async () => {
    const f = fake({ streams: { wrun_tg: [...waiting().wrun_tg, resolved("req-1", "withdrawn")] } });
    expect(await decideWaiting(OWNER, id, "approve", f.deps)).toEqual({ ok: false, reason: "gone", message: "This request is no longer waiting. Nothing was sent." });
    expect(f.posts).toEqual([]);
  });

  it("an answer the agent took but did not accept is never reported as approved", async () => {
    const f = fake({ streams: waiting(), after: "nothing" });
    const inner = f.deps.fetch;
    f.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await inner(input, init);
      // After the answer is accepted, the card ends as invalid: nobody decided.
      if (init?.method === "POST") f.streams.wrun_tg = [...(f.streams.wrun_tg as unknown[]), resolved("req-1", "invalid")];
      return response;
    }) as typeof fetch;
    expect(await decideWaiting(OWNER, id, "approve", f.deps)).toEqual({ ok: false, reason: "refused", message: "example did not accept the answer. Nothing was done." });
  });

  it("another member cannot decide, even with a valid item id", async () => {
    const f = fake({ streams: waiting() });
    expect(await decideWaiting(OTHER, id, "approve", f.deps)).toMatchObject({ ok: false, reason: "refused" });
    expect(f.posts).toEqual([]);
  });

  it("with two claimants, neither member can decide", async () => {
    for (const member of [OWNER, OTHER]) {
      const f = fake({ agents: [agentRow(), agentRow({ claim: { kind: "telegram", owner_email: OTHER } })], streams: waiting() });
      expect(await decideWaiting(member, id, "approve", f.deps)).toMatchObject({ ok: false, reason: "refused" });
      expect(f.posts).toEqual([]);
    }
  });

  it("an unapplied or switched-off claim gives no right to decide", async () => {
    for (const agent of [agentRow({ claim: null }), agentRow({ doors: [{ kind: "telegram", enabled: false }] })]) {
      const f = fake({ agents: [agent], streams: waiting() });
      expect(await decideWaiting(OWNER, id, "approve", f.deps)).toMatchObject({ ok: false, reason: "refused" });
      expect(f.posts).toEqual([]);
    }
  });

  it("a session that is not one of the agent's live conversations is refused, whatever the id says", async () => {
    const f = fake({ streams: { wrun_other: waiting().wrun_tg } });
    const forged = itemId("approval", ["example", "wrun_other", "req-1"]);
    expect(await decideWaiting(OWNER, forged, "approve", f.deps)).toMatchObject({ ok: false, reason: "gone" });
    expect(f.posts).toEqual([]);
  });

  it("an expired approval cannot be approved from here", async () => {
    const f = fake({ streams: { wrun_tg: asked("req-1", "Send it", "2026-10-14T10:00:00.000Z") } });
    expect(await decideWaiting(OWNER, id, "approve", f.deps)).toEqual({ ok: false, reason: "refused", message: EXPIRED_NOTE });
    expect(f.posts).toEqual([]);
  });

  it("an answer the request does not offer, or a malformed id, sends nothing", async () => {
    const f = fake({ streams: waiting() });
    expect(await decideWaiting(OWNER, id, "delete-everything", f.deps)).toMatchObject({ ok: false });
    expect(await decideWaiting(OWNER, "approval:not-base64!", "approve", f.deps)).toMatchObject({ ok: false, reason: "gone" });
    expect(await decideWaiting(OWNER, "draft:abc", "approve", f.deps)).toMatchObject({ ok: false, reason: "gone" });
    expect(f.posts).toEqual([]);
  });

  it("a session that ended meanwhile (eve's 409) is reported as gone, in words that fit why", async () => {
    const stranded = fake({ streams: waiting(), postStatus: 409, postBody: { code: "session_stranded", error: "This session is no longer available.", ok: false, eveVersion: "0.60.1" } });
    expect(await decideWaiting(OWNER, id, "approve", stranded.deps)).toEqual({ ok: false, reason: "gone", message: "That conversation ended with an update, so there is nothing left to decide." });
    const inactive = fake({ streams: waiting(), postStatus: 409, postBody: { ok: false, code: "session_not_active", error: "The session is no longer active." } });
    expect(await decideWaiting(OWNER, id, "approve", inactive.deps)).toEqual({ ok: false, reason: "gone", message: "That conversation has ended, so there is nothing left to decide." });
    // No code at all is still an ending, never a success; and the framework's own words are not repeated.
    const bare = fake({ streams: waiting(), postStatus: 409, postBody: "not json at all" });
    const result = await decideWaiting(OWNER, id, "approve", bare.deps);
    expect(result).toMatchObject({ ok: false, reason: "gone" });
    for (const f of [stranded, inactive, bare]) expect(f.posts).toHaveLength(1); // sent once, never retried
    expect(JSON.stringify([result])).not.toMatch(/session|stranded/i);
  });

  it.each([400, 403, 404, 422, 500, 503])("an answer the agent refuses (HTTP %i) is said as refused, and never as approved", async (status) => {
    // The agent refuses any body it does not list, with a status this console does not rely on:
    // anything that is not a success is a refusal.
    const f = fake({ streams: waiting(), postStatus: status, postBody: { ok: false, error: "framework words" } });
    for (const action of ["approve", "deny"]) {
      const result = await decideWaiting(OWNER, id, action, f.deps);
      expect(result).toEqual({ ok: false, reason: "unavailable", message: `example refused the answer (HTTP ${status}). Nothing was decided.` });
      expect(JSON.stringify(result)).not.toMatch(/approved|carried it out|framework words/i);
    }
    // Sent once each, never retried; and the card is still waiting afterwards.
    expect(f.posts).toHaveLength(2);
    expect((await listWaiting(OWNER, f.deps)).items.map((i) => i.ref)).toEqual(["req-1"]);
  });

  it("an agent not ready for an answer yet is 'try again', not an ending", async () => {
    const f = fake({ streams: waiting(), postStatus: 409, postBody: { ok: false, code: "session_not_ready", error: "The session is not ready to accept messages yet." } });
    expect(await decideWaiting(OWNER, id, "approve", f.deps)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(f.posts).toHaveLength(1);
  });

  it("a conversation whose record can no longer be read has nothing to decide, and nothing is sent", async () => {
    const out: string[] = [];
    const f = fake({ streams: waiting(), streamStatus: { wrun_tg: 409 } });
    f.deps.log = (l) => out.push(l);
    expect(await decideWaiting(OWNER, id, "approve", f.deps)).toMatchObject({ ok: false, reason: "gone" });
    expect(f.posts).toEqual([]);
    expect(out).toEqual(["[waiting] skipped a conversation of agent example: the agent no longer serves it (HTTP 409)"]);
  });

  it("accepted but not yet settled: says the answer arrived and has not been confirmed", async () => {
    const f = fake({ streams: waiting(), after: "nothing" });
    expect(await decideWaiting(OWNER, id, "approve", f.deps)).toMatchObject({ ok: true, outcome: "sent" });
  });

  it("no route password mounted: nothing is read or sent", async () => {
    const f = fake({ streams: waiting() });
    f.deps.routePassword = () => undefined;
    const fetchSpy = vi.spyOn(f.deps, "fetch");
    expect(await decideWaiting(OWNER, id, "approve", f.deps)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Proposals: read from the database, whether or not any agent is running ─────────────────────

const notionRow = (over: Record<string, unknown> = {}) => ({
  id: "7", vault_path: "notes/plan.md", notion_page_id: "page-1", proposed_body: "new text", base_md_hash: "a", notion_hash: "b",
  diff_preview: "- old line\n+ new line", kind: "update", state: "pending", created_at: new Date("2026-10-15T08:00:00.000Z"), notion_owned: false,
  ...over,
});
const atlasRow = (over: Record<string, unknown> = {}) => ({
  id: "3", note_path: "projects/example.md", proposed_note: "full note", base_body_hash: "a", sources_hash: "b",
  diff_preview: "- before\n+ after", state: "pending", created_at: new Date("2026-10-15T07:00:00.000Z"), ...over,
});

describe("proposals on the Waiting page", () => {
  it("lists pending Notion and shared-notes proposals even when every agent fetch fails", async () => {
    const f = fake({ notion: [notionRow(), notionRow({ id: "8", state: "approved" })], atlas: [atlasRow()], streams: {} });
    f.deps.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const { items, unreadable } = await listWaiting(OWNER, f.deps);
    expect(unreadable).toEqual([{ agent: "example", kind: "unreachable" }]);
    const proposals = items.filter((i) => i.kind === "proposal");
    expect(proposals.map((i) => i.kindLabel)).toEqual(["Shared notes proposal", "Notion proposal"]); // oldest first
    expect(proposals.every((i) => i.actions.map((a) => a.id).join() === "approve,reject")).toBe(true);
    expect(proposals[1]!.body.map((b) => ("text" in b ? b.text : "")).join("\n")).toContain("+ new line");
  });

  it("lists them with no agent at all, and never says 'Atlas'", async () => {
    const f = fake({ agents: [], notion: [notionRow()], atlas: [atlasRow()] });
    const { items } = await listWaiting(OWNER, f.deps);
    expect(items).toHaveLength(2);
    expect(JSON.stringify(items.map(({ id: _id, ref: _ref, ...shown }) => shown))).not.toMatch(/atlas/i); // only what the page shows
    expect(f.streamUrls).toEqual([]);
  });

  it("a database failure is named, and the agents' approvals are still listed", async () => {
    const f = fake({ proposalsDown: true, streams: { wrun_tg: asked("req-1", "Send it?", "2026-10-15T09:00:00.000Z") } });
    const { items, unreadable } = await listWaiting(OWNER, f.deps);
    expect(items.map((i) => i.kind)).toEqual(["approval"]);
    expect(unreadable.map((u) => u.agent)).toEqual(["Notion proposals", "Shared notes proposals"]);
  });

  it("Approve flips the Notion proposal through the guarded transition and sends nothing to any agent", async () => {
    const rows = [notionRow()];
    const f = fake({ agents: [], notion: rows });
    const [item] = (await listWaiting(OWNER, f.deps)).items;
    const result = await decideWaiting(OWNER, item!.id, "approve", f.deps);
    expect(result).toMatchObject({ ok: true, outcome: "approved" });
    expect(rows[0]!.state).toBe("approved");
    expect(f.posts).toEqual([]);
  });

  it("Reject flips a shared-notes proposal to rejected", async () => {
    const rows = [atlasRow()];
    const f = fake({ agents: [], atlas: rows });
    const [item] = (await listWaiting(OWNER, f.deps)).items;
    const result = await decideWaiting(OWNER, item!.id, "reject", f.deps);
    expect(result).toMatchObject({ ok: true, outcome: "cancelled" });
    expect(rows[0]!.state).toBe("rejected");
    expect(result.message).not.toMatch(/atlas/i);
  });

  it("a proposal already resolved elsewhere gives decided-elsewhere and changes nothing", async () => {
    const rows = [notionRow()];
    const f = fake({ agents: [], notion: rows });
    const [item] = (await listWaiting(OWNER, f.deps)).items;
    rows[0]!.state = "applied";
    const result = await decideWaiting(OWNER, item!.id, "approve", f.deps);
    expect(result).toMatchObject({ ok: false, reason: "decided-elsewhere" });
    expect(rows[0]!.state).toBe("applied");
  });

  it("a database failure while deciding says nothing was decided; a bad id or action is 'gone'", async () => {
    const f = fake({ agents: [], notion: [notionRow()] });
    const [item] = (await listWaiting(OWNER, f.deps)).items;
    const down = fake({ agents: [], proposalsDown: true });
    expect(await decideWaiting(OWNER, item!.id, "approve", down.deps)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await decideWaiting(OWNER, item!.id, "cancel", f.deps)).toMatchObject({ ok: false, reason: "gone" });
    expect(await decideWaiting(OWNER, itemId("proposal", ["other", "1"]), "approve", f.deps)).toMatchObject({ ok: false, reason: "gone" });
    expect(await decideWaiting(OWNER, itemId("proposal", ["notion", "x"]), "approve", f.deps)).toMatchObject({ ok: false, reason: "gone" });
  });
});


it("native Waiting approval keeps stable resolver separate without creating a private binding",async()=>{
  const f=fake({streams:{wrun_tg:asked("req1","Send reply","2026-10-15T11:00:00.000Z")}});
  const result=await decideWaiting(OWNER,itemId("approval",["example","wrun_tg","req1"]),"approve",f.deps);
  expect(result.ok).toBe(true);expect(f.posts).toHaveLength(1);
  expect(f.queries.every(({sql})=>!sql.includes("INSERT INTO console_session_bindings"))).toBe(true);
  for(const post of f.posts){expect(post.headers.get("x-lares-member-id")).toBe("owner-id");expect(post.headers.get("x-lares-purpose")).toBe("legacy-resolver");}
});
