import { defineHook } from "eve/hooks";
import { observeConversation } from "@lares/agent-kit/conversation-control";
export default defineHook({events:{"*":(event,ctx)=>observeConversation(event,ctx)}});
