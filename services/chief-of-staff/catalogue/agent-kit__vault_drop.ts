// This agent's `@lares/agent-kit` contribution, held directly in its own catalogue rather than
// reached through `agent/extensions/agent-kit/tools/vault_drop.ts`. That
// mount file is an unconditional `disableTool` sentinel (see its own header), because
// a resolver-emitted tool under the same prefixed key (`agent-kit__vault_drop`) replaces an
// authored/mounted tool of that name completely.
//
// Carries an approval (a vault DELETE, gated the same way `agent-kit__vault_write` is; see that
// file's header). The resolver in `agent/tools/catalogue.ts` copies it across unconditionally,
// and `sourcesForTool` inspects this tool rather than going blind on the
// disabled mount file. It is also an always-ask `delete` in `always-ask.ts`'s table.
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
// This tool keeps asking whatever the dial says: it is
// `["delete"]` in `TOOL_CATEGORIES`, and `mustAlwaysAsk` outranks an `autonomous` level, a rule
// no setting can loosen. A refusal on the board still refuses it, because a refusal only tightens.
// At execution the call goes through `assertApproval`, the same check every other gated tool makes:
// when a card was answered, the person who ANSWERED it (`ctx.approval.responder`) must be the
// owner, and the call must be the one the card showed (`assertApprovedCall`); with no card, the
// session's own caller must be an allowed approver. It is injected here, in place of the kit's
// requester-only check, because on eve 1.0 the requester of a scheduled job's card is the app.
// A private Console conversation is not offered this tool (`private-console-surface.ts`), so a
// call bound to one is refused here rather than read as a door's card.
import { isExactApprovalContext } from "@lares/agent-kit/approval-execution";
import { dropTool } from "@lares/agent-kit/note-write-tools";

import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";
import { vaultWriteAreasForTurn } from "../lib/vault-areas.js";

export default dropTool({
  areas: vaultWriteAreasForTurn,
  approval: approvalFor("agent-kit__vault_drop"),
  assertApproval: async (ctx: unknown, input: unknown) => {
    if (isExactApprovalContext(ctx)) throw new Error("A Vault note delete is not available in a private Console conversation");
    await assertApproval(ctx as never, "agent-kit__vault_drop", input);
  },
});
