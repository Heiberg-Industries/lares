/**
 * Delivery routing, as the console shows and edits it: which door each kind of message an agent
 * starts on its own goes through.
 *
 * The kinds, the doors and what an agent with no saved choice does today are the kit's
 * (`@lares/agent-kit/delivery`, a dependency-free module, so this file can be imported by client
 * components). What lives here is only the grid's shape: the rows the owner sees, pre-filled with
 * today's behaviour when nothing is saved, and the conversion back to the definition's map.
 */
import {
  DELIVERY_DOORS, DELIVERY_KINDS, DELIVERY_KIND_LABEL, configuredDoors, defaultDelivery,
  type DeliveryDoor, type DeliveryKind, type DeliveryMap,
} from "@lares/agent-kit/delivery";

export { DELIVERY_DOORS, DELIVERY_KIND_LABEL, DOOR_LABEL } from "@lares/agent-kit/delivery";
export type { DeliveryDoor, DeliveryKind, DeliveryMap } from "@lares/agent-kit/delivery";

export const DELIVERY_KIND_LIST = Object.keys(DELIVERY_KINDS) as DeliveryKind[];

/** The ledger's item-key prefix per kind, so "this kind's latest message" can be found. Most are the kind itself. */
export const ITEM_PREFIX: Readonly<Record<DeliveryKind, string>> = {
  "morning-brief": "morning-brief",
  "evening-brief": "evening-brief",
  "weekly-summary": "weekly-summary",
  reping: "reping",
  deadlines: "deadline",
  "proposals-watch": "proposal",
  "email-triage": "email-triage",
  "meeting-followup": "meeting-followup",
  "outreach-reply-watch": "outreach",
  "track-routing": "track-routing",
  digest: "digest",
  reminders: "reminder",
};

/** One grid row: the doors in the order they are tried. */
export interface GridRow {
  kind: DeliveryKind;
  label: string;
  doors: DeliveryDoor[];
  /** True when nothing is saved for this kind and `doors` is today's behaviour, shown as a starting point. */
  fromToday: boolean;
}

/** Every kind, with the saved doors or - where nothing is saved - today's single door. */
export function gridFrom(delivery: DeliveryMap | undefined): GridRow[] {
  return DELIVERY_KIND_LIST.map((kind) => ({
    kind,
    label: DELIVERY_KIND_LABEL[kind],
    doors: configuredDoors(kind, delivery),
    fromToday: delivery?.[kind] === undefined,
  }));
}

/** The map to save: every kind, so what the grid shows is exactly what is stored. */
export function deliveryFromGrid(rows: readonly Pick<GridRow, "kind" | "doors">[]): Record<string, DeliveryDoor[]> {
  return Object.fromEntries(rows.map((r) => [r.kind, [...r.doors]]));
}

/** Rank per door (1 = first), 0 = not used. The select cells of the grid hold these. */
export type Ranks = Record<DeliveryDoor, number>;

export function ranksOf(doors: readonly DeliveryDoor[]): Ranks {
  const r: Ranks = { web: 0, slack: 0, telegram: 0 };
  doors.forEach((d, i) => { r[d] = i + 1; });
  return r;
}

export type RanksResult = { ok: true; doors: DeliveryDoor[] } | { ok: false; message: string };

/** Ranks back to an ordered list, or the plain sentence saying what to fix. */
export function doorsFromRanks(label: string, ranks: Ranks): RanksResult {
  const chosen = DELIVERY_DOORS.filter((d) => ranks[d] > 0);
  if (chosen.length === 0) return { ok: false, message: `${label}: pick a first door.` };
  const sorted = [...chosen].sort((a, b) => ranks[a] - ranks[b]);
  for (let i = 0; i < sorted.length; i++) {
    const rank = ranks[sorted[i]!];
    if (i > 0 && rank === ranks[sorted[i - 1]!]) {
      return { ok: false, message: `${label}: two doors are both marked ${ordinal(rank)}.` };
    }
    if (rank !== i + 1) {
      return { ok: false, message: `${label}: there is no ${ordinal(i + 1)} choice - number the doors 1st, 2nd, 3rd without gaps.` };
    }
  }
  return { ok: true, doors: sorted };
}

export function ordinal(n: number): string {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}

/**
 * The map a NEW agent starts with: every kind goes to its first chat door, then web chat; with no
 * chat door, web chat alone. Mirrors the kit's `defaultDelivery` by calling it.
 */
export { defaultDelivery };

/**
 * The definition a new agent is created with: a chief of staff that has no `delivery` yet gets the
 * default (every kind to its first declared chat door, then web chat). Anything else, and every
 * edit of an existing agent, is returned as it is.
 */
export function withStartingDelivery<D extends { delivery?: DeliveryMap; doors?: { kind: string }[]; channels: string[] }>(
  definition: D,
  role: string,
  creating: boolean,
): D & { delivery?: DeliveryMap } {
  if (!creating || role !== "chief-of-staff" || definition.delivery) return definition;
  const chatDoors = (definition.doors ?? definition.channels.map((kind) => ({ kind })))
    .map((d) => d.kind)
    .filter((k): k is "slack" | "telegram" => k === "slack" || k === "telegram");
  return { ...definition, delivery: defaultDelivery(chatDoors) };
}
