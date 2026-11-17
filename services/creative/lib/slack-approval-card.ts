/**
 * lib/slack-approval-card.ts - what the owner reads on a Slack approval card.
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
 * A tool WITHOUT a Lares summary keeps eve's card untouched, raw input preview included: its
 * title is a generic one, and the request is the only complete thing the owner has to read.
 *
 * The renderer changes what is shown, never what a click does. eve's controls pass through
 * exactly as `next` rendered them, which eve checks: a result that adds, drops or alters a
 * control is thrown away and eve's own card is posted instead. This file must stay pure and
 * synchronous, and it reads nothing but the card it is given. The text goes to the owner in
 * Slack only; nothing here is fed to the model.
 *
 * This lives in `lib/`, not beside `agent/channels/slack.ts`: eve treats every file under
 * `agent/channels/` as a channel of its own, named after the file.
 *
 * The same file exists at `services/chief-of-staff/lib/slack-approval-card.ts`. Keep the two identical
 * but for this paragraph: the kit is where shared code belongs, and a new kit entry point needs a
 * `package.json` change this work was not allowed to make.
 */
import {
  defineSlackRenderer,
  type BlockKitBlock,
  type SlackInteractionCard,
  type SlackInteractionCardParts,
} from "eve/channels/slack";
import { coversApproval, detailsForApproval } from "@lares/agent-kit/approval-summary";

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
  // No Lares summary: eve's card as it is, with the request on it.
  if (!coversApproval(call.name)) return next(card);

  const draft = detailsForApproval(call.name, call.input);
  // Never cut what is being authorised without saying so. The kit shortens and says so; if a
  // text ever arrives over Slack's limit anyway, show eve's own card rather than a silent cut.
  if (draft !== undefined && draft.length > SLACK_SECTION_TEXT_LIMIT) return next(card);

  const parts = next(withoutCallInput(card));
  // A summarised tool with nothing more to show: the card alone, without the raw input.
  if (draft === undefined) return { controls: parts.controls };

  const draftBlock: BlockKitBlock = { type: "section", text: { type: "mrkdwn", text: draft } };
  return {
    controls: {
      blocks: [...parts.controls.blocks, draftBlock],
      // The notification preview and screen readers get the draft too, not the title alone.
      text: `${parts.controls.text}\n${draft}`,
    },
  };
}

/** The renderer the Slack door installs. */
export const approvalCardRenderer = defineSlackRenderer({ interactionCard: approvalInteractionCard });
