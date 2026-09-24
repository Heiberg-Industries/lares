// services/atlas/lib/apply.ts
// Where a decision becomes a file.
//
// Both decisions do work. An APPROVE writes the note; a REJECT writes nothing to disk but
// MUST still record the source fingerprint as accounted for — without that the next tick
// drafts the identical text and asks again, daily, forever. That symmetry is the whole
// reason both states sit in the same `resolved_at IS NULL` work queue.
//
// Order inside each proposal: write (or don't) → account → close. A throw anywhere leaves
// resolved_at NULL, which means the next tick retries the whole thing. Loud and repeatable
// beats quiet and lost.
//
// The close is ONE statement that moves the terminal state and stamps resolved_at together.
// It was two, and the pair could not work: the stamp was guarded on the row still being
// 'approved'/'rejected', so running it after the state move matched nothing and resolved_at
// stayed NULL forever. See completeAtlasProposal's comment for why one statement is not
// merely tidier here.
import {
  getAtlasProposalsAwaitingApply, completeAtlasProposal, supersedeAtlasProposal,
  recordAtlasSourcesAccounted, upsertAtlasNote,
} from "@lares/agent-box";
import { parseNote, setFrontmatterKeys } from "./frontmatter.js";
import { bodyHash } from "./fingerprint.js";
import type { TickDeps } from "./run.js";
// Straight from @lares/vault-format — the dependency-free package, not the role kit this
// service does not ship with (docs/specs/2026-09-18-origin-model-design.md).
import { ORIGIN_FRONTMATTER_KEY } from "@lares/vault-format/origin";

export interface ApplySummary { applied: number; rejected: number; superseded: number }

export async function runApply(deps: TickDeps): Promise<ApplySummary> {
  const summary: ApplySummary = { applied: 0, rejected: 0, superseded: 0 };

  for (const p of await getAtlasProposalsAwaitingApply(deps.db)) {
    try {
      if (p.state === "approved") {
        const current = deps.writer.readNote(p.notePath);
        const currentParsed = parseNote(current);
        // The stale-approval guard. Between propose and 👍 the note may have moved — a
        // human edit, or the mechanical pass normalising a field. Writing the proposed
        // bytes over that would discard the change without telling anyone.
        if (bodyHash(currentParsed.body) !== p.baseBodyHash) {
          await supersedeAtlasProposal(deps.db, p.id);
          summary.superseded++;
          await deps.notify(
            `Atlas proposal #${p.id} for ${p.notePath} was NOT applied — the note changed after ` +
            "you approved it, so applying the draft would have discarded that change. The next " +
            "sync will offer a fresh one.",
          );
          continue;
        }
        // ADR-0017 rule 9 / docs/specs/2026-09-18-origin-model-design.md: this write IS the
        // sync job's own 👍 gate landing content in the Vault, so a note with no origin
        // stamp yet gets `lares_origin: synced` here. The value to write is read off the
        // FRESHLY RE-READ note, not the frontmatter baked into `p.proposedNote` at propose
        // time — a note can pick up its own stamp (an owner hand-editing it) between propose
        // and apply without the body changing, and `proposedNote`'s frontmatter, captured
        // days earlier, would not carry it. Carrying the CURRENT value forward (rather than
        // only adding `synced` when none is set) is what stops that stamp being silently
        // dropped by this write: an existing stamp is always preserved verbatim, never
        // downgraded to `synced` and never lost.
        const existingOrigin = currentParsed.frontmatter[ORIGIN_FRONTMATTER_KEY];
        const originToWrite = typeof existingOrigin === "string" && existingOrigin !== ""
          ? existingOrigin
          : "synced";
        const toWrite = setFrontmatterKeys(p.proposedNote, { [ORIGIN_FRONTMATTER_KEY]: originToWrite });
        await deps.writer.writeNotes(
          [{ path: p.notePath, raw: toWrite }],
          `atlas: refresh ${p.notePath} from its canonical sources (proposal #${p.id}, approved)`,
        );
        await upsertAtlasNote(deps.db, {
          notePath: p.notePath,
          brand: String(parseNote(toWrite).frontmatter["brand"] ?? "") || null,
          bodyHash: bodyHash(parseNote(toWrite).body),
        });
        summary.applied++;
      } else {
        summary.rejected++;
      }

      // BOTH branches. A rejection is a decision about these exact sources, and forgetting
      // it is indistinguishable from never having asked.
      await recordAtlasSourcesAccounted(deps.db, p.notePath, p.sourcesHash);

      await completeAtlasProposal(deps.db, p.id, p.state);
    } catch (e) {
      // Deliberately does NOT close the proposal: it stays in the work queue and the next
      // tick retries. The alternative — close on failure — loses the decision silently.
      deps.log(
        `atlas: could not execute proposal #${p.id} for ${p.notePath} ` +
        `(${e instanceof Error ? e.message : String(e)}) — left open for the next tick`,
      );
    }
  }
  return summary;
}
