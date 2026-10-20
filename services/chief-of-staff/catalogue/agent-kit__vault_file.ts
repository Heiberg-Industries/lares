// This agent's `@lares/agent-kit` contribution, held directly in its own catalogue rather than
// reached through `agent/extensions/agent-kit/tools/vault_file.ts`. That
// mount file is an unconditional `disableTool` sentinel (see its own header), because
// a resolver-emitted tool under the same prefixed key (`agent-kit__vault_file`) replaces an
// authored/mounted tool of that name completely.
//
// Carries an approval (a vault write, gated the same way `agent-kit__vault_write` is; see that
// file's header). The resolver in `agent/tools/catalogue.ts` copies it across unconditionally,
// and `sourcesForTool` inspects this tool rather than going blind on the
// disabled mount file.
//
// Built here rather than re-exported, and narrowed to the private area alone: see
// `agent-kit__vault_write.ts`'s header.
//
// It names itself to the permissions board. `approvalFor` is `boardApproval` bound
// to this agent's declaration, and for a `vault` tool the AREA is the ratchet action, so
// the row read is `(agent, "vault", "private")`, the one the console renders as "Private notes".
// No per-action key is passed here, and none is wanted: the key is derived inside
// `boardApproval` from the tool's own area, and naming one here would override that derivation.
// With no row on the board the fallback is the declaration's own `vault: "gated"`.
// `assertApprovedCall` (the check against the card that was shown) is injected here rather than
// called inside the kit's factory; see `agent-kit__vault_write.ts`'s header for why.
import { approvalLedger, assertApprovedCall, callIdFrom } from "@lares/agent-kit/approval-ledger";
import { fileTool } from "@lares/agent-kit/note-write-tools";

import { approvalFor } from "../lib/board.js";
import { vaultWriteAreasForTurn } from "../lib/vault-areas.js";

export default fileTool({
  areas: vaultWriteAreasForTurn,
  approval: approvalFor("agent-kit__vault_file"),
  assertApprovedCall: (ctx: unknown, input: unknown) =>
    assertApprovedCall(approvalLedger(), { callId: callIdFrom(ctx), toolName: "agent-kit__vault_file", input }),
});
