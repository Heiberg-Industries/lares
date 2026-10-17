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
  "crm-routing": "slack",
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
  "crm-routing": "CRM routing",
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
 *  today's single door (and nothing after it - an agent without a map keeps today's behaviour). */
export function configuredDoors(kind: DeliveryKind, delivery: DeliveryMap | undefined): DeliveryDoor[] {
  const listed = delivery?.[kind];
  if (!listed) return [DELIVERY_KINDS[kind]];
  return listed.filter(isDeliveryDoor);
}

export interface DeliveryRoute {
  /** The door the message goes through, or null when nothing can carry it (no-map agent only). */
  door: DeliveryDoor | null;
  /** Doors skipped before reaching `door`, in order, each with the plain reason. */
  skipped: { door: DeliveryDoor; reason: string }[];
  /** "Morning brief went to web chat: Telegram is not connected" material; null on a first-choice send. */
  fallbackNote: string | null;
}

/**
 * Pick the door. Walk the owner's list and take the first connected door; if none is connected,
 * web chat - always. An agent with no map entry for this kind gets today's door only: connected,
 * or nothing (the schedule logs and skips, exactly as before).
 */
export function routeFor(
  kind: DeliveryKind,
  delivery: DeliveryMap | undefined,
  connected: (door: DeliveryDoor) => boolean,
  label: string = kind,
): DeliveryRoute {
  const mapped = delivery?.[kind] !== undefined;
  const order = configuredDoors(kind, delivery);
  if (mapped && !order.includes("web")) order.push("web");
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
