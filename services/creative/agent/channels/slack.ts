// Binds the kit's Slack door (`@lares/agent-kit/slack-door`) to this role. eve finds the door by this
// file's path. This role has no scheduled conversations, so no continuity and no reply handler.
import { slackChannel } from "eve/channels/slack";

import { slackDoor } from "@lares/agent-kit/slack-door";

export const { authorizeSlackAnswer, onTurnSettled, onSessionEnded, slackDoorConfig } = slackDoor({
  role: "creative",
  // As before the door moved: a claim code gets no line back, and the refused reply after an
  // answered card (which this role cannot raise) is left to eve's own words.
  replyBeforeClaim: false,
  postsApprovalReplyRefusal: false,
});

export default slackChannel(slackDoorConfig);
