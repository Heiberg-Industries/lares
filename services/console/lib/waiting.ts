import { randomBytes } from "node:crypto";
import { requireConsoleSessionBinding, CONSOLE_MEMBER_ID_HEADER, CONSOLE_ADMISSION_HEADER, CONSOLE_PURPOSE_HEADER } from "@lares/agent-kit/console-turn-authority";
import type { Member } from "@lares/agent-kit/authority-contract";
/**
 * "Waiting on you" — everything the agents have put in front of the owner and are waiting for an
 * answer on, whichever conversation it came from (Telegram, Slack or web chat), in one list.
 *
 * THE ITEM, NOT THE APPROVAL. The page is the place to review whatever the agents produce: today
 * approvals; later email drafts to read and adjust, proposals, and creative output (images, texts).
 * So the page renders a generic `WaitingItem` — kind, agent, channel, when, a title, a body that is
 * text, markdown or an attachment, and the actions that kind allows — and each kind is a
 * `WaitingSource` that lists its items and carries out an action. Approvals are the only source
 * built. A new kind is a new source in `SOURCES`, not a new page.
 *
 * HOW APPROVALS ARE FOUND, with no eve patch and no new table:
 *   1. the agents this member OWNS: the member is the one and only owner of the agent's applied
 *      connections on enabled doors — the keeper's own selection for `LARES_CONSOLE_PRINCIPAL`,
 *      the agent's console approver (`ownedFrom`). With two claimants nobody owns it here;
 *   2. that agent's live conversations, from the `agent_conversations` projection the agents write
 *      themselves (`@lares/agent-kit/conversation-control`; a schedule's session joins it once it
 *      asks for input);
 *   3. each conversation's own recorded stream, read through eve's supported route
 *      `GET /eve/v1/session/<id>/stream?includeTailIndex=1&follow=false` on the agent's own HTTP
 *      door — the same bounded read eve's own client makes (`snapshot()` in its
 *      `client/session.js`): eve sends the lines recorded so far and closes the stream
 *      (`createSessionStreamResponse` in its `eve-channel/request.js`). The body is also
 *      byte-capped, and the whole list has a deadline.
 *
 * WHAT THE STREAM IS (stream version 27; `readStreamLines` below). Newline-delimited JSON. One
 * stored LINE is `{ at, facts: [...] }`: every event one state change produced, with the time it
 * was written. An event is `{ type, scope?, data }` and is placed by its line and its index in
 * that line, not by an id. Lines `{ progress }` are previews of text still being written, and
 * lines `{ "$eve": ... }` are the route's own heartbeat and position marks; neither is recorded
 * history. A card is `interaction.opened` with `request.kind: "approval"`; the tool it asks about
 * is the `call.requested` its `subject.callId` names. It is still waiting while there is no
 * `interaction.settled` for its interaction id, its call has not settled, and the session has not
 * ended.
 *
 * A CONVERSATION THIS CONSOLE CANNOT READ IS SKIPPED, with one log line and no error on the page:
 * a stream that is not version 27, a record written in an earlier format, and a conversation the
 * agent no longer serves (HTTP 409 or 410). Every framework upgrade ends the conversations that
 * were open, and an ended conversation can act on no answer, so there is nothing in it to decide.
 *
 * HOW AN APPROVAL IS DECIDED: through the same door, the same way web chat answers its own cards —
 * `POST /eve/v1/session/<id>` with `{ answers: [{ interactionId, optionId }] }` where `optionId`
 * is `"approve"` or `"deny"`, the route password, and `x-lares-member` naming the signed-in
 * owner. eve's door resumes the session by its durable id whatever channel opened it, and the
 * tool's own approver check accepts exactly that owner
 * (`services/chief-of-staff/tests/console-decides-approval.test.ts` runs it). Whether a person
 * decided is read from the interaction's own `outcome`: `accepted` or `declined` is a decision;
 * anything else (withdrawn, interrupted, expired, ...) means nobody decided, and is never reported
 * as an approval.
 *
 * WHERE THE REPLY GOES. A session keeps the channel it was opened on, and a turn's events are
 * handed to that channel. The HTTP door that carried the answer only adds a delivery. So the
 * Telegram or Slack card's edit, and the agent's reply, happen in the conversation the approval
 * came from.
 *
 * Server only: it holds the route password. Nothing here is sent to a browser except the items.
 */
import { approvalArguments } from "./approval-text";
import { decideProposal, listProposals } from "./waiting-proposals";
import { bounded, MEMBER_HEADER, ROUTE_USERNAME, vouchedAddress } from "./chat-proxy";
import { APPROVAL_LIFETIME_MS } from "../components/ChatTranscript";

// ── The generic item ────────────────────────────────────────────────────────────────────────────

/** The kinds of thing the page can show: `approval` is an agent's card; `proposal` is read from
 *  the database (`lib/waiting-proposals.ts`). */
export type WaitingKind = "approval" | "proposal";

/** One part of an item's body. A page renders each as plain text, never as HTML. */
export type WaitingBody =
  | { readonly format: "text"; readonly label?: string; readonly text: string }
  | { readonly format: "markdown"; readonly label?: string; readonly markdown: string }
  | { readonly format: "attachment"; readonly label?: string; readonly name: string; readonly mediaType: string; readonly href: string };

export interface WaitingAction {
  readonly id: string;
  readonly label: string;
  readonly tone: "primary" | "neutral";
}

export interface WaitingItem {
  /** Opaque and stable: names the kind and, inside it, exactly what to act on. */
  readonly id: string;
  readonly kind: WaitingKind;
  readonly agent: string;
  readonly channel: "Telegram" | "Slack" | "Web chat" | "Console";
  /** What the page calls this kind of item, when the kind alone is too general. */
  readonly kindLabel?: string;
  /** When the agent asked, ISO 8601, or null when the event carried no time. */
  readonly createdAt: string | null;
  readonly title: string;
  readonly body: readonly WaitingBody[];
  readonly actions: readonly WaitingAction[];
  /** A sentence shown above the actions when something limits them (an expired approval). */
  readonly note?: string;
  /** Kind-specific key a link may select the item by (for an approval: eve's interaction id). */
  readonly ref: string;
}

/** Why an agent could not be read. `timeout`: no answer in time. `refused`: HTTP 401/403 (the
 *  console's credentials were not accepted). `not-found`: HTTP 404 where an answer was required.
 *  `unreachable`: no connection at all. `error`: any other HTTP status, or an unreadable answer. */
export type UnreadableKind = "timeout" | "refused" | "not-found" | "unreachable" | "error";

export interface Unreadable {
  readonly agent: string;
  readonly kind: UnreadableKind;
}

export interface WaitingList {
  readonly items: readonly WaitingItem[];
  /** Agents that could not be read, with why — said on the page, never silently dropped. */
  readonly unreadable: readonly Unreadable[];
}

export type DecideResult =
  | { readonly ok: true; readonly outcome: "approved" | "cancelled" | "sent"; readonly message: string }
  | {
      readonly ok: false;
      /** `action-failed`: the answer was accepted, and the action then failed or was refused. */
      readonly reason: "decided-elsewhere" | "gone" | "refused" | "unavailable" | "action-failed";
      readonly message: string;
    };

/** What the page says when eve accepted an approval and the action's own result is not in yet. */
export const APPROVED_PENDING =
  "Approved. The agent will now carry out the action; its reply appears in the original conversation.";

export interface WaitingDeps {
  connect?: import("@lares/agent-kit/console-turn-authority").AuthorityPool["connect"];
  signedInMember(): Promise<Member | null>;
  query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  fetch: typeof fetch;
  /** The agents' route password, or undefined when none is mounted. Never logged. */
  routePassword(): string | undefined;
  /** Where the console says why it could not read an agent. Never given a secret. Defaults to the console log. */
  log?(line: string): void;
  now(): number;
  /** Whether this member is the installation's credential administrator, who owns agents that have
   *  no door or email claim. Absent: nobody is. */
  isAdministrator?(member: string): Promise<boolean>;
  /** Pause between checks for the agent's outcome after an answer. Injected so tests do not wait. */
  sleep(ms: number): Promise<void>;
}

interface WaitingSource {
  /** Must return by the time `signal` aborts (the page's overall deadline). */
  list(member: string, deps: WaitingDeps, signal: AbortSignal): Promise<WaitingList>;
  decide(member: string, key: string, actionId: string, deps: WaitingDeps): Promise<DecideResult>;
}

// ── Item ids ────────────────────────────────────────────────────────────────────────────────────

export function itemId(kind: WaitingKind, parts: readonly string[]): string {
  return `${kind}:${Buffer.from(JSON.stringify(parts)).toString("base64url")}`;
}

function parseItemId(id: string): { kind: WaitingKind; key: string } | null {
  const match = /^([a-z]+):([A-Za-z0-9_-]{1,2048})$/.exec(id);
  if (!match || !(match[1]! in SOURCES)) return null;
  return { kind: match[1] as WaitingKind, key: match[2]! };
}

// ── Owned agents and their doors ────────────────────────────────────────────────────────────────

const AGENT_NAME = /^[a-z][a-z0-9-]{1,30}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** eve mints a short random id for a card of the session's own, and `<child session>/<id>` for one
 *  a sub-agent relays. It is only ever compared, or sent in a JSON body. */
const INTERACTION_ID = /^[A-Za-z0-9_.:\/-]{1,200}$/;
const MEMBER_SHAPE = /^[^\s,;]+@[^\s,;]+$/;

/** Roles the engine no longer ships. The keeper skips an agent whose definition (or applied
 *  definition) carries one (`RETIRED_ROLES` in `services/keeper/lib/runtime-bindings.ts`), mirrored
 *  here because the console does not depend on the keeper: such an agent may still have a ready
 *  resource and a valid definition row, yet it is not managed, so it is never asked or named. */
const RETIRED_ROLES: ReadonlySet<string> = new Set(["travel"]);

interface OwnedAgent {
  readonly name: string;
  readonly address: string;
  readonly incarnation: string;
}

/** The doors a definition switches on — `doorsOf` in `@lares/agent-kit/definition`, mirrored
 *  because the console does not depend on the agent kit: `doors[]` when present, else every name
 *  in the older `channels[]`. */
function enabledDoors(doors: unknown, channels: unknown): Set<string> {
  if (Array.isArray(doors)) {
    return new Set(
      (doors as { kind?: unknown; enabled?: unknown }[])
        .filter((d) => d?.enabled === true && typeof d.kind === "string")
        .map((d) => d.kind as string),
    );
  }
  return new Set(Array.isArray(channels) ? (channels as unknown[]).filter((c): c is string => typeof c === "string") : []);
}

/**
 * Who an agent's console approver is, decided exactly as the keeper decides it when it starts the
 * agent (`connections()` in `services/keeper/lib/lifecycle.ts`, written into
 * `LARES_CONSOLE_PRINCIPAL` by `compose-agents.ts`): the APPLIED connection of each claimed door
 * (`applied_connection`, not the row's newer unapplied values) on the current incarnation, counted
 * only for a door the definition has switched on. Pure; one row per agent × claim. An agent with no
 * claim at all is the installation administrator's: the keeper hands it that address as its console
 * approver, so `administrator` (is this member the credential administrator?) owns it here.
 *
 * OWNED means this member is the ONLY such claimant. Any member can claim any door, so two members
 * may hold claims on one agent while its `LARES_CONSOLE_PRINCIPAL` names only one of them; with
 * two claimants the console cannot tell which, and offers the agent to neither. EXPORTED for tests.
 */
export function ownedFrom(rows: readonly Record<string, unknown>[], member: string, administrator = false): OwnedAgent[] {
  const agents = new Map<string, { agent: OwnedAgent | null; owners: Set<string> }>();
  for (const row of rows) {
    if (typeof row.name !== "string" || !AGENT_NAME.test(row.name)) continue;
    if (row.status === "retired" || row.state === "retired") continue;
    if ([row.role, row.applied_role].some((r) => typeof r === "string" && RETIRED_ROLES.has(r))) continue;
    let entry = agents.get(row.name);
    if (entry === undefined) {
      const address = vouchedAddress(row);
      entry = { agent: address ? { name: row.name, address, incarnation: row.incarnation as string } : null, owners: new Set() };
      agents.set(row.name, entry);
    }
    const claim = row.claim as { kind?: unknown; owner_email?: unknown } | null | undefined;
    if (!claim || typeof claim.kind !== "string" || typeof claim.owner_email !== "string") continue;
    if (!enabledDoors(row.doors, row.channels).has(claim.kind)) continue;
    entry.owners.add(claim.owner_email);
  }
  return [...agents.values()]
    .filter((e) => e.agent !== null && (e.owners.size === 0 ? administrator : e.owners.size === 1 && e.owners.has(member)))
    .map((e) => e.agent!);
}

/** The ready agents this member is the sole applied owner of, each with the private address the
 *  console may reach it on. The address comes from the registry, never from a request. */
async function ownedAgents(member: string, deps: WaitingDeps, only?: string): Promise<OwnedAgent[]> {
  const { rows } = await deps.query(
    `SELECT r.name, host(r.address) AS address, r.state, a.status, r.runtime_control_token,
       r.ownership_token AS incarnation, a.definition->'doors' AS doors, a.definition->>'role' AS role, r.applied_definition->>'role' AS applied_role, a.definition->'channels' AS channels,
       d.applied_connection AS claim
     FROM agent_resources r JOIN agent_definitions a ON a.name = r.name
     LEFT JOIN agent_door_connections d
       ON d.agent = r.name AND d.incarnation = r.ownership_token
      AND d.principal IS NOT NULL AND d.applied_connection IS NOT NULL
     WHERE r.state = 'ready' AND a.status = 'valid' AND ($1::text IS NULL OR r.name = $1)
     ORDER BY r.name`,
    [only ?? null],
  );
  // Only asked when some agent has no claim: the keeper answers a credential status request for the
  // administrator alone, so a successful answer is the proof.
  const unclaimed = rows.some((r) => !r.claim);
  const administrator = unclaimed && deps.isAdministrator ? await deps.isAdministrator(member).catch(() => false) : false;
  return ownedFrom(rows, member, administrator);
}

interface Conversation {
  readonly sessionId: string;
  readonly door: string;
}

/** Live conversations, newest first. A week back: a card older than a day can only be denied,
 *  and one older than that is not worth a page load. */
async function conversations(agent: OwnedAgent, deps: WaitingDeps, only?: string): Promise<Conversation[]> {
  const { rows } = await deps.query(
    `SELECT session_id, door FROM agent_conversations c
     WHERE agent = $1 AND incarnation = $2::uuid AND NOT terminal
       AND NOT EXISTS(SELECT 1 FROM console_session_bindings b WHERE b.agent=c.agent AND b.incarnation=c.incarnation AND b.session_id=c.session_id)
       AND observed_at > now() - interval '7 days' AND ($3::text IS NULL OR session_id = $3)
     ORDER BY observed_at DESC LIMIT 50`,
    [agent.name, agent.incarnation, only ?? null],
  );
  return rows
    .filter((r) => typeof r.session_id === "string" && SESSION_ID.test(r.session_id))
    .map((r) => ({ sessionId: r.session_id as string, door: String(r.door) }));
}

function channelOf(door: string): WaitingItem["channel"] {
  return door === "telegram" ? "Telegram" : door === "slack" ? "Slack" : "Web chat";
}

/** A read of an agent that failed, with the kind the page and the log report. Carries no response
 *  body, header or credential: only a kind and, for an HTTP answer, its status. */
class AgentReadError extends Error {
  constructor(readonly kind: UnreadableKind, readonly status?: number) {
    super(status === undefined ? kind : `${kind} ${status}`);
  }
}

/** What an HTTP status means for a read that needed a good answer. Pure. EXPORTED for tests. */
export function kindOfStatus(status: number): UnreadableKind {
  if (status === 401 || status === 403) return "refused";
  if (status === 404) return "not-found";
  return "error";
}

/** The kind of any failure while reading an agent. Pure. EXPORTED for tests. */
export function classifyReadFailure(error: unknown): { kind: UnreadableKind; status?: number } {
  if (error instanceof AgentReadError) return error.status === undefined ? { kind: error.kind } : { kind: error.kind, status: error.status };
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return { kind: "timeout" };
  if (error instanceof RangeError) return { kind: "error" };
  return { kind: "unreachable" };
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`${ROUTE_USERNAME}:${password}`).toString("base64")}`;
}

const READ_TIMEOUT_MS = 5000;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
/** The whole list call, every agent and session together. Past it the page shows what it has and
 *  names the agents it did not finish. */
export const LIST_DEADLINE_MS = 15000;
/** After an answer, only the newest lines can hold its outcome. eve accepts a negative
 *  `startIndex` as "this many LINES from the end" (`parseStartIndex` and
 *  `createSessionStreamResponse` in its `eve-channel/request.js`). */
const OUTCOME_TAIL = -500;
/** The one stream format this console reads (`x-eve-stream-version`). */
const STREAM_VERSION = "27";

/** One recorded event: its type and payload, when its line was written, and where it sits. */
export interface StreamFact {
  readonly type: string;
  readonly data: Record<string, unknown>;
  /** The time of the line that holds it, ISO 8601, or null when the line carried none. */
  readonly at: string | null;
  /** The stored line (zero-based, counted from the start of the session) and the index in it. */
  readonly position: { readonly line: number; readonly index: number };
}

/** Why a conversation was left out of the list. Fixed words only: this reaches the log. */
type SkipReason =
  | "its record was written in an earlier format"
  | "its stream is not a version this console reads"
  | "the agent no longer serves it (HTTP 409)"
  | "its record is no longer kept (HTTP 410)";

/** A conversation this console cannot read. Not a failure of the agent: the conversation is left
 *  out, with a log line, and the agent's other conversations are still read. */
class SkippedConversation extends Error {
  constructor(readonly reason: SkipReason) {
    super(reason);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The recorded events in one response body of eve's stream route, in order. Pure. EXPORTED for tests.
 *
 * `startLine` is the position of the first stored line the response sends. Each stored line —
 * `{ at, facts }` or `{ progress }` — moves the position on by one; a `{ "$eve": "position", next }`
 * mark says the response skipped ahead to `next`. Only facts are returned: a progress line is a
 * preview, and a later fact carries the finished value.
 *
 * A line shaped like an event of an earlier stream format (an object with its own `type`) means
 * the whole record is one this console cannot read, so it throws rather than guess at half of it.
 * A line that is not JSON at all is not a card; the rest of the stream still counts.
 */
export function readStreamLines(text: string, startLine = 0): StreamFact[] {
  const facts: StreamFact[] = [];
  let line = startLine;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    if (typeof value.$eve === "string") {
      if (value.$eve === "position" && typeof value.next === "number" && Number.isSafeInteger(value.next) && value.next > line) line = value.next;
      continue;
    }
    if (Array.isArray(value.facts) && typeof value.at === "string") {
      (value.facts as unknown[]).forEach((fact, index) => {
        if (!isRecord(fact) || typeof fact.type !== "string") return;
        facts.push({ type: fact.type, data: isRecord(fact.data) ? fact.data : {}, at: value.at as string, position: { line, index } });
      });
      line += 1;
      continue;
    }
    if (isRecord(value.progress)) {
      line += 1;
      continue;
    }
    if (typeof value.type === "string") throw new SkippedConversation("its record was written in an earlier format");
    line += 1;
  }
  return facts;
}

/** Recheck a bound console audience for every stream/decision. Native conversations retain
 * their existing applied-owner checks and get resolver metadata, never a fabricated binding. */
async function waitingHeaders(agent: OwnedAgent, sessionId: string, member: string, door: string, purpose: "read" | "resolver", deps: WaitingDeps): Promise<Record<string,string>> {
  const stable = await deps.signedInMember();
  if (!stable) throw new AgentReadError("refused");
  const {rows} = await deps.query("SELECT admission_nonce FROM console_session_bindings WHERE agent=$1 AND incarnation=$2::uuid AND session_id=$3",[agent.name,agent.incarnation,sessionId]);
  let nonce: string;
  let requestPurpose: string = purpose;
  if (rows.length) {
    const binding = await requireConsoleSessionBinding({agent:agent.name,incarnation:agent.incarnation,sessionId,memberId:stable.id},deps);
    nonce = binding.admissionNonce;
  } else {
    if (!["slack","telegram"].includes(door)) throw new AgentReadError("refused");
    nonce = randomBytes(32).toString("base64url");
    requestPurpose = `legacy-${purpose}`;
  }
  return {[MEMBER_HEADER]:member,[CONSOLE_MEMBER_ID_HEADER]:stable.id,[CONSOLE_ADMISSION_HEADER]:nonce,[CONSOLE_PURPOSE_HEADER]:requestPurpose};
}

/**
 * The session's recorded events, through eve's own stream route: all of them, or with
 * `startIndex` < 0 only that many lines from the end. The body is read through `bounded`
 * (`lib/chat-proxy.ts`), so a huge or never-ending stream costs at most `MAX_STREAM_BYTES` and
 * `READ_TIMEOUT_MS` (or less, when `signal` — the list's overall deadline — fires first). Throws
 * `AgentReadError` when the agent does not answer, and `SkippedConversation` when it answers with
 * a conversation this console cannot read.
 *
 * Why the list does NOT read only the tail: a pending approval stays answerable after later turns,
 * so it can sit anywhere in the record.
 */
async function sessionFacts(
  agent: OwnedAgent,
  sessionId: string,
  password: string,
  deps: WaitingDeps,
  opts: { member: string; door: string; startIndex?: number; signal?: AbortSignal },
): Promise<StreamFact[]> {
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]) : AbortSignal.timeout(READ_TIMEOUT_MS);
  const start = opts.startIndex === undefined ? "" : `&startIndex=${opts.startIndex}`;
  let text: string;
  let startLine = 0;
  try {
    const response = await deps.fetch(
      `http://${agent.address}:3000/eve/v1/session/${sessionId}/stream?includeTailIndex=1&follow=false${start}`,
      { method: "GET", headers: { authorization: basicAuth(password), accept: "application/x-ndjson", ...await waitingHeaders(agent,sessionId,opts.member,opts.door,"read",deps) }, redirect: "error", signal },
    );
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return [];
    }
    if (response.status === 409 || response.status === 410) {
      await response.body?.cancel().catch(() => {});
      throw new SkippedConversation(response.status === 409 ? "the agent no longer serves it (HTTP 409)" : "its record is no longer kept (HTTP 410)");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AgentReadError(kindOfStatus(response.status), response.status);
    }
    // Anything but the one format this console reads is left alone: an agent on another framework
    // version writes other event names, and reading them as if they were these would show nothing
    // or, worse, the wrong thing.
    if (response.headers.get("x-eve-stream-version") !== STREAM_VERSION) {
      await response.body?.cancel().catch(() => {});
      throw new SkippedConversation("its stream is not a version this console reads");
    }
    const tail = response.headers.get("x-eve-stream-tail-index");
    if (opts.startIndex !== undefined && opts.startIndex >= 0) startLine = opts.startIndex;
    else if (opts.startIndex !== undefined && tail !== null && /^-?\d{1,15}$/.test(tail)) startLine = Math.max(0, Number(tail) + 1 + opts.startIndex);
    text = new TextDecoder().decode(await bounded(response.body, MAX_STREAM_BYTES, signal));
  } catch (error) {
    if (error instanceof AgentReadError || error instanceof SkippedConversation) throw error;
    // Our own deadline (or the page's) fired: slow, whatever the runtime called the error.
    if (signal.aborted) throw new AgentReadError("timeout");
    const { kind, status } = classifyReadFailure(error);
    throw new AgentReadError(kind, status);
  }
  return readStreamLines(text, startLine);
}

// ── Approvals ───────────────────────────────────────────────────────────────────────────────────

interface PendingApproval {
  /** eve's id for the card. The answer names it. */
  readonly interactionId: string;
  readonly prompt: string;
  readonly toolName: string;
  /** The call whose `call.settled` says how the approved action went, or "" when this session's
   *  record does not hold that call (a card relayed from a sub-agent). */
  readonly callId: string;
  readonly input: unknown;
  readonly options: readonly { id: string; label: string }[];
  readonly at: string | null;
}

/** How a card ended. `approved` and `cancelled` are a person's decision (eve's `accepted` and
 *  `declined`); `other` is every ending in which nobody decided. */
type Resolution = "approved" | "cancelled" | "other";

/** How a call ended, from eve's `call.settled`: its `outcome` and, on failure, its
 *  `error.message` — e.g. the agent's own "approval refused: … is not an allowed approver". */
interface ActionOutcome {
  readonly status: string;
  readonly error: string | null;
}

/** What is still waiting in one session, how cards ended (by interaction id), and how calls ended
 *  (by call id). Pure: it reads only the facts it is given. */
export function readApprovals(facts: readonly unknown[]): {
  pending: PendingApproval[];
  resolved: Map<string, Resolution>;
  results: Map<string, ActionOutcome>;
} {
  const calls = new Map<string, { name: string; input: unknown }>();
  const asked = new Map<string, { approval: Omit<PendingApproval, "toolName" | "input">; subjectCallId: string; relayed: { name: string; input: unknown } | null }>();
  const resolved = new Map<string, Resolution>();
  const results = new Map<string, ActionOutcome>();
  let ended = false;
  for (const fact of facts) {
    if (!isRecord(fact) || !isRecord(fact.data)) continue;
    const data = fact.data;
    if (fact.type === "call.requested" && typeof data.callId === "string") {
      const capability = isRecord(data.capability) ? data.capability : {};
      calls.set(data.callId, { name: typeof capability.name === "string" ? capability.name : "", input: data.input });
    }
    if (fact.type === "interaction.opened" && isRecord(data.request)) {
      const request = data.request;
      if (request.kind !== "approval" || typeof data.interactionId !== "string" || !INTERACTION_ID.test(data.interactionId)) continue;
      const options = Array.isArray(request.options)
        ? (request.options as { id?: unknown; label?: unknown }[])
            .filter((o) => typeof o?.id === "string")
            .map((o) => ({ id: o.id as string, label: typeof o.label === "string" ? o.label : (o.id as string) }))
        : [];
      const subjectCallId = isRecord(data.subject) && typeof data.subject.callId === "string" ? data.subject.callId : "";
      // A card a sub-agent relays names the call it asks about itself (`origin.call`); this
      // session's own record holds only the call that delegated to the sub-agent.
      const origin = isRecord(data.origin) && isRecord(data.origin.call) ? data.origin.call : null;
      asked.set(data.interactionId, {
        approval: {
          interactionId: data.interactionId,
          prompt: typeof request.prompt === "string" ? request.prompt : "",
          callId: origin ? "" : subjectCallId,
          options,
          at: typeof fact.at === "string" ? fact.at : null,
        },
        subjectCallId,
        relayed: origin ? { name: typeof origin.name === "string" ? origin.name : "", input: origin.input } : null,
      });
    }
    if (fact.type === "interaction.settled" && typeof data.interactionId === "string") {
      resolved.set(data.interactionId, data.outcome === "accepted" ? "approved" : data.outcome === "declined" ? "cancelled" : "other");
    }
    if (fact.type === "call.settled" && typeof data.callId === "string" && typeof data.outcome === "string") {
      results.set(data.callId, { status: data.outcome, error: isRecord(data.error) && typeof data.error.message === "string" ? data.error.message : null });
    }
    if (fact.type === "session.ended") ended = true;
  }
  // Waiting means: asked, not settled, its call not finished, and a session still there to act.
  const pending = ended
    ? []
    : [...asked.values()]
        .filter((a) => !resolved.has(a.approval.interactionId) && !(a.subjectCallId !== "" && results.has(a.subjectCallId)))
        .map((a): PendingApproval => {
          const call = a.relayed ?? calls.get(a.subjectCallId);
          return { ...a.approval, toolName: call?.name ?? "", input: call?.input };
        });
  return { pending, resolved, results };
}

function isExpired(approval: PendingApproval, now: number): boolean {
  const at = approval.at === null ? NaN : Date.parse(approval.at);
  return !Number.isNaN(at) && now - at > APPROVAL_LIFETIME_MS;
}

export const EXPIRED_NOTE =
  "This was asked more than 24 hours ago, so the agent will no longer act on an approval. Deny it, or ask the agent again for a fresh one.";

function titleOf(prompt: string, toolName: string): string {
  const first = prompt.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const title = first || `Approve ${toolName || "an action"}`;
  return title.length > 140 ? `${title.slice(0, 139).trimEnd()}…` : title;
}

function approvalItem(agent: OwnedAgent, conversation: Conversation, approval: PendingApproval, now: number): WaitingItem {
  const expired = isExpired(approval, now);
  // The prompt, then every argument as its own labelled block (`lib/approval-text.ts` says why a
  // single joined text would let one value pose as another field), in full.
  const body: WaitingBody[] = [
    { format: "text", label: "What the agent asks", text: approval.prompt },
    ...approvalArguments(approval.input).map((field): WaitingBody => ({ format: "text", label: field.key, text: field.value })),
  ];
  // The two answers a card has. An option this page does not know is not offered: `decide` below
  // would refuse it, and a button that cannot work is worse than no button.
  const actions = approval.options
    .filter((o) => (o.id === "approve" || o.id === "deny") && !(expired && o.id === "approve"))
    .map((o): WaitingAction => ({ id: o.id, label: o.label, tone: o.id === "approve" ? "primary" : "neutral" }));
  return {
    id: itemId("approval", [agent.name, conversation.sessionId, approval.interactionId]),
    kind: "approval",
    agent: agent.name,
    channel: channelOf(conversation.door),
    createdAt: approval.at,
    title: titleOf(approval.prompt, approval.toolName),
    body,
    actions,
    ...(expired ? { note: EXPIRED_NOTE } : {}),
    ref: approval.interactionId,
  };
}

/** Runs `fn` over `items` with at most `limit` at once: one slow agent must not stall the page. */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

/** One console log line per conversation left out: the agent's name and a fixed reason. No session
 *  id, header or response body reaches it. */
function logSkipped(deps: WaitingDeps, agent: string, reason: SkipReason): void {
  (deps.log ?? ((l: string) => console.warn(l)))(`[waiting] skipped a conversation of agent ${agent}: ${reason}`);
}

/** One console log line per unreadable agent: its name and the kind of failure (and the HTTP
 *  status when there was one). Built from the kind and status only, so no password, header or
 *  response body can reach it. */
function logUnreadable(deps: WaitingDeps, agent: string, error: unknown): void {
  const { kind, status } = classifyReadFailure(error);
  const line = `[waiting] could not read agent ${agent}: ${kind}${status === undefined ? "" : ` (HTTP ${status})`}`;
  (deps.log ?? ((l: string) => console.warn(l)))(line);
}

const approvals: WaitingSource = {
  async list(member, deps, signal) {
    const password = deps.routePassword();
    const agents = await ownedAgents(member, deps);
    if (agents.length === 0) return { items: [], unreadable: [] };
    // No password mounted: the console cannot ask any agent; that is a refusal on our side.
    if (!password) {
      for (const a of agents) logUnreadable(deps, a.name, new AgentReadError("refused"));
      return { items: [], unreadable: agents.map((a) => ({ agent: a.name, kind: "refused" as const })) };
    }
    const items: WaitingItem[] = [];
    const unreadable = new Map<string, UnreadableKind>();
    const finished = new Set<string>();
    const now = deps.now();
    const work = Promise.all(
      agents.map(async (agent) => {
        let live: Conversation[];
        try {
          live = await conversations(agent, deps);
        } catch (error) {
          // The console's own database, not the agent: an error, not the agent's silence.
          unreadable.set(agent.name, "error");
          logUnreadable(deps, agent.name, new AgentReadError("error"));
          return;
        }
        // One failure says the agent is not answering: its other sessions are not tried, so a
        // stalled agent costs one read timeout, not fifty.
        let failed = false;
        await eachLimited(live, 6, async (conversation) => {
          if (failed || signal.aborted) return;
          try {
            const { pending } = readApprovals(await sessionFacts(agent, conversation.sessionId, password, deps, { signal, member, door:conversation.door }));
            for (const approval of pending) items.push(approvalItem(agent, conversation, approval, now));
          } catch (error) {
            // A conversation this console cannot read (an older record, say) is left out and
            // logged. It is not the agent failing: its other conversations are still read.
            if (error instanceof SkippedConversation) {
              logSkipped(deps, agent.name, error.reason);
              return;
            }
            if (failed) return;
            failed = true;
            unreadable.set(agent.name, classifyReadFailure(error).kind);
            logUnreadable(deps, agent.name, error);
          }
        });
        if (!failed && !signal.aborted) finished.add(agent.name);
      }),
    );
    // The page never waits past the deadline, even for a read that ignores its abort signal.
    await Promise.race([work, new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })))]);
    for (const agent of agents) {
      if (finished.has(agent.name) || unreadable.has(agent.name)) continue;
      unreadable.set(agent.name, "timeout");
      logUnreadable(deps, agent.name, new AgentReadError("timeout"));
    }
    // Oldest first: what has waited longest is what to look at first.
    const shown = [...items].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    return {
      items: shown,
      unreadable: agents.filter((a) => unreadable.has(a.name)).map((a) => ({ agent: a.name, kind: unreadable.get(a.name)! })),
    };
  },

  async decide(member, key, actionId, deps) {
    let parts: unknown;
    try {
      parts = JSON.parse(Buffer.from(key, "base64url").toString("utf8"));
    } catch {
      return { ok: false, reason: "gone", message: "That item could not be found." };
    }
    if (!Array.isArray(parts) || parts.length !== 3 || !parts.every((p) => typeof p === "string")) {
      return { ok: false, reason: "gone", message: "That item could not be found." };
    }
    const [name, sessionId, interactionId] = parts as [string, string, string];
    if (!AGENT_NAME.test(name) || !SESSION_ID.test(sessionId) || !INTERACTION_ID.test(interactionId) || !["approve", "deny"].includes(actionId)) {
      return { ok: false, reason: "gone", message: "That item could not be found." };
    }
    const password = deps.routePassword();
    if (!password) return { ok: false, reason: "unavailable", message: "The console cannot reach the agents: no route password is mounted." };

    // Owner of THIS agent, and a live conversation of ITS current incarnation — checked again here,
    // never trusted from the list the browser was shown.
    const [agent] = await ownedAgents(member, deps, name);
    if (!agent) return { ok: false, reason: "refused", message: "Only the owner of this agent can decide its approvals." };
    const [conversation] = await conversations(agent, deps, sessionId);
    if (!conversation) return { ok: false, reason: "gone", message: "That conversation has ended, so there is nothing left to decide." };

    // Still waiting? Decided elsewhere in the meantime is the common case, not an error. Answering a
    // request that is no longer pending would reach the agent as a stray message, so it is not sent.
    let state: ReturnType<typeof readApprovals>;
    try {
      state = readApprovals(await sessionFacts(agent, sessionId, password, deps, {member,door:conversation.door}));
    } catch (error) {
      if (error instanceof SkippedConversation) {
        logSkipped(deps, agent.name, error.reason);
        return { ok: false, reason: "gone", message: "That conversation can no longer be read, so there is nothing left to decide. Nothing was sent." };
      }
      return { ok: false, reason: "unavailable", message: `${agent.name} did not answer. Nothing was sent; try again in a moment.` };
    }
    const earlier = state.resolved.get(interactionId);
    if (earlier === "approved" || earlier === "cancelled") {
      return { ok: false, reason: "decided-elsewhere", message: `This was already ${earlier === "approved" ? "approved" : "denied"} elsewhere. Nothing more was sent.` };
    }
    // It ended with nobody deciding (withdrawn when a message was sent instead, say).
    if (earlier !== undefined) return { ok: false, reason: "gone", message: "This request is no longer waiting. Nothing was sent." };
    const approval = state.pending.find((p) => p.interactionId === interactionId);
    if (!approval) return { ok: false, reason: "gone", message: "This request is no longer waiting. Nothing was sent." };
    if (!approval.options.some((o) => o.id === actionId)) return { ok: false, reason: "refused", message: "That answer is not one this request offers." };
    if (actionId === "approve" && isExpired(approval, deps.now())) return { ok: false, reason: "refused", message: EXPIRED_NOTE };
    if (!MEMBER_SHAPE.test(member) || member.length > 320) {
      return { ok: false, reason: "refused", message: "The signed-in address is not one this console can vouch for to an agent." };
    }

    let response: Response;
    try {
      response = await deps.fetch(`http://${agent.address}:3000/eve/v1/session/${sessionId}`, {
        method: "POST",
        headers: { authorization: basicAuth(password), ...await waitingHeaders(agent,sessionId,member,conversation.door,"resolver",deps), "content-type": "application/json" },
        body: JSON.stringify({ answers: [{ interactionId, optionId: actionId }] }),
        redirect: "error",
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: "unavailable", message: `${agent.name} did not answer, so it is not known whether your answer arrived. Reload the page to see.` };
    }
    if (response.status === 409) {
      // eve's three refusals of an answer, told apart by its stable code and worded here.
      const code = await refusalCode(response);
      if (code === "session_not_ready") return { ok: false, reason: "unavailable", message: `${agent.name} is not ready to take an answer yet. Nothing was decided; try again in a moment.` };
      if (code === "session_stranded") return { ok: false, reason: "gone", message: "That conversation ended with an update, so there is nothing left to decide." };
      return { ok: false, reason: "gone", message: "That conversation has ended, so there is nothing left to decide." };
    }
    if (!response.ok) return { ok: false, reason: "unavailable", message: `${agent.name} refused the answer (HTTP ${response.status}). Nothing was decided.` };

    // eve accepts at once and settles on its next step. Look a few times for what happened, so the
    // page can say it — and never claim more than the stream shows. An approval that eve accepted
    // is not yet an action that ran: the tool still checks who approved, and may refuse or fail.
    let approved = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      await deps.sleep(750);
      let seen: ReturnType<typeof readApprovals>;
      try {
        seen = readApprovals(await sessionFacts(agent, sessionId, password, deps, { startIndex: OUTCOME_TAIL, member, door:conversation.door }));
      } catch {
        break;
      }
      const outcome = seen.resolved.get(interactionId);
      if (outcome === "cancelled") return { ok: true, outcome: "cancelled", message: `Denied. ${agent.name} will not do it.` };
      if (outcome === "other") return { ok: false, reason: "refused", message: `${agent.name} did not accept the answer. Nothing was done.` };
      if (outcome === "approved") approved = true;
      const result = approval.callId === "" ? undefined : seen.results.get(approval.callId);
      if (result?.status === "completed") {
        return { ok: true, outcome: "approved", message: `Approved, and ${agent.name} carried it out. Its reply appears in the ${channelOf(conversation.door)} conversation this came from.` };
      }
      if (result !== undefined) {
        return {
          ok: false,
          reason: "action-failed",
          message: `Your approval arrived, but the action did not go through${result.error ? `: ${result.error}` : "."}`,
        };
      }
    }
    if (approved) {
      return { ok: true, outcome: "approved", message: APPROVED_PENDING };
    }
    return { ok: true, outcome: "sent", message: `Your answer reached ${agent.name}; it has not confirmed it yet. Reload in a moment to see.` };
  },
};

/** The `code` of eve's JSON refusal, or null. Reads at most a few kilobytes and never throws. */
async function refusalCode(response: Response): Promise<string | null> {
  try {
    const body = JSON.parse(new TextDecoder().decode(await bounded(response.body, 4096, AbortSignal.timeout(READ_TIMEOUT_MS)))) as unknown;
    return isRecord(body) && typeof body.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

const proposals: WaitingSource = {
  list: (_member, deps) => listProposals(deps, (parts) => itemId("proposal", parts)),
  async decide(_member, key, actionId, deps) {
    let parts: unknown;
    try {
      parts = JSON.parse(Buffer.from(key, "base64url").toString("utf8"));
    } catch {
      return { ok: false, reason: "gone", message: "That item could not be found." };
    }
    return decideProposal(parts, actionId, deps);
  },
};

const SOURCES: Record<WaitingKind, WaitingSource> = { approval: approvals, proposal: proposals };

// ── The page's two calls ────────────────────────────────────────────────────────────────────────

export async function listWaiting(member: string, deps: WaitingDeps, deadlineMs: number = LIST_DEADLINE_MS): Promise<WaitingList> {
  const signal = AbortSignal.timeout(deadlineMs);
  const lists = await Promise.all(Object.values(SOURCES).map((source) => source.list(member, deps, signal)));
  return {
    items: lists.flatMap((l) => l.items).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")),
    unreadable: lists.flatMap((l) => l.unreadable),
  };
}

export async function decideWaiting(member: string, id: string, actionId: string, deps: WaitingDeps): Promise<DecideResult> {
  const parsed = parseItemId(id);
  if (!parsed) return { ok: false, reason: "gone", message: "That item could not be found." };
  return SOURCES[parsed.kind].decide(member, parsed.key, actionId, deps);
}
