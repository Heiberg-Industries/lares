// Save a note to one area of the Vault — for this role, the shared area. GATED WRITE: `vault` is
// `write-with-confirm` in the agent's grants and `gated` in its autonomy block (agent.json), so this is
// the one tool that changes the business knowledge store, and the approval card is the
// last thing between the model and a durable, pushed commit.
//
// It takes a required `area` input and the same injected authority as the reads. THE GATE
// MOVED WITH THE CAPABILITY, ON PURPOSE: `approvalFor("vault_write")` names this tool to the same board policy, and
// `capabilityOfTool` now answers `vault` (the tool moved into `CAPABILITY_DOCS["vault"].tools`
// via `VAULT_SHARED_TOOLS`). The rule that the area is the action keeps
// that safe: no per-action key is passed here either, but `boardApproval`/`approvalFor` derive
// one from the tool's own area (`areaOfTool("vault_write")` — "shared"), so the ratchet row read
// is `(agent, "vault", "shared")` — 1:1 with the old `(agent, "atlas", "")` row, which a
// migration re-keys to exactly that. A rename that had left the row keyed on the bare capability would
// have merged this lane with every other vault write's.
//
// NEVER WIDEN. `vaultWriteAreasForTurn` is the granted areas intersected with the one area this
// tool serves (`lib/vault-areas.ts`), so it writes the shared store and nothing else — the same
// guarantee being bound to `storeRoot("atlas")` at construction used to give, now enforced
// against the declaration as well as against the code.
//
// PARITY WITH THE OLD WRITE TOOL, DELIBERATELY. This ports the old
// agent-runtime atlas write tool: the model supplies
// `{title, body, tags?}` and the PATH IS DERIVED — it is never an input. An earlier draft took
// a store-relative `path` from the model, which would have let the agent overwrite any note in the
// store, including hand-written brand notes. That is a capability widening, and this is a port:
// the goal is the old behaviour plus an approval card, not a broader write.
//
// TRAVERSAL IS UNREPRESENTABLE, NOT MERELY REFUSED. `inboxNotePath` maps every character
// outside [a-z0-9] to a hyphen, so `../../etc/passwd` becomes `_inbox/etc-passwd.md` and
// `.git/config` becomes `_inbox/git-config.md`. That matters more than it looks: the kit's
// `resolveInStore` containment refuses absolute paths, `..` and symlink escape, but does NOT
// exclude in-store dotfile directories — a model-supplied `.git/config` would have clobbered
// the file on disk before `git add --` ever rejected it. Deriving the path removes the class.
//
// THE APPROVER RE-CHECK IS NOT REDUNDANT with the channel allowlist. eve's own docs say
// built-in HITL buttons are handled BEFORE `onInteraction`, and "anyone who can interact with
// the Slack message can answer it" — so the click that authorises this never walks the inbound
// allowlist. eve's own remedy is a re-check inside the tool. That is the first line of
// `execute`, and it runs BEFORE the area is resolved, exactly as it did before the rename.
// See `lib/principals.ts` for the whole argument.
//
// NO CREDENTIAL OR PATH READ AT MODULE SCOPE: `storeRootForArea(area)` throws when the area's
// path is unset and `eve build` runs with no env at all, so it is called inside `execute`.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { inboxNotePath } from "@lares/agent-kit/note-paths";
import { storeRootForArea } from "@lares/agent-kit/notes-store";
import { NOTE_AREAS } from "@lares/agent-kit/note-tools";
import { commitNote } from "@lares/agent-kit/vault-git";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";
import { thisAgent } from "../lib/definition.js";
import { vaultWriteAreasForTurn } from "../lib/vault-areas.js";

export default defineTool({
  description:
    "Save a note to the shared area of the Vault — the business knowledge store — into its " +
    "_inbox queue, committed and pushed. The filename is derived from the title, so a second " +
    'note with the same title replaces the first. Say which area: "shared" is the only one ' +
    "this tool writes, and an area this agent was not granted is refused. Requires the " +
    "owner's 👍.",
  inputSchema: z.object({
    area: z.enum(NOTE_AREAS),
    title: z.string().min(1),
    body: z.string(),
    tags: z.array(z.string()).optional(),
  }),
  approval: approvalFor("vault_write"),
  async execute(input, ctx) {
    await assertApproval(ctx, "vault_write", input);
    const { area, title, body, tags } = input;

    const open = await vaultWriteAreasForTurn(ctx);
    if (!open.includes(area)) {
      throw new Error(`the "${area}" area of the Vault was not granted to this agent`);
    }
    // The agent's own name from its definition: the provenance and the commit attribution below.
    const { loaded } = await thisAgent(ctx.session?.id);
    const agentName = loaded.definition.name;

    return commitNote({
      vaultRoot: storeRootForArea(area),
      path: inboxNotePath(title),
      // Normalised, not passed through. The old tool forced `type` and defaulted `tags`,
      // and stamped `source`/`owner` from the agent name. Without the
      // normalisation every note the agent writes carries whatever frontmatter the model invented,
      // and the store stops being queryable by type; without the provenance, every note the
      // agent has ever saved is indistinguishable from one the owner wrote manually.
      frontmatter: {
        title,
        type: "note",
        source: agentName,
        owner: agentName,
        tags: tags ?? [],
      },
      body,
      // Not the kit's default commit subject: this commit lands in the shared store's repo,
      // whose git log is the only audit trail these writes have.
      message: `note(${agentName}): ${inboxNotePath(title)}`,
    });
  },
});
