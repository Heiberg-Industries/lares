// This agent's `@lares/agent-kit` contribution, held directly in its own catalogue rather than
// reached through `agent/extensions/agent-kit/tools/vault_write.ts`. That
// mount file is an unconditional `disableTool` sentinel (see its own header), because a
// resolver-emitted tool under the SAME prefixed key (`agent-kit__vault_write`) replaces an
// authored/mounted tool of that name completely (`agent/tools/catalogue.ts`'s own
// header), so leaving both live would either collide or silently double-resolve.
//
// Unlike `transit_plan`, this tool carries an approval: it writes a note into the owner's vault.
// That approval is the permissions board's check (see below), not the kit factory's unconditional
// `always` (the kit's own `packages/agent-kit/extension/lib/note-write-tools.ts`).
// The resolver in `agent/tools/catalogue.ts` copies a catalogue entry's `.approval` across
// unconditionally, and `packages/agent-kit/src/write-shape-lint.ts`'s
// `sourcesForTool` inspects this tool here so it stays covered
// by the ungated-write lint rather than going blind on the disabled mount file.
//
// Not a thin re-export: the shared object carries no area authority, because agent-kit cannot
// import this service's per-session definition read. This file builds its own instance, wired to
// `vaultWriteAreasForTurn`.
//
// NEVER WIDEN. This declaration grants `brain` AND `atlas`, so the session's granted areas are
// the private one AND the shared one, but the kit's write tools serve the private area alone
// (`KIT_WRITE_AREAS`), and `vaultWriteAreasForTurn` intersects the two. The tool writes only
// the private area.
//
// It names itself to the permissions board. `approvalFor` is `boardApproval` bound
// to this agent's declaration, and for a `vault` tool the AREA is the ratchet action, so
// the row read is `(agent, "vault", "private")`, the one the console renders as "Private notes".
// No per-action key is passed here, and none is wanted: the key is derived inside
// `boardApproval` from the tool's own area, and naming one here would override that derivation.
// With no row on the board the fallback is the declaration's own `vault: "gated"`.
// `assertApprovedCall` (the check against the card that was shown) is injected here, not called
// inside the kit's factory: the extension bundle that factory lives in cannot import
// `@lares/agent-kit/approval-ledger` without pulling a second copy of it, and the database pool
// underneath it, into code `eve build` loads with no database (see `note-write-tools.ts`'s own
// header). This agent already imports the ledger directly for its other gated tools, so it
// supplies the check the same way here.
import { approvalLedger, assertApprovedCall, callIdFrom } from "@lares/agent-kit/approval-ledger";
import { writeTool } from "@lares/agent-kit/note-write-tools";

import { approvalFor } from "../lib/board.js";
import { vaultWriteAreasForTurn } from "../lib/vault-areas.js";

export default writeTool({
  areas: vaultWriteAreasForTurn,
  approval: approvalFor("agent-kit__vault_write"),
  assertApprovedCall: (ctx: unknown, input: unknown) =>
    assertApprovedCall(approvalLedger(), { callId: callIdFrom(ctx), toolName: "agent-kit__vault_write", input }),
});
