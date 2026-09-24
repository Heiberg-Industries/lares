// This role's `@lares/agent-kit` contribution, held directly in its OWN catalogue rather than
// reached through `agent/extensions/agent-kit/tools/vault_drop.ts` (ORB-278 step 2, Task 9). That
// override file is now an unconditional `disableTool()` sentinel — see its own header — because
// a resolver-emitted tool under the same prefixed key (`agent-kit__vault_drop`) replaces an
// authored/mounted tool of that name completely (Task 1, Q1c).
//
// Carries an approval (a vault DELETE, gated the same way `agent-kit__vault_write` is — see that
// file's header) — the resolver in `agent/tools/catalogue.ts` copies it across unconditionally,
// and `sourcesForTool` (Task 8 §11) inspects this moved tool rather than going blind on the
// disabled mount file. It is also an always-ask `delete` in `always-ask.ts`'s table, under its
// new name, exactly as it was under the old one.
//
// Built here rather than re-exported (W5C-s4), and narrowed to the private area alone: see
// `agent-kit__vault_write.ts`'s header for both, and for why the catalogue entry's capability
// stays `brain` in this slice.
//
// W7A-s2 — AND IT NAMES ITSELF TO THE PERMISSIONS BOARD. Until now this tool's approval was the
// kit factory's hard-coded `always()`, so the board was never consulted: a 🚫 on "Private notes"
// did not refuse it and it wrote no `approval_events` row. `approvalFor` is `boardApproval` bound
// to this role's declaration, and for a `vault` tool the AREA is the ratchet action (W5C-s6b), so
// the row read is `(agent, "vault", "private")` — the one the console renders as "Private notes".
// No per-action key is passed here, and none is wanted: the key is derived inside
// `boardApproval` from the tool's own area, and naming one here would override that derivation.
// With no row on the board the fallback is the declaration's own `vault: "gated"`, which is the
// same card this tool has always shown. AND THIS ONE KEEPS ASKING WHATEVER THE DIAL SAYS: it is
// `["delete"]` in `TOOL_CATEGORIES`, and `mustAlwaysAsk` outranks an `autonomous` level — a rule
// no setting can loosen (owner decision A1). 🚫 still refuses it, because 🚫 only tightens.
// W7A-s6 — AND THE CARD IT WAS SHOWN. See `agent-kit__vault_write.ts`'s header for why this is
// injected here rather than called inside the kit's factory.
import { approvalLedger, assertApprovedCall, callIdFrom } from "@lares/agent-kit/approval-ledger";
import { dropTool } from "@lares/agent-kit/note-write-tools";

import { approvalFor } from "../lib/board.js";
import { vaultWriteAreasForTurn } from "../lib/vault-areas.js";

export default dropTool({
  areas: vaultWriteAreasForTurn,
  approval: approvalFor("agent-kit__vault_drop"),
  assertApprovedCall: (ctx: unknown, input: unknown) =>
    assertApprovedCall(approvalLedger(), { callId: callIdFrom(ctx), toolName: "agent-kit__vault_drop", input }),
});
