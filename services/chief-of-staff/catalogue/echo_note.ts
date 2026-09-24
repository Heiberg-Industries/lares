/**
 * The approval-gate proof (Task 9).
 *
 * The shadow writes nothing real — Brain and Atlas are mounted read-only and no Gmail,
 * CRM, Notion or reminder capability is wired. But the gate that the cutover will hang
 * every one of those on has to be proven working BEFORE the cutover decision, not after,
 * so it is proven here on the most harmless write available: a line appended to a log file
 * inside the container's tmpfs, which nothing reads and a restart discards.
 *
 * What this exists to demonstrate, end to end: she proposes → Slack renders eve's native
 * approval → approve writes the line, reject writes nothing.
 */
import { appendFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { assertApproval, UnauthorizedApproverError } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

export { UnauthorizedApproverError };

const DEFAULT_LOG_PATH = "/tmp/eve-gate-proof.log";

export default defineTool({
  description:
    "Append a short note to this agent's proof log. A deliberately trivial write, used to " +
    "demonstrate that a human approval is required before anything is written. Requires " +
    "approval on every call.",
  inputSchema: z.object({ note: z.string() }),
  // Asks every time via approvalFor, not once(): a gate the user clears once and never sees
  // again is a different mechanism from the one the cutover needs, and would prove the wrong thing.
  approval: approvalFor("echo_note"),
  async execute(input, ctx) {
    await assertApproval(ctx, "echo_note", input);
    const { note } = input;
    const path = process.env["EVE_GATE_PROOF_LOG"] ?? DEFAULT_LOG_PATH;
    const line = `${new Date().toISOString()} ${note.replace(/\s+/gu, " ").trim()}`;
    appendFileSync(path, line + "\n", "utf8");
    return { path, written: line };
  },
});
