import { defineChannel, POST } from "eve/channels";
import { conversationResetRoute } from "@lares/agent-kit/conversation-route";
export default defineChannel({routes:[POST("/lares/runtime/conversations/reset",conversationResetRoute)]});
