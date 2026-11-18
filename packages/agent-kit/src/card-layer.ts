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
import { ownerPrincipalId } from "./principals.js";
import {
  CARD_NO_LONGER_WAITING,
  CARD_REFUSED,
  CARD_UNCHECKED,
  CONSOLE_WAITING_PAGE_NAME,
  DOOR_NAMES,
  textShownWhole,
  type ShortenedCardPlace,
} from "./card-sentences.js";
import type { CardAddress } from "./approval-ledger.js";

/** What the layer knows about a door. A door is one row here and an adapter; nothing else in the
 *  layer names a door. */
export interface CardDoor {
  /** The name of the door a person reads. */
  readonly label: string;
  /** Where a person is sent to read and approve a card this door had to shorten, in words that are
   *  true of that place ("Slack" for a door that shows a long card whole; the console's page for
   *  the door that does not hold the conversation). Only read when {@link showsLongCardWhole}. */
  readonly whereToOpen: string;
  /** Whether {@link whereToOpen} has a page address the sentence can give (the console does). */
  readonly opensWithLink: boolean;
  /** Whether the door shows a long card whole (every field, nothing cut, as many messages or blocks
   *  as it takes). A door that does not is where a shortened card gets no Approve. */
  readonly showsLongCardWhole: boolean;
  /** Whether the door lists the cards that were raised on OTHER doors. A card is only on the door
   *  it was raised on, except in the console's Waiting on you page, which lists every door's. So
   *  only a door that does this can be where a person is sent to read a card raised elsewhere. */
  readonly listsCardsFromEveryDoor: boolean;
  /** Whether this door is connected for the person who answers (the installation's owner, for an
   *  approval): a door the person cannot reach is never named as a place to go. Read from what the
   *  process already holds (the allow-list); absent means always connected. */
  readonly connected?: (env: NodeJS.ProcessEnv) => boolean;
  /** Whether the door can show buttons at all (ADR-0025 rule 5, item 5). A door that cannot never
   *  lets typed text answer an approval. */
  readonly canShowButtons: boolean;
  /** Who may answer an approval card: the installation's owner on this door, or the member the
   *  card was raised for (a door whose conversations are each one member's). */
  readonly answeredBy: "owner" | "card-member";
  /** What a tap on a card the record does not know does: the owner's goes through to eve and
   *  nobody else's does, or the card counts as no longer waiting for everybody. */
  readonly unknownCard: "owner-goes-through" | "not-waiting";
  /** The owner's id on this door, when {@link answeredBy} is "owner". */
  readonly ownerId?: (env?: NodeJS.ProcessEnv) => string | undefined;
}

/**
 * One row per door that shows cards. In the order a person is pointed to when a card is too long:
 * Slack first, Telegram, the console last. Slack draws a long card whole across blocks, so its row
 * says so; it lists only the cards raised on Slack, so a card cut elsewhere is not sent there.
 */
export const CARD_DOORS: Readonly<Record<string, CardDoor>> = Object.freeze({
  slack: {
    label: DOOR_NAMES["slack"]!, whereToOpen: "Slack", opensWithLink: false, showsLongCardWhole: true, listsCardsFromEveryDoor: false,
    connected: (env) => ownerPrincipalId("slack", env) !== undefined, canShowButtons: true,
    answeredBy: "owner", unknownCard: "owner-goes-through", ownerId: (env) => ownerPrincipalId("slack", env),
  },
  telegram: {
    label: DOOR_NAMES["telegram"]!, whereToOpen: "Telegram", opensWithLink: false, showsLongCardWhole: false, listsCardsFromEveryDoor: false,
    connected: (env) => ownerPrincipalId("telegram", env) !== undefined, canShowButtons: true,
    answeredBy: "owner", unknownCard: "owner-goes-through", ownerId: (env) => ownerPrincipalId("telegram", env),
  },
  console: {
    label: DOOR_NAMES["console"]!, whereToOpen: CONSOLE_WAITING_PAGE_NAME, opensWithLink: true, showsLongCardWhole: true, listsCardsFromEveryDoor: true, canShowButtons: true,
    answeredBy: "card-member", unknownCard: "not-waiting",
  },
});

export function isCardDoor(door: unknown): door is string {
  return typeof door === "string" && Object.hasOwn(CARD_DOORS, door);
}

/**
 * Where a person is sent to read a card too long for the door it came on: the doors that show a
 * long card whole, are connected for this person, and hold this card, best first. The input of
 * {@link shortenedCardSentence}.
 *
 * A card is on the door it was raised on and in the console's Waiting on you page, so the places
 * are the doors that list every door's cards. A door that shows long cards whole but lists only its
 * own (Slack) is not named for a card that was cut somewhere else: a sentence that named it would
 * send a person to look for a request that is not there.
 */
export function placesShowingWhole(
  env: NodeJS.ProcessEnv = process.env,
  doors: Readonly<Record<string, CardDoor>> = CARD_DOORS,
): ShortenedCardPlace[] {
  return Object.values(doors)
    .filter((d) => d.showsLongCardWhole && d.listsCardsFromEveryDoor && isConnected(d, env))
    .map((d) => ({ where: d.whereToOpen, hasLink: d.opensWithLink }));
}

function isConnected(door: CardDoor, env: NodeJS.ProcessEnv): boolean {
  try {
    return door.connected === undefined || door.connected(env);
  } catch {
    return false; // a door whose state cannot be read is not named
  }
}

/**
 * The console's Waiting on you page for one request, from `LARES_CONSOLE_URL`, or null when it is
 * unset or not an http(s) address. The page selects the request by eve's interaction id
 * (`?request=<id>`).
 */
export function waitingPageLink(interactionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env["LARES_CONSOLE_URL"]?.trim();
  if (!raw) return null;
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  const url = new URL("waiting", base.href.endsWith("/") ? base.href : `${base.href}/`);
  url.searchParams.set("request", interactionId);
  return url.href;
}

export { textShownWhole };

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
  /** The owner's id on a door, replacing the row's. Default: the row's `ownerId`. */
  readonly ownerOf?: (door: string) => string | undefined;
}

const REFUSED: TapVerdict = { deliver: false, why: "refused", sentence: CARD_REFUSED };

/**
 * Whether a tap counts. Fails closed on everything it does not understand: an unknown door, a tap
 * that names nobody, a record it cannot read for anybody but the owner.
 *
 * What differs between doors is in the door's row ({@link CardDoor}): who answers an approval and
 * what an unknown card means. A door whose cards are the conversation member's answers only from
 * the member the card was raised for (`actingMemberId`).
 */
export async function decideTap(tap: Tap, deps: CardLayerDeps = {}): Promise<TapVerdict> {
  if (!isCardDoor(tap.door)) return REFUSED;
  const door = CARD_DOORS[tap.door]!;
  const tapper = typeof tap.tapper === "string" && tap.tapper.length > 0 ? tap.tapper : undefined;
  if (tapper === undefined) return REFUSED;
  const ownerAnswers = door.answeredBy === "owner";
  let ownerId: string | undefined;
  try {
    ownerId = ownerAnswers ? (deps.ownerOf ?? ((name: string) => CARD_DOORS[name]?.ownerId?.()))(tap.door) : undefined;
  } catch {
    ownerId = undefined; // an owner id that cannot be read names nobody
  }
  const isOwner = ownerId !== undefined && ownerId === tapper;
  const ownerGoesThrough = door.unknownCard === "owner-goes-through" && isOwner;

  // No card named: the tap is on a card nobody can name.
  if (tap.cards.length === 0) return ownerGoesThrough ? { deliver: true } : REFUSED;

  for (const lookup of tap.cards) {
    let card: CardRecord | null;
    try {
      card = await findCard(deps.db ?? getPool(), lookup);
    } catch {
      // The record cannot be read. Where the owner's tap may go to eve unchecked, it does (eve
      // refuses anything that is not allowed and drops a late answer); everybody else is held back.
      if (ownerGoesThrough) continue;
      return { deliver: false, why: "unchecked", sentence: CARD_UNCHECKED };
    }
    if (card === null) {
      if (door.unknownCard === "not-waiting") return { deliver: false, why: "settled", sentence: CARD_NO_LONGER_WAITING };
      if (ownerGoesThrough) continue;
      return REFUSED;
    }
    if (!card.waiting) return { deliver: false, why: "settled", sentence: CARD_NO_LONGER_WAITING };
    const mayAnswer = !ownerAnswers
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
