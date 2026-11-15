// Delivery routing: which door each kind of unprompted message goes out through.
//
// The owner's choice lives in the agent's definition as an optional `delivery` map (message kind ->
// ordered door list). This file is the one place that names the kinds and the doors, says what an
// agent with NO map does today, and works out where a message goes given which doors are connected.
// It is pure: no I/O, no environment. The console keeps a mirror of the lists below (it does not
// import this package); `services/console/tests/engine-drift.test.ts` reads this file as text.
//
// THREE DOORS. `web` is the console inbox (a small table the console shows at the top of web chat);
// it exists on every installation, which is why it is the last resort for every kind. `slack` and
// `telegram` are chat apps and only exist once connected.

export const DELIVERY_DOORS = ["web", "slack", "telegram"] as const;
export type DeliveryDoor = (typeof DELIVERY_DOORS)[number];

/** Every kind of message an agent starts on its own, keyed by the schedule that sends it, with the
 *  door it goes to TODAY when the definition has no `delivery` map. A new kind is a new row here. */
export const DELIVERY_KINDS = {
  "morning-brief": "telegram",
  "evening-brief": "telegram",
  "weekly-summary": "telegram",
  reping: "telegram",
  deadlines: "telegram",
  "proposals-watch": "telegram",
  "email-triage": "slack",
  "meeting-followup": "slack",
  "outreach-reply-watch": "slack",
  "track-routing": "slack",
  digest: "slack",
  reminders: "telegram",
} as const satisfies Record<string, DeliveryDoor>;
export type DeliveryKind = keyof typeof DELIVERY_KINDS;

export function isDeliveryKind(x: string): x is DeliveryKind {
  return Object.prototype.hasOwnProperty.call(DELIVERY_KINDS, x);
}
export function isDeliveryDoor(x: string): x is DeliveryDoor {
  return (DELIVERY_DOORS as readonly string[]).includes(x);
}

/** The shape stored in a definition. Keys are kept as strings so a definition written by a newer
 *  engine still loads; `deliveryFindings` is what refuses an unknown kind at save. */
export type DeliveryMap = Record<string, readonly string[]>;

/** Plain names for messages the owner reads. */
export const DOOR_LABEL: Readonly<Record<DeliveryDoor, string>> = {
  web: "web chat",
  slack: "Slack",
  telegram: "Telegram",
};

/** Plain names for the kinds, as the owner reads them in the console and in "went to web chat" notes. */
export const DELIVERY_KIND_LABEL: Readonly<Record<DeliveryKind, string>> = {
  "morning-brief": "Morning brief",
  "evening-brief": "Evening brief",
  "weekly-summary": "Weekly summary",
  reping: "Nudges",
  deadlines: "Deadlines",
  "proposals-watch": "Proposals",
  "email-triage": "Email triage",
  "meeting-followup": "Meeting follow-up",
  "outreach-reply-watch": "Outreach replies",
  "track-routing": "track routing",
  digest: "Digest",
  reminders: "Reminders",
};

/** Problems with a `delivery` map, one plain sentence each. Empty = valid (and an absent map is valid). */
export function deliveryFindings(delivery: DeliveryMap | undefined): string[] {
  const out: string[] = [];
  for (const [kind, doors] of Object.entries(delivery ?? {})) {
    if (!isDeliveryKind(kind)) {
      out.push(`"${kind}" is not a kind of message this engine sends`);
      continue;
    }
    if (doors.length === 0) {
      out.push(`${kind} has no door - list at least one (web chat is always available)`);
      continue;
    }
    const seen = new Set<string>();
    for (const d of doors) {
      if (!isDeliveryDoor(d)) out.push(`${kind} names "${d}", which is not a door (web, slack or telegram)`);
      else if (seen.has(d)) out.push(`${kind} lists ${d} twice`);
      seen.add(d);
    }
  }
  return out;
}

/** The ordered doors a kind is TRIED through. With a map entry: the owner's list. Without one:
 *  today's single door (`routeFor` adds web chat after it, so nothing is dropped). */
export function configuredDoors(kind: DeliveryKind, delivery: DeliveryMap | undefined): DeliveryDoor[] {
  const listed = delivery?.[kind];
  if (!listed) return [DELIVERY_KINDS[kind]];
  return listed.filter(isDeliveryDoor);
}

export interface DeliveryRoute {
  /** The door the message goes through. Null is unreachable (web chat is always last) and kept only for the type. */
  door: DeliveryDoor | null;
  /** Doors skipped before reaching `door`, in order, each with the plain reason. */
  skipped: { door: DeliveryDoor; reason: string }[];
  /** "Morning brief went to web chat: Telegram is not connected" material; null on a first-choice send. */
  fallbackNote: string | null;
}

/**
 * Pick the door. Walk the owner's list and take the first connected door; if none is connected,
 * web chat - always. An agent with no map entry for this kind tries today's door first, then web chat.
 */
export function routeFor(
  kind: DeliveryKind,
  delivery: DeliveryMap | undefined,
  connected: (door: DeliveryDoor) => boolean,
  label: string = kind,
): DeliveryRoute {
  const order = configuredDoors(kind, delivery);
  if (!order.includes("web")) order.push("web");
  const skipped: DeliveryRoute["skipped"] = [];
  for (const door of order) {
    if (door === "web" || connected(door)) {
      return { door, skipped, fallbackNote: skipped.length === 0 ? null : noteFor(label, door, skipped) };
    }
    skipped.push({ door, reason: `${DOOR_LABEL[door]} is not connected` });
  }
  return { door: null, skipped, fallbackNote: null };
}

function noteFor(label: string, door: DeliveryDoor, skipped: DeliveryRoute["skipped"]): string {
  return `${label} went to ${DOOR_LABEL[door]}: ${skipped.map((s) => s.reason).join("; ")}`;
}

/** What a new agent gets: every kind -> its first connected chat door, then web chat. */
export function defaultDelivery(chatDoors: readonly DeliveryDoor[]): Record<DeliveryKind, DeliveryDoor[]> {
  const first = chatDoors.find((d) => d !== "web");
  const list: DeliveryDoor[] = first ? [first, "web"] : ["web"];
  return Object.fromEntries(Object.keys(DELIVERY_KINDS).map((k) => [k, [...list]])) as Record<DeliveryKind, DeliveryDoor[]>;
}

// ── A test brief the owner asks for from the console ───────────────────────────────────────────
//
// The console writes one request row (`workflow_jobs`, this workflow type); the morning brief's own
// every-minute run claims it and sends the brief into the chosen door under the schedule's own
// identity, so it is paid as an owner job exactly like a real brief. It is a reply to the owner,
// not an initiation: no gate, no ledger row, never counted as the day's brief (ADR-0014 rule 1).
// These strings are shared by the console, the chief of staff and the real-install check.

/** `workflow_jobs.workflow_type` of a test-brief request. No other runner may claim this type. */
export const TEST_BRIEF_WORKFLOW_TYPE = "test-brief";
/** The conversation lane the test brief's session carries (`attributes.lane`). */
export const TEST_BRIEF_LANE = "morning-brief-test";
/** The chat doors a test brief can be asked for. Never web chat. */
export const TEST_BRIEF_DOORS = ["slack", "telegram"] as const;
export type TestBriefDoor = (typeof TEST_BRIEF_DOORS)[number];
/** The fixed block that starts every test-brief prompt. */
export const TEST_BRIEF_PROMPT_MARKER =
  "[test brief — the owner pressed 'Send a test brief' in the console to check this chat. " +
  "Begin your message with the words 'Test brief'. Everything below is today's real material.]";
/** The prompt after the marker on a morning with nothing to say: a test is never silent. */
export const TEST_BRIEF_NOTHING_NEW_PROMPT =
  "There is nothing new today; a real brief would stay silent. Say so in one line.";
/** At most this many requests per agent in any 24 hours. */
export const TEST_BRIEF_DAILY_MAX = 10;
/** A pending request older than this is never claimed; a running one older than this is "outcome unknown". */
export const TEST_BRIEF_STALE_MINUTES = 10;
/**
 * What the agent writes into the request row's `result.outcome`:
 *  - `sent`: handed to the chat app's conversation (`result.sentAt`). Not "answered": eve's send
 *    resolves when the message is accepted, not when the agent's turn settles;
 *  - `door-not-connected`: the chosen door is not connected, claimed and applied on this agent;
 *  - `too-slow`: the brief was not ready within the test's time budget; nothing was sent;
 *  - `send-failed`: the chat app refused the hand-over; nothing was sent;
 *  - `send-unknown`: the hand-over did not finish within the budget; it may still arrive;
 *  - `pass-failed`: something else went wrong before the hand-over; nothing was sent.
 */
export const TEST_BRIEF_OUTCOMES = ["sent", "door-not-connected", "too-slow", "send-failed", "send-unknown", "pass-failed"] as const;
export type TestBriefOutcome = (typeof TEST_BRIEF_OUTCOMES)[number];
export function isTestBriefDoor(x: unknown): x is TestBriefDoor {
  return typeof x === "string" && (TEST_BRIEF_DOORS as readonly string[]).includes(x);
}
