/**
 * The Atlas → studio-consensus seam (ORB-135).
 *
 * `makeBrainConsensus` (consensus.ts, ported verbatim) is dependency-injected and wants two
 * bare async functions:
 *
 *     search: (q: string) => Promise<string[]>   // store-relative note PATHS
 *     read:   (p: string) => Promise<string>     // the raw note BODY
 *
 * `@lares/agent-kit/notes-store` gives neither shape directly: `searchNotes(query, root)` is
 * SYNCHRONOUS and returns a `SearchResult` object (`{ hits, files }`), and `readNote(path,
 * root)` is SYNCHRONOUS and returns a `NoteContent` object (`{ path, content, lines }`). The
 * adapting happens HERE, at the call site — `consensus.ts` is never edited, so it stays a
 * verbatim port and stays injectable for tests.
 *
 * Why this is its own exported factory rather than three lines inside Task 5's tool: it makes
 * the seam unit-testable against a real temp directory (see `tests/studio-consensus.test.ts`)
 * instead of only reachable through a tool that needs a model and a database. Task 5's tool is
 * then a one-liner: `const consensus = makeAtlasConsensus();`.
 *
 * MODULE SCOPE IS CLEAN. `storeRoot("atlas")` throws `StorePathNotConfiguredError` when
 * `ATLAS_PATH` is unset, and `eve build` runs with no env and no secrets — so the root is
 * resolved lazily, on each call of the returned function, never at module load and not even
 * inside `makeAtlasConsensus()` itself. That means Task 5 may safely call this factory at the
 * top level of a tool module.
 *
 * ATLAS ONLY. Nothing here may reach `storeRoot("brain")` or `VAULT_PATH`.
 *
 * BOTH MISCONFIGURATIONS FAIL LOUDLY. A GENUINE NO-MATCH DOES NOT.
 * `makeBrainConsensus` wraps its search in `.catch(() => [])` (consensus.ts:50), so ANY error
 * raised inside `search` comes back out as "nothing matched" — the `(no prior material found…)`
 * sentinel — and `renderSpread` then tells Bendik, in a perfectly reasonable voice, that no
 * Atlas note matched his brief. Three different situations would otherwise hide behind that one
 * sentence, so the two that are FAULTS are raised here, before delegating, where the ported
 * module's catch cannot reach them:
 *
 *   - `ATLAS_PATH` UNSET → `StorePathNotConfiguredError`. A deploy fault. (The old runtime
 *     defaulted the path to `/srv/atlas`, so it could never notice. Task 7 must set `ATLAS_PATH`
 *     in compose — there is deliberately no default here.)
 *   - `ATLAS_PATH` SET but the store is SICK — the directory is missing, is not a directory, or
 *     contains no markdown at all → `StoreUnhealthyError`, raised by the explicit `listNotes`
 *     health check below. An unmounted or stale volume is a fault even when the deploy is
 *     perfect, and it is the ORB-51 failure class by name: a confident "I found nothing" over a
 *     store that was never readable is worse than an error, because nobody investigates it.
 *   - The store is HEALTHY and the brief simply matches nothing → the sentinel, unchanged. This
 *     is a real answer about a real Atlas, and her persona's job is to relay it.
 *
 * That split is possible because the kit draws the same line: `listNotes` throws
 * `StoreUnhealthyError` for a missing/unreadable/markdown-free root, while `searchNotes` on a
 * healthy store returns `{ hits: [], files }` for a query that matched nothing — no throw. So
 * the health check cannot make a legitimate no-match brief fail. It costs one extra tree walk
 * per run, which is the price of the distinction.
 *
 * All three branches are pinned in `tests/studio-consensus.test.ts`.
 */
import { listNotes, readNote, searchNotes, storeRoot } from "@lares/agent-kit/notes-store";
import { makeBrainConsensus } from "./consensus.js";

export interface AtlasConsensusOptions {
  /** Test seam: an explicit store root. Production leaves it unset and `ATLAS_PATH` decides. */
  root?: string;
  /** Test seam for the env `storeRoot` reads. Defaults to `process.env` at CALL time. */
  env?: NodeJS.ProcessEnv;
}

/**
 * A `consensus` function for `runStudioPipeline`, backed by the Atlas markdown store.
 * Returns `(brief) => Promise<string>` — the exact shape `StudioPipelineDeps.consensus` wants.
 *
 * `topN`/`maxChars` are deliberately NOT exposed: the ported defaults (3 notes / 4000 chars)
 * stand, and no caller has asked to override them.
 */
export function makeAtlasConsensus(opts: AtlasConsensusOptions = {}): (brief: string) => Promise<string> {
  const resolveRoot = (): string => opts.root ?? storeRoot("atlas", opts.env ?? process.env);

  const consensus = makeBrainConsensus({
    // `.hits` is the store-relative path list `makeBrainConsensus` ranks and reads.
    search: async (q: string) => searchNotes(q, resolveRoot()).hits,
    // `.content` is the raw body; the whole-object shape would serialise as "[object Object]".
    read: async (path: string) => readNote(path, resolveRoot()).content,
  });

  return async (brief: string) => {
    // Both checks run OUTSIDE makeBrainConsensus, so its per-search .catch cannot swallow them
    // into a sentinel that reads as "no Atlas note matched this brief" (see the header).
    const root = resolveRoot(); // unset ATLAS_PATH  → StorePathNotConfiguredError
    listNotes(root);            // missing/empty store → StoreUnhealthyError
    return consensus(brief);
  };
}
