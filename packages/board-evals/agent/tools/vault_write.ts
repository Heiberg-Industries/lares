// Named like the real tool, so the always-ask table and `capabilityOfTool` apply (atlas → the board's
// level decides).
import { appendFileSync } from "node:fs";
import { boardApproval } from "@lares/agent-kit/board-approval";
import { defineTool } from "eve/tools";
import { z } from "zod";
import manifest from "../../agent.json";
import "../../lib/file-board.js"; // the file-backed board, installed in THIS bundle's board-approval

export default defineTool({
  description: "Write a note (fixture).",
  inputSchema: z.object({ text: z.string() }),
  approval: boardApproval(manifest, "vault_write"),
  execute: async ({ text }) => {
    appendFileSync(process.env.BOARD_LOG!, `${text}\n`);
    return { written: text };
  },
});
