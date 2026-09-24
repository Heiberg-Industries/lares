// Save a note to one area of the Vault — for this role, the shared area. GATED WRITE: `atlas` is
// `write-with-confirm` in her grants and `gated` in her autonomy block (agent.json), so this is
// the one tool of hers that changes the business knowledge store, and the approval card is the
// last thing between the model and a durable, pushed commit.
//
// W5C-s4: renamed from `atlas_write`, and given the same required `area` input and the same
// injected authority W5C-s3 gave the reads. THE GATE MOVED WITH THE CAPABILITY, ON PURPOSE, AT
// W5C-s5/s6: `approvalFor("vault_write")` names this tool to the same board policy, and
// `capabilityOfTool` now answers `vault` (the tool moved into `CAPABILITY_DOCS["vault"].tools`
// via `VAULT_SHARED_TOOLS`). The controller's area-is-the-action ruling (W5C-s6b) is what keeps
// that safe: no per-action key is passed here either, but `boardApproval`/`approvalFor` derive
// one from the tool's own area (`areaOfTool("vault_write")` — "shared"), so the ratchet row read
// is `(agent, "vault", "shared")` — 1:1 with the old `(agent, "atlas", "")` row, which box 077
// re-keys to exactly that. A rename that had left the row keyed on the bare capability would
// have merged this lane with every other vault write's.
//
// NEVER WIDEN. `vaultWriteAreasForTurn` is the granted areas intersected with the one area this
// tool serves (`lib/vault-areas.ts`), so it writes the shared store and nothing else — the same
// guarantee being bound to `storeRoot("atlas")` at construction used to give, now enforced
// against the declaration as well as against the code.
//
// PARITY WITH THE OLD HAND, DELIBERATELY (fix round 1, controller ruling). This ports
// `services/agent-runtime/lib/adapters/hands/atlas.ts:35-42`: the model supplies
// `{title, body, tags?}` and the PATH IS DERIVED — it is never an input. An earlier draft took
// a store-relative `path` from the model, which would have let her overwrite any note in the
// store, including hand-written brand notes. That is a capability widening, and this is a port:
// the ticket asks for the old behaviour plus an approval card, not a broader write.
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

    return commitNote({
      vaultRoot: storeRootForArea(area),
      path: inboxNotePath(title),
      // Normalised, not passed through. The old hand forced `type` and defaulted `tags`
      // (hands/atlas.ts:39), and stamped `source`/`owner` from the agent name. Without the
      // normalisation every note she writes carries whatever frontmatter the model invented,
      // and the store stops being queryable by type; without the provenance, every note she
      // has ever saved is indistinguishable from one the owner wrote by hand.
      frontmatter: {
        title,
        type: "note",
        source: "calliope",
        owner: "calliope",
        tags: tags ?? [],
      },
      body,
      // Not the kit's default commit subject: this commit lands in the shared store's repo,
      // whose git log is the only audit trail these writes have.
      message: `note(calliope): ${inboxNotePath(title)}`,
    });
  },
});
