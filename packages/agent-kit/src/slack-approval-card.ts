/**
 * slack-approval-card.ts - what the owner reads on a Slack approval card, for every role's Slack door.
 *
 * The card's CONTENT is the kit's one card shape (`approval-summary.ts`, `approvalCardShape`): a
 * title line, then the exact change being approved with every detail. This file only DRAWS it for
 * Slack: eve's compact card (the title and the buttons) with the body in sections under it, in the
 * SAME message as the buttons. eve repaints that message in place when the request is answered or
 * ends, and this renderer runs again for each repaint, so the body stays on screen after the
 * answer as the record of what was approved or denied.
 *
 * SLACK SHOWS A LONG CARD WHOLE. A section holds at most 3,000 characters and a message at most 50
 * blocks (Slack's Block Kit limits, the same numbers as eve's `public/channels/slack/limits.js`).
 * The body is split across as many sections as it needs, so a long note, draft or calendar change
 * is read in full, with Approve, and the card record says it was shown whole.
 *
 * THE RULE FOR A CARD THAT DOES NOT FIT (the owner's rule D-6): a body that needs more blocks than
 * one message has left is cut, the card says how many characters are not shown and where the whole
 * request can be read, and it offers no Approve. Deny stays. eve rejects a renderer result whose
 * controls differ from its own, so the Approve button is taken off by `patches/eve.patch` (a hunk in
 * eve's Slack card code that asks {@link slackCardCut}), not here. The same function decides the
 * mark in the card record, so the mark and the card cannot disagree.
 *
 * Hiding the input from eve's default changes only what is drawn. The buttons eve draws for the
 * compact card carry the same actions and values as the ones in its container (eve checks exactly
 * that, see above), and the click still answers the real request with its real input.
 *
 * The other way to keep the draft would have been to post it as a thread message of our own
 * before the card. That leaves two messages to keep in step, one of which eve knows nothing
 * about, and a failed second post would leave a card with no draft or a draft with no card. One
 * message cannot come apart. The cost is that Slack sends this message back with every click.
 *
 * The renderer changes what is shown, never what a click does. This file must stay pure and
 * synchronous: it reads nothing but the card it is given (and, for the address of the console page
 * and which doors are connected, the environment, which does not change while a process runs). The
 * text goes to the owner in Slack only; nothing here is fed to the model.
 *
 * Every role's Slack door (`slack-door.ts`) installs this one renderer; there is no per-role copy.
 */
import {
  defineSlackRenderer,
  type BlockKitBlock,
  type SlackInteractionCard,
  type SlackInteractionCardParts,
} from "eve/channels/slack";
import { approvalCardShape, coversApproval, shortenedNotice, type CardBodyPart } from "./approval-summary.js";
import { placesShowingWhole, waitingPageLink } from "./card-layer.js";
import { CARD_OUTCOME_TEXT, shortenedCardSentence } from "./card-sentences.js";

/** Slack refuses a section whose text is longer than this (Block Kit: section text, 3,000). */
export const SLACK_SECTION_TEXT_LIMIT = 3000;

/** Slack refuses a message with more blocks than this (Block Kit: 50 blocks per message). */
export const SLACK_BLOCKS_PER_MESSAGE = 50;

/** The blocks in eve's compact approval card: one `card` block holding the title and the buttons
 *  (`tests/slack-approval-card.test.ts` renders eve's real default and checks this number). */
export const COMPACT_CARD_BLOCKS = 1;

/** The notification text (what a phone shows, what a screen reader reads) holds the title and the
 *  start of the body, never more than this; Slack's own limit is 40,000 and advises 4,000. */
const NOTIFICATION_TEXT_LIMIT = 3000;

/** The room a code fence takes in a section: "```\n" before and "\n```" after. */
const FENCE_LENGTH = 8;

/** The same card with the call's input taken out, so eve's default draws its compact card and
 *  no raw-input preview. Only the copy handed to eve's renderer changes. The input rides along
 *  under another name (`laresInput`) so that the framework patch, which decides from the request
 *  whether Approve is left off, sees the same request on this copy as on eve's own card: eve
 *  rejects a card whose buttons differ from its own. */
function withoutCallInput(card: SlackInteractionCard): SlackInteractionCard {
  const { call } = card.interaction;
  if (call === undefined) return card;
  const { input, ...rest } = call;
  return { ...card, interaction: { ...card.interaction, call: { ...rest, laresInput: input } as typeof call } };
}

/** Slack mrkdwn reads `<…>` as a link or mention and `&` as an entity, inside a code block too. */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The reverse of `escapeMrkdwn`, for counting characters as the input has them. */
function unescapeMrkdwn(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Cuts `text` into pieces of at most `max` characters that put back together to the same text,
 * breaking at a blank line, a line or a space when one is near the end of the piece, and never
 * inside an escaped character such as `&amp;`.
 */
function splitText(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const half = max / 2;
    let cut = max;
    const blank = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    if (blank > half) cut = blank + 2;
    else if (line > half) cut = line + 1;
    else if (space > half) cut = space + 1;
    const entity = /&[a-z]{0,4}$/u.exec(rest.slice(0, cut));
    if (entity !== null && entity.index > 0) cut = entity.index;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) pieces.push(rest);
  // A section of nothing but space is not a section Slack accepts, and there is nothing in it to read.
  return pieces.filter((p) => p.trim() !== "");
}

/** One section of the card and the number of characters of the request it carries, as written. */
interface Piece {
  readonly text: string;
  readonly size: number;
}

function piecesOf(part: CardBodyPart): Piece[] {
  if (part.kind === "text") {
    return splitText(part.text, SLACK_SECTION_TEXT_LIMIT).map((text) => ({ text, size: unescapeMrkdwn(text).length }));
  }
  return splitText(escapeMrkdwn(part.text), SLACK_SECTION_TEXT_LIMIT - FENCE_LENGTH).map((chunk) => ({
    text: "```\n" + chunk.replace(/\n$/u, "") + "\n```",
    size: unescapeMrkdwn(chunk).length,
  }));
}

/** What the sections of a card come to. */
export interface SlackCardLayout {
  /** The sections to draw under the card, in order. */
  readonly sections: readonly string[];
  /** True when every character of the body is in them. */
  readonly whole: boolean;
  /** How many characters of the request are not shown (0 when whole). */
  readonly hidden: number;
}

/**
 * Lays the body out in sections. `controlsBlocks` is how many blocks the card's own message
 * already holds. When the rest does not fit in one message, the last block is kept for the notice
 * that something was cut, so nothing is cut without saying so.
 */
export function layoutSlackCard(body: readonly CardBodyPart[], controlsBlocks: number): SlackCardLayout {
  const pieces = body.flatMap(piecesOf);
  const room = Math.max(0, SLACK_BLOCKS_PER_MESSAGE - controlsBlocks);
  if (pieces.length <= room) return { sections: pieces.map((p) => p.text), whole: true, hidden: 0 };
  const kept = Math.max(0, room - 1);
  return {
    sections: pieces.slice(0, kept).map((p) => p.text),
    whole: false,
    hidden: pieces.slice(kept).reduce((n, p) => n + p.size, 0),
  };
}

const section = (text: string): BlockKitBlock => ({ type: "section", text: { type: "mrkdwn", text } });

/** What the owner is told, in the last section, about a card that did not fit: how much is not
 *  shown and, while it can still be answered, where to read it and that Deny works. */
function cutNotice(hidden: number, open: boolean, cardId: string, env: NodeJS.ProcessEnv): string {
  const count = shortenedNotice(hidden).trim();
  return open ? `${count}\n${shortenedCardSentence(placesShowingWhole(env), waitingPageLink(cardId, env))}` : count;
}

/** eve's compact card for the call without its input, with the body in sections under it. */
function compactCardWith(
  card: SlackInteractionCard,
  next: (card: SlackInteractionCard) => SlackInteractionCardParts,
  body: readonly CardBodyPart[],
  env: NodeJS.ProcessEnv,
): SlackInteractionCardParts {
  const parts = next(withoutCallInput(card));
  const layout = layoutSlackCard(body, parts.controls.blocks.length);
  // Without the framework patch's hook nothing takes Approve off a card, so a cut card would carry
  // a notice that is false: leave the card to eve.
  if (!layout.whole && typeof globalThis.__eveSlackCardCut !== "function") return next(card);
  const texts = [...layout.sections];
  if (!layout.whole) {
    const open = card.interaction.status === "open" && card.interaction.answer === undefined;
    texts.push(cutNotice(layout.hidden, open, card.interaction.interactionId, env));
  }
  // The notification preview and screen readers get the start of the text too, not the title alone.
  const text = `${parts.controls.text}\n${texts.join("\n")}`.slice(0, NOTIFICATION_TEXT_LIMIT);
  return { controls: { blocks: [...parts.controls.blocks, ...texts.map(section)], text } };
}

/**
 * The line a settled approval card ends with, in the kit's words (`CARD_OUTCOME_TEXT`), the same as
 * on every other door. eve's own line is "Approve by <@U>" with a green tick even for Deny, and
 * "No longer needed" for a request nobody answered. Who answered stays, as Slack shows it. Only an
 * open or settled approval whose first block is eve's compact card with a subtext is touched; the
 * buttons and the body are not.
 */
export function settledOutcomeLine(card: SlackInteractionCard): string | undefined {
  const { interaction } = card;
  if (interaction.request.kind !== "approval" || interaction.status !== "settled") return undefined;
  const outcome = (interaction as { outcome?: unknown }).outcome;
  const line = outcome === "accepted" ? CARD_OUTCOME_TEXT.approved : outcome === "declined" ? CARD_OUTCOME_TEXT.denied : CARD_OUTCOME_TEXT.notApproved;
  const by = typeof card.answeredBy === "string" && card.answeredBy !== "" && (outcome === "accepted" || outcome === "declined") ? ` by <@${card.answeredBy}>` : "";
  return `${line}${by}`;
}

function withOutcomeLine(card: SlackInteractionCard, parts: SlackInteractionCardParts): SlackInteractionCardParts {
  const line = settledOutcomeLine(card);
  const [first, ...rest] = parts.controls.blocks as BlockKitBlock[];
  if (line === undefined || first === undefined || first.type !== "card") return parts;
  const changed = { ...first, subtext: { type: "mrkdwn", text: line, verbatim: false } } as BlockKitBlock;
  return { ...parts, controls: { ...parts.controls, blocks: [changed, ...rest] } };
}

/**
 * `renderers.interactionCard` for the Slack door. Exported on its own so tests can call it with
 * eve's real default card as `next`.
 */
export function approvalInteractionCard(
  card: SlackInteractionCard,
  next: (card: SlackInteractionCard) => SlackInteractionCardParts,
  env: NodeJS.ProcessEnv = process.env,
): SlackInteractionCardParts {
  return withOutcomeLine(card, drawnApprovalCard(card, next, env));
}

function drawnApprovalCard(
  card: SlackInteractionCard,
  next: (card: SlackInteractionCard) => SlackInteractionCardParts,
  env: NodeJS.ProcessEnv = process.env,
): SlackInteractionCardParts {
  const { call, request } = card.interaction;
  if (request.kind !== "approval" || call === undefined) return next(card);
  const shape = approvalCardShape(call.name, call.input);
  if (shape.body.length === 0) {
    // A call with no input and no summary: eve's card as it is. A summarised tool whose title says
    // all of it: the compact card alone, without the raw input.
    return coversApproval(call.name) ? { controls: next(withoutCallInput(card)).controls } : next(card);
  }
  return compactCardWith(card, next, shape.body, env);
}

/**
 * Whether the Slack card for this call shows everything it is about: the title and the whole body,
 * with nothing cut. The same layout the renderer draws, so the record of a posted card says what
 * the card said.
 */
export function slackCardShownWhole(toolName: string, input: unknown): boolean {
  return layoutSlackCard(approvalCardShape(toolName, input).body, COMPACT_CARD_BLOCKS).whole;
}

/**
 * Whether a card eve POSTED shows everything: the kit's layout is whole AND every section of it is
 * among the blocks in the message. eve draws its own card instead of ours when it rejects a
 * renderer result or when Slack refuses the message; that card shows a short preview of the
 * request, so the record must not call it whole. (eve checks a card's buttons against its own, so
 * the buttons cannot tell the two apart.) `blocks` are the posted message's, from eve's state.
 */
export function slackCardPostedWhole(toolName: string, input: unknown, blocks: unknown): boolean {
  const layout = layoutSlackCard(approvalCardShape(toolName, input).body, COMPACT_CARD_BLOCKS);
  if (!layout.whole) return false;
  if (layout.sections.length === 0) return true;
  if (!Array.isArray(blocks)) return false;
  const posted = new Set<string>();
  for (const block of blocks as Array<{ type?: unknown; text?: { text?: unknown } }>) {
    if (block?.type === "section" && typeof block.text?.text === "string") posted.add(block.text.text);
  }
  return layout.sections.every((section) => posted.has(section));
}

/** True when the Slack card for this call could not show the whole request, so it offers no Approve. */
export function slackCardCut(toolName: unknown, input: unknown): boolean {
  return typeof toolName === "string" && !slackCardShownWhole(toolName, input);
}

declare global {
  // eslint-disable-next-line no-var
  var __eveSlackCardCut: ((toolName: unknown, input: unknown) => boolean) | undefined;
}

/** Publishes {@link slackCardCut} for the framework patch, which edits compiled eve code that
 *  cannot import from this workspace. Without it, eve's buttons are left as they are. */
export function installSlackCardHook(): void {
  globalThis.__eveSlackCardCut = slackCardCut;
}

/** The renderer the Slack door installs. */
export const approvalCardRenderer = defineSlackRenderer({
  interactionCard: (card, next) => approvalInteractionCard(card, next),
});
