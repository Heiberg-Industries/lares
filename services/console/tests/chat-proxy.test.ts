/**
 * The console's chat proxy.
 *
 * This is the one place in the system that holds a browser session cookie and an agent's route
 * password at the same time, so the tests below are ordered by what would go wrong: a signed-out
 * visitor reaching an agent, a request path naming its own upstream, and the password coming back
 * out towards the browser.
 *
 * Shaped after `tests/door-forwarder.test.ts`, which guards the other lane (platform webhooks in).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { forwardChat, CHAT_PATHS, MEMBER_HEADER, ROUTE_USERNAME, resetAnswerClaimsForTests, type ChatDeps } from "../lib/chat-proxy";
import { chatSessionCapabilityCookie } from "../lib/chat-session-capability";

/**
 * THE AGENT KIT'S ENVELOPE CHECK. The proxy shows every body it is about to send to
 * `assertPrivateConsoleEnvelope` from the agent kit; the agent runs the same check on what
 * arrives, and refuses any field it does not list. These tests run against the kit's REAL check.
 * The wrapper below only records what the proxy showed it (`seen`), and lets one group of tests
 * take the check out of the way (`check`) to prove the proxy's own rules do not lean on it.
 */
const envelope=vi.hoisted(()=>({check:undefined as undefined|((payload:unknown,path:string)=>void),seen:[] as {payload:unknown;path:string}[]}));
vi.mock('@lares/agent-kit/private-console-envelope',async importOriginal=>{
  const real=await importOriginal<typeof import('@lares/agent-kit/private-console-envelope')>();
  return {...real,assertPrivateConsoleEnvelope:(payload:unknown,path:string)=>{envelope.seen.push({payload,path});(envelope.check??real.assertPrivateConsoleEnvelope)(payload,path);}};
});
beforeEach(()=>{envelope.check=undefined;envelope.seen.length=0;});
// Each test starts with no card claimed by an earlier test's answer (`claimAnswer` in the proxy).
beforeEach(()=>resetAnswerClaimsForTests());

const access=vi.hoisted(()=>({captureUse:vi.fn(async()=>1)}));
const modelPurpose=vi.hoisted(()=>({configured:vi.fn(()=>false),sign:vi.fn(async()=>"signed-model-capsule"),hashed:[] as Uint8Array[]}));
vi.mock('@lares/agent-kit/grant-store',()=>({PgGrantStore:class {captureUse=access.captureUse;async captureUseWithExpiry(){const revision=await access.captureUse();return revision===undefined?undefined:{accessRevision:revision,validUntil:null};}}}));
vi.mock('../lib/model-purpose-capsule',()=>({modelPurposeSigningConfigured:modelPurpose.configured,signPrivateModelPurposeRequest:modelPurpose.sign,modelPurposeRawBodyHash:(bytes:Uint8Array)=>{modelPurpose.hashed.push(bytes);return "a".repeat(64);}}));
beforeEach(()=>{vi.stubEnv('AGENT_OWNER_USER_ID','Owner-ID');access.captureUse.mockResolvedValue(1);modelPurpose.configured.mockReturnValue(false);modelPurpose.sign.mockClear();modelPurpose.hashed.length=0;});
afterAll(()=>vi.unstubAllEnvs());
const PASSWORD = "disposable-fixture-only";

const row = {
  address: "172.29.0.10/32",
  role: "chief-of-staff",
  status: "valid",
  state: "ready",
  runtime_control_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  incarnation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  definition_hash: "b".repeat(64),
};

/**
 * The plan's fixture plus two things this slice needs to be able to assert:
 * `signedInMember` (the session check happens INSIDE the proxy, so a route that forgot it cannot
 * exist) and `routePassword` as a spy (so "a signed-out request reads no secret" is a real
 * assertion and not a hope).
 */
// `password: null` means "none is mounted" — a default parameter cannot express that, because
// passing `undefined` is what selects the default.
const deps = (
  value: unknown = row,
  password: string | null = PASSWORD,
  email: string | null = "owner@example.invalid",
) => {const database={
  query: vi.fn<ChatDeps["query"]>(async (sql,values) => {
    if (["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.includes("pg_advisory_xact_lock")||sql.includes("console_vault_source_captures")) return {rows:[]};
    if (sql.includes("AS organisation_id FROM users"))return {rows:[{organisation_id:"org"}]};
    if (sql.includes("FROM users WHERE"))return {rows:[{id:values[0],org_id:"org",org_role:"owner",status:"active",automation_mode:"draft-and-ask"}]};
    if (sql.includes("FROM orgs WHERE"))return {rows:[{id:"org"}]};
    // A card still waiting for its answer, unless a test says otherwise.
    if (sql.includes("FROM approval_asks")) return {rows:[{outcome:null,used_at:null}]};
    if (sql.includes("console_session_bindings")) return {rows:[{agent:values[0],incarnation:values[1],session_id:values[2],member_id:values[3],admission_nonce:values[4] ?? "a".repeat(43),place_id:`console:${values[0]}:${values[1]}:${values[2]}`,audience_revision:1,policy_revision:2,agent_access_revision:1,private_surface_revision:2,source_history_guard_revision:1}]};
    return {rows:value ? [value as Record<string,unknown>] : []};
  }),
  fetch: vi.fn<typeof fetch>(async () =>
    new Response('{"ok":true,"sessionId":"wrun_A","status":"accepted"}', {
      status: 200,
      headers: { "content-type": "application/json", "x-eve-session-id": "wrun_A" },
    }),
  ),
  routePassword: vi.fn<ChatDeps["routePassword"]>(() => password ?? undefined),
  signedInMember: vi.fn<ChatDeps["signedInMember"]>(async () => email ? ({id:email === "owner@example.invalid" ? "Owner-ID" : "Other-ID",organisationId:"org",role:"owner",status:"active",automationMode:"draft-and-ask"}) : null),
};return {...database,connect:async()=>({query:async(sql:string,values?:unknown[])=>{const result=await database.query(sql,values??[]);return {...result,command:["BEGIN","COMMIT","ROLLBACK"].includes(sql)?sql:undefined};},release(){}})};};

const post = (body = '{"message":"hello"}', signal?: AbortSignal) =>
  new Request("https://console.example.invalid/api/chat/helper/eve/v1/session", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", cookie: "lares_session=abc", authorization: "Basic forged" },
    ...(signal ? { signal } : {}),
  });

const capability = (member = "Owner-ID", agent = "helper", incarnation = row.incarnation) =>
  chatSessionCapabilityCookie(post(), PASSWORD, member, agent, incarnation, "wrun_A").split(";")[0]!;

const sessionRequest = (path: string, method = "GET", cookie = capability()) =>
  new Request(`https://console.example.invalid/api/chat/helper/${path}`, {
    method,
    headers: { cookie: `lares_session=abc; ${cookie}` },
    ...(method === "POST" ? { body: /\/(cancel|clear|compact|end|reset)$/.test(path) ? "{}" : '{"message":"hello"}' } : {}),
  });

describe("the console's chat proxy", () => {
  it("prewarms an empty session, then signs and forwards the exact first human message", async () => {
    modelPurpose.configured.mockReturnValue(true);
    const d=deps();
    const created=await forwardChat(new Request("https://console.example.invalid/api/chat/helper/eve/v1/session",{method:"POST",headers:{cookie:"lares_session=abc"}}),"helper","eve/v1/session",d);
    expect(created.status).toBe(200);
    expect((d.fetch.mock.calls[0]![1]?.body as Uint8Array).byteLength).toBe(0);
    expect(modelPurpose.sign).not.toHaveBeenCalled();
    const cookie=created.headers.get("set-cookie")!.split(";")[0]!;
    const raw='{"message":"first chat"}';
    const sent=await forwardChat(new Request("https://console.example.invalid/api/chat/helper/eve/v1/session/wrun_A",{method:"POST",body:raw,headers:{cookie:`lares_session=abc; ${cookie}`}}),"helper","eve/v1/session/wrun_A",d);
    expect(sent.status).toBe(200);
    expect(modelPurpose.sign).toHaveBeenCalledWith(expect.objectContaining({session:"wrun_A",purpose:"human",rawBodyHash:expect.any(String)}));
    const [,init]=d.fetch.mock.calls[1]!;
    expect(Buffer.from(init?.body as Uint8Array).toString("utf8")).toBe(raw);
    expect(new Headers(init?.headers).get("x-lares-model-capsule")).toBe("signed-model-capsule");
    expect(new Headers(init?.headers).get("x-lares-model-purpose-required")).toBe("1");
  });
  it("fails closed when configured model custody lacks validated definition data or a chief adapter", async () => {
    modelPurpose.configured.mockReturnValue(true);
    const cookie=capability();
    const missingHash=deps({...row,definition_hash:undefined});
    const first=await forwardChat(new Request("https://console.example.invalid/api/chat/helper/eve/v1/session/wrun_A",{method:"POST",body:'{"message":"hello"}',headers:{cookie:`lares_session=abc; ${cookie}`}}),"helper","eve/v1/session/wrun_A",missingHash);
    expect(first.status).toBe(503);expect(missingHash.fetch).not.toHaveBeenCalled();
    const unsupported=deps({...row,role:"creative"});
    const second=await forwardChat(new Request("https://console.example.invalid/api/chat/helper/eve/v1/session/wrun_A",{method:"POST",body:'{"message":"hello"}',headers:{cookie:`lares_session=abc; ${cookie}`}}),"helper","eve/v1/session/wrun_A",unsupported);
    expect(second.status).toBe(503);expect(unsupported.fetch).not.toHaveBeenCalled();
  });
  it("denies missing adoption before reading address, route password or upstream",async()=>{
    const d=deps();access.captureUse.mockResolvedValueOnce(undefined as never);
    const response=await forwardChat(post(),'helper','eve/v1/session',d);
    expect(response.status).toBe(403);expect(await response.text()).toContain('Conversation access is unavailable');
    expect(d.query.mock.calls.some(([sql])=>sql.includes("FROM agent_resources"))).toBe(false);expect(d.routePassword).not.toHaveBeenCalled();expect(d.fetch).not.toHaveBeenCalled();
  });
  it("sends the turn to the agent's own door, with the route credential and nothing of the browser's", async () => {
    const d = deps();
    expect((await forwardChat(post(), "helper", "eve/v1/session", d)).status).toBe(200);
    const [url, init] = d.fetch.mock.calls[0]!;
    expect(url).toBe("http://172.29.0.10:3000/eve/v1/session");
    const headers = init!.headers as Headers;
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from(`eve:${PASSWORD}`).toString("base64")}`);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("host")).toBe(false);
    expect(init!.redirect).toBe("error");
  });

  it("does nothing at all for a visitor who is not signed in", async () => {
    const d = deps(row, PASSWORD, null);
    const response = await forwardChat(post(), "helper", "eve/v1/session", d);
    expect(response.status).toBe(401);
    // A browser must not be offered a Basic prompt for the agent's own credential.
    expect(response.headers.has("www-authenticate")).toBe(false);
    expect(d.query).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.routePassword).not.toHaveBeenCalled();
  });

  it("never lets the credential reach the browser", async () => {
    const d = deps();
    const response = await forwardChat(post(), "helper", "eve/v1/session", d);
    expect(await response.text()).not.toContain(PASSWORD);
    expect(response.headers.has("www-authenticate")).toBe(false);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Path=/api/chat/helper/eve/v1/session/wrun_A");
    expect(response.headers.get("set-cookie")).not.toContain(PASSWORD);
  });

  it("does not echo the agent's own challenge or cookie when the agent refuses the credential", async () => {
    const d = deps();
    d.fetch.mockResolvedValue(
      new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": 'Basic realm="lares"',
          "set-cookie": "agent_session=abc",
        },
      }),
    );
    const response = await forwardChat(post(), "helper", "eve/v1/session", d);
    expect(response.status).toBe(401);
    expect(response.headers.has("www-authenticate")).toBe(false);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.text()).not.toContain(PASSWORD);
  });

  it("refuses an existing conversation without its signed capability before calling the agent", async () => {
    const d = deps();
    const path = "eve/v1/session/wrun_A/stream";
    const response = await forwardChat(new Request(`https://console.example.invalid/api/chat/helper/${path}`), "helper", path, d);
    expect(response.status).toBe(403);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("binds a conversation to its signed-in member and agent incarnation", async () => {
    const path = "eve/v1/session/wrun_A/stream";
    const otherMember = deps(row, PASSWORD, "other@example.invalid");
    expect((await forwardChat(sessionRequest(path), "helper", path, otherMember)).status).toBe(403);
    expect(otherMember.fetch).not.toHaveBeenCalled();

    const newIncarnation = { ...row, incarnation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", runtime_control_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const replacement = deps(newIncarnation);
    expect((await forwardChat(sessionRequest(path), "helper", path, replacement)).status).toBe(403);
    expect(replacement.fetch).not.toHaveBeenCalled();
  });

  it("refuses a created session when Eve omits its ID header", async () => {
    const d = deps();
    d.fetch.mockResolvedValue(new Response('{"sessionId":"wrun_A"}', { status: 202 }));
    const response = await forwardChat(post(), "helper", "eve/v1/session", d);
    expect(response.status).toBe(502);
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("reports a failed upstream call without repeating what it was carrying", async () => {
    const d = deps();
    // A real `connect` failure quotes the whole request line in some runtimes; the proxy must
    // report its own sentence, never the error's.
    d.fetch.mockRejectedValue(new Error(`connect ECONNREFUSED eve:${PASSWORD}@172.29.0.10:3000`));
    const response = await forwardChat(post(), "helper", "eve/v1/session", d);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("172.29.0.10");
    for (const [, value] of response.headers) expect(value).not.toContain(PASSWORD);
  });

  it("marks an unreachable or not-ready agent as not running, and nothing else", async () => {
    const down = deps();
    down.fetch.mockRejectedValue(new Error("connect EHOSTUNREACH"));
    expect((await forwardChat(post(), "helper", "eve/v1/session", down)).headers.get("x-lares-agent-state")).toBe("not-running");
    const stopped = deps({ ...row, state: "retired" });
    const gone = await forwardChat(post(), "helper", "eve/v1/session", stopped);
    expect(gone.status).toBe(404);
    expect(gone.headers.get("x-lares-agent-state")).toBe("not-running");
    // A bad path is not "not running".
    expect((await forwardChat(post(), "helper", "eve/v1/slack", deps())).headers.has("x-lares-agent-state")).toBe(false);
  });

  it("streams the agent's answer instead of waiting for all of it", async () => {
    const d = deps();
    const chunks = ['{"type":"a"}\n', '{"type":"b"}\n'];
    d.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/x-ndjson" } },
      ),
    );
    const get = sessionRequest("eve/v1/session/wrun_A/stream");
    const response = await forwardChat(get, "helper", "eve/v1/session/wrun_A/stream", d);
    expect(response.body).not.toBeNull();
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(chunks.join(""));
  });

  it("hands the first line over before the agent has finished talking", async () => {
    const d = deps();
    let push!: (text: string) => void;
    d.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            push = (text) => c.enqueue(new TextEncoder().encode(text));
          },
        }),
        { status: 200, headers: { "content-type": "application/x-ndjson" } },
      ),
    );
    const get = sessionRequest("eve/v1/session/wrun_A/stream");
    const response = await forwardChat(get, "helper", "eve/v1/session/wrun_A/stream", d);
    push('{"type":"first"}\n');
    const first = await response.body!.getReader().read();
    // A proxy that buffered the whole body would never get here: the stream is still open.
    expect(new TextDecoder().decode(first.value)).toBe('{"type":"first"}\n');
  });

  it("lets go of the agent when the browser goes away", async () => {
    const d = deps();
    const controller = new AbortController();
    const get = new Request("https://console.example.invalid/api/chat/helper/eve/v1/session/wrun_A/stream", {
      signal: controller.signal,
      headers: { cookie: `lares_session=abc; ${capability()}` },
    });
    await forwardChat(get, "helper", "eve/v1/session/wrun_A/stream", d);
    const [, init] = d.fetch.mock.calls[0]!;
    expect(init!.signal!.aborted).toBe(false);
    controller.abort();
    expect(init!.signal!.aborted).toBe(true);
  });

  const STREAM = "eve/v1/session/wrun_A/stream";
  const streamWith = (query: string) =>
    new Request(`https://console.example.invalid/api/chat/helper/${STREAM}${query}`, { headers: { cookie: `lares_session=abc; ${capability()}` } });

  it.each([
    ["", ""],
    ["?startIndex=12", "?startIndex=12"],
    ["?includeTailIndex=1", "?includeTailIndex=1"],
    ["?follow=false", "?follow=false"],
    // The three together, in the order the framework's client writes them.
    ["?startIndex=12&includeTailIndex=1&follow=false", "?startIndex=12&includeTailIndex=1&follow=false"],
  ])("carries the stream parameters the framework's client sets, in the shape it sets them (%j)", async (query, upstream) => {
    const d = deps();
    expect((await forwardChat(streamWith(query), "helper", STREAM, d)).status).toBe(200);
    expect(String(d.fetch.mock.calls[0]![0])).toBe(`http://172.29.0.10:3000/${STREAM}${upstream}`);
  });

  it.each([
    "?host=evil.example.invalid",
    "?startIndex=12&host=evil.example.invalid",
    // The parameter the older client sent, which the new one does not.
    "?streamControlVersion=1",
    "?startIndex2=x",
    // A known name in any other shape.
    "?startIndex=-5",
    "?startIndex=1e3",
    "?startIndex=",
    "?startIndex=1234567890123",
    "?includeTailIndex=0",
    "?includeTailIndex=true",
    "?follow=true",
    "?follow=0",
    "?follow=FALSE",
    // A known name twice.
    "?startIndex=1&startIndex=2",
    "?follow=false&follow=false",
  ])("refuses a stream request with any other query parameter, rather than dropping it (%j)", async (query) => {
    const d = deps();
    const response = await forwardChat(streamWith(query), "helper", STREAM, d);
    expect(response.status).toBe(400);
    expect(d.fetch).not.toHaveBeenCalled();
    // Refused before anything is looked up, read or opened.
    expect(d.query).not.toHaveBeenCalled();
    expect(d.routePassword).not.toHaveBeenCalled();
  });

  it.each([
    ["eve/v1/session", "POST"],
    ["eve/v1/session/wrun_A", "POST"],
    ["eve/v1/session/wrun_A/end", "POST"],
    ["eve/v1/session/wrun_A/cancel", "POST"],
    ["eve/v1/health", "GET"],
  ])("takes no query parameter at all on any path but a stream (%s)", async (path, method) => {
    for (const query of ["?startIndex=1", "?includeTailIndex=1", "?follow=false", "?anything=1"]) {
      const d = deps();
      const request = new Request(`https://console.example.invalid/api/chat/helper/${path}${query}`, {
        method,
        headers: { cookie: `lares_session=abc; ${capability()}` },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect((await forwardChat(request, "helper", path, d)).status, query).toBe(400);
      expect(d.fetch).not.toHaveBeenCalled();
    }
  });

  it("relays only the two request headers the chat needs, and no event id from the older client", async () => {
    const d = deps();
    const get = streamWith("");
    get.headers.set("accept", "application/x-ndjson");
    get.headers.set("last-event-id", "evt_42");
    get.headers.set("x-forwarded-for", "203.0.113.9");
    await forwardChat(get, "helper", STREAM, d);
    const headers = d.fetch.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get("accept")).toBe("application/x-ndjson");
    expect(headers.has("last-event-id")).toBe(false);
    expect(headers.has("x-forwarded-for")).toBe(false);
  });

  it("passes the stream's own headers back, so the framework's client accepts the response", async () => {
    const d = deps();
    d.fetch.mockResolvedValue(new Response('{"$eve":"heartbeat"}\n', { status: 200, headers: {
      "content-type": "application/x-ndjson; charset=utf-8", "x-eve-stream-version": "27", "x-eve-stream-tail-index": "41",
      "x-eve-session-id": "wrun_A", "set-cookie": "agent=1", "x-accel-buffering": "no",
    } }));
    const response = await forwardChat(streamWith("?includeTailIndex=1"), "helper", STREAM, d);
    expect(response.headers.get("x-eve-stream-version")).toBe("27");
    expect(response.headers.get("x-eve-stream-tail-index")).toBe("41");
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("does NOT require a claimed or enabled door — a fresh installation has none", async () => {
    const d = deps();
    await forwardChat(post(), "helper", "eve/v1/session", d);
    const [sql] = d.query.mock.calls.find(([sql])=>sql.includes("host(r.address)"))!;
    expect(sql).not.toMatch(/agent_doors/);
  });

  it.each([
    null,
    { ...row, state: "retired" },
    { ...row, status: "invalid" },
    { ...row, runtime_control_token: null },
    { ...row, runtime_control_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { ...row, address: "8.8.8.8" },
    { ...row, address: "127.0.0.1" },
    { ...row, address: "evil.example.invalid" },
  ])("refuses an agent it cannot vouch for %#", async (value) => {
    const d = deps(value);
    expect((await forwardChat(post(), "helper", "eve/v1/session", d)).status).toBe(404);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.routePassword).not.toHaveBeenCalled();
  });

  it("refuses a path it does not recognise, before it looks anything up", async () => {
    const d = deps();
    expect((await forwardChat(post(), "helper", "eve/v1/slack", d)).status).toBe(404);
    expect((await forwardChat(post(), "../admin", "eve/v1/session", d)).status).toBe(404);
    expect(d.query).not.toHaveBeenCalled();
  });

  it.each([
    "../",
    "..",
    "%2e%2e",
    "../../etc/passwd",
    "agent@evil.example",
    "agent:8080",
    "http://evil.example.invalid/",
    "//evil.example.invalid",
    "",
    "a".repeat(200),
    "Helper",
    "helper/eve",
    "helper%2Fadmin",
  ])("never builds an address out of the name in the path (%j)", async (name) => {
    const d = deps();
    expect((await forwardChat(post(), name, "eve/v1/session", d)).status).toBe(404);
    expect(d.query).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.routePassword).not.toHaveBeenCalled();
  });

  it("forwards only what the chat itself needs, by method as well as by path", async () => {
    const d = deps();
    // Reading a session's stream is a GET; posting to it is how a turn is sent. Neither may stand
    // in for the other, and nothing outside this list is relayed at all.
    expect(CHAT_PATHS.length).toBe(5);
    const get = (path: string) => new Request(`https://console.example.invalid/api/chat/helper/${path}`);
    expect((await forwardChat(get("eve/v1/session"), "helper", "eve/v1/session", d)).status).toBe(404);
    expect(
      (await forwardChat(post(), "helper", "eve/v1/session/wrun_A/stream", d)).status,
    ).toBe(404);
    expect(d.query).not.toHaveBeenCalled();
    for (const path of ["eve/v1/health"]) {
      expect((await forwardChat(get(path), "helper", path, d)).status).toBe(200);
    }
    // `end` is how the framework's client closes a conversation; `reset` is the older name the
    // agent still serves for it.
    for (const verb of ["cancel", "clear", "compact", "end", "reset"]) {
      const path = `eve/v1/session/wrun_A/${verb}`;
      expect((await forwardChat(sessionRequest(path, "POST"), "helper", path, d)).status, verb).toBe(200);
      const [url, init] = d.fetch.mock.calls.at(-1)!;
      expect(url).toBe(`http://172.29.0.10:3000/${path}`);
      expect((init!.headers as Headers).get("x-lares-purpose")).toBe("control");
    }
    expect((await forwardChat(sessionRequest("eve/v1/session/wrun_A", "POST"), "helper", "eve/v1/session/wrun_A", d)).status).toBe(200);
  });

  it("ends a conversation with the body the framework's client sends: nothing, or a reason", async () => {
    const path = "eve/v1/session/wrun_A/end";
    for (const raw of ["{}", '{"reason":"Conversation finished"}']) {
      const d = deps();
      const request = new Request(`https://console.example.invalid/api/chat/helper/${path}`, {
        method: "POST", body: raw, headers: { "content-type": "application/json", cookie: `lares_session=abc; ${capability()}` },
      });
      expect((await forwardChat(request, "helper", path, d)).status, raw).toBe(200);
      expect(Buffer.from(d.fetch.mock.calls[0]![1]!.body as Uint8Array).toString("utf8")).toBe(raw);
    }
    const d = deps();
    const unknown = new Request(`https://console.example.invalid/api/chat/helper/${path}`, {
      method: "POST", body: '{"reason":"x","force":true}', headers: { cookie: `lares_session=abc; ${capability()}` },
    });
    expect((await forwardChat(unknown, "helper", path, d)).status).toBe(400);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("cancels with a turn named, or with none — and 'no turn' leaves the console as {}, never as a null", async () => {
    const path = "eve/v1/session/wrun_A/cancel";
    const cancel = (raw: string) => new Request(`https://console.example.invalid/api/chat/helper/${path}`, {
      method: "POST", body: raw, headers: { "content-type": "application/json", cookie: `lares_session=abc; ${capability()}` },
    });
    for (const [raw, sent] of [
      ['{"turnId":"turn_1"}', '{"turnId":"turn_1"}'],
      ["{}", "{}"],
      // What the framework's store sends when it knows of no running turn. The agent refuses a
      // null; the body that names no turn is the empty one.
      ['{"turnId":null}', "{}"],
    ] as const) {
      const d = deps();
      expect((await forwardChat(cancel(raw), "helper", path, d)).status, raw).toBe(200);
      const [, init] = d.fetch.mock.calls[0]!;
      expect(Buffer.from(init!.body as Uint8Array).toString("utf8")).toBe(sent);
      expect((init!.headers as Headers).get("x-lares-purpose")).toBe("control");
    }
    for (const raw of ['{"turnId":""}', '{"turnId":7}', '{"turnId":["turn_1"]}', '{"turnId":null,"force":true}', '{"turnId":"turn_1","reason":"x"}', '{"reason":null}']) {
      const d = deps();
      expect((await forwardChat(cancel(raw), "helper", path, d)).status, raw).toBe(400);
      expect(d.fetch).not.toHaveBeenCalled();
    }
    // Only cancel reads a null that way: the other controls still refuse one.
    for (const verb of ["end", "reset", "clear", "compact"]) {
      const d = deps();
      const other = `eve/v1/session/wrun_A/${verb}`;
      const request = new Request(`https://console.example.invalid/api/chat/helper/${other}`, { method: "POST", body: '{"turnId":null}', headers: { cookie: `lares_session=abc; ${capability()}` } });
      expect((await forwardChat(request, "helper", other, d)).status, verb).toBe(400);
      expect((await forwardChat(new Request(request.url, { method: "POST", body: '{"reason":null}', headers: { cookie: `lares_session=abc; ${capability()}` } }), "helper", other, d)).status, verb).toBe(400);
      expect(d.fetch).not.toHaveBeenCalled();
    }
  });

  it("marks its own refusals, and never passes that mark on from an agent", async () => {
    // Every sentence this proxy writes carries its mark, whatever the reason.
    const signedOut = await forwardChat(post(), "helper", "eve/v1/session", deps(row, PASSWORD, null));
    const badPath = await forwardChat(post(), "helper", "eve/v1/slack", deps());
    const badBody = await forwardChat(post('{"message":"x","callback":{}}'), "helper", "eve/v1/session", deps());
    const down = deps();
    down.fetch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const noAnswer = await forwardChat(post(), "helper", "eve/v1/session", down);
    for (const refusal of [signedOut, badPath, badBody, noAnswer]) {
      expect(refusal.ok).toBe(false);
      expect(refusal.headers.get("x-lares-console-refusal")).toBe("1");
      expect(refusal.headers.get("content-type")).toBe("text/plain");
    }
    // An agent answering in plain text, and claiming the mark, gets neither treated as ours.
    const d = deps();
    d.fetch.mockResolvedValue(new Response("Text an agent wrote.", { status: 400, headers: { "content-type": "text/plain", "x-lares-console-refusal": "1", "x-lares-agent-state": "not-running" } }));
    const relayed = await forwardChat(sessionRequest("eve/v1/session/wrun_A", "POST"), "helper", "eve/v1/session/wrun_A", d);
    expect(relayed.status).toBe(400);
    expect(relayed.headers.has("x-lares-console-refusal")).toBe(false);
    expect(relayed.headers.has("x-lares-agent-state")).toBe(false);
  });

  it.each([
    ["eve/v1/session/wrun_A/end", "GET"],
    ["eve/v1/session/wrun_A/end", "DELETE"],
    ["eve/v1/session/wrun_A", "PUT"],
    ["eve/v1/session/wrun_A", "PATCH"],
    ["eve/v1/session/wrun_A", "DELETE"],
    ["eve/v1/session", "PUT"],
    ["eve/v1/session/wrun_A/stream", "PUT"],
    ["eve/v1/health", "POST"],
  ])("refuses a known path under a method the chat does not use (%s %s)", async (path, method) => {
    const d = deps();
    const request = new Request(`https://console.example.invalid/api/chat/helper/${path}`, {
      method, headers: { cookie: `lares_session=abc; ${capability()}` }, ...(method === "GET" ? {} : { body: "{}" }),
    });
    expect((await forwardChat(request, "helper", path, d)).status).toBe(404);
    expect(d.query).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "eve/v1/session/wrun_A/restart",
    "eve/v1/session/wrun_A/stubs",
    "eve/v1/session/wrun_A/descendants/stream",
    "eve/v1/session/wrun_A/end/now",
    "eve/v1/session/wrun_A/ending",
    "eve/v1/info",
    "eve/v1/callback/token",
    "eve/v1/connections/x/callback/a/b",
  ])("refuses a route of the agent the chat has no use for (%j)", async (path) => {
    for (const method of ["GET", "POST"]) {
      const d = deps();
      const request = new Request(`https://console.example.invalid/api/chat/helper/${path}`, {
        method, headers: { cookie: `lares_session=abc; ${capability()}` }, ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect((await forwardChat(request, "helper", path, d)).status, method).toBe(404);
      expect(d.query).not.toHaveBeenCalled();
      expect(d.fetch).not.toHaveBeenCalled();
    }
  });

  it.each([
    "eve/v1/mcp",
    "eve/v1/events",
    "eve/v1/connect",
    "eve/v1/dev/runtime-artifacts",
    "eve/v1/session/wrun_A/subagents/c/child/stream",
    "eve/v1/session/../../v1/mcp",
    "../eve/v1/session",
    "eve/v1/session/wrun_A/stream/..",
  ])("does not relay the rest of the agent (%j)", async (path) => {
    const d = deps();
    expect((await forwardChat(post(), "helper", path, d)).status).toBe(404);
    expect(d.query).not.toHaveBeenCalled();
  });

  it("says so plainly when no route password is mounted, and does not call the agent", async () => {
    const d = deps(row, null);
    const response = await forwardChat(post(), "helper", "eve/v1/session", d);
    expect(response.status).toBe(503);
    expect(await response.text()).toMatch(/route password/i);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("bounds what a browser may push through it", async () => {
    const d = deps();
    expect((await forwardChat(post("x".repeat(262145)), "helper", "eve/v1/session", d)).status).toBe(413);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("uses the username the agent's own door answers to", () => {
    // The role's door is the source of truth. The console cannot import a service, so the
    // name is mirrored here and this reads the door's own source as text — the same reason and the
    // same method as tests/engine-drift.test.ts.
    const door = readFileSync(
      new URL("../../chief-of-staff/agent/channels/eve.ts", import.meta.url),
      "utf8",
    );
    expect(door).toMatch(new RegExp(`ROUTE_USERNAME\\s*=\\s*"${ROUTE_USERNAME}"`));
  });
});

/**
 * Who the agent is told it is acting for.
 *
 * The trust boundary, in two sentences, because it is the thing these tests are really about: the
 * agent believes this header ONLY because the same request carries the route password, so anything
 * holding that password can claim to be any member. What the console must therefore guarantee is
 * narrower and entirely checkable here — the value it sends is the one the SERVER verified from
 * the session cookie, and never one the browser supplied.
 */
describe("the member the console vouches for", () => {
  const forge = (member: string) =>
    new Request("https://console.example.invalid/api/chat/helper/eve/v1/session", {
      method: "POST",
      body: '{"message":"hello"}',
      headers: {
        "content-type": "application/json",
        cookie: "lares_session=abc",
        [MEMBER_HEADER]: member,
        "x-forwarded-user": member,
      },
    });

  it("names the signed-in member on the forwarded request", async () => {
    const d = deps();
    await forwardChat(post(), "helper", "eve/v1/session", d);
    const headers = d.fetch.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get(MEMBER_HEADER)).toBeNull();
    expect(headers.get("x-lares-member-id")).toBe("Owner-ID");
  });

  it("throws the browser's own copy away and sends the verified one instead", async () => {
    const d = deps();
    await forwardChat(forge("attacker@example.invalid"), "helper", "eve/v1/session", d);
    const headers = d.fetch.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get(MEMBER_HEADER)).toBeNull();
    expect(headers.get("x-lares-member-id")).toBe("Owner-ID");
    expect(headers.get("x-lares-member-id")).not.toContain("attacker");
    // Deny-by-default: no header the browser invented is relayed under any name.
    expect(headers.has("x-forwarded-user")).toBe(false);
  });

  it("vouches for nobody when nobody is signed in", async () => {
    const d = deps(row, PASSWORD, null);
    expect((await forwardChat(forge("attacker@example.invalid"), "helper", "eve/v1/session", d)).status).toBe(401);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("uses the verified opaque member even when no usable address exists",async()=>{
    const d=deps(row,PASSWORD,'not-an-address');
    expect((await forwardChat(post(),'helper','eve/v1/session',d)).status).toBe(200);
    const headers=d.fetch.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('x-lares-member-id')).toBe('Other-ID');expect(headers.get(MEMBER_HEADER)).toBeNull();
  });

  it("is answered on a POST only — a cross-site GET cannot reach the answer path at all", async () => {
    // Answering a card is `POST eve/v1/session/<id>` with `answers`. A cross-site <img> or
    // a link is a GET, and the allow-list has no GET rule for that path, so it never becomes a
    // request at all — before SameSite=Lax is even reached.
    const d = deps();
    const get = new Request("https://console.example.invalid/api/chat/helper/eve/v1/session/wrun_A", { method: "GET" });
    expect((await forwardChat(get, "helper", "eve/v1/session/wrun_A", d)).status).toBe(404);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("uses the header name the agent's own door reads", () => {
    // Same reason and same method as the ROUTE_USERNAME check above: the console cannot import a
    // service, so both doors' sources are read as text.
    for (const role of ["chief-of-staff", "creative"]) {
      const door = readFileSync(new URL(`../../${role}/agent/channels/eve.ts`, import.meta.url), "utf8");
      expect(door, role).toMatch(new RegExp(`MEMBER_HEADER\\s*=\\s*"${MEMBER_HEADER}"`));
      // And it is read only after the credential has been verified — the header appears inside the
      // `result.ok` branch, never before it.
      expect(door, role).toMatch(/if \(result\.ok\) \{\s+const legacy = withConsoleMember\(result\.sessionAuth, request\.headers\.get\(MEMBER_HEADER\)\)/);
    }
  });
});


describe("stable console session binding", () => {
  it("drops forged stable member, nonce and purpose headers and binds before issuing capability", async () => {
    const d = deps();
    const request = post();
    request.headers.set("x-lares-member-id","attacker");
    request.headers.set("x-lares-admission","forged");
    request.headers.set("x-lares-purpose","resolver");
    const response = await forwardChat(request,"helper","eve/v1/session",d);
    expect(response.status).toBe(200);
    const headers = d.fetch.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get("x-lares-member-id")).toBe("Owner-ID");
    expect(headers.get("x-lares-admission")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(headers.get("x-lares-purpose")).toBe("human");
    expect(d.query.mock.calls.some(([sql])=>sql.includes("INSERT INTO console_session_bindings"))).toBe(true);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });
  it("message-free creates bind the returned ID; storage failure issues no capability", async () => {
    const d = deps();
    expect((await forwardChat(post('{}'),"helper","eve/v1/session",d)).headers.get("set-cookie")).toContain("HttpOnly");
    const query=d.query.getMockImplementation()!;d.query.mockImplementation(async(sql,values)=>{if(sql.includes("console_session_bindings"))throw new Error("binding unavailable");return query(sql,values);});
    const response = await forwardChat(post('{}'),"helper","eve/v1/session",d);
    expect(response.status).toBe(502);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it("rejects mixed messages and approval replies; approval-only replies carry resolver purpose", async () => {
    const d = deps();
    const path = "eve/v1/session/wrun_A";
    const mixed = sessionRequest(path,"POST");
    const request = new Request(mixed.url,{method:"POST",headers:mixed.headers,body:JSON.stringify({message:"hello",answers:[{interactionId:"fixture-card",optionId:"approve"}]})});
    expect((await forwardChat(request,"helper",path,d)).status).toBe(400);
    expect(d.fetch).not.toHaveBeenCalled();
    const resolver = new Request(mixed.url,{method:"POST",headers:mixed.headers,body:JSON.stringify({answers:[{interactionId:"fixture-card",optionId:"approve"}]})});
    expect((await forwardChat(resolver,"helper",path,d)).status).toBe(200);
    expect((d.fetch.mock.calls[0]![1]!.headers as Headers).get("x-lares-purpose")).toBe("resolver");
  });
  it("rechecks bindings before every stream and control operation", async () => {
    for(const suffix of ["stream","cancel","clear","compact","end","reset"]){
      const d = deps();
      const query=d.query.getMockImplementation()!;d.query.mockImplementation(async(sql,values)=>sql.includes("console_session_bindings")?{rows:[]}:query(sql,values));
      const path = `eve/v1/session/wrun_A/${suffix}`;
      const response = await forwardChat(sessionRequest(path,suffix==="stream"?"GET":"POST"),"helper",path,d);
      expect(response.status).toBe(410);
      expect(await response.text()).toBe("This conversation is no longer available. Start a new one.");
      expect(d.fetch).not.toHaveBeenCalled();
    }
  });
  it("tells a member that a conversation ended by a save to the agent has ended, for a message and for an answer", async () => {
    // Saving a change to a running agent ends its open conversations (the binding is revoked). What the
    // member writes next, a message or an answer to a card still on the screen, gets the plain sentence and
    // reaches nothing.
    for (const body of ['{"message":"hello"}', '{"responses":[{"interactionId":"request-1","optionId":"approve"}]}']) {
      const d = deps();
      const query=d.query.getMockImplementation()!;d.query.mockImplementation(async(sql,values)=>sql.includes("console_session_bindings")?{rows:[]}:query(sql,values));
      const request = new Request("https://console.example.invalid/api/chat/helper/eve/v1/session/wrun_A", {
        method: "POST", body, headers: { "content-type": "application/json", cookie: `lares_session=abc; ${capability()}` } });
      const response = await forwardChat(request, "helper", "eve/v1/session/wrun_A", d);
      expect(response.status).toBe(410);
      expect(response.headers.get("x-lares-console-refusal")).toBe("1");
      expect(await response.text()).toBe("This conversation is no longer available. Start a new one.");
      expect(d.fetch).not.toHaveBeenCalled();
    }
  });
  it("stable member capability IDs remain case-sensitive", async () => {
    const d=deps();
    d.signedInMember.mockResolvedValue({id:"owner-id",organisationId:"org",role:"owner",status:"active",automationMode:"draft-and-ask"});
    const path="eve/v1/session/wrun_A/stream";
    expect((await forwardChat(sessionRequest(path),"helper",path,d)).status).toBe(403);
  });
});

it('refuses callback destinations, observers, unknown fields and attachments before an upstream call',async()=>{
 for(const payload of [{message:'hello',callback:{url:'https://example.invalid/output'}},{message:'hello',activityObserver:{}},{message:'hello',clientContext:'injected'},{message:'hello',mode:'task'},{message:'hello',outputSchema:{}},{message:'hello',unknown:true},{message:[{type:'file',mediaType:'text/plain',data:'https://example.invalid/file'}]}]){
  const d=deps();expect((await forwardChat(post(JSON.stringify(payload)),'helper','eve/v1/session',d)).status).toBe(400);expect(d.fetch).not.toHaveBeenCalled();
 }
});

/**
 * Answering a card. The body is the framework client's own: `{ answers: [{ interactionId,
 * optionId }] }`, with `optionId` "approve" or "deny". The proxy reads it — to decide the purpose
 * it vouches for, and to name the card in the model-resume capsule — and relays the bytes untouched.
 */
describe("an answer to a card", () => {
  const PATH = "eve/v1/session/wrun_A";
  const answer = (body: unknown, cookie = capability()) =>
    new Request(`https://console.example.invalid/api/chat/helper/${PATH}`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", cookie: `lares_session=abc; ${cookie}` },
    });

  it.each(["approve", "deny"] as const)("relays %s exactly as sent, under the resolver purpose", async (optionId) => {
    const d = deps();
    const raw = JSON.stringify({ answers: [{ interactionId: "int_A", optionId }] });
    expect((await forwardChat(answer(raw), "helper", PATH, d)).status).toBe(200);
    const [url, init] = d.fetch.mock.calls[0]!;
    expect(url).toBe("http://172.29.0.10:3000/eve/v1/session/wrun_A");
    expect(Buffer.from(init!.body as Uint8Array).toString("utf8")).toBe(raw);
    expect((init!.headers as Headers).get("x-lares-purpose")).toBe("resolver");
    // An answer is not a human message: it never carries the private Vault reader's capsule.
    expect((init!.headers as Headers).has("x-lares-vault-capsule")).toBe(false);
  });

  it("names the card by its interaction id in the model-resume capsule, with the same decision the body carries", async () => {
    modelPurpose.configured.mockReturnValue(true);
    for (const [optionId, capsuleOption] of [["approve", "approve"], ["deny", "deny"]] as const) {
      // Two separate cards that share an id; the proxy would otherwise take the second for a repeat.
      resetAnswerClaimsForTests();
      modelPurpose.sign.mockClear();
      const d = deps();
      expect((await forwardChat(answer({ answers: [{ interactionId: "int_A", optionId }] }), "helper", PATH, d)).status).toBe(200);
      expect(modelPurpose.sign).toHaveBeenCalledOnce();
      expect(modelPurpose.sign).toHaveBeenCalledWith(expect.objectContaining({
        session: "wrun_A", method: "POST", path: "/eve/v1/session/wrun_A", purpose: "resume",
        // The capsule keeps its own key for the card, `requestId`; the value is the interaction id.
        // The agent refuses a capsule whose two values are not exactly the body's.
        resume: { requestId: "int_A", optionId: capsuleOption },
      }));
      const headers = d.fetch.mock.calls[0]![1]!.headers as Headers;
      expect(headers.get("x-lares-model-capsule")).toBe("signed-model-capsule");
      expect(headers.get("x-lares-model-purpose-required")).toBe("1");
    }
  });

  it("refuses the answer, and calls nobody, when the capsule cannot be signed", async () => {
    modelPurpose.configured.mockReturnValue(true);
    modelPurpose.sign.mockRejectedValueOnce(new Error("signer down"));
    const d = deps();
    expect((await forwardChat(answer({ answers: [{ interactionId: "int_A", optionId: "approve" }] }), "helper", PATH, d)).status).toBe(503);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("carries a card a sub-agent relayed, whose id names the child conversation", async () => {
    const d = deps();
    expect((await forwardChat(answer({ answers: [{ interactionId: "wrun_child/int_B", optionId: "deny" }] }), "helper", PATH, d)).status).toBe(200);
  });

  it.each([
    ["the older answer field", { inputResponses: [{ requestId: "int_A", optionId: "approve" }] }],
    ["the older word for declining", { answers: [{ interactionId: "int_A", optionId: "cancel" }] }],
    ["an option that is neither", { answers: [{ interactionId: "int_A", optionId: "always-allow" }] }],
    ["no option", { answers: [{ interactionId: "int_A" }] }],
    ["free text in place of an option", { answers: [{ interactionId: "int_A", text: "yes do it" }] }],
    ["free text beside an option", { answers: [{ interactionId: "int_A", optionId: "approve", text: "and more" }] }],
    ["an extra field", { answers: [{ interactionId: "int_A", optionId: "approve", requestId: "int_A" }] }],
    ["two answers at once", { answers: [{ interactionId: "int_A", optionId: "approve" }, { interactionId: "int_B", optionId: "approve" }] }],
    ["no answer", { answers: [] }],
    ["an answer that is not a list", { answers: { interactionId: "int_A", optionId: "approve" } }],
    ["no card named", { answers: [{ optionId: "approve" }] }],
    ["an empty card id", { answers: [{ interactionId: "", optionId: "approve" }] }],
    ["a card id that is not an id", { answers: [{ interactionId: "int A\n", optionId: "approve" }] }],
    ["a card id that is not text", { answers: [{ interactionId: 7, optionId: "approve" }] }],
    ["an answer with a message", { message: "hello", answers: [{ interactionId: "int_A", optionId: "approve" }] }],
    ["nothing at all", {}],
    ["an unknown top-level field", { answers: [{ interactionId: "int_A", optionId: "approve" }], turnPolicy: "steer" }],
  ])("refuses %s before any upstream call", async (_name, body) => {
    const d = deps();
    const response = await forwardChat(answer(body), "helper", PATH, d);
    expect(response.status).toBe(400);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(modelPurpose.sign).not.toHaveBeenCalled();
  });

  it.each([
    ["the older answer field", { inputResponses: [{ requestId: "int_A", optionId: "approve" }] }],
    ["the older word for declining", { answers: [{ interactionId: "int_A", optionId: "cancel" }] }],
    ["an option that is neither", { answers: [{ interactionId: "int_A", optionId: "always-allow" }] }],
    ["no option", { answers: [{ interactionId: "int_A" }] }],
    ["free text beside an option", { answers: [{ interactionId: "int_A", optionId: "approve", text: "and more" }] }],
    ["an extra field", { answers: [{ interactionId: "int_A", optionId: "approve", requestId: "int_A" }] }],
    ["two answers at once", { answers: [{ interactionId: "int_A", optionId: "approve" }, { interactionId: "int_B", optionId: "approve" }] }],
    ["no answer", { answers: [] }],
    ["an answer that is not a list", { answers: { interactionId: "int_A", optionId: "approve" } }],
    ["an empty card id", { answers: [{ interactionId: "", optionId: "approve" }] }],
    ["a card id that is not an id", { answers: [{ interactionId: "int A\n", optionId: "approve" }] }],
    ["a card id that is not text", { answers: [{ interactionId: 7, optionId: "approve" }] }],
    ["an answer with a message", { message: "hello", answers: [{ interactionId: "int_A", optionId: "approve" }] }],
    ["neither a message nor an answer", { somethingElse: true }],
  ])("refuses %s by its OWN reading, even if the envelope check let it through", async (_name, body) => {
    // The envelope check is taken out of the way, so what refuses here is this proxy alone. Its
    // reading of an answer must not lean on another module having looked first.
    envelope.check = () => {};
    for (const signing of [false, true]) {
      modelPurpose.configured.mockReturnValue(signing);
      const d = deps();
      const response = await forwardChat(answer(body), "helper", PATH, d);
      expect(response.status, String(signing)).toBe(400);
      expect(d.fetch).not.toHaveBeenCalled();
      expect(modelPurpose.sign).not.toHaveBeenCalled();
    }
  });

  it("refuses an answer sent to the create route: a card belongs to a conversation", async () => {
    const d = deps();
    const request = new Request("https://console.example.invalid/api/chat/helper/eve/v1/session", {
      method: "POST", body: JSON.stringify({ answers: [{ interactionId: "int_A", optionId: "approve" }] }), headers: { cookie: "lares_session=abc" },
    });
    expect((await forwardChat(request, "helper", "eve/v1/session", d)).status).toBe(400);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("drops the inbox the framework's client adds by itself: it never leaves the console", async () => {
    modelPurpose.configured.mockReturnValue(true);
    for (const [raw, sent] of [
      ['{"message":"second message","inbox":"v1.b3BhcXVl.c2ln"}', '{"message":"second message"}'],
      ['{"answers":[{"interactionId":"int_A","optionId":"approve"}],"inbox":"v1.b3BhcXVl.c2ln"}', '{"answers":[{"interactionId":"int_A","optionId":"approve"}]}'],
      // Whatever it holds: it is dropped unread, not validated.
      ['{"inbox":{"not":"a string"},"message":"third"}', '{"message":"third"}'],
    ] as const) {
      const d = deps();
      envelope.seen.length = 0;
      expect((await forwardChat(answer(raw), "helper", PATH, d)).status, raw).toBe(200);
      expect(Buffer.from(d.fetch.mock.calls[0]![1]!.body as Uint8Array).toString("utf8")).toBe(sent);
      // The envelope check is shown what is SENT, not what arrived.
      expect(envelope.seen.map((seen) => JSON.stringify(seen.payload))).toEqual([sent]);
    }
  });

  it("sends its own rebuilt body, not the browser's bytes — and signs exactly what it sends", async () => {
    modelPurpose.configured.mockReturnValue(true);
    const d = deps();
    // The same message, written the way no client library writes it.
    const raw = '{ "inbox" : "x",\n  "message" : "spaced out" }';
    expect((await forwardChat(answer(raw), "helper", PATH, d)).status).toBe(200);
    const sent = d.fetch.mock.calls[0]![1]!.body as Uint8Array;
    expect(Buffer.from(sent).toString("utf8")).toBe('{"message":"spaced out"}');
    // The model capsule is asked for with a hash made over the outgoing bytes (the hash function
    // is stubbed here; what matters is which bytes it was given).
    expect(modelPurpose.hashed.map((bytes) => Buffer.from(bytes).toString("utf8"))).toEqual(['{"message":"spaced out"}']);
  });
});

/**
 * A second answer to a card that is already settled: a double click, a second tab, an old tab, or
 * a request sent again. eve turns an answer to a card that is no longer waiting into a new
 * message and opens a new turn under the answer's identity, which the agent then refuses, and the
 * page shows a dead conversation. The console refuses it first, from the card's own record
 * (`approval_asks`, which the agent writes when it takes and settles an answer).
 */
describe("a second answer to a card that is already settled", () => {
  const PATH = "eve/v1/session/wrun_A";
  const NOT_WAITING = "This request is no longer waiting, so this answer was not used.";
  const answer = (optionId: "approve" | "deny" = "approve", interactionId = "int_A") =>
    new Request(`https://console.example.invalid/api/chat/helper/${PATH}`, {
      method: "POST",
      body: JSON.stringify({ answers: [{ interactionId, optionId }] }),
      headers: { "content-type": "application/json", cookie: `lares_session=abc; ${capability()}` },
    });
  type Card = { outcome: string | null; used_at: Date | null };
  /** The card's record as the agent keeps it, found only by its own coordinates. By default the
   *  agent takes an answer and settles the card, as its response policy does. */
  const recorded = (initial: Card | null = { outcome: null, used_at: null }) => {
    const d = deps();
    const card = { current: initial, asked: [] as unknown[][] };
    const query = d.query.getMockImplementation()!;
    d.query.mockImplementation(async (sql, values) => {
      if (!sql.includes("FROM approval_asks")) return query(sql, values);
      card.asked.push(values);
      const mine = values.join("|") === ["int_A", "helper", "wrun_A", "Owner-ID"].join("|");
      return { rows: mine && card.current ? [card.current] : [] };
    });
    d.fetch.mockImplementation(async () => {
      card.current = { outcome: "approved", used_at: null };
      return new Response('{"ok":true,"status":"accepted"}', { status: 202, headers: { "content-type": "application/json" } });
    });
    return { d, card };
  };

  it.each([["approve", "approve"], ["approve", "deny"], ["deny", "approve"], ["deny", "deny"]] as const)(
    "%s, then %s: the first goes on as today; the second is refused before the agent, in one sentence",
    async (first, second) => {
      modelPurpose.configured.mockReturnValue(true);
      const { d } = recorded();
      expect((await forwardChat(answer(first), "helper", PATH, d)).status).toBe(202);
      expect(d.fetch).toHaveBeenCalledOnce();
      expect(modelPurpose.sign).toHaveBeenCalledOnce();
      const again = await forwardChat(answer(second), "helper", PATH, d);
      expect(again.status).toBe(409);
      expect(await again.text()).toBe(NOT_WAITING);
      expect(again.headers.get("x-lares-console-refusal")).toBe("1");
      // Nothing reached the agent, and no model or budget authority was asked for it.
      expect(d.fetch).toHaveBeenCalledOnce();
      expect(modelPurpose.sign).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["approved", { outcome: "approved", used_at: null }],
    ["approved and carried out", { outcome: "approved", used_at: new Date() }],
    ["denied", { outcome: "cancelled", used_at: null }],
    ["closed with nobody deciding", { outcome: "ignored", used_at: null }],
    ["refused as invalid", { outcome: "invalid", used_at: null }],
    ["expired", { outcome: "expired", used_at: null }],
    ["changed after it was asked", { outcome: "payload-changed", used_at: null }],
  ])("a card recorded as %s takes no answer: nothing is signed or sent", async (_name, settled) => {
    modelPurpose.configured.mockReturnValue(true);
    for (const optionId of ["approve", "deny"] as const) {
      const { d } = recorded(settled);
      const response = await forwardChat(answer(optionId), "helper", PATH, d);
      expect(response.status, optionId).toBe(409);
      expect(await response.text()).toBe(NOT_WAITING);
      expect(d.fetch).not.toHaveBeenCalled();
    }
    expect(modelPurpose.sign).not.toHaveBeenCalled();
  });

  it("looks the card up by its own coordinates: this agent, this conversation, this member", async () => {
    const { d, card } = recorded();
    expect((await forwardChat(answer(), "helper", PATH, d)).status).toBe(202);
    expect(card.asked).toEqual([["int_A", "helper", "wrun_A", "Owner-ID"]]);
  });

  it("fails closed: a card with no record of its own, or a record that cannot be read, is not answered", async () => {
    const unknown = recorded(null);
    const response = await forwardChat(answer(), "helper", PATH, unknown.d);
    expect(response.status).toBe(409);
    expect(await response.text()).toBe(NOT_WAITING);
    // Another conversation's card of the same id is not this one.
    const elsewhere = recorded();
    expect((await forwardChat(answer("approve", "int_B"), "helper", PATH, elsewhere.d)).status).toBe(409);
    const unreadable = recorded();
    const query = unreadable.d.query.getMockImplementation()!;
    unreadable.d.query.mockImplementation(async (sql, values) => {
      if (sql.includes("FROM approval_asks")) throw new Error("database unavailable");
      return query(sql, values);
    });
    const failed = await forwardChat(answer(), "helper", PATH, unreadable.d);
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe("I could not check that request just now. Nothing was done. Try again in a moment.");
    for (const d of [unknown.d, elsewhere.d, unreadable.d]) expect(d.fetch).not.toHaveBeenCalled();
    expect(modelPurpose.sign).not.toHaveBeenCalled();
  });

  it("a double click: two answers at the same moment, before the agent has settled the card — exactly one goes on", async () => {
    const { d, card } = recorded();
    let accept!: () => void;
    d.fetch.mockImplementation(() => new Promise<Response>((resolve) => {
      // The agent takes the delivery at once and settles the card on its next step, after both
      // requests have read the record as still waiting.
      accept = () => resolve(new Response('{"ok":true}', { status: 202, headers: { "content-type": "application/json" } }));
    }));
    const both = [forwardChat(answer("approve"), "helper", PATH, d), forwardChat(answer("approve"), "helper", PATH, d)];
    await vi.waitFor(() => expect(d.fetch).toHaveBeenCalled());
    accept();
    const statuses = (await Promise.all(both)).map((response) => response.status).sort();
    expect(statuses).toEqual([202, 409]);
    expect(d.fetch).toHaveBeenCalledOnce();
    // Still nothing more once the record says waiting no longer... and before it does.
    expect(card.current).toEqual({ outcome: null, used_at: null });
    expect((await forwardChat(answer("deny"), "helper", PATH, d)).status).toBe(409);
    expect(d.fetch).toHaveBeenCalledOnce();
  });

  it("an answer that never reached the agent may be sent again", async () => {
    for (const lost of [
      async () => { throw new TypeError("connection refused"); },
      async () => new Response('{"ok":false,"code":"session_not_ready"}', { status: 409, headers: { "content-type": "application/json" } }),
      async () => new Response("", { status: 401 }),
    ]) {
      resetAnswerClaimsForTests();
      const { d } = recorded();
      d.fetch.mockImplementationOnce(lost);
      expect((await forwardChat(answer(), "helper", PATH, d)).ok).toBe(false);
      expect((await forwardChat(answer(), "helper", PATH, d)).status).toBe(202);
      expect(d.fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("after a refused second answer, the person's next message in the same conversation goes on", async () => {
    const { d } = recorded();
    expect((await forwardChat(answer(), "helper", PATH, d)).status).toBe(202);
    expect((await forwardChat(answer(), "helper", PATH, d)).status).toBe(409);
    const message = new Request(`https://console.example.invalid/api/chat/helper/${PATH}`, {
      method: "POST", body: '{"message":"what happened?"}', headers: { cookie: `lares_session=abc; ${capability()}` },
    });
    expect((await forwardChat(message, "helper", PATH, d)).status).toBe(202);
    expect(d.fetch).toHaveBeenCalledTimes(2);
    expect(Buffer.from(d.fetch.mock.calls[1]![1]!.body as Uint8Array).toString("utf8")).toBe('{"message":"what happened?"}');
    expect((d.fetch.mock.calls[1]![1]!.headers as Headers).get("x-lares-purpose")).toBe("human");
  });

  it("a message is not an answer: it reads no card record", async () => {
    const { d, card } = recorded();
    const message = new Request(`https://console.example.invalid/api/chat/helper/${PATH}`, {
      method: "POST", body: '{"message":"hello"}', headers: { cookie: `lares_session=abc; ${capability()}` },
    });
    expect((await forwardChat(message, "helper", PATH, d)).status).toBe(202);
    expect(card.asked).toEqual([]);
  });
});

/**
 * Who may talk to an agent, and into whose conversation. Exercised with the paths and bodies the
 * new client sends, through the proxy's own checks (the agent kit's use and binding checks, and
 * this proxy's signed conversation cookie).
 */
describe("a member who is not the conversation's own", () => {
  const PATH = "eve/v1/session/wrun_A";
  const APPROVE_BODY = JSON.stringify({ answers: [{ interactionId: "int_A", optionId: "approve" }] });
  const requests = (cookie: string): [string, Request][] => [
    [PATH, new Request(`https://console.example.invalid/api/chat/helper/${PATH}`, { method: "POST", body: APPROVE_BODY, headers: { cookie: `lares_session=abc; ${cookie}` } })],
    [PATH, new Request(`https://console.example.invalid/api/chat/helper/${PATH}`, { method: "POST", body: '{"message":"hello"}', headers: { cookie: `lares_session=abc; ${cookie}` } })],
    [`${PATH}/stream`, new Request(`https://console.example.invalid/api/chat/helper/${PATH}/stream?includeTailIndex=1`, { headers: { cookie: `lares_session=abc; ${cookie}` } })],
    [`${PATH}/end`, new Request(`https://console.example.invalid/api/chat/helper/${PATH}/end`, { method: "POST", body: "{}", headers: { cookie: `lares_session=abc; ${cookie}` } })],
    ["eve/v1/session", new Request("https://console.example.invalid/api/chat/helper/eve/v1/session", { method: "POST", headers: { cookie: `lares_session=abc; ${cookie}` } })],
  ];

  it("refuses every chat request for an agent the signed-in member may not use, before anything is read", async () => {
    for (const [path, request] of requests(capability())) {
      const d = deps();
      access.captureUse.mockResolvedValueOnce(undefined as never);
      const response = await forwardChat(request, "helper", path, d);
      expect(response.status, path).toBe(403);
      expect(await response.text()).toContain("Conversation access is unavailable");
      expect(d.query.mock.calls.some(([sql]) => sql.includes("FROM agent_resources"))).toBe(false);
      expect(d.routePassword).not.toHaveBeenCalled();
      expect(d.fetch).not.toHaveBeenCalled();
      expect(modelPurpose.sign).not.toHaveBeenCalled();
    }
  });

  it("refuses an answer posted into a conversation bound to another member, even with that member's cookie", async () => {
    // The other member is signed in and may use the agent, and presents the OWNER's conversation
    // cookie (copied, say). The cookie is signed for the owner's id, so it does not fit.
    const d = deps(row, PASSWORD, "other@example.invalid");
    for (const [path, request] of requests(capability("Owner-ID")).slice(0, 4)) {
      const response = await forwardChat(request, "helper", path, d);
      expect(response.status, path).toBe(403);
      expect(await response.text()).toBe("This conversation is not available to this signed-in member.");
    }
    expect(d.fetch).not.toHaveBeenCalled();
    expect(modelPurpose.sign).not.toHaveBeenCalled();
  });

  it("refuses it when the console's own record binds the conversation to someone else", async () => {
    // The other member even holds a cookie signed for THEIR id; the binding the console stored
    // when the conversation was created names the owner, so the kit's check finds none for them.
    const d = deps(row, PASSWORD, "other@example.invalid");
    const query = d.query.getMockImplementation()!;
    d.query.mockImplementation(async (sql, values) => sql.includes("console_session_bindings") && values[3] !== "Owner-ID" ? { rows: [] } : query(sql, values));
    for (const [path, request] of requests(capability("Other-ID")).slice(0, 4)) {
      const response = await forwardChat(request, "helper", path, d);
      expect(response.ok, path).toBe(false);
      // The same sentence as for an ended conversation: true here too, and it says nothing about the owner's.
      expect(response.status, path).toBe(410);
      expect(await response.text()).toBe("This conversation is no longer available. Start a new one.");
    }
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.routePassword).not.toHaveBeenCalled();
    expect(modelPurpose.sign).not.toHaveBeenCalled();
  });

  it("the owner, with the owner's cookie, is let through — so the refusals above are about who, not what", async () => {
    for (const [path, request] of requests(capability())) {
      const d = deps();
      expect((await forwardChat(request, "helper", path, d)).status, path).toBe(200);
      expect(d.fetch).toHaveBeenCalledOnce();
    }
  });
});

/**
 * A conversation the agent's framework has ended. The agent answers with a status and a JSON code;
 * the proxy must hand both back untouched, because the page words the ending from that code.
 */
describe("a conversation the agent has ended", () => {
  const PATH = "eve/v1/session/wrun_A";
  it.each([
    ["ended by an update", { code: "session_stranded", error: "This session is no longer available.", ok: false, eveVersion: "0.60.1" }],
    ["ended otherwise", { ok: false, code: "session_not_active", error: "The session is no longer active." }],
  ])("%s: the refusal reaches the browser with its status and code, and nothing is retried", async (_name, refusal) => {
    for (const [path, init] of [
      [PATH, { method: "POST", body: '{"message":"hello"}' }],
      [PATH, { method: "POST", body: JSON.stringify({ answers: [{ interactionId: "int_A", optionId: "approve" }] }) }],
      [`${PATH}/stream`, {}],
    ] as const) {
      const d = deps();
      d.fetch.mockResolvedValue(new Response(JSON.stringify(refusal), { status: 409, headers: { "content-type": "application/json", "cache-control": "no-store" } }));
      const response = await forwardChat(new Request(`https://console.example.invalid/api/chat/helper/${path}`, { ...init, headers: { cookie: `lares_session=abc; ${capability()}` } }), "helper", path, d);
      expect(response.status).toBe(409);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual(refusal);
      expect(d.fetch).toHaveBeenCalledOnce();
    }
  });
});

it("runs against the agent kit's own envelope check, which refuses a field it does not list", async () => {
  // Earlier, while the kit on this branch still expected the older bodies, these tests used a
  // stand-in for its check and printed which one they ran against. There is no stand-in any more.
  // This is that line as an assertion: the check the proxy calls is the kit's real one, and it
  // is the strict one — so a body the proxy sends on has passed the same lists the agent applies.
  const kit = await vi.importActual<typeof import("@lares/agent-kit/private-console-envelope")>("@lares/agent-kit/private-console-envelope");
  const takes = (payload: unknown, path: string) => { try { kit.assertPrivateConsoleEnvelope(payload, path); return true; } catch { return false; } };
  const PATH = "/eve/v1/session/wrun_A";
  expect(takes({ message: "x" }, PATH)).toBe(true);
  expect(takes({ answers: [{ interactionId: "int_A", optionId: "deny" }] }, PATH)).toBe(true);
  expect(takes({ reason: "done" }, `${PATH}/end`)).toBe(true);
  for (const refused of [
    { message: "x", inbox: "opaque" },
    { message: "x", turnPolicy: "steer" },
    { answers: [{ interactionId: "int_A", optionId: "cancel" }] },
    { answers: [{ interactionId: "int_A", optionId: "approve", text: "t" }] },
    { inputResponses: [{ requestId: "int_A", optionId: "approve" }] },
  ]) expect(takes(refused, PATH), JSON.stringify(refused)).toBe(false);
  expect(takes({ turnId: null }, `${PATH}/cancel`)).toBe(false);
  // And with nothing overriding it, a request through the proxy is shown to that same check.
  expect(envelope.check).toBeUndefined();
  const d = deps();
  expect((await forwardChat(sessionRequest("eve/v1/session/wrun_A", "POST"), "helper", "eve/v1/session/wrun_A", d)).status).toBe(200);
  expect(envelope.seen).toEqual([{ payload: { message: "hello" }, path: PATH }]);
});

/**
 * THE WHOLE OUTGOING SURFACE, driven by the framework's OWN client.
 *
 * Nothing here is written by hand: the framework's shipped `Client` makes every request the chat
 * page can cause, each goes through `forwardChat`, and a stand-in agent records the body that
 * reaches it. The agent refuses any field it does not list, so every recorded body must be one of
 * the listed shapes exactly. If a later client library adds a field of its own — as this one adds
 * `inbox` — this fails: either the proxy refuses the send (the call throws), or an unlisted field
 * shows up in what was recorded.
 */
describe("what leaves the console when the framework's own client talks through it", () => {
  const BASE = "https://console.example.invalid/api/chat/helper";
  type Sent = { path: string; raw: string; body: unknown; purpose: string | null };

  async function drive(run: (client: InstanceType<typeof import("eve/client").Client>, seen: { fromBrowser: Sent[]; toAgent: Sent[] }) => Promise<void>) {
    const { Client } = await import("eve/client");
    const d = deps();
    const seen = { fromBrowser: [] as Sent[], toAgent: [] as Sent[] };
    let delivery = 0;
    // The agent: accepts, and — like an agent set up to issue them — hands back an `inbox`.
    d.fetch.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const raw = init?.body === undefined ? "" : Buffer.from(init.body as Uint8Array).toString("utf8");
      seen.toAgent.push({ path, raw, body: raw === "" ? undefined : JSON.parse(raw), purpose: new Headers(init?.headers).get("x-lares-purpose") });
      const answer = path === "/eve/v1/session"
        ? { ok: true, sessionId: "wrun_A" }
        : { ok: true, sessionId: "wrun_A", deliveryId: `dlv_${++delivery}`, inbox: "v1.aW5ib3g.c2lnbmF0dXJl" };
      return new Response(JSON.stringify(answer), { status: 202, headers: { "content-type": "application/json", "x-eve-session-id": "wrun_A" } });
    });
    // The browser: the client's requests, with the cookies a browser would send back.
    const cookies = new Map<string, string>([["lares_session", "abc"]]);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.href.startsWith(`${BASE}/`)).toBe(true);
      const path = url.pathname.slice("/api/chat/helper/".length);
      const raw = typeof init?.body === "string" ? init.body : "";
      seen.fromBrowser.push({ path: `/${path}`, raw, body: raw === "" ? undefined : JSON.parse(raw), purpose: null });
      const headers = new Headers(init?.headers);
      headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
      const response = await forwardChat(new Request(url, { method: init?.method ?? "GET", headers, ...(raw === "" ? {} : { body: raw }) }), "helper", path, d);
      const issued = response.headers.get("set-cookie")?.split(";")[0];
      if (issued) cookies.set(issued.slice(0, issued.indexOf("=")), issued.slice(issued.indexOf("=") + 1));
      return response;
    });
    try {
      await run(new Client({ baseUrl: BASE }), seen);
    } finally {
      vi.unstubAllGlobals();
    }
    return seen;
  }

  /** The agent's lists, as a table: every body it will take from the console, and no other. */
  function listed(sent: Sent): boolean {
    const exact = (...shapes: string[][]) => sent.body !== undefined && shapes.some((keys) => JSON.stringify(Object.keys(sent.body as object).sort()) === JSON.stringify([...keys].sort()));
    if (sent.path === "/eve/v1/session") return sent.raw === "" || exact([], ["message"], ["message", "operationId"]);
    if (sent.path === "/eve/v1/session/wrun_A") {
      if (exact(["message"])) return typeof (sent.body as { message: unknown }).message === "string";
      if (!exact(["answers"])) return false;
      const answers = (sent.body as { answers: unknown[] }).answers;
      return answers.length === 1 && JSON.stringify(Object.keys(answers[0] as object).sort()) === '["interactionId","optionId"]'
        && ["approve", "deny"].includes((answers[0] as { optionId: string }).optionId);
    }
    if (sent.path === "/eve/v1/session/wrun_A/cancel") return sent.raw === "" || exact([]) || (exact(["turnId"]) && typeof (sent.body as { turnId: unknown }).turnId === "string");
    if (/^\/eve\/v1\/session\/wrun_A\/(end|reset)$/.test(sent.path)) return sent.raw === "" || exact([], ["reason"]);
    if (/^\/eve\/v1\/session\/wrun_A\/(clear|compact)$/.test(sent.path)) return sent.raw === "" || exact([]);
    return false;
  }

  it("every body is one the agent lists, exactly — the client's own inbox included in what is stripped", async () => {
    const seen = await drive(async (client) => {
      const { session } = await client.sessions.create();            // what the page does first
      await session.send("first message");                           // the agent answers with an inbox
      await session.send("second message");                          // the client now adds it by itself
      await session.respond([{ interactionId: "int_A", optionId: "approve" }]);
      await session.respond([{ interactionId: "int_B", optionId: "deny" }]);
      await session.cancel({ turnId: "turn_1" });
      await session.cancel();                                        // no turn named
      await session.cancel({ turnId: null });                        // what the store sends with none running
      await session.clear();
      await session.compact();
      await session.end({ reason: "Conversation finished" });
      await session.end();
    });

    // The premise, checked: the client library really did add a field of its own on the way in.
    const withInbox = seen.fromBrowser.filter((sent) => sent.body !== undefined && "inbox" in (sent.body as object));
    expect(withInbox.map((sent) => sent.path)).toEqual(Array(3).fill("/eve/v1/session/wrun_A"));
    expect(seen.fromBrowser[2]!.body).toEqual({ message: "second message", inbox: "v1.aW5ib3g.c2lnbmF0dXJl" });
    // And that the client really does write a null turn id, which must not reach the agent.
    expect(seen.fromBrowser.filter((sent) => sent.path.endsWith("/cancel")).map((sent) => sent.raw)).toEqual(['{"turnId":"turn_1"}', "{}", '{"turnId":null}']);
    expect(seen.toAgent.some((sent) => sent.raw.includes("null"))).toBe(false);

    // What reached the agent: the exact bytes, in order.
    expect(seen.toAgent.map((sent) => [sent.path, sent.raw, sent.purpose])).toEqual([
      ["/eve/v1/session", "", "human"],
      ["/eve/v1/session/wrun_A", '{"message":"first message"}', "human"],
      ["/eve/v1/session/wrun_A", '{"message":"second message"}', "human"],
      ["/eve/v1/session/wrun_A", '{"answers":[{"interactionId":"int_A","optionId":"approve"}]}', "resolver"],
      ["/eve/v1/session/wrun_A", '{"answers":[{"interactionId":"int_B","optionId":"deny"}]}', "resolver"],
      ["/eve/v1/session/wrun_A/cancel", '{"turnId":"turn_1"}', "control"],
      ["/eve/v1/session/wrun_A/cancel", "{}", "control"],
      ["/eve/v1/session/wrun_A/cancel", "{}", "control"],
      ["/eve/v1/session/wrun_A/clear", "{}", "control"],
      ["/eve/v1/session/wrun_A/compact", "{}", "control"],
      ["/eve/v1/session/wrun_A/end", '{"reason":"Conversation finished"}', "control"],
      ["/eve/v1/session/wrun_A/end", "{}", "control"],
    ]);
    // And the rule itself, over everything recorded: no field outside the agent's lists, anywhere.
    for (const sent of seen.toAgent) expect(listed(sent), `${sent.path} ${sent.raw}`).toBe(true);
    expect(JSON.stringify(seen.toAgent)).not.toMatch(/inbox|idempotencyKey|clientContext|turnPolicy|inputResponses|requestId|"cancel"/);
  });

  it("the check above is not vacuous: it tells a listed body from one with a field added", () => {
    const sent = (path: string, body: unknown): Sent => ({ path, raw: JSON.stringify(body), body, purpose: null });
    expect(listed(sent("/eve/v1/session/wrun_A", { message: "x" }))).toBe(true);
    for (const extra of ["inbox", "idempotencyKey", "clientContext", "turnPolicy", "outputSchema", "callback", "anything"]) {
      expect(listed(sent("/eve/v1/session/wrun_A", { message: "x", [extra]: "y" })), extra).toBe(false);
      expect(listed(sent("/eve/v1/session/wrun_A", { answers: [{ interactionId: "i", optionId: "approve" }], [extra]: "y" })), extra).toBe(false);
    }
    expect(listed(sent("/eve/v1/session/wrun_A", { answers: [{ interactionId: "i", optionId: "approve", text: "t" }] }))).toBe(false);
    expect(listed(sent("/eve/v1/session/wrun_A", { answers: [{ interactionId: "i", optionId: "cancel" }] }))).toBe(false);
    expect(listed(sent("/eve/v1/session/wrun_A", { inputResponses: [{ requestId: "i", optionId: "approve" }] }))).toBe(false);
    expect(listed(sent("/eve/v1/session/wrun_A/end", { reason: "r", force: true }))).toBe(false);
    expect(listed(sent("/eve/v1/session/wrun_A/cancel", { turnId: null }))).toBe(false);
    expect(listed(sent("/eve/v1/session/wrun_A/cancel", { turnId: "t" }))).toBe(true);
    expect(listed(sent("/eve/v1/session/wrun_A/clear", { reason: "r" }))).toBe(false);
  });

  it.each([
    ["page context the client can attach to a turn", { clientContext: "the page says" }],
    ["a turn policy", { turnPolicy: "queue" }],
    ["an output schema", { outputSchema: { type: "object" } }],
  ])("a client option that adds a field (%s) is refused at the console, not passed on and not quietly dropped", async (_name, option) => {
    let thrown: unknown;
    const seen = await drive(async (client) => {
      const { session } = await client.sessions.create();
      try { await session.send("with an option", option as never); } catch (error) { thrown = error; }
    });
    expect((thrown as { status?: number })?.status).toBe(400);
    // Only the create reached the agent.
    expect(seen.toAgent.map((sent) => sent.path)).toEqual(["/eve/v1/session"]);
  });
});
