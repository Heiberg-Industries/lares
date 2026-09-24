/**
 * W8B-s2 — the console's half of web chat: one signed-in browser, one agent's own HTTP door.
 *
 * This is the only place in the console that holds a browser session and an agent's route password
 * at the same time, so it is written as a gate with a fixed order and no way round it:
 *
 *   1. the console session, first — a request that is not signed in causes NO database read, NO
 *      secret read, NO body read and NO connection;
 *   2. the method and the path, against a closed list of eve's own session routes;
 *   3. the agent NAME, which is never part of any address: it is matched against the console's own
 *      registry (`agent_resources` joined to `agent_definitions`, by bound parameter) and the
 *      upstream host comes only from that row's `address`, never from the request;
 *   4. the route password, read server-side and spent only on the upstream `Authorization` header.
 *
 * The answer is passed through as a stream — eve's session stream is a long NDJSON body and a proxy
 * that buffered it would turn a conversation into a wait — with an allow-list of response headers,
 * so the agent cannot set a cookie in the console's origin or make the browser prompt for the
 * agent's own credential.
 *
 * CSRF: this route is protected exactly the way every other state-changing route in this console is
 * — the `lares_session` cookie is `SameSite=Lax` (app/api/auth/[...route]/route.ts), so a cross-site
 * POST never carries it and step 1 refuses; and the session is re-checked here rather than trusted
 * from middleware (the reason app/api/notion-proposals/route.ts gives). There is no token scheme in
 * this console and this slice does not invent one. Answering an approval (W8B-s5) is one of those
 * state-changing POSTs — `POST eve/v1/session/<id>` with `inputResponses` — and is covered by the
 * same two facts: a cross-site form POST arrives without the cookie, and a cross-site GET cannot
 * reach it at all, because `eve/v1/session/<id>` is POST-only in the allow-list below.
 *
 * Structure copied from lib/door-forwarder.ts, which guards the other lane. The differences are the
 * three the plan names: it ADDS a credential instead of stripping one, it does not require a
 * claimed door row (a fresh installation has none), and it streams.
 */
import { isIP } from "node:net";

/**
 * The username the agent's own door answers to (`ROUTE_USERNAME` in every role's
 * `agent/channels/eve.ts`, W8B-s1). The console does not depend on a role service, so this is a
 * mirror; `tests/chat-proxy.test.ts` reads the door's source as text so the two cannot drift.
 */
export const ROUTE_USERNAME = "eve";

/**
 * The header this proxy sets to name the signed-in member it is acting for (W8B-s5). The agent's
 * own door reads it — `MEMBER_HEADER` in every role's `agent/channels/eve.ts`, which
 * `tests/chat-proxy.test.ts` reads as text so the two cannot drift.
 *
 * WHO SETS IT AND WHO MAY NOT. It is set HERE, on the server, from `deps.signedInEmail()` — the
 * same `verify()` of the `lares_session` cookie that `middleware.ts` already made, re-done rather
 * than trusted. It is never read from the incoming request: the browser's own copy is dropped
 * before this, because `REQUEST_HEADERS` below is an allow-list of exactly three names and
 * everything else the browser sent is discarded. A forged `x-lares-member` therefore cannot even
 * reach the agent, let alone be believed by it.
 *
 * WHAT THE AGENT IS TRUSTING. The agent believes this header because the same request carries
 * `Authorization: Basic eve:<route password>`. So the assertion is exactly as strong as that
 * password: **anything holding the agent's route password can claim to be any member** — today the
 * console container and the keeper, both on the owner's own server. That is owner decision B3, and
 * it is the honest limit `docs/decisions/0022-the-tested-install-path.md` states.
 *
 * The BODY cannot carry an identity either, and this proxy does not have to parse it to be sure:
 * eve's own `forwardedPrincipal` body field is answered 403 unless the channel declares a
 * `trustedForwarders` predicate (`dist/src/channel/forwarded-principal.js`), and no role's door
 * declares one.
 */
export const MEMBER_HEADER = "x-lares-member";

/** A member address may not contain anything that would fold, split or terminate a header line,
 *  and may not be absurdly long. `verify()` only ever returns an allow-listed address, so this is
 *  the belt to that braces: a header value is built here, and building one from an unchecked
 *  string is how response splitting happens. The agent's own `consoleMember` refuses the same
 *  shapes again on arrival. */
const MEMBER_SHAPE = /^[^\s,;]+@[^\s,;]+$/;
const MEMBER_MAX = 320;

/** eve's own session surface, by method and by path. Anything else on the agent is not relayed. */
const ALLOWED: readonly { readonly methods: readonly string[]; readonly path: RegExp }[] = [
  { methods: ["POST"], path: /^eve\/v1\/session$/ },
  { methods: ["POST"], path: /^eve\/v1\/session\/[A-Za-z0-9_-]{1,64}$/ },
  { methods: ["GET"], path: /^eve\/v1\/session\/[A-Za-z0-9_-]{1,64}\/stream$/ },
  { methods: ["POST"], path: /^eve\/v1\/session\/[A-Za-z0-9_-]{1,64}\/(cancel|clear|compact|reset)$/ },
  { methods: ["GET"], path: /^eve\/v1\/health$/ },
  { methods: ["GET"], path: /^eve\/v1\/info$/ },
];

/** The eve paths the console will forward, and nothing else. */
export const CHAT_PATHS: readonly RegExp[] = ALLOWED.map((rule) => rule.path);

/** The same shape `door-forwarder.ts` and `middleware.ts` accept — no dots, no slashes, no host. */
const AGENT_NAME = /^[a-z][a-z0-9-]{1,30}$/;

/** Everything else the browser sent — cookie, authorization, host, forwarded-*, and any
 *  `x-lares-member` it invented — is dropped. This list is the reason a forged identity header
 *  never leaves the console: it is an allow-list of three names, not a deny-list of known-bad
 *  ones, so a name nobody thought of is discarded too. */
const REQUEST_HEADERS = ["content-type", "accept", "last-event-id"] as const;

/**
 * What may come back. `x-eve-*` are eve's own transport headers (the client reads the session id
 * and the stream's tail index from them); `www-authenticate` and `set-cookie` are the two that
 * would leak the door's challenge or plant a cookie in the console's origin, and are not on it.
 */
const RESPONSE_HEADERS = ["content-type", "x-eve-session-id", "x-eve-stream-tail-index", "x-eve-stream-version"] as const;

/** The only query parameters eve's client sets on a stream, each with the shape it sets. */
const QUERY: Record<string, RegExp> = {
  streamControlVersion: /^[0-9]{1,4}$/,
  startIndex: /^[0-9]{1,12}$/,
  includeTailIndex: /^[01]$/,
};

const MAX_REQUEST_BYTES = 262144;
/** A turn is a small POST; a stream is not, and is bounded by the browser staying connected. */
const REQUEST_TIMEOUT_MS = 30000;

export interface ChatDeps {
  query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  fetch: typeof fetch;
  /** The route password, or undefined when none is mounted. Never logged. */
  routePassword(): string | undefined;
  /** The signed-in console member, or null. Checked before anything else happens. */
  signedInEmail(): Promise<string | null>;
}

function refuse(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
}

async function bounded(stream: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  const abort = () => void reader.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new RangeError("body too large");
      parts.push(value);
    }
    if (signal.aborted) throw new Error("aborted");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}

/** True only for a registered, runtime-controlled agent on a private address of this box. */
function vouchedAddress(row: Record<string, unknown> | undefined): string | null {
  if (!row) return null;
  const raw = typeof row.address === "string" ? row.address.split("/")[0] : "";
  const token = row.runtime_control_token;
  const incarnation = row.incarnation;
  if (row.state !== "ready" || row.status !== "valid") return null;
  if (typeof token !== "string" || typeof incarnation !== "string" || token !== incarnation) return null;
  if (!/^[a-f0-9-]{36}$/.test(incarnation)) return null;
  if (isIP(raw) !== 4) return null;
  const octets = raw.split(".").map(Number);
  const isPrivate =
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
  return isPrivate ? raw : null;
}

/**
 * Proxies one eve session request to the named agent. `path` is the part after
 * `/api/chat/<name>/`, e.g. `eve/v1/session` or `eve/v1/session/wrun_A/stream`.
 */
export async function forwardChat(request: Request, name: string, path: string, deps: ChatDeps): Promise<Response> {
  // 1. Signed in, or nothing happens at all. The address is kept: it is both the gate and, from
  //    W8B-s5, the identity this request is carried out under.
  const member = await deps.signedInEmail();
  if (!member) return refuse(401, "Sign in to the console to talk to an agent.");
  if (member.length > MEMBER_MAX || !MEMBER_SHAPE.test(member)) {
    return refuse(403, "The signed-in address is not one this console can vouch for to an agent.");
  }

  // 2. What may be asked for, before anything is looked up, read or opened.
  const rule = ALLOWED.find((candidate) => candidate.path.test(path));
  if (!rule || !rule.methods.includes(request.method) || !AGENT_NAME.test(name)) {
    return refuse(404, "Not found");
  }

  const isStream = path.endsWith("/stream");
  // The browser going away must reach the agent. A turn also gives up on its own; a stream is
  // held open by eve deliberately, so its only bound is the browser staying connected.
  const signal = isStream
    ? request.signal
    : AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

  try {
    // 3. The address comes from the console's own registry, by bound parameter — never from the
    //    request. An agent this console cannot vouch for is a 404 with no call made.
    const { rows } = await deps.query(
      `SELECT host(r.address) AS address, r.state, a.status, r.runtime_control_token,
        r.ownership_token AS incarnation, r.applied_definition->>'role' AS role
        FROM agent_resources r JOIN agent_definitions a ON a.name = r.name
        WHERE r.name = $1 AND r.state = 'ready' AND a.status = 'valid'`,
      [name],
    );
    const address = vouchedAddress(rows[0]);
    if (!address) return refuse(404, "Not found");

    // 4. The credential, read server-side, spent on one header and named nowhere else.
    const password = deps.routePassword();
    if (!password) {
      return refuse(503, "No route password is mounted for this agent, so the console cannot reach it.");
    }

    if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) {
      return refuse(413, "Body too large");
    }
    const body = isStream || request.method === "GET" ? undefined : await bounded(request.body, MAX_REQUEST_BYTES, signal);

    const headers = new Headers();
    for (const key of REQUEST_HEADERS) {
      const value = request.headers.get(key);
      if (value !== null) headers.set(key, value);
    }
    headers.set("authorization", `Basic ${Buffer.from(`${ROUTE_USERNAME}:${password}`).toString("base64")}`);
    // Set AFTER the loop above, and from the verified session — never copied from the request.
    // Whatever the browser sent under this name was already dropped, because the loop only ever
    // copies the three names in REQUEST_HEADERS.
    headers.set(MEMBER_HEADER, member);

    const search = new URLSearchParams();
    for (const [key, shape] of Object.entries(QUERY)) {
      const value = new URL(request.url).searchParams.get(key);
      if (value !== null && shape.test(value)) search.set(key, value);
    }
    const query = search.size > 0 ? `?${search.toString()}` : "";

    const upstream = await deps.fetch(`http://${address}:3000/${path}${query}`, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body: body as BodyInit }),
      signal,
      redirect: "error",
    });

    const out = new Headers({ "cache-control": "no-store" });
    for (const key of RESPONSE_HEADERS) {
      const value = upstream.headers.get(key);
      if (value !== null) out.set(key, value);
    }
    if (!out.has("content-type")) out.set("content-type", "application/octet-stream");
    // The body is passed through, never read: what eve streams, the browser gets as it arrives.
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (error) {
    // Reported in our own words. An upstream error message can quote the request line, and the
    // request line carries the credential.
    if (error instanceof RangeError) return refuse(413, "Body too large");
    return refuse(502, "The agent did not answer.");
  }
}
