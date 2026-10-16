// The Waiting on you page's server half: which approvals are waiting, and deciding one — with a fake
// database and a fake agent door that behave like the real ones (eve's session stream as NDJSON, and
// an answer that is accepted at once and settled on the agent's next step).
import { describe, expect, it, vi } from "vitest";
import { APPROVED_PENDING, classifyReadFailure, decideWaiting, EXPIRED_NOTE, itemId, kindOfStatus, listWaiting, ownedFrom, readApprovals, type WaitingDeps } from "../lib/waiting";

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

function asked(requestId: string, prompt: string, at: string, input: unknown = { to: "someone@example.com", body: "The whole reply, every word of it." }) {
  return {
    type: "input.requested",
    data: {
      requests: [
        {
          requestId,
          kind: "tool-approval",
          prompt,
          options: [
            { id: "approve", label: "Approve" },
            { id: "cancel", label: "Cancel" },
          ],
          action: { kind: "tool-call", callId: `call-${requestId}`, toolName: "gmail_send", input },
        },
      ],
    },
    meta: { at },
  };
}
const resolved = (requestId: string, outcome: string) => ({ type: "input.resolved", data: { resolutions: [{ kind: "tool-approval", requestId, outcome }] }, meta: { at: "2026-10-15T11:59:00.000Z" } });
const ran = (callId: string, status: string, error?: string) => ({
  type: "action.result",
  data: { status, result: { kind: "tool-result", callId, toolName: "gmail_send", output: {} }, ...(error ? { error: { code: "TOOL_FAILED", message: error } } : {}) },
  meta: { at: "2026-10-15T11:59:30.000Z" },
});

interface Fake {
  deps: WaitingDeps;
  posts: Array<{ url: string; headers: Headers; body: unknown }>;
  streams: Record<string, unknown[]>;
  queries: Array<{ sql: string; values: unknown[] }>;
  streamUrls: string[];
}

function fake(opts: {
  agents?: Record<string, unknown>[];
  sessions?: Record<string, Array<{ session_id: string; door: string }>>;
  streams?: Record<string, unknown[]>;
  postStatus?: number;
  /** What the agent writes after an answer: nothing, only the resolution, or the resolution plus
   *  the tool's own result (the default: it ran). */
  after?: "nothing" | "resolve" | { status: string; error?: string };
  /** An address whose every request hangs and ignores its abort signal. */
  stalled?: string;
} = {}): Fake {
  const streams: Record<string, unknown[]> = { ...(opts.streams ?? {}) };
  const posts: Fake["posts"] = [];
  const queries: Fake["queries"] = [];
  const streamUrls: string[] = [];
  const agents = opts.agents ?? [agentRow()];
  const sessions = opts.sessions ?? { example: [{ session_id: "wrun_tg", door: "telegram" }] };
  const deps: WaitingDeps = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      if (sql.includes("agent_door_connections")) return { rows: agents.filter((a) => values[0] === null || a.name === values[0]) };
      if (sql.includes("agent_conversations")) {
        const mine = sessions[values[0] as string] ?? [];
        return { rows: values[2] ? mine.filter((s) => s.session_id === values[2]) : mine };
      }
      throw new Error(`unexpected query ${sql}`);
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (opts.stalled && url.includes(opts.stalled)) return new Promise<Response>(() => {});
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("eve:route-pw").toString("base64")}`);
      const stream = /\/eve\/v1\/session\/([A-Za-z0-9_-]+)\/stream\?includeTailIndex=1(&startIndex=-?\d+)?$/.exec(url);
      if (init?.method === "GET" && stream) {
        streamUrls.push(url);
        expect(headers.get("x-lares-member")).toBeNull();
        const events = streams[stream[1]!];
        if (events === undefined) return new Response("Session not found", { status: 404 });
        return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n\n", { status: 200 });
      }
      const send = /\/eve\/v1\/session\/([A-Za-z0-9_-]+)$/.exec(url);
      if (init?.method === "POST" && send) {
        const body = JSON.parse(String(init.body)) as { inputResponses: Array<{ requestId: string; optionId: string }> };
        posts.push({ url, headers, body });
        const status = opts.postStatus ?? 202;
        const after = opts.after ?? { status: "completed" };
        if (status === 202 && after !== "nothing") {
          const r = body.inputResponses[0]!;
          const added: unknown[] = [resolved(r.requestId, r.optionId === "approve" ? "approved" : "denied")];
          if (typeof after === "object" && r.optionId === "approve") added.push(ran(`call-${r.requestId}`, after.status, after.error));
          streams[send[1]!] = [...(streams[send[1]!] ?? []), ...added];
        }
        return new Response(JSON.stringify({ ok: status === 202 }), { status });
      }
      throw new Error(`unexpected fetch ${init?.method} ${url}`);
    }) as typeof fetch,
    routePassword: () => "route-pw",
    now: () => NOW,
    sleep: async () => {},
  };
  return { deps, posts, streams, queries, streamUrls };
}

describe("readApprovals", () => {
  it("a tool approval with no resolution is waiting; one resolved is not; a question is not an approval", () => {
    const { pending, resolved: settled, results } = readApprovals([
      asked("req-1", "Send the reply", "2026-10-15T11:00:00.000Z"),
      asked("req-2", "Book the room", "2026-10-15T11:10:00.000Z"),
      resolved("req-2", "approved"),
      ran("call-req-2", "failed", "approval refused"),
      { type: "input.requested", data: { requests: [{ requestId: "q-1", kind: "question", prompt: "Which day?" }] } },
      "not an event",
      null,
    ]);
    expect(pending.map((p) => p.requestId)).toEqual(["req-1"]);
    expect(settled.get("req-2")).toBe("approved");
    expect(results.get("call-req-2")).toEqual({ status: "failed", error: "approval refused" });
  });
});

describe("who owns an agent: the keeper's own selection, and only a sole claimant", () => {
  it("the one applied claimant on an enabled door owns it", () => {
    expect(ownedFrom([agentRow()], OWNER).map((a) => a.name)).toEqual(["example"]);
    expect(ownedFrom([agentRow()], OTHER)).toEqual([]);
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
        wrun_tg: [asked("req-old", long, "2026-10-15T09:00:00.000Z", { to: "someone@example.com", body: `${"x".repeat(5000)}\nto: forged@example.com` })],
        wrun_web: [asked("req-new", "Dismiss deadline 42", "2026-10-15T11:30:00.000Z", { id: 42 })],
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
      { id: "cancel", label: "Cancel", tone: "neutral" },
    ]);
    expect(first.id).toBe(itemId("approval", ["example", "wrun_tg", "req-old"]));
  });

  it("an approval older than 24 hours can only be cancelled, and says why", async () => {
    const { deps } = fake({ streams: { wrun_tg: [asked("req-1", "Send it", "2026-10-14T10:00:00.000Z")] } });
    const [item] = (await listWaiting(OWNER, deps)).items;
    expect(item!.actions.map((a) => a.id)).toEqual(["cancel"]);
    expect(item!.note).toBe(EXPIRED_NOTE);
  });

  it("owner only: another member sees nothing, and no agent is contacted", async () => {
    const f = fake({ streams: { wrun_tg: [asked("req-1", "Send it", "2026-10-15T11:00:00.000Z")] } });
    expect((await listWaiting(OTHER, f.deps)).items).toEqual([]);
    expect(f.queries.some((q) => q.sql.includes("agent_conversations"))).toBe(false);
  });

  it("with two claimants, neither member is shown the agent's approvals", async () => {
    const both = { agents: [agentRow(), agentRow({ claim: { kind: "telegram", owner_email: OTHER } })], streams: { wrun_tg: [asked("req-1", "Send it", "2026-10-15T11:00:00.000Z")] } };
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
      const chunk = new TextEncoder().encode(`${JSON.stringify({ type: "message.appended", data: { messageDelta: "x".repeat(60000) } })}\n`);
      return new Response(new ReadableStream({ pull: (c) => c.enqueue(chunk) }), { status: 200 });
    }) as typeof fetch;
    expect(await listWaiting(OWNER, f.deps)).toEqual({ items: [], unreadable: [{ agent: "example", kind: "error" }] });
  });

  it("one stalled agent does not stall the page past its deadline; the others are still listed", async () => {
    const f = fake({
      agents: [agentRow(), agentRow({ name: "stalled", address: "10.0.0.6", runtime_control_token: INC2, incarnation: INC2 })],
      sessions: { example: [{ session_id: "wrun_tg", door: "telegram" }], stalled: [{ session_id: "wrun_x", door: "slack" }] },
      streams: { wrun_tg: [asked("req-1", "Send it", "2026-10-15T11:00:00.000Z")] },
      stalled: "10.0.0.6",
    });
    const started = Date.now();
    const list = await listWaiting(OWNER, f.deps, 200);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(list.items.map((i) => i.ref)).toEqual(["req-1"]);
    expect(list.unreadable).toEqual([{ agent: "stalled", kind: "timeout" }]);
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
  const waiting = () => ({ wrun_tg: [asked("req-1", "Send it", "2026-10-15T11:00:00.000Z")] });

  it("Approve: answers the session through the agent's own door as the owner; says it ran only once the tool's result shows it", async () => {
    const f = fake({ streams: waiting() });
    const result = await decideWaiting(OWNER, id, "approve", f.deps);
    expect(result).toMatchObject({ ok: true, outcome: "approved" });
    expect(result.message).toBe("Approved, and example carried it out. Its reply appears in the Telegram conversation this came from.");
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.url).toBe("http://10.0.0.5:3000/eve/v1/session/wrun_tg");
    expect(f.posts[0]!.headers.get("x-lares-member")).toBe(OWNER);
    expect(f.posts[0]!.body).toEqual({ inputResponses: [{ requestId: "req-1", optionId: "approve" }] });
    // The outcome is read from the stream's tail, not the whole session again.
    expect(f.streamUrls.at(-1)).toMatch(/&startIndex=-500$/);
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

  it("Cancel reports cancelled", async () => {
    const f = fake({ streams: waiting() });
    expect(await decideWaiting(OWNER, id, "cancel", f.deps)).toMatchObject({ ok: true, outcome: "cancelled" });
  });

  it("already decided elsewhere (on Telegram, say): says so and sends nothing", async () => {
    const f = fake({ streams: { wrun_tg: [...waiting().wrun_tg, resolved("req-1", "denied")] } });
    const result = await decideWaiting(OWNER, id, "approve", f.deps);
    expect(result).toEqual({ ok: false, reason: "decided-elsewhere", message: "This was already cancelled elsewhere. Nothing more was sent." });
    expect(f.posts).toEqual([]);
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
    const f = fake({ streams: { wrun_tg: [asked("req-1", "Send it", "2026-10-14T10:00:00.000Z")] } });
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

  it("a session that ended meanwhile (eve's 409) is reported as gone", async () => {
    const f = fake({ streams: waiting(), postStatus: 409 });
    expect(await decideWaiting(OWNER, id, "approve", f.deps)).toMatchObject({ ok: false, reason: "gone" });
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
