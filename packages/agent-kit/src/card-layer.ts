/**
 * THE CARD LAYER (ADR-0025): every rule about a card, written once for every door.
 *
 * A card is an approval ("may I send this?") or a question, shown with buttons. A tap is one press.
 * This module decides what a tap means; a door only hands it the tap and says what it is told.
 *
 *   - WHO MAY ANSWER. An approval: the owner (the same rule `approval-policy.ts` applies through
 *     eve's `response` policy, here asked before the answer is delivered so the person can be
 *     told). A question: the person it was put to. A card the record does not know: the owner's
 *     tap goes through to eve, anyone else's is refused. Web chat has no unknown card: it fails
 *     closed for everyone, the owner included, as before.
 *   - A LATE OR SECOND TAP. A card whose record says it is settled takes no answer; the person is
 *     told so. (eve's delivery step drops the same answer a second time in `patches/eve.patch`, so
 *     the rule holds even where a door did not ask first.)
 *   - THE SENTENCES. `card-sentences.ts`. A door passes them on and writes none.
 *   - A SHORTENED CARD (the owner's rule D-6). A door that has to cut a card offers no Approve on
 *     it, only Deny, and says where the whole of it can be read: a door that shows long cards
 *     whole, Slack first, web chat last.
 *
 * AN UNKNOWN DOOR FAILS CLOSED. A door is a row in {@link CARD_DOORS}; with no row, every tap is
 * refused and nothing is delivered. A new door gets every rule by adding its row and an adapter
 * that provides the five things in ADR-0025 rule 5: who sent it, the tap, the card address, one
 * private sentence, whether it can show buttons.
 *
 * What stays per door (rule 6): signature and secret checks, platform limits, how "privately" is
 * done, private chat or shared room, and when a conversation is replaced.
 */
import { getPool } from "./db.js";
import { ownerPrincipalId, type ChannelName } from "./principals.js";
import {
  CARD_NO_LONGER_WAITING,
  CARD_REFUSED,
  CARD_UNCHECKED,
  WEB_CHAT_NAME,
} from "./card-sentences.js";
import type { CardAddress } from "./approval-ledger.js";

/** What the layer knows about a door. */
export interface CardDoor {
  /** The name a person reads, in sentences about where to open a request. */
  readonly label: string;
  /** Whether the door shows a long card whole (every field, nothing cut). A door that does not
   *  is where a shortened card gets no Approve. */
  readonly showsLongCardWhole: boolean;
  /** Whether the door can show buttons at all (ADR-0025 rule 5, item 5). A door that cannot never
   *  lets typed text answer an approval. */
  readonly canShowButtons: boolean;
}

/**
 * One row per door that shows cards. In the order a person is pointed to when a card is too long:
 * Slack first, Telegram, web chat last. Slack's flag is false until Slack draws a long card whole
 * across blocks; flipping it is the whole change.
 */
export const CARD_DOORS: Readonly<Record<string, CardDoor>> = Object.freeze({
  slack: { label: "Slack", showsLongCardWhole: false, canShowButtons: true },
  telegram: { label: "Telegram", showsLongCardWhole: false, canShowButtons: true },
  console: { label: WEB_CHAT_NAME, showsLongCardWhole: true, canShowButtons: true },
});

export function isCardDoor(door: unknown): door is string {
  return typeof door === "string" && Object.hasOwn(CARD_DOORS, door);
}

/** The names of the doors that show a long card whole, best first. */
export function placesShowingWhole(): string[] {
  return Object.values(CARD_DOORS).filter((d) => d.showsLongCardWhole).map((d) => d.label);
}

/** The markers a cut leaves in a card's text: the kit's own notices (`approval-summary.ts`) and
 *  the framework patch's. A text with one was cut. */
const CUT_MARKERS = /— shortened —|\(shortened[,)]|…\(truncated\)/;

/** True when the text of a card shows the whole of what it is about. */
export function textShownWhole(text: string): boolean {
  return !CUT_MARKERS.test(text);
}

/**
 * Whether a card that was shown with this fact offers Approve. A card whose record does not say
 * "whole" (not known) counts as cut: it never gets Approve by default.
 */
export function cardOffersApprove(shownWhole: boolean | null | undefined): boolean {
  return shownWhole === true;
}

/* ------------------------------------------------------------------------------------------- *
 * The card record, read.
 * ------------------------------------------------------------------------------------------- */

export interface CardRecord {
  readonly requestId: string;
  readonly kind: "approval" | "question";
  readonly door: string | null;
  readonly putTo: string | null;
  readonly shownWhole: boolean | null;
  readonly actingMemberId: string | null;
  /** True while the record says the card still waits for an answer. */
  readonly waiting: boolean;
}

/** Anything that can run a query and return rows: the pool, a client, the console's own wrapper. */
export interface CardDb { query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }

type CardRow = {
  request_id: string; kind: string; door: string | null; put_to: string | null;
  shown_whole: boolean | null; acting_member_id: string | null; outcome: string | null; used_at: unknown;
};
const COLUMNS = "request_id, kind, door, put_to, shown_whole, acting_member_id, outcome, used_at";

function toRecord(row: CardRow): CardRecord {
  return {
    requestId: row.request_id,
    kind: row.kind === "question" ? "question" : "approval",
    door: row.door,
    putTo: row.put_to,
    shownWhole: row.shown_whole,
    actingMemberId: row.acting_member_id,
    waiting: row.outcome === null && row.used_at === null,
  };
}

/** How a tap names its card: by the request id eve gave it, or by where it sits on the platform. */
export type CardLookup =
  | { readonly requestId: string; readonly agent?: string; readonly sessionId?: string; readonly memberId?: string }
  | { readonly door: string; readonly address: CardAddress };

/** The card a tap names: `null` when the record has none, one row exactly or nothing (two rows are
 *  as good as none). Throws when the record cannot be read; {@link decideTap} turns that into the
 *  "could not check" outcome. */
export async function findCard(db: CardDb, lookup: CardLookup): Promise<CardRecord | null> {
  let result: { rows: Record<string, unknown>[] };
  if ("requestId" in lookup) {
    // Web chat narrows by the card's other coordinates (agent, conversation, member); the others
    // look it up by id alone, which is unique.
    const where = ["request_id = $1"], values: unknown[] = [lookup.requestId];
    for (const [column, value] of [["agent", lookup.agent], ["session_id", lookup.sessionId], ["acting_member_id", lookup.memberId]] as const) {
      if (value !== undefined) { values.push(value); where.push(`${column} = $${values.length}`); }
    }
    result = await db.query(`SELECT ${COLUMNS} FROM approval_asks WHERE ${where.join(" AND ")}`, values);
    // A lookup narrowed to a member only finds that member's card: the row carries it.
    const found = result.rows.length === 1 ? toRecord(result.rows[0] as unknown as CardRow) : null;
    return found !== null && lookup.memberId !== undefined ? { ...found, actingMemberId: lookup.memberId } : found;
  } else {
    result = await db.query(
      `SELECT ${COLUMNS} FROM approval_asks
        WHERE door = $1 AND card_address->>'channel' = $2 AND card_address->>'message' = $3`,
      [lookup.door, lookup.address.channel, lookup.address.message],
    );
  }
  return result.rows.length === 1 ? toRecord(result.rows[0] as unknown as CardRow) : null;
}

/* ------------------------------------------------------------------------------------------- *
 * The decision.
 * ------------------------------------------------------------------------------------------- */

/** One tap, as a door hands it over (ADR-0025 rule 5, item 2). */
export interface Tap {
  /** The door's name, a key of {@link CARD_DOORS}. */
  readonly door: string;
  /** The verified platform user id of the person who tapped (Slack user id, Telegram user id) or
   *  the signed-in member's id on web chat. `undefined` when the door could not name anybody. */
  readonly tapper: string | undefined;
  /** The cards the tap names. A door that knows request ids passes them; one that only knows
   *  where the card sits passes the address. No card named is an unknown card. */
  readonly cards: readonly CardLookup[];
}

export type TapVerdict =
  | { readonly deliver: true }
  | { readonly deliver: false; readonly why: "refused" | "settled" | "unchecked"; readonly sentence: string };

export interface CardLayerDeps {
  readonly db?: CardDb;
  /** The owner's id on a door. Default: the first id on the door's allow-list. */
  readonly ownerOf?: (door: string) => string | undefined;
}

const REFUSED: TapVerdict = { deliver: false, why: "refused", sentence: CARD_REFUSED };

/** The owner of an installation on a chat door. Web chat has no owner id of this kind. */
function defaultOwnerOf(door: string): string | undefined {
  return door === "slack" || door === "telegram" ? ownerPrincipalId(door as ChannelName) : undefined;
}

/**
 * Whether a tap counts. Fails closed on everything it does not understand: an unknown door, a tap
 * that names nobody, a record it cannot read for anybody but the owner.
 *
 * Web chat's tapper is the signed-in member and its rule is the card's own: the member the card
 * was raised for (`actingMemberId`). It has no owner id and no unknown card.
 */
export async function decideTap(tap: Tap, deps: CardLayerDeps = {}): Promise<TapVerdict> {
  if (!isCardDoor(tap.door)) return REFUSED;
  const tapper = typeof tap.tapper === "string" && tap.tapper.length > 0 ? tap.tapper : undefined;
  if (tapper === undefined) return REFUSED;
  const isConsole = tap.door === "console";
  let ownerId: string | undefined;
  try {
    ownerId = isConsole ? undefined : (deps.ownerOf ?? defaultOwnerOf)(tap.door);
  } catch {
    ownerId = undefined; // an owner id that cannot be read names nobody
  }
  const isOwner = ownerId !== undefined && ownerId === tapper;

  // No card named: the tap is on a card nobody can name. The owner's goes to eve, which decides.
  if (tap.cards.length === 0) return !isConsole && isOwner ? { deliver: true } : REFUSED;

  for (const lookup of tap.cards) {
    let card: CardRecord | null;
    try {
      card = await findCard(deps.db ?? getPool(), lookup);
    } catch {
      // The record cannot be read. The owner's tap still goes to eve (which refuses anything that
      // is not allowed and drops a late answer); everybody else's is held back.
      if (!isConsole && isOwner) continue;
      return { deliver: false, why: "unchecked", sentence: CARD_UNCHECKED };
    }
    if (card === null) {
      // Not in the record. Elsewhere the owner's tap passes to eve. Web chat fails closed for
      // everyone and says what it always said: the request is not waiting.
      if (isConsole) return { deliver: false, why: "settled", sentence: CARD_NO_LONGER_WAITING };
      if (isOwner) continue;
      return REFUSED;
    }
    if (!card.waiting) return { deliver: false, why: "settled", sentence: CARD_NO_LONGER_WAITING };
    const mayAnswer = isConsole
      ? card.actingMemberId !== null && card.actingMemberId === tapper
      : card.kind === "question"
        ? card.putTo !== null ? card.putTo === tapper : isOwner
        : isOwner;
    if (!mayAnswer) return REFUSED;
  }
  return { deliver: true };
}

/** The pool, for doors that have no other handle on the record. */
export function cardDb(): CardDb {
  return getPool();
}
