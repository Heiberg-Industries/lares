// services/atlas/lib/run.ts
// The tick. THE ORDER IS LOAD-BEARING:
//
//   1. APPLY   — execute decisions already made. Runs FIRST so an approved note is on disk
//                before anything reads it, and so its accounted-for stamp is in place before
//                the narrative pass asks whether anything drifted. `atlas_proposals_open`
//                deliberately excludes 'rejected' (only one OPEN claim per note is
//                enforced), so between a human tapping Reject and apply recording that
//                decision, narrative would be free to raise the identical proposal again —
//                apply running first is what closes that window.
//   2. MECHANICAL — deterministic fields, no gate. Runs BEFORE the narrative pass so a
//                proposal's `base_body_hash` is taken against the note in its final
//                mechanical shape; the other order guarantees every approval is superseded
//                by the very next mechanical write.
//   3. NARRATIVE — drift → draft → propose.
//
// Notes are processed independently in BOTH the mechanical and narrative passes: one note's
// failure never stops another's. `mechanicalRefresh` throws on legitimate input — a path
// `okfTypeFor` has no rule for, or a venture note with a bare legacy source and
// `codebase: —` — and one such note must not take the whole mechanical pass, and every
// note's write, down with it.
import type { Queryable } from "@lares/agent-box";
import {
  getOpenAtlasProposals, insertAtlasProposal, getAtlasNotes, upsertAtlasNote, setAtlasNoteState,
} from "@lares/agent-box";
import type { AtlasWriter } from "./adapters/atlas-writer.js";
import type { ReaderMap } from "./resolve.js";
import { resolveAll, verdictFor } from "./resolve.js";
import type { DraftModel } from "./narrative.js";
import { decideNote } from "./narrative.js";
import { parseNote } from "./frontmatter.js";
import { bodyHash } from "./fingerprint.js";
import { mechanicalRefresh } from "./mechanical.js";
import { sourceRefsFor } from "./sources.js";
import { cardFor, renderPortfolio, optsIntoGeneration, type VentureCard } from "./portfolio.js";
import { runApply, type ApplySummary } from "./apply.js";

export interface TickDeps {
  db: Queryable;
  writer: AtlasWriter;
  readers: ReaderMap;
  model: DraftModel;
  /** YYYY-MM-DD. Passed in so a test can pin it — never read from the clock in here. */
  today: string;
  now: Date;
  notify(message: string, opts?: { key?: string }): Promise<void>;
  log(message: string): void;
}

const VENTURE_DIR = "_projects/";
const PORTFOLIO = "_portfolio.md";

function venturePaths(writer: AtlasWriter): string[] {
  return writer.listNotes().filter((p) => p.normalize("NFC").toLowerCase().startsWith(VENTURE_DIR));
}

export interface MechanicalSummary {
  changed: string[];
  /**
   * Paths a step of this pass THREW on — `mechanicalRefresh` itself, or the portfolio card
   * derived from a venture note's (re-parsed) frontmatter. Every OTHER note still gets
   * refreshed and written; this is the operator's punch list, not a failed run. Same shape
   * and reasoning as `migrateOkf`'s `failures` (migrate-okf.ts) — one implementation of
   * "isolate a per-file failure" would be nice, but the two run over different inputs
   * (every file vs. venture-only card derivation) and duplicating the shape costs far less
   * than a shared abstraction over unrelated call sites.
   */
  failures: Array<{ path: string; error: string }>;
}

/** Deterministic fields + the regenerated portfolio map. One commit for the whole batch. */
export async function runMechanical(deps: TickDeps): Promise<MechanicalSummary> {
  const updates: Array<{ path: string; raw: string }> = [];
  const failures: Array<{ path: string; error: string }> = [];
  const failedPaths = new Set<string>();

  function recordFailure(path: string, e: unknown): void {
    if (failedPaths.has(path)) return; // already recorded from an earlier step this pass
    failedPaths.add(path);
    const error = e instanceof Error ? e.message : String(e);
    failures.push({ path, error });
    deps.log(`atlas: ${path} failed mechanical refresh — ${error} — left unchanged this tick`);
  }

  for (const path of deps.writer.listNotes()) {
    try {
      const raw = deps.writer.readNote(path);
      const res = mechanicalRefresh({ path, raw, today: deps.today });
      if (res.changed) updates.push({ path, raw: res.raw });
    } catch (e) {
      recordFailure(path, e);
    }
  }

  // The portfolio map is derived from the venture notes AFTER their own refresh, so its
  // cards never restate a status the note has already corrected. Built defensively, one
  // card at a time: a venture note whose frontmatter cannot be re-parsed (the same failure
  // mode `mechanicalRefresh` just hit, or a different one — an unterminated frontmatter
  // block, say) must not cost every OTHER venture's card, nor the mechanical fixes already
  // collected in `updates` above.
  const cards: VentureCard[] = [];
  for (const path of venturePaths(deps.writer)) {
    if (failedPaths.has(path)) continue; // already known broken; don't re-throw for a second entry
    try {
      const pending = updates.find((u) => u.path === path);
      cards.push(cardFor(path, parseNote(pending?.raw ?? deps.writer.readNote(path))));
    } catch (e) {
      recordFailure(path, e);
    }
  }

  // renderPortfolio throws if `_portfolio.md` has lost its generated-block markers — a
  // whole-store misconfiguration, not a per-note one, but it must not cost the venture
  // fixes already collected above either: they still get written even if the portfolio
  // itself cannot be regenerated this tick.
  try {
    const portfolioRaw = updates.find((u) => u.path === PORTFOLIO)?.raw ?? deps.writer.readNote(PORTFOLIO);
    // No markers at all means hand-written BY CHOICE (see optsIntoGeneration). Skipping quietly is
    // the point: the alternative reported a failure on EVERY tick for a file nobody intends
    // to generate, and a recurring "failure" that is actually normal is exactly how the one
    // that matters gets skimmed past. Note this only skips the portfolio — the venture notes'
    // mechanical fixes collected above are still written below.
    if (optsIntoGeneration(portfolioRaw)) {
      const rendered = renderPortfolio(cards, deps.today, portfolioRaw);
      if (rendered !== portfolioRaw) {
        const at = updates.findIndex((u) => u.path === PORTFOLIO);
        if (at === -1) updates.push({ path: PORTFOLIO, raw: rendered });
        else updates[at] = { path: PORTFOLIO, raw: rendered };
      }
    }
  } catch (e) {
    recordFailure(PORTFOLIO, e);
  }

  if (updates.length === 0) return { changed: [], failures };
  await deps.writer.writeNotes(updates, "atlas: mechanical refresh (derived fields)");
  return { changed: updates.map((u) => u.path), failures };
}

export interface NarrativeSummary {
  proposed: number;
  skipped: Array<{ path: string; reason: string }>;
}

export async function runNarrative(deps: TickDeps): Promise<NarrativeSummary> {
  const open = new Set((await getOpenAtlasProposals(deps.db)).map((p) => p.notePath));
  const rows = await getAtlasNotes(deps.db);
  const summary: NarrativeSummary = { proposed: 0, skipped: [] };

  for (const path of venturePaths(deps.writer)) {
    try {
      const raw = deps.writer.readNote(path);
      const note = parseNote(raw);

      // A row must EXIST before a proposal can be raised — a decision needs somewhere to be
      // recorded, and `recordAtlasSourcesAccounted` throws without one. The contract
      // notion-sync learned the hard way, enforced here rather than documented.
      await upsertAtlasNote(deps.db, {
        notePath: path,
        brand: String(note.frontmatter["brand"] ?? "") || null,
        bodyHash: bodyHash(note.body),
      });

      const resolved = await resolveAll(sourceRefsFor(note), deps.readers);
      const verdict = verdictFor(resolved);
      const changed = await setAtlasNoteState(deps.db, path, verdict.outcome, verdict.reason, deps.now);
      if (changed) {
        // Transitions only. A source unreachable for a week is ONE message, not seven — and
        // a source that comes back says so, which is what makes the first message trustworthy.
        // key: "source-health" — a source that could not be read, or one that just became
        // readable again — routes this at severity "warn" (data-quality/warn has a spine
        // route; data-quality/info never did, which is how the first live SOMA alert was lost).
        await deps.notify(
          verdict.outcome === "ok"
            ? `Atlas: ${path} — all canonical sources are readable again.`
            : `Atlas: ${path} is flagged **${verdict.outcome}** — ${verdict.reason}. The note has ` +
              "NOT been changed; no refresh will be proposed for it until this is fixed.",
          { key: "source-health" },
        );
      }

      const decision = await decideNote({
        notePath: path, note, raw, sources: resolved,
        accountedSourcesHash: rows.get(path)?.accountedSourcesHash ?? null,
        openProposalPaths: open, model: deps.model,
      });

      if (decision.action === "skip") {
        summary.skipped.push({ path, reason: decision.reason });
        continue;
      }
      await insertAtlasProposal(deps.db, decision.proposal!);
      open.add(path);
      summary.proposed++;
    } catch (e) {
      // Per-note containment: one unreadable note must not stop the other seven.
      summary.skipped.push({ path, reason: e instanceof Error ? e.message : String(e) });
      deps.log(`atlas: ${path} failed this tick — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return summary;
}

export interface TickSummary {
  apply: ApplySummary;
  mechanical: MechanicalSummary;
  narrative: NarrativeSummary;
}

export async function runTick(deps: TickDeps): Promise<TickSummary> {
  const apply = await runApply(deps);
  const mechanical = await runMechanical(deps);
  const narrative = await runNarrative(deps);
  deps.log(
    `atlas: tick done — applied ${apply.applied}, rejected ${apply.rejected}, ` +
    `superseded ${apply.superseded}; mechanical touched ${mechanical.changed.length}` +
    `${mechanical.failures.length > 0 ? ` (${mechanical.failures.length} failed)` : ""}; ` +
    `proposed ${narrative.proposed}, skipped ${narrative.skipped.length}`,
  );
  return { apply, mechanical, narrative };
}
