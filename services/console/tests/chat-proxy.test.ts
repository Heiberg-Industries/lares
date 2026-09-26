/**
 * W8B-s2 — the console's chat proxy.
 *
 * This is the one place in the system that holds a browser session cookie and an agent's route
 * password at the same time, so the tests below are ordered by what would go wrong: a signed-out
 * visitor reaching an agent, a request path naming its own upstream, and the password coming back
 * out towards the browser.
 *
 * Shaped after `tests/door-forwarder.test.ts`, which guards the other lane (platform webhooks in).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { forwardChat, CHAT_PATHS, MEMBER_HEADER, ROUTE_USERNAME, type ChatDeps } from "../lib/chat-proxy";
import { chatSessionCapabilityCookie } from "../lib/chat-session-capability";

const PASSWORD = "disposable-fixture-only";

const row = {
  address: "172.29.0.10/32",
  role: "chief-of-staff",
  status: "valid",
  state: "ready",
  runtime_control_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  incarnation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

/**
 * The plan's fixture plus two things this slice needs to be able to assert:
 * `signedInEmail` (the session check happens INSIDE the proxy, so a route that forgot it cannot
 * exist) and `routePassword` as a spy (so "a signed-out request reads no secret" is a real
 * assertion and not a hope).
 */
// `password: null` means "none is mounted" — a default parameter cannot express that, because
// passing `undefined` is what selects the default.
const deps = (
  value: unknown = row,
  password: string | null = PASSWORD,
  email: string | null = "owner@example.invalid",
) => ({
  query: vi.fn<ChatDeps["query"]>(async () => ({ rows: value ? [value as Record<string, unknown>] : [] })),
  fetch: vi.fn<typeof fetch>(async () =>
    new Response('{"ok":true,"sessionId":"wrun_A","status":"accepted"}', {
      status: 200,
      headers: { "content-type": "application/json", "x-eve-session-id": "wrun_A" },
    }),
  ),
  routePassword: vi.fn<ChatDeps["routePassword"]>(() => password ?? undefined),
  signedInEmail: vi.fn<ChatDeps["signedInEmail"]>(async () => email),
});

const post = (body = '{"message":"hello"}', signal?: AbortSignal) =>
  new Request("https://console.example.invalid/api/chat/helper/eve/v1/session", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", cookie: "lares_session=abc", authorization: "Basic forged" },
    ...(signal ? { signal } : {}),
  });

const capability = (member = "owner@example.invalid", agent = "helper", incarnation = row.incarnation) =>
  chatSessionCapabilityCookie(post(), PASSWORD, member, agent, incarnation, "wrun_A").split(";")[0]!;

const sessionRequest = (path: string, method = "GET", cookie = capability()) =>
  new Request(`https://console.example.invalid/api/chat/helper/${path}`, {
    method,
    headers: { cookie: `lares_session=abc; ${cookie}` },
    ...(method === "POST" ? { body: '{"message":"hello"}' } : {}),
  });

describe("the console's chat proxy", () => {
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

  it("carries only the stream parameters eve itself uses", async () => {
    const d = deps();
    const get = new Request(
      "https://console.example.invalid/api/chat/helper/eve/v1/session/wrun_A/stream" +
        "?startIndex=12&includeTailIndex=1&streamControlVersion=1&host=evil.example.invalid&startIndex2=x",
      { headers: { cookie: `lares_session=abc; ${capability()}` } },
    );
    await forwardChat(get, "helper", "eve/v1/session/wrun_A/stream", d);
    const [url] = d.fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://172.29.0.10:3000/eve/v1/session/wrun_A/stream?streamControlVersion=1&startIndex=12&includeTailIndex=1",
    );
  });

  it("does NOT require a claimed or enabled door — a fresh installation has none", async () => {
    const d = deps();
    await forwardChat(post(), "helper", "eve/v1/session", d);
    const [sql] = d.query.mock.calls[0]!;
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
    expect(CHAT_PATHS.length).toBe(6);
    const get = (path: string) => new Request(`https://console.example.invalid/api/chat/helper/${path}`);
    expect((await forwardChat(get("eve/v1/session"), "helper", "eve/v1/session", d)).status).toBe(404);
    expect(
      (await forwardChat(post(), "helper", "eve/v1/session/wrun_A/stream", d)).status,
    ).toBe(404);
    expect(d.query).not.toHaveBeenCalled();
    for (const path of ["eve/v1/health", "eve/v1/info"]) {
      expect((await forwardChat(get(path), "helper", path, d)).status).toBe(200);
    }
    for (const verb of ["cancel", "clear", "compact", "reset"]) {
      const path = `eve/v1/session/wrun_A/${verb}`;
      expect((await forwardChat(sessionRequest(path, "POST"), "helper", path, d)).status).toBe(200);
    }
    expect((await forwardChat(sessionRequest("eve/v1/session/wrun_A", "POST"), "helper", "eve/v1/session/wrun_A", d)).status).toBe(200);
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
    // The role's door is the source of truth (W8B-s1). The console cannot import a service, so the
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
 * W8B-s5 — who the agent is told it is acting for.
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
    expect(headers.get(MEMBER_HEADER)).toBe("owner@example.invalid");
  });

  it("throws the browser's own copy away and sends the verified one instead", async () => {
    const d = deps();
    await forwardChat(forge("attacker@example.invalid"), "helper", "eve/v1/session", d);
    const headers = d.fetch.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get(MEMBER_HEADER)).toBe("owner@example.invalid");
    expect(headers.get(MEMBER_HEADER)).not.toContain("attacker");
    // Deny-by-default: no header the browser invented is relayed under any name.
    expect(headers.has("x-forwarded-user")).toBe(false);
  });

  it("vouches for nobody when nobody is signed in", async () => {
    const d = deps(row, PASSWORD, null);
    expect((await forwardChat(forge("attacker@example.invalid"), "helper", "eve/v1/session", d)).status).toBe(401);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("refuses to build a header out of a session address that could split one", async () => {
    for (const bad of ["owner@example.invalid\r\nx-lares-member: attacker@example.invalid", "owner @example.invalid", "not-an-address", "a@b,c@d"]) {
      const d = deps(row, PASSWORD, bad);
      const response = await forwardChat(post(), "helper", "eve/v1/session", d);
      expect(response.status, bad).toBe(403);
      expect(d.fetch, bad).not.toHaveBeenCalled();
    }
  });

  it("is answered on a POST only — a cross-site GET cannot reach the answer path at all", async () => {
    // Answering a card is `POST eve/v1/session/<id>` with `inputResponses`. A cross-site <img> or
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
      expect(door, role).toMatch(/if \(result\.ok\) return withConsoleMember\(result\.sessionAuth, request\.headers\.get\(MEMBER_HEADER\)\)/);
    }
  });
});
