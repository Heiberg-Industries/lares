// This role's `@lares/agent-kit` contribution, held directly in its OWN catalogue rather than
// reached through `agent/extensions/agent-kit/tools/vault_write.ts` (ORB-278 step 2, Task 9 — the
// same move Task 8 made for the travel role's one live kit tool, `agent-kit__transit_plan`). That
// override file is now an unconditional `disableTool()` sentinel — see its own header — because a
// resolver-emitted tool under the SAME prefixed key (`agent-kit__vault_write`) replaces an
// authored/mounted tool of that name completely (Task 1, Q1c; `agent/tools/catalogue.ts`'s own
// header), so leaving both live would either collide or silently double-resolve.
//
// UNLIKE `transit_plan`, this tool carries an approval — it writes a note into the owner's vault.
// Until W7A-s2 that was the kit factory's unconditional `always()` (the kit's own
// `packages/agent-kit/extension/lib/note-write-tools.ts`); it is the board's check now, see below.
// The resolver in `agent/tools/catalogue.ts` copies a catalogue entry's `.approval` across
// unconditionally, so the card survives the move; `packages/agent-kit/src/write-shape-lint.ts`'s
// `sourcesForTool` was fixed (Task 8 §11) specifically so this tool, once moved, stays inspected
// by the ungated-write lint rather than going blind on the disabled mount file.
//
// NO LONGER A THIN RE-EXPORT (W5C-s4), for the same reason `agent-kit__vault_read.ts` stopped
// being one: the shared object carries no area authority, because agent-kit cannot import this
// service's per-session definition read. This file builds its OWN instance, wired to
// `vaultWriteAreasForTurn`.
//
// THE CAPABILITY IS UNCHANGED. The entry in `catalogue/index.ts` stays `brain` until W5C-s6
// rewrites the grants and box 077 re-keys the recorded levels — a rename that moved it to `vault`
// now would turn every approved `brain` level into a lookup miss.
//
// NEVER WIDEN. This declaration grants `brain` AND `atlas`, so the session's granted areas are
// the private one AND the shared one — but the kit's write tools serve the private area alone
// (`KIT_WRITE_AREAS`), and `vaultWriteAreasForTurn` intersects the two. The tool writes exactly
// what the personal write tool wrote before the rename, and nothing else.
//
// W7A-s2 — AND IT NAMES ITSELF TO THE PERMISSIONS BOARD. Until now this tool's approval was the
// kit factory's hard-coded `always()`, so the board was never consulted: a 🚫 on "Private notes"
// did not refuse it and it wrote no `approval_events` row. `approvalFor` is `boardApproval` bound
// to this role's declaration, and for a `vault` tool the AREA is the ratchet action (W5C-s6b), so
// the row read is `(agent, "vault", "private")` — the one the console renders as "Private notes".
// No per-action key is passed here, and none is wanted: the key is derived inside
// `boardApproval` from the tool's own area, and naming one here would override that derivation.
// With no row on the board the fallback is the declaration's own `vault: "gated"`, which is the
// same card this tool has always shown.
// W7A-s6 — AND THE CARD IT WAS SHOWN. `assertApprovedCall` is injected here, not called inside
// the kit's factory: the extension bundle that factory lives in cannot import
// `@lares/agent-kit/approval-ledger` without pulling a second copy of it, and the database pool
// underneath it, into code `eve build` loads with no database (see `note-write-tools.ts`'s own
// header). This role already imports the ledger directly for its other twenty gated tools, so it
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
