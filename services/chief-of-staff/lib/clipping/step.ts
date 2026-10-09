/**
 * The clipping step of a digest pass (LAR-113): find the one configured source, run the sync
 * under a time budget, and turn the result into a state row, a repair and (on failure) one line
 * for the digest summary.
 *
 * NEVER A QUIET "0 NEW". Success is recorded as `ok`; every failure keeps its own outcome,
 * opens a repair and returns a notice. Only "nothing is configured" is silent, and it says
 * `not-configured`, not `ok`. A failure here never blocks the rest of the digest.
 *
 * NO MODEL CALL. This module and everything under lib/clipping take no model dependency; the
 * digest's existing classify step reads the clip after it is in `_inbox`.
 */
import { existsSync, rmSync } from "node:fs";

import { openRepair, resolveRepair } from "@lares/agent-kit/repairs";
import { resolveInStore } from "@lares/agent-kit/notes-store";
import { writeRawNote } from "@lares/agent-kit/vault-raw";

import {
  ClippingFailure, STEP_BUDGET_MS, classifyNotionError, withBudget,
  type ClippingOutcome, type KeyState, type NotionLike,
} from "./notion-reader.js";
import { loadNotionSources, recordSourceState, type Queryable, type SourceRow } from "./store.js";
import { runClippingSync, type InboxPort } from "./sync.js";

export const REPAIR_KIND = "clipping";

export interface ClippingStepDeps {
  db: Queryable;
  inbox: InboxPort;
  /** The keeper-delivered Notion key: none, delivered but unreadable, or the key. */
  token(): KeyState;
  makeClient(token: string): Promise<NotionLike>;
  budgetMs?: number;
  log?(m: string): void;
  /** Test seam: fetch limits. */
  pageSize?: number;
  maxPages?: number;
  maxTrashChecks?: number;
}

export interface ClippingStepResult {
  outcome: ClippingOutcome;
  imported: number;
  /** Lines for the digest summary. Empty on success and when nothing is configured. */
  notices: string[];
}

/** The vault's `_inbox`, through the same traversal-safe path check every vault write uses. */
export function makeVaultInbox(vaultRoot: string): InboxPort {
  return {
    exists: (rel) => existsSync(resolveInStore(rel, vaultRoot)),
    write: (rel, body) => writeRawNote({ vaultRoot, relPath: rel, bytes: Buffer.from(body, "utf8") }),
    remove: async (rel) => { rmSync(resolveInStore(rel, vaultRoot), { force: true }); },
  };
}

const UNSUPPORTED =
  "Only one organisation-wide shared Notion source is supported for now; this source was not read.";

function supportedProblem(source: SourceRow, count: number): string | null {
  if (count !== 1) return "More than one clipping source is set up; only one is supported for now.";
  if (source.owner !== "organisation" || source.visibility !== "shared" || source.credentialRef !== "notion:shared") {
    return UNSUPPORTED;
  }
  return null;
}

const when = (d: Date | null): string => (d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never");

async function fail(
  deps: ClippingStepDeps, source: SourceRow, f: ClippingFailure,
): Promise<string> {
  try {
    await recordSourceState(deps.db, source.id, { outcome: f.outcome, detail: f.ownerText });
  } catch (e) {
    deps.log?.(`clipping: could not record the failure (${String(e)})`);
  }
  await openRepair(deps.db, {
    kind: REPAIR_KIND, ref: source.id, severity: "warn", what: `Clipping from Notion: ${f.ownerText}`, howToFix: f.howToFix,
  });
  return `Clipping from Notion did not run: ${f.ownerText} Last good fetch: ${when(source.lastSuccessAt)}.`;
}

export async function clippingPass(deps: ClippingStepDeps): Promise<ClippingStepResult> {
  const sources = await loadNotionSources(deps.db);
  if (sources.length === 0) return { outcome: "not-configured", imported: 0, notices: [] };

  const source = sources[0]!;
  const problem = supportedProblem(source, sources.length);
  if (problem) {
    const notices: string[] = [];
    for (const s of sources) {
      notices.push(await fail(deps, s, new ClippingFailure("unsupported-source", problem)));
    }
    return { outcome: "unsupported-source", imported: 0, notices: [...new Set(notices)].slice(0, 1) };
  }

  const key = deps.token();
  if (key.kind === "none") {
    // Nothing delivers a key to this agent. Not a failure, and it must never close a repair
    // that a real failure opened.
    await recordSourceState(deps.db, source.id, { outcome: "not-configured", detail: "No Notion key is connected." });
    return { outcome: "not-configured", imported: 0, notices: [] };
  }
  if (key.kind === "unreadable") {
    const f = new ClippingFailure(
      "key-unreadable", "The Notion key is delivered but cannot be read.",
      "Check the Notion connection on the Integrations page and apply the key again.",
    );
    return { outcome: f.outcome, imported: 0, notices: [await fail(deps, source, f)] };
  }
  const token = key.token;

  try {
    const result = await withBudget(deps.budgetMs ?? STEP_BUDGET_MS, async () => {
      const client = await deps.makeClient(token);
      return runClippingSync({
        db: deps.db, client, source, inbox: deps.inbox,
        pageSize: deps.pageSize, maxPages: deps.maxPages, maxTrashChecks: deps.maxTrashChecks,
      });
    });
    await recordSourceState(deps.db, source.id, {
      outcome: "ok",
      detail: result.warnings.length ? result.warnings.join(" ").slice(0, 400) : null,
      success: { watermark: result.watermark, capped: result.capped, counts: result.counts },
    });
    await resolveRepair(deps.db, REPAIR_KIND, source.id);
    const c = result.counts;
    deps.log?.(
      `clipping: ok — imported ${c.imported}, updated ${c.updated}, trashed ${c.trashed}, ` +
        `skipped ${c.skipped} (${c.noLink} without a link, ${c.duplicates} duplicate), ` +
        `edited after filing ${c.editedAfterFiling}`,
    );
    return { outcome: "ok", imported: c.imported, notices: [] };
  } catch (e) {
    const failure = classifyNotionError(e);
    deps.log?.(`clipping: ${failure.outcome} — ${failure.ownerText}`);
    return { outcome: failure.outcome, imported: 0, notices: [await fail(deps, source, failure)] };
  }
}
