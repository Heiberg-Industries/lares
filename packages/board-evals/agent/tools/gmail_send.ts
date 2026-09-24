// Named like the real tool, so the always-ask table and `capabilityOfTool` apply. `gmail_send` is a
// history-checked contact tool (RECIPIENTS_OF in @lares/agent-kit/always-ask): at "autonomous" it
// reads the recipients from the call's `to` field. This fixture's input is `{ text }` — no `to` — so
// the recipient list is unreadable and the call LOCKS to a card. No contact history is wired in here,
// so the eval proves the lock path, not the known-recipient path (agent-kit's unit tests cover that).
import { appendFileSync } from "node:fs";
import { boardApproval } from "@lares/agent-kit/board-approval";
import { defineTool } from "eve/tools";
import { z } from "zod";
import manifest from "../../agent.json";
import "../../lib/file-board.js"; // the file-backed board, installed in THIS bundle's board-approval

export default defineTool({
  description: "Send mail (fixture).",
  inputSchema: z.object({ text: z.string() }),
  approval: boardApproval(manifest, "gmail_send"),
  execute: async ({ text }) => {
    appendFileSync(process.env.BOARD_LOG!, `sent:${text}\n`);
    return { written: text };
  },
});
