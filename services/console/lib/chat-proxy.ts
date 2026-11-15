import { assertPrivateConsoleEnvelope } from "@lares/agent-kit/private-console-envelope";
import { randomBytes } from "node:crypto";
import { bindConsoleSession, requireConsoleSessionBinding, requireConsoleAgentUse, type AuthorityPool,
  CONSOLE_MEMBER_ID_HEADER, CONSOLE_ADMISSION_HEADER, CONSOLE_PURPOSE_HEADER } from "@lares/agent-kit/console-turn-authority";
import type { Member } from "@lares/agent-kit/authority-contract";
/**
 * The console's half of web chat: one signed-in browser, one agent's own HTTP door.
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
 * agent's own credential. This proxy alone may issue its own signed chat-session cookie.
 *
 * CSRF: middleware requires the configured console Origin on state-changing requests, including
 * approval POSTs. SameSite=Lax cookies provide an additional cross-site boundary, but do not block
 * other origins on the same site. This handler also re-checks the session. A GET cannot answer an
 * approval because `eve/v1/session/<id>` is POST-only in the allow-list below.
 *
 * WHAT IS RELAYED is what the framework's own browser client sends from this page, read from its
 * shipped code (`eve/dist/src/client/session.js`, `session-controls.js`, `open-stream.js`) and
 * nothing else: the paths in `ALLOWED`, the query parameters in `QUERY`, a message or one answer.
 * A request body is not passed on as it arrived: `outgoingBody` builds the one that is sent, from
 * a closed list of fields, so nothing the browser or the client library adds can ride along.
 * A conversation the framework has ended answers `409` with a JSON `code` (`session_stranded`
 * after an upgrade, `session_not_active` otherwise); that answer is passed through unchanged, and
 * the page words it (`endedConversation` in `lib/chat-session.ts`).
 *
 * Structure copied from lib/door-forwarder.ts, which guards the other lane. The differences are the
 * three the plan names: it ADDS a credential instead of stripping one, it does not require a
 * claimed door row (a fresh installation has none), and it streams.
 */
import { isIP } from "node:net";
import { chatSessionCapabilityCookie, hasChatSessionCapability, validChatSessionId } from "./chat-session-capability";
import { ANSWER_NOT_USED, ANSWER_UNCHECKED, CONSOLE_REFUSAL_HEADER, CONVERSATION_GONE } from "./chat-session";
import { createHash } from "node:crypto";
import { AGENT_STATE_HEADER, AGENT_NOT_RUNNING } from "./agent-reachability";
import { signPrivateVaultRequest, PRIVATE_CONSOLE_VAULT_CAPSULE_HEADER } from "./vault-capsule";
import { signPrivateModelPurposeRequest, modelPurposeRawBodyHash, modelPurposeSigningConfigured } from "./model-purpose-capsule";
import { PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER } from "@lares/agent-kit/private-console-envelope";

/**
 * The username the agent's own door answers to (`ROUTE_USERNAME` in every role's
 * `agent/channels/eve.ts`). The console does not depend on a role service, so this is a
 * mirror; `tests/chat-proxy.test.ts` reads the door's source as text so the two cannot drift.
 */
export const ROUTE_USERNAME = "eve";

/**
 * The header this proxy sets to name the signed-in member it is acting for. The agent's
 * own door reads it — `MEMBER_HEADER` in every role's `agent/channels/eve.ts`, which
 * `tests/chat-proxy.test.ts` reads as text so the two cannot drift.
 *
 * WHO SETS IT AND WHO MAY NOT. It is set HERE, on the server, from `deps.signedInEmail()` — the
 * same `verify()` of the `lares_session` cookie that `middleware.ts` already made, re-done rather
 * than trusted. It is never read from the incoming request: the browser's own copy is dropped
 * before this, because `REQUEST_HEADERS` below is an allow-list of exactly two names and
 * everything else the browser sent is discarded. A forged `x-lares-member` therefore cannot even
 * reach the agent, let alone be believed by it.
 *
 * WHAT THE AGENT IS TRUSTING. The agent believes this header because the same request carries
 * `Authorization: Basic eve:<route password>`. So the assertion is exactly as strong as that
 * password: **anything holding the agent's route password can claim to be any member** — today the
 * console container and the keeper, both on the owner's own server. That is the honest limit `docs/decisions/0022-the-tested-install-path.md` states.
 *
 * The BODY cannot carry an identity either, and this proxy does not have to parse it to be sure:
 * eve's own `forwardedPrincipal` body field is answered 403 unless the channel declares a
 * `trustedForwarders` predicate (`dist/src/channel/forwarded-principal.js`), and no role's door
 * declares one.
 */
export const MEMBER_HEADER = "x-lares-member";
export const MODEL_PURPOSE_REQUIRED_HEADER = "x-lares-model-purpose-required";

/** The controls on one conversation. `end` is the framework's name for closing it for good; `reset`
 *  is the older name for the same route, which the agent still serves. */
const CONTROL = /\/(cancel|clear|compact|end|reset)$/;

/** eve's own session surface, by method and by path. Anything else on the agent is not relayed. */
const ALLOWED: readonly { readonly methods: readonly string[]; readonly path: RegExp }[] = [
  { methods: ["POST"], path: /^eve\/v1\/session$/ },
  { methods: ["POST"], path: /^eve\/v1\/session\/[A-Za-z0-9_-]{1,64}$/ },
  { methods: ["GET"], path: /^eve\/v1\/session\/[A-Za-z0-9_-]{1,64}\/stream$/ },
  { methods: ["POST"], path: /^eve\/v1\/session\/[A-Za-z0-9_-]{1,64}\/(cancel|clear|compact|end|reset)$/ },
  { methods: ["GET"], path: /^eve\/v1\/health$/ },
];

/** The eve paths the console will forward, and nothing else. */
export const CHAT_PATHS: readonly RegExp[] = ALLOWED.map((rule) => rule.path);

/** The same shape `door-forwarder.ts` and `middleware.ts` accept — no dots, no slashes, no host. */
const AGENT_NAME = /^[a-z][a-z0-9-]{1,30}$/;

/** Everything else the browser sent — cookie, authorization, host, forwarded-*, and any
 *  `x-lares-member` it invented — is dropped. This list is the reason a forged identity header
 *  never leaves the console: it is an allow-list of two names, not a deny-list of known-bad
 *  ones, so a name nobody thought of is discarded too. (The framework's client sets only
 *  `content-type`; the browser adds `accept`. It no longer sends `last-event-id`: a stream is
 *  resumed by line position, in the `startIndex` query parameter.) */
const REQUEST_HEADERS = ["content-type", "accept"] as const;

/**
 * What may come back. `x-eve-*` are eve's own transport headers (the client reads the session id
 * and the stream's tail index from them); `www-authenticate` and `set-cookie` are the two that
 * would leak the door's challenge or plant an upstream cookie in the console's origin, and are
 * not on it. A successful create gets a separate cookie generated by this proxy below.
 */
const RESPONSE_HEADERS = ["content-type", "x-eve-session-id", "x-eve-stream-tail-index", "x-eve-stream-version"] as const;

/**
 * The only query parameters eve's client sets on a stream, each with the exact shape it sets
 * (`openStreamBody` in `eve/dist/src/client/open-stream.js`):
 *  - `startIndex`: the stored LINE to start from, sent when it is not 0;
 *  - `includeTailIndex=1`: ask for the last line's position in a response header;
 *  - `follow=false`: read what is recorded and stop, instead of waiting for more.
 * A stream request with any other parameter, a repeated one, or one of these in another shape is
 * refused, and no other path takes a query parameter at all.
 */
const QUERY: Record<string, RegExp> = {
  startIndex: /^[0-9]{1,12}$/,
  includeTailIndex: /^1$/,
  follow: /^false$/,
};

/** The two answers a card has. */
type AnswerOption = "approve" | "deny";

/**
 * The one answer web chat sends: `answers: [{ interactionId, optionId }]` with nothing else in it
 * (`createMessageBody` in `eve/dist/src/client/session.js` sends the array as given, and
 * `components/Chat.tsx` gives exactly this). One card per request, one of two options, no free
 * text. Anything else is not an answer this proxy relays.
 */
function soleAnswer(answers: unknown): { interactionId: string; optionId: AnswerOption } | null {
  if (!Array.isArray(answers) || answers.length !== 1) return null;
  const answer: unknown = answers[0];
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return null;
  const { interactionId, optionId } = answer as { interactionId?: unknown; optionId?: unknown };
  if (Object.keys(answer).some((key) => key !== "interactionId" && key !== "optionId")) return null;
  // The framework mints a short random id for its own cards and `<child session>/<id>` for one a
  // sub-agent relays, so a slash is part of the shape. The id only ever travels in a JSON body.
  if (typeof interactionId !== "string" || !/^[A-Za-z0-9_.:\/-]{1,200}$/.test(interactionId)) return null;
  if (optionId !== "approve" && optionId !== "deny") return null;
  return { interactionId, optionId };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * THE BODY THAT LEAVES THE CONSOLE, built here from a closed list of fields — never the bytes the
 * browser sent. The agent refuses any field it does not list, so these are the same lists:
 *
 *   POST eve/v1/session                 {}  |  { message }  |  { message, operationId }
 *   POST eve/v1/session/<id>            { message }  |  { answers: [{ interactionId, optionId }] }
 *   POST eve/v1/session/<id>/cancel     {}  |  { turnId }     (a `turnId` of null is sent as {})
 *   POST eve/v1/session/<id>/end|reset  {}  |  { reason }
 *   POST eve/v1/session/<id>/clear|compact   {}
 *
 * ONE field is dropped rather than refused: `inbox`. The framework's client adds it by itself to a
 * message or an answer once the agent has issued one (`postTurn` in its `client/session.js`); it
 * is an opaque routing hint whose absence only costs the agent a lookup. Everything else that is
 * not on a list is a refusal, not a silent drop: a field this page never sends is a request this
 * proxy does not understand. So if a later client library starts adding a field of its own, sends
 * fail here, loudly, instead of the field reaching an agent.
 *
 * Returns the body to send and, for an answer, what it says; or the sentence to refuse with.
 */
function outgoingBody(path: string, parsed: unknown): { body: Record<string, unknown>; answer?: { interactionId: string; optionId: AnswerOption } } | string {
  const unsupported = "Private conversation request is not supported.";
  if (!isRecord(parsed)) return unsupported;
  const only = (fields: Record<string, unknown>, ...allowed: string[]) => Object.keys(fields).every((key) => allowed.includes(key));
  const optional = (name: string): Record<string, unknown> | null =>
    !only(parsed, name) ? null : !(name in parsed) ? {} : isText(parsed[name]) ? { [name]: parsed[name] } : null;
  const control = CONTROL.exec(path)?.[1];
  if (control !== undefined) {
    // The framework's store cancels "whatever is running" as `{ "turnId": null }` when it knows of
    // no turn. That names no turn, so it goes on as the body that names none: {}.
    const noTurnNamed = control === "cancel" && only(parsed, "turnId") && parsed.turnId === null;
    const body = noTurnNamed ? {} : control === "cancel" ? optional("turnId") : control === "end" || control === "reset" ? optional("reason") : only(parsed) ? {} : null;
    return body === null ? unsupported : { body };
  }
  if (path === "eve/v1/session") {
    // A card belongs to a conversation, so an answer can never create one.
    if ("answers" in parsed) return "Private approval response is not supported.";
    if (!only(parsed, "message", "operationId")) return unsupported;
    if (!("message" in parsed)) return "operationId" in parsed ? unsupported : { body: {} };
    if (!isText(parsed.message) || ("operationId" in parsed && !isText(parsed.operationId))) return unsupported;
    return { body: { message: parsed.message, ...("operationId" in parsed ? { operationId: parsed.operationId } : {}) } };
  }
  // Into an existing conversation: a message or an answer, never both, and nothing else.
  const { inbox: _routingHint, ...sent } = parsed;
  if ("message" in sent && "answers" in sent) return "Send a message or an approval answer separately.";
  if ("answers" in sent) {
    const answer = only(sent, "answers") ? soleAnswer(sent.answers) : null;
    return answer === null ? "Private approval response is not supported." : { body: { answers: [{ interactionId: answer.interactionId, optionId: answer.optionId }] }, answer };
  }
  // Neither a message nor an answer — the older answer field included — is not relayed, and so
  // never travels under a human purpose.
  if (!only(sent, "message") || !isText(sent.message)) return unsupported;
  return { body: { message: sent.message } };
}

const MAX_REQUEST_BYTES = 262144;
/** A turn is a small POST; a stream is not, and is bounded by the browser staying connected. */
const REQUEST_TIMEOUT_MS = 30000;

export interface ChatDeps {
  connect?: AuthorityPool["connect"];
  query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  fetch: typeof fetch;
  /** The route password, or undefined when none is mounted. Never logged. */
  routePassword(): string | undefined;
  /** The signed-in console member, or null. Checked before anything else happens. */
  signedInMember(): Promise<Member | null>;
}

/**
 * A SECOND ANSWER TO A CARD THAT IS ALREADY SETTLED is refused here, before it reaches the agent.
 *
 * Why: eve treats an answer to a card that is no longer waiting as a new message, and opens a new
 * turn under the answer's identity. The agent refuses that turn, and the page then shows a dead
 * conversation. A double click, a second tab, an old tab or a request sent again would do it.
 *
 * How the console knows: from the card's own record, `approval_asks`, which the agent writes. It
 * finds the row by the card's four coordinates (the interaction id, this agent, this conversation,
 * this member) — the same coordinates the agent's own route admission needs for any answer
 * (`consoleRouteAdmission` in the agent kit), so a card that has none would be refused there too.
 * The card is waiting only while the row has no outcome and was never used: the agent's response
 * policy writes `approved` when it takes an Approve, and the card's settle writes a Deny, a
 * withdrawal or an expiry. Anything else — no row, two rows, a row that cannot be read — is not a
 * card this console can vouch is waiting, so the answer is not sent (fail closed).
 *
 * Two answers at the same moment (a double click). The agent takes a delivery at once and writes
 * the outcome on its next step, so for a moment the record still says "waiting" to both. The
 * console therefore also keeps, in memory, the cards it has just sent an answer to: the first
 * answer claims its card, synchronously, and a second one for the same card is refused while the
 * claim lasts. A claim is dropped at once when the answer did not reach the agent (no answer, or
 * a refusal), so a person may try again; otherwise it lasts `ANSWER_CLAIM_MS`, long after the
 * record has caught up. The claim is no record of answers: it decides nothing on its own beside
 * the record, and it is lost on a restart, after which the record alone decides.
 *
 * Two known limits. The console runs as one process today; with two, each would keep its own
 * claims, and only the agent's own checks would stop a double action. And an answer the agent
 * takes at once but refuses a step later (its response policy) leaves the card waiting while the
 * claim lasts: this console cannot see that refusal, which happens after the agent's reply.
 */
const ANSWER_CLAIM_MS = 10 * 60_000;
const ANSWER_CLAIMS_MAX = 4096;
const answerClaims = new Map<string, number>();

/** Test-only: forget every claim. */
export function resetAnswerClaimsForTests(): void {
  answerClaims.clear();
}

/** Claims a card for one answer. Synchronous on purpose: two requests cannot both pass. */
function claimAnswer(key: string, now: number): { release(): void } | "taken" | "full" {
  for (const [claimed, until] of answerClaims) if (until <= now) answerClaims.delete(claimed);
  if (answerClaims.has(key)) return "taken";
  if (answerClaims.size >= ANSWER_CLAIMS_MAX) return "full";
  const until = now + ANSWER_CLAIM_MS;
  answerClaims.set(key, until);
  // Drops this claim only, never a later one for the same card.
  return { release: () => { if (answerClaims.get(key) === until) answerClaims.delete(key); } };
}

/** True only when the card's own record says it still waits for an answer. Throws when the record
 *  cannot be read. */
async function cardStillWaiting(deps: Pick<ChatDeps, "query">, card: { interactionId: string; agent: string; sessionId: string; memberId: string }): Promise<boolean> {
  const { rows } = await deps.query(
    `SELECT outcome, used_at FROM approval_asks
      WHERE request_id = $1 AND agent = $2 AND session_id = $3 AND acting_member_id = $4`,
    [card.interactionId, card.agent, card.sessionId, card.memberId],
  );
  return rows.length === 1 && rows[0]!.outcome === null && rows[0]!.used_at === null;
}

function refuse(status: number, message: string, notRunning = false): Response {
  return new Response(message, { status, headers: {
    "content-type": "text/plain", "cache-control": "no-store",
    // Marks the sentence as this console's own; see CONSOLE_REFUSAL_HEADER.
    [CONSOLE_REFUSAL_HEADER]: "1",
    ...(notRunning ? { [AGENT_STATE_HEADER]: AGENT_NOT_RUNNING } : {}),
  } });
}

/** Reads a body up to `limit` bytes, or throws (`RangeError` when it is larger). Exported for
 *  `lib/waiting.ts`, which reads agents' event streams the same way. */
export async function bounded(stream: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Uint8Array> {
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

/** True only for a registered, runtime-controlled agent on a private address of this box.
 *  Exported for `lib/waiting.ts`, which reaches the same doors from the server side. */
export function vouchedAddress(row: Record<string, unknown> | undefined): string | null {
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
  //    the identity this request is carried out under.
  const stableMember = await deps.signedInMember();
  if (!stableMember) return refuse(401, "Sign in to the console to talk to an agent.");

  // 2. What may be asked for, before anything is looked up, read or opened.
  const rule = ALLOWED.find((candidate) => candidate.path.test(path));
  if (!rule || !rule.methods.includes(request.method) || !AGENT_NAME.test(name)) {
    return refuse(404, "Not found");
  }

  const isStream = path.endsWith("/stream");
  // Query parameters are part of what may be asked for: only a stream takes any, only the three
  // the framework's client sets, each once and in its exact shape. Nothing is silently dropped.
  const asked = new URL(request.url).searchParams;
  const search = new URLSearchParams();
  for (const [key, value] of asked) {
    if (!isStream || !Object.hasOwn(QUERY, key) || !QUERY[key]!.test(value) || search.has(key)) return refuse(400, "Not supported");
    search.set(key, value);
  }
  // The browser going away must reach the agent. A turn also gives up on its own; a stream is
  // held open by eve deliberately, so its only bound is the browser staying connected.
  const signal = isStream
    ? request.signal
    : AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

  // An answer's claim on its card (`claimAnswer`), and whether the agent took the answer.
  let answerClaim: { release(): void } | undefined;
  let answerDelivered = false;
  try {
    try { await requireConsoleAgentUse(name,stableMember.id,deps); }
    catch { return refuse(403,"Conversation access is unavailable. Start a new conversation after access has been granted."); }
    // 3. The address comes from the console's own registry, by bound parameter — never from the
    //    request. An agent this console cannot vouch for is a 404 with no call made.
    const { rows } = await deps.query(
      `SELECT host(r.address) AS address, r.state, a.status, a.hash AS definition_hash, r.runtime_control_token,
        r.ownership_token AS incarnation, r.applied_definition->>'role' AS role
        FROM agent_resources r JOIN agent_definitions a ON a.name = r.name
        WHERE r.name = $1 AND r.state = 'ready' AND NOT r.pending AND a.status = 'valid'`,
      [name],
    );
    const address = vouchedAddress(rows[0]);
    // Not registered as ready: the agent is not running. Marked, so the page can say so.
    if (!address) return refuse(404, "Not found", true);

    // Eve authenticates the route password, not the person who owns a session. A browser may
    // continue a session only with the cookie this proxy issued when that session was created.
    const sessionId = /^eve\/v1\/session\/([A-Za-z0-9_-]{1,64})(?:\/|$)/.exec(path)?.[1];
    // A conversation that has been ended for good cannot take another message or answer: saving a change to
    // the agent revokes its open conversations, and so does a change to who may use it. Say that, never "did
    // not answer", which reads as a fault worth retrying. Any other refusal (a read that failed, a
    // conversation that is not this member's) keeps its old answer below.
    let tuple: Awaited<ReturnType<typeof requireConsoleSessionBinding>> | undefined;
    try { tuple = sessionId ? await requireConsoleSessionBinding({agent:name,incarnation:rows[0]!.incarnation as string,sessionId,memberId:stableMember.id},deps) : undefined; }
    catch (error) {
      const revoked = await deps.query(`SELECT 1 FROM console_session_bindings WHERE agent=$1 AND incarnation=$2::uuid AND session_id=$3
        AND member_id=$4 AND revoked_at IS NOT NULL`, [name, rows[0]!.incarnation, sessionId, stableMember.id]).catch(() => ({ rows: [] }));
      if (revoked.rows.length === 1) return refuse(410, CONVERSATION_GONE);
      throw error;
    }

    // 4. The credential, read server-side, spent on one header and named nowhere else.
    const password = deps.routePassword();
    if (!password) {
      return refuse(503, "No route password is mounted for this agent, so the console cannot reach it.");
    }

    if (sessionId && !hasChatSessionCapability(request.headers.get("cookie"), password, stableMember.id, name, rows[0]!.incarnation as string, sessionId)) {
      return refuse(403, "This conversation is not available to this signed-in member.");
    }

    if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) {
      return refuse(413, "Body too large");
    }
    const received = isStream || request.method === "GET" ? undefined : await bounded(request.body, MAX_REQUEST_BYTES, signal);

    // What is sent on is built here, field by field, and then shown to the agent kit's own
    // envelope check — the same check the agent runs on what arrives. `body` is from here on the
    // bytes that leave the console; every signature below is made over exactly those bytes.
    let built: Uint8Array | undefined;
    let answer: { interactionId: string; optionId: AnswerOption } | undefined;
    if (received !== undefined) {
      let parsed: unknown;
      try { parsed = received.length ? JSON.parse(new TextDecoder().decode(received)) : {}; }
      catch { return refuse(400, "Private conversation request is not supported."); }
      const outgoing = outgoingBody(path, parsed);
      if (typeof outgoing === "string") return refuse(400, outgoing);
      try { assertPrivateConsoleEnvelope(outgoing.body, '/' + path); }
      catch { return refuse(400, "Private conversation request is not supported."); }
      answer = outgoing.answer;
      // A request that came with no body at all goes on with none (the framework's client creates
      // a conversation that way).
      built = received.length ? new TextEncoder().encode(JSON.stringify(outgoing.body)) : received;
    }
    const body = built;
    const nonce = tuple?.admissionNonce ?? randomBytes(32).toString("base64url");
    // An answer is a decision on a card, not something a person said: it is vouched for under
    // its own purpose.
    const purpose = isStream || request.method === "GET" ? "read" : CONTROL.test(path) ? "control" : answer ? "resolver" : "human";
    if (modelPurposeSigningConfigured() && body?.length && (purpose === "human" || purpose === "resolver") && !sessionId) {
      return refuse(409, "Create the conversation before sending a private message.");
    }
    // An answer goes on only to a card that still waits for one, and only once (see
    // `cardStillWaiting` and `claimAnswer` above). Before anything is signed or sent: a refused
    // answer asks for no model authority and opens nothing on the agent.
    if (answer && sessionId) {
      let waiting: boolean;
      try {
        waiting = await cardStillWaiting(deps, { interactionId: answer.interactionId, agent: name, sessionId, memberId: stableMember.id });
      } catch {
        return refuse(503, ANSWER_UNCHECKED);
      }
      if (!waiting) return refuse(409, ANSWER_NOT_USED);
      const claim = claimAnswer(JSON.stringify([name, rows[0]!.incarnation, sessionId, stableMember.id, answer.interactionId]), Date.now());
      if (claim === "taken") return refuse(409, ANSWER_NOT_USED);
      if (claim === "full") return refuse(503, ANSWER_UNCHECKED);
      answerClaim = claim;
    }
    const headers = new Headers();
    for (const key of REQUEST_HEADERS) {
      const value = request.headers.get(key);
      if (value !== null) headers.set(key, value);
    }
    headers.set("authorization", `Basic ${Buffer.from(`${ROUTE_USERNAME}:${password}`).toString("base64")}`);
    // Set AFTER the loop above, and from the verified session — never copied from the request.
    // Whatever the browser sent under this name was already dropped, because the loop only ever
    // copies the two names in REQUEST_HEADERS.
    // Health never carries member authority.
    if (path === "eve/v1/session" || sessionId) {
      headers.set(CONSOLE_MEMBER_ID_HEADER, stableMember.id);
      headers.set(CONSOLE_ADMISSION_HEADER, nonce);
      headers.set(CONSOLE_PURPOSE_HEADER, purpose);
    }

    // The browser never supplies this capability. It is available only for a non-empty human
    // message to an already-bound session; an empty create and ordinary chat remain unchanged.
    if (sessionId && body?.length && purpose === "human" && /^eve\/v1\/session\/[A-Za-z0-9_-]{1,64}$/.test(path) && tuple && typeof rows[0]!.definition_hash === "string") {
      try {
        const capsule=await signPrivateVaultRequest({agent:name,incarnation:rows[0]!.incarnation as string,session:sessionId,
          member:stableMember.id,admissionNonce:nonce,method:request.method,path:`/${path}`,
          rawBodyHash:createHash("sha256").update(body).digest("hex"),policyRevision:tuple.policyRevision,
          definitionHash:rows[0]!.definition_hash as string});
        headers.set(PRIVATE_CONSOLE_VAULT_CAPSULE_HEADER,capsule);
      } catch { /* Missing broker/key custody disables only the private Vault reader. */ }
    }

    // Model authority is independent from Vault authority. Bind both human messages and
    // approval resumes to the exact bytes sent to Eve. If a signer has been provisioned,
    // any failure refuses this request instead of forwarding an unsigned private turn.
    const modelPurposeMessage = sessionId && body?.length && (purpose === "human" || purpose === "resolver") &&
      /^eve\/v1\/session\/[A-Za-z0-9_-]{1,64}$/.test(path);
    if (modelPurposeMessage && modelPurposeSigningConfigured()) {
      // A provisioned signer makes every tagged human/resume request accountable. Missing
      // validated session data or a role without the private claim adapter must stop here.
      if (rows[0]!.role !== "chief-of-staff" || !tuple || typeof rows[0]!.definition_hash !== "string") {
        return refuse(503, "Private model authorization is unavailable.");
      }
      // The capsule names the card under its own key `requestId` — the value is the framework's
      // interaction id — and the decision in the framework's words, "approve" or "deny". The agent
      // compares both with the body it received (`verifiedPrivateConsoleModelResponseReceipt` in
      // the agent kit), so they are the same two values that body carries.
      let modelResume: { requestId: string; optionId: AnswerOption } | undefined;
      if (purpose === "resolver") {
        if (!answer) return refuse(400, "Private approval response is not supported.");
        modelResume = { requestId: answer.interactionId, optionId: answer.optionId };
      }
      const modelRequest = {
        agent: name,
        incarnation: rows[0]!.incarnation as string,
        session: sessionId,
        member: stableMember.id,
        admissionNonce: nonce,
        method: "POST" as const,
        path: `/${path}`,
        rawBodyHash: modelPurposeRawBodyHash(body),
        policyRevision: tuple.policyRevision,
        definitionHash: rows[0]!.definition_hash as string,
        purpose: purpose === "resolver" ? "resume" as const : "human" as const,
        requestId: randomBytes(32).toString("base64url"),
        ...(modelResume ? { resume: modelResume } : {}),
      };
      try {
        headers.set(MODEL_PURPOSE_REQUIRED_HEADER, "1");
        // The keeper issues the challenge this signs. It checks the conversation's binding and the
        // agent's definition, not whether the card still waits: that is checked above, before this.
        // A failure here ends in the refusal just below: nothing is forwarded, nothing is approved.
        headers.set(PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER, await signPrivateModelPurposeRequest(modelRequest));
      } catch {
        return refuse(503, "Private model authorization is unavailable.");
      }
    }

    const query = search.size > 0 ? `?${search.toString()}` : "";

    let upstream: Response;
    try {
      upstream = await deps.fetch(`http://${address}:3000/${path}${query}`, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body: body as BodyInit }),
        signal,
        redirect: "error",
      });
    } catch {
      // The registry says ready but the door did not answer (a stopped container). Reported in our
      // own words, and marked so the page can say the agent is not running.
      return refuse(502, "The agent did not answer.", !request.signal.aborted);
    }
    // Taken by the agent: the card's claim stays. Refused: it is dropped (below) and may be sent again.
    answerDelivered = upstream.ok;

    const out = new Headers({ "cache-control": "no-store" });
    for (const key of RESPONSE_HEADERS) {
      const value = upstream.headers.get(key);
      if (value !== null) out.set(key, value);
    }
    if (path === "eve/v1/session" && upstream.ok) {
      const createdSessionId = upstream.headers.get("x-eve-session-id");
      if (!validChatSessionId(createdSessionId)) {
        return refuse(502, "The agent did not return a usable conversation ID.");
      }
      await bindConsoleSession({agent:name,incarnation:rows[0]!.incarnation as string,sessionId:createdSessionId,memberId:stableMember.id,admissionNonce:nonce},deps);
      out.set("set-cookie", chatSessionCapabilityCookie(request, password, stableMember.id, name, rows[0]!.incarnation as string, createdSessionId));
    }
    if (!out.has("content-type")) out.set("content-type", "application/octet-stream");
    // The body is passed through, never read: what eve streams, the browser gets as it arrives.
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (error) {
    // Reported in our own words. An upstream error message can quote the request line, and the
    // request line carries the credential.
    if (error instanceof RangeError) return refuse(413, "Body too large");
    return refuse(502, "The agent did not answer.");
  } finally {
    if (!answerDelivered) answerClaim?.release();
  }
}
