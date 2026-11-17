/**
 * slack-approval-card.ts - what the owner reads on a Slack approval card, for every role's Slack door.
 *
 * eve 1.0.1 posts an approval whose call has input as one card: a `container` block with the
 * title, a bounded preview of the call's raw arguments, and the Deny and Approve buttons. A call
 * without input gets eve's compact `card` block: the title and the buttons, nothing else.
 *
 * For a tool Lares summarises (`coversApproval`), the raw preview is the wrong reading material
 * twice over: the arguments are not the thing being authorised, and what the owner needs to read
 * (the subject and body of an email, the guests of an invitation) should still be on screen
 * after the answer, as the record of what was approved or denied. So for those tools this
 * renderer:
 *
 *  - asks eve for the card it draws for a call WITHOUT input (the compact `card`), so the raw
 *    preview is never drawn, and drops any separate raw-input message eve might add, and
 *  - puts `detailsForApproval(toolName, input)` in a section directly under the card, in the
 *    SAME message as the buttons. eve repaints that message in place when the request is
 *    answered or ends, and this renderer runs again for each repaint, so the section stays.
 *
 * Hiding the input from eve's default changes only what is drawn. The buttons eve draws for the
 * compact card carry the same actions and values as the ones in its container (eve checks
 * exactly that, see below), and the click still answers the real request with its real input.
 *
 * The other way to keep the draft would have been to post it as a thread message of our own
 * before the card. That leaves two messages to keep in step, one of which eve knows nothing
 * about, and a failed second post would leave a card with no draft or a draft with no card. One
 * message cannot come apart. The cost is that Slack sends this message back with every click;
 * the kit caps the text at 2,800 characters and says so on the card when it cuts, so the click
 * stays small.
 *
 * A tool WITHOUT a Lares summary (an outside tool among them) gets the same compact card with the
 * WHOLE call input under it, as JSON in a code block: its title is a generic one, and the request
 * is the only complete thing the owner has to read. eve 1.0.1's own preview would not do: it shows
 * at most ten arguments and about 1,500 characters, and cuts every value at 500. The input is cut
 * only when it does not fit in one Slack section (3,000 characters), and then the card says how
 * much is not shown (`shortenedNotice`), as eve's "Tool input" message on rc.10 cut at about the
 * same length. A call with no input at all keeps eve's card as it is.
 *
 * The renderer changes what is shown, never what a click does. eve's controls pass through
 * exactly as `next` rendered them, which eve checks: a result that adds, drops or alters a
 * control is thrown away and eve's own card is posted instead. This file must stay pure and
 * synchronous, and it reads nothing but the card it is given. The text goes to the owner in
 * Slack only; nothing here is fed to the model.
 *
 * Every role's Slack door (`slack-door.ts`) installs this one renderer; there is no per-role copy.
 */
import {
  defineSlackRenderer,
  type BlockKitBlock,
  type SlackInteractionCard,
  type SlackInteractionCardParts,
} from "eve/channels/slack";
import { coversApproval, detailsForApproval, shortenedNotice } from "./approval-summary.js";

/** Slack refuses a section whose text is longer than this. The kit stays under it on its own
 *  (`DETAILS_MAX_LENGTH`); this is the check that it did. */
const SLACK_SECTION_TEXT_LIMIT = 3000;

/** The same card with the call's input taken out, so eve's default draws its compact card and
 *  no raw-input preview. Only the copy handed to eve's renderer changes. */
function withoutCallInput(card: SlackInteractionCard): SlackInteractionCard {
  const { call } = card.interaction;
  if (call === undefined) return card;
  const { input: _input, ...rest } = call;
  return { ...card, interaction: { ...card.interaction, call: rest as typeof call } };
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
 * The call's whole input as the owner reads it: pretty JSON in a code block, escaped, within one
 * Slack section. Over the limit it is cut, marked "…", and the card says how many characters are
 * not shown. `undefined` when there is no input to show.
 */
function wholeInputText(input: unknown): string | undefined {
  const json = JSON.stringify(input ?? {}, null, 2);
  if (json === undefined || json === "{}") return undefined;
  const escaped = escapeMrkdwn(json);
  const fenced = (body: string) => "```\n" + body + "\n```";
  if (fenced(escaped).length <= SLACK_SECTION_TEXT_LIMIT) return fenced(escaped);
  // Room for the fences, the "…" and the widest notice; never stop inside an escaped character.
  const room = SLACK_SECTION_TEXT_LIMIT - fenced("…").length - shortenedNotice(escaped.length).length;
  const shown = escaped.slice(0, room).replace(/&[a-z]*$/u, "");
  // Count the hidden characters in the input as written, not in its escaped form, so the
  // notice never says more is hidden than is.
  const hidden = json.length - unescapeMrkdwn(shown).length;
  return fenced(`${shown}…`) + shortenedNotice(hidden);
}

/** eve's compact card for the call without its input, with Lares's text in a section under it. */
function compactCardWith(
  card: SlackInteractionCard,
  next: (card: SlackInteractionCard) => SlackInteractionCardParts,
  sectionText: string,
): SlackInteractionCardParts {
  const parts = next(withoutCallInput(card));
  const section: BlockKitBlock = { type: "section", text: { type: "mrkdwn", text: sectionText } };
  return {
    controls: {
      blocks: [...parts.controls.blocks, section],
      // The notification preview and screen readers get the text too, not the title alone.
      text: `${parts.controls.text}\n${sectionText}`,
    },
  };
}

/**
 * `renderers.interactionCard` for the Slack door. Exported on its own so tests can call it with
 * eve's real default card as `next`.
 */
export function approvalInteractionCard(
  card: SlackInteractionCard,
  next: (card: SlackInteractionCard) => SlackInteractionCardParts,
): SlackInteractionCardParts {
  const { call, request } = card.interaction;
  if (request.kind !== "approval" || call === undefined) return next(card);
  // No Lares summary: the whole input under eve's compact card. No input: eve's card as it is.
  if (!coversApproval(call.name)) {
    const whole = wholeInputText(call.input);
    return whole === undefined ? next(card) : compactCardWith(card, next, whole);
  }

  const draft = detailsForApproval(call.name, call.input);
  // Never cut what is being authorised without saying so. The kit shortens and says so; if a
  // text ever arrives over Slack's limit anyway, show the whole input instead of a silent cut.
  if (draft !== undefined && draft.length > SLACK_SECTION_TEXT_LIMIT) {
    const whole = wholeInputText(call.input);
    return whole === undefined ? next(card) : compactCardWith(card, next, whole);
  }

  // A summarised tool with nothing more to show: the card alone, without the raw input.
  if (draft === undefined) return { controls: next(withoutCallInput(card)).controls };
  return compactCardWith(card, next, draft);
}

/** The renderer the Slack door installs. */
export const approvalCardRenderer = defineSlackRenderer({ interactionCard: approvalInteractionCard });
