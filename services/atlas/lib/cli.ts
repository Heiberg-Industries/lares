// services/atlas/lib/cli.ts
// Argument parsing and the reader wiring — the two parts of the entrypoint that have a
// WRONG ANSWER available, and therefore the two parts that live here, pure and tested,
// rather than inline in bin/atlas-sync.ts.
import type { Queryable } from "@lares/agent-box";
import {
  getOpenAtlasProposals, resolveAtlasProposal,
  atlasApproveConsequence, atlasRejectConsequence,
} from "@lares/agent-box";
import type { ReaderMap } from "./resolve.js";
import { makeFsReader } from "./adapters/fs-source.js";
import { makeRepoReader } from "./adapters/github-source.js";
import { makeNotionReader } from "./adapters/notion-source.js";
import type { Config } from "./config.js";
import { OKF_CORE_TYPES, checkConformance } from "@lares/vault-format/okf";
import type { AtlasWriter } from "./adapters/atlas-writer.js";

export const MODES = [
  "daemon", "once", "migrate-okf", "check-okf", "doctor", "list", "approve", "reject",
] as const;
export type Mode = (typeof MODES)[number];

export interface ParsedArgs {
  mode: Mode;
  /** Present for approve/reject only. */
  id?: number;
}

const FLAG_TO_MODE: Record<string, Mode> = {
  "--once": "once",
  "--migrate-okf": "migrate-okf",
  "--check-okf": "check-okf",
  "--doctor": "doctor",
  "--list": "list",
  "--approve": "approve",
  "--reject": "reject",
};

/**
 * No mode flag means the daemon — but only the daemon is gated on ATLAS_SYNC_LIVE. Every
 * explicit flag is a deliberate operator action and bypasses that gate, the same posture
 * notion-sync's entrypoint takes.
 *
 * Two modes at once is an ERROR, never a silently-picked winner: `--check-okf --migrate-okf`
 * is a person asking to preview AND to write, and guessing which they meant is how a preview
 * becomes a write.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let found: { mode: Mode; flag: string } | undefined;
  let id: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const mode = FLAG_TO_MODE[arg];
    if (mode === undefined) {
      throw new Error(`atlas: unknown argument "${arg}". Known flags: ${Object.keys(FLAG_TO_MODE).join(" ")}`);
    }
    if (found !== undefined) {
      throw new Error(
        `atlas: "${found.flag}" and "${arg}" are both modes — pass exactly one, so it is never ` +
        "ambiguous whether this run writes",
      );
    }
    found = { mode, flag: arg };

    if (mode === "approve" || mode === "reject") {
      const raw = argv[++i];
      if (raw === undefined) throw new Error(`atlas: ${arg} needs a proposal id`);
      // Integer-only: Number("3.5") and Number("3abc") would otherwise reach the database as
      // a silently-truncated or NaN id.
      if (!/^\d+$/.test(raw)) throw new Error(`atlas: "${raw}" is not a proposal id`);
      id = Number(raw);
      if (id === 0) throw new Error(`atlas: "${raw}" is not a proposal id`);
    }
  }

  return found === undefined ? { mode: "daemon" } : { mode: found.mode, ...(id === undefined ? {} : { id }) };
}

export interface ReaderDeps {
  getPageMarkdown(pageId: string): Promise<string>;
  fetch?: typeof fetch;
}

/**
 * The four readers, each rooted at exactly one store. `assertReaderWiring` and
 * `probeLocalStores` are what actually prove this function did its job — they run against
 * whatever this returns, so a mistake here is caught at startup rather than shipped.
 */
export function buildReaders(config: Config, deps: ReaderDeps): ReaderMap {
  return {
    repo: makeRepoReader({ token: config.githubToken, ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
    vault: makeFsReader({ id: "vault", root: config.vaultPath }),
    notion: makeNotionReader({ getPageMarkdown: deps.getPageMarkdown }),
    atlas: makeFsReader({ id: "atlas", root: config.atlasPath }),
  };
}

/** `--list`: the open queue, in the same words Saga's DM uses. */
export async function listProposals(db: Queryable, log: (s: string) => void): Promise<void> {
  const open = await getOpenAtlasProposals(db);
  if (open.length === 0) {
    log("atlas: no open proposals.");
    return;
  }
  for (const p of open) {
    log(`#${p.id}  ${p.notePath}  [${p.state}]  raised ${p.createdAt.toISOString()}`);
    log(p.diffPreview.trim() === "" ? "  (no diff preview)" : p.diffPreview.split("\n").map((l) => `  ${l}`).join("\n"));
  }
  log(`\napprove: --approve <id>  → ${atlasApproveConsequence()}`);
  log(`reject:  --reject <id>   → ${atlasRejectConsequence()}`);
}

/**
 * `--approve` / `--reject`. The decision is recorded here; the WRITE happens on the next
 * tick's apply pass, which is why the printed consequence says "on the next sync tick" —
 * the CLI must not imply the file has already moved.
 */
export async function decideProposal(
  db: Queryable, id: number, action: "approve" | "reject", log: (s: string) => void,
): Promise<void> {
  const row = await resolveAtlasProposal(db, id, action);
  const consequence = action === "approve" ? atlasApproveConsequence() : atlasRejectConsequence();
  // Spelled out, not `${action}ed` — that renders "approveed", which is exactly what this
  // printed on its first real use. bin/saga.ts carries a comment about this same trap ("third
  // time this surface has bent a verb by concatenation"), and it got made here anyway: an
  // English past tense is not a suffix rule, so the two forms are written down.
  const past = action === "approve" ? "approved" : "rejected";
  log(`atlas: proposal #${row.id} for ${row.notePath} → ${past}. Now ${consequence}.`);
}

export interface ConformanceReport { findings: number }

/** `--check-okf`: reports, writes nothing. */
export function checkOkf(writer: AtlasWriter, log: (s: string) => void): ConformanceReport {
  const files = writer.listNotes().map((path) => ({ path, raw: writer.readNote(path) }));
  const findings = checkConformance(files, { types: OKF_CORE_TYPES });
  if (findings.length === 0) {
    log(`atlas: all ${files.length} notes conform to OKF.`);
    return { findings: 0 };
  }
  for (const f of findings) {
    log(`  ${f.path}: ${f.problem}${f.found === undefined ? "" : ` (found "${f.found}")`}`);
  }
  log(`atlas: ${findings.length} conformance finding(s) across ${files.length} notes.`);
  return { findings: findings.length };
}
